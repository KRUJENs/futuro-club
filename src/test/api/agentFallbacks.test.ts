/**
 * Tests for Deterministic Agent Fallbacks
 * Validates PHV Mirwald formula, role profile rules, and scout insight classification.
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

// ── Role Profile Fallback ───────────────────────────────────────────────

describe("roleProfileFallback", () => {
  const baseInput = {
    player: {
      id: "p1",
      name: "Samu",
      age: 15,
      foot: "right",
      position: "mediocentro",
      minutesPlayed: 600,
      competitiveLevel: "Nacional",
      metrics: { speed: 65, technique: 80, vision: 75, stamina: 60, shooting: 55, defending: 45 },
      phvCategory: "ontme",
    },
  };

  it("returns all required fields", () => {
    const result = roleProfileFallback(baseInput, "claude_error");
    expect(result).toHaveProperty("playerId", "p1");
    expect(result).toHaveProperty("dominantIdentity");
    expect(result).toHaveProperty("identityDistribution");
    expect(result).toHaveProperty("topPositions");
    expect(result).toHaveProperty("topArchetypes");
    expect(result).toHaveProperty("capabilities");
    expect(result).toHaveProperty("strengths");
    expect(result).toHaveProperty("gaps");
    expect(result).toHaveProperty("overallConfidence");
    expect(result).toHaveProperty("_fallback", true);
  });

  it("identity distribution sums to approximately 1.0", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    const dist = result.identityDistribution;
    const sum = dist.ofensivo + dist.defensivo + dist.tecnico + dist.fisico + dist.mixto;
    expect(sum).toBeCloseTo(1.0, 1);
  });

  it("detects tecnico identity for high technique+vision", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    expect(result.dominantIdentity).toBe("tecnico");
  });

  it("detects fisico identity for high speed+stamina", () => {
    const input = {
      player: {
        ...baseInput.player,
        metrics: { speed: 85, technique: 50, vision: 50, stamina: 82, shooting: 50, defending: 50 },
      },
    };
    const result = roleProfileFallback(input, "no_api_key");
    expect(result.dominantIdentity).toBe("fisico");
  });

  it("detects mixto identity when metrics are close", () => {
    const input = {
      player: {
        ...baseInput.player,
        metrics: { speed: 62, technique: 60, vision: 61, stamina: 63, shooting: 60, defending: 62 },
      },
    };
    const result = roleProfileFallback(input, "no_api_key");
    expect(result.dominantIdentity).toBe("mixto");
  });

  it("maps position to correct code", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    // "mediocentro" (interior genérico) → RCM/LCM según lateralidad (foot=right → R);
    // "DM" queda reservado para "pivote"/"mediocentro defensivo".
    expect(result.topPositions[0].code).toBe("RCM");
  });

  it("maps portero to GK", () => {
    const input = { player: { ...baseInput.player, position: "portero" } };
    const result = roleProfileFallback(input, "no_api_key");
    expect(result.topPositions[0].code).toBe("GK");
  });

  it("confidence depends on minutes played", () => {
    const highMins = roleProfileFallback({ player: { ...baseInput.player, minutesPlayed: 600 } }, "no_api_key");
    const lowMins = roleProfileFallback({ player: { ...baseInput.player, minutesPlayed: 100 } }, "no_api_key");
    expect(highMins.overallConfidence).toBeGreaterThan(lowMins.overallConfidence);
  });

  it("strengths are top 3 metrics", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    expect(result.strengths).toHaveLength(3);
    // technique=80 should be first
    expect(result.strengths[0]).toContain("technique");
  });

  it("gaps are bottom 2 metrics", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    expect(result.gaps).toHaveLength(2);
    // defending=45 should be in gaps
    expect(result.gaps.some(g => g.includes("defending"))).toBe(true);
  });

  it("uses default metrics when none provided", () => {
    const input = { player: { name: "Test" } };
    const result = roleProfileFallback(input, "no_api_key");
    expect(result.dominantIdentity).toBeDefined();
    expect(result.capabilities.tactical.current).toBe(60); // default 60
  });

  // P1 bloque 5c: sin proyecciones (antes p6m/p18m = current × un factor fijo por PHV).
  it("capabilities: solo el nivel actual, sin p6m/p18m", () => {
    const result = roleProfileFallback(baseInput, "no_api_key");
    for (const dim of [result.capabilities.tactical, result.capabilities.technical, result.capabilities.physical]) {
      expect(Object.keys(dim)).toEqual(["current"]);
    }
  });
});

// ── Scout Insight Fallback ──────────────────────────────────────────────

describe("scoutInsightFallback", () => {
  it("detects breakout: VSI > 75 + trend up", () => {
    const result = scoutInsightFallback({
      player: { name: "Star", vsi: 80, vsiTrend: "up", recentMetrics: { speed: 70 } },
    }, "claude_error");
    expect(result.type).toBe("breakout");
    expect(result.urgency).toBe("high");
  });

  it("detects phv_alert: early maturer + speed > 75", () => {
    const result = scoutInsightFallback({
      player: { name: "PHV", phvCategory: "early", recentMetrics: { speed: 80 } },
    }, "no_api_key");
    expect(result.type).toBe("phv_alert");
    expect(result.urgency).toBe("high");
  });

  it("detects drill_record: max metric > 85", () => {
    const result = scoutInsightFallback({
      player: { name: "Record", recentMetrics: { technique: 90, speed: 60 } },
    }, "no_api_key");
    expect(result.type).toBe("drill_record");
    expect(result.urgency).toBe("medium");
  });

  it("detects regression: trend down", () => {
    const result = scoutInsightFallback({
      player: { name: "Declining", vsi: 60, vsiTrend: "down", recentMetrics: { speed: 50 } },
    }, "no_api_key");
    expect(result.type).toBe("regression");
    expect(result.urgency).toBe("high");
  });

  it("detects comparison: balanced 55-75 profile", () => {
    const result = scoutInsightFallback({
      player: { name: "Balanced", recentMetrics: { speed: 60, technique: 65, vision: 70 } },
    }, "no_api_key");
    expect(result.type).toBe("comparison");
    expect(result.urgency).toBe("low");
  });

  it("falls back to general for unclassified", () => {
    const result = scoutInsightFallback({
      player: { name: "Generic", recentMetrics: { speed: 40 } },
    }, "no_api_key");
    expect(result.type).toBe("general");
  });

  it("context override forces type", () => {
    const result = scoutInsightFallback({
      player: { name: "Override" },
      context: "breakout",
    }, "no_api_key");
    expect(result.type).toBe("breakout");
  });

  it("returns all required output fields", () => {
    const result = scoutInsightFallback({
      player: { name: "Test", id: "p1" },
    }, "no_api_key");
    expect(result.playerId).toBe("p1");
    expect(result.headline).toContain("Test");
    expect(typeof result.body).toBe("string");
    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.actionItems.length).toBeGreaterThan(0);
    expect(result.ragEnriched).toBe(false);
    expect(result._fallback).toBe(true);
    expect(result.tokensUsed).toBe(0);
  });

  it("uses 'unknown' when player.id is missing", () => {
    const result = scoutInsightFallback({
      player: { name: "NoId" },
    }, "no_api_key");
    expect(result.playerId).toBe("unknown");
  });
});
