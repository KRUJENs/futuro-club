/**
 * Tests para vsiStats — VSI honesto en la capa API (invariante #2).
 * El hueco (vsi null) NO promedia como 0 ni ordena como 0.
 */
import { describe, it, expect } from "vitest";
import {
  toVsi,
  isEvaluated,
  avgEvaluatedVsi,
  countElite,
  ELITE_MIN,
  byVsiDescNullsLast,
  formatVsi,
} from "../vsiStats";

describe("toVsi", () => {
  it("devuelve el número tal cual cuando es finito (incluido 0)", () => {
    expect(toVsi(72.5)).toBe(72.5);
    expect(toVsi(0)).toBe(0);
  });
  it("coacciona strings numéricos (numeric de supabase puede venir como string)", () => {
    expect(toVsi("72.5")).toBe(72.5);
    expect(toVsi("0")).toBe(0);
  });
  it("devuelve null para ausente o no numérico (nunca 0 fabricado)", () => {
    expect(toVsi(null)).toBeNull();
    expect(toVsi(undefined)).toBeNull();
    expect(toVsi("")).toBeNull();
    expect(toVsi("n/a")).toBeNull();
    expect(toVsi(NaN)).toBeNull();
    expect(toVsi(Infinity)).toBeNull();
  });
});

describe("isEvaluated", () => {
  it("un vsi null es 'sin evaluar'", () => {
    expect(isEvaluated({ vsi: null })).toBe(false);
    expect(isEvaluated({ vsi: undefined })).toBe(false);
  });
  it("un vsi real (incluido 0) está evaluado", () => {
    expect(isEvaluated({ vsi: 55 })).toBe(true);
    expect(isEvaluated({ vsi: 0 })).toBe(true);
  });
});

describe("avgEvaluatedVsi", () => {
  it("promedia SOLO sobre evaluados; los null no bajan la media", () => {
    // Sin el fix: (80 + 60 + 0 + 0) / 4 = 35. Con el fix: (80 + 60) / 2 = 70.
    const players = [{ vsi: 80 }, { vsi: 60 }, { vsi: null }, { vsi: null }];
    expect(avgEvaluatedVsi(players)).toBe(70);
  });
  it("devuelve null cuando NADIE está evaluado (nunca 0)", () => {
    expect(avgEvaluatedVsi([{ vsi: null }, { vsi: null }])).toBeNull();
    expect(avgEvaluatedVsi([])).toBeNull();
  });
  it("un 0 real (VSI evaluado bajo) SÍ cuenta en la media", () => {
    expect(avgEvaluatedVsi([{ vsi: 0 }, { vsi: 100 }])).toBe(50);
  });
  it("redondea a los decimales pedidos", () => {
    expect(avgEvaluatedVsi([{ vsi: 70 }, { vsi: 71 }, { vsi: 71 }])).toBe(70.7);
    expect(avgEvaluatedVsi([{ vsi: 70 }, { vsi: 71 }, { vsi: 71 }], 0)).toBe(71);
  });
});

describe("countElite", () => {
  // P1 bloque 5b: «Élite» = tramo único de la evaluación del entrenador (≥85), no ≥70.
  it("cuenta evaluados en el tramo Élite (≥85); el sin-evaluar NO es élite", () => {
    const players = [{ vsi: 90 }, { vsi: 85 }, { vsi: 84.9 }, { vsi: 72 }, { vsi: null }];
    expect(countElite(players)).toBe(2);
  });
  it("no cuenta un hueco como 0 < umbral (no infla nada)", () => {
    expect(countElite([{ vsi: null }, { vsi: null }])).toBe(0);
  });
  it("el mínimo del tramo sale de la config única", () => {
    expect(ELITE_MIN).toBe(85);
  });
});

describe("byVsiDescNullsLast", () => {
  it("ordena descendente y manda los null al final (no como 0)", () => {
    const players = [{ vsi: null }, { vsi: 40 }, { vsi: 90 }, { vsi: null }, { vsi: 10 }];
    const sorted = [...players].sort(byVsiDescNullsLast).map((p) => p.vsi);
    expect(sorted).toEqual([90, 40, 10, null, null]);
  });
  it("un 40 real queda por encima de un null (no al revés)", () => {
    expect(byVsiDescNullsLast({ vsi: 40 }, { vsi: null })).toBeLessThan(0);
    expect(byVsiDescNullsLast({ vsi: null }, { vsi: 40 })).toBeGreaterThan(0);
  });
});

describe("formatVsi", () => {
  it("muestra '—' para sin evaluar, nunca '0'", () => {
    expect(formatVsi(null)).toBe("—");
    expect(formatVsi(undefined)).toBe("—");
  });
  it("muestra el número redondeado para evaluados (incluido 0 real)", () => {
    expect(formatVsi(72.6)).toBe("73");
    expect(formatVsi(0)).toBe("0");
    expect(formatVsi(72.55, 1)).toBe("72.5");
  });
});
