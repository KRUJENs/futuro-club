/**
 * VITAS · Gate ÚNICO de PHV (fuente única de la decisión «¿se puede mostrar el PHV?»)
 *
 * Regla del product owner (28-sep): «si no están todas las métricas para PHV no se
 * puede calcular». El PHV (maturity offset / APHV de Mirwald, estado, timing y la
 * categoría persistida) solo se calcula y se MUESTRA cuando TODAS sus entradas han
 * sido introducidas por una persona:
 *
 *   · talla y peso
 *   · talla sentado
 *   · longitud de pierna (o talla − talla sentado, ambas introducidas)
 *   · edad cronológica EXACTA (decimal) desde la fecha de nacimiento del jugador
 *   · sexo registrado ("M" | "F"; nunca se infiere ni se asume — invariante #5)
 *
 * Si falta cualquiera ⇒ `value: null` + `gate_reason` que nombra lo que falta
 * («Falta: talla sentado, longitud de pierna»). Nunca una estimación (×0.52/×0.48),
 * nunca el entero `age` como sustituto de la fecha de nacimiento (invariante #2).
 *
 * Este módulo NO contiene fórmulas: delega en el motor existente (`mirwald.ts`,
 * `maturity.ts`, `khamisRoche.ts`) sin tocar ecuaciones, offsets ni referencias
 * (invariante #4). Solo decide QUÉ entra (excepción G6: medida sobre estimada) y si
 * lo que sale se puede presentar.
 *
 * %PAH (Khamis-Roche) es OTRA métrica: tiene su propio gate (`pahGate`) con sus
 * propias entradas completas y se rotula «% talla adulta», nunca como PHV.
 *
 * Edge-safe (solo imports relativos): importable desde api/ y src/.
 */

import { computeMirwald, canComputeMirwald, type MirwaldResult } from "./mirwald";
import { resolveMaturity, type MaturityAssessment, type MaturityTiming } from "./maturity";
import { computeKhamisRoche } from "./khamisRoche";
import { decimalAgeYears } from "../shared/age";
import { derived, gated, type MetricResult } from "../metrics/MetricResult";

// ── Entradas ────────────────────────────────────────────────────────────────

/** Entradas que exige el PHV (orden = orden en el que se listan en el gate_reason). */
export type PhvInputKey = "height" | "weight" | "sittingHeight" | "legLength" | "birthDate" | "sex" | "measuredAt";

export const PHV_INPUT_KEYS: readonly PhvInputKey[] = [
  "height",
  "weight",
  "sittingHeight",
  "legLength",
  "birthDate",
  "sex",
  "measuredAt",
];

/** Nombre canónico (es) de cada entrada, para el gate_reason servidor/LLM/PDF. */
export const PHV_INPUT_LABEL_ES: Record<PhvInputKey, string> = {
  height: "talla",
  weight: "peso",
  sittingHeight: "talla sentado",
  legLength: "longitud de pierna",
  birthDate: "fecha de nacimiento del jugador",
  sex: "sexo registrado",
  measuredAt: "fecha de la medición (registra una medición nueva)",
};

/** Clave i18n de cada entrada (la UI traduce; ver `maturity.gate.input.*`). */
export function phvInputI18nKey(key: PhvInputKey): string {
  return `maturity.gate.input.${key}`;
}

/** Subconjunto laxo de Player / fila de BD que el gate sabe leer. */
export interface PhvGateInput {
  height?: number | null;
  weight?: number | null;
  sittingHeight?: number | null;
  legLength?: number | null;
  /** Fecha de nacimiento del JUGADOR (ISO). Fuente única de la edad decimal. */
  birthDate?: string | null;
  /** Sexo registrado. Cualquier valor que no sea "M"/"F" cuenta como ausente. */
  gender?: string | null;
  /**
   * Fecha en la que se tomaron las medidas (ISO). La edad del cálculo es la de ESA fecha:
   * con la edad de hoy y una talla vieja el resultado sale sesgado. Sin ella (medidas
   * guardadas antes de registrarla) el PHV y el %PAH se bloquean pidiendo volver a guardar
   * las medidas (decisión del dueño, 21 oct 2026). Un `at` explícito tiene prioridad.
   */
  measuredAt?: string | null;
  /** Solo para %PAH (`pahGate`, Khamis-Roche); NO son entradas del PHV ni deciden su fase. */
  motherHeightCm?: number | null;
  fatherHeightCm?: number | null;
}

