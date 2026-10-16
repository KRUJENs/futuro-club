/**
 * VITAS · MetricResult — contrato de procedencia (G1 · arnés de honestidad).
 *
 * Ninguna función de métrica devuelve un `number` desnudo: devuelve un MetricResult
 * con su procedencia declarada. Ver `.claude/rules/metricas.md` (CLAUDE.md inv.1).
 *
 * Los 5 invariantes del contrato se comprueban EN EL FACTORY (`makeMetric`), no solo
 * en tests: construir un MetricResult inválido LANZA. Un número sin procedencia no
 * debe poder existir en tiempo de ejecución.
 *
 * FUNDACIÓN (aditiva): este módulo aún no lo consume nadie. La migración de cada
 * métrica a MetricResult es el resto de G1.
 */

export type Provenance =
  | "MEDIDA"        // sensor, antropometría introducida, o píxel calibrado
  | "DERIVADA"      // función determinista sobre entradas MEDIDA
  | "ESTIMADA_LLM"  // salida de un modelo de lenguaje o visión generativo
  | "CONSTANTE"     // valor fijo en código; nunca presentable como resultado
  | "MOCK";         // dato de ejemplo; exige banner visible

export interface MetricResult<T = number> {
  value: T | null;
  provenance: Provenance;
  confidence: number;         // 0..1
  units: string | null;       // 'km/h', 'm', 'px/s', 'años', null si adimensional
  calibrated: boolean;        // false ⇒ no puede ser MEDIDA
  gate_reason: string | null; // obligatorio y no vacío si value === null
  source_ref?: string;        // ruta, id de sensor, o modelo+versión si ESTIMADA_LLM
}

/**
 * Confianza por defecto de una métrica DERIVADA ORIENTATIVA: la función es determinista,
 * pero una entrada o un parámetro NO está validado. Usos (entre otros): tracking sin calibración de
 * campo certificada (píxeles reescalados, no metros fiables), percentiles y deltas de
 * la evaluación del entrenador (`percentile.ts`, `vsiDelta.ts`) y el trimestre de
 * nacimiento con el corte de categoría por defecto (`relativeAge.ts`). Constante compartida para
 * NO repetir el literal en cada ruta de cálculo (contrato `.claude/rules/metricas.md`:
 * las constantes de una ruta de cálculo van fuera de ella). Este fichero no es
 * calc_path de ninguna métrica, así que aquí el valor no es una "constante mágica".
 */
export const ORIENTATIVE_CONFIDENCE = 0.4;

/** Error de violación del contrato de procedencia. */
export class MetricContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricContractError";
  }
}

function invariant(cond: boolean, message: string): void {
  if (!cond) throw new MetricContractError(message);
}

/**
 * Factory canónico. Comprueba los 5 invariantes de `.claude/rules/metricas.md`.
 * TODA construcción de MetricResult pasa por aquí.
 */
export function makeMetric<T>(r: MetricResult<T>): MetricResult<T> {
  // Inv.5 — confidence en [0,1].
  invariant(
    Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1,
    `confidence fuera de [0,1]: ${r.confidence}`,
  );
  // Inv.1 — MEDIDA exige calibrated.
  invariant(
    !(r.provenance === "MEDIDA" && r.calibrated === false),
    "provenance MEDIDA con calibrated=false es inválido (sin calibración no es MEDIDA)",
  );
  // Inv.2 — value null exige gate_reason no vacío.
  invariant(
    !(r.value === null && (r.gate_reason === null || r.gate_reason.trim() === "")),
    "value=null exige un gate_reason no vacío",
  );
  // Inv.3 — CONSTANTE no es un resultado: su value debe ser null.
  invariant(
    !(r.provenance === "CONSTANTE" && r.value !== null),
    "provenance CONSTANTE debe tener value=null (una constante no es un resultado presentable)",
  );
  return r;
}

// ── Constructores de conveniencia ────────────────────────────────────────────
// Guían hacia el uso correcto; todos pasan por makeMetric (invariantes activos).

interface Common {
  confidence?: number;
  units?: string | null;
  source_ref?: string;
}

/** Medida real (sensor / antropometría / píxel calibrado). Exige calibrated=true. */
export function measured<T>(value: T, o: Common & { calibrated?: boolean } = {}): MetricResult<T> {
  return makeMetric({
    value,
    provenance: "MEDIDA",
    confidence: o.confidence ?? 1,
    units: o.units ?? null,
    calibrated: o.calibrated ?? true,
    gate_reason: null,
    source_ref: o.source_ref,
  });
}

/** Derivada determinista sobre entradas MEDIDA. */
export function derived<T>(value: T, o: Common & { calibrated?: boolean } = {}): MetricResult<T> {
  return makeMetric({
    value,
    provenance: "DERIVADA",
    confidence: o.confidence ?? 1,
    units: o.units ?? null,
    calibrated: o.calibrated ?? false,
    gate_reason: null,
    source_ref: o.source_ref,
  });
}

/** Estimada por un modelo generativo (LLM / visión). `source_ref` recomendado. */
export function estimatedLLM<T>(value: T, o: Common = {}): MetricResult<T> {
  return makeMetric({
    value,
    provenance: "ESTIMADA_LLM",
    confidence: o.confidence ?? 0.5,
    units: o.units ?? null,
    calibrated: false,
    gate_reason: null,
    source_ref: o.source_ref,
  });
}

/** Dato de ejemplo. Exige banner visible en UI (se controla en presentación). */
export function mock<T>(value: T, o: Common = {}): MetricResult<T> {
  return makeMetric({
    value,
    provenance: "MOCK",
    confidence: o.confidence ?? 0,
    units: o.units ?? null,
    calibrated: false,
    gate_reason: null,
    source_ref: o.source_ref,
  });
}

/**
 * Métrica BLOQUEADA: falta el dato o no se pudo medir. `value=null` + gate_reason.
 * Es un resultado válido y esperado (nunca un 0 que signifique «no medido»).
 */
export function gated<T = number>(
  gate_reason: string,
  o: Common & { provenance?: Provenance; calibrated?: boolean } = {},
): MetricResult<T> {
  return makeMetric({
    value: null,
    provenance: o.provenance ?? "DERIVADA",
    confidence: 0,
    units: o.units ?? null,
    calibrated: o.calibrated ?? false,
    gate_reason,
    source_ref: o.source_ref,
  });
}

/**
 * Sub-score CONSTANTE (fijo en código). Por contrato su value es null: no se
 * presenta como cifra. Sirve para declarar honestamente «esto hoy es una constante».
 */
export function constant(gate_reason: string): MetricResult<number> {
  return makeMetric<number>({
    value: null,
    provenance: "CONSTANTE",
    confidence: 0,
    units: null,
    calibrated: false,
    gate_reason,
  });
}

/** ¿Es un valor presentable como cifra? (value no null y no CONSTANTE). */
export function isPresentable<T>(r: MetricResult<T>): boolean {
  return r.value !== null && r.provenance !== "CONSTANTE";
}
