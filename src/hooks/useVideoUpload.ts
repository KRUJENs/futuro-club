/**
 * VITAS Phase 2 — useVideoUpload hook
 *
 * Manages the full upload lifecycle:
 *   1. POST /api/upload/video-init  → get signed TUS credentials + videoId (Bunny GUID);
 *      el servidor siembra también la fila `videos` (con el JWT del usuario).
 *   2. TUS upload directo a Bunny (reanudable): la sesión {videoId, uploadUrl,
 *      authSignature, authExpire, libraryId} se guarda por huella del fichero → al
 *      recargar y volver a elegir el mismo fichero NO se vuelve a llamar a video-init,
 *      se reanuda desde el offset que tiene Bunny (findPreviousUploads).
 *      Si Bunny RECHAZA la sesión guardada (4xx definitivo: vídeo borrado, clave rotada,
 *      firma inválida) se descarta y se reintenta UNA vez con un video-init nuevo; un 4xx
 *      en una sesión nueva también la descarta. Un corte de red la conserva (reanudable).
 *   3. Poll /api/videos/status → wait for encode to finish. Si el poll se agota (un
 *      partido largo codifica más que el poll) → termina con encodeStatus="processing"
 *      (subida OK; la codificación sigue en Bunny), nunca como error.
 *   4. El análisis REAL (Gemini vídeo completo → PHV + 6 reportes) corre ASYNC
 *      vía el webhook de Bunny (bunny-uploaded → cola de analyses) cuando hay jugador
 *      y el vídeo es un clip corto (SYNC_ANALYSIS_MAX_DURATION_SEC). Este hook YA
 *      NO llama a /api/pipeline/start (análisis de 1 frame, retirado).
 *
 * Returns upload state + controls.
 */

import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import i18n from "@/i18n";
import * as tus from "tus-js-client";
import { VideoService } from "@/services/real/videoService";
import type { VideoRecord, VideoAnalysis } from "@/services/real/videoService";
import { useAuth } from "@/context/AuthContext";
import { SupabaseVideoService } from "@/services/real/supabaseVideoService";
import { SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getAuthHeaders } from "@/lib/apiAuth";
import {
  generateLocalVideoId,
  extractVideoMetadata,
  extractThumbnailFromVideo,
} from "@/lib/localVideoUtils";
import { calculateFileHash } from "@/lib/fileHash";
import { getErrorDetails } from "@/services/errorDiagnosticService";
import {
  uploadFingerprint,
  loadTusSession,
  saveTusSession,
  updateTusSession,
  clearTusSession,
  tusErrorStatus,
  isTusSessionRejection,
  type TusUploadSession,
} from "@/lib/tusUploadSession";
import { evaluateSyncAnalysisGate, knownDurationSec } from "@/lib/shared/videoLimits";
import {
  ClipConsentBlockedError,
  clipConsentErrorFromResponse,
  type ClipAttestation,
  type ClipConsentCode,
} from "@/lib/shared/videoConsent";

export type UploadPhase =
  | "idle"
  | "hashing"      // computing SHA-256 for dedup check
  | "init"         // creating Bunny entry
  | "uploading"    // XHR PUT to Bunny
  | "processing"   // Bunny encoding
  | "analyzing"    // pipeline (Roboflow + Claude)
  | "done"
  | "error";

/** Info sobre un duplicado encontrado en la cuenta del usuario. */
export interface DuplicateInfo {
  videoId: string;
  title: string | null;
  dateUploaded: string | null;
  playerId: string | null;
  hasAnalysis: boolean;
}

/**
 * Opciones del upload. Todas son opcionales para mantener retrocompatibilidad
 * con llamadas existentes `upload(file, title)`.
 */
