/**
 * VITAS · Edad relativa: TRIMESTRE DE NACIMIENTO dentro del año de la categoría.
 *
 * ÚNICA implementación de la edad relativa (invariante #7; P1 bloque 6, punto 22). La
 * antigua (`RAEService` en advancedMetricsService.ts) se retiró junto con el «UBI» y el
 * «TruthFilter»: nadie le pasaba la fecha de nacimiento, sus pesos y correcciones
 * (0,55/0,45, +12 %, −2/+2/+5) no tenían fuente y leían la FASE PHV como si fuera el
 * ritmo de maduración. El bloque 8 (sesgo por edad relativa) se construye sobre esto.
 *
 * Es una función determinista sobre una fecha introducida por una persona ⇒ DERIVADA.
 * El trimestre es un dato, no un veredicto: no corrige ninguna evaluación.
 *
 *   Q1 = los 3 primeros meses tras el corte (los mayores del grupo) … Q4 = los 3 últimos.
 *
 * Sin fecha válida (misma regla que `toIsoBirthDate`) ⇒ value null + motivo; nunca un
 * trimestre por defecto. El mes se lee del TEXTO `YYYY-MM-DD`, no de `new Date().getMonth()`:
 * en husos horarios negativos el 1 de enero se convertiría en diciembre.
 *
 * Edge-safe: sin alias `@/`, importable desde api/ y src/.
 */

import { RELATIVE_AGE_CUTOFF_MONTH, RELATIVE_AGE_CUTOFF_SOURCE } from "../../../config/relativeAge";
import { toIsoBirthDate } from "./birthDate";
import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "../metrics/MetricResult";

export type BirthQuarter = 1 | 2 | 3 | 4;

export const RELATIVE_AGE_SOURCE_REF = "src/lib/shared/relativeAge.ts";

export const BIRTH_DATE_MISSING_REASON =
  "Falta la fecha de nacimiento del jugador (o no es una fecha válida): no se calcula el trimestre de nacimiento.";

export const INVALID_CUTOFF_REASON = "Mes de corte de la categoría no válido: no se calcula el trimestre de nacimiento.";

/**
 * Trimestre de nacimiento (1-4) respecto al mes de corte de la categoría.
 * `cutoffMonth` por defecto = `RELATIVE_AGE_CUTOFF_MONTH` (año natural, «pendiente de validar»).
 */
export function birthQuarter(
  birthDate: unknown,
  opts: { cutoffMonth?: number; now?: Date } = {},
): MetricResult<BirthQuarter> {
  const cutoff = opts.cutoffMonth ?? RELATIVE_AGE_CUTOFF_MONTH;
  if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 12) {
    return gated<BirthQuarter>(INVALID_CUTOFF_REASON, { source_ref: RELATIVE_AGE_SOURCE_REF });
  }
  const iso = toIsoBirthDate(birthDate, opts.now);
  if (iso === null) {
    return gated<BirthQuarter>(BIRTH_DATE_MISSING_REASON, { source_ref: RELATIVE_AGE_SOURCE_REF });
  }
  const month = Number(iso.slice(5, 7)); // 1-12, del texto (sin zona horaria)
  const monthsAfterCutoff = (month - cutoff + 12) % 12; // 0..11
  const quarter = (Math.floor(monthsAfterCutoff / 3) + 1) as BirthQuarter;
  return derived<BirthQuarter>(quarter, {
    // El corte no está validado por competición ⇒ confianza orientativa.
    confidence: ORIENTATIVE_CONFIDENCE,
    source_ref: `${RELATIVE_AGE_SOURCE_REF} · corte mes ${cutoff} · ${RELATIVE_AGE_CUTOFF_SOURCE}`,
  });
}
