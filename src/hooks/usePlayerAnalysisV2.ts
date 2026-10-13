/**
 * VITAS · usePlayerAnalysisV2 (Sprint 5 migración)
 *
 * Hook moderno para análisis de jugador. REEMPLAZA `usePlayerIntelligence.ts`
 * (que llamaba al deprecated /api/agents/video-intelligence).
 *
 * Nuevo flujo:
 *   1. POST /api/videos/create-upload → recibe credenciales TUS
 *   2. Cliente sube vídeo a Bunny via TUS protocol
 *   3. POST /api/videos/finalize → dispara webhook
 *   4. Webhook encola análisis · Modal procesa con MediaPipe
 *   5. Modal callback → orchestrator dispara 6 reportes Claude
 *   6. Polling /api/analyses/by-video hasta status='completed'
 *   7. GET /api/analyses/reports → devuelve los 6 reportes
 *
 * Diferencias vs usePlayerIntelligence (legacy):
 *   ✅ Pipeline real con GPU (MediaPipe 33 keypoints) en lugar de Claude vision
 *   ✅ 6 reportes especializados (vs 1 monolítico)
 *   ✅ Async con queue (resiste vídeos largos)
 *   ✅ Async upload directo a Bunny (no pasa por Vercel)
 *   ✅ VSI + PHV + scanning rate calculados
 *   ❌ Más latencia total (~90s vs ~30s · pero mejor calidad)
 *
 * Plan: cuando este hook esté validado, migrar `VitasLab.tsx` y borrar
 * `usePlayerIntelligence.ts` + `_video-intelligence.ts`.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import * as tus from "tus-js-client";
import { getAuthHeaders } from "@/lib/apiAuth";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { unwrapDnaContent } from "@/lib/reports/reportItems";
import { IS_DEMO } from "@/lib/demoMode";
import { PlayerService } from "@/services/real/playerService";
import { buildDemoAnalysisRows } from "@/lib/demo/demoReports";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";
import { finalizeSyncGateMessage } from "@/lib/syncVideoAnalysisGate";
import {
  ClipConsentBlockedError,
  clipConsentErrorFromResponse,
  type ClipAttestation,
} from "@/lib/shared/videoConsent";

/**
 * Consentimiento (decisión del owner, 30 sep · src/lib/shared/videoConsent): create-upload,
 * finalize y generate-reports exigen la declaración del entrenador (la que marca el
 * usuario en la UI; aquí solo se reenvía, nunca se fabrica) y, para un menor de 14
 * conocido, consentimiento parental verificado. Un bloqueo se lanza como
 * ClipConsentBlockedError con su motivo traducido y NUNCA cae a otra ruta de análisis.
 */
function throwIfConsentBlocked(json: unknown): void {
  const err = clipConsentErrorFromResponse(json, i18n.language);
  if (err) throw err;
}

// ── Tipos ─────────────────────────────────────────────────────────

export type AnalysisV2Step =
  | "idle"
  | "creating_upload"
  | "uploading"
  | "bunny_processing"
  | "queued"
  | "modal_processing"      // @deprecated — kept for backward compat
  | "gemini_analyzing"      // Sprint 7: Gemini video analysis step
  | "generating_reports"
  | "completed"
  | "error";

export interface AnalysisV2State {
  step: AnalysisV2Step;
  progress: number;       // 0-100
  message: string;
  error: string | null;
}

export interface AnalysisV2Result {
  analysisId: string | null;
  videoId: string | null;
  vsi: { vsi: number; tier: string; tierLabel: string; confidence?: number } | null;
  phv: Record<string, unknown> | null;
  similarity: Record<string, unknown> | null;
  scanning: Record<string, unknown> | null;
  biomechanics: Record<string, unknown> | null;
  reports: Array<{
    report_type: string;
    content: Record<string, unknown>;
    model: string;
    prompt_version: string;
  }> | null;
  completedAt: string | null;
}

const INITIAL_STATE: AnalysisV2State = {
  step: "idle",
  progress: 0,
  message: "",
  error: null,
};

