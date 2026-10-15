/**
 * VITAS · Tests — /api/rankings/list · percentiles con la implementación única (P1 bloque 5)
 * Run: npx vitest run --config vitest.api.config.ts api/rankings/__tests__/list-percentile.test.ts
 *
 * Antes: la ruta principal era la RPC SQL get_ranked_players, cuyo percent_rank() daba
 * P0 al jugador evaluado que estaba solo en su grupo de edad (y al último de cada
 * grupo); la ruta en memoria daba P100 con ≤1 valor. Sin mínimo de pares y con una
 * caché de 5 minutos por usuario.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-percentile", error: null }),
}));

import listHandler from "../_list";

type Row = { id: string; data: Record<string, unknown>; updated_at: string };
let rows: Row[] = [];
let playersUrls: string[] = [];
/** Estado HTTP de la RPC. En el test de la caché se fuerza 500: así el código viejo
 *  caería a su ruta en memoria (la que cacheaba 5 min) y el test lo detectaría. */
let rpcStatus = 200;

function player(id: string, vsi: number | null, extra: Record<string, unknown> = {}): Row {
  return { id, data: { name: id, age: 14, position: "MC", vsi, ...extra }, updated_at: "2026-10-01" };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  playersUrls = [];
  rpcStatus = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/rpc/get_ranked_players")) {
      if (rpcStatus !== 200) return new Response("rpc down", { status: rpcStatus });
      // Si se llamara, devolvería el P0 de percent_rank(): el test comprueba que no.
      return new Response(JSON.stringify({
        players: rows.map((r) => ({ id: r.id, name: r.id, vsi: r.data.vsi, percentile: 0, percentile_in_age_group: 0, data: r.data })),
        total: rows.length,
      }));
    }
    if (u.includes("/rest/v1/players")) {
      playersUrls.push(u);
      return new Response(JSON.stringify(rows));
    }
    return new Response("[]");
  });
});
afterEach(() => vi.restoreAllMocks());

async function list(): Promise<Array<Record<string, unknown>>> {
  const res = await listHandler(
    new Request("https://x.test/api/rankings/list?limit=200", { headers: { Authorization: "Bearer user-jwt" } }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { players: Array<Record<string, unknown>> } }).data.players;
}

describe("rankings · percentil entre pares (implementación única)", () => {
  it("evaluado solo en su grupo ⇒ null + motivo (antes P0 por la RPC, P100 en memoria)", async () => {
    rows = [player("solo", 72), player("sin-evaluar", null)];
    const players = await list();
    const solo = players.find((p) => p.id === "solo")!;
    expect(solo.percentile).toBeNull();
    expect(solo.percentileInAgeGroup).toBeNull();
    expect(solo.percentileInAgeGroupGate).toEqual({ code: "insufficient_peers", peers: 0, min: 10 });
    const unrated = players.find((p) => p.id === "sin-evaluar")!;
    expect(unrated.percentile).toBeNull();
    expect((unrated.percentileGate as { code: string }).code).toBe("not_evaluated");
    // nunca se consulta la RPC
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes("/rpc/"))).toBe(false);
  });

  it("solo los jugadores del propio usuario (la consulta va filtrada por user_id)", async () => {
    rows = [player("a", 60)];
    await list();
    expect(playersUrls[0]).toContain("user_id=eq.coach-percentile");
  });

  it("barras parciales sin VSI guardado ⇒ sin evaluar (una barra ausente no vale 0)", async () => {
    rows = [
      { id: "vacio", data: { name: "vacio", age: 14, position: "MC", metrics: {} }, updated_at: "2026-10-01" },
      { id: "parcial", data: { name: "parcial", age: 14, position: "MC", metrics: { speed: 70 } }, updated_at: "2026-10-01" },
    ];
    const players = await list();
    expect(players.find((p) => p.id === "vacio")!.vsi).toBeNull();
    expect(players.find((p) => p.id === "parcial")!.vsi).toBeNull();
    expect((players.find((p) => p.id === "vacio")!.percentileGate as { code: string }).code).toBe("not_evaluated");
  });

  it("11 evaluados del mismo grupo ⇒ percentil de punto medio entre los 10 pares", async () => {
    rows = Array.from({ length: 11 }, (_, i) => player(`p${i}`, 50 + i));
    const players = await list();
    expect(players.find((p) => p.id === "p10")!.percentileInAgeGroup).toBe(100);
    expect(players.find((p) => p.id === "p0")!.percentileInAgeGroup).toBe(0);
    expect(players.find((p) => p.id === "p5")!.percentileInAgeGroup).toBe(50);
    expect(players.find((p) => p.id === "p5")!.percentileInAgeGroupGate).toBeNull();
  });

  it("los jugadores de ejemplo no cuentan como pares de los reales", async () => {
    rows = [
      ...Array.from({ length: 10 }, (_, i) => player(`demo${i}`, 40 + i, { isDemo: true })),
      player("real", 55),
    ];
    const players = await list();
    const real = players.find((p) => p.id === "real")!;
    expect(real.percentile).toBeNull();
    expect(real.percentileGate).toEqual({ code: "insufficient_peers", peers: 0, min: 10 });
  });

  it("sin caché de 5 minutos: lo recién guardado se ve en la siguiente petición", async () => {
    rpcStatus = 500;
    rows = [player("x", null)];
    expect((await list()).find((p) => p.id === "x")!.vsi).toBeNull();
    rows = [player("x", 64)];
    expect((await list()).find((p) => p.id === "x")!.vsi).toBe(64);
  });
});
