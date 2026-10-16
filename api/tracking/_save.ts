/**
 * VITAS · POST /api/tracking/save
 * Persiste una sesión de tracking YOLO en Supabase.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { stripDuelOutcomes } from "../../src/lib/tracking/duels";

export const config = { runtime: "edge" };

const TrackingSaveSchema = z.object({
  playerId: z.string().optional(),
  videoId: z.string().optional(),
  targetTrackId: z.number().int().nullable().optional(),
  durationMs: z.number().int().min(0).default(0),
  metrics: z.record(z.unknown()).default({}),
  scanEvents: z.array(z.unknown()).default([]),
  // Se ACEPTA (clientes antiguos en caché) pero se IGNORA: sin criterio validado de duelo
  // (P1 bloque 6, src/lib/tracking/duels.ts). Se guarda siempre [].
  duelEvents: z.array(z.unknown()).default([]),
  calibrationPreset: z.string().default("full_corners"),
});

export default withHandler(
  { method: "POST", schema: TrackingSaveSchema, requireAuth: true, allowServiceToken: true, maxRequests: 60 },
  async ({ body, userId, isServiceCall }) => {
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse("Supabase no configurado", 503, "CONFIG_MISSING");
    }

    // Si se asigna a un jugador, debe pertenecer al usuario (si no, el historial
    // de _history se contamina con sesiones ajenas filtradas solo por player_id).
    if (body.playerId && !isServiceCall && !(await ownsPlayer(body.playerId, userId))) {
      return errorResponse("No autorizado para este jugador", 403, "FORBIDDEN");
    }

    const row = {
      user_id:           userId,
      player_id:         body.playerId,
      video_id:          body.videoId,
      target_track_id:   body.targetTrackId ?? null,
      duration_ms:       body.durationMs    ?? 0,
      metrics:           stripDuelOutcomes(body.metrics ?? {}),
      scan_events:       body.scanEvents    ?? [],
      duel_events:       [],
      calibration_preset: body.calibrationPreset ?? "full_corners",
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/tracking_sessions`, {
      method: "POST",
      headers: {
        "apikey":        supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "error");
      return errorResponse(`Supabase error: ${err}`, 500);
    }

    const data = await res.json();
    return successResponse({ id: data?.[0]?.id ?? null });
  },
);
