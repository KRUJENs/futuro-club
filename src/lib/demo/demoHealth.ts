/**
 * VITAS · Salud y Valoración de ejemplo del DEMO (piso piloto)
 *
 * En el demo no hay backend (los agentes injury-risk / valuation viven en /api,
 * interceptado por demoApiGuard → null). Aquí se PRE-HORNEAN ejemplos con valores
 * FIJOS (no derivados de la ficha) para que las pestañas Salud y Valoración no queden
 * vacías. Son datos de EJEMPLO: procedencia MOCK («Datos de ejemplo») + el
 * GlobalDemoBanner declaran que no son datos reales. Nunca se presentan como
 * medidos. Prosa localizada es/en (cae a es en otros idiomas).
 */

import type { Player } from "@/services/real/playerService";
import { normalizeLocale, pickLocale, type ReportLocale } from "@/lib/shared/locale";
import i18n from "@/i18n";
import type { ValuationData } from "@/components/valuation/ValuationCard";
import type { InjuryRiskReport } from "@/lib/injury/injuryRiskTypes";
import { mock } from "@/lib/metrics/MetricResult";

/**
 * Valoración de EJEMPLO (P1 bloque 5d): valores FIJOS, iguales para todos los jugadores
 * del demo (la pestaña lleva el banner del demo). Antes se derivaba de la ficha con
 * `?? 60` sin evaluación, un factor «VSI ajustado por PHV», una «Proyección de
 * maduración» = VSI + 6 «al alza» y probabilidades de llegar a 1.ª división / top-5
 * (VSI − 30 / − 46): retiradas también en el modelo real (sin fuente).
 */
export function buildDemoValuation(
  player: Player,
  locale: ReportLocale = normalizeLocale(i18n.language),
): ValuationData {
  const L = (es: string, en: string) => pickLocale(locale, { es, en });
  return {
    playerId: player.id,
    overallScore: 58,
    tier: "Developing Talent",
    tierColor: "#3B82F6",
    tierDescription: L(
      "Valoración de EJEMPLO con valores fijos (demo): no deriva de los datos del jugador.",
      "EXAMPLE valuation with fixed values (demo): not derived from the player's data.",
    ),
    factors: [
      { factor: "vsiTrend", weight: 0.25, score: 60, label: L("Tendencia de la evaluación", "Evaluation trend") },
      { factor: "phvCeiling", weight: 0.2, score: 55, label: L("Techo por maduración", "Maturation ceiling") },
      { factor: "versatility", weight: 0.15, score: 60, label: L("Versatilidad", "Versatility") },
      { factor: "injuryAdjusted", weight: 0.15, score: 65, label: L("Riesgo de lesión (inverso)", "Injury risk (inverse)") },
      { factor: "context", weight: 0.1, score: 55, label: L("Contexto", "Context") },
      { factor: "consistency", weight: 0.15, score: 50, label: L("Consistencia", "Consistency") },
    ],
    // Sin nº de análisis no se afirma «menos de 3» (misma regla que el modelo real); la
    // puntuación se rotula «Datos de ejemplo» (MOCK) además del banner del demo.
    coldStartWarning: null,
    analysisCount: null,
    provenance: "MOCK",
  };
}

/**
 * Riesgo de lesión de EJEMPLO (P1 bloque 4b): valores FIJOS con procedencia MOCK
 * (la tarjeta los rotula «Datos de ejemplo» y la pestaña lleva el banner del demo).
 * Antes salía de un HASH del id del jugador (prohibido incluso con banner,
 * rules/metricas.md) y la ventana PHV se deducía de la EDAD (≤ 15), contra la regla
 * de no usar PHV sin todas las medidas. Sin «apto para volver a jugar».
 */
export function buildDemoInjuryRisk(
  player: Player,
  locale: ReportLocale = normalizeLocale(i18n.language),
): InjuryRiskReport {
  const ex = (v: number) => mock(v, { confidence: 0, source_ref: "demo:ejemplo-fijo" });
  const desc = pickLocale(locale, { es: "Dato de ejemplo (demo)", en: "Example data (demo)" });
  return {
    playerId: player.id,
    // = (15·.30 + 50·.25 + 20·.12 + 25·.08 + 5·.15 + 30·.10) = 25 → «low» (coherente con los factores).
    composite: ex(25),
    category: "low",
    coverage: 1,
    factors: [
      { factor: "acwr", weight: 0.3, applicable: true, result: ex(15), description: desc },
      { factor: "phvWindow", weight: 0.25, applicable: true, result: ex(50), description: desc },
      { factor: "asymmetry", weight: 0.12, applicable: true, result: ex(20), description: desc },
      { factor: "biomechanics", weight: 0.08, applicable: true, result: ex(25), description: desc },
      { factor: "injuryHistory", weight: 0.15, applicable: true, result: ex(5), description: desc },
      { factor: "fatigue", weight: 0.1, applicable: true, result: ex(30), description: desc },
    ],
    recommendations: [
      pickLocale(locale, { es: "Ejemplo: priorizar coordinación y técnica sobre fuerza máxima durante el estirón.", en: "Example: prioritise coordination and technique over max strength during the growth spurt." }),
      pickLocale(locale, { es: "Ejemplo: vigilar molestias en rodilla/talón (Osgood-Schlatter / Sever).", en: "Example: watch knee/heel discomfort (Osgood-Schlatter / Sever)." }),
    ],
    growthShieldLevel: null,
    daysSinceLastInjury: null,
    injuryHistoryCount: 0,
    coldStartWarning: true,
    isMock: true,
  };
}
