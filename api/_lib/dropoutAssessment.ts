/**
 * VITAS · Evaluación de riesgo de abandono — ÚNICA implementación de servidor (inv #7)
 *
 * Construye las entradas del scorer canónico (`src/lib/wellbeing/dropoutRiskScorer.ts`)
 * a partir de SEÑALES REALES en Supabase (attendance_records, engagement_snapshots,
 * fatigue_sessions). La usan:
 *   - GET /api/wellbeing/dropout-risk (`api/wellbeing/_dropout-risk.ts`) → Hub y /wellbeing
 *   - el resumen mensual al director (`api/crons/director-risk-digest.ts`)
 * Así el email y el panel salen de la MISMA función. Antes el digest llevaba su propia
 * copia que derivaba el riesgo de un HASH del id del jugador (MOCK disfrazado,
 * prohibido por `.claude/rules/metricas.md` incluso con banner).
 *
 * Honestidad (inv #2):
 *   - Sin NINGUNA señal real → `source: "insufficient_data"` (nunca un riesgo inventado).
 *   - Guardas de VALOR, no solo de fila: un composite 0 de engagement puede ser el
 *     DEFAULT de la columna (no medido), y una sesión de fatiga puede no tener
 *     `fatigue_index` (columna nullable, 043). Ninguna de las dos cuenta como señal.
 *   - Señal ausente → entrada NEUTRA (contribución 0), nunca un valor típico.
 *
 * P1 bloque 4 (decisión del owner): el SOBREENTRENAMIENTO que ve el usuario
 * (OvertrainingAlert) es la alerta de sobrecarga. Sin índice de fatiga real, o con
 * la maduración NO registrada en esa sesión, no hay riesgo ni nivel (sin semáforo,
 * value null + gate_reason): se muestra solo la carga registrada. Antes salía
 * «0/100 bajo» en verde sin datos, y el riesgo se tomaba del índice sin mirar la
 * maduración. Tampoco se inventa una «carga recomendada» (era la misma carga).
 */

import { calculateAttendanceProfile } from "../../src/lib/wellbeing/attendanceTracker";
import { classifyMotivation } from "../../src/lib/wellbeing/motivationClassifier";
import { scoreDropoutRisk } from "../../src/lib/wellbeing/dropoutRiskScorer";
import { generateIntervention } from "../../src/lib/wellbeing/interventionProtocol";
import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "../../src/lib/metrics/MetricResult";
import type { AttendanceRecord } from "../../src/lib/wellbeing/attendanceTracker";
import type { MotivationProfile } from "../../src/lib/wellbeing/motivationClassifier";
import type { OvertrainingAssessment } from "../../src/lib/wellbeing/overtrainingDetector";
import type { DropoutRiskOutput } from "../../src/lib/wellbeing/dropoutRiskScorer";
import type { EngagementSnapshot } from "../../src/lib/shared/sessionTypes";
import { maturationKnown } from "../../src/lib/fatigue/phvFatigueAdjuster";
import { DEFAULT_FATIGUE_CONFIG } from "../../src/lib/fatigue/types";

export type SignalRow = Record<string, unknown>;

/** SELECT PostgREST que devuelve filas o [] ante cualquier fallo (nunca lanza). */
export type RowSelector = (path: string) => Promise<SignalRow[]>;

/** Selector con service key. Devuelve [] ante cualquier fallo (fail-closed). */
export function makeRowSelector(supabaseUrl: string, serviceKey: string): RowSelector {
  return async (path: string) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? (data as SignalRow[]) : [];
    } catch {
      return [];
    }
  };
}

export interface DropoutSignalRows {
  attendance: SignalRow[];
  engagement: SignalRow[];
  fatigue: SignalRow[];
}

