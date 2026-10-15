/**
 * VITAS · Valuation Model (Sprint 12)
 * POST /api/agents/valuation-model
 *
 * Deterministic model — NO LLM calls. Cost: $0.
 *
 * Puntuación compuesta ORIENTATIVA de seis factores (pesos y cortes en
 * config/valuation.ts, todos «pendiente de validar»):
 *   - Tendencia de la evaluación (VSI) — nivel y variación entre evaluaciones
 *   - Techo por maduración — según el TIMING de la puerta única (no aplica en adultos)
 *   - Versatilidad — encaje multi-posición del perfil de rol
 *   - Riesgo de lesión (inverso) — compuesto real del calculador
 *   - Contexto — nivel competitivo (escala del modelo) y edad
 *   - Consistencia — entre sesiones
 *
 * P1 bloque 4b: techo PHV y riesgo de lesión se abstienen (antes 50 y 60 por defecto).
 * P1 bloque 5d: NINGÚN factor lleva valor por defecto (antes tendencia 40 sin VSI,
 * versatilidad 40 sin perfiles, contexto con nivel «academy» fijo, consistencia 40/50);
 * el techo se lee del TIMING (antes del offset, un ESTADO, como «tardío»); en adultos el
 * techo no aplica y sale del peso; y se RETIRAN todas las probabilidades (llegar a 1.ª
 * división / liga top-5 con «tasas base de la UEFA Youth League» que no se encontraron,
 * y «mejora a 1/3/5 años» con fórmulas sin fuente). Mientras falte un factor que aplica
 * no hay puntuación ni tramo (gate_reason).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse } from "../_lib/apiResponse";
import { weightedComposite } from "../../src/lib/metrics/composite";
import { PHV_WINDOW_MAX_AGE } from "../../config/injuryRisk";
import {
  VALUATION_WEIGHTS,
  VALUATION_TIERS,
  PHV_CEILING_BY_TIMING,
  CONTEXT_BASE,
  CONTEXT_LEVEL_BONUS,
  CONTEXT_AGE_BONUS,
  VSI_TREND_MAX_ADJUST,
  VERSATILITY,
  CONSISTENCY,
  COLD_START_ANALYSES,
} from "../../config/valuation";

export const config = { runtime: "edge" };

const valuationSchema = z.object({
  playerId: z.string(),
  // Sin tope (todas las categorías) y nullable: antes un null daba 400.
  age: z.number().nonnegative().nullable().optional(),
  position: z.string().optional(),

  // VSI data
  currentVsi: z.number().min(0).max(100).nullable().optional(),
  vsiHistory: z.array(z.object({
    date: z.string(),
    vsi: z.number(),
  })).optional().default([]),

  // Maduración: TIMING de la puerta única (gatedMaturity().timing). El offset y la
  // categoría se aceptan por compatibilidad pero ya no puntúan (eran un ESTADO).
  maturityTiming: z.enum(["early", "on_time", "late"]).nullable().optional(),
  phvOffset: z.number().nullable().optional(),
  phvCategory: z.string().nullable().optional(),

  // Injury risk (from injury-risk-calculator)
  injuryRisk: z.number().min(0).max(100).nullable().optional(),
  injuryCategory: z.string().nullable().optional(),

  // Role profile
  positionFitScores: z.array(z.object({
    position: z.string(),
    fit: z.number(),
  })).optional().default([]),

  // Session aggregation
  sessionCount: z.number().optional().default(0),
  consistencyScore: z.number().min(0).max(100).nullable().optional(),
  speedTrend: z.number().nullable().optional(),
  sprintTrend: z.number().nullable().optional(),

  // Nivel competitivo en la escala del modelo: SIN valor por defecto (antes «academy»).
  competitiveLevel: z.enum(["recreational", "academy", "elite_academy", "national"]).nullable().optional(),
  // Nº real de análisis; sin él no se afirma ni se niega el «arranque en frío».
  analysisCount: z.number().int().nonnegative().nullable().optional(),
});

type FactorKey = keyof typeof VALUATION_WEIGHTS;

interface FactorView {
  factor: FactorKey;
  weight: number;
  score: number | null;
  label: string;
  applicable: boolean;
  gate_reason: string | null;
}

const LABEL: Record<FactorKey, string> = {
  vsiTrend: "Tendencia de la evaluación",
  phvCeiling: "Techo por maduración",
  versatility: "Versatilidad",
  injuryAdjusted: "Riesgo de lesión (inverso)",
  context: "Contexto",
  consistency: "Consistencia",
};

// ── Factores: cada uno con su dato o su motivo (nunca un valor por defecto) ───

export function vsiTrendScore(
  currentVsi: number | null,
  history: Array<{ date: string; vsi: number }>,
): { score: number | null; gate: string | null } {
  if (currentVsi == null) return { score: null, gate: "Sin evaluación actual (no se usa un 40 por defecto)." };
  let score = currentVsi;
  if (history.length >= 2) {
    const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
    const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const secondHalf = sorted.slice(Math.floor(sorted.length / 2));
    const avgFirst = firstHalf.reduce((s, h) => s + h.vsi, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, h) => s + h.vsi, 0) / secondHalf.length;
    const trend = (avgSecond - avgFirst) / (avgFirst || 1);
    score += Math.max(-VSI_TREND_MAX_ADJUST, Math.min(VSI_TREND_MAX_ADJUST, trend * 100));
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), gate: null };
}

export function phvCeilingScore(
  timing: "early" | "on_time" | "late" | null,
): { score: number | null; gate: string | null } {
  if (timing == null) {
    return { score: null, gate: "Techo por maduración no calculado: falta la maduración (con todas sus medidas) o su comparación con los pares." };
  }
  return { score: PHV_CEILING_BY_TIMING[timing], gate: null };
}

export function versatilityScore(
  positionFits: Array<{ position: string; fit: number }>,
): { score: number | null; gate: string | null } {
  if (positionFits.length === 0) return { score: null, gate: "Sin perfil de rol con encaje por posición (no se usa un 40 por defecto)." };
  const viable = positionFits.filter((p) => p.fit >= VERSATILITY.viableFit);
  const topFit = Math.max(...positionFits.map((p) => p.fit));
  let score = Math.min(100, topFit);
  score += Math.min(VERSATILITY.maxBonus, Math.max(0, viable.length - 1) * VERSATILITY.perExtra);
  return { score: Math.max(0, Math.min(100, Math.round(score))), gate: null };
}

function injuryAdjustmentScore(injuryRisk: number | null): { score: number | null; gate: string | null } {
  if (injuryRisk == null) return { score: null, gate: "Riesgo de lesión no calculado (no se usa un 60 por defecto)." };
  return { score: Math.max(0, Math.min(100, Math.round(100 - injuryRisk))), gate: null };
}

export function contextScore(
  age: number | null,
  competitiveLevel: keyof typeof CONTEXT_LEVEL_BONUS | null,
): { score: number | null; gate: string | null } {
  if (competitiveLevel == null) {
    return { score: null, gate: "Sin nivel competitivo en la escala de la valoración (no se usa «academy» por defecto)." };
  }
  if (age == null) return { score: null, gate: "Sin edad del jugador." };
  let score = CONTEXT_BASE + CONTEXT_LEVEL_BONUS[competitiveLevel];
  const ageBonus = CONTEXT_AGE_BONUS.find((b) => age <= b.maxAge);
  if (ageBonus) score += ageBonus.bonus;
  return { score: Math.max(0, Math.min(100, score)), gate: null };
}

export function sessionConsistencyScore(
  consistencyScore: number | null,
  sessionCount: number,
  speedTrend: number | null,
): { score: number | null; gate: string | null } {
  if (sessionCount < CONSISTENCY.minSessions) {
    return { score: null, gate: `Menos de ${CONSISTENCY.minSessions} sesiones registradas (no se usa un 40 por defecto).` };
  }
  if (consistencyScore == null) return { score: null, gate: "Sin consistencia calculada entre sesiones (no se usa un 50 por defecto)." };
  let score = consistencyScore;
  if (speedTrend != null && speedTrend > 0) {
    score += Math.min(CONSISTENCY.maxSpeedBonus, speedTrend * CONSISTENCY.speedTrendFactor);
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), gate: null };
}

/** Informe completo (puro): lo usan el handler y los tests. */
export function computeValuation(input: z.infer<typeof valuationSchema>) {
  const age = input.age ?? null;
  // Adulto: la ventana de maduración no aplica ⇒ el techo sale del peso (no cuenta como ausente).
  const phvApplies = !(typeof age === "number" && age > PHV_WINDOW_MAX_AGE);

  const raw: Record<FactorKey, { score: number | null; gate: string | null }> = {
    vsiTrend: vsiTrendScore(input.currentVsi ?? null, input.vsiHistory),
    phvCeiling: phvApplies
      ? phvCeilingScore(input.maturityTiming ?? null)
      : { score: null, gate: "No aplica: jugador adulto (la maduración no limita el techo)." },
    versatility: versatilityScore(input.positionFitScores),
    injuryAdjusted: injuryAdjustmentScore(input.injuryRisk ?? null),
    context: contextScore(age, input.competitiveLevel ?? null),
    consistency: sessionConsistencyScore(input.consistencyScore ?? null, input.sessionCount, input.speedTrend ?? null),
  };

  const factors: FactorView[] = (Object.keys(VALUATION_WEIGHTS) as FactorKey[]).map((k) => ({
    factor: k,
    weight: VALUATION_WEIGHTS[k],
    score: raw[k].score,
    label: LABEL[k],
    applicable: k === "phvCeiling" ? phvApplies : true,
    gate_reason: raw[k].gate,
  }));
  const contribution = (f: FactorView) => (f.score === null || !f.applicable ? -1 : f.score * f.weight);
  factors.sort((a, b) => contribution(b) - contribution(a));

  // Todos los factores que aplican son imprescindibles (cobertura 100 %): con uno
  // ausente no hay puntuación ni tramo. Los que no aplican salen del peso.
  const comp = weightedComposite(
    factors.map((f) => ({ key: f.factor, weight: f.weight, applicable: f.applicable, value: f.score })),
    { minCoverage: 1, label: (k) => LABEL[k] },
  );
  const tier = comp.value === null
    ? null
    : VALUATION_TIERS.find((t) => (comp.value as number) >= t.minScore) ?? VALUATION_TIERS[VALUATION_TIERS.length - 1];

  const analysisCount = input.analysisCount ?? null;
  return {
    playerId: input.playerId,
    overallScore: comp.value,
    // Procedencia de la puntuación (función determinista sobre sus factores); la UI la
    // rotula con ProvenanceBadge. Sin puntuación, no hay procedencia que rotular.
    provenance: comp.value === null ? null : ("DERIVADA" as const),
    tier: tier ? tier.name : null,
    tierColor: tier ? tier.color : null,
    tierDescription: tier ? tier.description : null,
    factors,
    // Retiradas (P1 bloque 5d): no hay fuente para ninguna probabilidad.
    probabilities: null,
    gate_reason: comp.value === null ? `Valoración no calculada. ${comp.gate_reason}` : null,
    // Sin el nº real de análisis no se afirma ni se niega el arranque en frío.
    coldStartWarning: analysisCount === null ? null : analysisCount < COLD_START_ANALYSES,
    analysisCount,
  };
}

// ── Main handler ────────────────────────────────────────────────────────────

export default withHandler(
  { schema: valuationSchema, requireAuth: true, maxRequests: 200, allowServiceToken: true, requiredPlan: "pro,club" },
  async ({ body }) => {
    const input = body as z.infer<typeof valuationSchema>;
    return successResponse({
      report: computeValuation(input),
      // P1 bloque 5d: sin valores por defecto, techo por timing, sin probabilidades.
      promptVersion: "v1.2.0-deterministic",
    });
  },
);
