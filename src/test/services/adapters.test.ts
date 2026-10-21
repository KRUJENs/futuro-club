/**
 * Tests for data adapters — adaptPlayerForUI, adaptInsightForUI, computeDashboardStats
 */
import { describe, it, expect, vi } from "vitest";
import { adaptPlayerForUI, adaptInsightForUI, computeDashboardStats } from "@/services/real/adapters";
import type { Player } from "@/services/real/playerService";
import type { ScoutInsightOutput } from "@/agents/contracts";
import { phvGate } from "@/lib/phv/phvGate";

// hiddenTalents delega en el GATE ÚNICO de PHV (gatedMaturity · probado aparte en
// phvGate.test.ts). Lo mockeamos para testear el CONTRATO DE GATING del adapter en
// aislamiento, sin acoplarnos a umbrales antropométricos del motor. Clave por id.
// sanitizePlayerPhv y phvGate se conservan REALES (importActual).
vi.mock("@/lib/phv/phvGate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/phv/phvGate")>();
  const M: Record<string, { timing: string; confidence: string }> = {
    gem_a:       { timing: "late", confidence: "high" },      // madurador tardío firme
    gem_b:       { timing: "late", confidence: "moderate" },  // tardío, confianza media
    gem_highvsi: { timing: "late", confidence: "high" },      // tardío pero VSI alto
    lowconf:     { timing: "late", confidence: "none" },      // tardío sin confianza
    precoz:      { timing: "early", confidence: "high" },     // precoz
    unk:         { timing: "unknown", confidence: "none" },   // sin datos
  };
  return {
    ...actual,
    gatedMaturity: (p: { id: string }) => M[p.id] ?? { timing: "unknown", confidence: "none" },
  };
});

