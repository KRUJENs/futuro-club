/**
 * VITAS · Búsqueda en lenguaje natural sobre Rankings (P2 bloque 11; decisión del dueño:
 * «IA → filtros + datos»).
 *
 * Un modelo rápido SOLO traduce la frase («lateral zurdo tardío, U14») a filtros del
 * vocabulario cerrado de Rankings (src/lib/shared/rankingVocab.ts + timing de
 * phvGate.ts). El modelo nunca devuelve jugadores ni cifras: la lista sale del filtrado de
 * siempre sobre los jugadores REALES del usuario, y si nadie cumple todo, la pantalla se
 * abstiene. Lo que el modelo devuelva fuera del vocabulario se descarta y se enseña como
 * «no entendido» (nunca se convierte en el valor «más parecido»).
 * La interpretación es ESTIMADA_LLM y se rotula como tal. Edge-safe: sin alias `@/`.
 */

import {
  RANKING_AGE_GROUP_LABELS,
  RANKING_FEET,
  RANKING_POSITIONS,
  type RankingFoot,
  type RankingPosition,
} from "../shared/rankingVocab";
import { RANKING_TIMING_FILTERS, type RankingTimingFilter } from "../phv/phvGate";

export interface NlRankingFilters {
  position?: RankingPosition;
  foot?: RankingFoot;
  timing?: RankingTimingFilter;
  ageGroup?: string;
}

export interface NlParseResult {
  filters: NlRankingFilters;
  /** Trozos de la frase (o valores del modelo) que no encajan en ningún filtro. */
  not_understood: string[];
}

export const NL_QUERY_MAX_CHARS = 200;

export function nlFilterSystemPrompt(): string {
  return [
    "Traduces una búsqueda de jugadores de fútbol base a FILTROS. No inventes nada.",
    "Responde SOLO un objeto JSON con estas claves (null si la frase no lo dice):",
    `- "position": uno de ${JSON.stringify(RANKING_POSITIONS)}`,
    `- "foot": uno de ${JSON.stringify(RANKING_FEET)} (zurdo = "left", diestro = "right", ambidiestro = "both")`,
    `- "timing": uno de ${JSON.stringify(RANKING_TIMING_FILTERS)} (madurador tardío = "late", a tiempo = "on_time", precoz = "early"; es el ritmo de maduración frente a sus pares, NO la fase PHV)`,
    `- "ageGroup": uno de ${JSON.stringify(RANKING_AGE_GROUP_LABELS)} (U14 = "Sub-14", etc.)`,
    '- "not_understood": lista de los trozos de la frase que no encajan en ninguna clave (nombres, cifras, cualidades como «rápido», niveles…).',
    "Si un valor no está EXACTAMENTE en su lista, pon null y añade el trozo a not_understood.",
    "«lateral zurdo» = position \"Lateral Izquierdo\" y foot \"left\". No deduzcas nada que la frase no diga.",
  ].join("\n");
}

function pick<T extends string>(value: unknown, allowed: readonly T[], miss: string[]): T | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  miss.push(String(value));
  return undefined;
}

/** Valida la respuesta del modelo contra el vocabulario cerrado. null = no es JSON válido. */
export function parseNlFilterJson(text: string): NlParseResult | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const miss: string[] = [];
  const filters: NlRankingFilters = {};
  const position = pick(raw.position, RANKING_POSITIONS, miss);
  const foot = pick(raw.foot, RANKING_FEET, miss);
  const timing = pick(raw.timing, RANKING_TIMING_FILTERS, miss);
  const ageGroup = pick(raw.ageGroup, RANKING_AGE_GROUP_LABELS, miss);
  if (position) filters.position = position;
  if (foot) filters.foot = foot;
  if (timing) filters.timing = timing;
  if (ageGroup) filters.ageGroup = ageGroup;
  const extra = Array.isArray(raw.not_understood)
    ? raw.not_understood.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.slice(0, 80))
    : [];
  return { filters, not_understood: [...extra, ...miss].slice(0, 10) };
}