export interface UploadOptions {
  title?: string;
  /**
   * Hook opcional que se dispara cuando detectamos un duplicado.
   * Debe devolver:
   *   - "reuse"  → saltar upload, seleccionar video existente en la UI
   *   - "upload" → continuar con el upload normal (el usuario quiere re-analizar)
   * Si no se pasa callback → comportamiento seguro por defecto: "upload"
   * (idéntico al flujo actual, nada cambia).
   */
  onDuplicate?: (dup: DuplicateInfo) => Promise<"reuse" | "upload"> | "reuse" | "upload";
  /**
   * Duración (s) leída de los metadatos del navegador. null/undefined = desconocida:
   * NO se inventa (no viaja a video-init y los gates no bloquean).
   */
  durationSec?: number | null;
  /**
   * Se dispara justo tras el éxito de la subida TUS (el fichero ya está entero en
   * Bunny), ANTES del poll de codificación — que en un partido largo puede tardar.
   */
  onUploaded?: (info: { videoId: string; libraryId: number }) => void;
  /**
   * Declaración del entrenador `{ accepted: true, version }` (decisión del owner, 30 sep):
   * video-init la exige y la GUARDA con el vídeo, porque el webhook de Bunny analiza
   * solo con la subida. Sin ella el servidor responde 400 attestation_required. La pone
   * SOLO el componente cuando el usuario marca la casilla; nunca un valor por defecto.
   */
  attestation?: ClipAttestation | null;
}

/** Resultado de la espera de codificación en Bunny. */
export type EncodeStatus = "ready" | "processing";

export interface UploadState {
  phase: UploadPhase;
  progress: number;        // 0-100 (upload %)
  encodeProgress: number;  // 0-100 (Bunny encoding %)
  videoId: string | null;
  error: string | null;
  video: VideoRecord | null;
  analysis: VideoAnalysis | null;
  /**
   * true cuando el vídeo quedó subido+codificado y el análisis REAL (Gemini +
   * PHV + 6 reportes) está encolado async vía el webhook de Bunny. Antes aquí se
   * corría /api/pipeline/start (análisis de 1 frame, inferior) — retirado.
   */
  analysisQueued: boolean;
  phase2Pending: boolean;
  uploadSpeed: number;     // bytes per second
  etaSeconds: number;      // estimated time remaining
  /**
   * null mientras no ha terminado; "ready" = Bunny terminó de codificar;
   * "processing" = la subida terminó pero el poll se agotó con Bunny aún codificando
   * (partido largo). NO es un error: el vídeo queda guardado.
   */
  encodeStatus: EncodeStatus | null;
  /**
   * Duración REAL (s) que dejó fuera la cola de análisis rápido por jugador
   * (> SYNC_ANALYSIS_MAX_DURATION_SEC). null = no aplica / duración desconocida.
   */
  syncGateDurationSec: number | null;
  /**
   * El servidor rechazó la subida por consentimiento (sin declaración, menor de 14
   * conocido sin consentimiento parental verificado, o no se pudo comprobar). `error`
   * lleva el motivo traducido; null = no aplica.
   */
  consentBlocked: ClipConsentCode | null;
}

const INITIAL: UploadState = {
  phase: "idle",
  progress: 0,
  encodeProgress: 0,
  videoId: null,
  error: null,
  video: null,
  analysis: null,
  analysisQueued: false,
  phase2Pending: false,
  uploadSpeed: 0,
  etaSeconds: 0,
  encodeStatus: null,
  syncGateDurationSec: null,
  consentBlocked: null,
};

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 150; // ~10 min; al agotarse NO falla (el encode sigue async)

/** Endpoint TUS de Bunny Stream (https://bunny.net/docs/stream/tus-resumable-uploads). */
export const BUNNY_TUS_ENDPOINT = "https://video.bunnycdn.com/tusupload";

/**
 * Reintentos TUS (ms): rampa larga para redes de campo inestables durante subidas de
 * varios GB. (Bunny documenta como ejemplo [0, 3000, 5000, 10000, 20000, 60000, 60000].)
 * chunkSize: Bunny NO documenta un valor recomendado → se deja el de tus-js-client
 * (un PATCH por intento; tras un corte se reanuda desde el offset que confirma Bunny).
 */
