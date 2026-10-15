/**
 * P1 bloque 5d — valoración e IDP sin cifras por defecto (cliente).
 *
 * Valoración: la tarjeta pintaba probabilidades de llegar a 1.ª división / top-5 / «mejora
 * a 1-3 años» (sin fuente), una «confianza» con pesos inventados y «tendencia positiva»
 * mirando el NIVEL de un factor; el demo derivaba cifras de la ficha (`?? 60`, «Proyección
 * de maduración» = VSI + 6) y el cliente mandaba nivel «academy» y nº de instantáneas como
 * análisis. IDP: edad 14, «overall» 60, la evaluación del entrenador COPIADA a las 4
 * dimensiones sin vídeo y posición «MID».
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (orig) => ({
  ...(await orig<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));

import ValuationCard, { type ValuationData } from "@/components/valuation/ValuationCard";
import { buildDemoValuation } from "@/lib/demo/demoHealth";
import { generatePlanDeterministic } from "@/lib/idp/idpGoalGenerator";
import { buildIDPArchitectPrompt } from "@/lib/idp/idpArchitectPrompt";
import { suggestDrillIds } from "@/lib/idp/idpDrillMatcher";
import valuationHookSrc from "@/hooks/useValuation.ts?raw";
import idpHookSrc from "@/hooks/useIDPArchitectInput.ts?raw";
import hubSrc from "@/pages/PlayerHubPage.tsx?raw";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";
import type { Player } from "@/services/real/playerService";
import { idpDimensionsWithData } from "@/lib/idp/idpGoalGenerator";
import idpDashboardSrc from "@/components/idp/IDPDashboard.tsx?raw";
import useIdpSrc from "@/hooks/useIDP.ts?raw";
import demoReportsSrc from "@/lib/demo/demoReports.ts?raw";

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ["es", es], ["es-419", esLA], ["en", en], ["fr", fr], ["de", de], ["it", it_], ["nl", nl],
];
const get = (o: Record<string, unknown>, k: string): unknown =>
  k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as Record<string, unknown>)[p] : undefined), o);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const COMPUTED: ValuationData = {
  playerId: "p1", overallScore: 58, tier: "Developing Talent", tierColor: "#3B82F6",
  tierDescription: "Puntuación compuesta media (orientativa).",
  factors: [
    { factor: "vsiTrend", weight: 0.25, score: 60, label: "Tendencia de la evaluación" },
    { factor: "phvCeiling", weight: 0.2, score: null, label: "Techo por maduración", applicable: false, gate_reason: "No aplica: jugador adulto." },
  ],
  coldStartWarning: null, analysisCount: null, provenance: null,
};

describe("ValuationCard · sin probabilidades ni confianza inventada", () => {
  it("valoración calculada: tramo, factores y su motivo; ni probabilidades, ni «Confianza», ni «tendencia positiva»", () => {
    const { container } = render(<ValuationCard data={COMPUTED} />);
    expect(screen.getByTestId("valuation-computed")).toBeDefined();
    expect(screen.getByText(/No aplica: jugador adulto/)).toBeDefined();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/1ra Div|Top-5|Probabilidades|Mejora 1|Confianza|Tendencia positiva/);
    expect(text).toContain("valuationCard.orientative");
    expect(text).not.toContain("valuationCard.coldStart"); // null ⇒ ni se afirma ni se niega
  });

  it("el Hub ya no pinta probabilidades ni los gráficos siempre vacíos", () => {
    expect(code(hubSrc)).not.toMatch(/ProbabilityDisplay|TierProgressionChart|CeilingComparison/);
  });

  it.each(LOCALES)("%s: textos de la tarjeta", (_l, j) => {
    for (const k of ["valuationCard.orientative", "valuationCard.orientativeWithCount_one", "valuationCard.orientativeWithCount_other", "valuationCard.coldStart", "valuationCard.factors"]) {
      expect(typeof get(j, k), k).toBe("string");
    }
  });
});

describe("demo · valoración de ejemplo FIJA", () => {
  it("igual para cualquier jugador (no deriva de la ficha) y sin probabilidades", () => {
    const a = buildDemoValuation({ id: "a", vsi: 90 } as unknown as Player, "es");
    const b = buildDemoValuation({ id: "b", vsi: 20 } as unknown as Player, "es");
    expect({ ...a, playerId: "x" }).toEqual({ ...b, playerId: "x" });
    expect(a).not.toHaveProperty("probabilities");
    expect(JSON.stringify(a)).not.toMatch(/Proyección de maduración|VSI ajustado por PHV/);
  });
});

describe("cliente · sin nivel ni nº de análisis inventados", () => {
  it("useValuation manda el timing de la puerta y no «academy» ni instantáneas como análisis", () => {
    const src = code(valuationHookSrc);
    expect(src).not.toMatch(/"academy"|analysisCount:/);
    expect(src).toMatch(/maturityTiming:/);
  });
});

describe("IDP · cada dimensión con su dato o sin dato", () => {
  it("el hook ya no inventa edad 14, «overall» 60, posición «MID» ni copia la evaluación", () => {
    const src = code(idpHookSrc);
    expect(src).not.toMatch(/: 14;|\|\| 60|"MID"|vsi_technical = p\.vsi/);
  });

  it("solo con la evaluación del entrenador (sin vídeo) NO se crean metas técnica/táctica/física", () => {
    const plan = generatePlanDeterministic({
      player: { id: "p1", name: "Leo", chronologicalAge: null },
      vsi: { overall: 70, technical: null, tactical: null, physical: null, mental: null },
    } as never);
    expect(plan.goals.map((g) => g.dimension)).not.toEqual(expect.arrayContaining(["technical"]));
    expect(plan.goals.some((g) => ["technical", "tactical", "physical"].includes(g.dimension))).toBe(false);
  });

  it("sin edad registrada, los ejercicios no se filtran por edad (antes 14 años)", () => {
    expect(suggestDrillIds({ dimension: "technical", age: null, limit: 3 }).length).toBeGreaterThan(0);
  });

  it("el prompt dice «sin dato» / «No disponible», nunca «null»", () => {
    const p = buildIDPArchitectPrompt({
      player: { id: "p1", name: "Leo", chronologicalAge: null },
      vsi: { overall: 70, technical: null, tactical: null, physical: null, mental: null },
    } as never, "es");
    expect(p).toContain("sin dato");
    expect(p).toMatch(/Edad cronológica: No disponible/);
    expect(p).toMatch(/Posición: No disponible/);
    expect(p).not.toMatch(/\bnull\b|undefined/);
  });
});

// Revisión del #320.
describe("revisión del #320 · IDP sin dimensiones con dato y procedencia de la valoración", () => {
  it("sin ninguna dimensión con dato el plan NO inventa «fundamentos técnicos» como foco", () => {
    const plan = generatePlanDeterministic({ player: { id: "p1", name: "Leo", chronologicalAge: 12 } } as never);
    expect(plan.goals).toHaveLength(0);
    expect(plan.overallFocus).not.toMatch(/fundamentos técnicos/);
    expect(idpDimensionsWithData({ player: { id: "p1", name: "Leo", chronologicalAge: 12 } } as never)).toEqual([]);
  });

  it("el prompt limita las metas a las dimensiones con dato y admite 1-5", () => {
    const p = buildIDPArchitectPrompt({
      player: { id: "p1", name: "Leo", chronologicalAge: 12 },
      vsi: { overall: 70, technical: 64, tactical: null, physical: null, mental: null },
    } as never, "es");
    expect(p).toContain("DIMENSIONES CON DATO: technical.");
    expect(p).toMatch(/Entre 1 y 5 goals/);
    expect(p).not.toMatch(/3-5 goals máximo|Mínimo 3 goals/);
  });

  it("ronda 2: textos sin «3-5 objetivos» ni promesas de desbloqueo; «cargando» hasta tener todas las entradas", () => {
    for (const [, j] of LOCALES) {
      expect(String(get(j, "idpDashboard.emptyDescription"))).not.toMatch(/3-5/);
      expect(String(get(j, "idpDashboard.noDimensionData"))).not.toMatch(/vídeo|video|vidéo/i);
    }
    expect(code(idpHookSrc)).toMatch(/loading: loadingPlayer \|\| loadingBehavioral \|\| loadingAnalyses \|\| riskLoading/);
    expect(code(useIdpSrc)).toMatch(/if \(plan\) \{/);
  });

  it("el panel no ofrece «Generar» sin dimensiones con dato y el error 422 se traduce", () => {
    expect(code(idpDashboardSrc)).toMatch(/disabled=\{generate\.isPending \|\| noDimensionData\}/);
    expect(code(idpDashboardSrc)).toContain('code === "idp_no_dimension_data"');
    expect(code(useIdpSrc)).toMatch(/errorDetail\?\.code/);
    for (const [, j] of LOCALES) expect(typeof get(j, "idpDashboard.noDimensionData")).toBe("string");
  });

  it("la puntuación calculada lleva su procedencia; el demo, «Datos de ejemplo» y sin afirmar «menos de 3»", () => {
    render(<ValuationCard data={{ ...COMPUTED, provenance: "DERIVADA" }} />);
    expect(screen.getByText("Calculado")).toBeDefined();
    const demo = buildDemoValuation({ id: "a" } as unknown as Player, "es");
    expect(demo.provenance).toBe("MOCK");
    expect(demo.coldStartWarning).toBeNull();
  });

  it("el informe de ejemplo de valoración no deriva tramo ni «techo» del VSI", () => {
    expect(code(demoReportsSrc)).not.toMatch(/techoEstimado: tierLabelFor/);
  });
});
