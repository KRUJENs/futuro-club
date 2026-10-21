/**
 * VITAS · Fecha de las medidas del blob del jugador (`measuredAt`). El PHV y el %PAH calculan
 * con la edad de ESA fecha (src/lib/phv/phvGate.ts); sin ella se bloquean pidiendo registrar
 * una medición nueva (decisión del dueño, 21 oct 2026).
 *
 * Regla única de cuándo cambia al guardar la ficha: ahora si alguna de las 4 medidas cambia o
 * se da por primera vez; si no, la que ya tenía. Re-guardar la ficha sin tocar las medidas NO
 * las «fecha hoy» (una talla vieja con la edad de hoy sesga el cálculo). Edge-safe.
 */

type Measures = { height?: number; weight?: number; sittingHeight?: number; legLength?: number };

const KEYS = ["height", "weight", "sittingHeight", "legLength"] as const;

function norm(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function measuredAtFor(
  data: Measures,
  previous?: Measures & { measuredAt?: string },
  now: Date = new Date(),
): string | undefined {
  if (!KEYS.some((k) => norm(data[k]) !== null)) return previous?.measuredAt;
  const changed = !previous || KEYS.some((k) => norm(data[k]) !== norm(previous[k]));
  return changed ? now.toISOString() : previous.measuredAt;
}
