/**
 * VITAS · Evaluaciones de VSI de ficha con fecha y origen + variación entre ellas.
 *
 * Fuente ÚNICA (invariante #7) de:
 *   - el registro de evaluaciones `vsiEvaluations: [{ value, at, source }]` que se
 *     guarda en el blob `data` del jugador cada vez que el entrenador evalúa las 6
 *     barras (PlayerService en el navegador, api/players/_crud.ts en el servidor);
 *   - la VARIACIÓN del VSI entre las dos últimas evaluaciones reales (`computeVsiDelta`),
 *     que consumen el ScoutFeed (api/scout/generate.ts → InsightCard), el panel de
 *     familia (ParentDashboardPage) y el informe imprimible (PlayerReportPrint);
 *   - la serie de evaluaciones reales con fecha (`realVsiEvaluations`), única base de
 *     las gráficas de evolución (PlayerReportPrint, api/reports/_pdf.ts);
 *   - la flecha de tendencia ↑/↓ (`vsiTrendArrow`, derivada de `computeVsiDelta`) de
 *     /rankings (api/rankings/_list.ts, adapters.ts) y de «Talentos en tendencia» (/pulse).
 *
 * Por qué existe: el «67.4 (+9.9)» del ScoutFeed lo escribía el LLM como texto libre y
 * el panel de familia rotulaba «+X pts vs hace 1 mes» restando posiciones de
 * `vsiHistory`, un array SIN fechas ni origen en el que además quedaron valores
 * fabricados (57.5 = calculateFichaVsi de las barras por defecto antes de #146).
 * Una variación solo es presentable si compara DOS evaluaciones reales con fecha y
 * origen conocidos; si no, se BLOQUEA (value null + gate_reason, invariante #2).
 * El historial legacy (`vsiHistory`) NUNCA entra en la variación: solo sirve para
 * explicar por qué está bloqueada.
 *
 * Solo imports relativos: este módulo lo importan también las Edge Functions de api/.
 */

import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "../metrics/MetricResult";

// ── Registro de evaluaciones ─────────────────────────────────────────────────

/**
 * Origen de una evaluación.
 *  - `coach_form`   — el entrenador guardó las 6 barras en la app (PlayerService).
 *  - `players_api`  — el entrenador guardó las 6 barras vía /api/players/crud.
 *  - `demo_seed`    — jugador de ejemplo sembrado por el modo demo (NO es real).
 */
export type VsiEvaluationSource = "coach_form" | "players_api" | "demo_seed";

/** Orígenes que cuentan como evaluación REAL de una persona (entran en la variación). */
export const REAL_VSI_EVALUATION_SOURCES: readonly VsiEvaluationSource[] = ["coach_form", "players_api"];

const ALL_SOURCES: readonly VsiEvaluationSource[] = ["coach_form", "players_api", "demo_seed"];

export interface VsiEvaluation {
  /** VSI de ficha (calculateFichaVsi) de esa evaluación, 0..100. */
  value: number;
  /** Instante ISO-8601 en que se guardó la evaluación. */
  at: string;
  source: VsiEvaluationSource;
}

function isValidEvaluation(e: unknown): e is VsiEvaluation {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.value === "number" &&
    Number.isFinite(r.value) &&
    r.value >= 0 &&
    r.value <= 100 &&
    typeof r.at === "string" &&
    Number.isFinite(Date.parse(r.at)) &&
    typeof r.source === "string" &&
    (ALL_SOURCES as readonly string[]).includes(r.source)
  );
}

/**
 * Lee un registro de evaluaciones de forma defensiva (viene de jsonb/localStorage):
 * descarta entradas sin valor, sin fecha parseable o con origen desconocido, y
 * devuelve el resto ordenado por fecha ascendente (orden estable).
 */
