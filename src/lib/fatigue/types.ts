/**
 * VITAS · Fatigue Detection System — Types
 *
 * Comprehensive fatigue monitoring combining:
 * - Metabolic Power (Osgnach 2010)
 * - Sprint/Speed Decay analysis
 * - Pose-based exhaustion signals (MediaPipe)
 * - ACWR multi-session workload (EWMA)
 * - PHV-adjusted thresholds for youth
 *
 * Unique differentiator: no competitor adjusts fatigue thresholds
 * by biological maturation (PHV offset).
 */

// ─── Fatigue Window Metrics (per 15-minute segment) ────────────────────────

export interface FatigueWindowMetrics {
  /** Window index (0 = first 15 min) */
  windowIndex: number;
  /** Start minute of this window */
  startMinute: number;
  /** End minute of this window */
  endMinute: number;
  /** Total distance covered in this window (meters) */
  distanceM: number;
  /** Number of sprints in this window */
  sprintCount: number;
  /** Distance covered during sprints (meters) */
  sprintDistanceM: number;
  /** Average speed in this window (m/s) */
  avgSpeedMs: number;
  /** Max speed in this window (m/s) */
  maxSpeedMs: number;
  /** High-intensity distance: distance at >4.0 m/s (>14.4 km/h) */
  highIntensityDistanceM: number;
  /** Number of accelerations >2.5 m/s² */
  accelerationCount: number;
  /** Number of decelerations <-2.5 m/s² */
  decelerationCount: number;
  /** Average metabolic power for this window (W/kg) */
  metabolicPowerWkg: number;
  /** High Metabolic Load Distance: distance when P > 25.5 W/kg (meters) */
  hmldM: number;
  /** Player Load: cumulative acceleration magnitude √(Δax²+Δay²) */
  playerLoad: number;
  /** Number of position samples in this window */
  sampleCount: number;
}

// ─── Decay Metrics (comparing periods) ──────────────────────────────────────

export interface DecayMetrics {
  /** Sprint count decay: (2nd_half - 1st_half) / 1st_half × 100 */
  sprintDecayPct: number | null;
  /** Max speed decay: (last15 - first15) / first15 × 100 */
  speedDecayPct: number | null;
  /** High-intensity distance decay: (last30 - first30) / first30 × 100 */
  hidDecayPct: number | null;
  /** Metabolic power trend: (last30 - first30) / first30 × 100 */
  metabolicDecayPct: number | null;
  /** Acceleration capacity decay: (last30 - first30) / first30 × 100 */
  accelDecayPct: number | null;
}

// ─── Fatigue Index (composite score 0-100) ──────────────────────────────────

export type FatigueSeverity = "normal" | "moderate" | "high" | "critical";

export interface FatigueIndex {
  /**
   * Composite fatigue score 0-100. null ⇒ not presentable (see gate_reason): too
   * short a session, no decay component, or maturation not registered (P1 block 4:
   * 60% of its weight comes from band-dependent counts).
   */
  value: number | null;
  /** Severity classification; null whenever value is null (no traffic light). */
  severity: FatigueSeverity | null;
  /** Why value/severity are null; null when presentable. */
  gate_reason: string | null;
  /** Individual component contributions (0-100 each, pre-weighting) */
  components: {
    sprintDecay: number;
    speedDecay: number;
    hidDecay: number;
    metabolicDecay: number;
    accelDecay: number;
  };
  /** Decay metrics used for calculation */
  decay: DecayMetrics;
  /** Whether there was enough data to compute reliably */
  reliable: boolean;
  /** Minimum minutes of data needed for reliable computation */
  minimumMinutesRequired: number;
}

// ─── Posture-Based Fatigue Signals (MediaPipe) ──────────────────────────────

export type PostureSignalType =
  | "hands_on_knees"
  | "trunk_lean_increase"
  | "stride_shortening"
  | "recovery_time_increase"
  | "arm_swing_decay"
  | "head_drop";

export interface PostureSignal {
  /** Type of posture signal */
  type: PostureSignalType;
  /** 0-1 severity score */
  severity: number;
  /** Whether this signal is currently active */
  active: boolean;
  /** Timestamp (ms) when first detected */
  firstDetectedMs: number;
  /** Number of occurrences */
  occurrences: number;
  /** Human-readable description */
  description: string;
}

export interface PostureFatigueResult {
  /** All detected posture signals */
  signals: PostureSignal[];
  /** Composite posture fatigue score (0-100) */
  postureScore: number;
  /** Total frames analyzed */
  framesAnalyzed: number;
  /** Confidence (0-1) based on keypoint visibility */
  confidence: number;
}

// ─── ACWR (Acute:Chronic Workload Ratio) ────────────────────────────────────

export type ACWRZone = "undertrained" | "optimal" | "caution" | "danger";

