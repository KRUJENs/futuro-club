/**
 * VITAS · Event Detection Engine (Tracking 9/10)
 *
 * Automated tactical event recognition from tracking data.
 * Detects passes, shots, recoveries, tackles, and set pieces
 * using physics-based heuristics on player positions and velocities.
 * Sin duelos (P1 bloque 6): la detección por proximidad no separaba equipos y
 * disparaba un evento por fotograma; el ganador («el más rápido») era inventado.
 * El concepto vive bloqueado en src/lib/tracking/duels.ts.
 *
 * Input: Track[] from YOLO + MediaPipe keypoints (optional)
 * Output: TacticalEvent[] with classifications, confidence, and spatial context
 *
 * No ML model needed — purely geometric/physics rules calibrated for youth football.
 * References:
 *   - FIFA EPTS Standard for event data
 *   - SPADL (Soccer Player Action Description Language) event taxonomy
 *   - Metrica Sports open-data event definitions
 */

import type { Track, ScanEvent, Keypoint } from "@/lib/yolo/types";
import type { BallEventType } from "./advancedEventTypes";
import { computeXgSimple } from "@/lib/xg/xgModel";

/* ── Types ─────────────────────────────────────────────────────── */

/** Base player-only event types (12) */
export type BaseEventType =
  | "pass"
  | "shot"
  | "recovery"
  | "tackle"
  | "interception"
  | "carry"
  | "set_piece"
  | "sprint_burst"
  | "press_trigger"
  | "offside_line_break"
  | "cross"
  | "through_ball";

/** All 31 tactical event types (12 base + 19 ball-aware from Sprint 3) */
export type TacticalEventType = BaseEventType | BallEventType;

export type EventOutcome = "success" | "fail" | "neutral" | "unknown";

export interface TacticalEvent {
  /** Unique event ID */
  id: string;
  /** Event type from SPADL-inspired taxonomy */
  type: TacticalEventType;
  /** Timestamp in ms */
  timestampMs: number;
  /** Frame index */
  frameIndex: number;
  /** Player track ID who initiated the event */
  actorTrackId: number;
  /** Receiving player track ID (for passes) */
  receiverTrackId: number | null;
  /** Field position where event started (meters, FIFA EPTS format) */
  startPosition: { fx: number; fy: number };
  /** Field position where event ended (for passes/shots) */
  endPosition: { fx: number; fy: number } | null;
  /** Event outcome */
  outcome: EventOutcome;
  /** Detection confidence 0-1 */
  confidence: number;
  /** Additional context */
  metadata: Record<string, number | string | boolean>;
}

export interface EventDetectionConfig {
  /** Minimum speed (m/s) to classify a sprint burst (default: 5.8 ≈ 21 km/h) */
  sprintThresholdMs: number;
  /** Minimum deceleration (m/s²) to detect a tackle/press (default: -3.5) */
  decelThresholdMs2: number;
  /** Ball speed proxy: max player speed change in one frame to detect a kick (default: 4.0 m/s) */
  kickSpeedChangeMs: number;
  /** Pass detection: direction alignment threshold in degrees (default: 30°) */
  passAngleThresholdDeg: number;
  /** Minimum carry distance to register a carry event (default: 5.0m) */
  carryMinDistanceM: number;
  /** Frame rate of tracking data (default: 8) */
  trackingFps: number;
  /** Field dimensions (default: 105 × 68) */
  fieldLengthM: number;
  fieldWidthM: number;
}

export interface EventSummary {
  /** Total events detected */
  totalEvents: number;
  /** Events by type */
  byType: Record<TacticalEventType, number>;
  /** Pass completion rate */
  passCompletionPct: number;
  /** Total passes attempted */
  passesAttempted: number;
  /** Total passes completed */
  passesCompleted: number;
  /** Recoveries */
  recoveries: number;
  /** Sprints detected */
  sprintBursts: number;
  /** Pressing actions */
  pressTriggers: number;
  /** Shots */
  shots: number;
  /** xG chain contributions (simplified) */
  xgContributions: number;
  /** VAEP approximation based on event sequences */
  vaepApprox: number;
}

