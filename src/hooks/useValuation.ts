/**
 * useValuation — Hook for player valuation model data
 *
 * Fetches from:
 * - /api/agents/valuation-model — deterministic valuation score
 * - ValuationAggregator — multi-video trend analysis
 * - Pipeline reports table — valuation-report (narrative)
 *
 * Sprint 12: Valuation Model
 */

import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/apiAuth";
import { gatedMaturity } from "@/lib/phv/phvGate";
import { ValuationAggregator } from "@/services/real/valuationAggregator";
import type { ValuationData } from "@/components/valuation/ValuationCard";
import { IS_DEMO } from "@/lib/demoMode";
import { PlayerService } from "@/services/real/playerService";
import { buildDemoValuation } from "@/lib/demo/demoHealth";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// ── Calculate valuation (deterministic) ─────────────────────────────────────

async function calculateValuation(playerId: string): Promise<ValuationData | null> {
  // Demo: el agente de valoración vive en /api (interceptado → null). Servimos
  // una valoración de EJEMPLO con valores FIJOS (MOCK), no derivada de la ficha.
  if (IS_DEMO) {
    const player = PlayerService.getById(playerId);
    return player ? buildDemoValuation(player) : null;
  }
  const aggregation = await ValuationAggregator.aggregate(playerId, 90);
  // Maduración: TIMING de la puerta única (P1 bloque 5d). Antes se mandaban el offset y
  // la «banda» del informe de fatiga, y el modelo leía el offset (estado) como timing.
  const player = PlayerService.getById(playerId);
  const timing = player ? gatedMaturity(player).timing : "unknown";

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/api/agents/valuation-model`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        // Sin evaluación, riesgo ni perfil de rol aquí: el modelo los deja sin calcular
        // (con su motivo) en vez de rellenarlos.
        currentVsi: null,
        vsiHistory: [],
        maturityTiming: timing === "unknown" ? null : timing,
        injuryRisk: null,
        positionFitScores: [],
        sessionCount: aggregation.snapshotCount,
        consistencyScore: aggregation.consistencyScore,
        speedTrend: null,
        // Sin nº real de análisis ni nivel en la escala del modelo: no se mandan (antes
        // `analysisCount` = nº de instantáneas de seguimiento y nivel «academy» fijo).
      }),
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (json.success && json.data?.report) {
      return json.data.report as ValuationData;
    }
  } catch {
    // Calculator failed
  }
  return null;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useValuation(playerId: string | null | undefined) {
  const valuationQuery = useQuery({
    queryKey: ["valuation", playerId],
    queryFn: () => calculateValuation(playerId!),
    enabled: !!playerId,
    staleTime: 15 * 60 * 1000, // 15 min cache
  });

  const aggregationQuery = useQuery({
    queryKey: ["valuation-aggregation", playerId],
    queryFn: () => ValuationAggregator.aggregate(playerId!, 90),
    enabled: !!playerId,
    staleTime: 15 * 60 * 1000,
  });

  return {
    valuationData: valuationQuery.data ?? null,
    valuationLoading: valuationQuery.isLoading,
    aggregation: aggregationQuery.data ?? null,
    aggregationLoading: aggregationQuery.isLoading,
  };
}