export interface ACWRResult {
  /** ACWR value (typically 0.5-2.0). null with fewer than 4 sessions or no chronic load. */
  value: number | null;
  /**
   * Risk zone (the traffic light). null when value is null, when the history is not
   * reliable, or when maturation is not registered (owner decision, P1 block 4:
   * no maturation ⇒ no traffic light; the load is still shown).
   */
  zone: ACWRZone | null;
  /** Acute EWMA load (last 7 days); null when not computed. */
  acuteLoad: number | null;
  /** Chronic EWMA load (last 28 days); null when not computed. */
  chronicLoad: number | null;
  /** Number of sessions used for chronic calculation */
  sessionsUsed: number;
  /** Whether we have enough history (need ≥4 sessions for reliability) */
  reliable: boolean;
  /** Human-readable recommendation; null when there is no zone. */
  recommendation: string | null;
  /** Why value/zone are null; null when the zone is presentable. */
  gate_reason: string | null;
}

// ─── PHV-Adjusted Fatigue Thresholds ────────────────────────────────────────

/**
 * "unknown" = maturation not registered (PHV gate closed). It lives ONLY in the
 * fatigue type, never in the PHV gate's phases (invariant 4). Before P1 block 4 an
 * unknown offset was silently classified as "post_phv" (adult thresholds).
 */
export type MaturationBand = "pre_phv" | "circa_phv" | "post_phv" | "unknown";

export interface FatigueThresholds {
  /** Maturation band based on PHV offset */
  band: MaturationBand;
  /** PHV offset value used */
  phvOffset: number | null;
  /** true only when maturation-adjusted thresholds are applied (pre/circa PHV). */
  adjusted: boolean;
  /**
   * Set when maturation is unknown: the counting thresholds below are the standard
   * (unadjusted) measurement definitions, and every risk classification (fatigue
   * severity, ACWR zone, alerts) is blocked.
   */
  gate_reason: string | null;
  /** Sprint speed threshold (m/s) — default adult: 5.83 */
  sprintThresholdMs: number;
  /** High-intensity speed threshold (m/s) — default adult: 4.0 */
  highIntensityThresholdMs: number;
  /** Metabolic power warning threshold (W/kg) — default adult: 25.5 */
  metabolicWarningWkg: number;
  /** ACWR danger zone lower bound — default adult: 1.5. null when maturation is unknown. */
  acwrDangerThreshold: number | null;
  /** ACWR caution zone lower bound — default adult: 1.3. null when maturation is unknown. */
  acwrCautionThreshold: number | null;
  /** Acceleration threshold (m/s²) — default adult: 2.5 */
  accelThresholdMs2: number;
  /** Deceleration threshold (m/s²) — default adult: -2.5 */
  decelThresholdMs2: number;
}

// ─── Fatigue Alert ──────────────────────────────────────────────────────────

export type FatigueAlertLevel = "info" | "warning" | "danger";

export interface FatigueAlert {
  /** Alert level */
  level: FatigueAlertLevel;
  /** Source metric that triggered this alert */
  source: "fatigue_index" | "acwr" | "posture" | "sprint_decay" | "metabolic";
  /** Short title */
  title: string;
  /** Detailed message */
  message: string;
  /** Timestamp when detected */
  detectedAt: number;
  /** Whether the alert includes PHV adjustment context */
  phvAdjusted: boolean;
}

// ─── Complete Fatigue Report ────────────────────────────────────────────────

export interface FatigueReport {
  /** Fatigue index (composite score) */
  fatigueIndex: FatigueIndex;
  /** Per-window metrics */
  windows: FatigueWindowMetrics[];
  /** Posture-based fatigue signals */
  posture: PostureFatigueResult | null;
  /** ACWR (null if no historical sessions) */
  acwr: ACWRResult | null;
  /** PHV-adjusted thresholds used */
  thresholds: FatigueThresholds;
  /** Active alerts */
  alerts: FatigueAlert[];
  /** Session duration analyzed (minutes) */
  sessionDurationMin: number;
  /**
   * Session load (Σ metabolic power) — the value ACWR is built from. Optional so
   * reports stored before P1 block 4 still parse; null when no positions.
   */
  totalMetabolicLoad?: number | null;
  /** Player ID */
  playerId: string;
  /** Timestamp of analysis */
  analyzedAt: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface FatigueEngineConfig {
  /** Window size in minutes (default: 15) */
  windowMinutes: number;
  /** Minimum session duration (min) for reliable fatigue index */
  minSessionMinutes: number;
  /** FI component weights (must sum to 1.0) */
  weights: {
    sprintDecay: number;
    speedDecay: number;
    hidDecay: number;
    metabolicDecay: number;
    accelDecay: number;
  };
  /**
   * Minimum share of the FI weights that must come from components actually
   * computed (missing ones are left out and the rest renormalised). Below it the
   * index is null. 0.7 = pendiente de validar (same pattern as the video VSI, G4).
   */
  minWeightCoverage: number;
  /** Severity thresholds for FI */
  severityThresholds: {
    moderate: number; // FI >= this → moderate
    high: number;     // FI >= this → high
    critical: number; // FI >= this → critical
  };
}

export const DEFAULT_FATIGUE_CONFIG: FatigueEngineConfig = {
  windowMinutes: 15,
  minSessionMinutes: 20,
  weights: {
    sprintDecay: 0.30,
    speedDecay: 0.25,
    hidDecay: 0.20,
    metabolicDecay: 0.15,
    accelDecay: 0.10,
  },
  minWeightCoverage: 0.7,
  severityThresholds: {
    moderate: 25,
    high: 50,
    critical: 75,
  },
};
