/**
 * VITAS · Señal de sesgo por EDAD RELATIVA en una plantilla (P2 bloque 8).
 *
 * Construida sobre `birthQuarter()` (src/lib/shared/relativeAge.ts), la única
 * implementación del trimestre de nacimiento (inv #7). Compara cuántos jugadores nacieron en
 * cada trimestre del año de la categoría con un reparto por igual (prueba χ² de bondad de
 * ajuste, 3 grados de libertad). Si el reparto se aleja de lo esperado y hay más nacidos al
 * principio del año que al final, es una SEÑAL de posible sesgo en la selección (efecto de
 * edad relativa): los mayores del año parecen mejores porque son mayores.
 *
 * Es una señal, nunca un veredicto: no corrige ni puntúa a ningún jugador. Confianza
 * orientativa siempre: el reparto esperado es una aproximación y el corte por defecto (año
 * natural) está «pendiente de validar» (config/relativeAge.ts). Límite conocido: en
 * categorías de 2 años el trimestre no ordena a los jugadores dentro de la categoría.
 *
 * Sin jugadores suficientes con fecha ⇒ value null + motivo (y ni el reparto se enseña: con
 * pocos niños no dice nada). Edge-safe: sin alias `@/`.
 */

import {
  RAE_CHI2_CRITICAL,
  RAE_CHI2_CRITICAL_SOURCE,
  RAE_EXPECTED_SOURCE,
  RAE_MIN_DATED_PLAYERS,
  RAE_MIN_DATED_PLAYERS_SOURCE,
} from "../../../config/relativeAge";
import {
  birthQuarter,
  CUTOFF_NOT_REGISTERED_REASON,
  INVALID_CUTOFF_REASON,
  type CategoryCutoff,
} from "./relativeAge";
import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "../metrics/MetricResult";

export const RAE_BIAS_SOURCE_REF = "src/lib/shared/relativeAgeBias.ts";

/** Nacidos por trimestre, del 1.º (los mayores del año) al 4.º (los más jóvenes). */
export type QuarterCounts = [number, number, number, number];

/** early = más nacidos al principio del año; late = al final; none = reparto compatible con el esperado. */
export type RaeDirection = "early" | "late" | "none";

export interface RaeSignal {
  counts: QuarterCounts;
  dated: number;
  chiSquare: number;
  direction: RaeDirection;
}

export type RaeGateCode = "insufficient_dated_players" | "cutoff_unavailable";

export interface SquadRelativeAge {
  /** Jugadores de la plantilla y cuántos tienen trimestre calculable (cobertura). */
  total: number;
  dated: number;
  signal: MetricResult<RaeSignal>;
  gate_code: RaeGateCode | null;
  min_dated: number;
}

export function insufficientDatedReason(dated: number, min: number): string {
  return `Pocos jugadores con fecha de nacimiento (${dated} de ${min}) para una señal de edad relativa.`;
}

export const CUTOFF_UNAVAILABLE_REASON =
  "Sin corte de categoría válido: no se calcula la señal de edad relativa.";

export function squadRelativeAge(
  birthDates: ReadonlyArray<unknown>,
  opts: { cutoff?: CategoryCutoff | null; now?: Date } = {},
): SquadRelativeAge {
  const counts: QuarterCounts = [0, 0, 0, 0];
  let dated = 0;
  let cutoffBlocked = false;
  for (const bd of birthDates) {
    const q = birthQuarter(bd, opts);
    if (q.value === null) {
      // Un corte ausente o no válido bloquea a TODOS por igual (no es falta de fecha).
      if (q.gate_reason === CUTOFF_NOT_REGISTERED_REASON || q.gate_reason === INVALID_CUTOFF_REASON) cutoffBlocked = true;
      continue;
    }
    counts[q.value - 1] += 1;
    dated += 1;
  }
  const base = { total: birthDates.length, dated, min_dated: RAE_MIN_DATED_PLAYERS };

  if (cutoffBlocked) {
    return {
      ...base,
      signal: gated<RaeSignal>(CUTOFF_UNAVAILABLE_REASON, { source_ref: RAE_BIAS_SOURCE_REF }),
      gate_code: "cutoff_unavailable",
    };
  }
  if (dated < RAE_MIN_DATED_PLAYERS) {
    return {
      ...base,
      signal: gated<RaeSignal>(insufficientDatedReason(dated, RAE_MIN_DATED_PLAYERS), {
        source_ref: `${RAE_BIAS_SOURCE_REF} · mínimo: ${RAE_MIN_DATED_PLAYERS_SOURCE}`,
      }),
      gate_code: "insufficient_dated_players",
    };
  }

  const expected = dated / counts.length;
  const chiSquare = counts.reduce((acc, o) => acc + ((o - expected) * (o - expected)) / expected, 0);
  const uneven = chiSquare >= RAE_CHI2_CRITICAL;
  const direction: RaeDirection = !uneven || counts[0] === counts[3] ? "none" : counts[0] > counts[3] ? "early" : "late";

  return {
    ...base,
    signal: derived<RaeSignal>(
      { counts, dated, chiSquare: Math.round(chiSquare * 100) / 100, direction },
      {
        confidence: ORIENTATIVE_CONFIDENCE,
        source_ref: `${RAE_BIAS_SOURCE_REF} · χ²: ${RAE_CHI2_CRITICAL_SOURCE} · esperado: ${RAE_EXPECTED_SOURCE}`,
      },
    ),
    gate_code: null,
  };
}
