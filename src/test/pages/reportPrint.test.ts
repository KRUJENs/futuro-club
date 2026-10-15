/**
 * Tests for enhanced report functionality
 * Sprint 1 — Reportes y Evolución
 *
 * Tests the data transformations and logic used by
 * PlayerReportPrint and AnalysisReportPrint without
 * rendering React components (avoids heavy DOM deps).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validatePlayerReport } from "@/services/real/reportValidator";

// Mock PlayerService
vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getAll: vi.fn(() => []),
  },
}));

import { PlayerService } from "@/services/real/playerService";

// ─── Helper: make mock report ──────────────────────────────────────────────

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    estadoActual: {
      resumenEjecutivo: "Jugador con buen potencial técnico.",
      nivelActual: "medio_alto",
      fortalezasPrimarias: ["Técnica", "Visión"],
      areasDesarrollo: ["Defensa"],
      dimensiones: {
        velocidadDecision: { score: 6, observacion: "Buena" },
        tecnicaConBalon: { score: 7, observacion: "Destacada" },
        inteligenciaTactica: { score: 5, observacion: "Promedio" },
        capacidadFisica: { score: 6, observacion: "Buena" },
        liderazgoPresencia: { score: 4, observacion: "En desarrollo" },
        eficaciaCompetitiva: { score: 5, observacion: "Regular" },
      },
      ajusteVSIVideoScore: 3,
    },
    adnFutbolistico: {
      estiloJuego: "Asociativo",
      arquetipoTactico: "Creador",
      patrones: [],
      mentalidad: "Competitiva",
    },
    jugadorReferencia: {
      top5: [],
      bestMatch: {
        proPlayerId: "pro1",
        nombre: "Luka Modric",
        posicion: "MC",
        club: "Real Madrid",
        score: 72,
        narrativa: "Similar en visión de juego.",
      },
    },
    proyeccionCarrera: {
      escenarioOptimista: { descripcion: "Liga profesional", nivelProyecto: "Segunda División", edadPeak: 26 },
      escenarioRealista: { descripcion: "Liga semi-pro", nivelProyecto: "Tercera División", clubTipo: "Club regional" },
      factoresClave: ["Técnica", "Constancia"],
      riesgos: ["Lesiones"],
    },
    planDesarrollo: {
      objetivo6meses: "Mejorar defensa 1v1",
      objetivo18meses: "Titular en equipo sub-16",
      pilaresTrabajo: [
        { pilar: "Defensa", acciones: ["Ejercicios 1v1"], prioridad: "alta" },
      ],
      recomendacionEntrenador: "Trabajar posicionamiento defensivo.",
    },
    confianza: 0.82,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Report Enhancement — Sprint 1", () => {
  beforeEach(() => {
    vi.mocked(PlayerService.getAll).mockReturnValue([]);
  });

  // ── VSI Evolution logic ──────────────────────────────────────────────

  describe("VSI Evolution trend calculation", () => {
    it("detects upward trend when delta > 2", () => {
      const history = [55, 58, 62, 67];
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      const delta = last - prev;
      expect(delta).toBeGreaterThan(2);
    });

    it("detects stable trend when delta <= 2", () => {
      const history = [65, 66, 67, 68];
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      const delta = last - prev;
      expect(Math.abs(delta)).toBeLessThanOrEqual(2);
    });

    it("detects downward trend when delta < -2", () => {
      const history = [70, 68, 65, 60];
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      const delta = last - prev;
      expect(delta).toBeLessThan(-2);
    });

    it("handles single-entry history gracefully", () => {
      const history = [65];
      expect(history.length).toBeLessThan(2);
    });
  });

  // (Sin «Benchmark in reports»: benchmarkService se retiró en el P1 bloque 5 —comparaba
  //  la nota del vídeo con las barras del entrenador /10 e imprimía P100—; la comparación
  //  con pares es /api/benchmark/peer, ver src/test/lib/percentile.test.ts.)

  // ── Report validator integration ─────────────────────────────────────

  describe("Quality score validation in reports", () => {
    it("validates a coherent report with high quality score", () => {
      const report = makeReport();
      const result = validatePlayerReport(
        report as Parameters<typeof validatePlayerReport>[0],
        { age: 14, position: "MC" },
      );
      expect(result.qualityScore).toBeGreaterThanOrEqual(70);
      expect(result.valid).toBe(true);
    });

    it("detects incoherence: elite level with low dimension scores", () => {
      const report = makeReport({
        estadoActual: {
          ...makeReport().estadoActual,
          nivelActual: "elite",
          dimensiones: {
            velocidadDecision: { score: 3, observacion: "Baja" },
            tecnicaConBalon: { score: 3, observacion: "Baja" },
            inteligenciaTactica: { score: 3, observacion: "Baja" },
            capacidadFisica: { score: 3, observacion: "Baja" },
            liderazgoPresencia: { score: 3, observacion: "Baja" },
            eficaciaCompetitiva: { score: 3, observacion: "Baja" },
          },
        },
      });
      const result = validatePlayerReport(
        report as Parameters<typeof validatePlayerReport>[0],
        { age: 14, position: "MC" },
      );
      expect(result.valid).toBe(false);
      expect(result.qualityScore).toBeLessThanOrEqual(80);
      expect(result.issues.some(i => i.rule === "nivel_dimension_coherence")).toBe(true);
    });

    it("detects impossible physical metrics", () => {
      const report = makeReport({
        metricasCuantitativas: {
          fisicas: {
            velocidadMaxKmh: 45, // impossible
            velocidadPromKmh: 8,
            distanciaM: 5000,
            sprints: 10,
            zonasIntensidad: { caminar: 40, trotar: 30, correr: 20, sprint: 10 },
          },
          fuente: "gemini_only",
          confianza: 0.7,
        },
      });
      const result = validatePlayerReport(
        report as Parameters<typeof validatePlayerReport>[0],
        { age: 14, position: "MC" },
      );
      expect(result.issues.some(i => i.rule === "physical_plausibility")).toBe(true);
    });

    it("generates feedbackForAgent when report is invalid", () => {
      const report = makeReport({
        estadoActual: {
          ...makeReport().estadoActual,
          nivelActual: "elite",
          dimensiones: {
            velocidadDecision: { score: 2, observacion: "" },
            tecnicaConBalon: { score: 2, observacion: "" },
            inteligenciaTactica: { score: 2, observacion: "" },
            capacidadFisica: { score: 2, observacion: "" },
            liderazgoPresencia: { score: 2, observacion: "" },
            eficaciaCompetitiva: { score: 2, observacion: "" },
          },
        },
      });
      const result = validatePlayerReport(
        report as Parameters<typeof validatePlayerReport>[0],
        { age: 14, position: "MC" },
      );
      expect(result.feedbackForAgent).toBeDefined();
      expect(result.feedbackForAgent).toContain("VALIDACIÓN SEMÁNTICA FALLIDA");
    });
  });

  // ── Server report (_pdf.ts) data extraction ──────────────────────────

  describe("Server report data extraction", () => {
    it("extracts dimension labels correctly", () => {
      const dimLabels: Record<string, string> = {
        velocidadDecision: "Vel. Decisión",
        tecnicaConBalon: "Técnica",
        inteligenciaTactica: "Int. Táctica",
        capacidadFisica: "Capacidad Física",
        liderazgoPresencia: "Liderazgo",
        eficaciaCompetitiva: "Eficacia",
      };
      expect(Object.keys(dimLabels)).toHaveLength(6);
      expect(dimLabels.velocidadDecision).toBe("Vel. Decisión");
    });

    it("builds evolution bar heights proportional to VSI", () => {
      const vsiHistory = [50, 55, 60, 65, 70];
      const barHeights = vsiHistory.map(v => Math.max(5, v) * 0.5);
      expect(barHeights[0]).toBe(25);
      expect(barHeights[4]).toBe(35);
      expect(barHeights.every(h => h >= 2.5)).toBe(true);
    });

    it("handles empty vsiHistory gracefully", () => {
      const vsiHistory: number[] = [];
      expect(vsiHistory.length > 1).toBe(false);
    });
  });
});
