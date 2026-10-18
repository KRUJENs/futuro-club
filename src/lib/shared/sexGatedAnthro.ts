/**
 * PHV CACHEADO de una fila de antropometría solo si el sexo del jugador está registrado
 * (P1 bloque 7, punto 11). Las filas guardadas antes de este bloque pudieron calcularse
 * con un «M» por defecto: sin sexo registrado (ausente o «M» sin confirmar) su PHV no
 * llega a agentes, informes, planes ni anuncios. La migración 078 los anula en BD; esto
 * cubre también el tiempo entre el despliegue y la 078. Solo decide QUÉ entra (inv #4).
 * Edge-safe: sin alias `@/`.
 */
import {
  gateAnthropometricsRow,
  trustAnthropometricsRow,
  type AnthropometricsRowLike,
  type TrustedAnthroPhv,
} from "../phv/phvGate";
import { registeredSex, sexPendingConfirmation } from "./registeredSex";

export const SEX_PENDING_PHV_REASON =
  "Sexo por confirmar: confírmalo en la ficha del jugador y vuelve a guardar la medición.";

interface SexFields {
  gender?: unknown;
  sexConfirmedAt?: unknown;
}

function sexBlockReason(player: SexFields | null | undefined): string | null {
  if (registeredSex(player) !== null) return null;
  return sexPendingConfirmation(player) ? SEX_PENDING_PHV_REASON : "Falta: sexo registrado";
}

/** `trustAnthropometricsRow` + sexo registrado del jugador (blob `data`). */
export function trustAnthroForPlayer(
  row: AnthropometricsRowLike | null | undefined,
  player: SexFields | null | undefined,
): TrustedAnthroPhv {
  const reason = sexBlockReason(player);
  if (reason === null) return trustAnthropometricsRow(row);
  return {
    trusted: false,
    gate_reason: reason,
    code: "missing_inputs",
    missing: ["sex"],
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
  const reason = sexBlockReason(player);
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
