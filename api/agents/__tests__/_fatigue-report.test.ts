/**
 * VITAS · Tests del Fatigue Report Agent (honestidad · inv #2)
 * Run: npm run test:api -- _fatigue-report
 *
 * Cobertura:
 *   - hasRealFatigueData exige una SEÑAL concreta (no una fila fatigue_sessions vacía
 *     con columnas NOT NULL DEFAULT 0)
 *   - blockedFatigueReport NUNCA fabrica cifras: índice/ACWR/riesgo en null
 *   - generateMockReport lee el índice snake_case real y no inventa ACWR
 *   - Regresión del bug de demo: sin sesiones útiles, no se estima 35/1.1
 */

import { describe, it, expect } from "vitest";
import {
  hasRealFatigueData,
  blockedFatigueReport,
  generateMockReport,
  fatigueMaturationKnown,
} from "../_fatigue-report";

describe("Fatigue Report · gate de datos (inv #2)", () => {
  it("hasRealFatigueData = false sin sesión ni historial", () => {
    expect(hasRealFatigueData({ playerId: "p1" } as never)).toBe(false);
    expect(hasRealFatigueData({ playerId: "p1", fatigueReport: null, fatigueHistory: [] } as never)).toBe(false);
    expect(hasRealFatigueData({ playerId: "p1", fatigueReport: {} } as never)).toBe(false);
  });

  it("hasRealFatigueData = false para una sesión REAL pero vacía (columnas NOT NULL DEFAULT 0)", () => {
    // El caso del BLOCK: fila de fatigue_sessions creada sin métricas derivadas.
    expect(hasRealFatigueData({
      playerId: "p1",
      fatigueReport: { duration_min: 0, total_distance_m: 0, total_load: 0, fatigue_index: null, acwr_value: null },
    } as never)).toBe(false);
  });

  it("hasRealFatigueData = true con índice/ACWR no-nulos o carga > 0", () => {
    expect(hasRealFatigueData({ playerId: "p1", fatigueReport: { fatigue_index: 40 } } as never)).toBe(true);
    expect(hasRealFatigueData({ playerId: "p1", fatigueReport: { acwr_value: 1.2 } } as never)).toBe(true);
    expect(hasRealFatigueData({ playerId: "p1", fatigueReport: { total_load: 350 } } as never)).toBe(true);
    expect(hasRealFatigueData({ playerId: "p1", fatigueHistory: [{ fatigue_index: 30 }] } as never)).toBe(true);
  });

  it("blockedFatigueReport NO fabrica cifras: índice/ACWR/riesgo en null", () => {
    const r = blockedFatigueReport({ playerId: "p1" } as never) as Record<string, Record<string, unknown>>;
    expect(r.estadoActual.indice).toBeNull();
    expect(r.cargaACWR.valor).toBeNull();
    expect(r.riesgoLesion.nivel).toBe("sin datos");
    expect(r._gated).toBe(true);
    // Sin evaluación no hay cifra de confianza (el chip no se pinta; nunca «0 %»).
    expect(r).not.toHaveProperty("confidence_score");
    expect(r).not.toHaveProperty("data_completeness");
    // Regresión: los valores fabricados del bug de demo NO aparecen.
    expect(r.estadoActual.indice).not.toBe(35);
    expect(r.cargaACWR.valor).not.toBe(1.1);
  });

  it("blockedFatigueReport propaga la banda PHV si viene, sin inventarla", () => {
    const r = blockedFatigueReport({ playerId: "p1", phv: { category: "early" } } as never) as Record<string, Record<string, unknown>>;
    expect(r.ajustesPHV.banda).toBe("early");
    const r2 = blockedFatigueReport({ playerId: "p1" } as never) as Record<string, Record<string, unknown>>;
    expect(r2.ajustesPHV.banda).toBe("unknown");
  });

  it("generateMockReport lee fatigue_index real (snake_case) y NUNCA fabrica ACWR", () => {
    const withIdx = generateMockReport({ playerId: "p1", fatigueReport: { fatigue_index: 72 } } as never) as Record<string, Record<string, unknown>>;
    expect(withIdx.estadoActual.indice).toBe(72);       // lee el snake_case real
    expect(withIdx.estadoActual.severidad).toBe("alto"); // derivado del índice real
    expect(withIdx.cargaACWR.valor).toBeNull();          // ACWR exige historial → null, no 1.1

    const noIdx = generateMockReport({ playerId: "p1", fatigueReport: { total_load: 350 } } as never) as Record<string, Record<string, unknown>>;
    expect(noIdx.estadoActual.indice).toBeNull();        // sin índice real → null, no 35
    expect(noIdx.estadoActual.severidad).toBe("sin datos");
  });
});

describe("Fatigue Report · sin maduración registrada no hay semáforo (P1 bloque 4)", () => {
  it("fatigueMaturationKnown: banda real sí; sin banda, sin sesión o \"post_phv\" sin offset (valor antiguo) no", () => {
    expect(fatigueMaturationKnown({ playerId: "p1", fatigueReport: { fatigue_index: 40, maturation_band: "circa_phv", phv_offset: 0.3 } } as never)).toBe(true);
    expect(fatigueMaturationKnown({ playerId: "p1", fatigueReport: { fatigue_index: 40, maturation_band: "post_phv", phv_offset: 1.4 } } as never)).toBe(true);
    expect(fatigueMaturationKnown({ playerId: "p1", fatigueReport: { fatigue_index: 40, maturation_band: null } } as never)).toBe(false);
    expect(fatigueMaturationKnown({ playerId: "p1", fatigueReport: { fatigue_index: 40, maturation_band: "post_phv", phv_offset: null } } as never)).toBe(false);
    expect(fatigueMaturationKnown({ playerId: "p1", fatigueHistory: [{ fatigue_index: 30 }] } as never)).toBe(false);
  });

  it("el fallback usa los cortes del índice de fatiga (una sola definición), no 66/33", () => {
    const at = (fatigue_index: number) =>
      (generateMockReport({ playerId: "p1", fatigueReport: { fatigue_index } } as never) as Record<string, Record<string, unknown>>).estadoActual.severidad;
    expect(at(80)).toBe("crítico");
    expect(at(55)).toBe("alto");
    expect(at(30)).toBe("moderado");
    expect(at(10)).toBe("bajo");
  });
});
