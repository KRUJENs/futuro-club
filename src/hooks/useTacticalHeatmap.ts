/**
 * VITAS · Tactical Heatmap Hooks
 *
 * Queries:
 *   useTacticalMatch(matchId)        → TacticalMatchSummary fully hydrated
 *   useTacticalMatchList()           → matches con heatmap (selector)
 *
 * Mutations:
 *   useComputeTacticalHeatmap()      → POST /compute-heatmap
 *   useGenerateTacticalInsights()    → POST /generate-insights
 *   useDeleteTacticalMatch()         → local-only cascade
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/apiAuth";
import { TacticalHeatmapService } from "@/services/real/tacticalHeatmapService";
import { PlayerService } from "@/services/real/playerService";
import i18n from "@/i18n";
import { normalizeLocale, type ReportLocale } from "@/lib/shared/locale";
import { aggregatePhvDistribution } from "@/lib/shared/phv";
import { isDemoMatchId } from "@/lib/tactical/tacticalTypes";
import type {
  TacticalInsights,
  TacticalMatchSummary,
} from "@/lib/tactical/tacticalTypes";

const STALE_MATCH = 1000 * 60 * 5;          // 5 min
const STALE_LIST = 1000 * 60 * 2;           // 2 min

const apiBase = "/api/tactical";

export const tacticalKeys = {
  all: ["tactical"] as const,
  match: (matchId: string) => [...tacticalKeys.all, "match", matchId] as const,
  list: () => [...tacticalKeys.all, "list"] as const,
};

// ── Queries ────────────────────────────────────────────────────────
export function useTacticalMatch(matchId: string | undefined) {
  return useQuery<TacticalMatchSummary | null>({
    queryKey: tacticalKeys.match(matchId ?? "none"),
    queryFn: () =>
      matchId ? TacticalHeatmapService.getMatchSummary(matchId) : Promise.resolve(null),
    enabled: Boolean(matchId),
    staleTime: STALE_MATCH,
  });
}

export function useTacticalMatchList() {
  return useQuery({
    queryKey: tacticalKeys.list(),
    queryFn: () => TacticalHeatmapService.listMatchesWithHeatmap(),
    staleTime: STALE_LIST,
  });
}

// ── Mutations ──────────────────────────────────────────────────────
interface ComputeInput {
  matchId: string;
  videoId?: string;
  samples: Array<{
    timestampMs: number;
    ball: { x: number; y: number };
    players: Array<{ id: string; x: number; y: number; team: "ours" | "theirs" }>;
    isSetPiece?: boolean;
  }>;
}

interface ComputeResult {
  matchId: string;
  phasesDetected: number;
  heatmapsComputed: number;
  playerCount: number;
}

export function useComputeTacticalHeatmap() {
  const qc = useQueryClient();
  return useMutation<ComputeResult, Error, ComputeInput>({
    mutationFn: async (input) => {
      const res = await fetch(`${apiBase}/compute-heatmap`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`compute-heatmap ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as { data: ComputeResult };
      return payload.data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: tacticalKeys.match(data.matchId) });
      qc.invalidateQueries({ queryKey: tacticalKeys.list() });
    },
  });
}

interface GenerateInsightsInput {
  matchId: string;
  team?: {
    id?: string;
    formation?: string;
    averageAge?: number;
    style?: "possession" | "direct" | "counter" | "pressing";
  };
  matchInfo?: {
    matchDate?: string;
    durationMin?: number;
    score?: { ours: number; theirs: number };
  };
  /** FASE 5 · idioma del reporte (default: idioma activo de la app) */
  locale?: ReportLocale;
  /** FASE 5 · distribución PHV del equipo (diferenciador VITAS) */
  phvDistribution?: { prePhv?: number; circaPhv?: number; postPhv?: number };
}

export function useGenerateTacticalInsights() {
  const qc = useQueryClient();
  return useMutation<TacticalInsights, Error, GenerateInsightsInput>({
    mutationFn: async (input) => {
      // Los match demo (seed local) no tienen fila en `analyses` → el endpoint
      // devolvería 403 (ownsMatch: sin analysis no hay dueño). Sus insights ya vienen
      // sintetizados por el seeder, así que los servimos desde cache sin llamar a
      // la API (ni disparar gasto LLM). Mantiene vivo el botón "Regenerar" en demo.
      if (isDemoMatchId(input.matchId)) {
        const summary = await TacticalHeatmapService.getMatchSummary(input.matchId);
        if (summary?.insights) return summary.insights;
        throw new Error(i18n.t("errors.demoInsightsReady"));
      }
      const res = await fetch(`${apiBase}/generate-insights`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({
          ...input,
          locale: input.locale ?? normalizeLocale(i18n.language),
          // FASE 5 activación · distribución PHV real del roster (diferenciador VITAS)
          phvDistribution: input.phvDistribution ?? aggregatePhvDistribution(PlayerService.getAll()),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`generate-insights ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as { data: { insights: TacticalInsights } };
      // Persist also via service for offline cache
      await TacticalHeatmapService.saveInsights(input.matchId, payload.data.insights);
      return payload.data.insights;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: tacticalKeys.match(vars.matchId) });
    },
  });
}

export function useDeleteTacticalMatch() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (matchId) => TacticalHeatmapService.deleteMatch(matchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tacticalKeys.all });
    },
  });
}

interface ComputeFromVideoInput {
  matchId: string;
  videoUrl: string;
  videoId?: string;
  frameWidth?: number;
  frameHeight?: number;
}

export function useComputeFromVideo() {
  const qc = useQueryClient();
  return useMutation<
    {
      matchId: string;
      phasesDetected: number;
      heatmapsComputed: number;
      playerCount: number;
    },
    Error,
    ComputeFromVideoInput
  >({
    mutationFn: async (input) => {
      const res = await fetch(`${apiBase}/compute-from-video`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`compute-from-video ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as {
        data: {
          matchId: string;
          phasesDetected: number;
          heatmapsComputed: number;
          playerCount: number;
        };
      };
      return payload.data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: tacticalKeys.match(data.matchId) });
      qc.invalidateQueries({ queryKey: tacticalKeys.list() });
    },
  });
}
