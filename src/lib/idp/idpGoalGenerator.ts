/**
 * VITAS · IDP Goal Generator (deterministic fallback)
 *
 * When the Claude `_idp-architect` agent is unavailable (no API key, offline,
 * rate limited), this generates a sensible 3-5 goal plan from the player's
 * VSI / behavioral / PHV / fatigue data using a rule-based heuristic.
 *
 * The agent's output and this generator share the SAME contract
 * (`IDPArchitectOutput`) so the rest of the pipeline doesn't care which
 * source produced the plan.
 */

import type { IDPArchitectInput, IDPArchitectOutput } from "../../agents/contracts";
import type { IDPDimension } from "./idpTypes";
import { suggestDrillIds } from "./idpDrillMatcher";

interface DimensionWeakness {
  dimension: IDPDimension;
  /** 0-100 — lower means more priority for development. */
  score: number;
  metricKey: string;
  baseline: number;
  label: string;
  unit?: string;
}

/** Compute per-dimension weakness scores, lowest-first. */
function scoreDimensions(input: IDPArchitectInput): DimensionWeakness[] {
  const items: DimensionWeakness[] = [];

  // Technical / Tactical / Physical / Mental from VSI breakdown
  if (input.vsi) {
    items.push({
      dimension: "technical",
      score: input.vsi.technical,
      metricKey: "vsi_technical",
      baseline: input.vsi.technical,
      label: "VSI Técnico",
    });
    items.push({
      dimension: "tactical",
      score: input.vsi.tactical,
      metricKey: "vsi_tactical",
      baseline: input.vsi.tactical,
      label: "VSI Táctico",
    });
    items.push({
      dimension: "physical",
      score: input.vsi.physical,
      metricKey: "vsi_physical",
      baseline: input.vsi.physical,
      label: "VSI Físico",
    });
    items.push({
      dimension: "mental",
      score: input.vsi.mental,
      metricKey: "vsi_mental",
      baseline: input.vsi.mental,
      label: "VSI Mental",
    });
  }

  // Mental enhanced by behavioral profile if available (replaces VSI mental)
  if (input.behavioralProfile?.mentalComposite != null) {
    const idx = items.findIndex((i) => i.dimension === "mental");
    if (idx >= 0) {
      items[idx] = {
        dimension: "mental",
        score: input.behavioralProfile.mentalComposite,
        metricKey: "mental_composite",
        baseline: input.behavioralProfile.mentalComposite,
        label: "Composite Mental (BPE)",
      };
    }
  }

  // Maturation only if PHV data AND a computed injury risk are present (P1 bloque 4b:
  // antes, sin riesgo, se usaba un 30 por defecto como línea base del objetivo).
  const computedRisk = input.recentFatigue?.injuryRisk;
  if (input.phv && typeof computedRisk === "number" && Number.isFinite(computedRisk)) {
    // Higher injuryRisk = more urgent maturation work
    const baseline = computedRisk;
    items.push({
      dimension: "maturation",
      // invert: high risk → low "score" (lower = more weakness = more priority)
      score: 100 - baseline,
      metricKey: "injury_risk",
      baseline,
      label: "Riesgo de Lesión (PHV)",
      unit: "%",
    });
  }

  return items.sort((a, b) => a.score - b.score);
}

/** Pick 3-5 dimensions to target this month, prioritizing weaknesses. */
function selectTargetDimensions(weaknesses: DimensionWeakness[], teamLevel?: string): DimensionWeakness[] {
  // For weak teams: focus on fundamentals (technical + physical first)
  // For elite teams: more balanced across mental + tactical
  const desired = weaknesses.length >= 5 ? 4 : Math.max(3, weaknesses.length);

  if (teamLevel === "weak" || teamLevel === "average") {
    const priorities: IDPDimension[] = ["technical", "physical", "tactical", "mental", "maturation"];
    const sorted = [...weaknesses].sort(
      (a, b) =>
        priorities.indexOf(a.dimension) - priorities.indexOf(b.dimension),
    );
    return sorted.slice(0, desired);
  }
  return weaknesses.slice(0, desired);
}