export const TUS_RETRY_DELAYS = [0, 3000, 10000, 30000, 60000, 120000];

/** Fallo de la subida TUS con el código HTTP de Bunny (null = sin respuesta: red). */
class TusUploadError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "TusUploadError";
    this.status = status;
  }
}

// Auth headers from shared utility
const authHeaders = getAuthHeaders;

export function useVideoUpload(playerId?: string) {
  const [state, setState] = useState<UploadState>(INITIAL);
  const tusRef = useRef<tus.Upload | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const setPhase = (phase: UploadPhase, extra?: Partial<UploadState>) =>
    setState((prev) => ({ ...prev, phase, ...extra }));

  const reset = useCallback(() => {
    tusRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setState(INITIAL);
  }, []);

  const upload = useCallback(
    async (file: File, titleOrOptions?: string | UploadOptions) => {
      reset();

      // Normalize args: retrocompatible con `upload(file, "título")`
      const opts: UploadOptions =
        typeof titleOrOptions === "string"
          ? { title: titleOrOptions }
          : (titleOrOptions ?? {});
      const title = opts.title;
      const onDuplicate = opts.onDuplicate;
      const durationSec = knownDurationSec(opts.durationSec);

      // Huella del fichero (= la que usa tus-js-client para guardar la URL de subida).
      const fingerprint = uploadFingerprint(file, BUNNY_TUS_ENDPOINT);
      // ¿Subida a medias de ESTE fichero, para ESTE jugador, aún firmada? → reanudar
      // sin volver a llamar a video-init (sería otro vídeo en Bunny desde el byte 0).
      const resumable: TusUploadSession | null = loadTusSession(fingerprint, {
        playerId: playerId ?? null,
        nowSec: Math.floor(Date.now() / 1000),
      });

      try {
        // ── Step 0 (opcional): Dedup check por SHA-256 ───────────────────────
        // Best-effort. Si cualquier paso falla, seguimos con upload normal.
        // Se salta al reanudar: el "duplicado" sería la propia subida a medias.
        let fileHash: string | null = null;
        if (SUPABASE_CONFIGURED && onDuplicate && !resumable) {
          setPhase("hashing", { progress: 0 });
          try {
            fileHash = await calculateFileHash(file, (pct) => {
              setState((prev) => ({ ...prev, progress: pct }));
            });
          } catch (hashErr) {
            console.warn("[useVideoUpload] Falló cálculo de hash — upload continúa sin dedup:", hashErr);
            fileHash = null;
          }

          if (fileHash) {
            try {
              const dupRes = await fetch("/api/videos/check-hash", {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify({ hash: fileHash, playerId }),
              });
              if (dupRes.ok) {
                const dupData = (await dupRes.json()) as {
                  success: boolean;
                  data?: {
                    duplicate: boolean;
                    videoId?: string;
                    title?: string | null;
                    dateUploaded?: string | null;
                    playerId?: string | null;
                    hasAnalysis?: boolean;
                    status?: string | null;
                  };
                };
                // Una fila en "created" es una subida que NUNCA terminó → no es un vídeo
                // reutilizable (reusarla dejaría al usuario con un vídeo vacío).
                if (
                  dupData.success && dupData.data?.duplicate && dupData.data.videoId &&
                  dupData.data.status !== "created"
                ) {
                  const dup: DuplicateInfo = {
                    videoId: dupData.data.videoId,
                    title: dupData.data.title ?? null,
                    dateUploaded: dupData.data.dateUploaded ?? null,
                    playerId: dupData.data.playerId ?? null,
                    hasAnalysis: Boolean(dupData.data.hasAnalysis),
                  };
                  const decision = await Promise.resolve(onDuplicate(dup));
                  if (decision === "reuse") {
                    // El usuario eligió reusar el video existente → terminamos el
                    // "upload" como done, apuntando al videoId ya existente.
                    const existing = VideoService.getById(dup.videoId);
                    setState({
                      ...INITIAL,
                      phase: "done",
                      progress: 100,
                      videoId: dup.videoId,
                      video: existing ?? null,
                    });
                    queryClient.invalidateQueries({ queryKey: ["videos"] });
                    if (playerId) {
                      queryClient.invalidateQueries({ queryKey: ["videos", playerId] });
                    }
                    return dup.videoId;
                  }
                  // decision === "upload" → continuar con flujo normal
                }
              }
            } catch (dupErr) {
              console.warn("[useVideoUpload] Falló check-hash — upload continúa sin dedup:", dupErr);
            }
          }
        }

        // ── Step 1: Init (solo si NO hay una subida reanudable de este fichero) ──
        /** video-init → sesión TUS nueva (ya persistida) o, sin Bunny, el fallback local. */
        const initFreshSession = async (): Promise<
          { kind: "bunny"; session: TusUploadSession } | { kind: "local"; videoId: string }
        > => {
          setPhase("init", { progress: 0 });

          const initRes = await fetch("/api/upload/video-init", {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify({
              title: title ?? file.name,
              playerId,
              // Solo si el navegador la leyó (dato real); nunca un default.
              ...(durationSec !== null ? { durationSec } : {}),
              // Declaración marcada por el usuario (si no, el servidor la exige: 400).
              ...(opts.attestation ? { attestation: opts.attestation } : {}),
            }),
          });

          if (!initRes.ok) {
            const errText = await initRes.text().catch(() => `HTTP ${initRes.status}`);
            let errJson: { error?: string } | null = null;
            try {
              errJson = JSON.parse(errText) as { error?: string };
            } catch { /* not JSON */ }
            // Bloqueo de consentimiento (400/403/500 con código): se muestra el motivo real;
            // un 403 parental_consent_required NO es una "sesión caducada".
            const consentErr = clipConsentErrorFromResponse(errJson, i18n.language);
            if (consentErr) throw consentErr;
            if (initRes.status === 401 || initRes.status === 403) {
              throw new Error(i18n.t("errors.sessionExpired"));
            }
            throw new Error(`video-init: ${errJson?.error ?? `HTTP ${initRes.status}`}`);
          }

          const initData = (await initRes.json()) as {
            success: boolean;
            phase2Pending?: boolean;
            error?: string;
            data?: {
              videoId:       string;
              uploadUrl:     string;
              authSignature: string;
              authExpire:    number;
              libraryId:     number;
            };
          };

          if (!initData.success) {
            if (initData.phase2Pending) {
              // ── LOCAL FALLBACK: Bunny CDN no configurado ────────────────────
              // Procesar el video localmente sin necesidad de CDN
              setPhase("uploading", { progress: 10 });

              const localId = generateLocalVideoId();
              const blobUrl = URL.createObjectURL(file);

              let meta = { duration: 0, width: 1280, height: 720 };
              try {
                meta = await extractVideoMetadata(file);
                setState((prev) => ({ ...prev, progress: 40 }));
              } catch {
                // Si falla metadata, usar defaults
              }

              let thumbnailUrl: string | null = null;
              try {
                thumbnailUrl = await extractThumbnailFromVideo(
                  blobUrl,
                  Math.min(2, (meta.duration || 10) / 2)
                );
                setState((prev) => ({ ...prev, progress: 70 }));
              } catch {
                // Thumbnail opcional
              }

              const localVideo: VideoRecord = {
                id: localId,
                title: title ?? file.name,
                playerId: playerId ?? null,
                status: "finished",
                statusCode: 4,
                encodeProgress: 100,
                duration: Math.round(meta.duration),
                width: meta.width,
                height: meta.height,
                fps: 30,
                storageSize: file.size,
                thumbnailUrl,
                embedUrl: "",
                streamUrl: blobUrl,
                dateUploaded: new Date().toISOString(),
                localPath: blobUrl,
                analysisResult: null,
                ...(fileHash ? { fileHash } : {}),
              };

              VideoService.save(localVideo);
              if (user && SUPABASE_CONFIGURED) {
                SupabaseVideoService.pushOne(user.id, localVideo).catch((err) => {
                  console.warn("[useVideoUpload] pushOne local video failed:", err);
                });
              }

              setState({
                ...INITIAL,
                phase: "done",
                progress: 100,
                videoId: localId,
                video: localVideo,
              });

              queryClient.invalidateQueries({ queryKey: ["videos"] });
              if (playerId) {
                queryClient.invalidateQueries({ queryKey: ["videos", playerId] });
              }
              return { kind: "local", videoId: localId };
            }
            throw new Error(initData.error ?? "Init failed");
          }

          const d = initData.data!;
          const fresh: TusUploadSession = {
            videoId: d.videoId,
            uploadUrl: d.uploadUrl,
            authSignature: d.authSignature,
            authExpire: d.authExpire,
            libraryId: d.libraryId,
            playerId: playerId ?? null,
            tusUploadUrl: null,
            savedAt: Date.now(),
          };
          // Persistir ANTES de subir: si la pestaña se cierra a mitad, la próxima vez
          // se reanuda este mismo vídeo en vez de crear otro.
          saveTusSession(fingerprint, fresh);
          return { kind: "bunny", session: fresh };
        };

        /** Stub local (al reanudar ya existe: solo se refresca el blob: de ESTA pestaña). */
        const prepareLocalStub = (videoId: string) => {
          const localBlobUrl = URL.createObjectURL(file);
          const existingLocal = VideoService.getById(videoId);
          if (existingLocal) {
            VideoService.save({ ...existingLocal, localPath: localBlobUrl });
            return;
          }
          const stubParams = {
            id: videoId,
            title: title ?? file.name,
            playerId: playerId ?? null,
            localPath: localBlobUrl,
            ...(fileHash ? { fileHash } : {}),
          };
          if (user && SUPABASE_CONFIGURED) {
            const stub = VideoService.createStub(stubParams);
            SupabaseVideoService.pushOne(user.id, stub).catch((err) => {
              console.warn("[useVideoUpload] pushOne stub failed:", err);
            });
          } else {
            VideoService.createStub(stubParams);
          }
        };

        /**
         * El vídeo de una sesión que Bunny RECHAZÓ ya no se va a completar → su registro
         * local deja de figurar "en subida" y pasa a "upload-failed" (dato honesto; no se
         * borra nada). Si el usuario ya lo borró, no hay registro que tocar.
         */
        const markUploadAbandoned = (videoId: string) => {
          const old = VideoService.getById(videoId);
          if (!old || old.status === "finished") return;
          if (old.localPath?.startsWith("blob:")) URL.revokeObjectURL(old.localPath);
          const failed = VideoService.updateStatus(videoId, "upload-failed");
          if (!failed) return;
          const cleaned: VideoRecord = { ...failed, localPath: undefined };
          VideoService.save(cleaned);
          if (user && SUPABASE_CONFIGURED) {
            SupabaseVideoService.pushOne(user.id, cleaned).catch((err) => {
              console.warn("[useVideoUpload] pushOne abandoned video failed:", err);
            });
          }
        };

        // ── Step 2 (helper): Upload to Bunny via TUS protocol (signed, resumable) ──
        const runTusUpload = (s: TusUploadSession, isResume: boolean) =>
          new Promise<void>((resolve, reject) => {
            const uploadStartTime = Date.now();
            const tusUpload = new tus.Upload(file, {
              endpoint: BUNNY_TUS_ENDPOINT,
              // Misma huella que nuestra sesión → tus guarda/encuentra la URL de subida.
              fingerprint: () => Promise.resolve(fingerprint),
              retryDelays: TUS_RETRY_DELAYS,
              removeFingerprintOnSuccess: true,
              headers: {
                AuthorizationSignature: s.authSignature,
                AuthorizationExpire: String(s.authExpire),
                VideoId: s.videoId,
                LibraryId: String(s.libraryId),
              },
              metadata: {
                filetype: file.type,
                title: title ?? file.name,
              },
              onUploadUrlAvailable: () => {
                if (tusUpload.url) updateTusSession(fingerprint, { tusUploadUrl: tusUpload.url });
              },
              onError: (error) => {
                // Se conserva el código HTTP de Bunny: distingue "red caída" (reanudable)
                // de "sesión rechazada" (4xx definitivo → descartar la sesión).
                reject(new TusUploadError(`Upload failed: ${error.message || error}`, tusErrorStatus(error)));
              },
              onProgress: (bytesUploaded, bytesTotal) => {
                const pct = Math.round((bytesUploaded / bytesTotal) * 100);
                const now = Date.now();
                const elapsed = (now - uploadStartTime) / 1000; // seconds
                const speed = elapsed > 0 ? bytesUploaded / elapsed : 0;
                const remaining = bytesTotal - bytesUploaded;
                const eta = speed > 0 ? Math.round(remaining / speed) : 0;
                setState((prev) => ({ ...prev, progress: pct, uploadSpeed: speed, etaSeconds: eta }));
              },
              onSuccess: () => {
                resolve();
              },
            });

            // Store reference for cancel support
            tusRef.current = tusUpload;

            const begin = async () => {
              if (isResume && typeof tusUpload.findPreviousUploads === "function") {
                try {
                  const previous = await tusUpload.findPreviousUploads();
                  const match =
                    previous.find((p) => !!p.uploadUrl && p.uploadUrl === s.tusUploadUrl) ??
                    previous[0];
                  // Reanuda desde el offset que tiene Bunny (HEAD), no desde el byte 0.
                  if (match) tusUpload.resumeFromPreviousUpload(match);
                } catch (err) {
                  console.warn("[useVideoUpload] findPreviousUploads falló — subida desde el inicio:", err);
                }
              } else if (!isResume && typeof tusUpload.findPreviousUploads === "function") {
                // Sesión NUEVA: las URLs TUS que tus guardó para este fichero son de un vídeo
                // anterior (firma caducada) → se limpian para no reanudar contra otro vídeo.
                try {
                  const stale = await tusUpload.findPreviousUploads();
                  for (const p of stale) await tusUpload.options.urlStorage?.removeUpload(p.urlStorageKey);
                } catch { /* best-effort */ }
              }
              tusUpload.start();
            };
            void begin();
          });

        /**
         * Sube con la sesión dada. Si Bunny la rechaza de forma definitiva (4xx), la sesión
         * se descarta ANTES de propagar el error: el siguiente intento con este fichero hace
         * un video-init nuevo en vez de chocar contra la misma sesión muerta hasta que
         * caduque. Un corte de red (sin respuesta) o un 5xx la conservan (reanudable).
         */
        const uploadWithSession = async (s: TusUploadSession, isResume: boolean) => {
          prepareLocalStub(s.videoId);
          setState((prev) => ({ ...prev, videoId: s.videoId, phase: "uploading" }));
          try {
            await runTusUpload(s, isResume);
          } catch (tusErr) {
            if (tusErr instanceof TusUploadError && isTusSessionRejection(tusErr.status)) {
              clearTusSession(fingerprint);
            }
            throw tusErr;
          }
        };

        let session: TusUploadSession;
        if (resumable) {
          session = resumable;
          setPhase("uploading", { progress: 0 });
        } else {
          const fresh = await initFreshSession();
          if (fresh.kind === "local") return fresh.videoId;
          session = fresh.session;
        }

        // ── Step 2: Upload to Bunny via TUS protocol (signed, resumable) ────
        try {
          await uploadWithSession(session, resumable !== null);
        } catch (tusErr) {
          // Bunny rechazó la sesión GUARDADA (vídeo borrado en Bunny, clave de la librería
          // rotada, firma inválida): reanudar ya no es posible. UNA sola vez: sesión nueva
          // (video-init → otro vídeo, desde el byte 0). Si esta también falla, se propaga.
          if (
            !resumable ||
            !(tusErr instanceof TusUploadError) ||
            !isTusSessionRejection(tusErr.status)
          ) {
            throw tusErr;
          }
          console.warn(
            `[useVideoUpload] Bunny rechazó la sesión reanudable (HTTP ${tusErr.status}) — nueva subida con video-init`,
          );
          markUploadAbandoned(resumable.videoId);
          const fresh = await initFreshSession();
          if (fresh.kind === "local") return fresh.videoId;
          session = fresh.session;
          await uploadWithSession(session, false);
        }

        const { videoId, libraryId } = session;

        // Subida completa: la sesión ya no se necesita (el fichero está entero en Bunny).
        clearTusSession(fingerprint);
        try {
          opts.onUploaded?.({ videoId, libraryId });
        } catch (cbErr) {
          console.warn("[useVideoUpload] onUploaded lanzó (se ignora):", cbErr);
        }

        // Construir embedUrl inmediatamente usando libraryId (no esperar polling)
        const embedUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
        const uploadedStub = VideoService.getById(videoId);
        if (uploadedStub) {
          VideoService.save({ ...uploadedStub, status: "uploaded", statusCode: 1, encodeProgress: 0, embedUrl });
          if (user && SUPABASE_CONFIGURED) {
            const updated = VideoService.getById(videoId);
            if (updated) SupabaseVideoService.pushOne(user.id, updated).catch((err) => {
              console.warn("[useVideoUpload] pushOne uploaded stub failed:", err);
            });
          }
        }
        setState((prev) => ({ ...prev, phase: "processing", progress: 100 }));

        // ── Step 3: Poll encoding status ─────────────────────────────────────
        const MAX_CONSECUTIVE_ERRORS = 5;
        const encodeStatus = await new Promise<EncodeStatus>((resolve, reject) => {
          let attempts = 0;
          let consecutiveErrors = 0;

          const poll = async () => {
            if (attempts++ >= POLL_MAX_ATTEMPTS) {
              // El encode de un partido LARGO puede tardar más que el poll. La subida a
              // Bunny YA está completa; el encode sigue en segundo plano y finalize espera
              // el encode-complete al analizar. NO es un error → resolvemos "processing"
              // (antes hacía reject → marcaba la subida como fallida EN FALSO, #21). El
              // registro local se queda SIN URL de CDN → getServerVideoUrl devuelve null
              // ("encoding_pending"): jamás se entrega el blob: a un consumidor de servidor.
              resolve("processing");
              return;
            }

            try {
              const statusRes = await fetch(`/api/videos/status?videoId=${videoId}`, {
                headers: await authHeaders(),
              });
              const statusData = (await statusRes.json()) as {
                success: boolean;
                data?: {
                  status: string;
                  encodeProgress: number;
                  isReady: boolean;
                  thumbnailUrl: string | null;
                  embedUrl: string;
                  streamUrl: string | null;
                  duration: number;
                  width: number;
                  height: number;
                  fps: number;
                  storageSize: number;
                };
              };

              if (statusData.success && statusData.data) {
                consecutiveErrors = 0; // reset on success
                const d = statusData.data;
                setState((prev) => ({
                  ...prev,
                  encodeProgress: d.encodeProgress,
                }));

                if (d.isReady) {
                  // Update local record with CDN data, clear expired blob URL
                  const local = VideoService.getById(videoId);
                  if (local) {
                    // Revoke blob URL to free memory (it will expire on refresh anyway)
                    if (local.localPath?.startsWith("blob:")) {
                      URL.revokeObjectURL(local.localPath);
                    }
                    VideoService.save({
                      ...local,
                      status: "finished",
                      statusCode: 4,
                      encodeProgress: 100,
                      thumbnailUrl: d.thumbnailUrl,
                      embedUrl: d.embedUrl,
                      streamUrl: d.streamUrl,
                      duration: d.duration,
                      width: d.width,
                      height: d.height,
                      fps: d.fps,
                      storageSize: d.storageSize,
                      localPath: undefined, // CDN URLs replace blob
                    });
                  }
                  resolve("ready");
                  return;
                }

                if (d.status === "error" || d.status === "upload-failed") {
                  reject(new Error(`Bunny encoding failed: ${d.status}`));
                  return;
                }
              }
            } catch (pollErr) {
              // Poll failed — count consecutive failures
              consecutiveErrors++;
              console.warn(`[useVideoUpload] poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, pollErr);
              if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                reject(new Error("Polling falló repetidamente — verifica tu conexión a internet"));
                return;
              }
            }

            pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
          };

          pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        });

        // ── Step 4: El análisis REAL corre async ─────────────────────────────
        // El vídeo ya está subido y codificado. El análisis con corrección PHV
        // (Gemini observa el vídeo completo → biomecánica + VSI + 6 reportes) se
        // dispara ASYNC vía el webhook de Bunny (bunny-uploaded → cola de
        // analyses, que se procesa de inmediato) y aparece en la ficha del
        // jugador (usePlayerAnalysisV2 / by-video hacen el polling).
        //
        // Antes aquí se llamaba a /api/pipeline/start = análisis de 1 SOLO frame
        // (una thumbnail → Claude Haiku, sin tracking ni PHV), inferior y
        // redundante con el pipeline real. Retirado (decisión de producto: la
        // ruta canónica de análisis de jugador es la cola Gemini).
        //
        // Honestidad: esa cola SOLO encola si hay jugador atado y el vídeo es un clip
        // corto (gate compartido con finalize/webhook). Un partido completo queda
        // guardado pero NO "en cola" → no se promete un análisis que no va a llegar.
        const finalVideo = VideoService.getById(videoId);
        const syncGate = evaluateSyncAnalysisGate(knownDurationSec(finalVideo?.duration, durationSec));

        setState((prev) => ({
          ...prev,
          phase: "done",
          video: finalVideo,
          analysis: null,
          analysisQueued: Boolean(playerId) && syncGate.allowed,
          encodeStatus,
          syncGateDurationSec: playerId && !syncGate.allowed ? syncGate.durationSec : null,
        }));

        // Invalidate queries so UI refreshes
        queryClient.invalidateQueries({ queryKey: ["videos"] });
        if (playerId) {
          queryClient.invalidateQueries({ queryKey: ["videos", playerId] });
        }

        // Devolvemos el videoId real para que el llamador dispare onDone con el
        // id correcto (antes VideoUpload leía state.videoId de una closure
        // obsoleta y disparaba el callback con un valor stale o nulo · #26).
        return videoId;
      } catch (err) {
        // Clean up blob URLs to prevent memory leaks
        const currentVideo = state.videoId ? VideoService.getById(state.videoId) : null;
        if (currentVideo?.localPath?.startsWith("blob:")) {
          URL.revokeObjectURL(currentVideo.localPath);
        }

        console.error("[useVideoUpload] Upload failed:", err);
        if (err instanceof ClipConsentBlockedError) {
          // Motivo del servidor tal cual (ya traducido), sin el texto genérico de "error de subida".
          setState((prev) => ({ ...prev, phase: "error", error: err.message, consentBlocked: err.code }));
          return null;
        }
        const { title, description } = getErrorDetails(err, "upload");
        const rawMsg = err instanceof Error ? err.message : String(err);
        // Show diagnostic message + raw error for debugging
        const errorMsg = rawMsg.length > 80 ? rawMsg : `${title}. ${description}`;
        setState((prev) => ({ ...prev, phase: "error", error: errorMsg }));
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerId, reset, queryClient, user]
  );

  const cancel = useCallback(() => {
    tusRef.current?.abort();
    reset();
  }, [reset]);

  return { state, upload, cancel, reset };
}
