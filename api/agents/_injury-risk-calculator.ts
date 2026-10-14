/**
 * VITAS · Injury Risk Calculator (Sprint 10 · rehecho en el P1 bloque 4b)
 * POST /api/agents/injury-risk-calculator
 *
 * Modelo determinista (sin LLM). Combina seis factores con pesos de
 * `config/injuryRisk.ts` (TODOS «pendiente de validar»):
 *   carga (zona ACWR) · ventana PHV · asimetría · biomecánica · historial · fatiga
 *
 * Antes (hasta el bloque 4b) cada factor ausente se rellenaba (ACWR 30, PHV por la
 * EDAD cronológica 60, asimetría 20, biomecánica 30, sin historial 5, fatiga 15): con
 * todo vacío salía 24 «bajo» + returnToPlayReady y la ficha decía «Apto para
 * actividad completa». Ahora:
 *   - cada factor ausente es null con su motivo (nunca un valor típico);
 *   - la ventana PHV sale SOLO del offset de la puerta del PHV (sin categoría ni
 *     edad) y con la definición del Escudo de Estirón (levelFromOffset);
 *   - la carga sale SOLO de la ZONA que decidió acwrService con los umbrales de la
 *     maduración del jugador: aquí no se reclasifica el ratio con cortes de adulto;
 *   - el compuesto exige carga y PHV (si aplica) y ≥ 70 % del peso aplicable, con
 *     confianza reducida (pesos sin fuente); si no, null con motivo;
 *   - no existe «apto para volver a jugar»: el alta de un menor es clínica.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse } from "../_lib/apiResponse";
import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "../../src/lib/metrics/MetricResult";
import { weightedComposite } from "../../src/lib/metrics/composite";
import { levelFromOffset } from "../../src/lib/phv/growthSpurtShield";
import { daysSince } from "../../src/lib/shared/time";
import type {
  InjuryRiskCategory,
  InjuryRiskFactorKey,
  InjuryRiskFactorView,
  InjuryRiskReport,
} from "../../src/lib/injury/injuryRiskTypes";
import {
  ACWR_ZONE_RISK,
  ASYMMETRY_RISK_PER_PCT,
  BIOMECH_MIN_FRAMES,
  INJURY_HISTORY_SCORING as H,
  INJURY_RISK_CATEGORY_CUTS,
  INJURY_RISK_MANDATORY,
  INJURY_RISK_MIN_COVERAGE,
  INJURY_RISK_SOURCE,
  INJURY_RISK_WEIGHTS,
  PHV_WINDOW_MAX_AGE,
} from "../../config/injuryRisk";
import { MIN_FATIGUE_SESSIONS } from "../_lib/metricsProvenance";

export const config = { runtime: "edge" };

export const INJURY_RISK_PROMPT_VERSION = "v2.0.0-deterministic";
const SOURCE_REF = `api/agents/_injury-risk-calculator.ts ${INJURY_RISK_PROMPT_VERSION} · pesos ${INJURY_RISK_SOURCE}`;

const injuryRiskSchema = z.object({
  playerId: z.string(),
  /** Edad (decimal si se conoce). Solo decide si la ventana PHV aplica (adultos no). Sin tope: VITAS evalúa todas las categorías. */
  age: z.number().finite().nonnegative().nullable().optional(),
  /** Offset PHV de la PUERTA del PHV (null si está cerrada). */
  phvOffset: z.number().finite().nullable().optional(),
  /** Aceptado por compatibilidad; ya no se usa (era la banda de fatiga, que no es una categoría PHV). */
  phvCategory: z.string().nullable().optional(),

  /** Ratio ACWR: solo descriptivo (la puntuación sale de la zona). */
  acwrValue: z.number().finite().nullable().optional(),
  /** Zona que decidió acwrService con ≥4 sesiones y la maduración registrada. */
  acwrZone: z.enum(["undertrained", "optimal", "caution", "danger"]).nullable().optional(),

  /** Índice de fatiga fiable (sesión ≥ 20 min con maduración registrada). */
  fatigueIndex: z.number().min(0).max(100).nullable().optional(),
  /** Aceptado por compatibilidad; ya no se usa (segundo mapeo del mismo índice). */
  fatigueSeverity: z.enum(["normal", "moderate", "high", "critical"]).nullable().optional(),

  biomechanicsInjuryRisk: z.number().min(0).max(100).nullable().optional(),
  /**
   * Asimetría bilateral del motor de biomecánica. Pese al nombre, es la diferencia
   * media de ÁNGULOS izq./dcha. en GRADOS (keypointMapper/biomechanicsEngine): sin tope
   * en el esquema (un valor alto ya no tumba la llamada entera); el factor se acota a
   * 100. Unidad y escala ×5 pendientes de calibrar (docs/pendientes-metricas.md).
   */
  asymmetryPct: z.number().finite().min(0).nullable().optional(),
  /** Fotogramas con pose y confianza media del motor de biomecánica (2D, sin calibrar). */
  biomechanicsFrames: z.number().finite().nonnegative().nullable().optional(),
  biomechanicsConfidence: z.number().min(0).max(1).nullable().optional(),

  injuryHistory: z.array(z.object({
    type: z.string(),
    severity: z.string(),
    daysOut: z.number().finite().nullable().optional(),
    date: z.string(),
    bodyPart: z.string().optional(),
  })).optional().default([]),

  daysSinceLastInjury: z.number().finite().nullable().optional(),
  sessionsLast28Days: z.number().finite().optional().default(0),
  matchesLast7Days: z.number().finite().optional().default(0),
});

