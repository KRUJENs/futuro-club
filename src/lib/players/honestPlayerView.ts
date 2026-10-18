/**
 * Vista honesta de un jugador para todo el cliente (P1 bloque 7, punto 11): primero el
 * sexo registrado (un «M» sin confirmar no entra al cálculo; src/lib/shared/registeredSex.ts)
 * y después el PHV persistido, que solo sobrevive si el gate único lo recalcula
 * (sanitizePlayerPhv). La aplican los 3 embudos de lectura: PlayerService.getAll,
 * useRawPlayerById y adaptPlayerForUI.
 */
import { sanitizePlayerPhv, type PhvGateInput } from "@/lib/phv/phvGate";
import { withRegisteredSex } from "@/lib/shared/registeredSex";

export function honestPlayerView<
  T extends PhvGateInput & { phvCategory?: unknown; phvOffset?: unknown; sexConfirmedAt?: unknown },
>(player: T): T & { sexPendingConfirmation?: true } {
  return sanitizePlayerPhv(withRegisteredSex(player));
}
