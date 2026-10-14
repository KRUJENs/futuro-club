/**
 * VITAS · Estadísticas de VSI honestas (invariante #2 · capa API)
 *
 * El VSI de FICHA ausente es NULL ("sin evaluar"), NO 0. Un hueco no promedia
 * como cero ni ordena como cero. Estas funciones son la ÚNICA implementación
 * del promedio/orden/recuento de VSI sobre listas de jugadores en la capa de
 * endpoints (invariante #7 · "una sola implementación por concepto").
 *
 * Reflejan lo que ya hacen la RPC `get_ranked_players` (migración 059) y
 * `computeDashboardStats` (src/services/real/adapters.ts): la MEDIA se calcula
 * solo sobre jugadores evaluados; el CONTEO del equipo incluye a todos.
 *
 * Antes: `Number(p.vsi || 0)` coaccionaba el hueco a 0 y lo metía —fabricado—
 * en la media, bajándola con jugadores nunca evaluados.
 */

import { coachEvalTier } from "../../src/services/real/metricsService";
import { COACH_EVAL_TIERS } from "../../config/coachEvaluation";

/** VSI tal como llega de supabase: `numeric` puede venir como number o string. */
export type RawVsi = number | string | null | undefined;

/**
 * Coacciona el VSI crudo a número, o `null` si está ausente/no es numérico.
 * NUNCA devuelve 0 para un hueco (eso es lo que corrige el invariante #2).
 */
export function toVsi(raw: RawVsi): number | null {
  if (raw === null || raw === undefined) return null;
  // Un string vacío/en blanco es "ausente", NO 0: Number("") === 0 fabricaría
  // un cero de un hueco (justo lo que prohíbe el invariante #2).
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `true` si el jugador tiene un VSI de ficha real (evaluado). */
export function isEvaluated(p: { vsi: RawVsi }): boolean {
  return toVsi(p.vsi) !== null;
}

/**
 * Media de VSI SOLO sobre jugadores evaluados (vsi != null).
 * Sin ninguno evaluado ⇒ `null` ("—"/"sin evaluar" en UI), nunca 0.
 * @param decimals decimales de redondeo (default 1)
 */
export function avgEvaluatedVsi(
  players: ReadonlyArray<{ vsi: RawVsi }>,
  decimals = 1,
): number | null {
  let sum = 0;
  let count = 0;
  for (const p of players) {
    const v = toVsi(p.vsi);
    if (v !== null) {
      sum += v;
      count += 1;
    }
  }
  if (count === 0) return null;
  const f = 10 ** decimals;
  return Math.round((sum / count) * f) / f;
}

/**
 * Nº de jugadores en el tramo «Élite» de la evaluación del entrenador: los cortes
 * ÚNICOS de coachEvalTier (config/coachEvaluation.ts; P1 bloque 5b — antes aquí
 * «élite» era ≥70 y en la ficha ≥85). Un jugador SIN evaluar NO es élite (se excluye;
 * no se cuenta como 0 ni infla denominadores).
 */
export function countElite(players: ReadonlyArray<{ vsi: RawVsi }>): number {
  let n = 0;
  for (const p of players) {
    const v = toVsi(p.vsi);
    if (v !== null && coachEvalTier(v) === "elite") n += 1;
  }
  return n;
}

/** Mínimo del tramo «Élite» (para rotularlo en textos: «≥85»). */
export const ELITE_MIN = COACH_EVAL_TIERS[0].min;

/**
 * Comparador para ordenar por VSI descendente con los NO evaluados (null)
 * SIEMPRE al final. No tratar null como 0: quedaría intercalado entre los
 * VSIs bajos reales, falseando el ranking.
 */
export function byVsiDescNullsLast(a: { vsi: RawVsi }, b: { vsi: RawVsi }): number {
  const av = toVsi(a.vsi);
  const bv = toVsi(b.vsi);
  if (av === null && bv === null) return 0;
  if (av === null) return 1; // a va después
  if (bv === null) return -1; // b va después
  return bv - av; // ambos evaluados: descendente
}

/**
 * Etiqueta de VSI para listados por jugador: número redondeado, o "—" si el
 * jugador está sin evaluar. Nunca "0" para un hueco.
 * @param decimals decimales (default 0)
 */
export function formatVsi(raw: RawVsi, decimals = 0): string {
  const v = toVsi(raw);
  return v === null ? "—" : v.toFixed(decimals);
}
