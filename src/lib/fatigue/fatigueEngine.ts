/**
 * VITAS · Fatigue Engine
 *
 * Core computation engine for match-day fatigue analysis.
 * Segments tracking data into 15-minute windows and computes:
 * - Distance, sprints, high-intensity distance per window
 * - Metabolic Power (Osgnach et al. 2010)
 * - HMLD (High Metabolic Load Distance, di Prampero 2005)
 * - Player Load (2D acceleration magnitude)
 * - Decay metrics (sprint, speed, HID, metabolic, acceleration)
 * - Composite Fatigue Index (0-100)
 *
 * Thresholds are PHV-adjustable via FatigueThresholds input.
 *
 * P1 block 4 (invariant 2): the Fatigue Index is null (with gate_reason) when the
 * session is too short, when no decay component could be computed, or when
 * maturation is unknown; missing components are left out (weights renormalised)
 * instead of counting as 0. No maturation ⇒ no alerts (owner decision).
 */

import type {
  FatigueWindowMetrics,
  DecayMetrics,
  FatigueIndex,
  FatigueSeverity,
  FatigueEngineConfig,
  FatigueThresholds,
  FatigueAlert,
} from "./types";
import { DEFAULT_FATIGUE_CONFIG } from "./types";

// ─── Input Types ────────────────────────────────────────────────────────────

export interface TrackingPosition {
  x: number;       // field X (meters)
  y: number;       // field Y (meters)
  timestampMs: number;
}

export interface FatigueEngineInput {
  /** Ordered position array with timestamps */
  positions: TrackingPosition[];
  /** Session duration in seconds */
  durationSec: number;
  /** PHV-adjusted thresholds */
  thresholds: FatigueThresholds;
  /** Optional config overrides */
  config?: Partial<FatigueEngineConfig>;
}

export interface FatigueEngineOutput {
  windows: FatigueWindowMetrics[];
  decay: DecayMetrics;
  fatigueIndex: FatigueIndex;
  alerts: FatigueAlert[];
  /** Total metabolic power for ACWR load calculation; null when there are no positions. */
  totalMetabolicLoad: number | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GRAVITY = 9.81; // m/s²

// ─── Metabolic Power (Osgnach et al. 2010) ──────────────────────────────────
/**
 * Metabolic Power = Energy Cost × Velocity
 *
 * Energy Cost (EC) on grass:
 *   EC = (155.4 × e^(−0.012 × θ_deg) − 30.4) / (1 − 0.01 × θ_deg)
 *   where θ_deg = atan(a / g) × (180/π)
 *
 * Simplified for computational efficiency (equivalent acceleration model):
 *   ES (Equivalent Slope) = tan(arctan(a / g)) = a / g
 *   EC = 155.4 × e^(−0.012 × atan(a/g) × 180/π) ... (full form)
 *
 * We use the simplified di Prampero approach:
 *   Equivalent slope = a / g
 *   Energy cost per meter: EC = 155.4 × e^(0.0674 × ES_pct) ... or the
 *   original formulation.
 *
 * For robustness, we use the widely-adopted approximation:
 *   MetabolicPower (W/kg) = EC(a) × |v|
 *   where EC = max(3.6, (155.4 × exp(-0.012 × atan_deg) - 30.4) / (1 - 0.01 × atan_deg))
 *   atan_deg = atan(a / 9.81) × (180/π)
 */
function computeMetabolicPower(velocityMs: number, accelerationMs2: number): number {
  // Angle in degrees
  const atanRad = Math.atan(accelerationMs2 / GRAVITY);
  const atanDeg = atanRad * (180 / Math.PI);

  // Energy cost per meter (J/kg/m) — Osgnach 2010 equation
  // Guard against division by zero when atanDeg ≈ 100
  const denominator = 1 - 0.01 * atanDeg;
  let ec: number;
  if (Math.abs(denominator) < 0.01) {
    ec = 3.6; // Minimum EC (flat walking)
  } else {
    ec = (155.4 * Math.exp(-0.012 * atanDeg) - 30.4) / denominator;
  }

  // Clamp EC to physiological range [3.6, 50] J/kg/m
  ec = Math.max(3.6, Math.min(50, ec));

  // Metabolic power = EC × velocity (W/kg)
  const power = ec * Math.abs(velocityMs);

  return Math.max(0, power);
}

// ─── Core Engine ────────────────────────────────────────────────────────────

export class FatigueEngine {
  private config: FatigueEngineConfig;

  constructor(config?: Partial<FatigueEngineConfig>) {
    this.config = { ...DEFAULT_FATIGUE_CONFIG, ...config };
  }

