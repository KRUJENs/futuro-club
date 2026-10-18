/**
 * VITAS Data Adapters
 * Convierten datos de PlayerService y AgentService
 * al formato exacto que esperan los componentes UI.
 */

import type { Player } from "./playerService";
import type { ScoutInsightOutput } from "@/agents/contracts";
import { gatedMaturity } from "@/lib/phv/phvGate";
import { honestPlayerView } from "@/lib/players/honestPlayerView";
import { vsiTrendArrow } from "@/lib/scoring/vsiDelta";

// Avatares por defecto usando iniciales (sin CDN externo)
const PLACEHOLDER_AVATARS = [
  "https://api.dicebear.com/7.x/initials/svg?seed=",
];

// Imágenes de jugadores — usa placeholder local
const PLAYER_IMAGES = [
  "/placeholder.svg",
];

// ─────────────────────────────────────────
// Adapta Player → forma esperada por Dashboard/Rankings
// ─────────────────────────────────────────
export function adaptPlayerForUI(rawPlayer: Player) {
  // phvCategory/phvOffset PERSISTIDOS solo sobreviven si el gate único de PHV los
  // recalcula desde entradas introducidas (regla del owner 28-sep); si no, null.
  const player = honestPlayerView(rawPlayer);
  // vsi puede ser null ("sin evaluar"): se propaga tal cual, nunca se convierte
  // en 0. La tendencia solo sale de dos evaluaciones reales con fecha (vsiTrendArrow →
  // computeVsiDelta); el vsiHistory legacy solo cuenta para jugadores demo.
  const trending: "up" | "down" | "stable" = vsiTrendArrow({
    evaluations: player.vsiEvaluations,
    legacyHistory: player.vsiHistory,
    currentVsi: player.vsi,
    isDemo: player.isDemo,
  });

  // "ontme" → "on-time" para compatibilidad con componentes existentes
  const phvCategoryMap: Record<string, "early" | "on-time" | "late"> = {
    early: "early",
    ontme: "on-time",
    late: "late",
  };

  return {
    id: player.id,
    name: player.name,
    age: player.age,
    position: player.position,
    // Polivalencia: LiveMatchPage (selector de posición) la lee del jugador adaptado.
    secondaryPositions: player.secondaryPositions,
    positionShort: player.position,
    academy: "VITAS Academy",
    vsi: player.vsi,
    phvOffset: player.phvOffset ?? null,
    phvCategory: player.phvCategory ? (phvCategoryMap[player.phvCategory] ?? null) : null,
    trending,
    avatar: `${PLACEHOLDER_AVATARS[0]}${encodeURIComponent(player.name)}`,
    image: PLAYER_IMAGES[0],
    // Sin métricas (jugador no evaluado) ⇒ stats null: no se fabrican ceros.
    stats: player.metrics
      ? {
          speed: player.metrics.speed,
          technique: player.metrics.technique,
          vision: player.metrics.vision,
          stamina: player.metrics.stamina,
          shooting: player.metrics.shooting,
          defending: player.metrics.defending,
        }
      : null,
    recentDrills: Math.floor(player.minutesPlayed / 90),
    lastActive: player.updatedAt,
  };
}

// ─────────────────────────────────────────
// Adapta ScoutInsightAgent output → forma esperada por ScoutFeed
// ─────────────────────────────────────────
export function adaptInsightForUI(
  insight: ScoutInsightOutput,
  player: Player
) {
  // "phv_alert" → "phv-alert", "drill_record" → "drill-record"
  const typeMap: Record<string, string> = {
    breakout: "breakout",
    comparison: "comparison",
    phv_alert: "phv-alert",
    drill_record: "drill-record",
    regression: "regression",
    milestone: "milestone",
    general: "breakout", // fallback visual
  };

  return {
    id: `${insight.playerId}-${Date.now()}`,
    player: {
      avatar: `${PLACEHOLDER_AVATARS[0]}${encodeURIComponent(player.name)}`,
      name: player.name,
      positionShort: player.position,
      age: player.age,
      academy: "VITAS Academy",
      vsi: player.vsi,
    },
    insightType: typeMap[insight.type] ?? "breakout",
    title: insight.headline,
    description: insight.body,
    metric: insight.metric,
    metricValue: insight.metricValue,
    timestamp: insight.timestamp,
  };
}

// ─────────────────────────────────────────
// Calcula stats del Dashboard desde la lista de jugadores
// ─────────────────────────────────────────
export function computeDashboardStats(players: Player[]) {
  if (players.length === 0) {
    return { activePlayers: 0, drillsCompleted: 0, avgVsi: null as number | null, hiddenTalents: 0 };
  }

  // avgVsi solo sobre jugadores EVALUADOS (vsi no null). Sin ninguno evaluado ⇒
  // null ("sin evaluar"): un hueco no promedia como 0 (invariante #2).
  const evaluated = players.filter((p): p is Player & { vsi: number } => p.vsi !== null);
  const avgVsi: number | null =
    evaluated.length > 0
      ? Math.round((evaluated.reduce((sum, p) => sum + p.vsi, 0) / evaluated.length) * 10) / 10
      : null;

  const drillsCompleted = players.reduce(
    (sum, p) => sum + Math.floor(p.minutesPlayed / 90),
    0
  );

  // "Talentos ocultos" = madurador TARDÍO (con confianza) y VSI < 65 (potencial
  // subestimado por maduración). Gateado por el motor canónico para no contar
  // a cualquier pre-púber como talento oculto (falso positivo). Un jugador sin
  // evaluar (vsi null) no puede ser talento oculto: se excluye.
  const hiddenTalents = players.filter((p) => {
    if (p.vsi === null || p.vsi >= 65) return false;
    const m = gatedMaturity(p);
    return m.timing === "late" && (m.confidence === "high" || m.confidence === "moderate");
  }).length;

  return {
    activePlayers: players.length,
    drillsCompleted,
    avgVsi,
    hiddenTalents,
  };
}
