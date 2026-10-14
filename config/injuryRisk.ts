/**
 * VITAS · Configuración del modelo de RIESGO DE LESIÓN (P1 bloque 4b)
 *
 * Fuente única de las constantes de `api/agents/_injury-risk-calculator.ts`
 * (contrato de `.claude/rules/metricas.md`: las constantes de una ruta de cálculo
 * viven en config/ con su procedencia). Es un módulo TS y no un JSON porque el
 * calculador corre en Edge y ninguna función Edge del repo importa JSON todavía.
 *
 * PROCEDENCIA: NINGÚN peso ni corte de este fichero tiene una fuente que lo
 * respalde. La cabecera antigua los atribuía a «Hulin 2014, Gabbett 2016, Murray
 * 2017»; esos trabajos estudian el ACWR, no proponen esta ponderación. Por eso
 * todos son «pendiente de validar» y el compuesto sale con confianza reducida
 * (ORIENTATIVE_CONFIDENCE × cobertura). No se inventa una cita.
 */

export const INJURY_RISK_SOURCE = "pendiente de validar";

export type InjuryRiskFactorKey =
  | "acwr"
  | "phvWindow"
  | "asymmetry"
  | "biomechanics"
  | "injuryHistory"
  | "fatigue";

/** Pesos del compuesto (suman 1). La asimetría y la biomecánica, antes un factor
 *  mezclado 60/40 con 20 %, son ahora dos factores (12 % + 8 %), cada uno con su
 *  propio dato ausente. */
export const INJURY_RISK_WEIGHTS: Record<InjuryRiskFactorKey, number> = {
  acwr: 0.3,
  phvWindow: 0.25,
  asymmetry: 0.12,
  biomechanics: 0.08,
  injuryHistory: 0.15,
  fatigue: 0.1,
};

/** Mínimo para componer: estos factores son OBLIGATORIOS (si aplican) y los
 *  presentes deben sumar al menos esta fracción del peso aplicable. */
export const INJURY_RISK_MANDATORY: readonly InjuryRiskFactorKey[] = ["acwr", "phvWindow"];
export const INJURY_RISK_MIN_COVERAGE = 0.7;

/** Puntuación de riesgo por zona ACWR (la zona la decide acwrService con los
 *  umbrales de la banda de maduración; aquí no se reclasifica el ratio). */
export const ACWR_ZONE_RISK = {
  danger: 95,
  caution: 65,
  optimal: 15,
  undertrained: 45,
} as const;

/** Asimetría bilateral (%) → riesgo: ×5 (20 % de asimetría = 100). */
export const ASYMMETRY_RISK_PER_PCT = 5;

/** Biomecánica: solo cuenta con al menos estos fotogramas con pose. Es el mismo
 *  mínimo del motor de biomecánica (por debajo devuelve todo a 0). */
export const BIOMECH_MIN_FRAMES = 5;

/** Historial de lesiones → riesgo (0-100). */
export const INJURY_HISTORY_SCORING = {
  /** Días desde la última lesión → puntos (el primer tramo que se cumple). */
  recency: [
    { maxDays: 30, points: 40 },
    { maxDays: 90, points: 25 },
    { maxDays: 180, points: 15 },
  ],
  recencyOlderPoints: 5,
  /** Lesiones en los últimos 12 meses (12 × 30 días, como antes): puntos por lesión y tope. */
  recentWindowDays: 360,
  pointsPerRecentInjury: 10,
  maxRecentPoints: 30,
  severeBonus: 20,
  /** Moderada con más de N días de baja. */
  moderateDaysOut: 14,
  moderateBonus: 10,
} as const;

/** Cortes de categoría del compuesto (riesgo ≥ corte). */
export const INJURY_RISK_CATEGORY_CUTS = {
  critical: 75,
  high: 50,
  moderate: 30,
} as const;

/** Por encima de esta edad decimal la ventana PHV no aplica (adulto): el factor
 *  se EXCLUYE del peso (no cuenta como ausente). */
export const PHV_WINDOW_MAX_AGE = 18;
