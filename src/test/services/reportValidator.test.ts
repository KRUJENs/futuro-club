/**
 * VITAS · Tests — Report Semantic Validator
 * Verifica: coherencia de player reports, team reports y PHV outputs
 */
import { describe, it, expect } from "vitest";
import {
  validatePlayerReport,
  validateTeamReport,
  validatePHVOutput,
} from "@/services/real/reportValidator";

// ── Helpers: objetos base válidos ────────────────────────────────────────────

function makeValidPlayerReport() {
  return {
    estadoActual: {
      nivelActual: "alto" as const,
      dimensiones: {
        velocidadDecision: { score: 7 },
        tecnicaConBalon: { score: 7 },
        inteligenciaTactica: { score: 7 },
        capacidadFisica: { score: 7 },
        liderazgoPresencia: { score: 6 },
        eficaciaCompetitiva: { score: 7 },
      },
      fortalezasPrimarias: ["Visión de juego", "Velocidad"],
      areasDesarrollo: ["Juego aéreo"],
    },
    proyeccionCarrera: {
      escenarioOptimista: { nivelProyecto: "Segunda División" },
    },
    planDesarrollo: {
      objetivo18meses: "Consolidar en equipo juvenil competitivo",
      pilaresTrabajo: [{ nombre: "Juego aéreo" }],
    },
    metricasCuantitativas: {
      fisicas: {
        velocidadMaxKmh: 28,
        velocidadPromKmh: 7,
        distanciaM: 9500,
        zonasIntensidad: { caminar: 40, trotar: 30, correr: 20, sprint: 10 },
      },
      eventos: {
        pasesCompletados: 30,
        pasesFallados: 10,
        precisionPases: 75,
        duelosGanados: 8,
        duelosPerdidos: 5,
      },
    },
    jugadorReferencia: {
      bestMatch: { score: 65 },
    },
  } as any;
}

function makeValidTeamReport() {
  // Team level only (identidad.md): no per-player rows / dorsal.
  return {
    equipoAnalizado: { jugadoresDetectados: 3 },
    posesion: { porcentaje: 55 },
    metricasColectivas: {
      compacidad: 7,
      amplitud: 5,
      sincronizacion: 6,
      alturaLineaDefensiva: "media" as const,
    },
    fasesJuego: {
      pressing: { alturaLinea: "media" as const, intensidad: 6 },
    },
    evaluacionGeneral: {
      fortalezasEquipo: ["Posesión", "Pressing"],
    },
  } as any;
}

const defaultPlayerContext = { age: 15, position: "mediocampista", currentVSI: 60 };

// ── validatePlayerReport ─────────────────────────────────────────────────────

