/**
 * PHV CACHEADO de una fila de antropometría (y de las columnas `players.phv_*`) solo si
 * cuadra con el sexo REGISTRADO del jugador (P1 bloque 7, punto 11). Las filas guardadas
 * antes de este bloque pudieron calcularse con un «M» por defecto:
 *  - sin sexo registrado (ausente o «M» sin confirmar) ⇒ su PHV no cuenta;
 *  - con sexo registrado, la fila solo cuenta si su offset guardado coincide con Mirwald
 *    calculado con ESE sexo sobre las medidas y la edad de la propia fila. Así, al
 *    confirmar «F» a quien tenía un «M» por defecto, sus filas calculadas como varón dejan
 *    de contar hasta volver a guardar la medición (no se emite ningún valor nuevo: solo
 *    se filtra; inv #4, solo decide QUÉ entra).
 * Edge-safe: sin alias `@/`.
 */
import {
  gateAnthropometricsRow,
  trustAnthropometricsRow,
  type AnthropometricsRowLike,
  type TrustedAnthroPhv,
} from "../phv/phvGate";
import { computeMirwald } from "../phv/mirwald";
import { registeredSex, sexPendingConfirmation, type RegisteredSex } from "./registeredSex";

export const SEX_PENDING_PHV_REASON =
  "Sexo por confirmar: confírmalo en «Editar jugador» y vuelve a guardar la medición.";
export const SEX_MISMATCH_PHV_REASON =
  "Medición calculada con otro sexo: vuelve a guardarla para recalcular el PHV.";

/**
 * Tolerancia (años) al comparar el offset guardado con el recalculado: el servidor lo
 * guarda redondeado a 2 decimales (api/players/anthropometrics.ts). Las fórmulas de
 * Mirwald de cada sexo difieren mucho más que esto en el rango juvenil. Procedencia:
 * redondeo del propio guardado (no es un umbral clínico).
 */
const OFFSET_TOLERANCE_YEARS = 0.05;

interface SexFields {
  gender?: unknown;
  sexConfirmedAt?: unknown;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function sexBlockReason(player: SexFields | null | undefined): string | null {
  if (registeredSex(player) !== null) return null;
  return sexPendingConfirmation(player) ? SEX_PENDING_PHV_REASON : "Falta: sexo registrado";
}

/** ¿El offset guardado en la fila es el de Mirwald con este sexo? (falla cerrado). */
export function rowComputedWithSex(row: AnthropometricsRowLike, sex: RegisteredSex): boolean {
  const h = num(row.height_cm);
  const w = num(row.weight_kg);
  const sh = num(row.sitting_height_cm);
  const age = num(row.chronological_age);
  const stored = num(row.maturity_offset);
  const leg = num(row.leg_length_cm) ?? (h !== null && sh !== null && h > sh ? h - sh : null);
  if (h === null || w === null || sh === null || age === null || stored === null || leg === null) return false;
  const r = computeMirwald({ chronologicalAge: age, height: h, weight: w, gender: sex, sittingHeight: sh, legLength: leg });
  return Math.abs(r.offset - stored) <= OFFSET_TOLERANCE_YEARS;
}

/**
 * Motivo para no usar el PHV de la fila: primero el sexo del jugador; después, SOLO si el
 * gate de siempre ya la daba por fiable, que se calculara con ese sexo (así una fila
 * antigua o incompleta conserva su propio motivo).
 */
function rowBlockReason(
  row: AnthropometricsRowLike | null | undefined,
  player: SexFields | null | undefined,
  baseTrusted: boolean,
): string | null {
  const sexReason = sexBlockReason(player);
  if (sexReason !== null) return sexReason;
  if (!baseTrusted || !row) return null;
  return rowComputedWithSex(row, registeredSex(player) as RegisteredSex) ? null : SEX_MISMATCH_PHV_REASON;
}

/**
 * Resultado con un código propio para «calculada con otro sexo»: la UI lo rotula con su
 * solución («vuelve a guardar la medición»), no como «falta el sexo» (que ya está).
 */
export type SexAwareAnthroTrust = Omit<TrustedAnthroPhv, "code"> & {
  code: TrustedAnthroPhv["code"] | "sex_mismatch";
};

/** `trustAnthropometricsRow` + sexo registrado del jugador (blob `data`). */
export function trustAnthroForPlayer(
  row: AnthropometricsRowLike | null | undefined,
  player: SexFields | null | undefined,
): SexAwareAnthroTrust {
  const base = trustAnthropometricsRow(row);
  const reason = rowBlockReason(row, player, base.trusted);
  if (reason === null) return base;
  const mismatch = reason === SEX_MISMATCH_PHV_REASON;
  return {
    trusted: false,
    gate_reason: reason,
    code: mismatch ? "sex_mismatch" : "missing_inputs",
    missing: mismatch ? [] : ["sex"],
    offset: null,
    category: null,
    chronologicalAge: null,
  };
}

/** `gateAnthropometricsRow` + sexo registrado del jugador (blob `data`). */
export function gateAnthroForPlayer<T extends AnthropometricsRowLike>(
  row: T | null | undefined,
  player: SexFields | null | undefined,
): ReturnType<typeof gateAnthropometricsRow<T>> {
  const gated = gateAnthropometricsRow(row);
  const reason = rowBlockReason(row, player, gated?.phv_trusted === true);
  if (!gated || reason === null) return gated;
  return {
    ...gated,
    maturity_offset: null,
    phv_category: null,
    phv_status: null,
    development_window: null,
    phv_trusted: false,
    phv_gate_reason: reason,
  };
}

/**
 * Columnas `players.phv_category` / `phv_offset` (caché que escribe el endpoint de
 * antropometría): sin sexo registrado ⇒ null. El caso «sexo confirmado DESPUÉS de
 * calcular la columna» lo cierra la 078 (sin fecha de cálculo en la columna).
 */
export function phvColumnsForPlayer<R extends SexFields & { phv_category?: unknown; phv_offset?: unknown }>(
  row: R,
): Omit<R, "gender" | "sexConfirmedAt"> {
  // Los campos de sexo solo se seleccionan para decidir; no viajan a prompts ni respuestas.
  const { gender: _g, sexConfirmedAt: _s, ...rest } = row;
  if (registeredSex(row) !== null) return rest;
  return { ...rest, phv_category: null, phv_offset: null } as Omit<R, "gender" | "sexConfirmedAt">;
}

/** Campos del blob que hace falta seleccionar junto a las columnas `phv_*`. */
export const PLAYER_SEX_SELECT = "gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt";
