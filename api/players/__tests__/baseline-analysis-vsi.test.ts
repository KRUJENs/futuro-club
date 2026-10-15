/**
 * POST /api/players/baseline-analysis — analyses.vsi ya NO lleva `trend` ni `history`.
 *
 * Antes: computeVsiTrend (pendiente/momentum/«delta») corría sobre players.vsi_history
 * —legacy SIN fechas ni origen, con el 57.5 fabricado antes de #146— con el VSI de otra
 * fórmula (media ± PHV) añadido al final. Para Samu ([57.5, 67.4]) guardaba
 * momentum "up" + history [57.5, 67.4, 67], que el panel de análisis pintaba como «↗» y
 * «+9.5 pts» (AnalysisDashboard TrendBadge / VsiSparkline): la misma variación
 * fabricada que el ScoutFeed y el panel de familia ya bloquean (invariante #7).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-coach-1", error: null }),
}));
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: vi.fn().mockResolvedValue(true) }));
vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [] }) }),
  responseText: vi.fn().mockReturnValue("{}"),
}));

// Supabase falso: registra inserts y responde lo mínimo que usa el handler.
const inserts: Record<string, unknown[]> = {};
let playerRow: Record<string, unknown> = {};
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      let op = "select";
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, gte: chain, lte: chain, in: chain, order: chain, limit: chain,
        insert: (payload: unknown) => { (inserts[table] ??= []).push(payload); op = "insert"; return b; },
        update: () => { op = "update"; return b; },
        single: async () =>
          table === "players" ? { data: playerRow, error: null }
          : table === "analyses" && op === "insert" ? { data: { id: "an-1" }, error: null }
          : { data: null, error: null },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(table === "players" ? { data: [], count: 0 } : { data: null, error: null }).then(res, rej),
      });
      return b;
    },
  }),
}));

import baselineHandler from "../baseline-analysis";

function req(): Request {
  return new Request("https://example.com/api/players/baseline-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ playerId: "p-samu" }),
  });
}

describe("baseline-analysis — sin tendencia sobre el historial legacy sin fechas", () => {
  beforeEach(() => {
    for (const k of Object.keys(inserts)) delete inserts[k];
    playerRow = {
      id: "p-samu", tenant_id: "t-1", name: "Samu", age: 9, position: "MC", foot: "right",
      height_cm: 135, weight_kg: 30, competitive_level: "Regional",
      metrics: { speed: 70, technique: 68, vision: 66, stamina: 67, shooting: 65, defending: 66 },
      vsi: 67.4, vsi_history: [57.5, 67.4], phv_category: null, phv_offset: null,
    };
  });

  it("caso Samu (vsi_history [57.5, 67.4]): analyses.vsi sin trend ni history", async () => {
    const res = await baselineHandler(req());
    expect(res.status).toBe(200);
    const analysisInsert = inserts.analyses?.[0] as { vsi: Record<string, unknown> } | undefined;
    expect(analysisInsert).toBeDefined();
    expect(analysisInsert!.vsi).not.toHaveProperty("trend");
    expect(analysisInsert!.vsi).not.toHaveProperty("history");
    expect(JSON.stringify(analysisInsert!.vsi)).not.toContain("57.5");
    // El resto del VSI del análisis sigue intacto; el percentil `peer` ya no se guarda
    // (P1 bloque 5: se calculaba contra jugadores de todas las cuentas, sin mínimo).
    expect(analysisInsert!.vsi).toHaveProperty("vsi");
    expect(analysisInsert!.vsi).not.toHaveProperty("peer");
  });

  it("historial largo (≥ 6 guardados): tampoco se emite el antiguo «delta» últimos-3 vs anteriores-3", async () => {
    playerRow = { ...playerRow, vsi_history: [50, 52, 54, 60, 62, 64, 67.4] };
    const res = await baselineHandler(req());
    expect(res.status).toBe(200);
    const vsi = (inserts.analyses?.[0] as { vsi: Record<string, unknown> }).vsi;
    expect(vsi).not.toHaveProperty("trend");
    expect(vsi).not.toHaveProperty("history");
  });
});