type Input = z.infer<typeof injuryRiskSchema>;

const FACTOR_LABEL_ES: Record<InjuryRiskFactorKey, string> = {
  acwr: "carga (zona ACWR)",
  phvWindow: "ventana PHV",
  asymmetry: "asimetría",
  biomechanics: "biomecánica",
  injuryHistory: "historial de lesiones",
  fatigue: "fatiga",
};

const factor = (value: number, ref: string): MetricResult<number> =>
  derived(Math.max(0, Math.min(100, Math.round(value))), {
    confidence: ORIENTATIVE_CONFIDENCE,
    calibrated: false,
    source_ref: ref,
  });

/** ¿El dato de biomecánica es utilizable? (el motor devuelve todo a 0 por debajo del mínimo). */
function biomechReliable(input: Input): boolean {
  return (
    typeof input.biomechanicsFrames === "number" &&
    input.biomechanicsFrames >= BIOMECH_MIN_FRAMES &&
    typeof input.biomechanicsConfidence === "number" &&
    input.biomechanicsConfidence > 0
  );
}

function historyScore(input: Input): number {
  let score = 0;
  const last = input.daysSinceLastInjury;
  if (typeof last === "number") {
    const tramo = H.recency.find((r) => last < r.maxDays);
    score += tramo ? tramo.points : H.recencyOlderPoints;
  }
  const recent = input.injuryHistory.filter((i) => {
    const d = daysSince(i.date);
    return d !== null && d <= H.recentWindowDays;
  });
  score += Math.min(H.maxRecentPoints, recent.length * H.pointsPerRecentInjury);
  if (input.injuryHistory.some((i) => i.severity === "severe")) score += H.severeBonus;
  if (input.injuryHistory.some((i) => i.severity === "moderate" && (i.daysOut ?? 0) > H.moderateDaysOut)) {
    score += H.moderateBonus;
  }
  return score;
}