export function parseVsiEvaluations(raw: unknown): VsiEvaluation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidEvaluation)
    .map((e) => ({ value: e.value, at: e.at, source: e.source }))
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * Evaluaciones REALES (origen persona: coach_form | players_api) con fecha, en orden
 * ascendente. Es la ÚNICA serie con la que se puede pintar una evolución del VSI de
 * ficha (informe imprimible /report/:id, PDF de servidor) y la misma que usa
 * `computeVsiDelta`. El historial legacy `vsiHistory` (sin fechas ni origen, con el
 * 57.5 fabricado antes de #146) nunca entra; las semillas demo tampoco.
 */
export function realVsiEvaluations(raw: unknown): VsiEvaluation[] {
  return parseVsiEvaluations(raw).filter((e) => REAL_VSI_EVALUATION_SOURCES.includes(e.source));
}

/**
 * Añade una evaluación al registro. El registro previo se sanea (entradas inválidas
 * fuera). `at` por defecto = ahora. Pura: no muta `previous`.
 */
export function appendVsiEvaluation(
  previous: unknown,
  value: number,
  source: VsiEvaluationSource,
  at: string = new Date().toISOString(),
): VsiEvaluation[] {
  const next = [...parseVsiEvaluations(previous), { value, at, source }];
  return parseVsiEvaluations(next);
}

// ── Variación entre las dos últimas evaluaciones reales ──────────────────────

/** Motivo de bloqueo en forma de código (la UI lo traduce; `gate_reason` es el texto canónico). */
export type VsiDeltaGateCode =
  | "no_evaluations"
  | "single_evaluation"
  | "legacy_undated"
  | "same_instant"
  | "current_mismatch";

export const VSI_DELTA_GATE_REASONS: Record<VsiDeltaGateCode, string> = {
  no_evaluations: "sin evaluaciones del entrenador con fecha y origen registradas",
  single_evaluation: "solo hay una evaluación con fecha; hace falta una segunda para calcular la variación",
  legacy_undated: "historial anterior sin fecha ni origen",
  same_instant: "las dos últimas evaluaciones tienen la misma fecha",
  current_mismatch: "el VSI actual no coincide con la última evaluación registrada",
};

/**
 * Variación del VSI de ficha como MetricResult (DERIVADA) + la trazabilidad que la
 * hace legible: qué dos evaluaciones compara y de qué fechas. Se persiste tal cual en
 * `scout_insights.context_data.vsi_delta`.
 */
export interface VsiDelta extends MetricResult<number> {
  from_at: string | null;
  to_at: string | null;
  from_value: number | null;
  to_value: number | null;
  gate_code: VsiDeltaGateCode | null;
}

export const VSI_DELTA_SOURCE_REF = "src/lib/scoring/vsiDelta.ts#computeVsiDelta";
const UNITS = "pts";

/** Redondeo a 1 decimal: la misma precisión con la que calculateFichaVsi emite el VSI. */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function blocked(code: VsiDeltaGateCode): VsiDelta {
  return {
    ...gated<number>(VSI_DELTA_GATE_REASONS[code], { units: UNITS, source_ref: VSI_DELTA_SOURCE_REF }),
    from_at: null,
    to_at: null,
    from_value: null,
    to_value: null,
    gate_code: code,
  };
}

function legacyLength(raw: unknown): number {
  return Array.isArray(raw) ? raw.filter((v) => typeof v === "number" && Number.isFinite(v)).length : 0;
}

export interface VsiDeltaInput {
  /** Registro `vsiEvaluations` del blob del jugador (jsonb/localStorage, sin validar). */
  evaluations: unknown;
  /** `vsiHistory` legacy (sin fechas ni origen). NUNCA entra en la cuenta: solo explica el bloqueo. */
  legacyHistory?: unknown;
  /**
   * VSI actual del jugador. Si se pasa (número o null) y no coincide con la última
   * evaluación registrada, la variación se bloquea: el VSI se movió por otra ruta
   * (p.ej. el antiguo ajuste PHV) y la variación no describiría el valor mostrado.
   * `undefined` = no comprobar.
   */
  currentVsi?: number | null;
}

/**
 * Variación del VSI de ficha entre las dos ÚLTIMAS evaluaciones reales (origen
 * persona, fecha conocida). value = última − penúltima, redondeada a 1 decimal.
 * Sin dos evaluaciones reales ⇒ value null + gate_reason (nunca un 0, nunca el
 * historial sin fechas).
 *
 * confidence = ORIENTATIVE_CONFIDENCE: la resta es exacta, pero sus dos entradas son
 * valoraciones SUBJETIVAS del entrenador (sliders), no medidas.
 */
export function computeVsiDelta(input: VsiDeltaInput): VsiDelta {
  const real = realVsiEvaluations(input.evaluations);

  if (real.length < 2) {
    if (legacyLength(input.legacyHistory) >= 2) return blocked("legacy_undated");
    return blocked(real.length === 1 ? "single_evaluation" : "no_evaluations");
  }

  const from = real[real.length - 2];
  const to = real[real.length - 1];
  if (Date.parse(to.at) === Date.parse(from.at)) return blocked("same_instant");

  if (input.currentVsi !== undefined) {
    const current = input.currentVsi;
    if (current === null || !Number.isFinite(current) || round1(current) !== round1(to.value)) {
      return blocked("current_mismatch");
    }
  }

  return {
    ...derived(round1(to.value - from.value), {
      units: UNITS,
      confidence: ORIENTATIVE_CONFIDENCE,
      source_ref: VSI_DELTA_SOURCE_REF,
    }),
    from_at: from.at,
    to_at: to.at,
    from_value: from.value,
    to_value: to.value,
    gate_code: null,
  };
}

/**
 * Lee un `vsi_delta` persistido (context_data de scout_insights) de forma defensiva.
 * Devuelve null si no tiene la forma de un VsiDelta (insights anteriores a este cambio).
 */
export function readVsiDelta(raw: unknown): VsiDelta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.provenance !== "DERIVADA") return null;
  const value = r.value;
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return null;
  const gateReason = typeof r.gate_reason === "string" && r.gate_reason.trim() !== "" ? r.gate_reason : null;
  if (value === null && gateReason === null) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const code = str(r.gate_code);
  const confidence = num(r.confidence);
  return {
    value: value as number | null,
    provenance: "DERIVADA",
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : 0,
    units: str(r.units),
    calibrated: false,
    gate_reason: gateReason,
    source_ref: str(r.source_ref) ?? undefined,
    from_at: str(r.from_at),
    to_at: str(r.to_at),
    from_value: num(r.from_value),
    to_value: num(r.to_value),
    gate_code: code && code in VSI_DELTA_GATE_REASONS ? (code as VsiDeltaGateCode) : null,
  };
}

