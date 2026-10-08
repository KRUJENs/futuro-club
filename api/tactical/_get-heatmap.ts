/**
 * VITAS · GET /api/tactical/get-heatmap?matchId=...
 *
 * Devuelve TacticalMatchSummary completo: phases + heatmaps (jugador + team)
 * + insights si existen.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsMatch } from "../_lib/ownership";
import type {
  GamePhase,
  PhaseHeatmap,
  PhaseSegment,
  TacticalInsights,
  TacticalMatchSummary,
} from "../../src/lib/tactical/tacticalTypes";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

interface DbPhase {
  id: string;
  match_id: string;
  video_id: string | null;
  phase_type: GamePhase;
  start_ms: number;
  end_ms: number;
  ball_possession: "ours" | "theirs" | "neutral";
  source: "auto" | "manual" | "hybrid";
  confidence: number;
  created_at: string;
}

interface DbHeatmap {
  id: string;
  match_id: string;
  player_id: string | null;
  phase_type: GamePhase;
  bins: PhaseHeatmap["bins"];
  hot_zones: PhaseHeatmap["hotZones"];
  total_time_sec: number;
  algo_version: string;
  computed_at: string;
}

interface DbInsight {
  match_id: string;
  team_id: string | null;
  headline: string | null;
  summary: string | null;
  by_phase: TacticalInsights["byPhase"];
  strengths: string[];
  weaknesses: string[];
  coaching_tips: string[];
  model_version: string;
}

export default withHandler(
  // Cierra el acceso anónimo (IDOR de lectura). El front lee Supabase directo
  // (RLS), así que este endpoint no lo usa la UI — pero estaba expuesto sin auth.
  { method: "GET", requireAuth: true, maxRequests: 60 },
  async ({ query, userId, isServiceCall }) => {
  const matchId = query.matchId;
  if (!matchId) return errorResponse("matchId required", 400);

  // Autorización a nivel de objeto: el service_role SALTA la RLS, así que la
  // propiedad se comprueba aquí en código. Mismo predicado que las políticas
  // tácticas de la 076: el match es una analysis creada por el usuario o de un
  // jugador suyo. Nunca por tenant.
  if (!isServiceCall && !(await ownsMatch(matchId, userId))) {
    return errorResponse("No autorizado para este partido", 403, "FORBIDDEN");
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return successResponse({ summary: null, source: "no_supabase" });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    const [phasesRes, heatmapsRes, insightsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/tactical_phases?match_id=eq.${matchId}&select=*&order=start_ms`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/phase_heatmaps?match_id=eq.${matchId}&select=*`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/tactical_insights?match_id=eq.${matchId}&select=*&limit=1`,
        { headers },
      ),
    ]);

    const phaseRows = (await phasesRes.json()) as DbPhase[];
    const heatmapRows = (await heatmapsRes.json()) as DbHeatmap[];
    const insightRows = (await insightsRes.json()) as DbInsight[];

    const phases: PhaseSegment[] = phaseRows.map((r) => ({
      id: r.id,
      matchId: r.match_id,
      videoId: r.video_id ?? undefined,
      phaseType: r.phase_type,
      startMs: r.start_ms,
      endMs: r.end_ms,
      ballPossession: r.ball_possession,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
    }));

    const heatmaps: PhaseHeatmap[] = heatmapRows.map((r) => ({
      id: r.id,
      matchId: r.match_id,
      playerId: r.player_id,
      phaseType: r.phase_type,
      bins: r.bins ?? [],
      hotZones: r.hot_zones ?? [],
      totalTimeSec: r.total_time_sec,
      algoVersion: r.algo_version,
      computedAt: r.computed_at,
    }));

    const insights: TacticalInsights | undefined = insightRows[0]
      ? {
          headline: insightRows[0].headline ?? "",
          summary: insightRows[0].summary ?? "",
          byPhase: insightRows[0].by_phase ?? [],
          strengths: insightRows[0].strengths ?? [],
          weaknesses: insightRows[0].weaknesses ?? [],
          coachingTips: insightRows[0].coaching_tips ?? [],
          modelVersion: insightRows[0].model_version ?? "v1.0.0",
        }
      : undefined;

    if (phases.length === 0 && heatmaps.length === 0) {
      return successResponse({ summary: null, message: "No data for this match" });
    }

    const phaseDurations = {
      build_up: 0,
      attacking: 0,
      defending: 0,
      defensive_transition: 0,
      offensive_transition: 0,
      set_piece: 0,
    } satisfies Record<GamePhase, number>;
    let totalMs = 0;
    let oursMs = 0;
    for (const p of phases) {
      phaseDurations[p.phaseType] += (p.endMs - p.startMs) / 1000;
      totalMs += p.endMs - p.startMs;
      if (p.ballPossession === "ours") oursMs += p.endMs - p.startMs;
    }
    const possessionPct = totalMs > 0 ? Math.round((oursMs / totalMs) * 100) : 0;

    const summary: TacticalMatchSummary = {
      matchId,
      phaseDurations,
      possessionPct,
      playerHeatmaps: heatmaps.filter((h) => h.playerId !== null),
      teamHeatmaps: heatmaps.filter((h) => h.playerId === null),
      insights,
    };

    return successResponse({ summary });
  } catch (err) {
    console.error("[get-heatmap] error:", err);
    return errorResponse("Internal error fetching heatmap", 500);
  }
  },
);
