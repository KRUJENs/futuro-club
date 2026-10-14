/**
 * VITAS · Utilidades de tiempo (una sola definición, inv #7).
 * Lógica pura: corre en el navegador y en Edge.
 */

/** Milisegundos de un día. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Días (redondeados) desde una fecha ISO hasta `now`; null si la fecha no es válida. */
export function daysSince(iso: string, now: number = Date.now()): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((now - t) / MS_PER_DAY);
}