const INITIAL_RESULT: AnalysisV2Result = {
  analysisId: null,
  videoId: null,
  vsi: null,
  phv: null,
  similarity: null,
  scanning: null,
  biomechanics: null,
  reports: null,
  completedAt: null,
};

// ── Polling helpers ───────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (v: T) => boolean,
  maxAttempts: number,
  intervalMs: number,
  abortSignal?: AbortSignal
): Promise<T | null> {
  for (let i = 0; i < maxAttempts; i++) {
    if (abortSignal?.aborted) return null;
    const v = await fn();
    if (v && predicate(v)) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Hook principal ────────────────────────────────────────────────

export function usePlayerAnalysisV2() {
  const [state, setState] = useState<AnalysisV2State>(INITIAL_STATE);
  const [result, setResult] = useState<AnalysisV2Result>(INITIAL_RESULT);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL_STATE);
    setResult(INITIAL_RESULT);
  }, []);

  /**
   * Análisis completo end-to-end:
   *   file → Bunny → Modal → 6 reports
   */
  const startAnalysis = useCallback(
    async (params: { file: File; playerId: string; title: string; attestation?: ClipAttestation | null }) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setResult(INITIAL_RESULT);

      try {
        // ── 1. Crear upload en Bunny ──────────────────
        setState({ step: "creating_upload", progress: 5, message: i18n.t("videoAnalysis.progress.preparingUpload"), error: null });
        const headers = await getAuthHeaders();
        const createRes = await fetch("/api/videos/create-upload", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            playerId: params.playerId,
            title: params.title,
            durationSec: undefined,
            ...(params.attestation ? { attestation: params.attestation } : {}),
          }),
          signal: ac.signal,
        });
        const createData = await createRes.json();
        throwIfConsentBlocked(createData);
        if (!createRes.ok || !createData.success) {
          throw new Error(createData?.error?.message ?? i18n.t("videoAnalysis.errors.createUpload"));
        }
        const meta = createData.data as {
          videoId: string;
          bunnyVideoId: string;
          libraryId: number;
          tusUploadUrl: string;
          authorizationSignature: string;
          authorizationExpire: number;
        };

        setResult((r) => ({ ...r, videoId: meta.videoId }));

        // ── 2. Upload TUS directo a Bunny ─────────────
        setState({ step: "uploading", progress: 10, message: i18n.t("videoAnalysis.progress.uploading"), error: null });
        await new Promise<void>((resolve, reject) => {
          const upload = new tus.Upload(params.file, {
            endpoint: meta.tusUploadUrl,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            headers: {
              AuthorizationSignature: meta.authorizationSignature,
              AuthorizationExpire: String(meta.authorizationExpire),
              VideoId: meta.bunnyVideoId,
              LibraryId: String(meta.libraryId),
            },
            metadata: { filetype: params.file.type, title: params.title },
            onError: (err) => reject(err),
            onProgress: (bytesUploaded, bytesTotal) => {
              const pct = 10 + Math.floor((bytesUploaded / bytesTotal) * 30);
              setState((s) => ({ ...s, progress: pct, message: i18n.t("videoAnalysis.progress.uploadingPct", { pct: Math.floor((bytesUploaded / bytesTotal) * 100) }) }));
            },
            onSuccess: () => resolve(),
          });
          upload.start();
          ac.signal.addEventListener("abort", () => upload.abort());
        });

        // ── 3. Finalizar (esperar a Bunny encoding) ──
        setState({ step: "bunny_processing", progress: 40, message: i18n.t("videoAnalysis.progress.bunnyProcessing"), error: null });
        let attempts = 0;
        let finalized = false;
        while (attempts < 12 && !finalized && !ac.signal.aborted) {
          attempts++;
          await new Promise((r) => setTimeout(r, 5000));
          const finRes = await fetch("/api/videos/finalize", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            // locale: idioma de la UI → finalize lo persiste (mig 064) y los informes
            // asíncronos salen en él (antes siempre en español).
            body: JSON.stringify({
              videoId: meta.videoId,
              bunnyVideoId: meta.bunnyVideoId,
              locale: normalizeLocale(i18n.language),
              ...(params.attestation ? { attestation: params.attestation } : {}),
            }),
            signal: ac.signal,
          });
          const finData = await finRes.json();
          throwIfConsentBlocked(finData);
          // Gate honesto del servidor: vídeo demasiado largo para la cola de clips cortos
          // → se para aquí con el motivo real, no tras 12 reintentos con un "timeout" falso.
          const gateMsg = finalizeSyncGateMessage(i18n.t.bind(i18n), finData);
          if (gateMsg) throw new Error(gateMsg);
          if (finData?.data?.ready) {
            finalized = true;
            break;
          }
          setState((s) => ({ ...s, progress: 40 + attempts, message: i18n.t("videoAnalysis.progress.bunnyEncoding", { n: attempts }) }));
        }
        if (!finalized) throw new Error(i18n.t("errors.bunnyTimeout"));

        // ── 4. Polling análisis ──────────────────────
        setState({ step: "queued", progress: 55, message: i18n.t("videoAnalysis.progress.queuedCron"), error: null });

        const analysisStatus = await pollUntil(
          async () => {
            const res = await fetch(`/api/analyses/by-video?videoId=${meta.videoId}`, { headers, signal: ac.signal });
            if (!res.ok) return null;
            const d = await res.json();
            return d?.data?.analysis ?? null;
          },
          (a) => a?.status === "completed" || a?.status === "completed_partial" || a?.status === "failed",
          60, // 60 attempts
          5000, // cada 5 seg = 5 minutos máximo
          ac.signal
        );

        if (!analysisStatus) throw new Error(i18n.t("errors.analysisTimeout"));
        if (analysisStatus.status === "failed") {
          throw new Error(analysisStatus.status_message ?? i18n.t("videoAnalysis.errors.analysisFailed"));
        }

        setResult((r) => ({ ...r, analysisId: analysisStatus.id }));

        // Ir actualizando estado durante polling para UX
        if (analysisStatus.status === "processing") {
          setState({ step: "modal_processing", progress: 70, message: i18n.t("videoAnalysis.progress.analyzingAi"), error: null });
        } else if (analysisStatus.status === "processing_reports") {
          setState({ step: "generating_reports", progress: 85, message: i18n.t("videoAnalysis.progress.generatingReports"), error: null });
        }

        // ── 5. Cargar reportes ───────────────────────
        setState({ step: "generating_reports", progress: 90, message: i18n.t("videoAnalysis.progress.loadingReports"), error: null });

        const reportsRes = await fetch(`/api/analyses/reports?analysisId=${analysisStatus.id}`, {
          headers,
          signal: ac.signal,
        });
        const reportsData = await reportsRes.json();
        if (!reportsRes.ok || !reportsData.success) {
          throw new Error(reportsData?.error?.message ?? i18n.t("videoAnalysis.errors.loadingReports"));
        }

        const a = reportsData.data.analysis;
        setResult({
          analysisId: a.id,
          videoId: a.video_id,
          vsi: a.vsi,
          phv: a.phv,
          similarity: a.similarity,
          scanning: null, // por ahora no se persiste separado · está en biomechanics
          biomechanics: a.biomechanics,
          reports: reportsData.data.reports,
          completedAt: a.completed_at,
        });

        setState({ step: "completed", progress: 100, message: i18n.t("videoAnalysis.progress.completed"), error: null });

        return reportsData.data;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Error desconocido";
        setState({ step: "error", progress: 0, message: i18n.t("videoAnalysis.progress.error"), error: errorMsg });
        throw err;
      }
    },
    []
  );

  /**
   * Recargar reportes de un análisis existente (sin subir vídeo).
   * Útil cuando el padre vuelve a la app y quiere ver el último.
   */
  const loadAnalysis = useCallback(async (analysisId: string) => {
    try {
      setState({ step: "generating_reports", progress: 90, message: i18n.t("videoAnalysis.progress.loadingReports"), error: null });
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/analyses/reports?analysisId=${analysisId}`, { headers });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.errorDetail?.message ?? (typeof data?.error === "string" ? data.error : null) ?? i18n.t("videoAnalysis.errors.notFound"));
      }

      const a = data.data.analysis;
      setResult({
        analysisId: a.id,
        videoId: a.video_id,
        vsi: a.vsi,
        phv: a.phv,
        similarity: a.similarity,
        scanning: null,
        biomechanics: a.biomechanics,
        reports: data.data.reports,
        completedAt: a.completed_at,
      });
      setState({ step: "completed", progress: 100, message: i18n.t("videoAnalysis.progress.loaded"), error: null });
      return data.data;
    } catch (err) {
      setState({
        step: "error",
        progress: 0,
        message: i18n.t("videoAnalysis.progress.errorLoading"),
        error: err instanceof Error ? err.message : "unknown",
      });
      throw err;
    }
  }, []);

  /**
   * Analizar un vídeo ya subido a Bunny (flujo sin re-upload).
   * Requiere videoId (Supabase UUID) y bunnyVideoId (Bunny GUID).
   * Si ya hay un análisis completado lo carga directamente.
   */
  const analyzeExistingVideo = useCallback(
    async (params: {
      videoId: string;
      bunnyVideoId: string;
      playerId: string;
      playedPosition?: string;
      /** Declaración marcada por el usuario para ESTE (re)análisis (finalize la exige). */
      attestation?: ClipAttestation | null;
    }) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setResult(INITIAL_RESULT);

      try {
        const headers = await getAuthHeaders();

        // 1. Verificar si ya existe un análisis completado
        setState({ step: "queued", progress: 15, message: i18n.t("videoAnalysis.progress.checkingExisting"), error: null });
        const checkRes = await fetch(`/api/analyses/by-video?videoId=${params.videoId}`, {
          headers, signal: ac.signal,
        });
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          const existing = checkData?.data?.analysis;
          if (existing?.status === "completed" || existing?.status === "completed_partial") {
            setResult((r) => ({ ...r, analysisId: existing.id, videoId: params.videoId }));
            return await loadAnalysis(existing.id);
          }
        }

        // 2. Disparar pipeline via finalize (trigger webhook → Modal → orchestrator)
        setState({ step: "bunny_processing", progress: 30, message: i18n.t("videoAnalysis.progress.preparingAnalysis"), error: null });
        let finalizeAttempts = 0;
        let finalized = false;
        while (finalizeAttempts < 12 && !finalized && !ac.signal.aborted) {
          finalizeAttempts++;
          const finRes = await fetch("/api/videos/finalize", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: params.videoId,
              bunnyVideoId: params.bunnyVideoId,
              playerId: params.playerId,                // jugador elegido → finalize siembra player_id/tenant_id + encola
              playedPosition: params.playedPosition,    // posición jugada en este video
              locale: normalizeLocale(i18n.language),   // idioma de la UI → informes en ese idioma (mig 064)
              ...(params.attestation ? { attestation: params.attestation } : {}),
            }),
            signal: ac.signal,
          });
          const finData = await finRes.json();
          throwIfConsentBlocked(finData);
          const gateMsg = finalizeSyncGateMessage(i18n.t.bind(i18n), finData);
          if (gateMsg) throw new Error(gateMsg);
          if (finData?.data?.ready) { finalized = true; break; }
          await new Promise((r) => setTimeout(r, 5000));
          setState((s) => ({ ...s, progress: 30 + finalizeAttempts * 2, message: i18n.t("videoAnalysis.progress.bunnyEncoding", { n: finalizeAttempts }) }));
        }

        // 3. Polling hasta completado
        setState({ step: "queued", progress: 55, message: i18n.t("videoAnalysis.progress.queuedProcessingAi"), error: null });
        const analysisStatus = await pollUntil(
          async () => {
            const res = await fetch(`/api/analyses/by-video?videoId=${params.videoId}`, { headers, signal: ac.signal });
            if (!res.ok) return null;
            const d = await res.json();
            return d?.data?.analysis ?? null;
          },
          (a) => a?.status === "completed" || a?.status === "completed_partial" || a?.status === "failed",
          60, 5000, ac.signal
        );

        if (!analysisStatus) throw new Error(i18n.t("errors.analysisTimeout"));
        if (analysisStatus.status === "failed") throw new Error(analysisStatus.status_message ?? i18n.t("videoAnalysis.errors.analysisFailed"));

        setResult((r) => ({ ...r, analysisId: analysisStatus.id, videoId: params.videoId }));
        setState({ step: "generating_reports", progress: 90, message: i18n.t("videoAnalysis.progress.loadingReports"), error: null });
        return await loadAnalysis(analysisStatus.id);

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Error desconocido";
        setState({ step: "error", progress: 0, message: i18n.t("videoAnalysis.progress.error"), error: errorMsg });
        throw err;
      }
    },
    [loadAnalysis]
  );

  /**
   * Análisis con datos client-side (MediaPipe + YOLO tracking).
   * Bypasses Modal — crea análisis en Supabase y dispara reportes Claude
   * directamente con la biomecánica y métricas calculadas en el navegador.
   *
   * Esto conecta el pipeline completo sin depender de Modal.
   */
  const analyzeWithClientData = useCallback(
    async (params: {
      videoId: string;
      playerId: string;
      playedPosition?: string;
      biomechanics?: Record<string, unknown> | null;
      physicalMetrics?: Record<string, unknown> | null;
      eventSummary?: Record<string, unknown> | null;
      /** Declaración marcada por el usuario (generate-reports la exige; también el fallback). */
      attestation?: ClipAttestation | null;
    }) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setResult(INITIAL_RESULT);

      try {
        const headers = await getAuthHeaders();

        // 1. Crear o encontrar análisis en Supabase
        setState({ step: "queued", progress: 20, message: i18n.t("videoAnalysis.progress.creatingClientAnalysis"), error: null });

        if (SUPABASE_CONFIGURED) {
          // Upsert análisis con datos de biomecánica del cliente
          const { data: analysis, error: upsertError } = await supabase
            .from("analyses")
            .upsert({
              video_id: params.videoId,
              player_id: params.playerId,
              status: "processing_reports",
              biomechanics: params.biomechanics ?? null,
              vsi: null, // Will be calculated by reports
              played_position: params.playedPosition ?? null,
              client_metrics: {
                physicalMetrics: params.physicalMetrics ?? null,
                eventSummary: params.eventSummary ?? null,
                source: "client_mediapipe_yolo",
                processedAt: new Date().toISOString(),
              },
            }, { onConflict: "video_id" })
            .select("id")
            .single();

          if (upsertError) {
            console.warn("[V2] Supabase upsert warning:", upsertError.message);
          }

          const analysisId = analysis?.id;
          if (analysisId) {
            setResult(r => ({ ...r, analysisId, videoId: params.videoId }));
          }

          // 2. Disparar generación de reportes Claude
          setState({ step: "generating_reports", progress: 50, message: i18n.t("videoAnalysis.progress.generatingReportsSpecialized"), error: null });

          // Trigger report generation via API
          try {
            const reportRes = await fetch("/api/analyses/generate-reports", {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({
                analysisId,
                playerId: params.playerId,
                videoId: params.videoId,
                biomechanics: params.biomechanics,
                physicalMetrics: params.physicalMetrics,
                eventSummary: params.eventSummary,
                playedPosition: params.playedPosition,
                // FASE 5 · idioma activo → reportes bilingües ES/EN
                locale: normalizeLocale(i18n.language),
                ...(params.attestation ? { attestation: params.attestation } : {}),
              }),
              signal: ac.signal,
            });

            if (!reportRes.ok) {
              // Bloqueo de consentimiento: se para aquí (sin caer al pipeline estándar).
              const errJson = await reportRes.json().catch(() => null);
              throwIfConsentBlocked(errJson);
            }

            if (reportRes.ok) {
              setState({ step: "generating_reports", progress: 75, message: i18n.t("videoAnalysis.progress.reportsGenerating"), error: null });

              // Poll until complete
              const completed = await pollUntil(
                async () => {
                  const res = await fetch(`/api/analyses/by-video?videoId=${params.videoId}`, { headers, signal: ac.signal });
                  if (!res.ok) return null;
                  const d = await res.json();
                  return d?.data?.analysis ?? null;
                },
                (a) => a?.status === "completed" || a?.status === "completed_partial",
                30, 3000, ac.signal
              );

              if (completed) {
                return await loadAnalysis(completed.id);
              }
            }
          } catch (reportErr) {
            // Un bloqueo de consentimiento NUNCA cae al pipeline alternativo.
            if (reportErr instanceof ClipConsentBlockedError) throw reportErr;
            // Report generation endpoint may not exist yet — fall back to existing flow
            console.warn("[V2] Report generation endpoint not available, trying existing pipeline");
          }
        }

        // 3. Fallback: try the standard analyzeExistingVideo flow
        setState({ step: "queued", progress: 40, message: i18n.t("videoAnalysis.progress.tryingStandardPipeline"), error: null });
        const bunnyVideoId = params.videoId; // May need different extraction
        return await analyzeExistingVideo({
          videoId: params.videoId,
          bunnyVideoId,
          playerId: params.playerId,
          playedPosition: params.playedPosition,
          attestation: params.attestation,
        });

      } catch (err) {
        if (err instanceof ClipConsentBlockedError) {
          // No es un "completado parcial": el servidor no analiza → error con su motivo.
          setState({ step: "error", progress: 0, message: i18n.t("videoAnalysis.progress.error"), error: err.message });
          throw err;
        }
        const errorMsg = err instanceof Error ? err.message : "Error desconocido";
        // Don't throw — store biomechanics result even if reports fail
        setState({ step: "completed", progress: 100, message: i18n.t("videoAnalysis.progress.biomechanicsSaved"), error: null });
        setResult(r => ({
          ...r,
          videoId: params.videoId,
          biomechanics: params.biomechanics as Record<string, unknown> ?? null,
          completedAt: new Date().toISOString(),
        }));
        console.warn("[V2] analyzeWithClientData partial:", errorMsg);
      }
    },
    [loadAnalysis, analyzeExistingVideo]
  );

  // Cleanup al unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    state,
    result,
    isProcessing: state.step !== "idle" && state.step !== "completed" && state.step !== "error",
    isCompleted: state.step === "completed",
    isError: state.step === "error",
    startAnalysis,
    analyzeExistingVideo,
    analyzeWithClientData,
    loadAnalysis,
    reset,
  };
}

// ── useSavedAnalysesV2 ────────────────────────────────────────────
// Replaces the legacy useSavedAnalyses (player_analyses table).
// Queries V2 analyses+reports tables, maps to legacy VideoIntelligenceOutput
// shape so existing consumer components continue to work without changes.

export type AnalysisDbRow = {
  id: string;
  player_id: string;
  video_id: string;
  created_at: string;
  vsi: Record<string, unknown> | null;
  /** Estadísticas cuantitativas de partido (opcional; el demo las sirve, el pipeline real las anida en su propio flujo). */
  metricasCuantitativas?: Record<string, unknown>;
  reports: Array<{ report_type: string; content: Record<string, unknown> }>;
};

function normalizeTier(tier?: string): string {
  const map: Record<string, string> = {
    elite: "elite", alto: "alto", medio_alto: "medio_alto", medio: "medio",
    desarrollo: "desarrollo", high: "alto", mid_high: "medio_alto", mid: "medio",
    developing: "desarrollo", talent: "medio_alto",
  };
  return map[tier ?? ""] ?? "medio";
}

function mapDbRowToLegacy(row: AnalysisDbRow) {
  const rpts = row.reports ?? [];
  const get = (type: string) =>
    (rpts.find((r) => r.report_type === type)?.content ?? {}) as Record<string, unknown>;

  if (rpts.length === 0) {
    return { id: row.id, player_id: row.player_id, video_id: row.video_id, created_at: row.created_at, report: null };
  }

  const pr  = get("player-report");
  const dna = unwrapDnaContent(get("dna-profile")); // content dna-profile viene envuelto {data:{…,dna}}
  const bm  = get("best-match");
  const pj  = get("projection");
  const dp  = get("development-plan");

  // ¿Datos REALES de proyección? Sin ellos se gatea (null), no se fabrica "Semi-pro" (#40 clase).
  const hasProjection = !!(
    (pj.optimistic as unknown) ?? (pj.escenarioOptimista as unknown) ??
    (pj.realistic as unknown)  ?? (pj.escenarioRealista as unknown)
  );
  const tierLabel  = normalizeTier((row.vsi?.tierLabel as string) ?? (pr.tier_label as string));
  const strengths  = (pr.strengths as Array<{ title: string }> | undefined) ?? [];
  const areasRaw   = (pr.areas_to_improve as Array<{ title: string }> | undefined) ?? [];
  const defaultDim = { score: 5, observacion: "Estimado por IA" };

  const report = {
    playerId:    row.player_id,
    videoId:     row.video_id ?? "",
    generatedAt: row.created_at,
    estadoActual: {
      resumenEjecutivo:    (pr.executive_summary as string) ?? "Análisis completado.",
      nivelActual:         tierLabel,
      fortalezasPrimarias: strengths.map((s) => s.title),
      areasDesarrollo:     areasRaw.map((a) => a.title),
      dimensiones: {
        velocidadDecision:   defaultDim,
        tecnicaConBalon:     defaultDim,
        inteligenciaTactica: defaultDim,
        capacidadFisica:     defaultDim,
        liderazgoPresencia:  defaultDim,
        eficaciaCompetitiva: defaultDim,
      },
      // defaultDim es CONSTANTE (el pipeline no mide dimensiones) → no son reales.
      dimensionesMedidas: false,
      // null cuando el VSI-vídeo compuesto está BLOQUEADO (el backend devuelve
      // vsi:null si <4/5 dimensiones reales — hoy siempre, técnica/mental/táctica no
      // se miden). Antes `?? 50` lo volvía 0 → cada informe pintaba "VSI +0 pts", un
      // ajuste fabricado (viola inv #2). Con null, el render oculta el badge (#40).
      ajusteVSIVideoScore: row.vsi?.vsi == null ? null : Math.round((row.vsi.vsi as number) - 50),
    },
    adnFutbolistico: {
      // Campos REALES del agente (_dna-profile.ts): primary_style/style_summary,
      // natural_role, pressure_behavior. Los nombres antiguos (playing_style,
      // archetype, mentality) nunca existieron en el schema → siempre defaults.
      estiloJuego:      ((dna.style_summary as string) ?? (dna.primary_style as string) ?? (dna.playing_style as string) ?? (dna.estiloJuego as string) ?? "Perfil táctico calculado por IA").slice(0, 200),
      arquetipoTactico: ((dna.natural_role as string) ?? (dna.archetype as string) ?? (dna.arquetipoTactico as string) ?? "DNA Análisis").slice(0, 100),
      patrones:         [] as never[],
      mentalidad:       ((dna.pressure_behavior as string) ?? (dna.mentality as string) ?? (dna.mentalidad as string) ?? "Determinado y competitivo").slice(0, 200),
    },
    jugadorReferencia: {
      top5: [] as never[],
      bestMatch: {
        proPlayerId: "",
        nombre:   (bm.nombre as string) ?? "Jugador Referencia",
        posicion: (bm.posicion as string) ?? "",
        club:     (bm.club as string) ?? "",
        score:    (bm.score as number) ?? 60,
        narrativa:(bm.narrativa as string) ?? "",
      },
    },
    proyeccionCarrera: hasProjection ? {
      escenarioOptimista: {
        descripcion:   ((pj.optimistic as Record<string,unknown>)?.description as string) ?? (pj.escenarioOptimista as Record<string,unknown>)?.descripcion as string ?? "Progresión favorable",
        nivelProyecto: ((pj.optimistic as Record<string,unknown>)?.level as string) ?? "Semi-pro",
        clubTipo:      "",
      },
      escenarioRealista: {
        descripcion:   ((pj.realistic as Record<string,unknown>)?.description as string) ?? (pj.escenarioRealista as Record<string,unknown>)?.descripcion as string ?? "Desarrollo consistente",
        nivelProyecto: ((pj.realistic as Record<string,unknown>)?.level as string) ?? "Amateur alto",
        clubTipo:      "",
      },
      factoresClave: (pj.key_factors as string[]) ?? [],
      riesgos:       (pj.risks as string[]) ?? [],
    } : null,
    planDesarrollo: {
      objetivo6meses:  (dp.goal_6months as string) ?? (dp.objetivo6meses as string) ?? "Consolidar fundamentos técnicos",
      objetivo18meses: (dp.goal_18months as string) ?? (dp.objetivo18meses as string) ?? "Transición a nivel competitivo superior",
      pilaresTrabajo:  (dp.pillars as Array<{ pilar: string; acciones: string[]; prioridad: string }>) ?? [],
    },
    // confianza = confidence REAL del VSI compuesto, solo si > 0. Bloqueado ⇒ gated() ⇒
    // confidence:0 (sentinela). 0 renderizado como "0%" viola inv #2 → se mapea a null y
    // la UI oculta el badge. Antes `?? 50` → 0.5 fabricado (#40 clase).
    confianza: (row.vsi?.confidence as number) > 0 ? (row.vsi.confidence as number) : null,
    // Estadísticas de partido (Stats tab / MatchStatsPanel / heatmap). Hoy solo el
    // demo las provee; en real quedan undefined → la pestaña muestra su vacío honesto.
    metricasCuantitativas: row.metricasCuantitativas,
  };

  // vsi top-level: el Histórico lo mostraba como "—" porque leía report.vsi (que no
  // existe; el ajuste está anidado en estadoActual). Exponemos el valor real aquí.
  return { id: row.id, player_id: row.player_id, video_id: row.video_id, created_at: row.created_at, vsi: (row.vsi?.vsi as number) ?? null, report };
}

export function useSavedAnalysesV2(playerId: string) {
  return useQuery({
    // En demo el idioma forma parte de la clave → cambiar de idioma regenera el
    // informe de ejemplo en ese idioma. Fuera del demo el segmento es null (la
    // caché real no depende del idioma: los datos guardados ya vienen en su idioma).
    queryKey: ["analyses-v2", playerId, IS_DEMO ? normalizeLocale(i18n.language) : null],
    queryFn: async () => {
      if (!playerId) return [];
      // DEMO (piso piloto): no hay pipeline ni Supabase → devolvemos un análisis
      // de ejemplo PRE-HORNEADO por jugador (derivado de sus datos reales). La UI
      // lo muestra bajo el banner «Datos de ejemplo».
      if (IS_DEMO) {
        const player = PlayerService.getById(playerId);
        return player ? buildDemoAnalysisRows(player, normalizeLocale(i18n.language)).map(mapDbRowToLegacy) : [];
      }
      if (!SUPABASE_CONFIGURED) return [];
      const { data, error } = await supabase
        .from("analyses")
        .select("id, player_id, video_id, created_at, vsi, reports(report_type, content)")
        .eq("player_id", playerId)
        .in("status", ["completed", "completed_partial"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []).map((row) => mapDbRowToLegacy(row as AnalysisDbRow));
    },
    enabled: !!playerId && (IS_DEMO || SUPABASE_CONFIGURED),
    staleTime: 60_000,
  });
}
