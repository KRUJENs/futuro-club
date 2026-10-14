/**
 * useInjuryRisk — Hook for injury risk data (calculator + history)
 *
 * Fetches from:
 * - /api/injuries/list — injury history
 * - /api/agents/injury-risk-calculator — deterministic risk score
 * - Pipeline reports table — injury-risk-report (narrative)
 *
 * Fallback: localStorage tracking snapshot for biomechanics/fatigue data.
 *
 * Sprint 10: Injury Risk Model & Data
 *
 * P1 bloque 4b: antes enviaba `age: null` (el esquema lo rechazaba: 400, la tarjeta
 * nunca se pintaba) y la maduración de un informe de fatiga guardado. Ahora:
 *   - PHV: el offset de la PUERTA del PHV del jugador (useRawPlayerById ya lo pasa
 *     por el gate); edad decimal solo para saber si la ventana PHV aplica;
 *   - carga/fatiga del snapshot SOLO si su maduración era conocida y son fiables
 *     (zona ACWR presente; índice no nulo);
 *   - biomecánica con sus fotogramas y su confianza (el servidor exige un mínimo).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/apiAuth";
import { PlayerTrackingService } from "@/services/real/playerTrackingService";
import type { InjuryEntry } from "@/components/injury/InjuryLogForm";
import type { InjuryRiskReport } from "@/lib/injury/injuryRiskTypes";
import { useRawPlayerById } from "@/hooks/usePlayers";
import { maturationKnown } from "@/lib/fatigue/phvFatigueAdjuster";
import { resolveChronologicalAge } from "@/lib/shared/age";
import { IS_DEMO } from "@/lib/demoMode";
import { PlayerService } from "@/services/real/playerService";
import { buildDemoInjuryRisk } from "@/lib/demo/demoHealth";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// Referencia ESTABLE para el caso "sin datos". Devolver `?? []` (literal nuevo en
// cada render) hacía que un consumidor con `useEffect(..., [injuries])` (p.ej.
// PlayerHubPage) hiciera setState en cada render → "Maximum update depth exceeded"
// mientras la query estaba pending/retry (API caído). Un array vacío compartido
// mantiene la identidad estable entre renders y corta el bucle.
const EMPTY_INJURIES: InjuryEntry[] = [];

// ── Fetch injury history ────────────────────────────────────────────────────

async function fetchInjuries(playerId: string): Promise<InjuryEntry[]> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(
      `${API_BASE}/api/injuries/list?playerId=${encodeURIComponent(playerId)}`,
      { headers },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      return json.data as InjuryEntry[];
    }
  } catch {
    // Fallback: return empty
  }
  return [];
}

// ── Save injury history ─────────────────────────────────────────────────────

async function saveInjuries(playerId: string, injuries: InjuryEntry[]): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/injuries/save`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, injuries }),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
}

// ── Calculate injury risk (deterministic) ───────────────────────────────────

/** Contexto del jugador que entra en el modelo: PHV de la puerta y edad. */
export interface InjuryRiskPlayerContext {
  phvOffset: number | null;
  age: number | null;
}

async function calculateInjuryRisk(
  playerId: string,
  injuries: InjuryEntry[],
  ctx: InjuryRiskPlayerContext,
): Promise<InjuryRiskReport | null> {
  // Demo: el calculador de riesgo vive en /api (interceptado → null). Servimos
  // un riesgo de EJEMPLO derivado de la ficha/edad (coldStartWarning:true).
  if (IS_DEMO) {
    const player = PlayerService.getById(playerId);
    return player ? buildDemoInjuryRisk(player) : null;
  }
  // Gather data from localStorage tracking snapshot
  const snapshot = PlayerTrackingService.get(playerId);
  const fatigue = snapshot?.fatigueReport;
  const biomech = snapshot?.biomechanicsScore;
  // Carga/fatiga solo de un informe con la maduración CONOCIDA (P1 bloque 4).
  const fatigueOk = !!fatigue && maturationKnown(fatigue.thresholds?.band, fatigue.thresholds?.phvOffset);

  // Get fatigue history for session count
  const fatigueHistory = await PlayerTrackingService.getFatigueHistory(playerId, 28);

  // Days since last injury
  let daysSinceLastInjury: number | null = null;
  if (injuries.length > 0) {
    const sorted = [...injuries].sort((a, b) => b.date.localeCompare(a.date));
    const lastDate = new Date(sorted[0].date);
    daysSinceLastInjury = Math.round((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/api/agents/injury-risk-calculator`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        age: ctx.age,
        phvOffset: ctx.phvOffset,
        acwrValue: fatigueOk ? fatigue?.acwr?.value ?? null : null,
        acwrZone: fatigueOk ? fatigue?.acwr?.zone ?? null : null,
        fatigueIndex: fatigueOk ? fatigue?.fatigueIndex?.value ?? null : null,
        biomechanicsInjuryRisk: biomech?.injuryRisk ?? null,
        asymmetryPct: biomech?.asymmetryPct ?? null,
        biomechanicsFrames: biomech?.framesAnalyzed ?? null,
        biomechanicsConfidence: biomech?.confidence ?? null,
        injuryHistory: injuries.map((inj) => ({
          type: inj.type,
          severity: inj.severity,
          daysOut: inj.daysOut,
          date: inj.date,
          bodyPart: inj.bodyPart,
        })),
        daysSinceLastInjury,
        sessionsLast28Days: fatigueHistory.length,
      }),
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (json.success && json.data?.report) {
      return json.data.report as InjuryRiskReport;
    }
  } catch {
    // Calculator failed — return null (fallback handled in UI)
  }
  return null;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useInjuryRisk(playerId: string | null | undefined) {
  const queryClient = useQueryClient();

  const injuriesQuery = useQuery({
    queryKey: ["injuries", playerId],
    queryFn: () => fetchInjuries(playerId!),
    enabled: !!playerId,
    staleTime: 5 * 60 * 1000,
  });

  // PHV de la puerta (el jugador «crudo» ya viene saneado por el gate) y edad.
  const rawPlayerQuery = useRawPlayerById(playerId ?? undefined);
  const raw = rawPlayerQuery.data as (Record<string, unknown> & { birthDate?: string | null; age?: number | null }) | null | undefined;
  const ctx: InjuryRiskPlayerContext = {
    phvOffset: typeof raw?.phvOffset === "number" && Number.isFinite(raw.phvOffset) ? raw.phvOffset : null,
    age: raw ? resolveChronologicalAge(raw) : null,
  };

  const riskQuery = useQuery({
    queryKey: ["injury-risk", playerId, ctx.phvOffset, ctx.age],
    queryFn: () => calculateInjuryRisk(playerId!, injuriesQuery.data ?? [], ctx),
    enabled: !!playerId && injuriesQuery.isSuccess && !rawPlayerQuery.isLoading,
    staleTime: 10 * 60 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: (injuries: InjuryEntry[]) => saveInjuries(playerId!, injuries),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["injuries", playerId] });
      queryClient.invalidateQueries({ queryKey: ["injury-risk", playerId] });
    },
  });

  return {
    injuries: injuriesQuery.data ?? EMPTY_INJURIES,
    injuriesLoading: injuriesQuery.isLoading,
    riskData: riskQuery.data ?? null,
    riskLoading: riskQuery.isLoading,
    saveInjuries: saveMutation.mutateAsync,
    saving: saveMutation.isPending,
  };
}