  /**
   * Process a full session of tracking positions into fatigue metrics.
   */
  analyze(input: FatigueEngineInput): FatigueEngineOutput {
    const cfg = { ...this.config, ...input.config };
    const { positions, durationSec, thresholds } = input;

    if (positions.length < 3) {
      return emptyOutput();
    }

    // ── Sort positions by timestamp ──
    const sorted = [...positions].sort((a, b) => a.timestampMs - b.timestampMs);

    // ── Compute per-sample derived metrics ──
    const samples = this.computeSamples(sorted);

    // ── Segment into windows ──
    const windowMs = cfg.windowMinutes * 60 * 1000;
    const windows = this.segmentIntoWindows(samples, windowMs, thresholds, cfg.windowMinutes);

    // ── Compute decay metrics ──
    const decay = this.computeDecay(windows);

    // ── Compute fatigue index ──
    const durationMin = durationSec / 60;
    const fatigueIndex = this.computeFatigueIndex(decay, cfg, durationMin, thresholds);

    // ── Total metabolic load for ACWR ──
    const totalMetabolicLoad = samples.reduce((sum, s) => sum + s.metabolicPower * s.dt, 0);

    // ── Generate alerts ──
    const alerts = this.generateAlerts(fatigueIndex, decay, thresholds);

    return { windows, decay, fatigueIndex, alerts, totalMetabolicLoad };
  }

  // ── Internal: compute per-sample velocity, acceleration, metabolic power ──

  private computeSamples(positions: TrackingPosition[]) {
    const samples: Array<{
      timestampMs: number;
      velocity: number;
      acceleration: number;
      metabolicPower: number;
      distance: number;
      dt: number; // seconds
    }> = [];

    let prevVel = 0;

    for (let i = 1; i < positions.length; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];

      const dtMs = p1.timestampMs - p0.timestampMs;
      if (dtMs <= 0 || dtMs > 10_000) continue; // Skip bad samples (>10s gap)

      const dt = dtMs / 1000;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const vel = dist / dt;

      // Cap unrealistic velocities (>12 m/s = 43 km/h is beyond any player)
      const cappedVel = Math.min(vel, 12);
      const accel = (cappedVel - prevVel) / dt;

      // Cap acceleration to physiological range [-8, 8] m/s²
      const cappedAccel = Math.max(-8, Math.min(8, accel));

      const mp = computeMetabolicPower(cappedVel, cappedAccel);

      samples.push({
        timestampMs: p1.timestampMs,
        velocity: cappedVel,
        acceleration: cappedAccel,
        metabolicPower: mp,
        distance: dist,
        dt,
      });

      prevVel = cappedVel;
    }

    return samples;
  }

  // ── Internal: segment samples into time windows ──

  private segmentIntoWindows(
    samples: Array<{
      timestampMs: number;
      velocity: number;
      acceleration: number;
      metabolicPower: number;
      distance: number;
      dt: number;
    }>,
    windowMs: number,
    thresholds: FatigueThresholds,
    windowMinutes: number,
  ): FatigueWindowMetrics[] {
    if (samples.length === 0) return [];

    const t0 = samples[0].timestampMs;
    const windows: FatigueWindowMetrics[] = [];

    // Group samples by window
    const windowMap = new Map<number, typeof samples>();
    for (const s of samples) {
      const idx = Math.floor((s.timestampMs - t0) / windowMs);
      if (!windowMap.has(idx)) windowMap.set(idx, []);
      windowMap.get(idx)!.push(s);
    }

    for (const [idx, wSamples] of windowMap) {
      let distance = 0;
      let sprintCount = 0;
      let sprintDist = 0;
      let hidDist = 0;
      let accelCount = 0;
      let decelCount = 0;
      let totalMp = 0;
      let hmld = 0;
      let playerLoad = 0;
      let maxSpeed = 0;
      let totalSpeed = 0;
      let inSprint = false;
      let prevAccel = 0;

      for (const s of wSamples) {
        distance += s.distance;
        totalSpeed += s.velocity;
        if (s.velocity > maxSpeed) maxSpeed = s.velocity;

        // Sprints
        if (s.velocity >= thresholds.sprintThresholdMs) {
          if (!inSprint) {
            sprintCount++;
            inSprint = true;
          }
          sprintDist += s.distance;
        } else {
          inSprint = false;
        }

        // High-intensity distance
        if (s.velocity >= thresholds.highIntensityThresholdMs) {
          hidDist += s.distance;
        }

        // Accelerations / Decelerations
        if (s.acceleration >= thresholds.accelThresholdMs2) accelCount++;
        if (s.acceleration <= thresholds.decelThresholdMs2) decelCount++;

        // Metabolic power
        totalMp += s.metabolicPower;

        // HMLD
        if (s.metabolicPower >= thresholds.metabolicWarningWkg) {
          hmld += s.distance;
        }

        // Player Load (2D): √(Δax² + Δay²) approximated as |accel_change|
        const accelChange = Math.abs(s.acceleration - prevAccel);
        playerLoad += accelChange;
        prevAccel = s.acceleration;
      }

      windows.push({
        windowIndex: idx,
        startMinute: idx * windowMinutes,
        endMinute: (idx + 1) * windowMinutes,
        distanceM: round2(distance),
        sprintCount,
        sprintDistanceM: round2(sprintDist),
        avgSpeedMs: round2(wSamples.length > 0 ? totalSpeed / wSamples.length : 0),
        maxSpeedMs: round2(maxSpeed),
        highIntensityDistanceM: round2(hidDist),
        accelerationCount: accelCount,
        decelerationCount: decelCount,
        metabolicPowerWkg: round2(wSamples.length > 0 ? totalMp / wSamples.length : 0),
        hmldM: round2(hmld),
        playerLoad: round2(playerLoad),
        sampleCount: wSamples.length,
      });
    }

    return windows.sort((a, b) => a.windowIndex - b.windowIndex);
  }

