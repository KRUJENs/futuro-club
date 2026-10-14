/**
 * VITAS · useFatigue Hook
 *
 * Combines all fatigue subsystems into a single React hook:
 * - FatigueEngine (metabolic power, windows, decay, FI)
 * - FatiguePostureDetector (MediaPipe pose signals)
 * - ACWR Service (multi-session workload ratio)
 * - PHV Fatigue Adjuster (maturation-based thresholds)
 *
 * Usage:
 *   const fatigue = useFatigue({
 *     playerId: selectedPlayerId,
 *     phvOffset: player.phvOffset,
 *   });
 *
 *   // Feed tracking positions each frame:
 *   fatigue.addPosition(x, y, timestampMs);
 *
 *   // Feed pose data each frame:
 *   fatigue.addPoseFrame(mappedPoseFrame, timestampMs);
 *
 *   // Get report when session ends:
 *   const report = fatigue.generateReport(durationSec);
 */

import { useState, useRef, useCallback, useMemo } from "react";
import { FatigueEngine } from "@/lib/fatigue/fatigueEngine";
import type { TrackingPosition } from "@/lib/fatigue/fatigueEngine";
import { FatiguePostureDetector } from "@/lib/fatigue/fatiguePostureDetector";
import { computeACWR, type SessionLoad } from "@/lib/fatigue/acwrService";
import { adjustFatigueThresholds } from "@/lib/fatigue/phvFatigueAdjuster";
import type {
  FatigueReport,
  FatigueIndex,
  FatigueWindowMetrics,
  FatigueAlert,
  FatigueThresholds,
  PostureFatigueResult,
  ACWRResult,
  FatigueEngineConfig,
} from "@/lib/fatigue/types";
import type { MappedPoseFrame } from "@/lib/mediapipe/keypointMapper";

// ─── Hook Options ───────────────────────────────────────────────────────────

export interface UseFatigueOptions {
  /** Player ID for ACWR history lookup */
  playerId: string;
  /**
   * PHV offset from the PHV gate, for threshold adjustment. null → maturation
   * unknown: standard counting definitions, no risk classification and no alerts
   * (P1 block 4; before: adult thresholds in silence).
   */
  phvOffset?: number | null;
  /** Optional config overrides */
  config?: Partial<FatigueEngineConfig>;
  /** Historical sessions for ACWR (if already loaded) */
  historicalSessions?: SessionLoad[];
}

// ─── Hook State ─────────────────────────────────────────────────────────────

export interface FatigueState {
  /** Current fatigue index (updates as data accumulates) */
  currentIndex: FatigueIndex | null;
  /** Per-window metrics (updates as windows complete) */
  windowMetrics: FatigueWindowMetrics[];
  /** Posture signals from MediaPipe */
  postureSignals: PostureFatigueResult | null;
  /** ACWR result (null if no historical sessions) */
  acwr: ACWRResult | null;
  /** PHV-adjusted thresholds being used */
  thresholds: FatigueThresholds;
  /** Active alerts */
  alerts: FatigueAlert[];
  /** Number of tracking positions collected */
  positionCount: number;
  /** Number of pose frames collected */
  poseFrameCount: number;
  /** Whether a report has been generated */
  reportReady: boolean;
  /** The full report (null until generateReport is called) */
  report: FatigueReport | null;
}

// ─── Hook Return ────────────────────────────────────────────────────────────

export interface UseFatigueReturn extends FatigueState {
  /** Add a tracking position (call per frame from useTracking) */
  addPosition: (x: number, y: number, timestampMs: number) => void;
  /** Add a batch of positions (e.g., from completed tracking session) */
  addPositions: (positions: TrackingPosition[]) => void;
  /** Add a pose frame (call per frame from useMediaPipePose) */
  addPoseFrame: (pose: MappedPoseFrame, timestampMs: number) => void;
  /** Generate the full fatigue report */
  generateReport: (durationSec: number) => FatigueReport;
  /** Reset all state for new session */
  reset: () => void;
}

// ─── Hook Implementation ────────────────────────────────────────────────────

