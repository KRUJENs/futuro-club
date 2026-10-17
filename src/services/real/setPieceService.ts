/**
 * VITAS · Set Piece Service — Mock data generator
 *
 * Generates realistic set piece events for visualization.
 * In production this would be fed by the video pipeline.
 */

import type {
  SetPieceEvent,
  SetPieceAggregateStats,
  SetPieceRecommendation,
  SetPieceType,
  AttackingPattern,
  PlayerOnSetPiece,
} from "@/lib/setPiece/types";

const MATCHES = [
  { id: "m1", label: "vs Rival FC · 12 Abr" },
  { id: "m2", label: "vs Academia Sur · 19 Abr" },
  { id: "m3", label: "vs Tigres FC · 26 Abr" },
  { id: "m4", label: "vs CD Norte · 03 May" },
  { id: "m5", label: "vs Eagles SC · 10 May" },
];

const PLAYER_POOL = [
  { id: "p1", name: "Samu", number: 8 },
  { id: "p2", name: "Marco López", number: 10 },
  { id: "p3", name: "Diego Fernández", number: 9 },
  { id: "p4", name: "Tomás Sánchez", number: 4 },
  { id: "p5", name: "Andrés Rodríguez", number: 6 },
  { id: "p6", name: "Pablo Martínez", number: 11 },
  { id: "p7", name: "Lucas García", number: 7 },
  { id: "p8", name: "Nicolás Torres", number: 2 },
  { id: "p9", name: "Mateo Ruiz", number: 5 },
];

function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function pickPlayers(rng: () => number, count: number): typeof PLAYER_POOL {
  const shuffled = [...PLAYER_POOL].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

function generateCornerPlayers(
  rng: () => number,
  side: "left" | "right",
): PlayerOnSetPiece[] {
  const taker = PLAYER_POOL[1]; // Marco López typically
  const targets = pickPlayers(rng, 4).filter((p) => p.id !== taker.id).slice(0, 4);
  const cornerX = side === "left" ? 100 : 100;
  const cornerY = side === "left" ? 0 : 100;

  return [
    {
      playerId: taker.id,
      playerName: taker.name,
      shirtNumber: taker.number,
      role: "taker",
      position: { x: cornerX, y: cornerY },
    },
    ...targets.map((p, i) => ({
      playerId: p.id,
      playerName: p.name,
      shirtNumber: p.number,
      role: (i === 0 ? "target" : i === 3 ? "decoy" : "target") as PlayerOnSetPiece["role"],
      position: {
        x: 88 + (rng() - 0.5) * 8,
        y: 30 + i * 12 + (rng() - 0.5) * 6,
      },
    })),
  ];
}

function generateFreeKickPlayers(rng: () => number): PlayerOnSetPiece[] {
  const taker = PLAYER_POOL[2]; // Diego
  const wall = pickPlayers(rng, 3).filter((p) => p.id !== taker.id);
  return [
    {
      playerId: taker.id,
      playerName: taker.name,
      shirtNumber: taker.number,
      role: "taker",
      position: { x: 75 + rng() * 10, y: 40 + rng() * 20 },
    },
    ...wall.map((p, i) => ({
      playerId: p.id,
      playerName: p.name,
      shirtNumber: p.number,
      role: (i === 0 ? "target" : "screener") as PlayerOnSetPiece["role"],
      position: {
        x: 88 + (rng() - 0.5) * 4,
        y: 35 + i * 10 + (rng() - 0.5) * 5,
      },
    })),
  ];
}

const PATTERNS_BY_TYPE: Record<SetPieceType, AttackingPattern[]> = {
  corner: ["near_post", "far_post", "penalty_spot", "edge_of_box", "short_corner", "trick_play"],
  free_kick_direct: ["direct_shot", "wall_curl", "wall_over"],
  free_kick_indirect: ["near_post", "far_post", "penalty_spot", "edge_of_box"],
  penalty: ["direct_shot"],
  throw_in: ["short_corner"],
  goal_kick: ["edge_of_box"],
};

const OUTCOMES_BY_PATTERN: Record<AttackingPattern, Array<{ outcome: SetPieceEvent["outcome"]; weight: number }>> = {
  near_post: [
    { outcome: "shot_on_target", weight: 25 },
    { outcome: "goal", weight: 8 },
    { outcome: "cleared", weight: 35 },
    { outcome: "blocked", weight: 15 },
    { outcome: "lost", weight: 17 },
  ],
  far_post: [
    { outcome: "shot_on_target", weight: 22 },
    { outcome: "goal", weight: 12 },
    { outcome: "shot_off_target", weight: 18 },
    { outcome: "cleared", weight: 30 },
    { outcome: "lost", weight: 18 },
  ],
  penalty_spot: [
    { outcome: "shot_on_target", weight: 28 },
    { outcome: "goal", weight: 10 },
    { outcome: "blocked", weight: 22 },
    { outcome: "cleared", weight: 25 },
    { outcome: "lost", weight: 15 },
  ],
  edge_of_box: [
    { outcome: "shot_on_target", weight: 18 },
    { outcome: "shot_off_target", weight: 22 },
    { outcome: "retained", weight: 30 },
    { outcome: "lost", weight: 30 },
  ],
  short_corner: [
    { outcome: "retained", weight: 50 },
    { outcome: "shot_on_target", weight: 10 },
    { outcome: "lost", weight: 40 },
  ],
  trick_play: [
    { outcome: "goal", weight: 18 },
    { outcome: "shot_on_target", weight: 25 },
    { outcome: "cleared", weight: 32 },
    { outcome: "lost", weight: 25 },
  ],
  direct_shot: [
    { outcome: "goal", weight: 15 },
    { outcome: "shot_on_target", weight: 25 },
    { outcome: "shot_off_target", weight: 30 },
    { outcome: "blocked", weight: 30 },
  ],
  wall_curl: [
    { outcome: "goal", weight: 12 },
    { outcome: "shot_on_target", weight: 28 },
    { outcome: "shot_off_target", weight: 35 },
    { outcome: "blocked", weight: 25 },
  ],
  wall_over: [
    { outcome: "shot_off_target", weight: 45 },
    { outcome: "shot_on_target", weight: 20 },
    { outcome: "blocked", weight: 15 },
    { outcome: "goal", weight: 20 },
  ],
};

function pickWeighted<T>(rng: () => number, items: Array<{ outcome: T; weight: number }>): T {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.outcome;
  }
  return items[0].outcome;
}

