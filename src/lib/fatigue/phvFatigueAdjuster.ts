/**
 * VITAS · PHV Fatigue Threshold Adjuster
 *
 * Adjusts fatigue detection thresholds based on biological maturation (PHV offset).
 * This is VITAS's unique differentiator — no competitor adjusts fatigue/workload
 * thresholds by biological age.
 *
 * Rationale:
 * - Pre-PHV (<-2): Lower muscle mass, fatigues faster, higher injury risk at
 *   lower absolute workloads. Sprint threshold ×0.75, ACWR danger at 1.3.
 * - Circa-PHV (-2 to +1): Active growth spurt, vulnerable tendons/ligaments,
 *   increased injury risk. Sprint threshold ×0.85, ACWR danger at 1.4.
 * - Post-PHV (>+1): Approaching adult physiology. Standard adult thresholds.
 * - Unknown (no PHV offset: maturation not registered, the PHV gate is closed):
 *   NOT treated as adult any more (P1 block 4). The standard definitions are kept
 *   only to COUNT (what a sprint is), and every risk classification is blocked
 *   with MATURATION_UNKNOWN_REASON — owner decision: no maturation ⇒ no traffic
 *   light, the load is still shown.
 *
 * References:
 * - Mirwald et al. 2002 (PHV calculation)
 * - Wrigley et al. 2014 (injury risk during growth spurt)
 * - Cumming et al. 2018 (maturation-adjusted training load)
 * - Read et al. 2018 (ACWR in youth football)
 */

import type { FatigueThresholds, MaturationBand } from "./types";

// ─── Adult Baseline Thresholds ──────────────────────────────────────────────

const ADULT_THRESHOLDS: Omit<FatigueThresholds, "band" | "phvOffset" | "adjusted" | "gate_reason"> = {
  sprintThresholdMs: 5.83,         // ~21 km/h
  highIntensityThresholdMs: 4.0,   // ~14.4 km/h
  metabolicWarningWkg: 25.5,       // W/kg (di Prampero 2005)
  acwrDangerThreshold: 1.5,
  acwrCautionThreshold: 1.3,
  accelThresholdMs2: 2.5,
  decelThresholdMs2: -2.5,
};

// ─── PHV Band Multipliers ───────────────────────────────────────────────────

interface BandAdjustment {
  sprintMultiplier: number;
  hidMultiplier: number;
  metabolicMultiplier: number;
  acwrDanger: number;
  acwrCaution: number;
  accelMultiplier: number;
}

const BAND_ADJUSTMENTS: Record<Exclude<MaturationBand, "unknown">, BandAdjustment> = {
  pre_phv: {
    sprintMultiplier: 0.75,     // 5.83 × 0.75 = 4.37 m/s
    hidMultiplier: 0.80,        // 4.0 × 0.80 = 3.2 m/s
    metabolicMultiplier: 0.78,  // 25.5 × 0.78 = ~20 W/kg
    acwrDanger: 1.3,
    acwrCaution: 1.1,
    accelMultiplier: 0.80,
  },
  circa_phv: {
    sprintMultiplier: 0.85,     // 5.83 × 0.85 = 4.96 m/s
    hidMultiplier: 0.88,        // 4.0 × 0.88 = 3.5 m/s
    metabolicMultiplier: 0.86,  // 25.5 × 0.86 = ~22 W/kg
    acwrDanger: 1.4,
    acwrCaution: 1.2,
    accelMultiplier: 0.88,
  },
  post_phv: {
    sprintMultiplier: 1.0,
    hidMultiplier: 1.0,
    metabolicMultiplier: 1.0,
    acwrDanger: 1.5,
    acwrCaution: 1.3,
    accelMultiplier: 1.0,
  },
};

// ─── Main Function ──────────────────────────────────────────────────────────

/** Why every fatigue/load risk classification is blocked when maturation is unknown. */
export const MATURATION_UNKNOWN_REASON =
  "Maduración no registrada: sin las medidas para el PHV no se sabe qué umbrales de carga corresponden " +
  "a este jugador, así que no se clasifica el riesgo (sin semáforo). La carga se muestra igualmente.";