describe("validatePlayerReport", () => {
  it("reporte válido con scores coherentes → valid=true, qualityScore=100", () => {
    const report = makeValidPlayerReport();
    const result = validatePlayerReport(report, defaultPlayerContext);

    expect(result.valid).toBe(true);
    expect(result.qualityScore).toBe(100);
    expect(result.issues).toHaveLength(0);
    expect(result.feedbackForAgent).toBeUndefined();
  });

  describe("nivel_dimension_coherence", () => {
    it("nivel 'elite' con avgScore < 6.5 → error", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.nivelActual = "elite";
      // avg = (4+4+4+4+4+4)/6 = 4.0
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 4;
      }

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "nivel_dimension_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it("nivel 'desarrollo' con avgScore > 5.5 → error", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.nivelActual = "desarrollo";
      // avg = (6+6+6+6+6+6)/6 = 6.0
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 6;
      }

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "nivel_dimension_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it("nivel 'alto' con avgScore < 3.5 → error", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.nivelActual = "alto";
      // avg = (3+3+3+3+3+3)/6 = 3.0
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 3;
      }

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "nivel_dimension_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("strengths_dimension_alignment", () => {
    it("todas dimensiones < 4 pero > 2 fortalezas → warning", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.nivelActual = "desarrollo";
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 3;
      }
      report.estadoActual.fortalezasPrimarias = ["A", "B", "C"];

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find((i: any) => i.rule === "strengths_dimension_alignment");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("age_projection_realism", () => {
    it("edad <= 10 con proyección elite → warning", () => {
      const report = makeValidPlayerReport();
      report.proyeccionCarrera.escenarioOptimista.nivelProyecto = "Primera División top europeo";

      const result = validatePlayerReport(report, { age: 9, position: "delantero" });

      const issue = result.issues.find((i: any) => i.rule === "age_projection_realism");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("age_plan_coherence", () => {
    it("edad >= 19 con objetivo formativo → warning", () => {
      const report = makeValidPlayerReport();
      report.planDesarrollo.objetivo18meses = "Completar etapa formativa en cantera";

      const result = validatePlayerReport(report, { age: 20, position: "defensa" });

      const issue = result.issues.find((i: any) => i.rule === "age_plan_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("vsi_dimension_coherence", () => {
    it("avgScore >= 7 pero vsiDelta < -5 → error", () => {
      const report = makeValidPlayerReport();
      // Subimos todas las dimensiones a 7 para asegurar avg = 7.0
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 7;
      }
      report.estadoActual.ajusteVSIVideoScore = -8;

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "vsi_dimension_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it("avgScore < 3.5 pero vsiDelta > 5 → error", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.nivelActual = "desarrollo";
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 3;
      }
      report.estadoActual.ajusteVSIVideoScore = 8;

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "vsi_dimension_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("physical_plausibility", () => {
    it("velocidadMaxKmh > 38 → error", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.fisicas.velocidadMaxKmh = 42;

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find(
        (i: any) => i.rule === "physical_plausibility" && i.fields.includes("metricasCuantitativas.fisicas.velocidadMaxKmh")
      );
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it("velocidadPromKmh > velocidadMaxKmh → error", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.fisicas.velocidadPromKmh = 30;
      report.metricasCuantitativas.fisicas.velocidadMaxKmh = 25;

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find(
        (i: any) => i.rule === "physical_plausibility" && i.message.includes("promedio")
      );
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it("distanciaM > 15000 → warning", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.fisicas.distanciaM = 16000;

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find(
        (i: any) => i.rule === "physical_plausibility" && i.fields.includes("metricasCuantitativas.fisicas.distanciaM")
      );
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("physical_zones_sum", () => {
    it("zonasIntensidad suma fuera de 90-110 → warning", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.fisicas.zonasIntensidad = {
        caminar: 20,
        trotar: 20,
        correr: 10,
        sprint: 5,
      };
      // suma = 55

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find((i: any) => i.rule === "physical_zones_sum");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("event_consistency", () => {
    it("precisionPases mismatch > 5% → error", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.eventos.pasesCompletados = 60;
      report.metricasCuantitativas.eventos.pasesFallados = 40;
      // real = 60%, reportada = 75% → diff = 15%
      report.metricasCuantitativas.eventos.precisionPases = 75;

      const result = validatePlayerReport(report, defaultPlayerContext);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "event_consistency");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("event_plausibility", () => {
    it("totalDuels > 100 → warning", () => {
      const report = makeValidPlayerReport();
      report.metricasCuantitativas.eventos.duelosGanados = 60;
      report.metricasCuantitativas.eventos.duelosPerdidos = 50;

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find((i: any) => i.rule === "event_plausibility");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("reference_player_quality", () => {
    it("bestMatch score < 20 → warning", () => {
      const report = makeValidPlayerReport();
      report.jugadorReferencia.bestMatch.score = 12;

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find((i: any) => i.rule === "reference_player_quality");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("plan_coverage", () => {
    it("areasDesarrollo pero sin pilaresTrabajo → warning", () => {
      const report = makeValidPlayerReport();
      report.estadoActual.areasDesarrollo = ["Juego aéreo", "Definición"];
      report.planDesarrollo.pilaresTrabajo = [];

      const result = validatePlayerReport(report, defaultPlayerContext);

      const issue = result.issues.find((i: any) => i.rule === "plan_coverage");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("qualityScore", () => {
    it("múltiples errores reducen qualityScore correctamente (100 - errors*20 - warnings*5)", () => {
      const report = makeValidPlayerReport();
      // Error 1: elite con scores bajos → nivel_dimension_coherence
      report.estadoActual.nivelActual = "elite";
      for (const dim of Object.values(report.estadoActual.dimensiones) as any[]) {
        dim.score = 3;
      }
      // Error 2: vsiDelta < -5 con avg bajo → no aplica (avg < 7)
      // Mejor: velocidad imposible → physical_plausibility error
      report.metricasCuantitativas.fisicas.velocidadMaxKmh = 42;
      // Error 3: velocidadProm > velocidadMax → physical_plausibility error
      report.metricasCuantitativas.fisicas.velocidadPromKmh = 43;
      // Warning 1: fortalezas con dimensiones bajas
      report.estadoActual.fortalezasPrimarias = ["A", "B", "C"];
      // Warning 2: bestMatch < 20
      report.jugadorReferencia.bestMatch.score = 10;

      const result = validatePlayerReport(report, defaultPlayerContext);

      const errorCount = result.issues.filter((i: any) => i.severity === "error").length;
      const warningCount = result.issues.filter((i: any) => i.severity === "warning").length;

      expect(errorCount).toBeGreaterThanOrEqual(3);
      expect(warningCount).toBeGreaterThanOrEqual(2);
      expect(result.qualityScore).toBe(Math.max(0, 100 - errorCount * 20 - warningCount * 5));
      expect(result.valid).toBe(false);
      expect(result.feedbackForAgent).toBeDefined();
    });
  });
});

// ── validateTeamReport ───────────────────────────────────────────────────────

describe("validateTeamReport", () => {
  it("reporte de equipo válido → valid=true", () => {
    const report = makeValidTeamReport();
    const result = validateTeamReport(report);

    expect(result.valid).toBe(true);
    expect(result.qualityScore).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  describe("identity (team level only)", () => {
    it("per-player rows of a legacy report are not validated nor quoted (no dorsal in any message)", () => {
      const report = makeValidTeamReport();
      report.jugadores = [
        { velocidadMaxKmh: 40, distanciaM: 16000, dorsalEstimado: "7", rendimiento: "bajo" },
      ];

      const result = validateTeamReport(report);

      expect(result.valid).toBe(true);
      expect(result.issues.some((i: any) => /^player_|formation_player_count|evaluation_player/.test(i.rule))).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/dorsal|Jugador 7/i);
    });
  });

  describe("possession_realism", () => {
    it("posesión < 10 → warning", () => {
      const report = makeValidTeamReport();
      report.posesion.porcentaje = 5;

      const result = validateTeamReport(report);

      const issue = result.issues.find((i: any) => i.rule === "possession_realism");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });

    it("posesión > 90 → warning", () => {
      const report = makeValidTeamReport();
      report.posesion.porcentaje = 95;

      const result = validateTeamReport(report);

      const issue = result.issues.find((i: any) => i.rule === "possession_realism");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });

    it("posesión null (no observada) → sin aviso (antes «Posesión de null% es extrema»)", () => {
      const report = makeValidTeamReport();
      report.posesion.porcentaje = null;

      const result = validateTeamReport(report);

      expect(result.issues.some((i: any) => i.rule === "possession_realism")).toBe(false);
      expect(JSON.stringify(result)).not.toContain("null%");
    });
  });

  describe("collective_metrics_coherence", () => {
    it("compacidad >= 9 Y amplitud >= 9 → warning", () => {
      const report = makeValidTeamReport();
      report.metricasColectivas.compacidad = 9.5;
      report.metricasColectivas.amplitud = 9.2;

      const result = validateTeamReport(report);

      const issue = result.issues.find((i: any) => i.rule === "collective_metrics_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });
  });

  describe("pressing_line_coherence", () => {
    it("pressing alta + intensidad >= 7 + linea defensiva baja → error", () => {
      const report = makeValidTeamReport();
      report.fasesJuego.pressing.alturaLinea = "alta";
      report.fasesJuego.pressing.intensidad = 8;
      report.metricasColectivas.alturaLineaDefensiva = "baja";

      const result = validateTeamReport(report);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "pressing_line_coherence");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });
});

// ── validatePHVOutput ────────────────────────────────────────────────────────

describe("validatePHVOutput", () => {
  it("output PHV válido → valid=true, qualityScore=100", () => {
    const output = {
      ageAtPHV: 13.5, // = 14.0 − 0.5
      chronologicalAge: 14.0,
      offset: 0.5,
      category: "ontme",
      adjustedVSI: 65,
    };

    const result = validatePHVOutput(output, 14.0);

    expect(result.valid).toBe(true);
    expect(result.qualityScore).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  describe("phv_offset_consistency", () => {
    it("offset no coincide con chrono − ageAtPHV → error", () => {
      const output = {
        ageAtPHV: 13.5, // offset coherente sería 14.0 − 13.5 = 0.5
        chronologicalAge: 14.0,
        offset: 2.5, // no coincide con 0.5
        category: "late",
        adjustedVSI: 60,
      };

      const result = validatePHVOutput(output, 14.0);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "phv_offset_consistency");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("phv_category_consistency", () => {
    it("categoría no coincide con offset → error", () => {
      const output = {
        ageAtPHV: 12.0, // = 14.0 − 2.0 (offset coherente)
        chronologicalAge: 14.0,
        offset: 2.0, // > 1 → debería ser "late"
        category: "early",
        adjustedVSI: 60,
      };

      const result = validatePHVOutput(output, 14.0);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "phv_category_consistency");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("phv_age_plausibility", () => {
    it("ageAtPHV fuera de 8-18 → error", () => {
      const output = {
        ageAtPHV: 5, // < 8 → implausible (offset 9.0 = 14.0 − 5 coherente)
        chronologicalAge: 14.0,
        offset: 9.0,
        category: "late",
        adjustedVSI: 60,
      };

      const result = validatePHVOutput(output, 14.0);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "phv_age_plausibility");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });

  describe("phv_vsi_range", () => {
    it("adjustedVSI fuera de 0-100 → error", () => {
      const output = {
        ageAtPHV: 13.5, // = 14.0 − 0.5
        chronologicalAge: 14.0,
        offset: 0.5,
        category: "ontme",
        adjustedVSI: 120,
      };

      const result = validatePHVOutput(output, 14.0);

      expect(result.valid).toBe(false);
      const issue = result.issues.find((i: any) => i.rule === "phv_vsi_range");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });
  });
});
