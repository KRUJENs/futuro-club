/**
 * VITAS · Deterministic Agent Fallbacks
 * Pure TypeScript implementations of agent logic for when LLMs are unavailable.
 * Each function returns the SAME schema as the Claude-powered agent.
 * Confidence is always lower to indicate approximate results.
 */

import { fallbackStrings } from "./fallbackStrings";

type FallbackReason = "no_api_key" | "claude_error" | "parse_error";

// ─── PHV Calculator ─────────────────────────────────────────────────────────
// `phvFallback()` RETIRADO (regla del owner 28-sep · invariantes #2/#5/#7): era
// una 4ª copia de Mirwald (solo masculina, sin gate de sexo) que ESTIMABA talla
// sentado/pierna (×0.52/×0.48), rellenaba talla/peso (155/45) y VSI (70) por
// defecto y aplicaba ×1.12 / ×0.92 por la categoría de ESTADO. No tenía caller en
// producción. El PHV no usa LLM: el cálculo vivo es api/agents/_phv-calculator.ts,
// gateado por src/lib/phv/phvGate.ts; sin todas las entradas introducidas se
// bloquea con motivo, no se «aproxima».

// ─── Role Profile (Rule-based) ──────────────────────────────────────────────

interface RoleProfileInput {
  player: {
    id?: string;
    name: string;
    age?: number;
    foot?: string;
    position?: string;
    minutesPlayed?: number;
    competitiveLevel?: string;
    metrics?: Record<string, number>;
    phvCategory?: string;
    phvOffset?: number;
  };
  locale?: string;
}

export function roleProfileFallback(body: RoleProfileInput, reason: FallbackReason) {
  const p = body.player;
  const S = fallbackStrings(body.locale);
  const m = p.metrics ?? { speed: 60, technique: 60, vision: 60, stamina: 60, shooting: 60, defending: 60 };
  const speed = m.speed ?? 60;
  const technique = m.technique ?? 60;
  const vision = m.vision ?? 60;
  const stamina = m.stamina ?? 60;
  const shooting = m.shooting ?? 60;
  const defending = m.defending ?? 60;

  // Identity rules from prompt
  let dominantIdentity: "ofensivo" | "defensivo" | "tecnico" | "fisico" | "mixto";
  const sorted = [
    { k: "speed", v: speed }, { k: "technique", v: technique },
    { k: "vision", v: vision }, { k: "stamina", v: stamina },
    { k: "shooting", v: shooting }, { k: "defending", v: defending },
  ].sort((a, b) => b.v - a.v);

  const top2 = new Set([sorted[0].k, sorted[1].k]);
  const top4Diff = sorted[0].v - sorted[3].v;

  if (top4Diff < 10) dominantIdentity = "mixto";
  else if (top2.has("speed") && top2.has("stamina")) dominantIdentity = "fisico";
  else if (top2.has("technique") && top2.has("vision")) dominantIdentity = "tecnico";
  else if (top2.has("shooting") && top2.has("speed")) dominantIdentity = "ofensivo";
  else if (top2.has("defending") && top2.has("stamina")) dominantIdentity = "defensivo";
  else dominantIdentity = "mixto";

  // Identity distribution (must sum to 1.0)
  const rawDist = {
    ofensivo: (shooting + speed) / 2,
    defensivo: (defending + stamina) / 2,
    tecnico: (technique + vision) / 2,
    fisico: (speed + stamina) / 2,
    mixto: 0,
  };
  const total = rawDist.ofensivo + rawDist.defensivo + rawDist.tecnico + rawDist.fisico;
  const identityDistribution = {
    ofensivo: Math.round((rawDist.ofensivo / total) * 100) / 100,
    defensivo: Math.round((rawDist.defensivo / total) * 100) / 100,
    tecnico: Math.round((rawDist.tecnico / total) * 100) / 100,
    fisico: Math.round((rawDist.fisico / total) * 100) / 100,
    mixto: 0,
  };
  // Fix rounding to sum exactly 1.0
  const sum = identityDistribution.ofensivo + identityDistribution.defensivo +
    identityDistribution.tecnico + identityDistribution.fisico;
  identityDistribution.mixto = Math.round((1.0 - sum) * 100) / 100;

  // Capabilities
  const tactical = Math.round((vision + defending) / 2);
  const technical = Math.round((technique + vision) / 2);
  const physical = Math.round((speed + stamina) / 2);
  // Solo el nivel actual: sin p6m/p18m (P1 bloque 5c). Antes «proyectaba» con un factor
  // fijo por la categoría PHV persistida (+3 % / +2 % / +1 %, ×2,5 a 18 meses).
  const capabilities = {
    tactical: { current: tactical },
    technical: { current: technical },
    physical: { current: physical },
  };

  // Confidence based on minutes
  const mins = p.minutesPlayed ?? 0;
  const confidence = mins > 500 ? 0.42 : mins > 200 ? 0.35 : 0.28;

  // Position mapping · respeta lateralidad declarada y pie hábil
  const positionStr = (p.position ?? "").toLowerCase();
  const foot = (p as { foot?: string }).foot;
  const isLeft  = positionStr.includes("izquierd") || foot === "left";
  const isRight = positionStr.includes("derech") || (!isLeft && (foot === "right" || foot === undefined));
  const side: "L" | "R" = isLeft ? "L" : "R";

  let posCode = "RCM";
  if (positionStr.includes("portero")) posCode = "GK";
  else if (positionStr.includes("central") || positionStr.includes("defensa")) posCode = side === "L" ? "LCB" : "RCB";
  else if (positionStr.includes("lateral")) posCode = side === "L" ? "LB" : "RB";
  else if (positionStr.includes("carrilero")) posCode = side === "L" ? "LWB" : "RWB";
  else if (positionStr.includes("pivote") || positionStr.includes("mediocentro defensiv")) posCode = "DM";
  else if (positionStr.includes("interior") || positionStr.includes("mediocent") || positionStr.includes("centrocampista")) posCode = side === "L" ? "LCM" : "RCM";
  else if (positionStr.includes("mediapunta") || positionStr.includes("enganche")) posCode = "CAM";
  else if (positionStr.includes("extremo") || positionStr.includes("banda")) posCode = side === "L" ? "LW" : "RW";
  else if (positionStr.includes("delantero") || positionStr.includes("punta")) posCode = "ST";
  // Suprimir warning sobre isRight no usado
  void isRight;

  // Strengths = top 3 metrics
  const strengths = sorted.slice(0, 3).map(s => `${s.k}: ${s.v}`);
  // Gaps = bottom 2
  const gaps = sorted.slice(-2).map(s => S.roleGap(s.k, s.v));

  return {
    playerId: p.id,
    dominantIdentity,
    identityDistribution,
    topPositions: [
      { code: posCode, fit: 75, confidence: confidence },
    ],
    topArchetypes: [
      { code: dominantIdentity === "tecnico" ? "organizador" : dominantIdentity === "ofensivo" ? "finalizador" : "recuperador", fit: 70, stability: "en_desarrollo" as const },
    ],
    capabilities,
    strengths,
    risks: [S.roleRiskUnavailable],
    gaps,
    overallConfidence: confidence,
    summary: S.roleSummary(p.name, dominantIdentity),
    tokensUsed: 0,
    agentName: "RoleProfileAgent",
    _fallback: true,
    _fallbackReason: reason,
  };
}

