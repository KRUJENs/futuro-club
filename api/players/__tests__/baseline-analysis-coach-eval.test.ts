/**
 * VITAS · Tests — /api/players/baseline-analysis · sin evaluación del entrenador no se
 * genera nada (P1 bloque 5, decisión del dueño 15 oct 2026)
 * Run: npx vitest run --config vitest.api.config.ts api/players/__tests__/baseline-analysis-coach-eval.test.ts
 *
 * Antes: las barras ausentes valían 0 (`Number(metric_*) || 0`; la columna la rellena con
 * 0 el trigger de la 069) ⇒ el modelo recibía «Velocidad: 0 … VSI cacheado: 0/100» de un
 * niño sin evaluar, se guardaba un análisis con VSI 0 y se pagaban 6 informes. El
 * percentil se calculaba contra jugadores de TODAS las cuentas (sin filtro de dueño).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// El handler lee las variables al importarse (constantes de módulo).
vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", error: null }),
}));
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: vi.fn().mockResolvedValue(true) }));

const sentPrompts: Array<{ system: string; user: string }> = [];
vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async (init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: string }>;
    };
    sentPrompts.push({ system: body.system[0].text, user: body.messages[0].content });
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "{}" }] }) } as unknown as Response;
  }),
  responseText: () => "{}",
}));

let playerRow: Record<string, unknown> = {};
const selects: Array<{ table: string; cols: string }> = [];
const inserts: Array<{ table: string; values: unknown }> = [];
const poolQueries: string[] = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: (cols: string) => {
          selects.push({ table, cols });
          if (table === "players" && /\bage\b/.test(cols) === false) poolQueries.push(cols);
          return b;
        },
        eq: chain, gte: chain, lte: chain, order: chain, limit: chain, neq: chain,
        insert: (values: unknown) => { inserts.push({ table, values }); return b; },
        update: chain,
        single: async () =>
          table === "players" ? { data: playerRow, error: null }
          : table === "analyses" ? { data: { id: "an-1" }, error: null }
          : { data: null, error: null },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], count: 0, error: null }).then(res, rej),
      });
      return b;
    },
  }),
}));

import handler from "../baseline-analysis";

function post(): Request {
  return new Request("https://x.test/api/players/baseline-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify({ playerId: "leo" }),
  });
}

const BASE = {
  id: "leo", tenant_id: "t1", name: "Leo", age: 11, position: "RW", foot: null,
  height_cm: null, weight_kg: null, nivel_registrado: null, vsi: null,
  // Lo que el trigger de la 069 deja en las columnas para un no evaluado: 0.
  metric_speed: 0, metric_technique: 0, metric_vision: 0, metric_stamina: 0, metric_shooting: 0, metric_defending: 0,
};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.ANTHROPIC_API_KEY = "test-key";
  sentPrompts.length = 0;
  selects.length = 0;
  inserts.length = 0;
  poolQueries.length = 0;
});

describe("baseline-analysis · evaluación del entrenador obligatoria", () => {
  it("sin barras en el blob ⇒ 422 coach_evaluation_missing, sin modelo ni análisis guardado", async () => {
    playerRow = { ...BASE, metrics: null };
    const res = await handler(post());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errorDetail: { code: string; message: string } };
    expect(body.errorDetail.code).toBe("coach_evaluation_missing");
    expect(sentPrompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "analyses")).toHaveLength(0);
  });

  it("evaluación incompleta (falta una barra) ⇒ 422 también (una barra ausente no vale 0)", async () => {
    playerRow = { ...BASE, metrics: { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60 } };
    const res = await handler(post());
    expect(res.status).toBe(422);
    expect(sentPrompts).toHaveLength(0);
  });

  it("6 barras pero SIN VSI de ficha guardado ⇒ 422 (regla única de «evaluado»: el guardado)", async () => {
    playerRow = { ...BASE, vsi: null, metrics: { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 } };
    const res = await handler(post());
    expect(res.status).toBe(422);
    expect(sentPrompts).toHaveLength(0);
  });

  it("las barras se leen del BLOB (data->metrics), nunca de las columnas metric_* (0 del trigger)", async () => {
    playerRow = { ...BASE, metrics: null };
    await handler(post());
    const playerSelect = selects.find((s) => s.table === "players")!;
    expect(playerSelect.cols).toContain("metrics:data->metrics");
    expect(playerSelect.cols).not.toMatch(/metric_(speed|technique|vision|stamina|shooting|defending)/);
  });

  it("evaluado ⇒ prompts con la evaluación del entrenador, sin «VSI cacheado» ni ceros, y sin percentil", async () => {
    playerRow = {
      ...BASE,
      vsi: 66.2,
      metrics: { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 },
    };
    const res = await handler(post());
    expect(res.status).toBe(200);
    expect(sentPrompts).toHaveLength(6);
    for (const p of sentPrompts) {
      expect(p.user).toContain("EVALUACIÓN DEL ENTRENADOR");
      expect(p.user).toContain("Velocidad: 70");
      expect(p.user).not.toContain("VSI cacheado");
      expect(p.user).not.toMatch(/Velocidad: 0\b/);
    }
    // el informe del jugador ya no pide al modelo que escriba una puntuación
    const playerReport = sentPrompts.find((p) => p.system.includes("Player Report"))!;
    expect(playerReport.system).not.toContain("vsi_score");
    // ningún percentil guardado ni consulta de pares (antes: pool de todas las cuentas)
    const analysis = inserts.find((i) => i.table === "analyses")!.values as { vsi: Record<string, unknown> };
    expect(analysis.vsi).not.toHaveProperty("peer");
    expect(analysis.vsi.vsi).toBe(66.2);
    expect(selects.filter((s) => s.table === "players")).toHaveLength(1);
  });
});