/**
 * Compute fatigue thresholds adjusted for biological maturation.
 *
 * @param phvOffset - PHV offset in years (negative = pre-PHV, positive = post-PHV),
 *                    from the PHV gate. null → band "unknown": standard counting
 *                    definitions, no ACWR thresholds, gate_reason set.
 */
export function adjustFatigueThresholds(phvOffset: number | null): FatigueThresholds {
  const band = classifyBand(phvOffset);
  if (band === "unknown") {
    return {
      band,
      phvOffset: null,
      adjusted: false,
      gate_reason: MATURATION_UNKNOWN_REASON,
      // Standard measurement definitions, used ONLY to count (not to classify risk).
      sprintThresholdMs: ADULT_THRESHOLDS.sprintThresholdMs,
      highIntensityThresholdMs: ADULT_THRESHOLDS.highIntensityThresholdMs,
      metabolicWarningWkg: ADULT_THRESHOLDS.metabolicWarningWkg,
      acwrDangerThreshold: null,
      acwrCautionThreshold: null,
      accelThresholdMs2: ADULT_THRESHOLDS.accelThresholdMs2,
      decelThresholdMs2: ADULT_THRESHOLDS.decelThresholdMs2,
    };
  }
  const adj = BAND_ADJUSTMENTS[band];

  return {
    band,
    phvOffset,
    adjusted: band !== "post_phv",
    gate_reason: null,
    sprintThresholdMs: round3(ADULT_THRESHOLDS.sprintThresholdMs * adj.sprintMultiplier),
    highIntensityThresholdMs: round3(ADULT_THRESHOLDS.highIntensityThresholdMs * adj.hidMultiplier),
    metabolicWarningWkg: round3(ADULT_THRESHOLDS.metabolicWarningWkg * adj.metabolicMultiplier),
    acwrDangerThreshold: adj.acwrDanger,
    acwrCautionThreshold: adj.acwrCaution,
    accelThresholdMs2: round3(ADULT_THRESHOLDS.accelThresholdMs2 * adj.accelMultiplier),
    decelThresholdMs2: round3(ADULT_THRESHOLDS.decelThresholdMs2 * adj.accelMultiplier),
  };
}

/**
 * Classify a PHV offset into a maturation band. No offset ⇒ "unknown" (before P1
 * block 4 it was "post_phv", i.e. adult thresholds applied in silence).
 */
export function classifyBand(phvOffset: number | null): MaturationBand {
  if (phvOffset === null || phvOffset === undefined || !Number.isFinite(phvOffset)) return "unknown";
  if (phvOffset < -2) return "pre_phv";
  if (phvOffset <= 1) return "circa_phv";
  return "post_phv";
}

/**
 * Get human-readable description for a maturation band in Spanish.
 */
export function bandDescription(band: MaturationBand): string {
  switch (band) {
    case "pre_phv":
      return "Pre-pico de crecimiento — umbrales reducidos para proteger desarrollo muscular";
    case "circa_phv":
      return "Pico de crecimiento activo — umbrales ajustados por vulnerabilidad musculoesquelética";
    case "post_phv":
      return "Post-pico de crecimiento — umbrales estándar de adulto";
    case "unknown":
      return "Maduración no registrada — conteo con definiciones estándar, sin clasificar el riesgo";
  }
}

/**
 * ¿La banda guardada (sesión de fatiga, snapshot) corresponde a una maduración
 * CONOCIDA? Antes del bloque 4 un offset desconocido se guardaba como "post_phv"
 * con offset null: ese par se trata como desconocido. Una banda ausente o no
 * reconocida, también.
 */
export function maturationKnown(band: unknown, phvOffset: unknown): boolean {
  if (band === "pre_phv" || band === "circa_phv") return true;
  if (band === "post_phv") return typeof phvOffset === "number" && Number.isFinite(phvOffset);
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
