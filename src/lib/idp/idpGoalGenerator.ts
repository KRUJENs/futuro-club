/**
 * VITAS · IDP Goal Generator (deterministic fallback)
 *
 * When the Claude `_idp-architect` agent is unavailable (no API key, offline,
 * rate limited), this generates a 1-4 goal plan (only dimensions with data) from the player's
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

  // Technical / Tactical / Physical / Mental: SOLO las dimensiones con dato (P1 bloque
  // 5d). Antes, sin vídeo, llegaban todas con la evaluación del entrenador copiada y
  // se fijaban metas sobre un nivel que nadie había medido en esa dimensión.
  const fromVsi: Array<{ dimension: IDPDimension; value: number | null | undefined; metricKey: string; label: string }> = [
    { dimension: "technical", value: input.vsi?.technical, metricKey: "vsi_technical", label: "VSI Técnico" },
    { dimension: "tactical", value: input.vsi?.tactical, metricKey: "vsi_tactical", label: "VSI Táctico" },
    { dimension: "physical", value: input.vsi?.physical, metricKey: "vsi_physical", label: "VSI Físico" },
    { dimension: "mental", value: input.vsi?.mental, metricKey: "vsi_mental", label: "VSI Mental" },
  ];
  for (const d of fromVsi) {
    if (typeof d.value === "number" && Number.isFinite(d.value)) {
      items.push({ dimension: d.dimension, score: d.value, metricKey: d.metricKey, baseline: d.value, label: d.label });
    }
  }

  // Mental enhanced by behavioral profile if available (replaces VSI mental)
  if (input.behavioralProfile?.mentalComposite != null) {
    const bpe: DimensionWeakness = {
      dimension: "mental",
      score: input.behavioralProfile.mentalComposite,
      metricKey: "mental_composite",
      baseline: input.behavioralProfile.mentalComposite,
      label: "Composite Mental (BPE)",
    };
    const idx = items.findIndex((i) => i.dimension === "mental");
    if (idx >= 0) items[idx] = bpe;
    else items.push(bpe);
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

/** Pick up to 4 dimensions (of those with data) to target this month, prioritizing weaknesses. */
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
function deriveTarget(baseline: number, dimension: IDPDimension, age: number | null): number {
  // Monthly improvement is harder at higher baselines and for older players.
  let pctIncrease = 0.05; // 5% default
  if (baseline > 80) pctIncrease = 0.025;
  else if (baseline > 65) pctIncrease = 0.035;
  if (age != null && age >= 18) pctIncrease *= 0.8; // adults plateau faster (sin edad: sin ajuste)

  // Maturation is "lower is better" (injury risk). Nunca por encima de la baseline: con
  // un riesgo ya por debajo del suelo de 5, la meta subía el riesgo (revisión del #320).
  if (dimension === "maturation") {
    return Math.min(baseline, Math.max(5, Math.round(baseline * (1 - pctIncrease) * 10) / 10));
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

// Sin afirmaciones que el plan no calcula (revisión del #320: decían «por debajo del umbral
// de la posición», «vs benchmark de edad» o «riesgo elevado» sin compararlo con nada).
const GOAL_RATIONALE_TEMPLATES: Record<IDPDimension, string> = {
  technical:
    "Meta sobre el nivel técnico disponible. Trabajo enfocado en primer toque y pase bajo presión.",
  tactical:
    "Meta sobre el nivel táctico disponible. Rondos y juegos posicionales para decidir en zonas presionadas.",
  physical:
    "Meta sobre el nivel físico disponible. Intervalos cortos y transiciones, con la carga adaptada a la edad.",
  mental:
    "Meta sobre el nivel mental disponible. Drills con alta carga cognitiva y feedback inmediato del coach.",
  maturation:
    "Meta sobre el riesgo de lesión calculado en la ventana PHV. Controlar el volumen de alta intensidad, priorizar movilidad y recuperación.",
};

/** Dimensión con dato REAL: su métrica y su valor (la baseline de cualquier meta). */
export interface IDPDimensionBaseline {
  dimension: IDPDimension;
  metricKey: string;
  baseline: number;
}

/**
 * Dimensiones con dato REAL (las únicas en las que se pueden fijar metas), con su métrica
 * y su valor: técnica/táctica/física/mental con su valor, mental también desde el perfil
 * conductual, y maduración solo con PHV y un riesgo de lesión calculado. Una sola
 * definición: la usan el generador, el prompt del agente y los endpoints (P1 bloque 5d,
 * revisión del #320).
 */
export function idpDimensionBaselines(input: IDPArchitectInput): IDPDimensionBaseline[] {
  return scoreDimensions(input).map((d) => ({ dimension: d.dimension, metricKey: d.metricKey, baseline: d.baseline }));
}

export function idpDimensionsWithData(input: IDPArchitectInput): IDPDimension[] {
  return idpDimensionBaselines(input).map((d) => d.dimension);
}

type AgentMetric = { metric?: unknown; value?: unknown };

/**
 * Metas del agente que se pueden aceptar: de una dimensión CON dato, una sola por
 * dimensión, con la métrica de esa dimensión (baseline y target) y la línea base del dato
 * de entrada (±0,5 por redondeo), y con el target en la dirección de mejora (menos riesgo
 * en maduración; en el resto, no por debajo de la baseline). La baseline aceptada se FIJA
 * al valor real. El modelo puede inventar metas de dimensiones sin dato, repetir
 * dimensiones, cambiar de métrica o de baseline (revisión del #320). Los endpoints, si se
 * descarta ALGUNA, usan el plan determinista completo: el foco y los textos del modelo
 * podrían hablar de lo descartado.
 */
export function keepGoalsWithData<G extends { dimension?: unknown; baselineMetric?: AgentMetric; targetMetric?: AgentMetric }>(
  input: IDPArchitectInput,
  goals: G[],
): G[] {
  const truth = new Map<string, IDPDimensionBaseline>(idpDimensionBaselines(input).map((d) => [d.dimension, d]));
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const used = new Set<string>();
  const kept: G[] = [];
  for (const g of goals) {
    const t = typeof g.dimension === "string" ? truth.get(g.dimension) : undefined;
    if (!t || used.has(t.dimension)) continue;
    const b = g.baselineMetric;
    const target = g.targetMetric?.value;
    if (b?.metric !== t.metricKey || g.targetMetric?.metric !== t.metricKey) continue;
    if (!isNum(b.value) || Math.abs(b.value - t.baseline) > 0.5 || !isNum(target)) continue;
    if (t.dimension === "maturation" ? target > t.baseline : target < t.baseline) continue;
    used.add(t.dimension);
    kept.push({ ...g, baselineMetric: { ...b, value: t.baseline } });
  }
  return kept;
}

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

  // Sin ninguna dimensión con dato no hay foco (antes «fundamentos técnicos» por defecto).
  // Los endpoints no llegan aquí en ese caso (422 idp_no_dimension_data).
  const topWeakness = weaknesses[0]?.dimension ?? null;
  return {
    overallFocus: topWeakness === null
      ? "Sin datos por dimensión: no hay foco del mes."
      : `Foco del mes: ${topWeakness === "technical" ? "fundamentos técnicos" : topWeakness === "tactical" ? "lectura táctica" : topWeakness === "physical" ? "base física" : topWeakness === "mental" ? "carga mental" : "gestión de maduración"}`,
    agentSummary: `Plan generado heurísticamente desde VSI/behavioral/PHV del jugador ${input.player.name}. ${goals.length} objetivos priorizados por debilidad relativa.`,
    goals,
  };
}
