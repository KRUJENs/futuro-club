/**
 * Análisis de equipo · posesión (P1 bloque 2).
 * Antes «Posesión 0%» cuando el modelo no la daba y «55%» (el ejemplo del prompt) sin
 * rótulo, como si fuera una estadística. Ahora: ESTIMADA_LLM con badge, o bloqueada con
 * motivo; y los prompts ya no anclan 55/45.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { possessionMetric } from "@/pages/TeamAnalysisPage";
import { MetricValue } from "@/components/metrics/MetricValue";
import obs from "../../../api/agents/team-observation.ts?raw";
import intel from "../../../api/agents/_team-intelligence.ts?raw";

describe("possessionMetric", () => {
  it("sin porcentaje ⇒ bloqueada con motivo (nunca 0%)", () => {
    const m = possessionMetric(undefined, 0.6, "no observada");
    expect(m.value).toBeNull();
    expect(m.gate_reason).toBe("no observada");
    render(<MetricValue result={m} format={(v) => `${v}%`} />);
    expect(screen.getByText("no observada")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("null del modelo ⇒ bloqueada", () => {
    expect(possessionMetric(null, 0.6, "x").value).toBeNull();
  });

  it("con porcentaje ⇒ ESTIMADA_LLM, redondeada, con la confianza del informe", () => {
    const m = possessionMetric(54.6, 0.4, "x");
    expect(m).toMatchObject({ value: 55, provenance: "ESTIMADA_LLM", confidence: 0.4, units: "%" });
  });

  it("confianza ausente o fuera de rango ⇒ 0..1", () => {
    expect(possessionMetric(50, undefined, "x").confidence).toBe(0);
    expect(possessionMetric(50, 7, "x").confidence).toBe(1);
  });
});

describe("prompts sin cifra de anclaje 55/45", () => {
  it("team-observation y team-intelligence piden null si no se puede estimar", () => {
    expect(obs).not.toMatch(/"posesionEstimada":\s*\{"equipo":\s*55/);
    expect(intel).not.toMatch(/"porcentaje":\s*55/);
    expect(obs).toMatch(/posesionEstimada[^\n]*null/);
    expect(intel).toMatch(/"porcentaje":[^\n]*null/);
  });
});
