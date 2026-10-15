/**
 * P1 bloque 4b · pantallas de riesgo de lesión y valoración, y el compuesto común.
 *   - Sin riesgo calculado: el motivo, sin indicador ni «bajo»; nunca «apto».
 *   - Con lesión registrada: cuándo fue y que el alta es clínica.
 *   - Valoración sin calcular: motivo, sin tier ni probabilidades.
 *   - IDP: sin riesgo calculado no se fabrica un objetivo de «riesgo 30».
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import InjuryRiskCard from "@/components/injury/InjuryRiskCard";
import ValuationCard, { type ValuationData } from "@/components/valuation/ValuationCard";
import { weightedComposite } from "@/lib/metrics/composite";
import { derived, gated, mock } from "@/lib/metrics/MetricResult";
import type { InjuryRiskReport } from "@/lib/injury/injuryRiskTypes";
import { generatePlanDeterministic } from "@/lib/idp/idpGoalGenerator";

function report(over: Partial<InjuryRiskReport> = {}): InjuryRiskReport {
  return {
    playerId: "p1",
    composite: gated("Riesgo de lesión no calculado. Falta un dato imprescindible: carga (zona ACWR)."),
    category: null,
    coverage: 0,
    factors: [
      { factor: "acwr", weight: 0.3, applicable: true, result: gated("Sin zona de carga."), description: "Zona ACWR: sin calcular" },
      { factor: "phvWindow", weight: 0.25, applicable: false, result: gated("No aplica: jugador adulto."), description: "-" },
    ],
    recommendations: [],
    growthShieldLevel: null,
    daysSinceLastInjury: null,
    injuryHistoryCount: 0,
    coldStartWarning: true,
    ...over,
  };
}

describe("InjuryRiskCard", () => {
  it("sin riesgo calculado: el motivo, sin indicador ni porcentaje; cada factor con su motivo o «no aplica»", () => {
    render(<InjuryRiskCard data={report()} />);
    expect(screen.getByTestId("injury-risk-not-computed")).toHaveTextContent("Falta un dato imprescindible");
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.getByTestId("injury-factor-acwr")).toHaveTextContent("Sin zona de carga.");
    expect(screen.getByTestId("injury-factor-phvWindow")).toHaveTextContent("injuryRiskCard.notApplicable");
    expect(screen.queryByText(/apto/i)).toBeNull();
  });

  it("con una lesión registrada: cuándo fue + el alta la decide el clínico (nunca «apto»)", () => {
    render(<InjuryRiskCard data={report({ daysSinceLastInjury: 12, injuryHistoryCount: 1 })} />);
    expect(screen.getByTestId("injury-return-note")).toHaveTextContent("injuryRiskCard.clearanceIsClinical");
  });

  it("control: con riesgo calculado se ven el badge de procedencia («Calculado») y la confianza", () => {
    render(<InjuryRiskCard data={report({ composite: derived(46, { confidence: 0.34 }), category: "moderate", coverage: 0.85 })} />);
    expect(screen.queryByTestId("injury-risk-not-computed")).toBeNull();
    expect(screen.getByText("Calculado")).toBeInTheDocument();
    expect(screen.getByText("34%")).toBeInTheDocument();
  });

  it("demo: los valores de ejemplo se rotulan «Datos de ejemplo»", () => {
    render(<InjuryRiskCard data={report({ composite: mock(25), category: "low", isMock: true })} />);
    expect(screen.getByText("Datos de ejemplo")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull(); // sin «Confianza 0 %» para datos de ejemplo
  });
});

describe("ValuationCard", () => {
  it("sin valoración calculada: motivo y factores que faltan; sin tier ni probabilidades", () => {
    const data: ValuationData = {
      playerId: "p1", overallScore: null, tier: null, tierColor: null, tierDescription: null,
      gate_reason: "Valoración no calculada: falta Techo PHV.",
      factors: [{ factor: "phvCeiling", weight: 0.2, score: null, label: "Techo PHV", gate_reason: "PHV bloqueado." }],
      coldStartWarning: true, analysisCount: 0, provenance: null,
    };
    render(<ValuationCard data={data} />);
    expect(screen.getByTestId("valuation-not-computed")).toHaveTextContent("falta Techo PHV");
    expect(screen.getByText(/PHV bloqueado/)).toBeInTheDocument();
    expect(screen.queryByText(/1ra Div/)).toBeNull();
  });
});

describe("weightedComposite", () => {
  const f = (key: string, weight: number, value: number | null, applicable = true) => ({ key, weight, value, applicable });

  it("renormaliza sobre los presentes; un factor que no aplica sale del peso", () => {
    const r = weightedComposite([f("a", 0.5, 80), f("b", 0.3, 20), f("c", 0.2, 50, false)], { minCoverage: 0.7 });
    expect(r.coverage).toBe(1);
    expect(r.value).toBe(58); // (80·.5 + 20·.3) / .8 = 57.5 → 58
  });

  it("falta un obligatorio → null con motivo; por debajo de la cobertura → null", () => {
    expect(weightedComposite([f("a", 0.5, null), f("b", 0.5, 30)], { minCoverage: 0.1, mandatory: ["a"] }).value).toBeNull();
    const low = weightedComposite([f("a", 0.5, 10), f("b", 0.5, null)], { minCoverage: 0.7 });
    expect(low.value).toBeNull();
    expect(low.gate_reason).toMatch(/50 %/);
  });
});

describe("IDP · objetivo de maduración", () => {
  it("con PHV pero SIN riesgo de lesión calculado no se crea el objetivo (antes riesgo 30 por defecto)", () => {
    const plan = generatePlanDeterministic({
      player: { id: "p1", name: "Leo", position: "MID", chronologicalAge: 13 },
      phv: { offset: 0.1, category: "ontme" },
      recentFatigue: undefined,
    } as never);
    expect(plan.goals.some((g) => g.dimension === "maturation")).toBe(false);
  });
});
