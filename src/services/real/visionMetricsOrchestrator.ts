/**
 * VITAS · Vision Metrics Orchestrator (Sprint 9)
 *
 * Client-side service that unifies all existing vision extractors
 * into a single coherent output. Does NOT call any API — all
 * processing happens in the browser via existing engines.
 *
 * Inputs: raw tracking data from YOLO, MediaPipe, EventDetectionEngine
 * Output: unified VisionMetrics object for downstream consumers
 *
 * This replaces the plan's proposed server-side "_vision-metrics-extractor.ts"
 * because YOLO/MediaPipe run client-side.
 */

import type { BiomechanicsScore } from "@/lib/mediapipe/biomechanicsEngine";
import type { EventSummary, TacticalEvent } from "@/lib/tracking/eventDetectionEngine";
import type { FatigueReport } from "@/lib/fatigue/types";
import type { XgSummary } from "@/lib/xg/xgAccumulator";
import { metricsTrustworthy, type CalibrationConfidence } from "@/lib/yolo/fieldRegistration";

// ─── Output types ───────────────────────────────────────────────────────────

export interface VisionPhysicalMetrics {
  distanceCoveredM: number;
  maxSpeedMs: number;
  avgSpeedMs: number;
  sprintCount: number;
  /** Intensity zones derived from speed thresholds */
  intensityZones: {
    walkMinutes: number;   // <1.5 m/s
    jogMinutes: number;    // 1.5-3.5 m/s
    runMinutes: number;    // 3.5-5.5 m/s
    sprintMinutes: number; // >5.5 m/s
  };
}

export interface VisionMetrics {
  /** Source confidence: how much data backs these metrics */
  confidence: {
    level: "high" | "medium" | "low";
    score: number;           // 0-100
    dataPoints: number;      // how many frames/events contributed
    sources: string[];       // e.g., ["yolo", "mediapipe", "eventEngine"]
  };

  /**
   * ¿Son FIABLES las métricas físicas en metros? Solo si el campo se calibró
   * (metricsTrustworthy). Si es false, la UI NO debe presentar m/s ni metros
   * como medida — mostrar "sin calibrar" en vez de un número inventado.
   */
  physicalReliable: boolean;
  /** Confianza de calibración que respaldó (o no) las métricas físicas. */
  calibrationConfidence: CalibrationConfidence;

  /** Physical metrics from YOLO tracking */
  physical: VisionPhysicalMetrics;

  /** Technical/tactical events from EventDetectionEngine */
  events: EventSummary;

  /** Raw tactical events (up to 500) */
  tacticalEvents: TacticalEvent[];

  /** Biomechanics from MediaPipe */
  biomechanics: BiomechanicsScore | null;

  /** Fatigue analysis */
  fatigue: FatigueReport | null;

  /** xG data */
  xg: XgSummary | null;

