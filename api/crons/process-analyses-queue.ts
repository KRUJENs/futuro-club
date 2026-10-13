/**
 * VITAS · Cron Worker · Process Analyses Queue (v2 · Gemini)
 * Vercel Cron: GET /api/crons/process-analyses-queue
 *
 * DECISIÓN Gemini vs Modal (Sprint 0.9): el ANÁLISIS de vídeo de este worker usa
 * Gemini video-observation (más barato/rápido para observación estructurada, sin
 * GPU). Modal (MODAL_TRACK_URL) queda reservado para el TRACKING de jugadores/balón
 * del heatmap táctico y set-pieces (api/coaching/_track-players.ts,
 * api/tactical/_compute-from-video.ts) — no lo usa este worker.
 *
 * Gemini analiza el video completo y devuelve observaciones estructuradas.
 * Luego dispara pipeline-orchestrator para los 6 reportes Claude.
 *
 * Flujo:
 *   1. SELECT analyses WHERE status='queued' LIMIT 2
 *   2. UPDATE status='processing'
 *   2a. Leer el GUID de Bunny de la fila `videos` y exigir que sea un GUID (B4)
 *   2b. Gate de consentimiento con ESE GUID, en nombre del dueño del jugador del análisis
 *       (declaración guardada + propiedad + consentimiento parental de un menor de 14
 *       conocido · api/_lib/analysisConsentGate) → si falta, failed con motivo
 *   3. Construir URL de video desde Bunny CDN (GUID comprobado, escapado)
 *   4. POST a /api/agents/video-observation (Gemini · hasta 120s)
 *   5. Convertir GeminiObservation → biomechanics format
 *   6. Persistir en analyses table
 *   7. POST a /api/agents/pipeline-orchestrator → 6 reportes Claude
 */

import { errorResponse, successResponse } from "../_lib/apiResponse";
import { timingSafeEqual } from "../_lib/edgeCrypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildGeminiPlayerContext,
  geminiToBiomechanics,
  type GeminiObservation,
} from "../_lib/geminiBiomechanics";
import { gateClipAnalysis } from "../_lib/analysisConsentGate";
import { isBunnyGuid } from "../_lib/bunnyGuid";
import { clipResolutionReason } from "../../src/lib/shared/videoConsent";

// Node.js runtime. maxDuration 300 (no 120): este worker encadena DOS pasos largos
// por análisis — gemini-analyze (hasta ~120s) + pipeline-orchestrator (6 informes
// Opus, ~60s). En 120s el segundo paso se guillotinaba a mitad → el análisis quedaba
// colgado en 'processing_reports' hasta que el reaper lo mataba a la hora (una espera
// de ~4 min se volvía fallo + reintento). 300s da holgura para ambos. Vercel clampa al
// tope del plan si es menor, así que nunca es peor que hoy.
export const config = { runtime: "nodejs", maxDuration: 300 };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;

const SLACK_WEBHOOK = process.env.SLACK_RETENTION_WEBHOOK ?? "";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? process.env.CRON_SECRET ?? "";

// Batch reducido: Gemini tarda ~30-60s por video, max 2 en paralelo dentro del timeout
const BATCH_SIZE = 2;

async function notifySlack(message: string) {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch {
    /* silent */
  }
}

interface QueuedAnalysis {
  id: string;
  player_id: string;
  video_id: string;
  tenant_id: string;
  retry_count?: number;
}

// ─── Gemini Observation → Biomechanics adapter ────────────────────────────
// Única implementación en api/_lib/geminiBiomechanics.ts (invariante #7). Antes
// había aquí una copia que rellenaba huecos con `?? 5` / `?? 0` y edad 12.

// ─── Dispatch to Gemini via dedicated endpoint (Sprint 7) ────────────────

/**
 * `abstained` = gemini-analyze cerró el análisis sin atribuir nada al jugador
 * (no identificado / jugador inexistente) → NO se disparan informes ni el inline.
 */