// Entradas COMPLETAS introducidas (regla del owner 28-sep): el gate recalcula.
const COMPLETE_PHV = { height: 165, weight: 55, sittingHeight: 85, legLength: 80, birthDate: "2012-03-15", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M" as const, sexConfirmedAt: "2026-01-01T00:00:00.000Z" };

const makePlayer = (overrides: Partial<Player> = {}): Player => ({
  id: "p1",
  name: "Test Player",
  age: 14,
  position: "delantero",
  foot: "right",
  height: 165,
  weight: 55,
  competitiveLevel: "Regional",
  gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
  vsi: 72,
  minutesPlayed: 450,
  metrics: { speed: 75, technique: 80, vision: 65, stamina: 70, shooting: 85, defending: 40 },
  vsiHistory: [68, 70, 72],
  phvCategory: "ontme",
  phvOffset: 0.3,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-06-01T00:00:00Z",
  ...overrides,
});

// ── adaptPlayerForUI ────────────────────────────────────────────────────────
describe("adaptPlayerForUI", () => {
  it("maps core fields", () => {
    const ui = adaptPlayerForUI(makePlayer());
    expect(ui.id).toBe("p1");
    expect(ui.name).toBe("Test Player");
    expect(ui.age).toBe(14);
    expect(ui.position).toBe("delantero");
    expect(ui.vsi).toBe(72);
  });

  // La flecha sale de dos evaluaciones REALES con fecha (vsiTrendArrow → computeVsiDelta),
  // nunca del vsiHistory legacy (sin fechas; con el 57.5 fabricado antes de #146).
  const evals = (from: number, to: number) => [
    { value: from, at: "2026-09-01T10:00:00.000Z", source: "coach_form" as const },
    { value: to, at: "2026-09-15T10:00:00.000Z", source: "coach_form" as const },
  ];

  it("calculates trending=up when the dated real delta > 2", () => {
    const ui = adaptPlayerForUI(makePlayer({ vsi: 75, vsiHistory: [70, 75], vsiEvaluations: evals(70, 75) }));
    expect(ui.trending).toBe("up");
  });

  it("calculates trending=down when the dated real delta < -2", () => {
    const ui = adaptPlayerForUI(makePlayer({ vsi: 65, vsiHistory: [70, 65], vsiEvaluations: evals(70, 65) }));
    expect(ui.trending).toBe("down");
  });

  it("calculates trending=stable for a small dated real delta", () => {
    // delta = 72 - 70 = 2 → dentro de la banda ±2
    const ui = adaptPlayerForUI(makePlayer({ vsi: 72, vsiHistory: [70, 72], vsiEvaluations: evals(70, 72) }));
    expect(ui.trending).toBe("stable");
  });

  it("legacy vsiHistory alone never yields an arrow for a real player (was ↑ from [68, 70] → 75)", () => {
    const ui = adaptPlayerForUI(makePlayer({ vsi: 75, vsiHistory: [68, 70], vsiEvaluations: undefined }));
    expect(ui.trending).toBe("stable");
  });

  // Gate único (regla del owner 28-sep): el phvCategory PERSISTIDO solo cuenta si
  // el gate lo recalcula desde entradas introducidas; y entonces manda el recálculo.
  it.each(["ontme", "early", "late"] as const)(
    "phvCategory persistido %s SIN todas las entradas introducidas ⇒ null (no se muestra)",
    (cat) => {
      // makePlayer: sin talla sentado, pierna ni fecha de nacimiento.
      const ui = adaptPlayerForUI(makePlayer({ phvCategory: cat, phvOffset: -1.2 }));
      expect(ui.phvCategory).toBeNull();
      expect(ui.phvOffset).toBeNull();
    },
  );

  it("con entradas completas usa la categoría RECALCULADA por el gate (no la persistida)", () => {
    const g = phvGate(COMPLETE_PHV);
    if (!g.ok) throw new Error("gate cerrado");
    const ui = adaptPlayerForUI(makePlayer({ ...COMPLETE_PHV, phvCategory: "late", phvOffset: 9 }));
    const expected = g.category === "ontme" ? "on-time" : g.category;
    expect(ui.phvCategory).toBe(expected);
    expect(ui.phvOffset).toBe(g.offset.value);
  });

  it("phvCategory is null when undefined (no se asume on-time)", () => {
    // Rework de maduración: no fabricar "on-time" cuando falta el dato; null =
    // desconocido, así la UI no afirma un timing que no calculó.
    const ui = adaptPlayerForUI(makePlayer({ phvCategory: undefined }));
    expect(ui.phvCategory).toBeNull();
  });

  it("generates avatar URL with encoded name", () => {
    const ui = adaptPlayerForUI(makePlayer({ name: "José García" }));
    expect(ui.avatar).toContain("Jos%C3%A9%20Garc%C3%ADa");
  });

  it("maps stats correctly", () => {
    const ui = adaptPlayerForUI(makePlayer());
    expect(ui.stats.speed).toBe(75);
    expect(ui.stats.technique).toBe(80);
    expect(ui.stats.shooting).toBe(85);
  });

  it("computes recentDrills from minutesPlayed", () => {
    const ui = adaptPlayerForUI(makePlayer({ minutesPlayed: 360 }));
    expect(ui.recentDrills).toBe(4); // floor(360/90)
  });

  it("handles missing vsiHistory", () => {
    const ui = adaptPlayerForUI(makePlayer({ vsiHistory: undefined, vsi: 70 }));
    expect(ui.trending).toBe("stable");
  });

  it("phvOffset is null when undefined (no se asume 0)", () => {
    const ui = adaptPlayerForUI(makePlayer({ phvOffset: undefined }));
    expect(ui.phvOffset).toBeNull();
  });
});

// ── adaptInsightForUI ───────────────────────────────────────────────────────
describe("adaptInsightForUI", () => {
  const player = makePlayer();
  const baseInsight: ScoutInsightOutput = {
    playerId: "p1",
    type: "breakout",
    urgency: "high",
    headline: "Explosión de rendimiento",
    body: "El jugador muestra mejora significativa",
    metric: "speed",
    metricValue: "85",
    tags: ["breakout", "speed"],
    actionItems: ["Incrementar carga"],
    timestamp: "2025-06-01T00:00:00Z",
  };

  it("maps breakout type correctly", () => {
    const ui = adaptInsightForUI(baseInsight, player);
    expect(ui.insightType).toBe("breakout");
  });

  it("maps phv_alert to phv-alert", () => {
    const ui = adaptInsightForUI({ ...baseInsight, type: "phv_alert" }, player);
    expect(ui.insightType).toBe("phv-alert");
  });

  it("maps drill_record to drill-record", () => {
    const ui = adaptInsightForUI({ ...baseInsight, type: "drill_record" }, player);
    expect(ui.insightType).toBe("drill-record");
  });

  it("maps general to breakout (fallback visual)", () => {
    const ui = adaptInsightForUI({ ...baseInsight, type: "general" }, player);
    expect(ui.insightType).toBe("breakout");
  });

  it("includes player info", () => {
    const ui = adaptInsightForUI(baseInsight, player);
    expect(ui.player.name).toBe("Test Player");
    expect(ui.player.age).toBe(14);
    expect(ui.player.vsi).toBe(72);
  });

  it("preserves insight content", () => {
    const ui = adaptInsightForUI(baseInsight, player);
    expect(ui.title).toBe("Explosión de rendimiento");
    expect(ui.metric).toBe("speed");
    expect(ui.metricValue).toBe("85");
  });

  it("generates unique id with playerId", () => {
    const ui = adaptInsightForUI(baseInsight, player);
    expect(ui.id).toContain("p1-");
  });
});

// ── computeDashboardStats ───────────────────────────────────────────────────
describe("computeDashboardStats", () => {
  it("returns zeros for counts and null avgVsi for empty array", () => {
    const stats = computeDashboardStats([]);
    expect(stats.activePlayers).toBe(0);
    expect(stats.drillsCompleted).toBe(0);
    // Sin jugadores no hay media que calcular ⇒ null, no un 0 fabricado (invariante #2).
    expect(stats.avgVsi).toBeNull();
    expect(stats.hiddenTalents).toBe(0);
  });

  it("counts active players", () => {
    const stats = computeDashboardStats([makePlayer(), makePlayer({ id: "p2" })]);
    expect(stats.activePlayers).toBe(2);
  });

  it("calculates average VSI", () => {
    const stats = computeDashboardStats([
      makePlayer({ vsi: 70 }),
      makePlayer({ id: "p2", vsi: 80 }),
    ]);
    expect(stats.avgVsi).toBe(75);
  });

  it("avgVsi es null si ningún jugador está evaluado (no fabrica media · invariante #2)", () => {
    const stats = computeDashboardStats([
      makePlayer({ vsi: null }),
      makePlayer({ id: "p2", vsi: null }),
    ]);
    expect(stats.avgVsi).toBeNull();
  });

  it("avgVsi promedia solo los evaluados e ignora los vsi null", () => {
    const stats = computeDashboardStats([
      makePlayer({ vsi: 70 }),
      makePlayer({ id: "p2", vsi: null }), // sin evaluar: no entra en la media
      makePlayer({ id: "p3", vsi: 80 }),
    ]);
    expect(stats.avgVsi).toBe(75);
  });

  it("sums drills completed", () => {
    const stats = computeDashboardStats([
      makePlayer({ minutesPlayed: 180 }), // 2 drills
      makePlayer({ id: "p2", minutesPlayed: 270 }), // 3 drills
    ]);
    expect(stats.drillsCompleted).toBe(5);
  });

  it("counts hidden talents: madurador tardío confiable + VSI < 65 (gateado por gatedMaturity)", () => {
    const stats = computeDashboardStats([
      makePlayer({ id: "gem_a", vsi: 55 }),       // ✓ tardío + confianza alta + VSI<65
      makePlayer({ id: "gem_b", vsi: 60 }),       // ✓ tardío + confianza media + VSI<65
      makePlayer({ id: "gem_highvsi", vsi: 70 }), // ✗ VSI >= 65
      makePlayer({ id: "lowconf", vsi: 50 }),     // ✗ tardío pero sin confianza (anti-falso-positivo)
      makePlayer({ id: "precoz", vsi: 40 }),      // ✗ precoz, no tardío
      makePlayer({ id: "unk", vsi: 30 }),         // ✗ timing desconocido
    ]);
    expect(stats.hiddenTalents).toBe(2);
  });
});