/** Categoría persistida (convención interna, POR ESTADO: early = pre-PHV). */
export type PhvCategory = "early" | "ontme" | "late";

/**
 * Fase PHV ÚNICA (estado en SU curva, de Mirwald). Es la MISMA respuesta que
 * `category` con otra notación: pre_phv ⇔ early, circa_phv ⇔ ontme, post_phv ⇔
 * late. `assessment.status` es siempre esta fase (inv #7: una sola respuesta). El
 * %PAH (Khamis-Roche) NO decide la fase: es otra métrica («% talla adulta»).
 */
export type PhvPhase = "pre_phv" | "circa_phv" | "post_phv";

export type PhvBlockReason = "missing_inputs" | "out_of_range";

export interface PhvGateOpen {
  ok: true;
  /** Siempre null con el gate abierto (simetría con PhvGateBlocked.reason). */
  reason: null;
  missing: PhvInputKey[];
  gate_reason: null;
  /** Edad decimal exacta en la fecha de medida (desde birthDate). */
  ageYears: number;
  legLengthCm: number;
  /** true ⇒ la pierna se obtuvo como talla − talla sentado (ambas introducidas). */
  legLengthDerived: boolean;
  mirwald: MirwaldResult;
  /**
   * Evaluación canónica (timing/factor) sobre SOLO las entradas del PHV. Su
   * `status` === `status` del gate (fase de Mirwald), nunca el estado por %PAH.
   * Sin %PAH (`percentPredictedAdultHeight` ausente): ese dato sale de `pahGate`.
   */
  assessment: MaturityAssessment;
  offset: MetricResult<number>;
  aphv: MetricResult<number>;
  /** Fase PHV única (Mirwald). Misma respuesta que `category`. */
  status: PhvPhase;
  category: PhvCategory;
}

export interface PhvGateBlocked {
  ok: false;
  reason: PhvBlockReason;
  /** Entradas que faltan (vacío si reason === "out_of_range"). */
  missing: PhvInputKey[];
  gate_reason: string;
  mirwald: null;
  assessment: null;
  offset: MetricResult<number>;
  aphv: MetricResult<number>;
  status: null;
  category: null;
}

export type PhvGate = PhvGateOpen | PhvGateBlocked;

const MIRWALD_REF = "src/lib/phv/mirwald.ts · Mirwald et al. 2002";
const OUT_OF_RANGE_ES =
  "Datos fuera del rango de validez de Mirwald (edad 8–18 años, talla y peso plausibles): no se calcula el PHV.";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function sexOf(g: unknown): "M" | "F" | null {
  return g === "M" || g === "F" ? g : null;
}

/** «Falta: talla sentado, longitud de pierna» (es). */
export function phvGateReason(missing: readonly PhvInputKey[]): string {
  return `Falta: ${missing.map((k) => PHV_INPUT_LABEL_ES[k]).join(", ")}`;
}

function blocked(reason: PhvBlockReason, missing: PhvInputKey[], gate_reason: string): PhvGateBlocked {
  return {
    ok: false,
    reason,
    missing,
    gate_reason,
    mirwald: null,
    assessment: null,
    offset: gated(gate_reason, { units: "años", source_ref: MIRWALD_REF }),
    aphv: gated(gate_reason, { units: "años", source_ref: MIRWALD_REF }),
    status: null,
    category: null,
  };
}

/** Qué entradas del PHV faltan (lista vacía ⇒ completas). */
/**
 * Fecha de las medidas: `at` explícito, o `input.measuredAt` si es una fecha válida que no
 * está en el futuro (más de un día) ni es anterior al nacimiento. Si no, null (nunca hoy por
 * defecto: invariante #2).
 */
export function measurementDateOf(input: PhvGateInput, at?: string | Date): string | Date | null {
  if (at !== undefined && at !== null) return at;
  const raw = typeof input.measuredAt === "string" ? input.measuredAt.trim() : "";
  const t = Date.parse(raw);
  if (!raw || !Number.isFinite(t)) return null;
  if (t > Date.now() + 86_400_000) return null;
  const birth = Date.parse(input.birthDate ?? "");
  if (Number.isFinite(birth) && t < birth) return null;
  return raw;
}

