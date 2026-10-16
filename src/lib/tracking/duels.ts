/**
 * VITAS · Duelos — ÚNICA ruta del concepto `eventos.duelos` (P1 bloque 6, punto 3; inv #7).
 *
 * Hoy NO hay ningún criterio defendible ni para DETECTAR un duelo ni para decidir quién
 * lo GANA, así que la métrica queda BLOQUEADA siempre (value null + gate_reason):
 *  - las detecciones por proximidad que había (poseAnalyzer ≤ 1,8 m; motor de eventos
 *    < 2 m acercándose) no separaban equipos —contaban pares de COMPAÑEROS— y el motor
 *    disparaba un evento por fotograma mientras dos jugadores se acercaban;
 *  - el ganador nunca se resolvía (pose) o se inventaba («gana el más rápido», y además
 *    puntuaba al jugador enfocado con el resultado del rival cuando era el receptor);
 *  - la estimación del modelo de vídeo (Gemini) traía en el propio prompt el ejemplo
 *    «3 ganados / 1 perdido», y el ensayo del 29 sep mostró que inventa eventos;
 *  - `fixtures/golden/README.md` prohíbe inferir un duelo con un criterio inventado sin
 *    la anotación humana `fixtures/golden/duelos_gt.csv` (hoy solo existe la plantilla).
 *
 * Se desbloquea cuando exista esa anotación y un criterio acordado (tarea del dueño T1),
 * construido AQUÍ y validado contra ella. El etiquetado MANUAL en directo (`api/live/*`,
 * lo marca el entrenador) es otro concepto y no pasa por aquí.
 *
 * Edge-safe: sin alias `@/`, importable desde api/ y src/.
 */

import { gated, type MetricResult } from "../metrics/MetricResult";

export const DUELS_SOURCE_REF = "src/lib/tracking/duels.ts";

export const DUELS_GATE_REASON =
  "Duelos no disponibles: no hay un criterio validado de qué es un duelo ni de quién lo gana " +
  "(falta la anotación humana fixtures/golden/duelos_gt.csv). No se infieren por proximidad.";

/** La métrica de duelos: hoy siempre bloqueada con su motivo. */
export function duelsMetric(): MetricResult<number> {
  return gated<number>(DUELS_GATE_REASON, { source_ref: DUELS_SOURCE_REF });
}

/**
 * Claves con cifras de duelos que pueden llegar de clientes antiguos (PWA en caché), de
 * filas ya guardadas o del modelo de vídeo. Ninguna se acepta ni se reenvía.
 */
export const DUEL_OUTCOME_KEYS: readonly string[] = [
  "duelsWon", "duelsLost", "duelCount", "duelEvents",
  "duels_won", "duels_lost", "duel_count", "duel_events",
  "duelosGanados", "duelosPerdidos",
];

const DUEL_KEY_SET = new Set(DUEL_OUTCOME_KEYS);
const MAX_DEPTH = 8;

/**
 * Saneador ÚNICO: devuelve una copia sin ninguna clave de `DUEL_OUTCOME_KEYS` a cualquier
 * profundidad (objetos y arrays planos). No muta la entrada. Lo usan el servidor al
 * escribir y al leer, y el cliente con datos guardados antes del bloque 6.
 */
export function stripDuelOutcomes<T>(input: T): T {
  return strip(input, 0) as T;
}

function strip(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Map, Date, typed arrays…
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (DUEL_KEY_SET.has(k)) continue;
    out[k] = strip(val, depth + 1);
  }
  return out;
}
