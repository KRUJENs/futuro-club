/**
 * P1 bloque 7a-2 (decisión del dueño D2) — la proyección de carrera («Top semipro»,
 * escenarios, factores, riesgos) y la competitiva no se pintan en ninguna superficie, ni
 * de análisis nuevos ni de informes antiguos guardados: en su lugar, el motivo.
 */
import { describe, expect, it } from "vitest";
import { careerProjectionMetric, CAREER_PROJECTION_GATE_REASON } from "@/lib/reports/careerProjection";

const SRC = import.meta.glob(
  [
    "/src/hooks/usePlayerAnalysisV2.ts",
    "/src/pages/PlayerIntelligencePage.tsx",
    "/src/pages/PlayerEvolutionPage.tsx",
    "/src/pages/AnalysisReportPrint.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const code = (p: string) => SRC[p].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("proyección de carrera bloqueada (D2)", () => {
  it("la métrica es siempre null con su motivo", () => {
    const m = careerProjectionMetric();
    expect(m.value).toBeNull();
    expect(m.gate_reason).toBe(CAREER_PROJECTION_GATE_REASON);
  });

  it("el mapeo del análisis la deja SIEMPRE en null (también la de filas antiguas)", () => {
    const c = code("/src/hooks/usePlayerAnalysisV2.ts");
    expect(c).toMatch(/proyeccionCarrera: null,/);
    expect(c).not.toMatch(/nivelProyecto:/);
  });

  it("ninguna pantalla pinta el nivel proyectado ni la proyección competitiva", () => {
    for (const f of ["/src/pages/PlayerIntelligencePage.tsx", "/src/pages/PlayerEvolutionPage.tsx", "/src/pages/AnalysisReportPrint.tsx"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/\.nivelProyecto\b/);
      expect(c, f).not.toMatch(/<ProyeccionCompetitiva|probabilidadAlcanzar|escenarioOptimista\.descripcion/);
      expect(c, f).toMatch(/careerProjection\.blocked/);
    }
  });
});