/** Los seis factores, cada uno con su dato o su motivo. */
export function computeInjuryRiskFactors(input: Input): InjuryRiskFactorView[] {
  const w = INJURY_RISK_WEIGHTS;
  const phvApplies = !(typeof input.age === "number" && input.age > PHV_WINDOW_MAX_AGE);
  const zone = input.acwrZone ?? null;
  const ratio = typeof input.acwrValue === "number" ? ` (ratio ${input.acwrValue.toFixed(2)})` : "";
  const offset = typeof input.phvOffset === "number" && Number.isFinite(input.phvOffset) ? input.phvOffset : null;
  const bmOk = biomechReliable(input);

  return [
    {
      factor: "acwr",
      weight: w.acwr,
      applicable: true,
      result: zone
        ? factor(ACWR_ZONE_RISK[zone], "acwrService:zone")
        : gated(
            `Sin zona de carga: hacen falta al menos ${MIN_FATIGUE_SESSIONS} sesiones registradas y la maduración del jugador.`,
            { source_ref: SOURCE_REF },
          ),
      description: zone ? `Zona ACWR: ${zone}${ratio}` : "Zona ACWR: sin calcular",
    },
    {
      factor: "phvWindow",
      weight: w.phvWindow,
      applicable: phvApplies,
      result: !phvApplies
        ? gated("No aplica: jugador adulto (la ventana de estirón es de jugadores en crecimiento).", { source_ref: SOURCE_REF })
        : offset !== null
          ? factor(levelFromOffset(offset).risk, "phvGate+growthSpurtShield")
          : gated("PHV no calculado: faltan medidas del jugador (la puerta del PHV está cerrada).", { source_ref: SOURCE_REF }),
      description: offset !== null && phvApplies ? `Offset PHV: ${offset.toFixed(1)} (${levelFromOffset(offset).level})` : "Offset PHV: no disponible",
    },
    {
      factor: "asymmetry",
      weight: w.asymmetry,
      applicable: true,
      result:
        typeof input.asymmetryPct === "number" && bmOk
          ? factor(input.asymmetryPct * ASYMMETRY_RISK_PER_PCT, "biomechanicsEngine:asymmetryPct")
          : gated("Sin asimetría medida con pose suficiente (fotogramas y confianza del análisis biomecánico).", { source_ref: SOURCE_REF }),
      description: typeof input.asymmetryPct === "number" && bmOk ? `Asimetría: ${input.asymmetryPct.toFixed(1)}° (diferencia media de ángulos izq./dcha.)` : "Asimetría: sin dato",
    },
    {
      factor: "biomechanics",
      weight: w.biomechanics,
      applicable: true,
      result:
        typeof input.biomechanicsInjuryRisk === "number" && bmOk
          ? factor(input.biomechanicsInjuryRisk, "biomechanicsEngine:injuryRisk")
          : gated("Sin análisis biomecánico con pose suficiente (fotogramas y confianza).", { source_ref: SOURCE_REF }),
      description: typeof input.biomechanicsInjuryRisk === "number" && bmOk ? `Biomecánica: ${Math.round(input.biomechanicsInjuryRisk)}/100` : "Biomecánica: sin dato",
    },
    {
      factor: "injuryHistory",
      weight: w.injuryHistory,
      applicable: true,
      result:
        input.injuryHistory.length > 0
          ? factor(historyScore(input), "player_injuries")
          : gated(
              "Sin lesiones registradas: no se distingue «sin lesiones» de «sin registrar».",
              { source_ref: SOURCE_REF },
            ),
      description: `${input.injuryHistory.length} lesiones registradas`,
    },
    {
      factor: "fatigue",
      weight: w.fatigue,
      applicable: true,
      result:
        typeof input.fatigueIndex === "number"
          ? factor(input.fatigueIndex, "fatigueEngine:index")
          : gated("Sin índice de fatiga fiable (sesión de al menos 20 min con la maduración registrada).", { source_ref: SOURCE_REF }),
      description: typeof input.fatigueIndex === "number" ? `Índice de fatiga: ${Math.round(input.fatigueIndex)}/100` : "Índice de fatiga: sin dato",
    },
  ];
}

function categoryOf(value: number): InjuryRiskCategory {
  const c = INJURY_RISK_CATEGORY_CUTS;
  return value >= c.critical ? "critical" : value >= c.high ? "high" : value >= c.moderate ? "moderate" : "low";
}

