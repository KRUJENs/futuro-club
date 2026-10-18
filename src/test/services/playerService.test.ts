/**
 * VITAS · Tests — PlayerService
 * Verifica: CRUD, updatePHV, updateMetrics, sort, seedIfEmpty
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PlayerService } from "@/services/real/playerService";
import type { CreatePlayerInput } from "@/services/real/playerService";

// ── Datos de prueba ──────────────────────────────────────────────────────────

const samplePlayer: CreatePlayerInput = {
  name: "Test Player",
  age: 15,
  position: "RW",
  foot: "right",
  height: 172,
  weight: 62,
  competitiveLevel: "Regional",
  minutesPlayed: 840,
  metrics: { speed: 80, technique: 74, vision: 71, stamina: 76, shooting: 78, defending: 45 },
  gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe("PlayerService", () => {
  describe("create", () => {
    it("crea un jugador con ID generado", () => {
      const player = PlayerService.create(samplePlayer);
      expect(player.id).toBeDefined();
      expect(player.id).toMatch(/^p\d+(_\d+)?$/);
      expect(player.name).toBe("Test Player");
    });

    it("calcula VSI al crear", () => {
      const player = PlayerService.create(samplePlayer);
      expect(player.vsi).toBeGreaterThan(0);
      expect(player.vsiHistory).toHaveLength(1);
      expect(player.vsiHistory[0]).toBe(player.vsi);
    });

    it("asigna createdAt y updatedAt", () => {
      const player = PlayerService.create(samplePlayer);
      expect(player.createdAt).toBeTruthy();
      expect(player.updatedAt).toBeTruthy();
    });
  });

  describe("getAll", () => {
    it("retorna array vacío sin jugadores", () => {
      expect(PlayerService.getAll()).toEqual([]);
    });

    it("retorna todos los jugadores creados", () => {
      PlayerService.create(samplePlayer);
      PlayerService.create({ ...samplePlayer, name: "Otro Jugador" });
      expect(PlayerService.getAll()).toHaveLength(2);
    });
  });

  describe("getById", () => {
    it("retorna jugador existente", () => {
      const created = PlayerService.create(samplePlayer);
      const found = PlayerService.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Test Player");
    });

    it("retorna null para ID inexistente", () => {
      expect(PlayerService.getById("no-existe")).toBeNull();
    });
  });

  describe("delete", () => {
    it("elimina jugador existente", () => {
      const player = PlayerService.create(samplePlayer);
      const deleted = PlayerService.delete(player.id);
      expect(deleted).toBe(true);
      expect(PlayerService.getById(player.id)).toBeNull();
    });

    it("retorna false para ID inexistente", () => {
      expect(PlayerService.delete("no-existe")).toBe(false);
    });
  });

  describe("updateMetrics", () => {
    it("actualiza métricas y recalcula VSI", async () => {
      const player = PlayerService.create(samplePlayer);
      const newMetrics = { speed: 90, technique: 85, vision: 80, stamina: 75, shooting: 70, defending: 65 };
      const updated = await PlayerService.updateMetrics(player.id, newMetrics);
      expect(updated).not.toBeNull();
      expect(updated!.metrics!.speed).toBe(90);
      expect(updated!.vsi).not.toBe(player.vsi);
    });

    it("agrega nuevo VSI al historial (máx 10)", async () => {
      const player = PlayerService.create(samplePlayer);
      const newMetrics = { speed: 90, technique: 85, vision: 80, stamina: 75, shooting: 70, defending: 65 };
      const updated = await PlayerService.updateMetrics(player.id, newMetrics);
      expect(updated!.vsiHistory).toHaveLength(2);
    });

    it("retorna null para ID inexistente", async () => {
      const result = await PlayerService.updateMetrics("no-existe", samplePlayer.metrics!);
      expect(result).toBeNull();
    });

    it("registra cada evaluación con fecha y origen (vsiEvaluations) y permite una variación honesta", async () => {
      const player = PlayerService.create(samplePlayer);
      expect(player.vsiEvaluations).toHaveLength(1);
      expect(player.vsiEvaluations![0]).toMatchObject({ value: player.vsi, source: "coach_form" });
      expect(Number.isFinite(Date.parse(player.vsiEvaluations![0].at))).toBe(true);

      const updated = await PlayerService.updateMetrics(player.id, { speed: 90, technique: 85, vision: 80, stamina: 75, shooting: 70, defending: 65 });
      expect(updated!.vsiEvaluations).toHaveLength(2);
      expect(updated!.vsiEvaluations![1]).toMatchObject({ value: updated!.vsi, source: "coach_form" });
      // Persistido en localStorage (sobrevive recargas).
      expect(PlayerService.getById(player.id)!.vsiEvaluations).toHaveLength(2);
    });

    it("jugador de ejemplo (isDemo): sus evaluaciones se marcan demo_seed, nunca como reales", async () => {
      const demo = PlayerService.create({ ...samplePlayer, isDemo: true });
      expect(demo.vsiEvaluations![0].source).toBe("demo_seed");
      const upd = await PlayerService.updateMetrics(demo.id, samplePlayer.metrics!);
      expect(upd!.vsiEvaluations!.every((e) => e.source === "demo_seed")).toBe(true);
    });
  });

  describe("create sin métricas", () => {
    it("alta sin evaluar ⇒ vsi null, sin evaluaciones", () => {
      const { metrics: _m, ...noMetrics } = samplePlayer;
      const p = PlayerService.create(noMetrics);
      expect(p.vsi).toBeNull();
      expect(p.vsiEvaluations).toEqual([]);
    });
  });

  describe("PHV persistido (gate único · regla del owner 28-sep)", () => {
    it("updatePHV ya no existe: nada sobrescribe el VSI con un «VSI ajustado» sin procedencia", () => {
      expect((PlayerService as unknown as Record<string, unknown>).updatePHV).toBeUndefined();
    });

    it("getAll retira un phvCategory/phvOffset persistido si faltan entradas introducidas", () => {
      const player = PlayerService.create({ ...samplePlayer, phvCategory: "early", phvOffset: -1.2 });
      const read = PlayerService.getById(player.id)!;
      expect(read.phvCategory).toBeUndefined();
      expect(read.phvOffset).toBeUndefined();
    });

    it("getAll recalcula la categoría desde entradas completas (no la persistida)", () => {
      const player = PlayerService.create({
        ...samplePlayer,
        height: 165, weight: 55, sittingHeight: 85, legLength: 80,
        birthDate: "2012-03-15", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
        phvCategory: "late", phvOffset: 9,
      });
      const read = PlayerService.getById(player.id)!;
      expect(read.phvOffset).not.toBe(9);
      expect(typeof read.phvOffset).toBe("number");
    });
  });

  describe("update (datos parentales / antropometría)", () => {
    it("persiste alturas parentales + fecha de nacimiento", async () => {
      const player = PlayerService.create(samplePlayer);
      const updated = await PlayerService.update(player.id, {
        birthDate: "2010-05-01",
        motherHeightCm: 165,
        fatherHeightCm: 180,
      });
      expect(updated).not.toBeNull();
      expect(updated!.birthDate).toBe("2010-05-01");
      expect(updated!.motherHeightCm).toBe(165);
      expect(updated!.fatherHeightCm).toBe(180);
      // persistido (no solo en memoria)
      const reread = PlayerService.getById(player.id);
      expect(reread!.fatherHeightCm).toBe(180);
    });

    it("es parcial: no pisa otros campos", async () => {
      const player = PlayerService.create(samplePlayer);
      await PlayerService.update(player.id, { motherHeightCm: 170 });
      const reread = PlayerService.getById(player.id);
      expect(reread!.name).toBe("Test Player");
      expect(reread!.vsi).toBe(player.vsi);
      expect(reread!.motherHeightCm).toBe(170);
    });

    it("retorna null para ID inexistente", async () => {
      const result = await PlayerService.update("no-existe", { motherHeightCm: 165 });
      expect(result).toBeNull();
    });
  });

  describe("sort", () => {
    it("ordena por VSI ascendente", () => {
      const p1 = PlayerService.create({ ...samplePlayer, name: "Alfa", metrics: { ...samplePlayer.metrics!, speed: 90 } });
      const p2 = PlayerService.create({ ...samplePlayer, name: "Beta", metrics: { ...samplePlayer.metrics!, speed: 40 } });
      const all = PlayerService.getAll();
      const sorted = PlayerService.sort(all, "vsi", "asc");
      expect(sorted[0].vsi).toBeLessThanOrEqual(sorted[1].vsi);
    });

    it("ordena por nombre descendente", () => {
      PlayerService.create({ ...samplePlayer, name: "Zebra" });
      PlayerService.create({ ...samplePlayer, name: "Alfa" });
      const all = PlayerService.getAll();
      const sorted = PlayerService.sort(all, "name", "desc");
      expect(sorted[0].name).toBe("Zebra");
    });

    it("ordena por edad", () => {
      PlayerService.create({ ...samplePlayer, name: "Joven", age: 12 });
      PlayerService.create({ ...samplePlayer, name: "Mayor", age: 18 });
      const all = PlayerService.getAll();
      const sorted = PlayerService.sort(all, "age", "asc");
      expect(sorted[0].age).toBe(12);
    });
  });

  describe("getAllVSIs", () => {
    it("retorna array de VSIs", () => {
      PlayerService.create(samplePlayer);
      PlayerService.create({ ...samplePlayer, name: "Otro" });
      const vsis = PlayerService.getAllVSIs();
      expect(vsis).toHaveLength(2);
      vsis.forEach((v) => expect(v).toBeGreaterThan(0));
    });
  });

  describe("seedIfEmpty", () => {
    it("no siembra si ya hay jugadores", () => {
      PlayerService.create(samplePlayer);
      const countBefore = PlayerService.getAll().length;
      PlayerService.seedIfEmpty();
      expect(PlayerService.getAll().length).toBe(countBefore);
    });
  });
});