  // ── Internal: compute decay between first half and second half ──

  private computeDecay(windows: FatigueWindowMetrics[]): DecayMetrics {
    if (windows.length < 2) {
      return {
        sprintDecayPct: null,
        speedDecayPct: null,
        hidDecayPct: null,
        metabolicDecayPct: null,
        accelDecayPct: null,
      };
    }

    const mid = Math.floor(windows.length / 2);
    const firstHalf = windows.slice(0, mid);
    const secondHalf = windows.slice(mid);

    const sum = (arr: FatigueWindowMetrics[], key: keyof FatigueWindowMetrics) =>
      arr.reduce((s, w) => s + (w[key] as number), 0);
    const avg = (arr: FatigueWindowMetrics[], key: keyof FatigueWindowMetrics) =>
      arr.length > 0 ? sum(arr, key) / arr.length : 0;
    const max = (arr: FatigueWindowMetrics[], key: keyof FatigueWindowMetrics) =>
      arr.reduce((m, w) => Math.max(m, w[key] as number), 0);

    const decay = (first: number, second: number): number | null => {
      if (first === 0) return null;
      return round2(((second - first) / first) * 100);
    };

    return {
      sprintDecayPct: decay(sum(firstHalf, "sprintCount"), sum(secondHalf, "sprintCount")),
      speedDecayPct: decay(max(firstHalf, "maxSpeedMs"), max(secondHalf, "maxSpeedMs")),
      hidDecayPct: decay(sum(firstHalf, "highIntensityDistanceM"), sum(secondHalf, "highIntensityDistanceM")),
      metabolicDecayPct: decay(avg(firstHalf, "metabolicPowerWkg"), avg(secondHalf, "metabolicPowerWkg")),
      accelDecayPct: decay(sum(firstHalf, "accelerationCount"), sum(secondHalf, "accelerationCount")),
    };
  }

  // ── Internal: compute composite Fatigue Index ──