const TACTICAL_NOTES: Record<AttackingPattern, string[]> = {
  near_post: [
    "Bloque de pantalla efectivo en primer palo",
    "Saque cerrado con curva hacia el primer palo",
    "Movimiento de desmarque cruzado",
  ],
  far_post: [
    "Saque hacia segundo palo con jugador alto",
    "Movimiento de espera larga",
    "Centro con efecto hacia el segundo palo",
  ],
  penalty_spot: [
    "Centro al punto de penal sin marca",
    "Jugador llegando desde fuera del área",
    "Bloque para liberar al rematador",
  ],
  edge_of_box: [
    "Pase corto + remate desde fuera del área",
    "Segunda jugada planificada",
    "Combinación de saques cortos",
  ],
  short_corner: [
    "Saque corto para mantener posesión",
    "Triángulo entre 3 jugadores",
    "Cambio de orientación del juego",
  ],
  trick_play: [
    "Jugada ensayada con movimientos coordinados",
    "Decoy para liberar al rematador",
    "Cambio de ritmo sorpresivo",
  ],
  direct_shot: [
    "Tiro directo con efecto",
    "Disparo potente al ángulo",
    "Tiro raso buscando el segundo palo",
  ],
  wall_curl: [
    "Curva sobre la barrera",
    "Efecto exterior hacia ángulo",
    "Disparo con interior",
  ],
  wall_over: [
    "Disparo elevado sobre la barrera",
    "Efecto cucharita",
    "Tiro con ascenso pronunciado",
  ],
};

