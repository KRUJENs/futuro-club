/**
 * VITAS · Set Piece Intelligence — Types
 *
 * Tipos para análisis de jugadas a balón parado (córners, faltas, penales, saques).
 */

export type SetPieceType =
  | "corner"
  | "free_kick_direct"
  | "free_kick_indirect"
  | "penalty"
  | "throw_in"
  | "goal_kick";

export type SetPieceOutcome =
  | "goal"
  | "shot_on_target"
  | "shot_off_target"
  | "blocked"
  | "cleared"
  | "retained"
  | "lost";

export type SetPieceSide = "left" | "right" | "center";

export type AttackingPattern =
  | "near_post"
  | "far_post"
  | "penalty_spot"
  | "edge_of_box"
  | "short_corner"
  | "trick_play"
  | "direct_shot"
  | "wall_curl"
  | "wall_over";

export interface PitchPosition {
  /** 0-100 normalized field coordinates */
  x: number;
  y: number;
}

export interface PlayerOnSetPiece {
  playerId: string;
  playerName: string;
  shirtNumber: number;
  role: "taker" | "target" | "screener" | "decoy" | "defender";
  position: PitchPosition;
  /** Movement during the play (heading direction) */
  movementAngle?: number;
}

export interface SetPieceEvent {
  id: string;
  matchId: string;
  matchLabel: string; // e.g. "vs Rival FC · 12 Abr"
  minute: number;
  type: SetPieceType;
  side: SetPieceSide;
  /** Origin point of the set piece (where ball was placed) */
  origin: PitchPosition;
  /** Where the ball ended up (or shot target) */
  endPoint: PitchPosition;
  outcome: SetPieceOutcome;
  pattern: AttackingPattern;
  /** Expected goal value (xG) of the resulting shot, if any */
  xG?: number;
  /** All players involved in the play */
  players: PlayerOnSetPiece[];
  /** AI-tagged tactical notes */
  tacticalNotes: string[];
  /** Confidence of the detection 0-1 */
  confidence: number;
  /** Was the play offensive (our team) or defensive (rival) */
  isOffensive: boolean;
}

export interface SetPieceAggregateStats {
  total: number;
  goals: number;
  shotsOnTarget: number;
  conversionRate: number; // goals / total
  shotRate: number; // shots / total
  avgXG: number;
  /** Distribution by type */
  byType: Record<SetPieceType, number>;
  /** Top performing patterns */
  topPatterns: Array<{
    pattern: AttackingPattern;
    count: number;
    successRate: number;
  }>;
}

export interface SetPieceRecommendation {
  id: string;
  type: SetPieceType;
  pattern: AttackingPattern;
  title: string;
  description: string;
  successProbability: number; // 0-100
  basedOn: string; // e.g. "Análisis de 12 córners del rival"
  /** Visual diagram positions */
  diagram: PlayerOnSetPiece[];
  keyPoints: string[];
}
