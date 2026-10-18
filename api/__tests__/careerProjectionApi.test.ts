/**
 * P1 bloque 7a-2 — la proyección de carrera no sale del servidor: el análisis base no la
 * genera, la API de informes (también el enlace de la familia) entrega su contenido como
 * motivo y el agente de proyección no llama al modelo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const code = (p: string) =>
  readFileSync(resolve(__dirname, "..", "..", p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("proyección de carrera fuera del servidor (D2)", () => {
  it("el análisis base no tiene prompt de proyección y su total sale de PROMPTS", () => {
    const b = code("api/players/baseline-analysis.ts");
    expect(b).not.toMatch(/^\s*projection: \{/m);
    expect(b).not.toMatch(/Top semipro|Amateur alto/);
    expect(b).toMatch(/reportsFailed: Object\.keys\(PROMPTS\)\.length - successful\.length/);
  });

  it("reports y share (enlace de la familia) pasan los informes por withCareerProjectionBlocked", () => {
    expect(code("api/analyses/reports.ts")).toMatch(/reports: withCareerProjectionBlocked\(reportsRes\.data/);
    expect(code("api/analyses/share.ts")).toMatch(/reports: withCareerProjectionBlocked\(reports/);
  });

  it("el agente de proyección devuelve el motivo antes de llamar al modelo", () => {
    const p = code("api/agents/_projection-report.ts");
    const gate = p.indexOf("if (CAREER_PROJECTION_BLOCKED)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(p.indexOf("process.env.ANTHROPIC_API_KEY"));
  });
});
