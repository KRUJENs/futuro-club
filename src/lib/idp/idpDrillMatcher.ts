/**
 * VITAS · IDP Drill Matcher
 *
 * Maps an IDP dimension + age + position to a ranked list of drill IDs from
 * `DRILLS_LIBRARY`. Heuristic: matches `category` → dimension, filters by
 * `ageRange`, boosts by `positions`, and uses keyword overlap with the goal
 * title to refine.
 *
 * This is the deterministic fallback. When RAG ships (Sprint A-C in backlog),
 * the matcher can be replaced with a semantic search call. The signature stays
 * the same so swapping is a one-liner.
 */

import { DRILLS_LIBRARY, type DrillDocument } from "../../data/drillsLibrary";
import type { IDPDimension } from "./idpTypes";

const DIMENSION_TO_CATEGORIES: Record<IDPDimension, DrillDocument["category"][]> = {
  technical: ["tecnica"],
  tactical: ["tactica", "transicion", "pressing"],
  physical: ["fisico"],
  // Mental drills aren't a category — we surface tactical/technical drills
  // with high decision-making load (objectives mentioning "decision", "scan").
  mental: ["tactica", "tecnica"],
  // Maturation = age-appropriate load management; pick lower difficulty
  // drills regardless of category.
  maturation: ["fisico", "tecnica", "tactica"],
};

const MENTAL_KEYWORDS = [
  "decisión",
  "decision",
  "visión",
  "vision",
  "scan",
  "periférica",
  "comunicación",
  "comunicacion",
  "lectura",
  "liderazgo",
];

interface MatchedDrill {
  drill: DrillDocument;
  score: number;
  reasons: string[];
}

interface MatchOptions {
  dimension: IDPDimension;
  /** Sin edad registrada (null) no se filtra por rango de edad (P1 bloque 5d). */
  age: number | null;
  position?: string;
  /** Free-text goal title — boosts drills with overlapping keywords. */
  goalTitle?: string;
  /** Cap returned drills (default 5). */
  limit?: number;
  /** When true, prefer lower-difficulty drills (used for `maturation`). */
  preferEasy?: boolean;
}

/** Score a single drill against the matching context. */
function scoreDrill(d: DrillDocument, opts: MatchOptions): MatchedDrill | null {
  const reasons: string[] = [];
  let score = 0;

  // 1. Category fit (strongest signal)
  const validCategories = DIMENSION_TO_CATEGORIES[opts.dimension];
  if (!validCategories.includes(d.category)) return null;
  score += 30;
  reasons.push(`categoría ${d.category} encaja con ${opts.dimension}`);

  // 2. Age range
  const [minAge, maxAge] = d.ageRange;
  if (opts.age != null) {
    if (opts.age < minAge || opts.age > maxAge) return null;
    score += 15;
  }

  // 3. Position fit (optional boost, not required)
  if (opts.position) {
    const positionMatch =
      d.positions.includes(opts.position) ||
      d.positions.includes("all") ||
      d.positions.length === 0;
    if (positionMatch) {
      score += 10;
      if (d.positions.includes(opts.position)) {
        reasons.push(`específico para posición ${opts.position}`);
      }
    } else {
      score -= 5; // penalize but don't exclude
    }
  }

  // 4. Mental dimension: extra boost for drills with mental keywords
  if (opts.dimension === "mental") {
    const haystack = (
      d.description +
      " " +
      d.objectives.join(" ") +
      " " +
      d.coachingPoints.join(" ")
    ).toLowerCase();
    const hits = MENTAL_KEYWORDS.filter((k) => haystack.includes(k));
    if (hits.length > 0) {
      score += hits.length * 5;
      reasons.push(`carga mental (${hits.slice(0, 2).join(", ")})`);
    } else {
      score -= 10; // mental drills should have mental keywords
    }
  }

  // 5. Maturation / preferEasy: bias toward "basico" difficulty
  if (opts.preferEasy || opts.dimension === "maturation") {
    if (d.difficulty === "basico") score += 8;
    else if (d.difficulty === "avanzado") score -= 5;
  }

  // 6. Goal title keyword overlap (best effort)
  if (opts.goalTitle) {
    const goalWords = new Set(
      opts.goalTitle
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    const drillBag = (d.name + " " + d.description + " " + d.objectives.join(" "))
      .toLowerCase()
      .split(/\s+/);
    const overlap = drillBag.filter((w) => goalWords.has(w)).length;
    if (overlap > 0) {
      score += Math.min(overlap * 3, 15);
      reasons.push(`coincide con objetivo (${overlap} palabras clave)`);
    }
  }

  return { drill: d, score, reasons };
}

/**
 * Match drills to an IDP context. Returns top `limit` ranked by score.
 */
export function matchDrillsForGoal(opts: MatchOptions): MatchedDrill[] {
  const limit = opts.limit ?? 5;
  const scored = DRILLS_LIBRARY.map((d) => scoreDrill(d, opts)).filter(
    (x): x is MatchedDrill => x !== null,
  );
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Convenience: just the IDs (for persistence in `idp_goals.drills_assigned`).
 */
export function suggestDrillIds(opts: MatchOptions): string[] {
  return matchDrillsForGoal(opts).map((m) => m.drill.id);
}
