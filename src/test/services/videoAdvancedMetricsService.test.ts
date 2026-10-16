import { describe, it, expect, beforeEach } from "vitest";
import { VideoAdvancedMetricsService } from "@/services/real/videoAdvancedMetricsService";
import { _resetJitter, type VideoObservationPacket } from "@/services/real/videoMetricsExtractor";
import type { Player } from "@/services/real/playerService";

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: "p1",
    name: "Test Player",
    age: 16,
    position: "Delantero",
    foot: "right",
    height: 175,
    weight: 68,
    competitiveLevel: "Regional",
    minutesPlayed: 450,
    metrics: {
      speed: 72, technique: 68, vision: 65, stamina: 70, shooting: 74, defending: 55,
    },
    vsi: 72,
    vsiHistory: [70, 71, 72],
    gender: "M",
    phvCategory: "ontme",
    phvOffset: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-04-01T00:00:00Z",
    ...overrides,
  };
}

function makePacket(): VideoObservationPacket {
  return {
    durationSec: 5400,
    minutesPlayed: 90,
    events: [
      { tSec: 10, type: "pass", result: "success", fromZone: "mid-center", toZone: "att-center" },
      { tSec: 25, type: "dribble", result: "success", fromZone: "att-right" },
      { tSec: 40, type: "shot", result: "success", fromZone: "att-center", impact: 0.8 },
      { tSec: 55, type: "tackle", result: "success", fromZone: "def-center" },
      { tSec: 70, type: "pass", result: "success", fromZone: "mid-right" },
      { tSec: 85, type: "cross", result: "success", fromZone: "att-left" },
    ],
    positioning: {
      dominantZone: "att-center",
      zoneDistribution: { "att-center": 0.5, "mid-center": 0.3, "att-right": 0.2 },
      estimatedMaxSpeedMs: 8.2,
      sprintCount: 6,
    },
    biomechanics: {
      bilateralAsymmetryObserved: 8,
      movementEfficiency: 0.82,
    },
  };
}

