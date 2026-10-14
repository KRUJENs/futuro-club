/**
 * VITAS · P1 bloque 4b — puertas de valoración, informes LLM, seguimiento y fila de fatiga
 *   - valoración: sin PHV o sin riesgo de lesión calculado NO hay puntuación, tier
 *     ni probabilidades (antes 50 / 60 por defecto);
 *   - informes LLM de lesión y valoración: si el modelo determinista no calculó,
 *     NO se llama al modelo (aunque haya clave) y no se inventa una edad;
 *   - progression-tracker: solo servidor; ya no escribe PHV;
 *   - fila de fatigue_sessions para agentes: sin maduración, sin clasificaciones.
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/block4b-gates.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  // El tracker lee la URL de Supabase al importarse.
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});
vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", email: null, tenantId: null, error: null }),
}));

import valuationModel from "../_valuation-model";
import valuationReport from "../_valuation-report";
import injuryReport from "../_injury-risk-report";
import progressionTracker from "../_progression-tracker";
import { computeInjuryRisk } from "../_injury-risk-calculator";
import { fatigueRowForAgents } from "../../../src/lib/fatigue/fatigueRowGate";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.CRON_SECRET = "cron-test";
  fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function call(h: (r: Request) => Promise<Response>, path: string, body: unknown, bearer = "cron-test") {
  const res = await h(
    new Request(`https://x.test/api/agents/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> } };
}

const VAL_BASE = {
  playerId: "p1", age: 13.5, position: "MID", currentVsi: 62, vsiHistory: [], positionFitScores: [],
  sessionCount: 3, analysisCount: 3, competitiveLevel: "academy",
};

describe("valoración · sin PHV o sin riesgo de lesión no hay puntuación", () => {
  it("sin offset PHV ni riesgo → puntuación, tier y probabilidades null con motivo (antes 50 y 60 por defecto)", async () => {
    const { status, json } = await call(valuationModel, "valuation-model", { ...VAL_BASE, phvOffset: null, injuryRisk: null });
    expect(status).toBe(200);
    const r = json.data!.report as Record<string, unknown>;
    expect(r).toMatchObject({ overallScore: null, tier: null, probabilities: null });
    expect(String(r.gate_reason)).toMatch(/Techo PHV/);
    const factors = r.factors as Array<{ factor: string; score: number | null; gate_reason: string | null }>;
    expect(factors.find((f) => f.factor === "phvCeiling")).toMatchObject({ score: null });
    expect(factors.find((f) => f.factor === "injuryAdjusted")).toMatchObject({ score: null });
  });

  it("control positivo: con offset PHV y riesgo calculado SÍ hay puntuación y tier", async () => {
    const { json } = await call(valuationModel, "valuation-model", { ...VAL_BASE, phvOffset: -0.8, injuryRisk: 35 });
    const r = json.data!.report as Record<string, unknown>;
    expect(typeof r.overallScore).toBe("number");
    expect(typeof r.tier).toBe("string");
    expect(r.gate_reason).toBeNull();
  });

  it("age null o de sénior se acepta (antes 400)", async () => {
    expect((await call(valuationModel, "valuation-model", { ...VAL_BASE, age: null })).status).toBe(200);
    expect((await call(valuationModel, "valuation-model", { ...VAL_BASE, age: 29 })).status).toBe(200);
  });
});

describe("informes LLM · sin cálculo determinista no se llama al modelo", () => {
  it("valoración no calculada → informe bloqueado, sin modelo y sin tier inventado", async () => {
    const { json } = await call(valuationReport, "valuation-report", {
      playerId: "p1",
      valuationModel: { overallScore: null, tier: null, gate_reason: "Valoración no calculada: falta Techo PHV." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.data).toMatchObject({ model: "gated", source: "valuation_not_computed" });
    const report = json.data!.report as Record<string, unknown>;
    expect(report.tierAnalisis).toBe("No calculado");
    expect(String(report.evaluacionGeneral)).toMatch(/falta Techo PHV/);
  });

  it("riesgo de lesión no calculado → informe bloqueado («desconocido»), sin modelo, con los motivos", async () => {
    const risk = computeInjuryRisk({ playerId: "p1", injuryHistory: [], sessionsLast28Days: 0, matchesLast7Days: 0 } as never);
    const { json } = await call(injuryReport, "injury-risk-report", { playerId: "p1", injuryRisk: risk });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.data).toMatchObject({ model: "gated", source: "injury_risk_not_computed" });
    const report = json.data!.report as Record<string, unknown>;
    expect(report).toMatchObject({ nivelRiesgo: "desconocido", factoresRiesgo: [], recomendacionesCarga: [] });
    expect((report.not_evaluated as string[]).some((x) => /PHV no calculado/.test(x))).toBe(true);
  });

  it("control positivo: con riesgo calculado SÍ se llama al modelo, y el nivel lo fija la categoría del modelo", async () => {
    const risk = computeInjuryRisk({
      playerId: "p1", injuryHistory: [], sessionsLast28Days: 6, matchesLast7Days: 0,
      acwrZone: "optimal", phvOffset: 0.2, age: 13.4, asymmetryPct: 10, biomechanicsInjuryRisk: 30,
      biomechanicsFrames: 20, biomechanicsConfidence: 0.8, fatigueIndex: 40,
    } as never);
    fetchMock.mockResolvedValueOnce(
      Response.json({ content: [{ type: "text", text: JSON.stringify({ evaluacionGeneral: "x", nivelRiesgo: "critico", factoresRiesgo: [] }) }] }),
    );
    const { json } = await call(injuryReport, "injury-risk-report", { playerId: "p1", injuryRisk: risk });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((json.data!.report as Record<string, unknown>).nivelRiesgo).toBe("moderado"); // el del modelo, no el «critico» del LLM
    const prompt = String(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).messages[0].content);
    expect(prompt).not.toMatch(/ACWR es >1\.5/);
    expect(prompt).toMatch(/Edad cronologica: No disponible/); // sin playerContext no se suponen 12 años
  });
});

describe("progression-tracker · solo servidor y sin PHV", () => {
  it("con la sesión de un usuario (no servicio) → 403 (antes cualquier sesión escribía con la service key)", async () => {
    const { status } = await call(progressionTracker, "progression-tracker", { playerId: "00000000-0000-4000-8000-000000000000" }, "user-jwt");
    expect(status).toBe(403);
  });

  it("no escribe PHV aunque se le mande", async () => {
    fetchMock.mockResolvedValue(Response.json([{ id: "s1" }], { status: 201 }));
    await call(progressionTracker, "progression-tracker", {
      playerId: "00000000-0000-4000-8000-000000000000", vsi: 61, injuryRisk: 40, phvOffset: 0.4, phvCategory: "ontme",
    });
    const writes = fetchMock.mock.calls
      .map((c) => (c as [string, RequestInit])[1])
      .filter((init) => init && typeof init.body === "string");
    expect(writes.length).toBeGreaterThan(0);
    for (const init of writes) expect(String(init.body)).not.toMatch(/phv_offset|phv_category/);
  });
});

describe("fila de fatigue_sessions para agentes", () => {
  const row = { total_load: 410, fatigue_index: 82, fatigue_severity: "critical", acwr_zone: "danger", acwr_value: 1.6, alerts: [{ title: "Fatiga Crítica" }] };

  it("sin maduración (o \"post_phv\" sin offset) quita índice, severidad, zona y alertas; conserva carga y ratio", () => {
    for (const m of [{ maturation_band: null, phv_offset: null }, { maturation_band: "post_phv", phv_offset: null }]) {
      const out = fatigueRowForAgents({ ...row, ...m })!;
      expect(out).toMatchObject({ fatigue_index: null, fatigue_severity: null, acwr_zone: null, alerts: null, total_load: 410, acwr_value: 1.6, _maturation_gate: true });
    }
  });

  it("control: con maduración registrada la fila no cambia", () => {
    const known = { ...row, maturation_band: "circa_phv", phv_offset: 0.3 };
    expect(fatigueRowForAgents(known)).toBe(known);
  });
});