// ─── Scout Insight (Rule-based) ─────────────────────────────────────────────

interface ScoutInput {
  player: {
    id?: string;
    name: string;
    age?: number;
    position?: string;
    vsi?: number;
    vsiTrend?: string;
    phvCategory?: string;
    recentMetrics?: Record<string, number>;
  };
  context?: string;
  locale?: string;
}

export function scoutInsightFallback(body: ScoutInput, reason: FallbackReason) {
  const p = body.player;
  const S = fallbackStrings(body.locale);
  const vsi = p.vsi ?? 60;
  const trend = p.vsiTrend ?? "stable";
  const phv = p.phvCategory ?? "ontme";
  const metrics = p.recentMetrics ?? {};
  const speed = metrics.speed ?? 60;
  const maxMetric = Math.max(...Object.values(metrics).filter(v => typeof v === "number"), 0);

  // Determine type by rules
  let type: "breakout" | "phv_alert" | "drill_record" | "regression" | "comparison" | "general" = "general";
  let urgency: "high" | "medium" | "low" = "low";
  let headline = S.scoutSummaryHead(p.name);
  let body_text = S.scoutSummaryBody(vsi, trend);

  if (vsi > 75 && trend === "up") {
    type = "breakout";
    urgency = "high";
    headline = S.scoutBreakoutHead(p.name);
    body_text = S.scoutBreakoutBody(vsi);
  } else if (phv === "early" && speed > 75) {
    // "early" = pre-PHV = madurador TARDÍO vs pares (no "temprana").
    type = "phv_alert";
    urgency = "high";
    headline = S.scoutPhvHead(p.name);
    body_text = S.scoutPhvBody(speed);
  } else if (maxMetric > 85) {
    type = "drill_record";
    urgency = "medium";
    const topMetricName = Object.entries(metrics).sort(([, a], [, b]) => b - a)[0]?.[0] ?? S.metricFallbackName;
    headline = S.scoutDrillHead(p.name, topMetricName);
    body_text = S.scoutDrillBody(maxMetric, topMetricName);
  } else if (trend === "down") {
    type = "regression";
    urgency = "high";
    headline = S.scoutRegressionHead(p.name);
    body_text = S.scoutRegressionBody(vsi);
  } else if (Object.values(metrics).every(v => typeof v === "number" && v >= 55 && v <= 75)) {
    type = "comparison";
    urgency = "low";
    headline = S.scoutBalancedHead(p.name);
    body_text = S.scoutBalancedBody;
  }

  // Override with explicit context
  if (body.context && ["breakout", "comparison", "phv_alert", "drill_record", "regression", "milestone", "general"].includes(body.context)) {
    type = body.context as typeof type;
  }

  return {
    playerId: p.id ?? "unknown",
    type,
    headline,
    body: body_text,
    metric: Object.entries(metrics).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "vsi",
    metricValue: String(maxMetric > 0 ? maxMetric : vsi),
    urgency,
    tags: [type, p.position ?? S.playerTag].filter(Boolean).slice(0, 4),
    timestamp: new Date().toISOString(),
    recommendedDrills: [],
    actionItems: S.scoutActionItems,
    tokensUsed: 0,
    agentName: "ScoutInsightAgent",
    ragEnriched: false,
    _fallback: true,
    _fallbackReason: reason,
  };
}
