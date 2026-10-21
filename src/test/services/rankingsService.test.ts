/**
 * Tests for Rankings Service
 * Validates local fallback: percentile calculation, age groups, filtering, sorting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
  SUPABASE_CONFIGURED: false, // Force local fallback
}));

const mockPlayers = [
  { id: "p1", name: "Ana", age: 14, position: "Mediocentro", foot: "right", height: 165, weight: 55, vsi: 75, phvCategory: "on-time", phvOffset: 0, competitiveLevel: "Nacional", minutesPlayed: 800, metrics: { speed: 70, technique: 80, vision: 75, stamina: 65, shooting: 60, defending: 55 } },
  { id: "p2", name: "Bruno", age: 12, position: "Delantero", foot: "left", height: 155, weight: 48, vsi: 82, phvCategory: "early", phvOffset: 1.2, competitiveLevel: "Regional", minutesPlayed: 600, metrics: { speed: 85, technique: 65, vision: 55, stamina: 70, shooting: 80, defending: 40 } },
  { id: "p3", name: "Carlos", age: 16, position: "Defensa Central", foot: "right", height: 178, weight: 68, vsi: 68, phvCategory: "late", phvOffset: -0.8, competitiveLevel: "Nacional", minutesPlayed: 1200, metrics: { speed: 55, technique: 50, vision: 60, stamina: 75, shooting: 40, defending: 85 } },
  { id: "p4", name: "Diana", age: 14, position: "Extremo", foot: "right", height: 160, weight: 50, vsi: 71, phvCategory: "on-time", phvOffset: 0.1, competitiveLevel: "Provincial", minutesPlayed: 500, metrics: { speed: 80, technique: 70, vision: 60, stamina: 65, shooting: 55, defending: 45 } },
  { id: "p5", name: "Emilio", age: 14, position: "Mediocentro", foot: "right", height: 168, weight: 57, vsi: 78, phvCategory: "on-time", phvOffset: 0.2, competitiveLevel: "Nacional", minutesPlayed: 900, metrics: { speed: 72, technique: 76, vision: 78, stamina: 68, shooting: 65, defending: 60 } },
];

vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getAll: vi.fn(() => mockPlayers),
    sort: vi.fn((players: typeof mockPlayers, field: string, dir: string) => {
      return [...players].sort((a, b) => {
        const aVal = (a as Record<string, unknown>)[field] as number;
        const bVal = (b as Record<string, unknown>)[field] as number;
        return dir === "desc" ? bVal - aVal : aVal - bVal;
      });
    }),
  },
}));

vi.mock("@/services/real/adapters", () => ({
  adaptPlayerForUI: vi.fn((p: Record<string, unknown>) => ({
    ...p,
    positionShort: (p.position as string).slice(0, 3).toUpperCase(),
    stats: p.metrics,
    trending: "stable",
    lastActive: new Date().toISOString(),
  })),
}));

import { fetchRankedPlayers } from "@/services/rankingsService";
import { PlayerService } from "@/services/real/playerService";
import { phvGate } from "@/lib/phv/phvGate";

describe("fetchRankedPlayers (local fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all players with no filters", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    expect(result.players.length).toBe(5);
    expect(result.total).toBe(5);
    expect(result.totalUnfiltered).toBe(5);
  });

  it("sorts by VSI descending", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    const vsis = result.players.map(p => p.vsi);
    for (let i = 1; i < vsis.length; i++) {
      expect(vsis[i]).toBeLessThanOrEqual(vsis[i - 1]);
    }
  });

  it("sorts by age ascending", async () => {
    const result = await fetchRankedPlayers("age", "asc", {});
    const ages = result.players.map(p => p.age);
    for (let i = 1; i < ages.length; i++) {
      expect(ages[i]).toBeGreaterThanOrEqual(ages[i - 1]);
    }
  });

  // ── Percentile calculation ──────────────────────────────────────────

  // P1 bloque 5: percentil con la implementación única (src/lib/metrics/percentile.ts):
  // mínimo 10 pares evaluados además del propio. Con 5 jugadores NO hay percentil (antes
  // se daba uno contra 4 compañeros, y P100 con 1).
  it("con 5 jugadores no hay percentil: null + motivo (mínimo 10 pares)", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    for (const p of result.players) {
      expect(p.percentile).toBeNull();
      expect(p.percentileGate).toEqual({ code: "insufficient_peers", peers: 4, min: 10 });
      expect(p.percentileInAgeGroup).toBeNull();
      expect(p.percentileInAgeGroupGate?.code).toBe("insufficient_peers");
    }
  });

  it("filtro de pie (bloque 11): solo el pie registrado casa; valor fuera del vocabulario ⇒ nadie (igual que el servidor)", async () => {
    expect((await fetchRankedPlayers("vsi", "desc", { foot: "left" })).players.map((p) => p.id)).toEqual(["p2"]);
    expect((await fetchRankedPlayers("vsi", "desc", { foot: "zurdo" })).players).toEqual([]);
    expect((await fetchRankedPlayers("vsi", "desc", { foot: "all" })).players).toHaveLength(5);
  });

  it("edad sin grupo (fuera de 8-21) ⇒ sin percentil por grupo (age_unknown), como el servidor; 14,5 cuenta como 14", async () => {
    vi.mocked(PlayerService.getAll).mockReturnValueOnce([{ ...mockPlayers[0], id: "x", age: 25 }, { ...mockPlayers[1], id: "y", age: 14.5 }] as never);
    const r = await fetchRankedPlayers("vsi", "desc", {});
    const x = r.players.find((p) => p.id === "x")!;
    expect(x.ageGroup).toBeNull();
    expect(x.percentileInAgeGroupGate?.code).toBe("age_unknown");
    expect(r.players.find((p) => p.id === "y")!.ageGroup).toBe("Sub-14");
  });

  it("con 11 evaluados sí hay percentil (punto medio) y el más alto tiene el más alto", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...mockPlayers[0],
      id: `m${i}`,
      name: `J${i}`,
      vsi: 50 + i, // 50..60, todos Sub-14
    }));
    vi.mocked(PlayerService.getAll).mockReturnValueOnce(many as never);
    const result = await fetchRankedPlayers("vsi", "desc", {});
    const top = result.players.find((p) => p.name === "J10")!;
    const low = result.players.find((p) => p.name === "J0")!;
    expect(top.percentile).toBe(100); // 10 de 10 por debajo
    expect(low.percentile).toBe(0);
    expect(top.percentileInAgeGroup).toBe(100);
    expect(top.percentileGate).toBeNull();
  });

  it("un jugador sin evaluar no tiene percentil ni cuenta como par", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...mockPlayers[0],
      id: `m${i}`,
      name: `J${i}`,
      vsi: i === 0 ? null : 50 + i, // 10 evaluados + 1 sin evaluar
    }));
    vi.mocked(PlayerService.getAll).mockReturnValueOnce(many as never);
    const result = await fetchRankedPlayers("vsi", "desc", {});
    const unrated = result.players.find((p) => p.name === "J0")!;
    expect(unrated.percentile).toBeNull();
    expect(unrated.percentileGate?.code).toBe("not_evaluated");
    // cada evaluado tiene solo 9 pares evaluados ⇒ bloqueado
    expect(result.players.find((p) => p.name === "J10")!.percentile).toBeNull();
  });

  it("los jugadores de ejemplo no son pares de los reales", async () => {
    const demos = Array.from({ length: 10 }, (_, i) => ({
      ...mockPlayers[0],
      id: `d${i}`,
      name: `D${i}`,
      vsi: 40 + i,
      isDemo: true,
    }));
    vi.mocked(PlayerService.getAll).mockReturnValueOnce([...demos, { ...mockPlayers[0] }] as never);
    const result = await fetchRankedPlayers("vsi", "desc", {});
    const real = result.players.find((p) => p.name === "Ana")!;
    expect(real.percentile).toBeNull();
    expect(real.percentileGate).toEqual({ code: "insufficient_peers", peers: 0, min: 10 });
  });

  // ── Age groups ──────────────────────────────────────────────────────

  it("assigns correct age groups", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    const bruno = result.players.find(p => p.name === "Bruno")!; // age 12
    const ana = result.players.find(p => p.name === "Ana")!; // age 14
    const carlos = result.players.find(p => p.name === "Carlos")!; // age 16
    expect(bruno.ageGroup).toBe("Sub-12");
    expect(ana.ageGroup).toBe("Sub-14");
    expect(carlos.ageGroup).toBe("Sub-16");
  });

  it("provides age group stats", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    expect(result.ageGroupStats).toBeDefined();
    expect(result.ageGroups.length).toBeGreaterThan(0);

    // Sub-14 should have 3 players (Ana, Diana, Emilio)
    const sub14 = result.ageGroupStats["Sub-14"];
    if (sub14) {
      expect(sub14.count).toBe(3);
      expect(sub14.avgVsi).toBeGreaterThan(0);
      expect(sub14.minVsi).toBeLessThanOrEqual(sub14.maxVsi);
    }
  });

  // ── Filters ─────────────────────────────────────────────────────────

  it("filters by search (name)", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { search: "bruno" });
    expect(result.players.length).toBe(1);
    expect(result.players[0].name).toBe("Bruno");
    expect(result.totalUnfiltered).toBe(5); // Total before filter
  });

  // Filtro «Maduración» = TIMING vs pares del gate (lo que rotula la fila), no la
  // fase persistida: Bruno («early» persistido, sin medidas) ya no pasa nada.
  it("filters by maturity TIMING from the gate, never by the persisted phase", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    try {
      const late = { ...mockPlayers[0], id: "late", name: "Tardío", height: 160, weight: 48, sittingHeight: 80, legLength: 80, birthDate: "2011-09-29", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M", phvCategory: "early" };
      const pre = { ...mockPlayers[0], id: "pre", name: "PreFase", height: 150, weight: 42, sittingHeight: 78, legLength: 72, birthDate: "2016-03-29", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M", phvCategory: "late" };
      const roster = [...mockPlayers, late, pre];
      vi.mocked(PlayerService.getAll).mockReturnValue(roster as never);
      const lateOnly = await fetchRankedPlayers("vsi", "desc", { timing: "late" });
      expect(lateOnly.players.map((p) => p.id)).toEqual(["late"]);
      expect(lateOnly.players[0].phvTiming).toBe("late");
      const onTime = await fetchRankedPlayers("vsi", "desc", { timing: "on_time" });
      expect(onTime.players.map((p) => p.id)).toEqual(["pre"]);
      // Agreement: every row's timing (same gate as Rankings.tsx) equals the chip.
      for (const timing of ["late", "on_time", "early"]) {
        const r = await fetchRankedPlayers("vsi", "desc", { timing });
        for (const p of r.players) {
          const g = phvGate(p);
          expect(g.ok && g.assessment.timing).toBe(timing);
        }
      }
    } finally {
      vi.mocked(PlayerService.getAll).mockReturnValue(mockPlayers as never);
      vi.useRealTimers();
    }
  });

  it("filters by position", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { position: "Mediocentro" });
    expect(result.players.length).toBe(2);
    expect(result.players.every(p => p.position === "Mediocentro")).toBe(true);
  });

  it("filters by age group", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { ageGroup: "Sub-14" });
    expect(result.players.length).toBe(3);
    expect(result.players.every(p => p.age >= 13 && p.age <= 14)).toBe(true);
  });

  it("filters by competitive level", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { level: "Nacional" });
    expect(result.players.length).toBe(3);
  });

  it("timing=all returns all players", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { timing: "all" });
    expect(result.players.length).toBe(5);
  });

  it("position=Todos returns all", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", { position: "Todos" });
    expect(result.players.length).toBe(5);
  });

  it("combines multiple filters", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {
      ageGroup: "Sub-14",
      level: "Nacional",
    });
    // Sub-14 (Ana, Diana, Emilio) + Nacional (Ana, Emilio) = 2
    expect(result.players.length).toBe(2);
  });

  // ── Competitive levels ──────────────────────────────────────────────

  it("returns unique competitive levels", async () => {
    const result = await fetchRankedPlayers("vsi", "desc", {});
    expect(result.competitiveLevels).toContain("Nacional");
    expect(result.competitiveLevels).toContain("Regional");
    expect(result.competitiveLevels).toContain("Provincial");
  });
});