export function missingPhvInputs(input: PhvGateInput, at?: string | Date): PhvInputKey[] {
  const missing: PhvInputKey[] = [];
  const height = num(input.height);
  const sitting = num(input.sittingHeight);
  const leg = num(input.legLength);
  if (height === null) missing.push("height");
  if (num(input.weight) === null) missing.push("weight");
  if (sitting === null) missing.push("sittingHeight");
  // Pierna: introducida, o talla − talla sentado (ambas introducidas y coherentes).
  const derivable = height !== null && sitting !== null && height > sitting;
  if (leg === null && !derivable) missing.push("legLength");
  const when = measurementDateOf(input, at);
  if (decimalAgeYears(input.birthDate ?? null, when ?? undefined) === null) missing.push("birthDate");
  if (sexOf(input.gender) === null) missing.push("sex");
  if (when === null) missing.push("measuredAt");
  return missing;
}

/**
 * Gate del PHV. La edad decimal se calcula en la FECHA DE LA MEDIDA (`at` explícito o
 * `input.measuredAt`), nunca hoy por defecto: una medida antigua conserva su edad real.
 */
export function phvGate(input: PhvGateInput, at?: string | Date): PhvGate {
  const missing = missingPhvInputs(input, at);
  if (missing.length > 0) return blocked("missing_inputs", missing, phvGateReason(missing));

  const height = num(input.height) as number;
  const weight = num(input.weight) as number;
  const sittingHeight = num(input.sittingHeight) as number;
  const measuredLeg = num(input.legLength);
  const legLengthCm = measuredLeg ?? height - sittingHeight;
  const ageYears = decimalAgeYears(input.birthDate ?? null, measurementDateOf(input, at) as string | Date) as number;
  const sex = sexOf(input.gender) as "M" | "F";

  if (!canComputeMirwald({ age: ageYears, height, weight })) {
    return blocked("out_of_range", [], OUT_OF_RANGE_ES);
  }

  // Mirwald con las 4 medidas introducidas ⇒ estimated === false por construcción.
  const mirwald = computeMirwald({
    chronologicalAge: ageYears,
    height,
    weight,
    gender: sex,
    sittingHeight,
    legLength: legLengthCm,
  });

  // UNA sola fase (inv #7): la de Mirwald. Antes el motor recibía también las
  // alturas parentales y, con ellas, su `status` salía del %PAH (Khamis-Roche)
  // mientras `category` salía de Mirwald: el mismo jugador era «En PHV» en equipo,
  // familia y PDF y «Pre-PHV» en el Hub. El %PAH es OTRA métrica (`pahGate`).
  const status: PhvPhase =
    mirwald.phvStatus === "pre_phv" ? "pre_phv" : mirwald.phvStatus === "post_phv" ? "post_phv" : "circa_phv";
  const category: PhvCategory = status === "pre_phv" ? "early" : status === "post_phv" ? "late" : "ontme";

  // Motor canónico con SOLO las entradas del PHV (sin alturas parentales). El
  // timing sale del APHV de Mirwald en ambos métodos del motor, así que el factor
  // de ajuste no cambia. Fórmulas intactas (inv #4); se fija `status` a la fase
  // única (el motor usa los mismos umbrales ±1 sobre el mismo offset).
  const assessment: MaturityAssessment = {
    ...resolveMaturity({
      sex,
      ageYears,
      heightCm: height,
      weightKg: weight,
      sittingHeightCm: sittingHeight,
      legLengthCm,
    }),
    status,
  };

  return {
    ok: true,
    reason: null,
    missing: [],
    gate_reason: null,
    ageYears,
    legLengthCm,
    legLengthDerived: measuredLeg === null,
    mirwald,
    assessment,
    offset: derived(mirwald.offset, { units: "años", confidence: mirwald.confidence, source_ref: MIRWALD_REF }),
    aphv: derived(mirwald.ageAtPHV, { units: "años", confidence: mirwald.confidence, source_ref: MIRWALD_REF }),
    status,
    category,
  };
}