  /** Session metadata */
  session: {
    durationSec: number;
    playerId: string;
    videoId: string | null;
    analyzedAt: string;
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface VisionInputs {
  playerId: string;
  videoId: string | null;
  durationSec: number;

  /**
   * Confianza de la CALIBRACIÓN del campo (gate honesto). Sin ella (o low/none)
   * las métricas físicas en metros son píxeles disfrazados → NO fiables. Default
   * "none": si el caller no la pasa, se asume no calibrado (fail-closed).
   */
  calibrationConfidence?: CalibrationConfidence;

  // From YOLO tracker
  distanceCoveredM?: number;
  maxSpeedMs?: number;
  avgSpeedMs?: number;
  sprintCount?: number;
  trackCount?: number;
  /** Speed samples for intensity zone calculation (m/s per frame) */
  speedSamples?: number[];

  // From EventDetectionEngine
  eventSummary?: EventSummary;
  tacticalEvents?: TacticalEvent[];

  // From MediaPipe
  biomechanics?: BiomechanicsScore;

  // From FatigueEngine
  fatigue?: FatigueReport;

  // From XgAccumulator
  xg?: XgSummary;

  // Scan counts from PoseAnalyzer (sin duelos: P1 bloque 6, src/lib/tracking/duels.ts)
  scanCount?: number;
}

/**
 * Orchestrate all vision data into a unified metrics object.
 * Pure function — no side effects, no API calls.
 */
export function orchestrateVisionMetrics(inputs: VisionInputs): VisionMetrics {
  const sources: string[] = [];
  let dataPoints = 0;

  // Gate honesto: las métricas físicas en metros solo son fiables si el campo se
  // calibró. Sin calibración válida, el tracking NO cuenta como fuente fiable (no
  // debe inflar la confianza) y physicalReliable=false → la UI mostrará "sin calibrar".
  const calibrationConfidence: CalibrationConfidence = inputs.calibrationConfidence ?? "none";
  const physicalReliable = metricsTrustworthy(calibrationConfidence);

  // ── Physical metrics ──────────────────────────────────────────
  const hasTracking = (inputs.distanceCoveredM ?? 0) > 0 || (inputs.trackCount ?? 0) > 0;
  if (hasTracking && physicalReliable) {
    sources.push("yolo");
    dataPoints += inputs.trackCount ?? 1;
  }

  const intensityZones = calculateIntensityZones(
    inputs.speedSamples ?? [],
    inputs.durationSec,
  );

  const physical: VisionPhysicalMetrics = {
    distanceCoveredM: inputs.distanceCoveredM ?? 0,
    maxSpeedMs: inputs.maxSpeedMs ?? 0,
    avgSpeedMs: inputs.avgSpeedMs ?? 0,
    sprintCount: inputs.sprintCount ?? 0,
    intensityZones,
  };

  // ── Events ────────────────────────────────────────────────────
  const hasEvents = (inputs.eventSummary?.totalEvents ?? 0) > 0;
  if (hasEvents) {
    sources.push("eventEngine");
    dataPoints += inputs.eventSummary?.totalEvents ?? 0;
  }

  const events: EventSummary = inputs.eventSummary ?? {
    totalEvents: 0,
    byType: {} as EventSummary["byType"],
    passCompletionPct: 0,
    passesAttempted: 0,
    passesCompleted: 0,
    recoveries: 0,
    sprintBursts: 0,
    pressTriggers: 0,
    shots: 0,
    xgContributions: 0,
    vaepApprox: 0,
  };

  // ── Biomechanics ──────────────────────────────────────────────
  if (inputs.biomechanics) {
    sources.push("mediapipe");
    dataPoints += 100; // MediaPipe processes many frames
  }

  // ── Fatigue ───────────────────────────────────────────────────
  if (inputs.fatigue) {
    sources.push("fatigueEngine");
  }

  // ── xG ────────────────────────────────────────────────────────
  if (inputs.xg) {
    sources.push("xgModel");
  }

  // ── Confidence calculation ────────────────────────────────────
  const confidenceScore = calculateConfidence(sources, dataPoints, inputs.durationSec);

  return {
    confidence: {
      level: confidenceScore >= 70 ? "high" : confidenceScore >= 40 ? "medium" : "low",
      score: confidenceScore,
      dataPoints,
      sources,
    },
    physicalReliable,
    calibrationConfidence,
    physical,
    events,
    tacticalEvents: inputs.tacticalEvents ?? [],
    biomechanics: inputs.biomechanics ?? null,
    fatigue: inputs.fatigue ?? null,
    xg: inputs.xg ?? null,
    session: {
      durationSec: inputs.durationSec,
      playerId: inputs.playerId,
      videoId: inputs.videoId,
      analyzedAt: new Date().toISOString(),
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Calculate intensity zones from speed samples */
function calculateIntensityZones(
  speedSamples: number[],
  totalDurationSec: number,
): VisionPhysicalMetrics["intensityZones"] {
  if (speedSamples.length === 0 || totalDurationSec <= 0) {
    return { walkMinutes: 0, jogMinutes: 0, runMinutes: 0, sprintMinutes: 0 };
  }

  const frameSeconds = totalDurationSec / speedSamples.length;
  let walk = 0, jog = 0, run = 0, sprint = 0;

  for (const speed of speedSamples) {
    if (speed > 5.5) sprint += frameSeconds;
    else if (speed > 3.5) run += frameSeconds;
    else if (speed > 1.5) jog += frameSeconds;
    else walk += frameSeconds;
  }

  return {
    walkMinutes: Math.round((walk / 60) * 10) / 10,
    jogMinutes: Math.round((jog / 60) * 10) / 10,
    runMinutes: Math.round((run / 60) * 10) / 10,
    sprintMinutes: Math.round((sprint / 60) * 10) / 10,
  };
}

/** Calculate confidence score based on available data sources */
function calculateConfidence(
  sources: string[],
  dataPoints: number,
  durationSec: number,
): number {
  let score = 0;

  // Source diversity (max 40 points)
  score += Math.min(40, sources.length * 10);

  // Data density (max 30 points)
  const pointsPerMinute = durationSec > 0 ? (dataPoints / (durationSec / 60)) : 0;
  score += Math.min(30, pointsPerMinute * 0.5);

  // Duration bonus (max 20 points) — longer videos = more data
  const durationMinutes = durationSec / 60;
  score += Math.min(20, durationMinutes * 2);

  // Has biomechanics bonus (10 points)
  if (sources.includes("mediapipe")) score += 10;

  return Math.min(100, Math.round(score));
}

/**
 * Create a minimal snapshot object for persistence via progression-tracker.
 * Extracts the key metrics that should be stored longitudinally.
 */
export function toMetricSnapshot(metrics: VisionMetrics) {
  return {
    player_id: metrics.session.playerId,
    snapshot_date: metrics.session.analyzedAt.slice(0, 10),
    vsi: null as number | null, // Filled by pipeline orchestrator
    injury_risk: metrics.biomechanics?.injuryRisk ?? null,
    fatigue_index: metrics.fatigue?.fatigueIndex?.value ?? null,
    acwr: metrics.fatigue?.acwr?.value ?? null,
    event_summary: metrics.events,
    xg_accumulated: metrics.xg?.totalXg ?? null,
    source: "video_analysis",
  };
}
