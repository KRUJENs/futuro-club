/**
 * VITAS · P1 bloque 5d — valoración sin valores por defecto, sin probabilidades, techo
 * por TIMING; orquestador sin edad 12 / nivel «academy» / análisis 1 fijos.
 *
 * Antes (_valuation-model.ts): tendencia 40 sin evaluación, versatilidad 40 sin perfil de
 * rol, contexto con nivel «academy» por defecto (+5), consistencia 40/50, techo PHV leído
 * del OFFSET (un estado) como «tardío», probabilidades de llegar a 1.ª división / top-5
 * con «tasas base de la UEFA Youth League» (fuente no encontrada) y «mejora a 1/3/5 años»
 * con fórmulas sin fuente, y una «confianza» con pesos inventados.
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/valuation-5d.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "";
});
vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", email: null, tenantId: null, error: null }),
}));

import { computeValuation } from "../_valuation-model";
import labReport from "../_lab-biomechanics-report";
import modelSrc from "../_valuation-model.ts?raw";
import orchestratorSrc from "../_pipeline-orchestrator.ts?raw";
import { VALUATION_SOURCE } from "../../../config/valuation";

beforeEach(() => {
  process.env.CRON_SECRET = "cron-test";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
});
afterEach(() => vi.unstubAllGlobals());

const FULL = {
  playerId: "p1", age: 13.5, currentVsi: 62, vsiHistory: [],
  maturityTiming: "on_time" as const, injuryRisk: 35,
  positionFitScores: [{ position: "MID", fit: 70 }],
  sessionCount: 3, consistencyScore: 60, competitiveLevel: "academy" as const, analysisCount: 3,
};
const factor = (r: ReturnType<typeof computeValuation>, k: string) => r.factors.find((f) => f.factor === k)!;
/** Quita comentarios para no confundir la explicación con el código. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const orchestrator = code(orchestratorSrc);

describe("valoración · ningún factor con valor por defecto", () => {
  it.each([
    ["vsiTrend", { currentVsi: null }],
    ["versatility", { positionFitScores: [] }],
    ["context", { competitiveLevel: null }],
    ["consistency", { sessionCount: 1 }],
    ["consistency", { consistencyScore: null }],
  ])("sin dato para %s ⇒ factor null con motivo y SIN puntuación", (key, patch) => {
    const r = computeValuation({ ...FULL, ...patch } as never);
    expect(factor(r, key).score).toBeNull();
    expect(factor(r, key).gate_reason).toBeTruthy();
    expect(r.overallScore).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.gate_reason).toMatch(/Valoración no calculada/);
  });

  it("control positivo: con todos los factores hay puntuación y tramo", () => {
    const r = computeValuation(FULL as never);
    expect(typeof r.overallScore).toBe("number");
    expect(typeof r.tier).toBe("string");
    expect(r.gate_reason).toBeNull();
  });
});

describe("techo por maduración: TIMING de la puerta, no el offset", () => {
  it("tardío / a tiempo / precoz ⇒ 65 / 55 / 45 (pendiente de validar)", () => {
    expect(factor(computeValuation({ ...FULL, maturityTiming: "late" } as never), "phvCeiling").score).toBe(65);
    expect(factor(computeValuation({ ...FULL, maturityTiming: "on_time" } as never), "phvCeiling").score).toBe(55);
    expect(factor(computeValuation({ ...FULL, maturityTiming: "early" } as never), "phvCeiling").score).toBe(45);
  });

  it("un offset de ESTADO sin timing ya no puntúa (antes −1,5 ⇒ «tardío» 75)", () => {
    const r = computeValuation({ ...FULL, maturityTiming: null, phvOffset: -1.5 } as never);
    expect(factor(r, "phvCeiling").score).toBeNull();
    expect(r.overallScore).toBeNull();
  });

  it("adulto: el techo NO APLICA y sale del peso (la valoración se calcula sin él)", () => {
    const r = computeValuation({ ...FULL, age: 25, maturityTiming: null } as never);
    expect(factor(r, "phvCeiling")).toMatchObject({ applicable: false, score: null });
    expect(factor(r, "phvCeiling").gate_reason).toMatch(/No aplica/);
    expect(typeof r.overallScore).toBe("number");
  });
});

describe("sin probabilidades ni confianza inventada", () => {
  it("probabilities siempre null; sin confidenceLevel; arranque en frío solo con el nº real de análisis", () => {
    const r = computeValuation(FULL as never) as Record<string, unknown>;
    expect(r.probabilities).toBeNull();
    expect(r).not.toHaveProperty("confidenceLevel");
    expect(r).not.toHaveProperty("dataPointsUsed");
    expect(computeValuation({ ...FULL, analysisCount: null } as never).coldStartWarning).toBeNull();
    expect(computeValuation({ ...FULL, analysisCount: 1 } as never).coldStartWarning).toBe(true);
  });

  it("ni tasas base ni la cita de la UEFA en el modelo; las constantes están «pendiente de validar»", () => {
    expect(code(modelSrc)).not.toMatch(/baseRate|UEFA Youth League data|probFirstDiv|prob1Year/);
    expect(VALUATION_SOURCE).toBe("pendiente de validar");
  });
});

describe("orquestador · sin edad, nivel ni nº de análisis inventados", () => {
  it("sin `?? 12`, sin `analysisCount: 1`, sin `competitiveLevel: \"academy\"`; manda el timing", () => {
    expect(orchestrator).not.toMatch(/chronological_age \?\? 12/);
    expect(orchestrator).not.toMatch(/analysisCount: 1\b/);
    expect(orchestrator).not.toMatch(/competitiveLevel: "academy"/);
    expect(orchestrator).toMatch(/maturityTiming,/);
  });

  it("VSI físico: lee la biomecánica en camelCase y exige zancada Y asimetría (sin `?? 0`)", () => {
    expect(orchestrator).toContain('bmNum("strideFrequencyHz", "stride_frequency_hz")');
    expect(orchestrator).not.toMatch(/stride_frequency_hz \?\? 0|asymmetry_pct \?\? 0/);
    expect(orchestrator).toMatch(/strideHz !== null && asymmetry !== null/);
  });

  it("informe de biomecánica: la edad es opcional (antes 400 sin ella; el orquestador mandaba 12)", async () => {
    const res = await labReport(
      new Request("https://x.test/api/agents/lab-biomechanics-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer cron-test" },
        body: JSON.stringify({ playerId: "p1", videoId: "v1", biomechanics: null, playerContext: { position: "MID" } }),
      }),
    );
    expect(res.status).not.toBe(400);
  });
});
