/**
 * VITAS · Tests — /api/rankings/list · sin nivel ni pie inventados (P1 bloque 2)
 * Run: npx vitest run --config vitest.api.config.ts api/rankings/__tests__/list-no-defaults.test.ts
 *
 * Antes: la ruta en memoria devolvía competitiveLevel «Regional» y foot «right» a quien
 * no los tenía registrados; la ruta RPC usaba el `competitive_level` que devuelve la RPC,
 * que es `coalesce(data->>'competitiveLevel', 'Regional')` (059).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
// userId propio: la ruta en memoria cachea por usuario a nivel de módulo.
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-no-defaults", error: null }),
}));

import listHandler from "../_list";

// Alta rápida: sin pie ni nivel.
const QUICK = { name: "Leo", age: 11, position: "RW", birthDate: "2015-03-02" };
const WITH_LEVEL = { name: "Ana", age: 12, position: "CM", foot: "left", competitiveLevel: "Nacional" };

let rpcOk = true;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/rpc/get_ranked_players")) {
      if (!rpcOk) return new Response("no rpc", { status: 404 });
      return new Response(JSON.stringify({
        players: [
          // La RPC devuelve el 'Regional' de su coalesce; el blob no tiene nivel.
          { id: "quick", name: "Leo", vsi: null, competitive_level: "Regional", data: QUICK },
          { id: "lvl", name: "Ana", vsi: null, competitive_level: "Nacional", data: WITH_LEVEL },
        ],
        total: 2,
      }));
    }
    if (u.includes("/rest/v1/players")) {
      return new Response(JSON.stringify([
        { id: "quick", data: QUICK, updated_at: "2026-10-01" },
        { id: "lvl", data: WITH_LEVEL, updated_at: "2026-10-01" },
      ]));
    }
    return new Response("[]");
  });
});
afterEach(() => vi.restoreAllMocks());

async function listBody(): Promise<{ players: Array<Record<string, unknown>>; competitiveLevels: string[] }> {
  const res = await listHandler(
    new Request("https://x.test/api/rankings/list", { headers: { Authorization: "Bearer user-jwt" } }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { players: Array<Record<string, unknown>>; competitiveLevels: string[] } }).data;
}

describe("rankings · nivel y pie sin valores por defecto", () => {
  it("aunque la RPC respondiera (con su 'Regional'), ya no se usa: el nivel sale del blob", async () => {
    // P1 bloque 5: la RPC get_ranked_players no se llama (sus percentiles daban P0).
    rpcOk = true;
    const { players } = await listBody();
    const quick = players.find((p) => p.id === "quick")!;
    const lvl = players.find((p) => p.id === "lvl")!;
    expect(quick.competitiveLevel).toBeNull();
    expect(quick.foot).toBeNull();
    expect(lvl.competitiveLevel).toBe("Nacional");
    expect(lvl.foot).toBe("left");
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes("/rpc/get_ranked_players"))).toBe(false);
  });

  it("ruta en memoria: sin nivel ni pie ⇒ null (no «Regional»/«right»), y el filtro de niveles no inventa ninguno", async () => {
    rpcOk = false;
    const { players, competitiveLevels } = await listBody();
    const quick = players.find((p) => p.id === "quick")!;
    const lvl = players.find((p) => p.id === "lvl")!;
    expect(quick.competitiveLevel).toBeNull();
    expect(quick.foot).toBeNull();
    expect(lvl.competitiveLevel).toBe("Nacional");
    expect(lvl.foot).toBe("left");
    expect(competitiveLevels).toEqual(["Nacional"]);
  });
});
