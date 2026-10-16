/**
 * VITAS · Advanced Event Types (Sprint 3 — Expanded Event Detection)
 *
 * 19 new ball-aware tactical event types that extend the base 12 types
 * from eventDetectionEngine.ts. These require ball tracking data to detect.
 *
 * Total: 12 (base) + 19 (new) = 31 tactical event types (sin duelos, P1 bloque 6).
 *
 * References:
 *   - Opta F24 event taxonomy
 *   - StatsBomb 360 event model
 *   - SPADL v2 action types
 */

// ─── New ball-aware event types ────────────────────────────────────────────

export type BallEventType =
  | "reception"           // Player receives a pass (ball arrives within 2m)
  | "dribble"             // Player carries ball past opponent (>2s ball possession)
  | "clearance"           // Defensive clearance (ball kicked >20m from own third)
  | "goal_kick"           // Goalkeeper restart from goal area
  | "corner_kick"         // Set piece from corner
  | "throw_in"            // Set piece from sideline
  | "foul"                // Contact between players with sudden stop
  | "offside"             // Player beyond defensive line when ball played
  | "goalkeeper_save"     // GK stops ball near goal
  | "blocked_shot"        // Defender blocks shot trajectory
  | "key_pass"            // Pass leading directly to a shot
  | "progressive_pass"    // Pass advancing ball >10m toward goal
  | "switch_play"         // Long diagonal pass switching sides (>30m horizontal)
  | "ball_recovery"       // Team regains possession after opponent had it
  | "turnover"            // Loss of possession (ball goes to opponent)
  | "dispossessed"        // Opponent takes ball from player in possession
  | "second_assist"       // Pass before the assist pass
  | "chance_created"      // Action creating a clear goalscoring opportunity
  | "progressive_carry";  // Ball carry advancing >10m toward goal

// ─── Combined type (all 31) ───────────────────────────────────────────────

import type { TacticalEventType as BaseEventType } from "./eventDetectionEngine";

/** All 31 tactical event types (12 base + 19 ball-aware). Sin duelos (P1 bloque 6). */
export type ExpandedEventType = BaseEventType | BallEventType;

// ─── Event metadata extensions ─────────────────────────────────────────────

export interface BallEventMetadata {
  /** Ball position at event time (field coords) */
  ballFx?: number;
  ballFy?: number;
  /** Ball speed at event time (m/s) */
  ballSpeedMs?: number;
  /** Distance from ball to actor (meters) */
  ballDistanceM?: number;
  /** Possession team at event time */
  possessionTeam?: "home" | "away" | "contested" | "none";
  /** Pass distance (m) for pass-related events */
  passDistanceM?: number;
  /** Pass direction angle (degrees) */
  passAngleDeg?: number;
  /** Whether pass is forward (toward opponent goal) */
  isForward?: boolean;
  /** Progression distance toward goal (m) */
  progressionM?: number;
  /** Number of defenders bypassed */
  defendersBypassed?: number;
  /** Whether event leads to a shot within 10s */
  leadsToShot?: boolean;
  /** xG of resulting shot (if applicable) */
  resultingXg?: number;
}

// ─── SPADL mapping for new types ───────────────────────────────────────────

export const BALL_EVENT_SPADL_MAP: Record<BallEventType, string> = {
  reception: "receival",
  dribble: "dribble",
  clearance: "clearance",
  goal_kick: "goalkick",
  corner_kick: "corner_crossed",
  throw_in: "throw_in",
  foul: "foul",
  offside: "offside",
  goalkeeper_save: "keeper_save",
  blocked_shot: "shot_block",
  key_pass: "pass",
  progressive_pass: "pass",
  switch_play: "pass",
  ball_recovery: "interception",
  turnover: "bad_touch",
  dispossessed: "bad_touch",
  second_assist: "pass",
  chance_created: "pass",
  progressive_carry: "dribble",
};

// ─── Zone classification helpers ───────────────────────────────────────────

export type FieldZone =
  | "own_box"        // 0-16.5m
  | "own_third"      // 0-35m
  | "middle_third"   // 35-70m
  | "final_third"    // 70-105m
  | "opponent_box";  // 88.5-105m

export function classifyFieldZone(fx: number, fieldLength = 105): FieldZone {
  if (fx <= 16.5) return "own_box";
  if (fx <= fieldLength / 3) return "own_third";
  if (fx <= (fieldLength * 2) / 3) return "middle_third";
  if (fx >= fieldLength - 16.5) return "opponent_box";
  return "final_third";
}

/** Check if a pass is progressive (advances >10m toward opponent goal) */
export function isProgressiveAction(
  startFx: number,
  endFx: number,
  minProgressionM = 10,
): boolean {
  return endFx - startFx >= minProgressionM;
}

/** Check if pass switches play (crosses >30m horizontally) */
export function isSwitchPlay(
  startFy: number,
  endFy: number,
  minSwitchM = 30,
): boolean {
  return Math.abs(endFy - startFy) >= minSwitchM;
}