/** Recomendaciones SOLO con un compuesto real: sin él no se aconseja carga. */
function recommendations(category: InjuryRiskCategory, factors: InjuryRiskFactorView[], shield: string | null): string[] {
  const recs: string[] = [];
  const present = factors.filter((f) => f.applicable && f.result.value !== null);
  const top = [...present].sort((a, b) => (b.result.value as number) - (a.result.value as number))[0];
  if (category === "critical") {
    recs.push("Reducir carga de entrenamiento al 50% durante esta semana");
    recs.push("Evaluacion medica preventiva recomendada");
  }
  if (category === "high" || category === "critical") {
    recs.push("Evitar sesiones de alta intensidad consecutivas");
    recs.push("Priorizar recuperacion activa (hidroterapia, estiramientos)");
  }
  if (top?.factor === "acwr") recs.push("El ratio de carga aguda/cronica esta elevado — moderar volumen");
  if (top?.factor === "phvWindow" && (shield === "peak" || shield === "high")) {
    recs.push("Jugador en ventana de crecimiento — riesgo de lesion osea elevado");
    recs.push("Limitar sprints maximos y cambios de direccion bruscos");
  }
  if (top?.factor === "asymmetry") recs.push("Asimetria biomecanica detectada — trabajo correctivo bilateral recomendado");
  if (top?.factor === "injuryHistory") recs.push("Historial de lesiones previas — protocolo de prevencion reforzado");
  if (category === "low") {
    recs.push("Riesgo bajo con los datos disponibles — mantener plan y seguir registrando carga");
  }
  return recs.slice(0, 5);
}

/** Informe completo (puro): lo usan el handler y los tests. */
export function computeInjuryRisk(input: Input): InjuryRiskReport {
  const factors = computeInjuryRiskFactors(input);
  const comp = weightedComposite(
    factors.map((f) => ({ key: f.factor, weight: f.weight, applicable: f.applicable, value: f.result.value })),
    { minCoverage: INJURY_RISK_MIN_COVERAGE, mandatory: INJURY_RISK_MANDATORY, label: (k) => FACTOR_LABEL_ES[k] },
  );
  const offset = typeof input.phvOffset === "number" && Number.isFinite(input.phvOffset) ? input.phvOffset : null;
  const phvApplies = !(typeof input.age === "number" && input.age > PHV_WINDOW_MAX_AGE);
  const shield = offset !== null && phvApplies ? levelFromOffset(offset).level : null;

  const composite: MetricResult<number> =
    comp.value === null
      ? gated(`Riesgo de lesión no calculado. ${comp.gate_reason}`, { source_ref: SOURCE_REF })
      : derived(comp.value, {
          confidence: Math.round(ORIENTATIVE_CONFIDENCE * comp.coverage * 100) / 100,
          calibrated: false,
          source_ref: SOURCE_REF,
        });
  const category = comp.value === null ? null : categoryOf(comp.value);

  const injuries = input.injuryHistory;
  const lastDays =
    typeof input.daysSinceLastInjury === "number"
      ? input.daysSinceLastInjury
      : injuries.length > 0
        ? daysSince([...injuries].sort((a, b) => b.date.localeCompare(a.date))[0].date)
        : null;

  return {
    playerId: input.playerId,
    composite,
    category,
    coverage: Math.round(comp.coverage * 100) / 100,
    factors,
    recommendations: category ? recommendations(category, factors, shield) : [],
    growthShieldLevel: shield,
    daysSinceLastInjury: lastDays,
    injuryHistoryCount: injuries.length,
    coldStartWarning: (input.sessionsLast28Days ?? 0) < MIN_FATIGUE_SESSIONS,
  };
}

export default withHandler(
  { schema: injuryRiskSchema, requireAuth: true, maxRequests: 200, allowServiceToken: true, requiredPlan: "pro,club" },
  async ({ body }) => {
    const input = body as Input;
    return successResponse({
      report: computeInjuryRisk(input),
      promptVersion: INJURY_RISK_PROMPT_VERSION,
    });
  },
);