  private computeFatigueIndex(
    decay: DecayMetrics,
    cfg: FatigueEngineConfig,
    durationMin: number,
    thresholds: FatigueThresholds,
  ): FatigueIndex {
    const reliable = durationMin >= cfg.minSessionMinutes;

    // Normalize decay % to 0-100 score (negative decay = fatigue)
    // A -50% sprint decay → score 50. A -100% → score 100. Positive = no fatigue (0).
    // A component that could not be computed stays null (before: counted as 0).
    const normalize = (pct: number | null): number | null => {
      if (pct === null) return null;
      // Negative = fatigue (player declined). Clamp to [0, 100].
      return Math.max(0, Math.min(100, -pct));
    };

    const parts = {
      sprintDecay: normalize(decay.sprintDecayPct),
      speedDecay: normalize(decay.speedDecayPct),
      hidDecay: normalize(decay.hidDecayPct),
      metabolicDecay: normalize(decay.metabolicDecayPct),
      accelDecay: normalize(decay.accelDecayPct),
    };
    // Mini-bars of the UI: a missing component shows as 0 there, but it does NOT
    // enter the index below.
    const components = {
      sprintDecay: parts.sprintDecay ?? 0,
      speedDecay: parts.speedDecay ?? 0,
      hidDecay: parts.hidDecay ?? 0,
      metabolicDecay: parts.metabolicDecay ?? 0,
      accelDecay: parts.accelDecay ?? 0,
    };
    const blocked = (gate_reason: string): FatigueIndex => ({
      value: null,
      severity: null,
      gate_reason,
      components,
      decay,
      reliable,
      minimumMinutesRequired: cfg.minSessionMinutes,
    });

    if (thresholds.band === "unknown") {
      return blocked(thresholds.gate_reason ?? "Maduración no registrada.");
    }
    if (!reliable) {
      return blocked(`Sesión demasiado corta para el índice de fatiga (mínimo ${cfg.minSessionMinutes} min).`);
    }

    // Weights renormalised over the components that exist (no filler zeros).
    const keys = Object.keys(parts) as Array<keyof typeof parts>;
    const present = keys.filter((k) => parts[k] !== null);
    if (present.length === 0) {
      return blocked("No se pudo comparar ninguna métrica entre la primera y la segunda parte de la sesión.");
    }
    const wsum = present.reduce((acc, k) => acc + cfg.weights[k], 0);
    // Sin cobertura mínima no se rellena con la media de las demás (revisión del PR #315):
    // con un solo componente del 10 % ya salían índice, severidad y alertas.
    // (Comparación directa: con los pesos actuales la frontera 0.25+0.20+0.15+0.10 = 0.7 exacto.)
    if (wsum < cfg.minWeightCoverage) {
      return blocked(
        "Índice no calculado: no se pudieron comparar suficientes métricas entre la primera y la segunda parte de la sesión.",
      );
    }
    const value = round2(present.reduce((acc, k) => acc + (parts[k] as number) * cfg.weights[k], 0) / wsum);

    const clamped = Math.max(0, Math.min(100, value));

    let severity: FatigueSeverity = "normal";
    if (clamped >= cfg.severityThresholds.critical) severity = "critical";
    else if (clamped >= cfg.severityThresholds.high) severity = "high";
    else if (clamped >= cfg.severityThresholds.moderate) severity = "moderate";

    return {
      value: clamped,
      severity,
      gate_reason: null,
      components,
      decay,
      reliable,
      minimumMinutesRequired: cfg.minSessionMinutes,
    };
  }

  // ── Internal: generate alerts ──

  private generateAlerts(
    fi: FatigueIndex,
    decay: DecayMetrics,
    thresholds: FatigueThresholds,
  ): FatigueAlert[] {
    const alerts: FatigueAlert[] = [];
    // No maturation ⇒ no alerts at all (owner decision, P1 block 4).
    if (thresholds.band === "unknown") return alerts;
    const now = Date.now();
    const phvAdjusted = thresholds.adjusted;

    if (fi.value !== null && fi.severity === "critical") {
      alerts.push({
        level: "danger",
        source: "fatigue_index",
        title: "Fatiga Crítica",
        message: `Índice de fatiga ${fi.value.toFixed(0)}/100. Riesgo elevado de lesión. Considerar sustitución inmediata.`,
        detectedAt: now,
        phvAdjusted,
      });
    } else if (fi.value !== null && fi.severity === "high") {
      alerts.push({
        level: "warning",
        source: "fatigue_index",
        title: "Fatiga Alta",
        message: `Índice de fatiga ${fi.value.toFixed(0)}/100. El rendimiento está decayendo significativamente.`,
        detectedAt: now,
        phvAdjusted,
      });
    }

    if (decay.sprintDecayPct !== null && decay.sprintDecayPct < -40) {
      alerts.push({
        level: "warning",
        source: "sprint_decay",
        title: "Caída de Sprints",
        message: `Los sprints cayeron ${Math.abs(decay.sprintDecayPct).toFixed(0)}% en la segunda mitad. Capacidad explosiva comprometida.`,
        detectedAt: now,
        phvAdjusted,
      });
    }

    if (decay.metabolicDecayPct !== null && decay.metabolicDecayPct < -30) {
      alerts.push({
        level: "warning",
        source: "metabolic",
        title: "Caída Metabólica",
        message: `La potencia metabólica cayó ${Math.abs(decay.metabolicDecayPct).toFixed(0)}%. El jugador está bajando intensidad.`,
        detectedAt: now,
        phvAdjusted,
      });
    }

    return alerts;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyOutput(): FatigueEngineOutput {
  return {
    windows: [],
    decay: {
      sprintDecayPct: null,
      speedDecayPct: null,
      hidDecayPct: null,
      metabolicDecayPct: null,
      accelDecayPct: null,
    },
    fatigueIndex: {
      value: null,
      severity: null,
      gate_reason: "Sin posiciones de seguimiento suficientes para analizar la fatiga.",
      components: {
        sprintDecay: 0,
        speedDecay: 0,
        hidDecay: 0,
        metabolicDecay: 0,
        accelDecay: 0,
      },
      decay: {
        sprintDecayPct: null,
        speedDecayPct: null,
        hidDecayPct: null,
        metabolicDecayPct: null,
        accelDecayPct: null,
      },
      reliable: false,
      minimumMinutesRequired: 20,
    },
    alerts: [],
    totalMetabolicLoad: null,
  };
}