/** Lee las tres fuentes de señal de UN jugador (las más recientes primero). */
export async function fetchDropoutSignals(playerId: string, select: RowSelector): Promise<DropoutSignalRows> {
  const pid = encodeURIComponent(playerId);
  const [attendance, engagement, fatigue] = await Promise.all([
    select(`attendance_records?player_id=eq.${pid}&select=player_id,date,status,source,session_id&order=date.desc&limit=90`),
    select(`engagement_snapshots?player_id=eq.${pid}&select=session_id,date,physical,social,emotional,composite,trend,weekly_avg&order=date.desc&limit=60`),
    select(`fatigue_sessions?player_id=eq.${pid}&select=session_date,total_load,fatigue_index,fatigue_severity,acwr_value,maturation_band,phv_offset&order=session_date.desc&limit=28`),
  ]);
  return { attendance, engagement, fatigue };
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// ── Neutrales HAND-BUILT (contribución 0) para señales ausentes ─────────────
// NO llamar a assessOvertraining/classifyMotivation con datos vacíos: inyectan
// ~12 y ~45 pts de riesgo respectivamente sobre un jugador sin datos.
function neutralOvertraining(playerId: string): OvertrainingAssessment {
  return {
    playerId,
    overtrainingRisk: 0,
    riskLevel: "low",
    factors: { acwrRisk: 0, fatigueRisk: 0, loadRisk: 0, phvRisk: 0, injuryRisk: 0 },
    recommendations: [],
    loadAdjustment: { currentLoadAU: 0, recommendedLoadAU: 0, adjustmentPct: 0 },
  };
}
function neutralMotivation(playerId: string): MotivationProfile {
  return {
    playerId,
    type: "mixed",
    inherentDropoutRisk: 0,
    confidence: 0,
    signals: {
      physicalEngagementAvg: 0,
      socialEngagementAvg: 0,
      emotionalEngagementAvg: 0,
      intensityConsistency: 0,
      trainingVsMatchGap: 0,
    },
  };
}

/**
 * Overtraining a partir del fatigue_index REAL más reciente de una sesión con
 * maduración CONOCIDA (las filas llegan ya filtradas). Los cortes del nivel son los
 * del índice de fatiga (DEFAULT_FATIGUE_CONFIG, una sola definición: inv #7).
 */
function overtrainingFromFatigue(playerId: string, realRows: SignalRow[]): OvertrainingAssessment {
  const latest = realRows[0] ?? {};
  const risk = clamp(Math.round(latest.fatigue_index as number));
  const cut = DEFAULT_FATIGUE_CONFIG.severityThresholds;
  return {
    playerId,
    overtrainingRisk: risk,
    riskLevel: risk >= cut.critical ? "critical" : risk >= cut.high ? "high" : risk >= cut.moderate ? "moderate" : "low",
    factors: { acwrRisk: 0, fatigueRisk: risk, loadRisk: 0, phvRisk: 0, injuryRisk: 0 },
    recommendations: [],
    loadAdjustment: { currentLoadAU: 0, recommendedLoadAU: 0, adjustmentPct: 0 },
  };
}

/** Lo que ve el usuario del sobreentrenamiento (OvertrainingAlert, burnout-report). */
export interface OvertrainingView {
  /** 0-100; null = sin calcular (ver gate_reason). Nunca un 0 por falta de dato. */
  risk: number | null;
  riskLevel: OvertrainingAssessment["riskLevel"] | null;
  /** Carga registrada de la última sesión (total_load); null si no hay. */
  currentLoadAU: number | null;
  /** Nada calcula hoy una carga recomendada: null (antes repetía la actual). */
  recommendedLoadAU: number | null;
  adjustmentPct: number | null;
  gate_reason: string | null;
  /** Código estable del motivo (la UI lo traduce): null cuando hay riesgo. */
  gate_code: "maturation_unknown" | "no_data" | null;
}

export const OVERTRAINING_NO_DATA_REASON =
  "Sin sesiones con índice de fatiga registradas: no se puede valorar el sobreentrenamiento.";
export const OVERTRAINING_MATURATION_REASON =
  "Maduración no registrada: no se valora el riesgo de sobrecarga (sin semáforo). Se muestra solo la carga registrada.";

/**
 * Carga REAL de una sesión: total_load > 0. La columna es NOT NULL DEFAULT 0 (043), así
 * que un 0 es «sin carga registrada», no una carga (revisión del PR #315).
 */
function realLoad(row: SignalRow | undefined): number | null {
  const v = row?.total_load;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/** Última carga real de cualquier sesión; null si no hay ninguna. */
function latestLoad(rows: SignalRow[]): number | null {
  for (const r of rows) {
    const v = realLoad(r);
    if (v !== null) return v;
  }
  return null;
}

function overtrainingView(
  rows: SignalRow[],
  fromRisk: OvertrainingAssessment | null,
  riskRow: SignalRow | undefined,
  unknownMaturity: boolean,
): OvertrainingView {
  if (fromRisk) {
    return {
      risk: fromRisk.overtrainingRisk,
      riskLevel: fromRisk.riskLevel,
      // La carga de la MISMA sesión que el riesgo (antes: la última fila con número,
      // que podía ser un 0 por defecto de otra sesión junto a un riesgo crítico).
      currentLoadAU: realLoad(riskRow),
      recommendedLoadAU: null,
      adjustmentPct: null,
      gate_reason: null,
      gate_code: null,
    };
  }
  return {
    risk: null,
    riskLevel: null,
    currentLoadAU: latestLoad(rows),
    recommendedLoadAU: null,
    adjustmentPct: null,
    gate_reason: unknownMaturity ? OVERTRAINING_MATURATION_REASON : OVERTRAINING_NO_DATA_REASON,
    gate_code: unknownMaturity ? "maturation_unknown" : "no_data",
  };
}

/** engagement_snapshots (row DB) → EngagementSnapshot del dominio. */
function toEngagementSnapshot(playerId: string, r: SignalRow): EngagementSnapshot {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    playerId,
    sessionId: String(r.session_id ?? ""),
    date: String(r.date ?? ""),
    physicalEngagement: num(r.physical),
    socialEngagement: num(r.social),
    emotionalEngagement: num(r.emotional),
    engagementScore: num(r.composite),
    engagementTrend: (r.trend === "rising" || r.trend === "declining" || r.trend === "stable" ? r.trend : "stable") as EngagementSnapshot["engagementTrend"],
    weeklyAvg: num(r.weekly_avg),
  };
}

/** Resumen de engagement para la UI + engagementDecline (0 = estable, 100 = caída). */
function buildEngagement(rows: SignalRow[]): {
  decline: number;
  summary: { current: number; historical: number; trend: "declining" | "stable" | "improving"; consecutiveDeclines: number };
} {
  // rows vienen ordenadas por date DESC (la más reciente primero).
  const comps = rows.map((r) => (typeof r.composite === "number" ? r.composite : 0));
  const current = comps[0] ?? 0;
  const historical = Math.round(comps.reduce((s, v) => s + v, 0) / (comps.length || 1));
  const decline = clamp(historical - current);
  // Rachas de caída consecutiva (de más reciente a más antigua).
  let consecutiveDeclines = 0;
  for (let i = 0; i < comps.length - 1; i++) {
    if (comps[i] < comps[i + 1]) consecutiveDeclines++;
    else break;
  }
  const trend: "declining" | "stable" | "improving" =
    current < historical - 3 ? "declining" : current > historical + 3 ? "improving" : "stable";
  return { decline, summary: { current: Math.round(current), historical, trend, consecutiveDeclines } };
}

/**
 * Evaluación honesta "sin datos": todo neutro, source ≠ "computed".
 * El riskScore 0 / "low" / asistencia 0 de aquí NO es una evaluación: el cliente
 * (fetchDropoutRisk en src/hooks/useWellbeing.ts) trata `source: "insufficient_data"`
 * como «sin calcular» (null) y no pinta ninguno de estos números (P1 bloque 2). El
 * digest NUNCA la lista: solo lista source "computed".
 */
export function insufficientAssessment(playerId: string) {
  return {
    playerId,
    riskScore: 0,
    riskLevel: "low" as const,
    primaryFactor: "insufficient_data",
    factors: {
      engagementDecline: { score: 0, weight: 0.25 },
      motivationType: { score: 0, weight: 0.2 },
      overtrainingRisk: { score: 0, weight: 0.15 },
      vsiStagnation: { score: 0, weight: 0.12 },
      attendanceDecline: { score: 0, weight: 0.1 },
      injuryRecurrence: { score: 0, weight: 0.08 },
      growthSpurtStress: { score: 0, weight: 0.05 },
      lowResilience: null,
    },
    hasBehavioralData: false,
    intervention: { urgency: "monitor", actions: [], followUpDate: "", escalationNeeded: false },
    engagement: null,
    overtraining: {
      risk: null,
      riskLevel: null,
      currentLoadAU: null,
      recommendedLoadAU: null,
      adjustmentPct: null,
      gate_reason: OVERTRAINING_NO_DATA_REASON,
      gate_code: "no_data",
    } satisfies OvertrainingView,
    motivation: { type: "mixed", dropoutRisk: 0, confidence: 0 },
    attendance: { rate: 0, consecutiveAbsences: 0, recentTrend: "stable" },
  };
}

/** Qué fuentes aportaron una señal REAL (guardas de valor aplicadas). */
export interface SignalCoverage {
  attendance: boolean;
  engagement: boolean;
  /** classifyMotivation exige ≥3 snapshots reales; con menos, el factor es neutro. */
  motivation: boolean;
  fatigue: boolean;
}

export type DropoutAssessmentResult =
  | {
      source: "computed";
      assessment: ReturnType<typeof buildComputedAssessment>;
      /** Salida cruda del scorer (para persistir). */
      out: DropoutRiskOutput;
      signals: SignalCoverage;
    }
  | {
      source: "insufficient_data";
      assessment: ReturnType<typeof insufficientAssessment>;
      signals: SignalCoverage;
    };

function buildComputedAssessment(
  playerId: string,
  out: DropoutRiskOutput,
  proto: ReturnType<typeof generateIntervention>,
  /** null = sin implicación real registrada (la UI dice «sin datos», nunca 0). */
  eng: ReturnType<typeof buildEngagement>["summary"] | null,
  overtraining: OvertrainingView,
  motivation: MotivationProfile,
  attendance: ReturnType<typeof calculateAttendanceProfile>,
) {
  // recentTrend de asistencia (AttendanceProfile no lo trae): de la alerta/racha.
  const recentTrend =
    attendance.rate === null ? "sin datos" :
    attendance.consecutiveAbsences >= 2 ? "declining" :
    attendance.rate >= 85 ? "stable" : "declining";

  return {
    playerId,
    riskScore: out.riskScore,
    riskLevel: out.riskLevel,
    primaryFactor: out.primaryFactor,
    factors: out.factors,
    hasBehavioralData: out.hasBehavioralData,
    intervention: {
      urgency: proto.urgency,
      actions: proto.actions,
      followUpDate: proto.followUpDate,
      escalationNeeded: proto.escalationNeeded,
    },
    engagement: eng && {
      current: eng.current,
      historical: eng.historical,
      trend: eng.trend,
      consecutiveDeclines: eng.consecutiveDeclines,
    },
    overtraining,
    motivation: {
      type: motivation.type,
      dropoutRisk: motivation.inherentDropoutRisk,
      confidence: motivation.confidence,
    },
    attendance: {
      rate: attendance.rate,
      consecutiveAbsences: attendance.consecutiveAbsences,
      recentTrend,
    },
  };
}

/**
 * Evaluación pura (sin I/O) a partir de las filas de señal de un jugador.
 * Determinista: mismas filas → misma evaluación, en el endpoint y en el digest.
 */
export function computeDropoutAssessment(playerId: string, rows: DropoutSignalRows): DropoutAssessmentResult {
  const hasAtt = rows.attendance.length > 0;
  // Guarda de VALOR: composite 0 puede ser el DEFAULT de la columna ("no medido"),
  // NO engagement nulo → solo cuenta el snapshot con composite > 0 (evita que un 0
  // por defecto se clasifique como amotivación, inherentDropoutRisk 90).
  // NOTA: el contrato de columnas de engagement_snapshots está por reconciliar
  // (los writers escriben engagement_score; la migración/lectura usan composite);
  // hasta entonces esta guarda mantiene la señal honesta (neutra si no es real).
  const realEngRows = rows.engagement.filter((r) => typeof r.composite === "number" && (r.composite as number) > 0);
  const hasEng = realEngRows.length > 0;
  // Guarda de VALOR: fatigue_index es nullable (043) → una sesión sin índice NO es
  // señal de sobrecarga. Se usa el índice real más reciente, no la última fila.
  // P1 bloque 4: y solo de sesiones con la maduración CONOCIDA (el índice depende de
  // umbrales por maduración). "post_phv" sin offset = valor por defecto antiguo.
  const withIndex = rows.fatigue.filter(
    (r) => typeof r.fatigue_index === "number" && Number.isFinite(r.fatigue_index as number),
  );
  const realFatRows = withIndex.filter((r) => maturationKnown(r.maturation_band, r.phv_offset));
  const hasFat = realFatRows.length > 0;
  const fatigueUnknownMaturity = !hasFat && withIndex.length > 0;
  const hasMotivation = realEngRows.length >= 3;

  const signals: SignalCoverage = {
    attendance: hasAtt,
    engagement: hasEng,
    motivation: hasMotivation,
    fatigue: hasFat,
  };

  // Invariante #2: sin NINGUNA señal real → no se computa nada.
  if (!hasAtt && !hasEng && !hasFat) {
    return { source: "insufficient_data", assessment: insufficientAssessment(playerId), signals };
  }

  // ── Entradas: reales donde hay datos, NEUTRO (contribución 0) donde no ──
  const attendance = calculateAttendanceProfile(playerId, hasAtt ? (rows.attendance.map((r) => ({
    playerId,
    date: String(r.date ?? ""),
    status: r.status as AttendanceRecord["status"],
    source: (r.source === "video" || r.source === "manual" || r.source === "auto" ? r.source : "manual") as AttendanceRecord["source"],
    sessionId: r.session_id ? String(r.session_id) : undefined,
  })) as AttendanceRecord[]) : []);

  const eng = hasEng
    ? buildEngagement(realEngRows)
    : { decline: 0, summary: { current: 0, historical: 0, trend: "stable" as const, consecutiveDeclines: 0 } };

  // classifyMotivation necesita ≥3 snapshots REALES; si no, neutro (no inventa 45/90).
  const motivation: MotivationProfile = hasMotivation
    ? classifyMotivation(playerId, realEngRows.map((r) => toEngagementSnapshot(playerId, r)), [])
    : neutralMotivation(playerId);

  // Overtraining desde fatigue_index real; si no hay, neutro (no inventa 12).
  // (deuda documentada: en el SCORER la ausencia entra neutra y su peso no se
  // redistribuye; en la VISTA queda sin calcular, nunca «0/100 bajo»).
  const overtrainingRisk = hasFat ? overtrainingFromFatigue(playerId, realFatRows) : null;
  const overtraining = overtrainingRisk ?? neutralOvertraining(playerId);
  const overtrainingShown = overtrainingView(rows.fatigue, overtrainingRisk, realFatRows[0], fatigueUnknownMaturity);

  const out = scoreDropoutRisk({
    playerId,
    engagementDecline: eng.decline,
    motivation,
    overtraining,
    // Sin señal real todavía → contribución 0 (neutro, no inventa riesgo).
    // DEUDA inv#2 (pendientes-metricas): su peso NO se redistribuye → el compuesto
    // puede quedar INFRAVALORADO. El email lo declara.
    vsiStagnation: 0,
    attendance,
    injuryRecurrence: 0,
    growthSpurtStress: 0,
    behavioralScores: null,
  });
  const proto = generateIntervention(out);

  return {
    source: "computed",
    // Sin implicación real el resumen es null (P1 bloque 4): antes current 0 ⇒ el padre
    // veía «el nivel de disfrute es bajo» en rojo sin un solo dato.
    assessment: buildComputedAssessment(playerId, out, proto, hasEng ? eng.summary : null, overtrainingShown, motivation, attendance),
    out,
    signals,
  };
}

/** Referencia de procedencia del riesgo (modelo + estado de validación). */
export const DROPOUT_RISK_SOURCE_REF =
  "src/lib/wellbeing/dropoutRiskScorer.ts (modelo de 8 factores; pesos pendientes de validar)";

/**
 * El riesgo como MetricResult (contrato `.claude/rules/metricas.md`):
 *   - computed → DERIVADA, confianza ORIENTATIVA (constante compartida de
 *     MetricResult.ts: pesos y umbrales «pendiente de validar» ⇒ confidence reducida).
 *   - insufficient_data → BLOQUEADA (value null + gate_reason). Nunca un 0.
 */
export function dropoutRiskMetric(result: DropoutAssessmentResult): MetricResult<number> {
  if (result.source !== "computed") {
    return gated(
      "Sin señales reales registradas (asistencia, implicación o carga): no se puede calcular el riesgo de abandono.",
      { provenance: "DERIVADA", source_ref: DROPOUT_RISK_SOURCE_REF },
    );
  }
  return derived(result.assessment.riskScore, {
    confidence: ORIENTATIVE_CONFIDENCE,
    units: null,
    calibrated: false,
    source_ref: DROPOUT_RISK_SOURCE_REF,
  });
}
