/**
 * Tests for api/_lib/agentFallbacks.ts
 * Pure TypeScript logic — no mocks needed.
 */
import { describe, it, expect } from "vitest";
import { roleProfileFallback, scoutInsightFallback } from "../../../api/_lib/agentFallbacks";

// ── PHV Calculator Fallback ─────────────────────────────────────────────
// phvFallback() se RETIRÓ (regla del owner 28-sep): estimaba talla sentado/pierna,
// rellenaba talla/peso/VSI por defecto y aplicaba ×1.12/×0.92 por categoría de
// estado. El PHV se bloquea sin todas las entradas introducidas (phvGate.ts).
describe("phvFallback (retirado)", () => {
  it("ya no se exporta: el PHV no tiene un fallback que aproxime", async () => {
    const mod = (await import("../../../api/_lib/agentFallbacks")) as Record<string, unknown>;
    expect(mod.phvFallback).toBeUndefined();
  });
});

// ─── Role Profile Fallback ──────────────────────────────────────────────────

describe("roleProfileFallback", () => {
  const baseInput = {
    player: {
      id: "p1",
      name: "Test Player",
      age: 14,
      position: "delantero",
      minutesPlayed: 300,
      metrics: { speed: 80, technique: 70, vision: 65, stamina: 75, shooting: 85, defending: 40 },
      phvCategory: "ontme" as const,
    },
  };

  it("returns valid role profile with _fallback flag", () => {
    const r = roleProfileFallback(baseInput, "no_api_key");
    expect(r._fallback).toBe(true);
    expect(r.agentName).toBe("RoleProfileAgent");
    expect(r.tokensUsed).toBe(0);
  });

  it("identifies ofensivo when shooting+speed are top", () => {
    const r = roleProfileFallback(baseInput, "no_api_key");
    expect(r.dominantIdentity).toBe("ofensivo");
  });

  it("identifies fisico when speed+stamina are top", () => {
    const input = {
      player: {
        ...baseInput.player,
        metrics: { speed: 90, technique: 40, vision: 40, stamina: 85, shooting: 45, defending: 40 },
      },
    };
    const r = roleProfileFallback(input, "no_api_key");
    expect(r.dominantIdentity).toBe("fisico");
  });

  it("identifies tecnico when technique+vision are top", () => {
    const input = {
      player: {
        ...baseInput.player,
        metrics: { speed: 40, technique: 90, vision: 88, stamina: 40, shooting: 45, defending: 40 },
      },
    };
    const r = roleProfileFallback(input, "no_api_key");
    expect(r.dominantIdentity).toBe("tecnico");
  });

  it("identityDistribution sums to ~1.0", () => {
    const r = roleProfileFallback(baseInput, "no_api_key");
    const sum = Object.values(r.identityDistribution).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 1);
  });

  // P1 bloque 5c: sin proyecciones (antes p18m = current × (1 + factor PHV fijo × 2,5)).
  it("capabilities sin p6m/p18m: solo el nivel actual", () => {
    const r = roleProfileFallback(baseInput, "no_api_key");
    expect(r.capabilities.tactical).not.toHaveProperty("p18m");
    expect(r.capabilities.technical).not.toHaveProperty("p6m");
    expect(r.capabilities.physical).not.toHaveProperty("p18m");
  });

  it("confidence based on minutesPlayed", () => {
    const r = roleProfileFallback(baseInput, "no_api_key");
    expect(r.overallConfidence).toBe(0.35); // 200-500 range
  });

  it("handles missing metrics gracefully", () => {
    const input = { player: { name: "Bare" } };
    const r = roleProfileFallback(input, "claude_error");
    expect(r._fallback).toBe(true);
    expect(r.dominantIdentity).toBeDefined();
  });
});

// ─── Scout Insight Fallback ─────────────────────────────────────────────────

describe("scoutInsightFallback", () => {
  it("generates breakout when vsi > 75 and trend up", () => {
    const r = scoutInsightFallback({
      player: { name: "Star", vsi: 82, vsiTrend: "up", recentMetrics: { speed: 80 } },
    }, "no_api_key");
    expect(r.type).toBe("breakout");
    expect(r.urgency).toBe("high");
    expect(r._fallback).toBe(true);
  });

  it("generates regression when trend is down", () => {
    const r = scoutInsightFallback({
      player: { name: "Slump", vsi: 55, vsiTrend: "down", recentMetrics: { speed: 60 } },
    }, "no_api_key");
    expect(r.type).toBe("regression");
    expect(r.urgency).toBe("high");
  });

  it("generates phv_alert when early + high speed", () => {
    const r = scoutInsightFallback({
      player: { name: "Young", phvCategory: "early", recentMetrics: { speed: 80 } },
    }, "no_api_key");
    expect(r.type).toBe("phv_alert");
    expect(r.urgency).toBe("high");
  });

  it("generates drill_record when metric > 85", () => {
    const r = scoutInsightFallback({
      player: { name: "Pro", recentMetrics: { technique: 90, speed: 60 } },
    }, "no_api_key");
    expect(r.type).toBe("drill_record");
    expect(r.urgency).toBe("medium");
  });

  it("generates general for average metrics", () => {
    const r = scoutInsightFallback({
      player: { name: "Average", vsi: 60, recentMetrics: { speed: 60, technique: 60 } },
    }, "no_api_key");
    expect(["general", "comparison"]).toContain(r.type);
  });

  it("timestamp is valid ISO string", () => {
    const r = scoutInsightFallback({ player: { name: "T" } }, "no_api_key");
    expect(new Date(r.timestamp).toISOString()).toBe(r.timestamp);
  });

  it("always has actionItems", () => {
    const r = scoutInsightFallback({ player: { name: "T" } }, "no_api_key");
    expect(r.actionItems.length).toBeGreaterThanOrEqual(2);
  });
});