describe("VideoAdvancedMetricsService", () => {
  beforeEach(() => _resetJitter());

  describe("calculate()", () => {
    it("calcula métricas avanzadas completas desde video + jugador", () => {
      const player = makePlayer();
      const packet = makePacket();
      const result = VideoAdvancedMetricsService.calculate(player, packet);

      expect(result.vaep.status).toBe("calculated");
      expect(result.vaep.vaepTotal).not.toBeNull();
      expect(result.vaep.vaep90).not.toBeNull();

      expect(result.dominantFeatures.dominant.length).toBeGreaterThan(0);
    });

    it("sin UBI / TruthFilter / «VSI ajustado» / RAE (retirados en el P1 bloque 6, punto 22)", () => {
      const result = VideoAdvancedMetricsService.calculate(makePlayer(), makePacket());
      for (const k of ["rae", "ubi", "truthFilter", "adjustedVSI", "phvValidation"]) {
        expect(result).not.toHaveProperty(k);
      }
    });

    it("VAEP90 es positivo cuando hay acciones mayormente exitosas", () => {
      const player = makePlayer();
      const packet = makePacket();
      const result = VideoAdvancedMetricsService.calculate(player, packet);
      expect(result.vaep.vaep90).toBeGreaterThan(0);
    });

    it("tracking incluye fieldCoverage desde positions", () => {
      const player = makePlayer();
      const packet = makePacket();
      const result = VideoAdvancedMetricsService.calculate(player, packet);
      expect(result.tracking.status).toBe("calculated");
      expect(result.tracking.fieldCoveragePct).not.toBeNull();
    });

    it("biomechanics con datos genera drillScore", () => {
      const player = makePlayer();
      const packet = makePacket();
      const result = VideoAdvancedMetricsService.calculate(player, packet);
      expect(result.biomechanics.status).toBe("calculated");
      expect(result.biomechanics.drillScore).not.toBeNull();
    });

    it("biomechanics sin datos devuelve stub", () => {
      const player = makePlayer();
      const packet = { ...makePacket(), biomechanics: undefined };
      const result = VideoAdvancedMetricsService.calculate(player, packet);
      expect(result.biomechanics.status).toBe("stub_no_data");
    });
  });

  describe("calculateFromRaw()", () => {
    it("acepta packet como objeto JSON", () => {
      const player = makePlayer();
      const raw = {
        durationSec: 5400,
        minutesPlayed: 90,
        events: [{ tSec: 1, type: "pass", result: "success", fromZone: "mid-center" }],
      };
      const result = VideoAdvancedMetricsService.calculateFromRaw(player, raw);
      expect(result.vaep.status).toBe("calculated");
    });

    it("acepta packet como string JSON", () => {
      const player = makePlayer();
      const raw = JSON.stringify({
        durationSec: 5400,
        minutesPlayed: 90,
        events: [{ tSec: 1, type: "pass", result: "success", fromZone: "mid-center" }],
      });
      const result = VideoAdvancedMetricsService.calculateFromRaw(player, raw);
      expect(result.vaep.status).toBe("calculated");
    });

    it("lanza error con packet inválido", () => {
      const player = makePlayer();
      expect(() => VideoAdvancedMetricsService.calculateFromRaw(player, { events: [] }))
        .toThrow("inválido");
    });

    it("lanza error con packet null", () => {
      const player = makePlayer();
      expect(() => VideoAdvancedMetricsService.calculateFromRaw(player, null))
        .toThrow();
    });
  });

  describe("assessPacketQuality()", () => {
    it("packet completo alta calidad tiene score alto", () => {
      const packet = makePacket();
      // Añadir más eventos para pasar threshold >15
      for (let i = 0; i < 15; i++) {
        packet.events.push({
          tSec: 100 + i * 30, type: "pass", result: "success", fromZone: "mid-center",
        });
      }
      const quality = VideoAdvancedMetricsService.assessPacketQuality(packet);
      expect(quality.score).toBeGreaterThan(0.8);
      expect(quality.issues.length).toBeLessThan(2);
    });

    it("packet con pocos eventos tiene issues", () => {
      const packet: VideoObservationPacket = {
        durationSec: 600,
        minutesPlayed: 10,
        events: [
          { tSec: 1, type: "pass", result: "success" },
          { tSec: 2, type: "shot", result: "success" },
        ],
      };
      const quality = VideoAdvancedMetricsService.assessPacketQuality(packet);
      expect(quality.score).toBeLessThan(0.6);
      expect(quality.issues.length).toBeGreaterThan(1);
    });

    it("score está entre 0 y 1", () => {
      const packet: VideoObservationPacket = {
        durationSec: 10, minutesPlayed: 1,
        events: [{ tSec: 1, type: "pass", result: "success" }],
      };
      const quality = VideoAdvancedMetricsService.assessPacketQuality(packet);
      expect(quality.score).toBeGreaterThanOrEqual(0);
      expect(quality.score).toBeLessThanOrEqual(1);
    });

    it("penaliza falta de positioning", () => {
      const packetWith = makePacket();
      const packetWithout = { ...makePacket(), positioning: undefined };
      // Añadir eventos para no penalizar por pocos
      for (let i = 0; i < 20; i++) {
        packetWith.events.push({ tSec: 100 + i, type: "pass", result: "success", fromZone: "mid-center" });
        packetWithout.events.push({ tSec: 100 + i, type: "pass", result: "success", fromZone: "mid-center" });
      }
      const qualityWith = VideoAdvancedMetricsService.assessPacketQuality(packetWith);
      const qualityWithout = VideoAdvancedMetricsService.assessPacketQuality(packetWithout);
      expect(qualityWith.score).toBeGreaterThan(qualityWithout.score);
    });
  });
});
