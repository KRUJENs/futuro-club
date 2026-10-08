/**
 * VITAS · Gemini Analyze Endpoint (Sprint 7 — Pipeline Automático)
 * POST /api/pipeline/gemini-analyze
 *
 * Dedicated endpoint for the Gemini video analysis step.
 * Decouples Gemini processing from the cron job for:
 *   - Cleaner separation of concerns
 *   - Independent retry on Gemini failures
 *   - Future support for manual re-analysis
 *
 * Body: { videoId: string, playerId: string, analysisId: string }
 *
 * Flow:
 *   1. Look up video URL from Bunny CDN
 *   2. Load player context (position, age, foot)
 *   3. Call video-observation agent (Gemini)
 *   4. Convert GeminiObservation → biomechanics format (api/_lib/geminiBiomechanics.ts)
 *   5. Persist to analyses table
 *   6. Return success with biomechanics
 *
 * Honestidad (CLAUDE.md inv. 1-2 + identidad.md): el contexto del jugador NO se
 * rellena con valores por defecto (antes edad 12 / "MID" / "derecho") y la
 * observación NO se atribuye al jugador si Gemini no pudo identificarlo por dorsal
 * y equipación. En ese caso el análisis se cierra como `failed` con el motivo
 * (`abstained: true`) y NO se generan informes bajo el nombre del menor.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { GEMINI_MODEL } from "../../src/lib/shared/geminiModel";
import { isBunnyGuid } from "../_lib/bunnyGuid";
import {
  buildGeminiPlayerContext,
  geminiToBiomechanics,
  type GeminiObservation,
} from "../_lib/geminiBiomechanics";

// maxDuration 300 (no 120): para un vídeo largo (~4 min) la observación Gemini puede
// acercarse a su propio tope de 120s; con solo 120s aquí, este endpoint moría antes de
// persistir → el análisis se reintentaba entero. 300s deja margen. Vercel lo clampa al
// tope del plan si es menor (nunca peor que hoy).
export const config = { runtime: "nodejs", maxDuration: 300 };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? process.env.CRON_SECRET ?? "";

const geminiAnalyzeSchema = z.object({
  videoId: z.string(),
  playerId: z.string(),
  analysisId: z.string().uuid(),
  /**
   * GUID de Bunny que comprobó el gate del cron (B4, review del PR #308). Si la fila
   * `videos` ya apunta a OTRO GUID (el dueño de la fila lo reescribió entre el gate y este
   * paso), no se analiza (409). Opcional: el único llamador (el cron) siempre lo manda.
   */
  bunnyVideoId: z.string().optional(),
});

export default withHandler(
  // serviceOnly: paso INTERNO del pipeline (lee PII de menores, dispara Gemini de
  // pago, escribe biomechanics). Solo cron/orchestrator server-to-server con
  // INTERNAL_TOKEN; nunca un caller anónimo (era abuso de coste + overwrite ajeno).
  { schema: geminiAnalyzeSchema, serviceOnly: true, maxRequests: 20 },
  async ({ body }) => {
    const { videoId, playerId, analysisId, bunnyVideoId } = body as z.infer<typeof geminiAnalyzeSchema>;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Get video URL ──
    const { data: video } = await supabase
      .from("videos")
      .select("bunny_video_id")
      .eq("id", videoId)
      .single();

    if (!video?.bunny_video_id) {
      return errorResponse({ code: "video_not_found", message: "Video not in DB", status: 404 });
    }

    // B4: el GUID va TAL CUAL en la URL que descarga Gemini → tiene que ser un GUID, y el
    // MISMO que comprobó el gate del cron (si no, la fila cambió después del gate).
    const bunnyGuid = String(video.bunny_video_id);
    if (!isBunnyGuid(bunnyGuid)) {
      return errorResponse({ code: "invalid_video_reference", message: "bunny_video_id is not a Bunny GUID", status: 422 });
    }
    if (bunnyVideoId !== undefined && bunnyVideoId !== bunnyGuid) {
      return errorResponse({ code: "video_changed", message: "The video row changed after the consent gate", status: 409 });
    }

    const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID ?? "";
    const cdnHost = process.env.BUNNY_CDN_HOSTNAME ?? "";
    const guidInUrl = encodeURIComponent(bunnyGuid);
    const videoUrl = cdnHost
      ? `https://${cdnHost}/${guidInUrl}/play_720p.mp4`
      : `https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos/${guidInUrl}/play.mp4`;

    // ── 2. Load player context ──
    const { data: player } = await supabase
      .from("players")
      .select("name, position, foot")
      .eq("id", playerId)
      .single();

    // Sin jugador no hay a quién atribuir el vídeo: se cierra el análisis con el
    // motivo (abstención), en vez de analizarlo como un «Jugador» genérico de 12 años.
    if (!player) {
      const gate_reason = "Jugador no encontrado: no se puede atribuir el vídeo a ningún jugador.";
      await supabase
        .from("analyses")
        .update({ status: "failed", status_message: gate_reason })
        .eq("id", analysisId);
      return successResponse({ analysisId, abstained: true, gate_reason });
    }

    const { data: anthro } = await supabase
      .from("player_latest_anthropometrics")
      .select("chronological_age, height_cm, weight_kg")
      .eq("player_id", playerId)
      .maybeSingle();

    // Huecos → null + gate_reason (nunca edad 12 / "MID" / "derecho" por defecto).
    // El pipeline aún no recibe dorsal/color de equipación → referenceProvided=false.
    const {
      playerContext,
      gate_reasons: contextGateReasons,
      referenceProvided,
    } = buildGeminiPlayerContext(player, anthro);

    // ── 3. Call Gemini video-observation agent ──
    const startMs = Date.now();
    const geminiRes = await fetch(`${PUBLIC_URL}/api/agents/video-observation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ videoUrl, playerContext }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      return errorResponse({
        code: "gemini_failed",
        message: `Gemini returned ${geminiRes.status}: ${errText.slice(0, 200)}`,
        status: 502,
      });
    }

    const geminiData = await geminiRes.json() as {
      success?: boolean;
      data?: { observations?: GeminiObservation };
    };
    const observation = geminiData?.data?.observations;

    if (!observation) {
      return errorResponse({
        code: "gemini_no_observations",
        message: "Gemini returned no observations",
        status: 502,
      });
    }

    const geminiLatencyMs = Date.now() - startMs;

    // ── 4. Convert to biomechanics format ──
    const { biomechanics, identity } = geminiToBiomechanics(observation, {
      referenceProvided,
      contextGateReasons,
    });

    // Identidad (identidad.md): jugador no identificado ⇒ nada se atribuye al menor.
    // Se cierra el análisis con el motivo; el cron NO dispara los informes.
    if (!identity.attributable) {
      await supabase
        .from("analyses")
        .update({ status: "failed", status_message: identity.reason, biomechanics })
        .eq("id", analysisId);
      return successResponse({
        analysisId,
        abstained: true,
        gate_reason: identity.reason,
        identity,
        geminiLatencyMs,
        source: GEMINI_MODEL,
      });
    }

    // ── 5. Persist to analyses table ──
    const { error: updateError } = await supabase
      .from("analyses")
      .update({
        status: "processing_reports",
        biomechanics,
      })
      .eq("id", analysisId);

    if (updateError) {
      return errorResponse({
        code: "db_update_failed",
        message: updateError.message,
        status: 500,
      });
    }

    return successResponse({
      analysisId,
      abstained: false,
      identity,
      biomechanics,
      geminiLatencyMs,
      source: GEMINI_MODEL,
    });
  },
);
