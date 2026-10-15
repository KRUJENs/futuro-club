/**
 * VITAS · Tests — /api/players/baseline-analysis · PHV por el gate único
 * Run: npx vitest run --config vitest.api.config.ts api/players/__tests__/baseline-analysis.test.ts
 *
 * Antes (origin/main):
 *   · baseline-analysis.ts:112-115 metía en los 6 prompts la categoría PHV CRUDA
 *     (anthro ?? players.phv_category), así que a un menor sin medidas se le
 *     describía una maduración (p.ej. «Categoría: early»);
 *   · :176-192 computeVsi restaba/sumaba 5 por esa categoría persistida (y con la
 *     semántica invertida: «precoz penaliza» leyendo "early" = pre-PHV).
 * Ahora: PHV solo desde una fila COMPLETA y fiable de player_anthropometrics
 * (age_source='birth_date', migración 069) y el VSI baseline no lleva ajuste PHV.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateFichaVsi } from "../../../src/services/real/metricsService";

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
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "{}" }] }) } as unknown as Response;
  }),
  responseText: () => "{}",
}));

type Row = Record<string, unknown> | null;
let playerRow: Row = null;
let anthroRow: Row = null;
const analysisInserts: Array<Record<string, unknown>> = [];

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self, eq: self, gte: self, lte: self, order: self, limit: self,
    insert: (values: Record<string, unknown>) => {
      if (table === "analyses") analysisInserts.push(values);
      return chain;
    },
    update: self,
    single: async () => {
      if (table === "players") return { data: playerRow, error: null };
      if (table === "analyses") return { data: { id: "an-1" }, error: null };
      return { data: null, error: null };
    },
    maybeSingle: async () => ({ data: table === "player_latest_anthropometrics" ? anthroRow : null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], count: 0, error: null }).then(resolve, reject),
  });
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chainFor(t) }),
}));

const METRICS = { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 };
// VSI de ficha (calculateFichaVsi, fuente única): ya no la media simple (64).
const FICHA = calculateFichaVsi(METRICS);

function post(body: Record<string, unknown>) {
  return new Request("https://x.test/api/players/baseline-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify(body),
  });
}

async function run() {
  const { default: handler } = await import("../baseline-analysis");
  const res = await handler(post({ playerId: "samu" }));
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.ANTHROPIC_API_KEY = "test-key";
  sentPrompts.length = 0;
  analysisInserts.length = 0;
  playerRow = {
    id: "samu", tenant_id: "t1", name: "Samu", age: 9, position: "DC", foot: "right",
    height_cm: 135, weight_kg: 30, competitive_level: "Regional",
    // Barras del entrenador del blob (alias metrics:data->metrics del select).
    metrics: METRICS,
    vsi: 67.4, vsi_history: [57.5, 67.4],
    // Columna persistida naive (caso Samu): NO debe llegar a los prompts.
    phv_category: "early", phv_offset: -1.2,
  };
  anthroRow = null;
});

describe("phvBlock · el prompt solo afirma PHV con fila fiable", () => {
  it("bloqueado ⇒ «NO DISPONIBLE» + motivo y prohibición de afirmar maduración", async () => {
    const { phvBlock } = await import("../baseline-analysis");
    const txt = phvBlock({ phv: { category: null, offset: null, chronologicalAge: null, gate_reason: "Falta: talla sentado" } });
    expect(txt).toContain("NO DISPONIBLE");
    expect(txt).toContain("Falta: talla sentado");
    expect(txt).not.toMatch(/Categoría:|Offset:/);
  });

  it("fiable ⇒ fase por ESTADO y APHV con la edad DECIMAL de la medición", async () => {
    const { phvBlock } = await import("../baseline-analysis");
    const txt = phvBlock({ phv: { category: "early", offset: -1.5, chronologicalAge: 12.4, gate_reason: null } });
    expect(txt).toContain("Pre-PHV (estirón pendiente)");
    expect(txt).toContain("NO timing vs pares");
    expect(txt).toContain("13.90a"); // 12.4 − (−1.5)
  });
});

describe("handler · la categoría persistida NO llega a los 6 prompts", () => {
  it("sin fila antropométrica: players.phv_category='early' se ignora y el VSI no lleva −5", async () => {
    const { status, json } = await run();
    expect(status).toBe(200);
    expect(json.data.vsi).toBe(67.4); // el VSI de ficha guardado, sin −5
    // …y no la media simple de las barras (64) ni un recálculo desde ellas (FICHA):
    // precondición del fixture para que la aserción anterior distinga las tres reglas.
    expect([64, FICHA]).not.toContain(67.4);
    expect(sentPrompts.length).toBe(6);
    for (const p of sentPrompts) {
      expect(p).toContain("NO DISPONIBLE");
      expect(p).not.toContain("Categoría: early");
    }
    expect(analysisInserts[0]?.phv).toBeNull();
  });

  it("fila antigua (edad entera, sin age_source) con categoría ⇒ tampoco cuenta", async () => {
    anthroRow = {
      height_cm: 135, weight_kg: 30, sitting_height_cm: 70, leg_length_cm: 65,
      chronological_age: 9, maturity_offset: -3.1, phv_category: "early",
    };
    await run();
    for (const p of sentPrompts) {
      expect(p).toContain("NO DISPONIBLE");
      expect(p).toContain("edad exacta desde la fecha de nacimiento");
    }
    expect(analysisInserts[0]?.phv).toBeNull();
  });

  it("fila COMPLETA con age_source='birth_date' ⇒ se usa (fase + APHV con edad decimal)", async () => {
    anthroRow = {
      height_cm: 150, weight_kg: 40, sitting_height_cm: 78, leg_length_cm: 72,
      chronological_age: 12.37, age_source: "birth_date", maturity_offset: -1.6, phv_category: "early",
    };
    await run();
    expect(sentPrompts[0]).toContain("Pre-PHV (estirón pendiente)");
    expect(sentPrompts[0]).toContain("13.97a");
    expect(analysisInserts[0]?.phv).toMatchObject({ category: "early", offset: -1.6, chronologicalAge: 12.37 });
  });
});

describe("handler · nivel competitivo sin inventar (P1 bloque 2)", () => {
  it("sin nivel en el blob: la columna 'Regional' del trigger NO llega a los prompts", async () => {
    // playerRow trae competitive_level 'Regional' (columna) y ningún nivel_registrado.
    await run();
    expect(sentPrompts.length).toBe(6);
    for (const p of sentPrompts) {
      expect(p).toContain("Nivel competitivo: no registrado");
      expect(p).not.toContain("Nivel competitivo: Regional");
    }
  });

  it("con nivel registrado en el blob ⇒ ese nivel", async () => {
    playerRow = { ...playerRow, nivel_registrado: "Nacional" };
    await run();
    expect(sentPrompts[0]).toContain("Nivel competitivo: Nacional");
  });
});
