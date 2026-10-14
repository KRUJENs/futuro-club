/**
 * VITAS · Tests — MetricsService
 * Verifica: VSI calculation, percentile, trend, classify, normalization
 */
import { describe, it, expect } from "vitest";
import { coachEvalTier, MetricsService } from "@/services/real/metricsService";
import { COACH_EVAL_TIERS, COACH_EVAL_TIERS_SOURCE } from "../../../config/coachEvaluation";

// ── VSI Weights: speed 0.18, technique 0.22, vision 0.20, stamina 0.15, shooting 0.13, defending 0.12

describe("MetricsService", () => {
  describe("calculateVSI", () => {
    it("calcula VSI correcto con pesos definidos", () => {
      const metrics = { speed: 80, technique: 70, vision: 75, stamina: 60, shooting: 65, defending: 50 };
      // Expected: 80*0.18 + 70*0.22 + 75*0.20 + 60*0.15 + 65*0.13 + 50*0.12
      //         = 14.4 + 15.4 + 15.0 + 9.0 + 8.45 + 6.0 = 68.25
      const result = MetricsService.calculateVSI(metrics);
      expect(result).toBe(68.3); // rounded to 1 decimal
    });

    it("retorna 0 con todas las metricas en 0", () => {
      const metrics = { speed: 0, technique: 0, vision: 0, stamina: 0, shooting: 0, defending: 0 };
      expect(MetricsService.calculateVSI(metrics)).toBe(0);
    });

    it("retorna ~100 con metricas maximas", () => {
      const metrics = { speed: 100, technique: 100, vision: 100, stamina: 100, shooting: 100, defending: 100 };
      // 100 * (0.18+0.22+0.20+0.15+0.13+0.12) = 100 * 1.00 = 100
      expect(MetricsService.calculateVSI(metrics)).toBe(100);
    });

    it("technique tiene mas peso que defending", () => {
      const highTech = { speed: 50, technique: 90, vision: 50, stamina: 50, shooting: 50, defending: 50 };
      const highDef = { speed: 50, technique: 50, vision: 50, stamina: 50, shooting: 50, defending: 90 };
      expect(MetricsService.calculateVSI(highTech)).toBeGreaterThan(MetricsService.calculateVSI(highDef));
    });
  });

  describe("calculateTrend", () => {
    it("retorna 'up' si delta > 2", () => {
      expect(MetricsService.calculateTrend(70, 67)).toBe("up");
    });

    it("retorna 'down' si delta < -2", () => {
      expect(MetricsService.calculateTrend(65, 68)).toBe("down");
    });

    it("retorna 'stable' si delta entre -2 y +2", () => {
      expect(MetricsService.calculateTrend(70, 69)).toBe("stable");
      expect(MetricsService.calculateTrend(70, 71)).toBe("stable");
      expect(MetricsService.calculateTrend(70, 70)).toBe("stable");
    });

    it("boundary: delta exactamente 2 es stable", () => {
      expect(MetricsService.calculateTrend(72, 70)).toBe("stable");
    });

    it("boundary: delta 2.1 es up", () => {
      expect(MetricsService.calculateTrend(72.1, 70)).toBe("up");
    });
  });

  // (calculatePercentile retirado en el P1 bloque 5: devolvía 50 con el grupo vacío y no
  //  tenía mínimo de pares. El percentil entre pares vive en src/lib/metrics/percentile.ts,
  //  probado en src/test/lib/percentile.test.ts.)
  it("ya no expone calculatePercentile ni getVSIResult (implementación única de percentil)", () => {
    expect((MetricsService as Record<string, unknown>).calculatePercentile).toBeUndefined();
    expect((MetricsService as Record<string, unknown>).getVSIResult).toBeUndefined();
  });

  // P1 bloque 5b: un solo juego de cortes (config/coachEvaluation.ts, 85/70/50). Antes
  // classifyVSI usaba 80/65/50 y el indicador 85/70/50: el mismo niño era «Élite» en una
  // pantalla y «Pro» en otra.
  describe("classifyVSI / coachEvalTier (cortes únicos)", () => {
    it("elite >= 85", () => {
      expect(MetricsService.classifyVSI(85)).toBe("elite");
      expect(coachEvalTier(99)).toBe("elite");
      expect(coachEvalTier(84.9)).toBe("pro");
    });

    it("pro >= 70 y < 85", () => {
      expect(coachEvalTier(70)).toBe("pro");
      expect(coachEvalTier(69.9)).toBe("talent");
    });

    it("talent >= 50 y < 70", () => {
      expect(coachEvalTier(50)).toBe("talent");
    });

    it("develop < 50", () => {
      expect(coachEvalTier(49.9)).toBe("develop");
      expect(coachEvalTier(0)).toBe("develop");
    });

    it("los cortes salen de la config única con su procedencia", () => {
      expect(COACH_EVAL_TIERS.map((x) => x.min)).toEqual([85, 70, 50, 0]);
      expect(COACH_EVAL_TIERS_SOURCE).toBe("pendiente de validar");
    });
  });

  describe("normalize", () => {
    it("normaliza 50 a 0.5", () => {
      expect(MetricsService.normalize(50)).toBe(0.5);
    });

    it("clamp a 0 si negativo", () => {
      expect(MetricsService.normalize(-10)).toBe(0);
    });

    it("clamp a 1 si > 100", () => {
      expect(MetricsService.normalize(150)).toBe(1);
    });
  });

  describe("weightedAverage", () => {
    it("calcula promedio ponderado correctamente", () => {
      const result = MetricsService.weightedAverage([80, 60], [0.7, 0.3]);
      // (80*0.7 + 60*0.3) / (0.7+0.3) = (56+18)/1 = 74
      expect(result).toBe(74);
    });

    it("con pesos iguales es promedio simple", () => {
      const result = MetricsService.weightedAverage([80, 60, 40], [1, 1, 1]);
      expect(result).toBe(60);
    });
  });
});