/**
 * Rótulo (es) del PHV para superficies SERVIDOR (PDF, prompts): por ESTADO en SU
 * propia curva — la categoría persistible es de estado (early = pre-PHV), NO un
 * timing vs pares (early ≠ «madurador precoz» ni «tardío»). Sin gate abierto se
 * nombra qué falta. La UI usa sus claves i18n (`maturity.status.*`, `maturity.gate.*`).
 */
export const PHV_STATUS_LABEL_ES: Record<PhvCategory, string> = {
  early: "Pre-PHV (estirón pendiente)",
  ontme: "En PHV (estirón en curso)",
  late: "Post-PHV (consolidado)",
};

export function phvLabelEs(g: PhvGate): string {
  return g.ok ? PHV_STATUS_LABEL_ES[g.category] : `PHV no disponible · ${g.gate_reason}`;
}

/** Evaluación "sin datos" con el motivo del gate (misma forma que la abstención del motor). */
export function blockedAssessment(gate_reason: string): MaturityAssessment {
  return {
    method: "insufficient_data",
    confidence: "none",
    status: "unknown",
    timing: "unknown",
    adjustmentFactor: 1,
    validityNote: gate_reason,
  };
}

/**
 * Sustituto directo de `playerMaturity()` para CUALQUIER superficie: con el gate
 * abierto devuelve la evaluación canónica; si no, una abstención cuyo
 * `validityNote` es el gate_reason. Nunca afirma estado/timing sin todas las
 * entradas introducidas.
 */
export function gatedMaturity(input: PhvGateInput, at?: string | Date): MaturityAssessment {
  const g = phvGate(input, at);
  return g.ok ? g.assessment : blockedAssessment(g.gate_reason);
}

export type { MaturityTiming };

/**
 * Filtro «Maduración» del ranking: por TIMING vs pares, lo MISMO que rotula cada
 * fila («Madurador tardío ⭐», `maturity.timing.*`), nunca por la fase/categoría.
 * `early` = pre-PHV es un ESTADO, no «tardío»: el filtro «Tardío ⭐» filtraba la
 * fase y devolvía a casi todo pre-púber mientras ocultaba a tardíos ya en PHV.
 */
export const RANKING_TIMING_FILTERS = ["late", "on_time", "early"] as const;
export type RankingTimingFilter = (typeof RANKING_TIMING_FILTERS)[number];

/**
 * ¿Pasa el filtro de timing? Sin filtro ("all"/vacío) ⇒ sí. Gate cerrado (timing
 * null) o timing «unknown» ⇒ no pasa ningún filtro. Valor desconocido ⇒ nadie.
 */
export function matchesTimingFilter(
  timing: MaturityTiming | null | undefined,
  filter: string | null | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  return (RANKING_TIMING_FILTERS as readonly string[]).includes(filter) && timing === filter;
}

/**
 * Normaliza los campos PERSISTIDOS `phvCategory`/`phvOffset` de un jugador: solo
 * sobreviven si el gate los puede recalcular desde entradas introducidas (y en
 * ese caso se sustituyen por el recálculo); si no, se eliminan. Así ningún
 * consumidor lee una categoría naive/estancada (p.ej. la de un pre-púber sin
 * medidas) como si fuera un hecho.
 */
export function sanitizePlayerPhv<T extends PhvGateInput & { phvCategory?: unknown; phvOffset?: unknown }>(
  player: T,
): T {
  const g = phvGate(player);
  if (g.ok) {
    return { ...player, phvCategory: g.category, phvOffset: g.offset.value as number };
  }
  if (player.phvCategory === undefined && player.phvOffset === undefined) return player;
  const rest = { ...player } as Record<string, unknown>;
  delete rest.phvCategory;
  delete rest.phvOffset;
  return rest as T;
}

/**
 * PHV de un SNAPSHOT congelado (p.ej. transfer_listings.player_snapshot): no hay
 * entradas para recalcular, así que solo cuenta si el SERVIDOR lo marcó
 * `phvTrusted: true` al copiarlo de players.phv_category/phv_offset (columnas que
 * solo escribe el endpoint gateado de antropometría, migración 069). Cualquier
 * snapshot antiguo o aportado por el cliente ⇒ sin PHV.
 */