let _cache: SetPieceEvent[] | null = null;

export function getAllSetPieces(): SetPieceEvent[] {
  if (_cache) return _cache;
  const events: SetPieceEvent[] = [];
  const rng = rand(42);

  for (const match of MATCHES) {
    const count = 6 + Math.floor(rng() * 5); // 6-10 set pieces per match
    for (let i = 0; i < count; i++) {
      const typeRoll = rng();
      let type: SetPieceType = "corner";
      if (typeRoll < 0.45) type = "corner";
      else if (typeRoll < 0.7) type = "free_kick_direct";
      else if (typeRoll < 0.85) type = "free_kick_indirect";
      else if (typeRoll < 0.9) type = "penalty";
      else if (typeRoll < 0.97) type = "throw_in";
      else type = "goal_kick";

      const isOffensive = rng() > 0.45;
      const side: SetPieceEvent["side"] =
        rng() < 0.45 ? "left" : rng() < 0.9 ? "right" : "center";

      const patterns = PATTERNS_BY_TYPE[type];
      const pattern = patterns[Math.floor(rng() * patterns.length)];

      const outcome = pickWeighted(rng, OUTCOMES_BY_PATTERN[pattern] ?? OUTCOMES_BY_PATTERN.penalty_spot);

      const origin: { x: number; y: number } =
        type === "corner"
          ? { x: 100, y: side === "left" ? 0 : 100 }
          : type === "penalty"
            ? { x: 89, y: 50 }
            : { x: 70 + rng() * 20, y: 20 + rng() * 60 };

      const endPoint: { x: number; y: number } = {
        x: 85 + rng() * 12,
        y: 35 + rng() * 30,
      };

      const players: PlayerOnSetPiece[] =
        type === "corner"
          ? generateCornerPlayers(rng, side === "center" ? "right" : side)
          : generateFreeKickPlayers(rng);

      const notes = TACTICAL_NOTES[pattern] ?? [];
      const tacticalNotes = notes.slice(0, 1 + Math.floor(rng() * 2));

      const xG =
        outcome === "goal" || outcome.startsWith("shot")
          ? 0.05 + rng() * 0.4
          : undefined;

      events.push({
        id: `sp_${match.id}_${i}`,
        matchId: match.id,
        matchLabel: match.label,
        minute: 1 + Math.floor(rng() * 90),
        type,
        side,
        origin,
        endPoint,
        outcome,
        pattern,
        xG: xG ? Math.round(xG * 100) / 100 : undefined,
        players,
        tacticalNotes,
        confidence: 0.78 + rng() * 0.2,
        isOffensive,
      });
    }
  }

  _cache = events.sort((a, b) => b.matchId.localeCompare(a.matchId) || a.minute - b.minute);
  return _cache;
}

export function getAggregateStats(
  events: SetPieceEvent[] = getAllSetPieces(),
): SetPieceAggregateStats {
  const offensive = events.filter((e) => e.isOffensive);
  const goals = offensive.filter((e) => e.outcome === "goal").length;
  const shots = offensive.filter(
    (e) => e.outcome === "goal" || e.outcome === "shot_on_target" || e.outcome === "shot_off_target",
  ).length;
  const shotsOnTarget = offensive.filter(
    (e) => e.outcome === "goal" || e.outcome === "shot_on_target",
  ).length;
  const total = offensive.length;

  const xGs = offensive.filter((e) => e.xG).map((e) => e.xG ?? 0);
  const avgXG = xGs.length ? xGs.reduce((s, x) => s + x, 0) / xGs.length : 0;

  const byType = offensive.reduce(
    (acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    },
    {} as Record<SetPieceType, number>,
  );

  // Top patterns
  const patternCounts: Record<string, { count: number; successes: number }> = {};
  for (const e of offensive) {
    const key = e.pattern;
    if (!patternCounts[key]) patternCounts[key] = { count: 0, successes: 0 };
    patternCounts[key].count++;
    if (e.outcome === "goal" || e.outcome === "shot_on_target") {
      patternCounts[key].successes++;
    }
  }

  const topPatterns = Object.entries(patternCounts)
    .map(([pattern, { count, successes }]) => ({
      pattern: pattern as AttackingPattern,
      count,
      successRate: count > 0 ? successes / count : 0,
    }))
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 5);

  return {
    total,
    goals,
    shotsOnTarget,
    conversionRate: total > 0 ? goals / total : 0,
    shotRate: total > 0 ? shots / total : 0,
    avgXG,
    byType,
    topPatterns,
  };
}

