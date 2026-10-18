/**
 * VITAS · Tests — /api/players/phv-window-plan · PHV desde una fila fiable
 * Run: npx vitest run --config vitest.api.config.ts api/players/__tests__/phv-window-plan.test.ts
 *
 * Antes: el plan se generaba desde players.phv_category / phv_offset (hasta
 * aplicar 069 guardan el valor naive legacy: un pre-púber sin medidas «early»,
 * offset −1.2) y el APHV con la edad ENTERA. Ahora el PHV sale solo de la última
 * fila de player_anthropometrics que el gate único da por fiable; si no, 400
 * no_phv con el motivo y NO se llama al LLM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", error: null }),
}));
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: vi.fn().mockResolvedValue(true) }));

const sentPrompts: string[] = [];
vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async (init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    sentPrompts.push(body.messages[0].content);
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }),
  responseText: () => "{}",
}));

type Row = Record<string, unknown> | null;
/** La columna legacy SIEMPRE trae una categoría: el endpoint no debe usarla. */
const PLAYER = { name: "Samu", age: 13, gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", position: "DC", height_cm: 158, weight_kg: 46, phv_category: "early", phv_offset: -1.2 };
let anthroRow: Row = null;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        single: async () => ({ data: table === "players" ? PLAYER : null, error: null }),
        maybeSingle: async () => ({ data: table === "player_latest_anthropometrics" ? anthroRow : null, error: null }),
      });
      return chain;
    },
  }),
}));

const ROW = {
  player_id: "samu", height_cm: 158, weight_kg: 46, sitting_height_cm: 80, leg_length_cm: 78,
  chronological_age: 13.33, maturity_offset: -0.91, phv_category: "ontime",
};

async function run() {
  const { default: handler } = await import("../phv-window-plan");
  const res = await handler(
    new Request("https://x.test/api/players/phv-window-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerId: "samu" }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  sentPrompts.length = 0;
  anthroRow = null;
});

describe("phv-window-plan · sin fila fiable no hay plan PHV", () => {
  it("columna legacy 'early' y sin mediciones ⇒ 400 no_phv, sin llamar al LLM", async () => {
    const { status, json } = await run();
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("no_phv");
    expect(sentPrompts).toHaveLength(0);
  });

  it("fila completa pero sin age_source (antes de 069) ⇒ 400 no_phv", async () => {
    anthroRow = { ...ROW };
    const { status } = await run();
    expect(status).toBe(400);
    expect(sentPrompts).toHaveLength(0);
  });

  it("fila fiable ⇒ el prompt lleva el PHV de la FILA y el APHV con la edad decimal", async () => {
    anthroRow = { ...ROW, age_source: "birth_date" };
    const { status, json } = await run();
    expect(status).toBe(200);
    expect(sentPrompts).toHaveLength(1);
    const prompt = sentPrompts[0];
    expect(prompt).toContain("Categoría: ontime");
    expect(prompt).toContain("Offset: -0.91 años");
    expect(prompt).toContain("APHV estimado: 14.24a"); // 13.33 − (−0.91), no 13 − (−1.2)
    expect(prompt).not.toContain("-1.20");
    const ctx = (json.data as { context: Record<string, unknown> }).context;
    expect(ctx).toMatchObject({ phvCategory: "ontime", phvOffset: -0.91 });
  });
});
