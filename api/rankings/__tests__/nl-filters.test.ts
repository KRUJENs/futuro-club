/**
 * P2 bloque 11 — POST /api/rankings/nl-filters: solo filtros (ESTIMADA_LLM), con tope de
 * gasto; sin clave ⇒ 503; respuesta no interpretable ⇒ 502. Nunca devuelve jugadores.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 19, limit: 20, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({ verifyAuth: vi.fn(async () => ({ userId: "owner-1", error: null })) }));
const mockOver = vi.fn();
const mockSpend = vi.fn();
vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: (...a: unknown[]) => mockOver(...a),
  recordSpendUsd: (...a: unknown[]) => mockSpend(...a),
  budgetExceededResponse: () => new Response(JSON.stringify({ error: "budget" }), { status: 429 }),
}));
let llmText = "";
let llmOk = true;
const sentBodies: Array<Record<string, unknown>> = [];
vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async (init: RequestInit) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ content: [{ type: "text", text: llmText }] }), { status: llmOk ? 200 : 500 });
  }),
  responseText: (d: { content: Array<{ text: string }> }) => d.content.map((c) => c.text).join(""),
}));

import handler from "../_nl-filters";

const post = (query: string) =>
  handler(new Request("https://x.test/api/rankings/nl-filters", {
    method: "POST",
    headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  mockOver.mockReset().mockResolvedValue(false);
  mockSpend.mockReset().mockResolvedValue(undefined);
  llmOk = true;
  llmText = '{"position":"Lateral Izquierdo","foot":"left","timing":"late","ageGroup":"Sub-14","not_understood":["rápido"]}';
  sentBodies.length = 0;
});

describe("POST /api/rankings/nl-filters", () => {
  it("control positivo: filtros del vocabulario + no entendido, rotulado ESTIMADA_LLM, gasto contabilizado", async () => {
    const res = await post("lateral zurdo tardío y rápido, U14");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.filters).toEqual({ position: "Lateral Izquierdo", foot: "left", timing: "late", ageGroup: "Sub-14" });
    expect(data.not_understood).toEqual(["rápido"]);
    expect(data.provenance).toBe("ESTIMADA_LLM");
    expect(data).not.toHaveProperty("players");
    expect(mockSpend).toHaveBeenCalledWith("claude-haiku");
    expect(sentBodies[0].temperature).toBe(0);
  });

  it("sin clave de IA ⇒ 503 (los filtros manuales siguen funcionando), sin llamar al modelo", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect((await post("zurdo")).status).toBe(503);
    expect(sentBodies).toHaveLength(0);
  });

  it("tope de gasto superado ⇒ respuesta de presupuesto, sin llamar al modelo", async () => {
    mockOver.mockResolvedValue(true);
    expect((await post("zurdo")).status).toBe(429);
    expect(sentBodies).toHaveLength(0);
  });

  it("respuesta del modelo no interpretable o error ⇒ 502", async () => {
    llmText = "no sé";
    expect((await post("zurdo")).status).toBe(502);
    llmOk = false;
    expect((await post("zurdo")).status).toBe(502);
  });

  it("frase vacía o demasiado larga ⇒ 400", async () => {
    expect((await post("   ")).status).toBe(400);
    expect((await post("x".repeat(201))).status).toBe(400);
  });
});