export function getRecommendations(): SetPieceRecommendation[] {
  const rng = rand(99);
  return [
    {
      id: "rec1",
      type: "corner",
      pattern: "near_post",
      title: "Córner cerrado al primer palo con bloque",
      description:
        "El rival defiende en zona con un solo jugador en el primer palo. Saque cerrado con curva interior + bloque de pantalla libera al rematador.",
      successProbability: 38,
      basedOn: "Análisis de 12 córners defendidos por el rival",
      diagram: generateCornerPlayers(rng, "right"),
      keyPoints: [
        "Saque con efecto interior pronunciado",
        "Bloque del 9 sobre el central del primer palo",
        "Rematador (4) entra desde fuera del área",
        "Decoy del 11 hacia segundo palo",
      ],
    },
    {
      id: "rec2",
      type: "free_kick_direct",
      pattern: "wall_curl",
      title: "Falta directa con curva sobre barrera",
      description:
        "Distancia óptima (24m) y ángulo favorable. El portero rival tiende a cubrir el primer palo.",
      successProbability: 22,
      basedOn: "Patrón de 5 faltas similares analizadas",
      diagram: generateFreeKickPlayers(rng),
      keyPoints: [
        "Diego Fernández como ejecutor (pie izquierdo)",
        "Curva sobre la barrera al segundo palo",
        "Marco López y Lucas como ofensivos por rebote",
        "Decoy de Samu corriendo hacia primer palo",
      ],
    },
    {
      id: "rec3",
      type: "corner",
      pattern: "trick_play",
      title: "Jugada ensayada — Doble pase corto",
      description:
        "Sorprende a defensas que esperan centro. Saque corto al lateral + cambio de orientación crea ventaja numérica.",
      successProbability: 31,
      basedOn: "Solo el 18% de equipos rivales presiona córners cortos",
      diagram: generateCornerPlayers(rng, "left"),
      keyPoints: [
        "Saque corto del 10 al 7 en zona izquierda",
        "Devolución del 7 al 10 que centra",
        "Centro al punto de penal sin marca",
        "Llegada del 6 desde segunda línea",
      ],
    },
  ];
}

export const SET_PIECE_TYPE_LABELS: Record<SetPieceType, string> = {
  corner: "Córner",
  free_kick_direct: "Falta directa",
  free_kick_indirect: "Falta indirecta",
  penalty: "Penal",
  throw_in: "Saque de banda",
  goal_kick: "Saque de meta",
};

export const PATTERN_LABELS: Record<AttackingPattern, string> = {
  near_post: "Primer palo",
  far_post: "Segundo palo",
  penalty_spot: "Punto de penal",
  edge_of_box: "Borde del área",
  short_corner: "Córner corto",
  trick_play: "Jugada ensayada",
  direct_shot: "Tiro directo",
  wall_curl: "Curva sobre barrera",
  wall_over: "Por encima de barrera",
};

export const OUTCOME_LABELS: Record<SetPieceEvent["outcome"], { label: string; color: string }> = {
  goal: { label: "Gol", color: "text-emerald-500" },
  shot_on_target: { label: "Tiro a puerta", color: "text-blue-500" },
  shot_off_target: { label: "Tiro fuera", color: "text-amber-500" },
  blocked: { label: "Bloqueado", color: "text-orange-500" },
  cleared: { label: "Despejado", color: "text-gray-500" },
  retained: { label: "Posesión retenida", color: "text-cyan-500" },
  lost: { label: "Pérdida", color: "text-red-500" },
};
