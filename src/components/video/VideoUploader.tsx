/**
 * VITAS · Video Uploader
 *
 * Sube un vídeo directamente a Bunny Stream usando TUS protocol
 * (resumable, soporta archivos grandes, no pasa por nuestro servidor).
 *
 * Flujo:
 *   1. Llama /api/videos/create-upload → recibe credenciales TUS
 *   2. Sube archivo a Bunny via TUS (con barra de progreso)
 *   3. Llama /api/videos/finalize → dispara análisis
 *   4. Polling a /api/analyses/by-video hasta status='completed'
 *
 * Auth: los tres endpoints son `requireAuth` y `verifyAuth` (api/_lib/auth.ts) SOLO
 * acepta `Authorization: Bearer <jwt>`. Antes se mandaba `credentials: "include"`
 * sin cabecera → 401 SIEMPRE y la subida desde IDP/Tactical nunca funcionó. Ahora
 * cada llamada usa el helper compartido `getAuthHeaders` (inv #7), pedido JUSTO antes
 * de cada fetch para que una subida larga no finalice con un token ya caducado (el
 * helper lo refresca). Sin sesión (demo / Supabase sin configurar) el helper no lanza
 * y devuelve solo Content-Type → el servidor responde 401 y la UI muestra el error
 * genérico, sin romperse.
 *
 * Consentimiento (decisión del owner, 30 sep): el botón de subir solo se habilita con la
 * declaración versionada marcada (ClipAttestationField); viaja en create-upload (que la
 * guarda con el vídeo ANTES de crearlo en Bunny) y en finalize. Un bloqueo del servidor
 * (sin declaración, menor de 14 conocido sin consentimiento parental verificado, o no se
 * pudo comprobar) para el flujo con su motivo traducido; nunca se reintenta en bucle.
 *
 * Requiere: npm install tus-js-client
 *
 * Uso:
 *   <VideoUploader playerId={player.id} onComplete={(analysisId) => navigate(...)} />
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";
import { finalizeSyncGateMessage } from "@/lib/syncVideoAnalysisGate";
import { getAuthHeaders } from "@/lib/apiAuth";
import ClipAttestationField from "@/components/consent/ClipAttestationField";
import { buildClipAttestation, clipConsentErrorFromResponse } from "@/lib/shared/videoConsent";
import * as tus from "tus-js-client";
import {
  getActiveFieldFormat,
  setActiveFieldFormat,
  type FieldFormat,
} from "@/lib/yolo/fieldFormatConfig";

interface Props {
  playerId: string;
  playerName?: string;
  onComplete?: (analysisId: string) => void;
}

type UploadState =
  | "idle"
  | "creating"
  | "uploading"
  | "processing_bunny"
  | "queued"
  | "analyzing"
  | "completed"
  | "error";

interface VideoMeta {
  videoId: string;
  bunnyVideoId: string;
  libraryId: number;
  tusUploadUrl: string;
  authorizationSignature: string;
  authorizationExpire: number;
}

export function VideoUploader({ playerId, playerName, onComplete }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState<string>("");
  // Formato del partido: el usuario lo elige ANTES de analizar → selecciona
  // internamente plantilla, dimensiones (metros) y métricas del campo correcto.
  const [fieldFormat, setFieldFormat] = useState<FieldFormat>(getActiveFieldFormat());
  // Declaración del entrenador para ESTE vídeo (sin marcar al empezar y tras reiniciar).
  const [attested, setAttested] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function chooseFormat(fmt: FieldFormat) {
    setFieldFormat(fmt);
    setActiveFieldFormat(fmt);
  }

  // Reset
  function reset() {
    setState("idle");
    setProgress(0);
    setStatusMessage("");
    setError(null);
    setAnalysisId(null);
    setFile(null);
    setTitle("");
    setAttested(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Validación cliente del archivo
  function validateFile(f: File): string | null {
    if (f.size > 500 * 1024 * 1024) return t("videoUploader.errorTooLarge");
    if (f.size < 100 * 1024) return t("videoUploader.errorTooSmall");
    if (!f.type.startsWith("video/")) return t("videoUploader.errorNotVideo");
    return null;
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    const validation = validateFile(selected);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setFile(selected);
    if (!title) {
      // Sugerir título basado en fecha
      const today = new Date().toLocaleDateString("es-ES");
      setTitle(t("videoUploader.defaultTitle", { date: today }));
    }
  }

  async function handleUpload() {
    const attestation = buildClipAttestation(attested);
    if (!file || !title || !attestation) return;
    setError(null);
    setState("creating");
    setStatusMessage(t("videoUploader.statusPreparing"));

    try {
      // 1. Crear video en Bunny + obtener credenciales TUS
      const createHeaders = await getAuthHeaders();
      const createRes = await fetch("/api/videos/create-upload", {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify({
          playerId,
          title,
          durationSec: undefined,
          attestation,
        }),
      });

      // 401 CON token enviado = sesión caducada/rechazada → se dice tal cual. Sin token
      // (demo / sin sesión) no hay sesión que "caducar" → cae al error genérico de abajo.
      if (createRes.status === 401 && createHeaders.Authorization) {
        throw new Error(t("errors.sessionExpired"));
      }
      const createData = await createRes.json();
      // Bloqueo de consentimiento: el motivo del servidor, traducido (no un error genérico).
      const createConsentErr = clipConsentErrorFromResponse(createData, i18n.language);
      if (createConsentErr) throw createConsentErr;
      if (!createRes.ok || !createData.success) {
        throw new Error(createData?.error?.message ?? t("videoUploader.errorCreatingUpload"));
      }

      const meta: VideoMeta = createData.data;

      // 2. Subir con TUS protocol
      setState("uploading");
      setStatusMessage(t("videoUploader.statusUploading"));

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: meta.tusUploadUrl,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            AuthorizationSignature: meta.authorizationSignature,
            AuthorizationExpire: String(meta.authorizationExpire),
            VideoId: meta.bunnyVideoId,
            LibraryId: String(meta.libraryId),
          },
          metadata: {
            filetype: file.type,
            title,
          },
          onError: (err) => reject(err),
          onProgress: (bytesUploaded, bytesTotal) => {
            const pct = Math.floor((bytesUploaded / bytesTotal) * 100);
            setProgress(pct);
          },
          onSuccess: () => resolve(),
        });

        upload.start();
      });

      // 3. Finalizar (consulta Bunny + dispara webhook)
      setState("processing_bunny");
      setStatusMessage(t("videoUploader.statusBunnyProcessing"));
      setProgress(100);

      let attempts = 0;
      let finalized = false;
      while (attempts < 12 && !finalized) {
        attempts++;
        await new Promise((r) => setTimeout(r, 5000));

        const finRes = await fetch("/api/videos/finalize", {
          method: "POST",
          headers: await getAuthHeaders(),
          body: JSON.stringify({
            videoId: meta.videoId,
            bunnyVideoId: meta.bunnyVideoId,
            // Idioma de la UI → finalize lo persiste (mig 064) para que los 9 informes
            // asíncronos salgan en este idioma y no siempre en español.
            locale: normalizeLocale(i18n.language),
            // La misma declaración que marcó el usuario para este vídeo (create-upload ya
            // la guardó; finalize la vuelve a exigir antes de encolar el análisis).
            attestation,
          }),
        });

        // create-upload ya aceptó un token en este mismo flujo → un 401 aquí es una
        // sesión perdida: se para con el motivo real en vez de reintentar 12 veces y
        // acabar en un "Bunny tardó demasiado" falso.
        if (finRes.status === 401) throw new Error(t("errors.sessionExpired"));
        const finData = await finRes.json();
        // Bloqueo de consentimiento → se para con su motivo (no se reintenta).
        const finConsentErr = clipConsentErrorFromResponse(finData, i18n.language);
        if (finConsentErr) throw finConsentErr;
        // Gate honesto del servidor (vídeo demasiado largo para la cola de clips cortos):
        // se muestra el motivo real en vez de reintentar hasta un "timeout" falso.
        const gateMsg = finalizeSyncGateMessage(t, finData);
        if (gateMsg) throw new Error(gateMsg);
        if (finData?.data?.ready) {
          finalized = true;
          break;
        }
        setStatusMessage(t("videoUploader.statusBunnyProgress", { attempts }));
      }

      if (!finalized) throw new Error(t("videoUploader.errorBunnyTimeout"));

      // 4. Polling al análisis
      setState("queued");
      setStatusMessage(t("videoUploader.statusQueued"));

      let analysisCompleted = false;
      let pollAttempts = 0;
      while (pollAttempts < 30 && !analysisCompleted) {
        pollAttempts++;
        await new Promise((r) => setTimeout(r, 8000));

        const statusRes = await fetch(
          `/api/analyses/by-video?videoId=${meta.videoId}`,
          { headers: await getAuthHeaders() }
        );
        // Mismo motivo que en finalize: sin esto el polling ignoraba el 401 en silencio
        // durante 4 min y terminaba en "está tardando" cuando en realidad no había sesión.
        if (statusRes.status === 401) throw new Error(t("errors.sessionExpired"));
        if (statusRes.ok) {
          const status = await statusRes.json();
          const a = status?.data?.analysis;
          if (a) {
            setAnalysisId(a.id);
            if (a.status === "processing" || a.status === "processing_reports") {
              setState("analyzing");
              setStatusMessage(t("videoUploader.statusAnalyzing"));
            } else if (a.status === "completed") {
              analysisCompleted = true;
              setState("completed");
              // status_message SOLO viene poblado en runs PARCIALES ("Parcial: N de M
              // informes"): declararlo, no presentar un parcial como completo (invariante
              // de honestidad). En un run completo es null → mensaje genérico.
              setStatusMessage(a.status_message ?? t("videoUploader.statusCompleted"));
              onComplete?.(a.id);
              break;
            } else if (a.status === "failed") {
              throw new Error(a.status_message ?? t("videoUploader.errorAnalysisFailed"));
            }
          }
        }
      }

      if (!analysisCompleted) {
        setStatusMessage(t("videoUploader.statusTakingLong"));
      }
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : t("videoUploader.errorUnknown"));
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <header>
        <div className="text-xs uppercase tracking-widest text-purple-600 font-bold mb-1">
          {t("videoUploader.eyebrow")}
        </div>
        <h2 className="font-rajdhani text-2xl font-bold mb-2">
          {t("videoUploader.heading", { name: playerName ?? t("videoUploader.playerFallback") })}
        </h2>
        <p className="text-sm text-slate-600">
          {t("videoUploader.subheading")}
        </p>
      </header>

      {state === "idle" && (
        <>
          <div>
            <label className="block text-sm font-semibold mb-1">{t("videoUploader.titleLabel")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("videoUploader.titlePlaceholder")}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1">{t("videoUploader.fieldFormatLabel")}</label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("videoUploader.fieldFormatLabel")}>
              {(["f8", "f11"] as FieldFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  role="radio"
                  aria-checked={fieldFormat === fmt}
                  onClick={() => chooseFormat(fmt)}
                  className={
                    "px-4 py-3 rounded-xl border text-sm font-semibold transition-colors " +
                    (fieldFormat === fmt
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-slate-200 text-slate-600 hover:border-slate-300")
                  }
                >
                  {t(fmt === "f8" ? "videoUploader.fieldFormatF8" : "videoUploader.fieldFormatF11")}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-1">{t("videoUploader.fieldFormatHint")}</p>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1">{t("videoUploader.videoLabel")}</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/x-m4v,video/*"
              onChange={handleFileSelect}
              className="block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            <p className="text-xs text-slate-500 mt-1">
              {t("videoUploader.formatsHint")}
            </p>
          </div>

          {file && (
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="font-semibold">{file.name}</div>
              <div className="text-slate-600">
                {(file.size / 1024 / 1024).toFixed(1)} MB · {file.type}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          <ClipAttestationField id="video-uploader-attestation" checked={attested} onChange={setAttested} purpose="upload" />

          <button
            onClick={handleUpload}
            disabled={!file || !title || !attested}
            className="w-full py-3.5 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold disabled:opacity-50"
          >
            {t("videoUploader.uploadButton")}
          </button>
        </>
      )}

      {state !== "idle" && (
        <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-4">
          <div className="flex items-center gap-3">
            {state === "completed" ? (
              <span className="text-3xl">✅</span>
            ) : state === "error" ? (
              <span className="text-3xl">❌</span>
            ) : (
              <div className="w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
            )}
            <div className="font-rajdhani font-bold text-lg">{statusMessage}</div>
          </div>

          {(state === "uploading" || state === "processing_bunny") && (
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-600 to-purple-600 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {state === "completed" && analysisId && (
            <a
              href={`/player/${playerId}/analysis/${analysisId}`}
              className="block text-center w-full py-3 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold"
            >
              {t("videoUploader.viewReports")}
            </a>
          )}

          {(state === "error" || state === "completed") && (
            <button
              onClick={reset}
              className="w-full py-2.5 rounded-full border border-slate-300 text-sm font-semibold hover:bg-slate-50"
            >
              {t("videoUploader.uploadAnother")}
            </button>
          )}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
