/**
 * VITAS · Vocabulario ÚNICO de los filtros de Rankings (inv #7): lo usan la pantalla de
 * Rankings, la ruta /api/rankings/list y la búsqueda en lenguaje natural (P2 bloque 11),
 * que solo puede devolver valores de esta lista (nada fuera de ella es un filtro válido).
 * Antes la pantalla y el servidor repetían cada uno su lista. Edge-safe: sin alias `@/`.
 */

export const RANKING_POSITIONS = [
  "Portero",
  "Defensa Central",
  "Lateral Derecho",
  "Lateral Izquierdo",
  "Pivote",
  "Mediocentro",
  "Mediapunta",
  "Extremo Derecho",
  "Extremo Izquierdo",
  "Delantero Centro",
  "Segundo Delantero",
] as const;
export type RankingPosition = (typeof RANKING_POSITIONS)[number];

/** Grupos de edad: etiqueta → [edad mínima, edad máxima] (años enteros, ambos incluidos). */
export const RANKING_AGE_GROUPS: Record<string, readonly [number, number]> = {
  "Sub-10": [8, 10],
  "Sub-12": [11, 12],
  "Sub-14": [13, 14],
  "Sub-16": [15, 16],
  "Sub-18": [17, 18],
  "Sub-21": [19, 21],
};
export const RANKING_AGE_GROUP_LABELS = Object.keys(RANKING_AGE_GROUPS);

/**
 * Grupo de edad de un jugador. Sin edad numérica, o fuera de todos los grupos ⇒ null:
 * nunca una edad por defecto (antes 15 ⇒ «Sub-16») ni el último grupo (antes «Sub-21»
 * para cualquiera fuera de 8-21 años). Invariante #2.
 */
export function rankingAgeGroup(age: unknown): string | null {
  if (typeof age !== "number" || !Number.isFinite(age)) return null;
  for (const [label, [min, max]] of Object.entries(RANKING_AGE_GROUPS)) {
    if (age >= min && age <= max) return label;
  }
  return null;
}

/** Pie dominante tal como lo guarda la ficha (`Player.foot`). */
export const RANKING_FEET = ["left", "right", "both"] as const;
export type RankingFoot = (typeof RANKING_FEET)[number];