/** Build target value: nudge baseline upward by a realistic monthly delta. */
function deriveTarget(baseline: number, dimension: IDPDimension, age: number): number {
  // Monthly improvement is harder at higher baselines and for older players.
  let pctIncrease = 0.05; // 5% default
  if (baseline > 80) pctIncrease = 0.025;
  else if (baseline > 65) pctIncrease = 0.035;
  if (age >= 18) pctIncrease *= 0.8; // adults plateau faster

  // Maturation is "lower is better" (injury risk)
  if (dimension === "maturation") {
    return Math.max(5, Math.round(baseline * (1 - pctIncrease) * 10) / 10);
  }
  return Math.min(100, Math.round(baseline * (1 + pctIncrease) * 10) / 10);
}

/** Goal title templates per dimension (kept generic, agent overrides with richer copy). */
const GOAL_TITLE_TEMPLATES: Record<IDPDimension, string> = {
  technical: "Mejorar primer toque y precisión de pase",
  tactical: "Subir lectura táctica y posicionamiento",
  physical: "Aumentar capacidad aeróbica y explosividad",
  mental: "Reforzar resiliencia mental y velocidad de decisión",
  maturation: "Gestionar carga para reducir riesgo de lesión",
};

const GOAL_RATIONALE_TEMPLATES: Record<IDPDimension, string> = {
  technical:
    "El VSI técnico está por debajo del umbral de la posición. Trabajo enfocado en primer toque y pase bajo presión mejorará rendimiento global.",
  tactical:
    "Décisions tácticas en zonas presionadas son la palanca con mayor retorno este mes. Reps en rondos + juegos posicionales.",
  physical:
    "Margen claro en capacidad aeróbica vs benchmark de edad. Bloques de intervalos cortos + transiciones de alta intensidad.",
  mental:
    "El perfil conductual muestra margen en composite mental. Drills con alta carga cognitiva y feedback inmediato del coach.",
  maturation:
    "Indicadores de riesgo de lesión elevados en ventana PHV actual. Reducir volumen de alta intensidad, priorizar movilidad y recuperación.",
};

/**
 * Generate the full plan deterministically.
 */
export function generatePlanDeterministic(input: IDPArchitectInput): IDPArchitectOutput {
  const weaknesses = scoreDimensions(input);
  const targets = selectTargetDimensions(weaknesses, input.teamContext?.teamLevel);

  const goals = targets.map((w, i) => {
    const targetValue = deriveTarget(w.baseline, w.dimension, input.player.chronologicalAge);
    const suggestedDrills = suggestDrillIds({
      dimension: w.dimension,
      age: input.player.chronologicalAge,
      position: input.player.position,
      goalTitle: GOAL_TITLE_TEMPLATES[w.dimension],
      limit: 4,
      preferEasy: w.dimension === "maturation",
    });
    return {
      dimension: w.dimension,
      title: GOAL_TITLE_TEMPLATES[w.dimension],
      description: `Trabajo focalizado sobre ${w.label.toLowerCase()} durante el próximo mes con seguimiento semanal.`,
      rationale: GOAL_RATIONALE_TEMPLATES[w.dimension],
      baselineMetric: {
        metric: w.metricKey,
        value: w.baseline,
        label: w.label,
        unit: w.unit,
      },
      targetMetric: {
        metric: w.metricKey,
        value: targetValue,
        label: w.label,
        unit: w.unit,
      },
      suggestedDrills,
      // Priority weight: weakest dimension gets 5, decreasing
      weight: Math.max(1, 5 - i),
    };
  });

  const topWeakness = weaknesses[0]?.dimension ?? "technical";
  return {
    overallFocus: `Foco del mes: ${topWeakness === "technical" ? "fundamentos técnicos" : topWeakness === "tactical" ? "lectura táctica" : topWeakness === "physical" ? "base física" : topWeakness === "mental" ? "carga mental" : "gestión de maduración"}`,
    agentSummary: `Plan generado heurísticamente desde VSI/behavioral/PHV del jugador ${input.player.name}. ${goals.length} objetivos priorizados por debilidad relativa.`,
    goals,
  };
}
