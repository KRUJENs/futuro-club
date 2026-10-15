/**
 * VITAS · P1 bloque 5d (revisión del #320) — vía LLM del arquitecto del IDP.
 *
 * El modelo solo puede fijar metas de dimensiones CON dato, una por dimensión y con la
 * línea base exacta del dato. Si se sale en alguna (meta de una dimensión sin dato, una
 * dimensión repetida u otra baseline), se usa el plan determinista COMPLETO: el foco y
 * los textos del modelo podrían hablar de lo descartado. Antes el prompt exigía 3-5 metas
 * y el servidor aceptaba cualquier array de metas.
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/idp-architect-llm.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});
vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

import idpArchitect from "../_idp-architect";

const goal = (dimension: string, value: number, target = value + 3, metric = `vsi_${dimension}`) => ({
  dimension,
  title: `Meta de ${dimension}`,
  description: "Descripción suficientemente larga.",
  rationale: "Razonamiento suficientemente largo.",
  baselineMetric: { metric, value },
  targetMetric: { metric, value: target },
  suggestedDrills: [],
  weight: 3,
});
const llmPlan = (goals: unknown[]) => ({
  overallFocus: "Foco del mes propuesto por el modelo",
  agentSummary: "Resumen del modelo con suficiente longitud para el esquema.",
  goals,
});

function mockClaude(plan: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan) }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }),
        { status: 200 },
      ),
    ),
  );
}

const input = {
  player: { id: "p1", name: "Leo", chronologicalAge: 12 },
  vsi: { overall: 70, technical: 64, tactical: null, physical: null, mental: null },
};
const post = () =>
  idpArchitect(
    new Request("https://x.test/api/agents/idp-architect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
type Body = {
  data: { source: string; plan: { overallFocus: string; goals: Array<{ dimension: string; baselineMetric: { value: number } }> } };
};

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("arquitecto del IDP · el modelo solo fija metas sobre datos reales", () => {
  it("control: una meta de la única dimensión con dato y su baseline exacta ⇒ se acepta el plan del modelo", async () => {
    mockClaude(llmPlan([goal("technical", 64)]));
    const body = (await (await post()).json()) as Body;
    expect(body.data.source).toBe("agent");
    expect(body.data.plan.overallFocus).toBe("Foco del mes propuesto por el modelo");
  });

  it("baseline con redondeo (64,4) ⇒ se acepta y se guarda el valor real (64)", async () => {
    mockClaude(llmPlan([goal("technical", 64.4)]));
    const body = (await (await post()).json()) as Body;
    expect(body.data.source).toBe("agent");
    expect(body.data.plan.goals[0].baselineMetric.value).toBe(64);
  });

  it.each([
    ["una meta de una dimensión SIN dato", [goal("technical", 64), goal("tactical", 60)]],
    ["la misma dimensión repetida", [goal("technical", 64), goal("technical", 64)]],
    ["otra baseline (la evaluación del entrenador copiada)", [goal("technical", 70)]],
    ["otra métrica para la dimensión", [goal("technical", 64, 67, "scanning")]],
    ["un target por debajo de la baseline", [goal("technical", 64, 60)]],
  ])("%s ⇒ plan determinista completo (sin el foco ni los textos del modelo)", async (_n, goals) => {
    mockClaude(llmPlan(goals));
    const body = (await (await post()).json()) as Body;
    expect(body.data.source).toBe("fallback_goals_outside_data");
    expect(body.data.plan.overallFocus).not.toBe("Foco del mes propuesto por el modelo");
    expect(body.data.plan.goals.map((g) => g.dimension)).toEqual(["technical"]);
  });
});
