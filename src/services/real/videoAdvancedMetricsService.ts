/**
 * VITAS · Video-based Advanced Metrics Service
 *
 * Orquesta el pipeline completo:
 *   1. Recibe VideoObservationPacket (generado por agente de video)
 *   2. Extrae SPADL / Tracking / Biomechanics inputs
 *   3. Calcula métricas avanzadas usando advancedMetricsService
 *   4. Devuelve resultado listo para UI
 *
 * Este servicio REEMPLAZA la necesidad de GPS físico (Catapult, StatSports)
 * en el MVP — el video analizado aporta datos suficientes para calcular
 * VAEP, SPADL y una aproximación de biomecánica.
 */
import type { Player } from "./playerService";
import type { AdvancedPlayerMetrics } from "./advancedMetricsService";
import { calculateAdvancedMetrics } from "./advancedMetricsService";
import type { VideoObservationPacket, VideoEvent, FieldZoneApprox } from "./videoMetricsExtractor";
import { VideoMetricsExtractor } from "./videoMetricsExtractor";
import type { TrackingSnapshot } from "./playerTrackingService";
import type { TacticalEvent } from "@/lib/tracking/eventDetectionEngine";
import type { BiomechanicsScore } from "@/lib/mediapipe/biomechanicsEngine";

export const VideoAdvancedMetricsService = {
  /**
   * Calcula métricas avanzadas combinando:
   *   - Datos del jugador (para DominantFeatures)
   *   - Análisis de video (para VAEP, SPADL, Tracking, Biomechanics)
   * Sin RAE/UBI/TruthFilter (retirados en el P1 bloque 6; el trimestre de nacimiento vive
   * en src/lib/shared/relativeAge.ts).
   */
  calculate(
    player: Player,
    packet: VideoObservationPacket,
  ): AdvancedPlayerMetrics {
    const { vaepInput, trackingInput, biomechanicsInput } =
      VideoMetricsExtractor.extract(packet);

    return calculateAdvancedMetrics(player, {
      vaepInput,
      trackingInput,
      biomechanicsInput: biomechanicsInput ?? undefined,
    });
  },

  /**
   * Parsea un packet crudo (JSON string o objeto) y calcula métricas.
   * Lanza error si el packet es inválido.
   */
  calculateFromRaw(
    player: Player,
    rawPacket: unknown,
  ): AdvancedPlayerMetrics {
    const packet = typeof rawPacket === "string"
      ? VideoMetricsExtractor.parseRawPacket(JSON.parse(rawPacket))
      : VideoMetricsExtractor.parseRawPacket(rawPacket);

    if (!packet) {
      throw new Error("Packet de análisis de video inválido o vacío");
    }

    return this.calculate(player, packet);
  },

  /**
   * Evalúa qué tan confiable es el packet para calcular métricas.
   * Returns 0-1: 0 = insuficiente, 1 = excelente.
   */
  assessPacketQuality(packet: VideoObservationPacket): {
    score: number;
    issues: string[];
  } {
    const issues: string[] = [];
    let score = 1.0;

    if (packet.events.length < 10) {
      issues.push(`Pocos eventos detectados (${packet.events.length}). Recomendado: >15.`);
      score -= 0.3;
    }

    if (packet.minutesPlayed < 20) {
      issues.push(`Muestra corta (${packet.minutesPlayed} min). Recomendado: >45 min.`);
      score -= 0.2;
    }

    const eventsWithZone = packet.events.filter(e => e.fromZone || e.toZone).length;
    const zonesCoverage = eventsWithZone / Math.max(1, packet.events.length);
    if (zonesCoverage < 0.5) {
      issues.push("Menos del 50% de eventos tienen zona de campo asignada.");
      score -= 0.15;
    }

    if (!packet.positioning) {
      issues.push("Sin datos de posicionamiento — tracking coverage limitado.");
      score -= 0.1;
    }

    if (!packet.biomechanics) {
      issues.push("Sin observaciones biomecánicas — DrillScore no disponible.");
      score -= 0.1;
    }

    return {
      score: Math.max(0, Math.round(score * 100) / 100),
      issues,
    };
  },
};

// ─── Lab → Profile Bridge ──────────────────────────────────────────────────

