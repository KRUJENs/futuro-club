/**
 * VITAS · Bio-banding automático de una plantilla (P2 bloque 9; decisión del dueño D10,
 * 20 oct 2026).
 *
 * Agrupa a los jugadores por su BANDA DE MADURACIÓN según el % de la talla adulta predicha
 * (%PAH, Khamis & Roche 1994; bandas de bio-banding de Cumming et al. 2017: < 88 % pre-PHV,
 * 88–95 % en PHV, > 95 % post-PHV). Es un CONSUMIDOR: usa `pahGate` (src/lib/phv/phvGate.ts)
 * y `bandFromPercentPAH` / `PHV_BANDS` (src/lib/phv/khamisRoche.ts) tal cual; no cambia
 * ninguna fórmula, umbral ni valor de referencia (inv #4).
 *
 * Sustituye al módulo viejo `bioBanding.ts`, que agrupaba por la «edad biológica»
 * (edad + offset de Mirwald), ya retirada por no tener base, y que nadie usaba.
 *
 * Sin las alturas de los padres (o sin cualquier otra entrada del %PAH, incluido el sexo
 * REGISTRADO: un «M» sin confirmar no cuenta) el jugador queda SIN BANDA con su motivo;
 * nunca se le asigna una banda desde el offset ni por defecto (D10).
 */

import { pahGate, type PahInputKey, type PhvGateInput } from "./phvGate";
import { bandFromPercentPAH, PHV_BANDS } from "./khamisRoche";
import type { PhvStatus } from "./maturity";
import type { MetricResult } from "../metrics/MetricResult";
import { withRegisteredSex } from "../shared/registeredSex";

export type BioBandKey = Exclude<PhvStatus, "unknown">;

export const BIO_BAND_ORDER: readonly BioBandKey[] = ["pre_phv", "circa_phv", "post_phv"];

/** Umbrales de las bandas (Cumming 2017), para rotularlas sin repetir las cifras. */
export const BIO_BAND_THRESHOLDS = PHV_BANDS;

export interface BandedPlayer<T> {
  player: T;
  /** % de la talla adulta predicha (DERIVADA, Khamis-Roche). */
  percent: MetricResult<number>;
}

export interface UnbandedPlayer<T> {
  player: T;
  missing: PahInputKey[];
  /** Motivo canónico de `pahGate` (incluye «fuera del rango de validez»). */
  gate_reason: string;
}

export interface SquadBioBands<T> {
  bands: Record<BioBandKey, BandedPlayer<T>[]>;
  unbanded: UnbandedPlayer<T>[];
}

export function squadBioBands<T extends PhvGateInput & { sexConfirmedAt?: unknown }>(
  players: ReadonlyArray<T>,
  at?: string | Date,
): SquadBioBands<T> {
  const bands: Record<BioBandKey, BandedPlayer<T>[]> = { pre_phv: [], circa_phv: [], post_phv: [] };
  const unbanded: UnbandedPlayer<T>[] = [];
  for (const player of players) {
    // Sexo REGISTRADO (regla única): un «M» sin confirmar entra como ausente.
    const pah = pahGate(withRegisteredSex(player), at);
    if (!pah.ok || pah.percent.value === null) {
      unbanded.push({ player, missing: pah.missing, gate_reason: pah.gate_reason ?? "Sin % de talla adulta" });
      continue;
    }
    bands[bandFromPercentPAH(pah.percent.value)].push({ player, percent: pah.percent });
  }
  return { bands, unbanded };
}
