/**
 * VITAS · Tests — AdvancedMetricsService
 * Verifica: VAEP (events), DominantFeatures, TrackingService. RAE / UBI / TruthFilter se
 * retiraron en el P1 bloque 6 (punto 22); el trimestre de nacimiento se prueba en
 * src/test/lib/relativeAge.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as advancedMetricsModule from "@/services/real/advancedMetricsService";
import {
  VAEPService,
  DominantFeaturesService,
  TrackingService,
  calculateAdvancedMetrics,
} from "@/services/real/advancedMetricsService";
import type { SPADLAction } from "@/services/real/advancedMetricsService";
import type { MatchEvent } from "@/services/real/matchEventsService";
import type { Player } from "@/services/real/playerService";

// ─── VAEP ───────────────────────────────────────────────────────────────────

describe("VAEPService", () => {
  describe("calculate (SPADL con probabilidades)", () => {
    it("retorna stub_no_data sin acciones", () => {
      const result = VAEPService.calculate({ actions: [], minutesPlayed: 90 });
      expect(result.status).toBe("stub_no_data");
      expect(result.vaepTotal).toBeNull();
    });

    it("deriva VAEP con xG zonal cuando faltan probabilidades del proveedor", () => {
      // Antes esto devolvía stub_no_data; ahora, con coordenadas válidas en el
      // campo, VITAS rellena las probabilidades con su modelo zone-xG y calcula.
      const actions: SPADLAction[] = [{
        actionId: "a1", type: "pass", startX: 30, startY: 34, endX: 50, endY: 34, result: "success",
      }];
      const result = VAEPService.calculate({ actions, minutesPlayed: 90 });
      expect(result.status).toBe("calculated");
      expect(result.vaepTotal).not.toBeNull();
    });

    it("calcula VAEP real con probabilidades completas", () => {
      const actions: SPADLAction[] = [{
        actionId: "a1", type: "pass", startX: 30, startY: 34, endX: 50, endY: 34, result: "success",
        scoreProbBefore: 0.01, scoreProbAfter: 0.05,
        concedeProbBefore: 0.02, concedeProbAfter: 0.01,
      }];
      const result = VAEPService.calculate({ actions, minutesPlayed: 90 });
      expect(result.status).toBe("calculated");
      // VAEP = (0.05 - 0.01) - (0.01 - 0.02) = 0.04 - (-0.01) = 0.05
      expect(result.vaepTotal).toBeCloseTo(0.05, 2);
      expect(result.vaep90).toBeCloseTo(0.05, 2); // 90 min jugados
    });

    it("vaep90 escala correctamente a 90 minutos", () => {
      const actions: SPADLAction[] = [{
        actionId: "a1", type: "shot", startX: 95, startY: 34, endX: 105, endY: 34, result: "success",
        scoreProbBefore: 0.1, scoreProbAfter: 0.9,
        concedeProbBefore: 0.0, concedeProbAfter: 0.0,
      }];
      const result = VAEPService.calculate({ actions, minutesPlayed: 45 });
      expect(result.status).toBe("calculated");
      // vaep90 = (total / 45) * 90 = total * 2
      expect(result.vaep90).toBeCloseTo(result.vaepTotal! * 2, 2);
    });
  });

  describe("calculateFromEvents (eventos manuales)", () => {
    it("retorna insufficient_data sin eventos", () => {
      const result = VAEPService.calculateFromEvents([], 90);
      expect(result.status).toBe("insufficient_data");
    });

    it("shot_success vale 0.15", () => {
      const events: MatchEvent[] = [{
        id: "e1", playerId: "p1", type: "shot", result: "success",
        minute: 25, matchDate: "2026-04-01", createdAt: new Date().toISOString(),
      }];
      const result = VAEPService.calculateFromEvents(events, 90);
      expect(result.status).toBe("calculated");
      expect(result.vaepTotal).toBe(0.15);
    });

    it("pass_success en zona ofensiva vale 0.03", () => {
      const events: MatchEvent[] = [{
        id: "e1", playerId: "p1", type: "pass", result: "success",
        minute: 30, matchDate: "2026-04-01", xZone: "offensive", createdAt: new Date().toISOString(),
      }];
      const result = VAEPService.calculateFromEvents(events, 90);
      expect(result.vaepTotal).toBe(0.03);
    });

    it("pass_success en zona defensiva vale 0.005", () => {
      const events: MatchEvent[] = [{
        id: "e1", playerId: "p1", type: "pass", result: "success",
        minute: 10, matchDate: "2026-04-01", xZone: "defensive", createdAt: new Date().toISOString(),
      }];
      const result = VAEPService.calculateFromEvents(events, 90);
      expect(result.vaepTotal).toBe(0.005);
    });

    it("dribble_fail penaliza -0.02", () => {
      const events: MatchEvent[] = [{
        id: "e1", playerId: "p1", type: "dribble", result: "fail",
        minute: 40, matchDate: "2026-04-01", createdAt: new Date().toISOString(),
      }];
      const result = VAEPService.calculateFromEvents(events, 90);
      expect(result.vaepTotal).toBe(-0.02);
    });

    it("topActions ordenadas por impacto descendente", () => {
      const events: MatchEvent[] = [
        { id: "e1", playerId: "p1", type: "pass", result: "fail", minute: 10, matchDate: "2026-04-01", createdAt: new Date().toISOString() },
        { id: "e2", playerId: "p1", type: "shot", result: "success", minute: 30, matchDate: "2026-04-01", createdAt: new Date().toISOString() },
        { id: "e3", playerId: "p1", type: "tackle", result: "success", minute: 50, matchDate: "2026-04-01", createdAt: new Date().toISOString() },
      ];
      const result = VAEPService.calculateFromEvents(events, 90);
      expect(result.topActions[0].actionId).toBe("e2"); // shot_success = 0.15
      expect(result.topActions[1].actionId).toBe("e3"); // tackle_success = 0.04
    });

    it("vaep90 escala correctamente", () => {
      const events: MatchEvent[] = [{
        id: "e1", playerId: "p1", type: "shot", result: "success",
        minute: 25, matchDate: "2026-04-01", createdAt: new Date().toISOString(),
      }];
      const result = VAEPService.calculateFromEvents(events, 45);
      // vaep90 = (0.15 / 45) * 90 = 0.3
      expect(result.vaep90).toBeCloseTo(0.3, 2);
    });
  });

  describe("getStub", () => {
    it("retorna status stub_no_data", () => {
      const result = VAEPService.getStub(540);
      expect(result.status).toBe("stub_no_data");
      expect(result.vaepTotal).toBeNull();
      expect(result.vaep90).toBeNull();
    });
  });
});

// ─── DominantFeatures ───────────────────────────────────────────────────────

describe("DominantFeaturesService", () => {
  describe("calculate", () => {
    it("identifica top 3 dominantes por z-score", () => {
      const metrics = { speed: 90, technique: 85, vision: 80, stamina: 50, shooting: 45, defending: 40 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.dominant).toHaveLength(3);
      expect(result.dominant[0].key).toBe("speed"); // highest z-score
    });

    it("identifica 2 areas subdesarrolladas", () => {
      const metrics = { speed: 90, technique: 85, vision: 80, stamina: 50, shooting: 45, defending: 40 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.underdeveloped).toHaveLength(2);
      // Las 2 areas con menor z-score (defending=40, shooting=45 o stamina=50)
      const underKeys = result.underdeveloped.map((u) => u.key);
      expect(underKeys).toContain("defending"); // lowest value (40)
    });

    it("jugador ofensivo clasificado como ofensivo", () => {
      const metrics = { speed: 70, technique: 85, vision: 80, stamina: 55, shooting: 78, defending: 40 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.playStyle).toBe("ofensivo");
    });

    it("jugador defensivo clasificado como defensivo", () => {
      const metrics = { speed: 65, technique: 50, vision: 50, stamina: 85, shooting: 40, defending: 90 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.playStyle).toBe("defensivo");
    });

    it("jugador equilibrado", () => {
      const metrics = { speed: 60, technique: 60, vision: 60, stamina: 60, shooting: 60, defending: 60 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.playStyle).toBe("equilibrado");
    });

    it("specializationIndex entre 0 y 1", () => {
      const metrics = { speed: 95, technique: 20, vision: 90, stamina: 15, shooting: 85, defending: 10 };
      const result = DominantFeaturesService.calculate(metrics);
      expect(result.specializationIndex).toBeGreaterThanOrEqual(0);
      expect(result.specializationIndex).toBeLessThanOrEqual(1);
    });

    it("jugador uniforme tiene specializationIndex bajo", () => {
      const uniform = { speed: 60, technique: 60, vision: 60, stamina: 60, shooting: 60, defending: 60 };
      const specialized = { speed: 95, technique: 30, vision: 90, stamina: 25, shooting: 85, defending: 20 };
      const r1 = DominantFeaturesService.calculate(uniform);
      const r2 = DominantFeaturesService.calculate(specialized);
      expect(r1.specializationIndex).toBeLessThan(r2.specializationIndex);
    });
  });
});

// ─── calculateAdvancedMetrics · jugador SIN evaluar ──────────────────────────

describe("calculateAdvancedMetrics · jugador sin métricas del entrenador", () => {
  const unratedPlayer = {
    id: "p_unrated",
    name: "Sin Evaluar",
    age: 14,
    position: "RW",
    foot: "right",
    height: 165,
    weight: 55,
    competitiveLevel: "Regional",
    minutesPlayed: 0,
    vsi: null,
    vsiHistory: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    // sin `metrics`: jugador creado por onboarding/wizard sin evaluación real
  } as unknown as Player;

  it("no lanza (antes: Object.keys(undefined) en DominantFeaturesService)", () => {
    expect(() => calculateAdvancedMetrics(unratedPlayer)).not.toThrow();
  });

  it("dominantFeatures es null: no se infieren características de la nada (invariante #2)", () => {
    const result = calculateAdvancedMetrics(unratedPlayer);
    expect(result.dominantFeatures).toBeNull();
  });

  it("sin UBI / TruthFilter / «VSI ajustado» / RAE aunque tenga PHV y VSI (P1 bloque 6, punto 22)", () => {
    // Antes: con offset+categoría el UBI salía siempre (edad relativa = 0 porque nadie
    // pasaba la fecha) y el TruthFilter sumaba puntos al VSI con correcciones sin fuente.
    const withPhv = { ...unratedPlayer, vsi: 70, phvOffset: -1.5, phvCategory: "early" } as unknown as Player;
    const result = calculateAdvancedMetrics(withPhv);
    for (const k of ["rae", "ubi", "truthFilter", "adjustedVSI", "phvValidation"]) {
      expect(result).not.toHaveProperty(k);
    }
  });

  it("el módulo ya no exporta RAEService / UBIService / TruthFilterService / validatePhvData", () => {
    for (const k of ["RAEService", "UBIService", "TruthFilterService", "validatePhvData"]) {
      expect(advancedMetricsModule).not.toHaveProperty(k);
    }
  });
});

// ─── TrackingService ────────────────────────────────────────────────────────

describe("TrackingService", () => {
  it("retorna stub sin datos", () => {
    const result = TrackingService.calculate(null);
    expect(result.status).toBe("stub_no_data");
    expect(result.maxSpeedMs).toBeNull();
  });

  it("retorna stub con array vacío", () => {
    const result = TrackingService.calculate({ positions: [], minutesPlayed: 90 });
    expect(result.status).toBe("stub_no_data");
  });

  it("calcula distancia y velocidad con datos GPS", () => {
    const positions = [
      { x: 0, y: 0, timestampMs: 0 },
      { x: 10, y: 0, timestampMs: 1000 },  // 10m in 1s = 10 m/s
      { x: 20, y: 0, timestampMs: 2000 },   // 10m in 1s = 10 m/s
      { x: 22, y: 0, timestampMs: 3000 },   // 2m in 1s = 2 m/s (no sprint)
    ];
    const result = TrackingService.calculate({ positions, minutesPlayed: 1 });
    expect(result.status).toBe("calculated");
    expect(result.totalDistanceM).toBeCloseTo(22, 0);
    expect(result.maxSpeedMs).toBeCloseTo(10, 0);
  });

  it("detecta sprints (>6.5 m/s por >1s)", () => {
    const positions = [
      { x: 0, y: 0, timestampMs: 0 },
      { x: 7, y: 0, timestampMs: 1000 },   // 7 m/s — sprint
      { x: 14, y: 0, timestampMs: 2000 },  // 7 m/s — sprint continues
      { x: 16, y: 0, timestampMs: 3000 },  // 2 m/s — sprint ends
    ];
    const result = TrackingService.calculate({ positions, minutesPlayed: 1 });
    expect(result.sprintCount).toBeGreaterThanOrEqual(1);
  });
});
