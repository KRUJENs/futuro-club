/**
 * VITAS · Fila de fatigue_sessions para AGENTES (P1 bloque 4b)
 *
 * El orquestador leía la sesión con `select("*")` y la mandaba entera a todos los
 * agentes: severidad, zona ACWR y alertas calculadas con unos umbrales que, sin la
 * maduración registrada, no corresponden al jugador (y el informe de lesión la
 * metía tal cual en su prompt). Sin maduración conocida se quitan esas
 * clasificaciones; la carga, la duración, la distancia, el ratio y los campos de
 * maduración se conservan (el informe de fatiga los usa para abstenerse).
 * Mismo predicado que el resto del bloque 4 (`maturationKnown`, inv #7).
 */
import { maturationKnown } from "./phvFatigueAdjuster";

export type FatigueRow = Record<string, unknown>;

export function fatigueRowForAgents(row: FatigueRow | null | undefined): FatigueRow | null {
  if (!row || typeof row !== "object") return null;
  if (maturationKnown(row.maturation_band, row.phv_offset)) return row;
  return {
    ...row,
    fatigue_index: null,
    fatigue_severity: null,
    acwr_zone: null,
    alerts: null,
    _maturation_gate: true,
  };
}
