/**
 * VITAS · Tests — Audit Service
 * Verifica: runSync, runFull, quickStatus, secciones de auditoría
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock de dependencias antes de importar el servicio
vi.mock("@/services/real/storageService", () => ({
  StorageService: {
    keys: vi.fn(() => ["players", "settings", "cache"]),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
  },
}));

vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getAll: vi.fn(() => [
      { id: "1", name: "Alfa", vsi: 72, phvCategory: "ontime" },
      { id: "2", name: "Beta", vsi: 65, phvCategory: "early" },
      { id: "3", name: "Gamma", vsi: 80, phvCategory: null },
      { id: "4", name: "Delta", vsi: 58, phvCategory: "late" },
      { id: "5", name: "Epsilon", vsi: 0, phvCategory: null },
      { id: "6", name: "Zeta", vsi: 70, phvCategory: "ontime" },
    ]),
  },
}));

vi.mock("@/services/real/metricsService", () => ({
  MetricsService: {
    calculateVSI: vi.fn((m: Record<string, number>) => {
      const vals = Object.values(m);
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }),
    classifyVSI: vi.fn((vsi: number) => {
      if (vsi >= 85) return "elite";
      if (vsi >= 70) return "high";
      if (vsi >= 55) return "medium";
      return "developing";
    }),
  },
}));

import { AuditService } from "@/services/real/auditService";
import { StorageService } from "@/services/real/storageService";
import { PlayerService } from "@/services/real/playerService";

describe("AuditService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runSync", () => {
    it("retorna AuditReport con timestamp y secciones", () => {
      const report = AuditService.runSync();

      expect(report.timestamp).toBeDefined();
      expect(report.sections.length).toBeGreaterThanOrEqual(3);
      expect(report.summary.total).toBeGreaterThan(0);
      expect(["ok", "warning", "error"]).toContain(report.overall);
    });

    it("sección Storage detecta localStorage disponible", () => {
      const report = AuditService.runSync();
      const storage = report.sections.find(s => s.section.includes("Storage"));

      expect(storage).toBeDefined();
      const lsCheck = storage!.checks.find(c => c.name.includes("localStorage"));
      expect(lsCheck).toBeDefined();
      expect(lsCheck!.status).toBe("ok");
    });

    it("sección Storage cuenta claves vitas_", () => {
      const report = AuditService.runSync();
      const storage = report.sections.find(s => s.section.includes("Storage"));
      const keysCheck = storage!.checks.find(c => c.name.includes("Claves"));

      expect(keysCheck).toBeDefined();
      expect(keysCheck!.status).toBe("ok");
    });

    it("sección PlayerService verifica getAll", () => {
      const report = AuditService.runSync();
      const ps = report.sections.find(s => s.section.includes("PlayerService"));

      expect(ps).toBeDefined();
      const getAllCheck = ps!.checks.find(c => c.name.includes("getAll"));
      expect(getAllCheck).toBeDefined();
      expect(getAllCheck!.status).toBe("ok");
    });

    it("sección PlayerService calcula % con VSI", () => {
      const report = AuditService.runSync();
      const ps = report.sections.find(s => s.section.includes("PlayerService"));
      const vsiCheck = ps!.checks.find(c => c.name.includes("VSI"));

      expect(vsiCheck).toBeDefined();
      // 5 de 6 tienen vsi > 0
      expect(vsiCheck!.message).toContain("5/6");
    });

    it("sección MetricsService verifica coherencia de pesos VSI", () => {
      const report = AuditService.runSync();
      const ms = report.sections.find(s => s.section.includes("MetricsService"));

      expect(ms).toBeDefined();
      const pesosCheck = ms!.checks.find(c => c.name.includes("Pesos"));
      expect(pesosCheck).toBeDefined();
      expect(pesosCheck!.status).toBe("ok");
    });

    it("sección MetricsService verifica classifyVSI", () => {
      const report = AuditService.runSync();
      const ms = report.sections.find(s => s.section.includes("MetricsService"));
      const classifyCheck = ms!.checks.find(c => c.name.includes("classifyVSI"));

      expect(classifyCheck).toBeDefined();
      expect(classifyCheck!.status).toBe("ok");
    });

    it("sección Entorno reporta modo de desarrollo", () => {
      const report = AuditService.runSync();
      const env = report.sections.find(s => s.section.includes("Entorno"));

      expect(env).toBeDefined();
      const modeCheck = env!.checks.find(c => c.name.includes("Modo"));
      expect(modeCheck).toBeDefined();
    });

    it("summary cuenta checks correctamente", () => {
      const report = AuditService.runSync();
      const { total, ok, warnings, errors } = report.summary;

      expect(total).toBe(ok + warnings + errors);
      expect(total).toBeGreaterThan(0);
    });

    it("overall es el peor status de todos los checks", () => {
      const report = AuditService.runSync();

      if (report.summary.errors > 0) {
        expect(report.overall).toBe("error");
      } else if (report.summary.warnings > 0) {
        expect(report.overall).toBe("warning");
      } else {
        expect(report.overall).toBe("ok");
      }
    });
  });

  describe("runSync con storage vacío", () => {
    it("sin claves → warning en Storage", () => {
      vi.mocked(StorageService.keys).mockReturnValueOnce([]);

      const report = AuditService.runSync();
      const storage = report.sections.find(s => s.section.includes("Storage"));
      const keysCheck = storage!.checks.find(c => c.name.includes("Claves"));

      expect(keysCheck!.status).toBe("warning");
    });
  });

  describe("runSync con PlayerService vacío", () => {
    it("sin jugadores → registrados warning", () => {
      vi.mocked(PlayerService.getAll).mockReturnValue([]);

      const report = AuditService.runSync();
      const ps = report.sections.find(s => s.section.includes("PlayerService"));
      const registradosCheck = ps!.checks.find(c => c.name.includes("registrados"));

      expect(registradosCheck!.status).toBe("warning");
    });
  });

  describe("runFull", () => {
    it("incluye sección de agentes (async)", async () => {
      // Mock fetch para evitar llamadas reales
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));

      const report = await AuditService.runFull();
      const agents = report.sections.find(s => s.section.includes("Agentes"));

      expect(agents).toBeDefined();
      expect(agents!.checks.length).toBe(4); // 4 agent endpoints

      globalThis.fetch = originalFetch;
    });
  });

  describe("quickStatus", () => {
    it("retorna un AuditStatus válido", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));

      const status = await AuditService.quickStatus();
      expect(["ok", "warning", "error"]).toContain(status);

      globalThis.fetch = originalFetch;
    });
  });
});