// ── Flecha de tendencia ↑/↓ (/rankings y «Talentos en tendencia» de /pulse) ──

/**
 * Flecha de tendencia de un jugador. "stable" = SIN flecha: ninguna superficie pinta
 * "stable" (Rankings solo dibuja ↑/↓; dashboardService solo lista "up"), así que cubre
 * tanto una variación pequeña como una variación NO calculable (bloqueada).
 */
export type VsiTrendArrow = "up" | "down" | "stable";

/**
 * Banda de la flecha, en pts de VSI de ficha: la misma ±2 que usaban las flechas
 * anteriores (y MetricsService.calculateTrend). Sin fuente en literatura: pendiente de
 * validar. La flecha solo resume el signo de una variación ya calculada por
 * computeVsiDelta (DERIVADA, confidence orientativa); no añade ninguna cifra.
 */
export const VSI_TREND_ARROW_BAND_PTS = 2;

export interface VsiTrendArrowInput extends VsiDeltaInput {
  /**
   * `true` ⇒ jugador de DEMO (MOCK, la demo lleva banner). Sus evaluaciones son
   * `demo_seed` (nunca reales), así que su flecha sale del historial que siembra
   * demoDataService (seedPlayerExtras, #198). Solo el literal `true` activa esa vía:
   * un jugador real NUNCA recibe una flecha del historial legacy.
   */
  isDemo?: boolean | null;
}

/** Variación del historial SEMBRADO de un jugador demo (actual − penúltimo); null si no hay dos. */
function demoLegacyChange(legacy: unknown, current: number | null | undefined): number | null {
  if (typeof current !== "number" || !Number.isFinite(current) || !Array.isArray(legacy)) return null;
  const nums = legacy.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length >= 2 ? current - nums[nums.length - 2] : null;
}

/**
 * Flecha ↑/↓ desde la MISMA variación que el panel de familia, el informe y el ScoutFeed
 * (computeVsiDelta, invariante #7): ↑ si value > banda, ↓ si value < −banda; value null
 * (sin dos evaluaciones reales con fecha, historial legacy, VSI actual distinto…) ⇒ sin
 * flecha. Antes /rankings y /pulse restaban `vsiHistory.at(-2)`: con Samu ([57.5, 67.4],
 * sin evaluaciones con fecha) salía ↑ y «en tendencia» mientras el panel de familia
 * bloqueaba la misma variación («historial anterior sin fecha ni origen»).
 */
export function vsiTrendArrow(input: VsiTrendArrowInput): VsiTrendArrow {
  let change = computeVsiDelta(input).value;
  if (change === null && input.isDemo === true) {
    change = demoLegacyChange(input.legacyHistory, input.currentVsi);
  }
  if (change === null) return "stable";
  if (change > VSI_TREND_ARROW_BAND_PTS) return "up";
  if (change < -VSI_TREND_ARROW_BAND_PTS) return "down";
  return "stable";
}

// ── Serie legacy retirada de `analyses.vsi` ──────────────────────────────────

/**
 * Campos RETIRADOS del JSON `analyses.vsi`: `trend` (pendiente/momentum/delta) e
 * `history`. Su único escritor fue api/players/baseline-analysis.ts, que los calculaba
 * sobre `players.vsi_history` (legacy SIN fechas ni origen, con el 57.5 fabricado antes
 * de #146) con, al final, un VSI de OTRA fórmula. Para Samu ([57.5, 67.4]) el panel de
 * análisis pintaba «↗» y «+9.x pts»: la misma variación fabricada que el ScoutFeed.
 * baseline-analysis ya no los escribe; las filas guardadas los conservan, así que los
 * endpoints que sirven análisis (api/analyses/reports.ts, api/analyses/share.ts) los
 * quitan al leer. La única variación válida es `computeVsiDelta` (invariante #7).
 *
 * `peer` (P1 bloque 5): percentil que el mismo endpoint guardaba comparando contra
 * jugadores de TODAS las cuentas, sin mínimo y con los no evaluados como 0 (podía dar
 * «P0»). Ya no se escribe; las filas viejas lo pierden al leer. La comparación con pares
 * es /api/benchmark/peer (implementación única, src/lib/metrics/percentile.ts).
 */
export const RETIRED_ANALYSIS_VSI_FIELDS = ["trend", "history", "peer"] as const;

/** Copia de `analyses.vsi` sin los campos retirados. No muta la entrada; lo demás intacto. */
export function withoutUndatedVsiSeries<T>(vsi: T): T {
  if (!vsi || typeof vsi !== "object" || Array.isArray(vsi)) return vsi;
  const copy: Record<string, unknown> = { ...(vsi as Record<string, unknown>) };
  for (const field of RETIRED_ANALYSIS_VSI_FIELDS) delete copy[field];
  return copy as T;
}