/* ── Default Config ────────────────────────────────────────────── */

const DEFAULT_CONFIG: EventDetectionConfig = {
  sprintThresholdMs: 5.8,       // ~21 km/h
  decelThresholdMs2: -3.5,
  kickSpeedChangeMs: 4.0,
  passAngleThresholdDeg: 30,
  carryMinDistanceM: 5.0,
  trackingFps: 8,
  fieldLengthM: 105,
  fieldWidthM: 68,
};

/* ── Event Detection Engine ───────────────────────────────────── */

export class EventDetectionEngine {
  private config: EventDetectionConfig;
  private events: TacticalEvent[] = [];
  private eventCounter = 0;
  private previousTracks: Track[] = [];
  private previousTimestampMs = 0;
  private carryState: Map<number, { startPos: { fx: number; fy: number }; startTimeMs: number; distanceM: number }> = new Map();

  constructor(config?: Partial<EventDetectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Reset for a new session */
  reset(): void {
    this.events = [];
    this.eventCounter = 0;
    this.previousTracks = [];
    this.previousTimestampMs = 0;
    this.carryState.clear();
  }

  /**
   * Process a frame of tracking data and detect tactical events.
   * Call this for each frame in sequence.
   *
   * @param ballTrack - Optional ball tracking data (Sprint 3). When provided,
   *   improves confidence of existing event detections (e.g., pass/shot confirmed
   *   by ball trajectory).
   */
  processFrame(
    tracks: Track[],
    timestampMs: number,
    frameIndex: number,
    focusTrackId?: number | null,
    ballTrack?: { fieldPos: { fx: number; fy: number } | null; speedMs: number; visible: boolean } | null,
    calibrationReliable = true,
  ): TacticalEvent[] {
    const frameEvents: TacticalEvent[] = [];

    // Todos los eventos tácticos se deciden por posición/velocidad en METROS
    // (umbrales fx>0.7·L, cruces desde banda, etc.). Sin calibración fiable esas
    // posiciones no son de fiar → NO detectamos eventos (avanzamos el estado sin
    // emitir, para no arrastrar un salto al recuperar la calibración).
    if (!calibrationReliable) {
      // Reseteamos el estado previo (NO guardamos posiciones no fiables): al recuperar
      // la calibración, la primera frame fiable re-inicializa (guarda 175-179) en vez
      // de comparar contra posiciones-basura → evita un evento espurio en el borde.
      this.previousTracks = [];
      this.previousTimestampMs = timestampMs;
      return frameEvents;
    }

    const dt = (timestampMs - this.previousTimestampMs) / 1000;

    if (dt <= 0 || this.previousTracks.length === 0) {
      this.previousTracks = tracks;
      this.previousTimestampMs = timestampMs;
      return frameEvents;
    }

    // Build previous track lookup
    const prevMap = new Map<number, Track>();
    for (const t of this.previousTracks) prevMap.set(t.id, t);

    for (const track of tracks) {
      const prev = prevMap.get(track.id);
      if (!prev) continue;

      const pos = lastFieldPos(track);
      const prevPos = lastFieldPos(prev);
      if (!pos || !prevPos) continue;

      const speed = track.smoothSpeedMs;
      const prevSpeed = prev.smoothSpeedMs;
      const accel = dt > 0 ? (speed - prevSpeed) / dt : 0;

      // ── Sprint burst detection ──
      if (speed >= this.config.sprintThresholdMs && prevSpeed < this.config.sprintThresholdMs) {
        frameEvents.push(this.createEvent({
          type: "sprint_burst",
          timestampMs,
          frameIndex,
          actorTrackId: track.id,
          startPosition: pos,
          confidence: Math.min(1, speed / (this.config.sprintThresholdMs * 1.5)),
          metadata: { speedMs: round2(speed), accelMs2: round2(accel) },
        }));
      }

      // ── Press trigger: sudden deceleration towards opponent ──
      if (accel <= this.config.decelThresholdMs2 && prevSpeed > 3.0) {
        const nearestOpponent = this.findNearest(track, tracks, 4.0);
        if (nearestOpponent) {
          frameEvents.push(this.createEvent({
            type: "press_trigger",
            timestampMs,
            frameIndex,
            actorTrackId: track.id,
            startPosition: pos,
            endPosition: lastFieldPos(nearestOpponent) ?? pos,
            confidence: Math.min(1, Math.abs(accel) / 6.0),
            metadata: {
              decelMs2: round2(accel),
              targetTrackId: nearestOpponent.id,
              distanceM: round2(fieldDistance(pos, lastFieldPos(nearestOpponent)!)),
            },
          }));
        }
      }

      // ── Pass detection: sudden velocity change + nearest teammate alignment ──
      if (Math.abs(accel) >= this.config.kickSpeedChangeMs / dt) {
        const receiver = this.findPassReceiver(track, tracks, pos, dt);
        if (receiver) {
          const receiverPos = lastFieldPos(receiver);
          const dist = receiverPos ? fieldDistance(pos, receiverPos) : 0;
          const isLong = dist > 25;
          const isToGoal = receiverPos && receiverPos.fx > this.config.fieldLengthM * 0.75;

          frameEvents.push(this.createEvent({
            type: isLong && isToGoal ? "through_ball" : "pass",
            timestampMs,
            frameIndex,
            actorTrackId: track.id,
            receiverTrackId: receiver.id,
            startPosition: pos,
            endPosition: receiverPos,
            outcome: "success", // We'll refine with tracking continuity
            confidence: 0.6,
            metadata: {
              distanceM: round2(dist),
              isLong,
              angle: round2(this.computePassAngle(pos, receiverPos!)),
            },
          }));
        }
      }

      // ── Shot detection: near opponent goal + high speed change ──
      if (pos.fx > this.config.fieldLengthM * 0.7 && speed > 2.0) {
        if (Math.abs(accel) >= this.config.kickSpeedChangeMs * 0.8 / dt) {
          const goalCenter = { fx: this.config.fieldLengthM, fy: this.config.fieldWidthM / 2 };
          const angleToGoal = Math.abs(Math.atan2(goalCenter.fy - pos.fy, goalCenter.fx - pos.fx)) * (180 / Math.PI);

          if (angleToGoal < 60) {
            const isOnTarget = Math.abs(pos.fy - this.config.fieldWidthM / 2) < 15;
            frameEvents.push(this.createEvent({
              type: "shot",
              timestampMs,
              frameIndex,
              actorTrackId: track.id,
              startPosition: pos,
              endPosition: goalCenter,
              outcome: isOnTarget ? "success" : "fail",
              confidence: 0.5 + (angleToGoal < 30 ? 0.2 : 0),
              metadata: {
                distanceToGoalM: round2(fieldDistance(pos, goalCenter)),
                angleToGoalDeg: round2(angleToGoal),
                xgApprox: round2(this.estimateXG(pos)),
              },
            }));
          }
        }
      }

      // ── Recovery detection: sudden speed increase after low activity ──
      if (speed > 3.5 && prevSpeed < 1.5 && accel > 2.5) {
        const nearbyOpponents = tracks.filter(t => {
          if (t.id === track.id) return false;
          const oPos = lastFieldPos(t);
          return oPos ? fieldDistance(pos, oPos) < 5.0 : false;
        });
        if (nearbyOpponents.length >= 1) {
          frameEvents.push(this.createEvent({
            type: "recovery",
            timestampMs,
            frameIndex,
            actorTrackId: track.id,
            startPosition: pos,
            confidence: 0.55,
            metadata: { nearbyOpponents: nearbyOpponents.length },
          }));
        }
      }

      // ── Cross detection: from wide position towards box ──
      if (
        (pos.fy < 15 || pos.fy > this.config.fieldWidthM - 15) &&
        pos.fx > this.config.fieldLengthM * 0.6 &&
        Math.abs(accel) >= this.config.kickSpeedChangeMs * 0.6 / dt
      ) {
        frameEvents.push(this.createEvent({
          type: "cross",
          timestampMs,
          frameIndex,
          actorTrackId: track.id,
          startPosition: pos,
          endPosition: {
            fx: this.config.fieldLengthM - 12,
            fy: this.config.fieldWidthM / 2,
          },
          confidence: 0.5,
          metadata: { fromSide: pos.fy < this.config.fieldWidthM / 2 ? "left" : "right" },
        }));
      }

      // ── Carry tracking ──
      if (focusTrackId && track.id === focusTrackId) {
        const carry = this.carryState.get(track.id);
        if (speed > 2.0) {
          if (!carry) {
            this.carryState.set(track.id, {
              startPos: pos,
              startTimeMs: timestampMs,
              distanceM: 0,
            });
          } else {
            carry.distanceM += fieldDistance(prevPos, pos);
          }
        } else if (carry && carry.distanceM >= this.config.carryMinDistanceM) {
          frameEvents.push(this.createEvent({
            type: "carry",
            timestampMs: carry.startTimeMs,
            frameIndex,
            actorTrackId: track.id,
            startPosition: carry.startPos,
            endPosition: pos,
            outcome: "success",
            confidence: 0.65,
            metadata: {
              distanceM: round2(carry.distanceM),
              durationMs: timestampMs - carry.startTimeMs,
            },
          }));
          this.carryState.delete(track.id);
        } else if (speed <= 2.0) {
          this.carryState.delete(track.id);
        }
      }
    }

    // ── Boost confidence when ball data confirms events (Sprint 3) ──
    if (ballTrack?.visible && ballTrack.fieldPos) {
      for (const evt of frameEvents) {
        if ((evt.type === "pass" || evt.type === "through_ball" || evt.type === "cross") && ballTrack.speedMs > 3) {
          evt.confidence = Math.min(1.0, evt.confidence + 0.15);
          (evt.metadata as Record<string, unknown>).ballConfirmed = true;
          (evt.metadata as Record<string, unknown>).ballSpeedMs = round2(ballTrack.speedMs);
        }
        if (evt.type === "shot" && ballTrack.speedMs > 5) {
          evt.confidence = Math.min(1.0, evt.confidence + 0.2);
          (evt.metadata as Record<string, unknown>).ballConfirmed = true;
          (evt.metadata as Record<string, unknown>).ballSpeedMs = round2(ballTrack.speedMs);
        }
      }
    }

    // Store for next frame
    this.previousTracks = tracks;
    this.previousTimestampMs = timestampMs;

    // Accumulate
    this.events.push(...frameEvents);
    return frameEvents;
  }

  /** Get all detected events */
  getEvents(): TacticalEvent[] {
    return this.events;
  }

  /** Get events for a specific player */
  getPlayerEvents(trackId: number): TacticalEvent[] {
    return this.events.filter(
      e => e.actorTrackId === trackId || e.receiverTrackId === trackId,
    );
  }

  /** Compute event summary for reporting */
  summarize(focusTrackId?: number): EventSummary {
    const events = focusTrackId
      ? this.getPlayerEvents(focusTrackId)
      : this.events;

    const byType = {} as Record<TacticalEventType, number>;
    for (const e of events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }

    const passes = events.filter(e => e.type === "pass" || e.type === "through_ball");
    const passesCompleted = passes.filter(e => e.outcome === "success").length;
    const shots = events.filter(e => e.type === "shot");
    const xgTotal = shots.reduce((s, e) => s + (Number(e.metadata.xgApprox) || 0), 0);

    // VAEP approximation: successful actions in the attacking third
    const attackingEvents = events.filter(e =>
      e.startPosition.fx > 70 && e.outcome === "success",
    );
    const vaepApprox = attackingEvents.length * 0.02 + xgTotal * 0.5;

    return {
      totalEvents: events.length,
      byType,
      passCompletionPct: passes.length > 0
        ? Math.round((passesCompleted / passes.length) * 100)
        : 0,
      passesAttempted: passes.length,
      passesCompleted,
      recoveries: byType.recovery ?? 0,
      sprintBursts: byType.sprint_burst ?? 0,
      pressTriggers: byType.press_trigger ?? 0,
      shots: shots.length,
      xgContributions: round2(xgTotal),
      vaepApprox: round2(vaepApprox),
    };
  }

  /** Export events as SPADL-compatible format */
  toSPADL(): Array<{
    game_id: string;
    period_id: number;
    time_seconds: number;
    team_id: number;
    player_id: number;
    start_x: number;
    start_y: number;
    end_x: number;
    end_y: number;
    type_name: string;
    result_name: string;
  }> {
    return this.events.map(e => ({
      game_id: "vitas_session",
      period_id: 1,
      time_seconds: e.timestampMs / 1000,
      team_id: 0,
      player_id: e.actorTrackId,
      start_x: e.startPosition.fx,
      start_y: e.startPosition.fy,
      end_x: e.endPosition?.fx ?? e.startPosition.fx,
      end_y: e.endPosition?.fy ?? e.startPosition.fy,
      type_name: e.type,
      result_name: e.outcome,
    }));
  }

  /* ── Private helpers ─────────────────────────────────────────── */

  private createEvent(partial: Omit<TacticalEvent, "id"> & { id?: string }): TacticalEvent {
    return {
      id: `evt_${++this.eventCounter}_${partial.type}`,
      receiverTrackId: null,
      endPosition: null,
      outcome: "neutral",
      ...partial,
    };
  }

  private findNearest(track: Track, tracks: Track[], maxDist: number): Track | null {
    const pos = lastFieldPos(track);
    if (!pos) return null;
    let best: Track | null = null;
    let bestDist = maxDist;
    for (const t of tracks) {
      if (t.id === track.id) continue;
      const tPos = lastFieldPos(t);
      if (!tPos) continue;
      const d = fieldDistance(pos, tPos);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return best;
  }

  private findPassReceiver(
    passer: Track,
    tracks: Track[],
    passerPos: { fx: number; fy: number },
    dt: number,
  ): Track | null {
    // Direction of movement
    const positions = passer.positions;
    if (positions.length < 2) return null;
    const last = positions[positions.length - 1];
    const prev = positions[positions.length - 2];
    const dx = last.fx - prev.fx;
    const dy = last.fy - prev.fy;
    const moveAngle = Math.atan2(dy, dx);

    let bestReceiver: Track | null = null;
    let bestScore = 0;

    for (const t of tracks) {
      if (t.id === passer.id) continue;
      const tPos = lastFieldPos(t);
      if (!tPos) continue;

      const dist = fieldDistance(passerPos, tPos);
      if (dist < 3 || dist > 50) continue; // too close or too far

      // Angle to potential receiver
      const angleToReceiver = Math.atan2(tPos.fy - passerPos.fy, tPos.fx - passerPos.fx);
      const angleDiff = Math.abs(normalizeAngle(angleToReceiver - moveAngle)) * (180 / Math.PI);

      if (angleDiff < this.config.passAngleThresholdDeg) {
        const score = (1 - angleDiff / 90) * (1 - Math.min(dist, 40) / 50);
        if (score > bestScore) {
          bestScore = score;
          bestReceiver = t;
        }
      }
    }

    return bestReceiver;
  }

  private computePassAngle(from: { fx: number; fy: number }, to: { fx: number; fy: number }): number {
    return Math.atan2(to.fy - from.fy, to.fx - from.fx) * (180 / Math.PI);
  }

  /**
   * @deprecated Use computeXgSimple() from xgModel.ts (Sprint 6).
   * Kept as thin delegation for backward compatibility.
   */
  private estimateXG(pos: { fx: number; fy: number }): number {
    return computeXgSimple(pos.fx, pos.fy);
  }
}

/* ── Utility Functions ────────────────────────────────────────── */

function lastFieldPos(track: Track): { fx: number; fy: number } | null {
  const positions = track.positions;
  if (!positions || positions.length === 0) return null;
  const last = positions[positions.length - 1];
  return { fx: last.fx, fy: last.fy };
}

function fieldDistance(a: { fx: number; fy: number }, b: { fx: number; fy: number }): number {
  return Math.sqrt((a.fx - b.fx) ** 2 + (a.fy - b.fy) ** 2);
}

function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
