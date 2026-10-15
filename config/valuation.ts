/**
 * VITAS · Valoración predictiva — constantes del modelo determinista (P1 bloque 5d)
 *
 * PROCEDENCIA: NINGUNA de estas constantes tiene una fuente validada → «pendiente de
 * validar» (no se inventa una cita). Antes la cabecera del modelo decía «tasas base
 * calibradas con datos de la UEFA Youth League» (2 % llega a 1.ª división, 0,3 % a una
 * liga top-5): no se encontró esa fuente y las PROBABILIDADES se retiraron (decisión
 * aceptada por el dueño, 15 oct 2026). Lo que queda es una puntuación compuesta de
 * factores con pesos y cortes elegidos a mano: se calcula solo con TODOS sus factores
 * reales y se presenta como orientativa.
 *
 * Solo imports relativos: lo importan las Edge Functions de api/.
 */

export const VALUATION_SOURCE = "pendiente de validar";

/** Pesos de los factores (suman 1). Sin fuente. */
export const VALUATION_WEIGHTS = {
  vsiTrend: 0.25,
  phvCeiling: 0.20,
  versatility: 0.15,
  injuryAdjusted: 0.15,
  context: 0.10,
  consistency: 0.15,
} as const;

/** Tramos de la puntuación (de mayor a menor). Sin fuente; sin probabilidades asociadas. */
export const VALUATION_TIERS: ReadonlyArray<{ name: string; minScore: number; color: string; description: string }> = [
  { name: "Elite Prospect",    minScore: 78, color: "#FFD700", description: "Puntuación compuesta alta con los datos disponibles (orientativa, pendiente de validar)." },
  { name: "High Potential",    minScore: 60, color: "#22C55E", description: "Puntuación compuesta media-alta con los datos disponibles (orientativa, pendiente de validar)." },
  { name: "Developing Talent", minScore: 40, color: "#3B82F6", description: "Puntuación compuesta media con los datos disponibles (orientativa, pendiente de validar)." },
  { name: "Foundation",        minScore: 0,  color: "#8B5CF6", description: "Puntuación compuesta baja con los datos disponibles (orientativa, pendiente de validar)." },
];

/**
 * Techo por maduración según el TIMING de la puerta única (gatedMaturity().timing:
 * madurador precoz / a tiempo / tardío respecto a sus pares). Antes se leía el OFFSET
 * (un ESTADO: −1,5 = le falta el estirón) como si fuera timing («tardío ⇒ más techo»).
 * Valores: los del modelo anterior por tramo (tardío 65, a tiempo 55, precoz 45). Sin fuente.
 */
export const PHV_CEILING_BY_TIMING = { late: 65, on_time: 55, early: 45 } as const;

/** Contexto: bonificación por nivel competitivo (escala propia del modelo) y por edad. Sin fuente. */
export const CONTEXT_BASE = 50;
export const CONTEXT_LEVEL_BONUS = { national: 25, elite_academy: 15, academy: 5, recreational: 0 } as const;
export const CONTEXT_AGE_BONUS = [
  { maxAge: 12, bonus: 10 },
  { maxAge: 14, bonus: 5 },
] as const;

/** Tendencia de la evaluación: ±15 puntos como máximo por la variación relativa. Sin fuente. */
export const VSI_TREND_MAX_ADJUST = 15;

/** Versatilidad: encaje ≥ 60 cuenta como posición viable; +7 por cada una extra, máx. +20. Sin fuente. */
export const VERSATILITY = { viableFit: 60, perExtra: 7, maxBonus: 20 } as const;

/** Consistencia: mínimo de sesiones y bonificación por tendencia de velocidad (máx. +15). Sin fuente. */
export const CONSISTENCY = { minSessions: 2, speedTrendFactor: 50, maxSpeedBonus: 15 } as const;

/** Por debajo de este número de análisis se avisa de «arranque en frío». */
export const COLD_START_ANALYSES = 3;