/**
 * Converts a VitasLab TrackingSnapshot (with optional tactical events and
 * biomechanics) into a VideoObservationPacket that can be fed through
 * the standard VideoAdvancedMetricsService pipeline.
 *
 * This bridges the gap between Lab-generated data and the advanced metrics
 * system, enabling real VAEP, Tracking, and Biomechanics on the player profile.
 */
export function labSnapshotToObservationPacket(
  snapshot: TrackingSnapshot,
  biomechanics?: BiomechanicsScore | null,
): VideoObservationPacket {
  const events: VideoEvent[] = [];

  // Convert TacticalEvents → VideoEvents (SPADL-compatible)
  if (snapshot.tacticalEvents?.length) {
    for (const te of snapshot.tacticalEvents) {
      const videoType = mapTacticalToVideoType(te.type);
      if (!videoType) continue;

      events.push({
        tSec: te.timestampMs / 1000,
        type: videoType,
        result: te.outcome === "success" ? "success" : "fail",
        fromZone: fieldPointToZone(te.startPosition),
        toZone: te.endPosition ? fieldPointToZone(te.endPosition) : undefined,
        impact: te.confidence * 0.5, // conservative impact from confidence
        confidence: te.confidence,
      });
    }
  }

  // Build positioning from focusPositions
  const positioning = buildPositioning(snapshot);

  // Build biomechanics observation from MediaPipe score
  const bio = biomechanics ?? snapshot.biomechanicsScore;
  const biomechanicsObs = bio
    ? {
        bilateralAsymmetryObserved: bio.asymmetryPct,
        movementEfficiency: bio.runningEfficiency / 100,
        fatigueSignals: bio.injuryRisk > 60,
        dominantFootUsagePct: undefined,
      }
    : undefined;

  return {
    durationSec: snapshot.durationSec,
    minutesPlayed: Math.round(snapshot.durationSec / 60),
    events,
    positioning,
    biomechanics: biomechanicsObs,
  };
}

/** Map TacticalEventType → VideoEvent.type (or null to skip) */
function mapTacticalToVideoType(
  type: TacticalEvent["type"],
): VideoEvent["type"] | null {
  switch (type) {
    case "pass":
    case "shot":
    case "tackle":
    case "interception":
    case "cross":
      return type;
    case "through_ball":
      return "pass";
    case "carry":
      return "dribble";
    case "duel_aerial":
    case "duel_ground":
      return "tackle";
    case "recovery":
      return "interception";
    case "sprint_burst":
      return "run";
    case "press_trigger":
      return "tackle";
    case "set_piece":
      return "pass";
    case "offside_line_break":
      return "run";
    default:
      return null;
  }
}

/** Convert field position (fx 0-105, fy 0-68) to approximate zone */
function fieldPointToZone(pos: { fx: number; fy: number }): FieldZoneApprox {
  const xZone = pos.fx < 35 ? "def" : pos.fx < 70 ? "mid" : "att";
  const yZone = pos.fy < 22.7 ? "right" : pos.fy < 45.3 ? "center" : "left";
  return `${xZone}-${yZone}` as FieldZoneApprox;
}

/** Build VideoPositioning from snapshot's physical metrics + focusPositions */
function buildPositioning(snapshot: TrackingSnapshot) {
  const metrics = snapshot.sessionMetrics;
  const positions = snapshot.focusPositions;

  // Calculate zone distribution from positions
  let zoneDistribution: Partial<Record<FieldZoneApprox, number>> | undefined;
  let dominantZone: FieldZoneApprox | undefined;

  if (positions?.length) {
    const zoneCounts: Partial<Record<FieldZoneApprox, number>> = {};
    for (const p of positions) {
      const zone = fieldPointToZone(p);
      zoneCounts[zone] = (zoneCounts[zone] ?? 0) + 1;
    }
    const total = positions.length;
    zoneDistribution = {};
    let maxCount = 0;
    for (const [zone, count] of Object.entries(zoneCounts)) {
      const pct = count / total;
      zoneDistribution[zone as FieldZoneApprox] = Math.round(pct * 100) / 100;
      if (count > maxCount) {
        maxCount = count;
        dominantZone = zone as FieldZoneApprox;
      }
    }
  }

  return {
    dominantZone,
    zoneDistribution,
    estimatedMaxSpeedMs: metrics.maxSpeedMs,
    sprintCount: metrics.sprintCount,
    estimatedDistanceM: metrics.distanceCoveredM,
  };
}