export function useFatigue(options: UseFatigueOptions): UseFatigueReturn {
  const { playerId, phvOffset = null, config, historicalSessions = [] } = options;

  // ── PHV-adjusted thresholds (memoized on phvOffset) ──
  const thresholds = useMemo(
    () => adjustFatigueThresholds(phvOffset),
    [phvOffset],
  );

  // ── Refs for accumulating data (no re-renders per frame) ──
  const positionsRef = useRef<TrackingPosition[]>([]);
  const engineRef = useRef(new FatigueEngine(config));
  const postureDetectorRef = useRef(new FatiguePostureDetector());

  // ── State (only updated at meaningful intervals) ──
  const [state, setState] = useState<FatigueState>({
    currentIndex: null,
    windowMetrics: [],
    postureSignals: null,
    acwr: null,
    thresholds,
    alerts: [],
    positionCount: 0,
    poseFrameCount: 0,
    reportReady: false,
    report: null,
  });

  // ── Add position (high frequency — only update state every 100 positions) ──
  const addPosition = useCallback((x: number, y: number, timestampMs: number) => {
    positionsRef.current.push({ x, y, timestampMs });
    const count = positionsRef.current.length;

    // Update state periodically (every 100 samples ≈ ~12.5s at 8fps)
    if (count % 100 === 0) {
      setState(prev => ({ ...prev, positionCount: count }));
    }
  }, []);

  // ── Add batch of positions ──
  const addPositions = useCallback((positions: TrackingPosition[]) => {
    positionsRef.current.push(...positions);
    setState(prev => ({
      ...prev,
      positionCount: positionsRef.current.length,
    }));
  }, []);

  // ── Add pose frame (high frequency — no state update per frame) ──
  const addPoseFrame = useCallback((pose: MappedPoseFrame, timestampMs: number) => {
    postureDetectorRef.current.addFrame(pose, timestampMs);
  }, []);

  // ── Generate full report ──
  const generateReport = useCallback((durationSec: number): FatigueReport => {
    const positions = positionsRef.current;

    // 1. Run fatigue engine
    const engineResult = engineRef.current.analyze({
      positions,
      durationSec,
      thresholds,
      config,
    });

    // 2. Run posture detector
    const postureResult = postureDetectorRef.current.analyze();

    // 3. Compute ACWR
    const acwrResult = historicalSessions.length > 0 && engineResult.totalMetabolicLoad !== null
      ? computeACWR(historicalSessions, engineResult.totalMetabolicLoad, thresholds)
      : null;

    // 4. Merge posture alerts into engine alerts. No maturation ⇒ no alerts from any
    //    source (owner decision, P1 block 4): the posture signals are still listed.
    const allAlerts = [...engineResult.alerts];
    const maturationKnown = thresholds.band !== "unknown";

    if (maturationKnown && postureResult.postureScore > 50) {
      const activeSignals = postureResult.signals.filter(s => s.active);
      allAlerts.push({
        level: postureResult.postureScore > 75 ? "danger" : "warning",
        source: "posture",
        title: "Señales Posturales de Fatiga",
        message: `Detectadas ${activeSignals.length} señales: ${activeSignals.map(s => s.type.replace(/_/g, " ")).join(", ")}`,
        detectedAt: Date.now(),
        phvAdjusted: thresholds.adjusted,
      });
    }

    if (maturationKnown && acwrResult && (acwrResult.zone === "danger" || acwrResult.zone === "caution")) {
      allAlerts.push({
        level: acwrResult.zone === "danger" ? "danger" : "warning",
        source: "acwr",
        title: acwrResult.zone === "danger" ? "ACWR Zona Peligro" : "ACWR Precaución",
        message: acwrResult.recommendation ?? "",
        detectedAt: Date.now(),
        phvAdjusted: thresholds.adjusted,
      });
    }

    // 5. Build report
    const report: FatigueReport = {
      fatigueIndex: engineResult.fatigueIndex,
      windows: engineResult.windows,
      posture: postureResult,
      acwr: acwrResult,
      thresholds,
      alerts: allAlerts,
      sessionDurationMin: Math.round(durationSec / 60),
      totalMetabolicLoad: engineResult.totalMetabolicLoad,
      playerId,
      analyzedAt: new Date().toISOString(),
    };

    // 6. Update state
    setState({
      currentIndex: engineResult.fatigueIndex,
      windowMetrics: engineResult.windows,
      postureSignals: postureResult,
      acwr: acwrResult,
      thresholds,
      alerts: allAlerts,
      positionCount: positions.length,
      poseFrameCount: postureResult.framesAnalyzed,
      reportReady: true,
      report,
    });

    return report;
  }, [playerId, thresholds, config, historicalSessions]);

  // ── Reset ──
  const reset = useCallback(() => {
    positionsRef.current = [];
    engineRef.current = new FatigueEngine(config);
    postureDetectorRef.current = new FatiguePostureDetector();
    setState({
      currentIndex: null,
      windowMetrics: [],
      postureSignals: null,
      acwr: null,
      thresholds,
      alerts: [],
      positionCount: 0,
      poseFrameCount: 0,
      reportReady: false,
      report: null,
    });
  }, [thresholds, config]);

  return {
    ...state,
    addPosition,
    addPositions,
    addPoseFrame,
    generateReport,
    reset,
  };
}