export function trustedSnapshotPhv(
  snap: { phvCategory?: unknown; phvOffset?: unknown; phvTrusted?: unknown } | null | undefined,
): { phvCategory: string | null; phvOffset: number | null } {
  if (!snap || snap.phvTrusted !== true) return { phvCategory: null, phvOffset: null };
  return {
    phvCategory: typeof snap.phvCategory === "string" ? snap.phvCategory : null,
    phvOffset: typeof snap.phvOffset === "number" && Number.isFinite(snap.phvOffset) ? snap.phvOffset : null,
  };
}

// ── %PAH (Khamis-Roche) — métrica DISTINTA, rotulada «% talla adulta» ─────────

export type PahInputKey = "height" | "weight" | "motherHeight" | "fatherHeight" | "birthDate" | "sex" | "measuredAt";

export const PAH_INPUT_LABEL_ES: Record<PahInputKey, string> = {
  height: "talla",
  weight: "peso",
  motherHeight: "altura de la madre",
  fatherHeight: "altura del padre",
  birthDate: "fecha de nacimiento del jugador",
  sex: "sexo registrado",
  measuredAt: "fecha de la medición (registra una medición nueva)",
};

export interface PahGate {
  ok: boolean;
  missing: PahInputKey[];
  gate_reason: string | null;
  /** % de la talla adulta predicha ya alcanzado. */
  percent: MetricResult<number>;
  predictedAdultHeightCm: MetricResult<number>;
}

const KR_REF = "src/lib/phv/khamisRoche.ts · Khamis & Roche 1994";

export function pahGate(input: PhvGateInput, at?: string | Date): PahGate {
  const missing: PahInputKey[] = [];
  if (num(input.height) === null) missing.push("height");
  if (num(input.weight) === null) missing.push("weight");
  if (num(input.motherHeightCm) === null) missing.push("motherHeight");
  if (num(input.fatherHeightCm) === null) missing.push("fatherHeight");
  const when = measurementDateOf(input, at);
  const ageYears = decimalAgeYears(input.birthDate ?? null, when ?? undefined);
  if (ageYears === null) missing.push("birthDate");
  const sex = sexOf(input.gender);
  if (sex === null) missing.push("sex");
  if (when === null) missing.push("measuredAt");

  const block = (reason: string): PahGate => ({
    ok: false,
    missing,
    gate_reason: reason,
    percent: gated(reason, { units: "%", source_ref: KR_REF }),
    predictedAdultHeightCm: gated(reason, { units: "cm", source_ref: KR_REF }),
  });

  if (missing.length > 0) {
    return block(`Falta: ${missing.map((k) => PAH_INPUT_LABEL_ES[k]).join(", ")}`);
  }
  const kr = computeKhamisRoche({
    sex: sex as "M" | "F",
    ageYears: ageYears as number,
    heightCm: num(input.height) as number,
    weightKg: num(input.weight) as number,
    motherHeightCm: num(input.motherHeightCm) as number,
    fatherHeightCm: num(input.fatherHeightCm) as number,
  });
  if (!kr) {
    return block("Datos fuera del rango de validez de Khamis-Roche: no se calcula el % de talla adulta.");
  }
  return {
    ok: true,
    missing: [],
    gate_reason: null,
    percent: derived(kr.percentOfPredictedAdultHeight, { units: "%", source_ref: KR_REF }),
    predictedAdultHeightCm: derived(kr.predictedAdultHeightCm, { units: "cm", source_ref: KR_REF }),
  };
}

// ── Filas persistidas de player_anthropometrics (servidor y cliente) ────────

/** Marca de procedencia de la edad de una fila (migración 069). */
export const AGE_SOURCE_BIRTH_DATE = "birth_date";
export const AGE_SOURCE_INTEGER = "integer_age";

export interface AnthropometricsRowLike {
  height_cm?: number | string | null;
  weight_kg?: number | string | null;
  sitting_height_cm?: number | string | null;
  leg_length_cm?: number | string | null;
  chronological_age?: number | string | null;
  /** 'birth_date' ⇒ la edad es decimal desde la fecha de nacimiento (069). */
  age_source?: string | null;
  maturity_offset?: number | string | null;
  phv_category?: string | null;
  phv_status?: string | null;
  development_window?: string | null;
  /** Motivo persistido cuando el endpoint bloqueó el PHV al guardar (069). */
  phv_gate_reason?: string | null;
}

