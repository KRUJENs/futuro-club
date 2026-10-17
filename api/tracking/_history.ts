/**
 * VITAS · Tracking History
 * GET /api/tracking/history?playerId=xxx&limit=10
 *
 * Returns the last N tracking sessions for a player from Supabase.
 * Provides summary data (no full positions/events) for timeline charts.
 *
 * SEGURIDAD: withHandler({ requireAuth, allowServiceToken }) + ownsPlayer.
 * Consulta Supabase con SERVICE_ROLE (salta RLS) → el check de propiedad por
 * players.user_id es obligatorio aquí (mismo patrón que el resto de la API).
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default withHandler(
  { method: "GET", requireAuth: true, allowServiceToken: true, maxRequests: 60 },
  async ({ userId, isServiceCall, query }) => {
    const playerId = query.playerId;
    const limit = Math.min(Number(query.limit ?? 10), 50);

    if (!playerId) {
      return errorResponse({ code: "missing_player_id", message: "playerId required", status: 400 });
    }

    if (!isServiceCall && !(await ownsPlayer(playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from("tracking_sessions")
      .select("id, created_at, duration_ms, metrics, scan_events")
      .eq("player_id", playerId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return errorResponse({ code: "db_error", message: error.message, status: 500 });
    }

    const sessions = (data ?? []).map((row) => {
      const metrics = (row.metrics ?? {}) as Record<string, unknown>;
      const scans = Array.isArray(row.scan_events) ? row.scan_events : [];
      // Sin duelCount (P1 bloque 6): duel_events antiguos no tienen criterio validado.

      return {
        id: row.id,
        date: row.created_at,
        durationSec: Math.round((row.duration_ms ?? 0) / 1000),
        maxSpeedMs: Number(metrics.maxSpeedMs ?? 0),
        avgSpeedMs: Number(metrics.avgSpeedMs ?? 0),
        sprintCount: Number(metrics.sprintCount ?? 0),
        scanCount: scans.length,
        eventCount: 0, // events not stored in tracking_sessions yet
        source: "supabase" as const,
      };
    });

    return successResponse(sessions);
  },
);