export async function dispatchToGeminiEndpoint(
  analysis: QueuedAnalysis,
  /** GUID de Bunny que comprobó el gate (B4): gemini-analyze no lee píxeles de otro. */
  bunnyVideoId?: string,
): Promise<{ success: boolean; abstained?: boolean; error?: string }> {
  try {
    const res = await fetch(`${PUBLIC_URL}/api/pipeline/gemini-analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        videoId: analysis.video_id,
        playerId: analysis.player_id,
        analysisId: analysis.id,
        ...(bunnyVideoId ? { bunnyVideoId } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { success: false, error: `gemini-analyze ${res.status}: ${errText.slice(0, 200)}` };
    }
    const json = (await res.json().catch(() => null)) as { data?: { abstained?: unknown } } | null;
    return { success: true, abstained: json?.data?.abstained === true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

// ─── Dispatch to Gemini (inline fallback) ────────────────────────────────

async function dispatchToGemini(
  analysis: QueuedAnalysis,
  videoUrl: string,
): Promise<{
  success: boolean;
  observation?: GeminiObservation;
  referenceProvided?: boolean;
  contextGateReasons?: Record<string, string>;
  error?: string;
}> {
  try {
    // Load player context for Gemini prompt
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });
    const { data: player } = await supabase
      .from("players")
      .select("name, position, foot, tenant_id")
      .eq("id", analysis.player_id)
      .single();

    // Sin jugador no hay a quién atribuir el vídeo (antes: «Jugador» genérico).
    if (!player) {
      return { success: false, error: "player_not_found" };
    }

    const { data: anthro } = await supabase
      .from("player_latest_anthropometrics")
      .select("chronological_age, height_cm, weight_kg")
      .eq("player_id", analysis.player_id)
      .maybeSingle();

    // Huecos → null + gate_reason (nunca edad 12 / "MID" / "derecho" por defecto).
    const { playerContext, gate_reasons, referenceProvided } = buildGeminiPlayerContext(player, anthro);

    const res = await fetch(`${PUBLIC_URL}/api/agents/video-observation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ videoUrl, playerContext }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { success: false, error: `Gemini agent returned ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json() as { success?: boolean; data?: { observations?: GeminiObservation } };
    const observation = data?.data?.observations;
    if (!observation) {
      return { success: false, error: "Gemini returned no observations" };
    }

    return { success: true, observation, referenceProvided, contextGateReasons: gate_reasons };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

/**
 * Persiste el resultado del Gemini INLINE (fallback). Misma regla que
 * gemini-analyze: si el jugador no se pudo identificar, el análisis se cierra como
 * `failed` con el motivo y NO se atribuye nada ni se disparan informes.
 */
export async function persistInlineGeminiResult(
  supabase: SupabaseClient,
  analysisId: string,
  observation: GeminiObservation,
  opts: { referenceProvided: boolean; contextGateReasons?: Record<string, string> },
): Promise<{ abstained: boolean; reason: string | null }> {
  const { biomechanics, identity } = geminiToBiomechanics(observation, opts);
  if (!identity.attributable) {
    await supabase
      .from("analyses")
      .update({ status: "failed", status_message: identity.reason, biomechanics })
      .eq("id", analysisId);
    return { abstained: true, reason: identity.reason };
  }
  await supabase
    .from("analyses")
    .update({ status: "processing_reports", biomechanics })
    .eq("id", analysisId);
  return { abstained: false, reason: identity.reason };
}

// ─── Trigger pipeline orchestrator ──────────────────────────────────────

async function triggerOrchestrator(analysisId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${PUBLIC_URL}/api/agents/pipeline-orchestrator`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ analysisId }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { success: false, error: `orchestrator ${res.status}: ${errText.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

// ─── Main queue processor ───────────────────────────────────────────────

/**
 * Idioma del análisis (mig 064) para el motivo de un bloqueo. Best-effort: si la columna
 * no existe o falla la lectura → null (el motivo sale en español, idioma por defecto).
 */
async function analysisLocale(supabase: SupabaseClient, analysisId: string): Promise<string | null> {
  try {
    const { data } = await supabase.from("analyses").select("locale").eq("id", analysisId).maybeSingle();
    const loc = (data as { locale?: unknown } | null)?.locale;
    return typeof loc === "string" ? loc : null;
  } catch {
    return null;
  }
}

/**
 * Reaper de análisis colgados: marca 'failed' los que llevan en 'processing' /
 * 'processing_reports' más de `staleHours` (el worker murió a mitad — edge timeout,
 * crash, Gemini colgado). Filtra por started_at para no pisar uno que se complete en
 * la carrera. Antes solo se rescataban tracking_jobs, NO los `analyses` (#56).
 */
export async function reapStuckAnalyses(supabase: SupabaseClient, staleHours: number): Promise<number> {
  const staleBefore = new Date(Date.now() - staleHours * 3600_000).toISOString();
  const { data: reaped } = await supabase
    .from("analyses")
    .update({ status: "failed", status_message: `Rescatado: colgado en procesamiento más de ${staleHours}h` })
    .in("status", ["processing", "processing_reports"])
    // started_at < staleBefore, PERO también las filas con started_at NULL (algún claim
    // no lo setea): `.lt` excluye NULLs en Postgres → sin el fallback a created_at, una
    // fila colgada sin started_at NO se rescataba nunca. Se usa created_at como respaldo.
    .or(`started_at.lt.${staleBefore},and(started_at.is.null,created_at.lt.${staleBefore})`)
    .select("id");
  return reaped?.length ?? 0;
}

async function processQueue() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── 0. Reaper de análisis colgados en 'processing' (ver reapStuckAnalyses) ──
  const reapedCount = await reapStuckAnalyses(supabase, Number(process.env.STALE_ANALYSIS_HOURS ?? 1));
  if (reapedCount > 0) {
    console.warn(`[queue] reaper: ${reapedCount} análisis colgados → failed`);
    await notifySlack(`♻️ VITAS reaper: ${reapedCount} análisis colgados en 'processing' → failed`);
  }

  // ── 1. Claim queued analyses ──
  let queuedAnalyses: QueuedAnalysis[] = [];

  const { data: rpcResult, error: rpcError } = await supabase
    .rpc("claim_queued_analyses", { batch_size: BATCH_SIZE });

  if (!rpcError && rpcResult && rpcResult.length > 0) {
    queuedAnalyses = rpcResult as QueuedAnalysis[];
  } else {
    if (rpcError) console.warn("[queue] RPC not available, using fallback:", rpcError.message);
    const { data: fallbackData, error: queryError } = await supabase
      .from("analyses")
      .select("id, player_id, video_id, tenant_id")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (queryError) {
      return { processed: 0, error: queryError.message };
    }
    queuedAnalyses = (fallbackData ?? []) as QueuedAnalysis[];
  }

  if (queuedAnalyses.length === 0) {
    return { processed: 0, reaped: reapedCount, message: "no queued analyses" };
  }

  const usedRpc = !rpcError;
  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const analysis of queuedAnalyses) {
    // Lock row if using fallback
    if (!usedRpc) {
      const { error: lockError } = await supabase
        .from("analyses")
        .update({ status: "processing", started_at: new Date().toISOString() })
        .eq("id", analysis.id)
        .eq("status", "queued");

      if (lockError) {
        results.push({ id: analysis.id, status: "skip", error: lockError.message });
        continue;
      }
    }

    const locale = await analysisLocale(supabase, analysis.id);

    // ── 1b. GUID de Bunny del vídeo (B4, review del PR #308) ──
    // Es el id que va TAL CUAL en la URL que descarga Gemini y lo puede reescribir el dueño
    // de la fila (RLS 038). Se lee ANTES del gate para que el gate compruebe EXACTAMENTE
    // ese GUID, y tiene que ser un GUID: con otra forma (`a/../<GUID ajeno>`) `fetch`
    // resolvería los puntos y se analizaría otro vídeo.
    const { data: video } = await supabase
      .from("videos")
      .select("bunny_video_id")
      .eq("id", analysis.video_id)
      .single();

    if (!video?.bunny_video_id) {
      await supabase
        .from("analyses")
        .update({ status: "failed", status_message: "video not found" })
        .eq("id", analysis.id);
      results.push({ id: analysis.id, status: "failed", error: "no_video" });
      continue;
    }
    const bunnyGuid = String(video.bunny_video_id);
    if (!isBunnyGuid(bunnyGuid)) {
      await supabase
        .from("analyses")
        .update({ status: "failed", status_message: clipResolutionReason(locale, "invalid_video_reference") })
        .eq("id", analysis.id);
      results.push({ id: analysis.id, status: "failed", error: "invalid_video_reference" });
      continue;
    }

    // ── 1c. Consentimiento (defensa en profundidad) ANTES de cualquier despacho ──
    // enqueueAnalysis ya lo exige, pero aquí llegan también filas encoladas ANTES de este
    // gate y filas que no pasaron por él (p. ej. escritas desde el navegador bajo RLS).
    // Solo cuenta una declaración GUARDADA con el vídeo; consentimiento parental de un
    // menor de 14 conocido: el jugador del análisis Y el `player_id` de cada fila `videos`
    // de ese vídeo de Bunny (B1). B5: el motivo se escribe en analyses.status_message, que
    // lee quien gestiona el jugador del análisis → el cron actúa en nombre del DUEÑO de ese
    // jugador (actAsPlayerOwner): las filas del vídeo y sus jugadores tienen que ser suyos
    // ANTES de leer ninguna fecha de nacimiento; si no, un motivo genérico (403 forbidden).
    // Bloqueado → failed con el motivo; ni Gemini ni informes.
    const consent = await gateClipAnalysis({
      videoId: analysis.video_id,
      bunnyGuid,
      requireVideoRow: true,
      storedOnly: true,
      playerId: analysis.player_id,
      actor: { userId: null, tenantId: analysis.tenant_id ?? null },
      endpoint: "crons/process-analyses-queue",
      scope: "player",
      locale,
      ownsVideo: null,
      ownsPlayer: null,
      actAsPlayerOwner: true,
    });
    if (!consent.allowed) {
      await supabase
        .from("analyses")
        .update({ status: "failed", status_message: consent.gate_reason })
        .eq("id", analysis.id);
      results.push({ id: analysis.id, status: "consent_blocked", error: consent.code });
      continue;
    }

    // ── 2. URL del vídeo en Bunny (el GUID comprobado, escapado) ──
    const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID ?? "";
    const cdnHost = process.env.BUNNY_CDN_HOSTNAME ?? "";
    const guidInUrl = encodeURIComponent(bunnyGuid);
    const videoUrl = cdnHost
      ? `https://${cdnHost}/${guidInUrl}/play_720p.mp4`
      : `https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos/${guidInUrl}/play.mp4`;

    // ── 3. Dispatch to Gemini via dedicated endpoint (Sprint 7 refactor) ──
    console.log(`[queue] Dispatching ${analysis.id} to gemini-analyze...`);
    const geminiRes = await dispatchToGeminiEndpoint(analysis, bunnyGuid);

    // Abstención (jugador no identificado / inexistente): gemini-analyze ya cerró el
    // análisis con su motivo. NO se reintenta inline ni se generan informes bajo el
    // nombre del menor (identidad.md).
    if (geminiRes.success && geminiRes.abstained) {
      results.push({ id: analysis.id, status: "abstained" });
      continue;
    }

    if (!geminiRes.success) {
      // Fallback: try inline Gemini if endpoint fails
      console.log(`[queue] gemini-analyze endpoint failed, trying inline...`);
      const gemini = await dispatchToGemini(analysis, videoUrl);

      if (!gemini.success || !gemini.observation) {
        await supabase
          .from("analyses")
          .update({
            status: "failed",
            status_message: `Gemini failed: ${gemini.error}`,
          })
          .eq("id", analysis.id);
        results.push({ id: analysis.id, status: "gemini_failed", error: gemini.error });
        await notifySlack(`⚠️ VITAS Gemini falló: ${analysis.id} · ${gemini.error}`);
        continue;
      }

      // Persist inline Gemini results (misma regla de identidad que gemini-analyze)
      const inline = await persistInlineGeminiResult(supabase, analysis.id, gemini.observation, {
        referenceProvided: gemini.referenceProvided ?? false,
        contextGateReasons: gemini.contextGateReasons,
      });
      if (inline.abstained) {
        results.push({ id: analysis.id, status: "abstained", error: inline.reason ?? undefined });
        continue;
      }
    }

    // ── 5. Trigger pipeline orchestrator → 6 Claude reports ──
    const orch = await triggerOrchestrator(analysis.id);
    if (orch.success) {
      results.push({ id: analysis.id, status: "completed" });
    } else {
      // Gemini worked but orchestrator failed — data is saved, can be re-triggered
      results.push({ id: analysis.id, status: "reports_failed", error: orch.error });
      await notifySlack(`⚠️ VITAS orchestrator falló (Gemini OK): ${analysis.id} · ${orch.error}`);
    }
  }

  return {
    processed: results.length,
    reaped: reapedCount,
    completed: results.filter((r) => r.status === "completed").length,
    abstained: results.filter((r) => r.status === "abstained").length,
    failed: results.filter((r) => r.status !== "completed" && r.status !== "abstained").length,
    details: results,
  };
}

export default async function handler(req: Request) {
  // Verificar que viene de Vercel Cron. Fail-closed: sin CRON_SECRET el cron
  // queda deshabilitado (503) en vez de aceptar "Bearer undefined"; comparación
  // en tiempo constante contra el secreto.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return errorResponse({ code: "cron_disabled", message: "CRON_SECRET not configured", status: 503 });
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return errorResponse({
      code: "unauthorized",
      message: "Invalid cron auth",
      status: 401,
    });
  }

  try {
    const result = await processQueue();
    return successResponse({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    await notifySlack(
      `🚨 VITAS cron process-analyses-queue FAILED: ${err instanceof Error ? err.message : "unknown"}`
    );
    return errorResponse({
      code: "queue_processor_failed",
      message: err instanceof Error ? err.message : "unknown",
      status: 500,
    });
  }
}