export const LEGACY_ROW_REASON_ES =
  "Medición registrada antes de usar la edad exacta desde la fecha de nacimiento: vuelve a guardarla para calcular el PHV.";
export const NOT_COMPUTED_ROW_REASON_ES = "El PHV no se calculó para esta medición.";

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Por qué una superficie no muestra PHV (la UI lo traduce: `maturity.gate.*`). */
export type PhvGateCode = "missing_inputs" | "out_of_range" | "legacy_row" | "not_computed" | "no_row";

export interface TrustedAnthroPhv {
  trusted: boolean;
  gate_reason: string | null;
  /** null si trusted. */
  code: PhvGateCode | null;
  /** Medidas que faltan en la fila (solo con code === "missing_inputs"). */
  missing: PhvInputKey[];
  /** Solo presentes si trusted. */
  offset: number | null;
  category: PhvCategory | null;
  /** Edad decimal de la fila (solo si trusted). */
  chronologicalAge: number | null;
}

/**
 * ¿Es fiable el PHV cacheado en una fila de player_anthropometrics? Solo si la fila
 * es COMPLETA (4 medidas introducidas), su edad salió de la fecha de nacimiento
 * (`age_source = 'birth_date'`, escrito por el endpoint gateado) y tiene offset.
 * Las filas antiguas (edad entera, `age_source` NULL) NO cuentan.
 */
export function trustAnthropometricsRow(row: AnthropometricsRowLike | null | undefined): TrustedAnthroPhv {
  const none = (reason: string, code: PhvGateCode, missing: PhvInputKey[] = []): TrustedAnthroPhv => ({
    trusted: false,
    gate_reason: reason,
    code,
    missing,
    offset: null,
    category: null,
    chronologicalAge: null,
  });
  if (!row) return none("Sin medición antropométrica registrada.", "no_row");

  const missing: PhvInputKey[] = [];
  const h = toNum(row.height_cm);
  const sh = toNum(row.sitting_height_cm);
  if (h === null) missing.push("height");
  if (toNum(row.weight_kg) === null) missing.push("weight");
  if (sh === null) missing.push("sittingHeight");
  // Misma regla que el gate: pierna introducida o talla − talla sentado.
  const legDerivable = h !== null && sh !== null && h > sh;
  if (toNum(row.leg_length_cm) === null && !legDerivable) missing.push("legLength");
  if (missing.length > 0) return none(phvGateReason(missing), "missing_inputs", missing);

  if (row.age_source !== AGE_SOURCE_BIRTH_DATE) {
    // Fila anterior a 069 (edad entera) o guardada sin fecha de nacimiento.
    return row.age_source === AGE_SOURCE_INTEGER
      ? none(row.phv_gate_reason || phvGateReason(["birthDate"]), "missing_inputs", ["birthDate"])
      : none(LEGACY_ROW_REASON_ES, "legacy_row");
  }
  const offset = toNum(row.maturity_offset);
  const cat = row.phv_category;
  const category: PhvCategory | null =
    cat === "early" || cat === "late" ? cat : cat === "ontime" || cat === "ontme" ? "ontme" : null;
  if (offset === null || category === null) {
    return none(row.phv_gate_reason || NOT_COMPUTED_ROW_REASON_ES, "not_computed");
  }
  return {
    trusted: true,
    gate_reason: null,
    code: null,
    missing: [],
    offset,
    category,
    chronologicalAge: toNum(row.chronological_age),
  };
}

/**
 * Devuelve la fila con los campos de PHV anulados si no es fiable (las medidas se
 * conservan). Para consumidores servidor que pasan la fila a agentes/prompts.
 */
export function gateAnthropometricsRow<T extends AnthropometricsRowLike>(
  row: T | null | undefined,
): (T & { phv_trusted: boolean; phv_gate_reason: string | null }) | null {
  if (!row) return null;
  const t = trustAnthropometricsRow(row);
  if (t.trusted) return { ...row, phv_trusted: true, phv_gate_reason: null };
  return {
    ...row,
    maturity_offset: null,
    phv_category: null,
    phv_status: null,
    development_window: null,
    phv_trusted: false,
    phv_gate_reason: t.gate_reason,
  };
}
