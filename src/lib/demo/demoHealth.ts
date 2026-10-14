/**
 * VITAS · Salud y Valoración de ejemplo del DEMO (piso piloto)
 *
 * En el demo no hay backend (los agentes injury-risk / valuation viven en /api,
 * interceptado por demoApiGuard → null). Aquí se PRE-HORNEAN ejemplos derivados
 * de la ficha del jugador para que las pestañas Salud y Valoración no queden
 * vacías. Son datos de EJEMPLO: coldStartWarning:true + confianza baja + el
 * GlobalDemoBanner ya declaran que no son datos reales. Nunca se presentan como
 * medidos. Prosa localizada es/en (cae a es en otros idiomas).
 */

import type { Player } from "@/services/real/playerService";
import { normalizeLocale, pickLocale, type ReportLocale } from "@/lib/shared/locale";
import i18n from "@/i18n";
import type { ValuationData } from "@/components/valuation/ValuationCard";
import type { InjuryRiskReport } from "@/lib/injury/injuryRiskTypes";
import { mock } from "@/lib/metrics/MetricResult";

const clamp = (n: number) => Math.max(2, Math.min(96, Math.round(n)));

export function buildDemoValuation(
  player: Player,
  locale: ReportLocale = normalizeLocale(i18n.language),
): ValuationData {
  const vsi = typeof player.vsi === "number" ? player.vsi : 60;
  const score = Math.round(vsi);
  const tier = vsi >= 80 ? "Élite" : vsi >= 70 ? "Pro" : vsi >= 55 ? "Talento" : "Desarrollo";
  const tierColor = vsi >= 80 ? "#0059B3" : vsi >= 70 ? "#A855F7" : vsi >= 55 ? "#F59E0B" : "#EF4444";
  return {
    playerId: player.id,
    overallScore: score,
    tier,
    tierColor,
    tierDescription: pickLocale(locale, {
      es: "Valoración de ejemplo derivada de la ficha; sin datos de mercado reales.",
      en: "Example valuation derived from the profile; no real market data.",
    }),
    factors: [
      { factor: pickLocale(locale, { es: "VSI ajustado por PHV", en: "PHV-adjusted VSI" }), weight: 0.4, score, label: tier },
      { factor: pickLocale(locale, { es: "Proyección de maduración", en: "Maturation projection" }), weight: 0.35, score: clamp(vsi + 6), label: pickLocale(locale, { es: "Al alza", en: "Upward" }) },
      { factor: pickLocale(locale, { es: "Consistencia (sesiones)", en: "Consistency (sessions)" }), weight: 0.25, score: 40, label: pickLocale(locale, { es: "Insuficiente en la demo", en: "Insufficient in demo" }) },
    ],
    probabilities: {
      prob1Year: clamp(vsi - 25),
      prob3Year: clamp(vsi - 12),
      prob5Year: clamp(vsi - 4),
      probFirstDiv: clamp(vsi - 30),
      probTop5League: clamp(vsi - 46),
    },
    coldStartWarning: true,
    confidenceLevel: 0.4,
    dataPointsUsed: 1,
    analysisCount: 1,
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
    composite: ex(32),
    category: "moderate",
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
