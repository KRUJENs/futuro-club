/**
 * VITAS · POST /api/tactical/compute-heatmap
 *
 * Orquesta el cómputo del heatmap táctico de un partido:
 *
 *   1. Recibe tracking samples (player positions + ball + timestamps)
 *   2. Resuelve posesión por proximidad
 *   3. Detecta las 6 fases tácticas con phaseDetector
 *   4. Para cada (jugador × fase) → aggregateBins → findHotZones
 *   5. Combina heatmaps por fase para vista de equipo
 *   6. Persiste todo en tactical_phases + phase_heatmaps
 *
 * Idempotente: si ya hay heatmap para este matchId, lo reemplaza.
 *
 * Para mantener este endpoint ligero, NO llama al agente IA aquí —
 * el agente se llama por separado vía POST /api/tactical/generate-insights.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsMatch } from "../_lib/ownership";
import { detectPhases, resolvePossession } from "../../src/lib/tactical/phaseDetector";
import { aggregateBins, combineHeatmaps } from "../../src/lib/tactical/heatmapAggregator";
import { findHotZones } from "../../src/lib/tactical/clusterAnalyzer";
import type {
  GamePhase,
  HeatmapBin,
  PhaseHeatmap,
  PhaseSegment,
} from "../../src/lib/tactical/tacticalTypes";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const TrackingSampleSchema = z.object({
  timestampMs: z.number(),
  ball: z.object({ x: z.number(), y: z.number() }),
  players: z.array(
    z.object({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      team: z.enum(["ours", "theirs"]),
    }),
  ),
  isSetPiece: z.boolean().optional(),
});

const ComputeHeatmapSchema = z.object({
  matchId: z.string(),
  videoId: z.string().optional(),
  samples: z.array(TrackingSampleSchema).min(10),
  algoVersion: z.string().optional(),
});

const uuid = (): string => crypto.randomUUID();

const ALL_PHASES: GamePhase[] = [
  "build_up",
  "attacking",
  "defending",
  "defensive_transition",
  "offensive_transition",
  "set_piece",
];

export default withHandler(
  {
    method: "POST",
    schema: ComputeHeatmapSchema,
    // Cierra el acceso anónimo (IDOR): borra+inserta datos posicionales de
    // menores vía service role. allowServiceToken deja pasar la llamada interna
    // de compute-from-video (server-to-server con token de servicio).
    requireAuth: true,
    allowServiceToken: true,
    maxRequests: 10,
  },
  async ({ body, userId, isServiceCall }) => {
    const { matchId, videoId, samples, algoVersion = "v1.0.0" } =
      body as z.infer<typeof ComputeHeatmapSchema>;

    // Autorización a nivel de objeto (escritura): borra+inserta datos posicionales
    // de menores. El service_role SALTA la RLS, así que la propiedad (076: creador
    // o dueño del jugador de la analysis, nunca por tenant) se comprueba aquí. La
    // cadena interna (compute-from-video con token de servicio) omite el check vía
    // isServiceCall.
    if (!isServiceCall && !(await ownsMatch(matchId, userId))) {
      return errorResponse("No autorizado para este partido", 403, "FORBIDDEN");
    }

    // 1. Resolve possession + build phase samples
    const phaseSamples = samples.map((s) => ({
      timestampMs: s.timestampMs,
      ballX: s.ball.x,
      ballY: s.ball.y,
      possession: resolvePossession(s.ball, s.players),
      isSetPiece: s.isSetPiece,
    }));

    // 2. Detect phases
    const phases: PhaseSegment[] = detectPhases(phaseSamples, matchId).map((p) => ({
      ...p,
      videoId,
    }));

    // 3. For each (player × phase) → heatmap
    const playerIds = Array.from(new Set(
      samples.flatMap((s) => s.players.filter((p) => p.team === "ours").map((p) => p.id)),
    ));

    const heatmaps: PhaseHeatmap[] = [];

    for (const phase of ALL_PHASES) {
      const phaseSegments = phases.filter((p) => p.phaseType === phase);
      if (phaseSegments.length === 0) continue;

      // Per-player heatmap
      const perPlayerBins: HeatmapBin[][] = [];
      for (const playerId of playerIds) {
        // Get all positions of this player during these segments
        const positions: Array<{ timestampMs: number; x: number; y: number }> = [];
        for (const seg of phaseSegments) {
          for (const s of samples) {
            if (s.timestampMs < seg.startMs || s.timestampMs > seg.endMs) continue;
            const pl = s.players.find((p) => p.id === playerId);
            if (pl) positions.push({ timestampMs: s.timestampMs, x: pl.x, y: pl.y });
          }
        }
        if (positions.length < 3) continue;

        const { bins, totalTimeMs } = aggregateBins(positions);
        const hotZones = findHotZones(bins);

        const heatmap: PhaseHeatmap = {
          id: uuid(),
          matchId,
          playerId,
          phaseType: phase,
          bins,
          hotZones,
          totalTimeSec: totalTimeMs / 1000,
          algoVersion,
          computedAt: new Date().toISOString(),
        };
        heatmaps.push(heatmap);
        perPlayerBins.push(bins);
      }

      // Team aggregate heatmap (combination of all players in this phase)
      if (perPlayerBins.length > 0) {
        const teamBins = combineHeatmaps(perPlayerBins);
        const teamZones = findHotZones(teamBins);
        const phaseDurationSec =
          phaseSegments.reduce((acc, s) => acc + (s.endMs - s.startMs), 0) / 1000;
        heatmaps.push({
          id: uuid(),
          matchId,
          playerId: null,
          phaseType: phase,
          bins: teamBins,
          hotZones: teamZones,
          totalTimeSec: phaseDurationSec,
          algoVersion,
          computedAt: new Date().toISOString(),
        });
      }
    }

    // 4. Persist via Supabase service role (replace existing for idempotency)
    if (SUPABASE_URL && SUPABASE_KEY) {
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      };

      try {
        // Clear existing rows for this match
        await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/tactical_phases?match_id=eq.${matchId}`, {
            method: "DELETE",
            headers,
          }),
          fetch(`${SUPABASE_URL}/rest/v1/phase_heatmaps?match_id=eq.${matchId}`, {
            method: "DELETE",
            headers,
          }),
        ]);

        // Insert new
        if (phases.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/tactical_phases`, {
            method: "POST",
            headers,
            body: JSON.stringify(
              phases.map((p) => ({
                id: p.id,
                match_id: p.matchId,
                video_id: p.videoId ?? null,
                phase_type: p.phaseType,
                start_ms: p.startMs,
                end_ms: p.endMs,
                ball_possession: p.ballPossession,
                source: p.source,
                confidence: p.confidence,
              })),
            ),
          });
        }
        if (heatmaps.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/phase_heatmaps`, {
            method: "POST",
            headers,
            body: JSON.stringify(
              heatmaps.map((h) => ({
                id: h.id,
                match_id: h.matchId,
                player_id: h.playerId,
                phase_type: h.phaseType,
                bins: h.bins,
                hot_zones: h.hotZones,
                total_time_sec: h.totalTimeSec,
                algo_version: h.algoVersion,
              })),
            ),
          });
        }
      } catch (err) {
        console.warn("[compute-heatmap] Supabase persistence failed:", err);
        return errorResponse(
          "Heatmap computed but persistence failed; result returned for client cache",
          207,
        );
      }
    }

    return successResponse({
      matchId,
      phasesDetected: phases.length,
      heatmapsComputed: heatmaps.length,
      playerCount: playerIds.length,
      phases,
      heatmaps,
    });
  },
);
