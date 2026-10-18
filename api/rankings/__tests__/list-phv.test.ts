/**
 * VITAS · Tests — /api/rankings/list · PHV por el gate único
 * Run: npx vitest run --config vitest.api.config.ts api/rankings/__tests__/list-phv.test.ts
 *
 * Antes (origin/main, _list.ts:144-151 y :221-222): la ruta RPC esparcía el blob
 * DESPUÉS de mapear la columna (el phvCategory persistido del blob llegaba tal
 * cual al cliente) y la ruta en memoria rellenaba phvCategory «ontme»/offset 0
 * para quien no tenía nada — un pre-púber sin medidas salía «on-time».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-rank", error: null }),
}));

import listHandler from "../_list";
import { phvGate } from "../../../src/lib/phv/phvGate";

const SAMU = {
  name: "Samu", age: 9, position: "DC", height: 135, weight: 30, gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
  metrics: { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 },
  vsi: 67.4, phvCategory: "early", phvOffset: -1.2,
};
const COMPLETE = {
  name: "Completo", age: 14, position: "MC", height: 165, weight: 55, sittingHeight: 85, legLength: 80,
  birthDate: "2012-03-15", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
  metrics: { speed: 60, technique: 60, vision: 60, stamina: 60, shooting: 60, defending: 60 },
  vsi: 60, phvCategory: "late", phvOffset: 9,
};

let rpcOk = true;
let lastRpcBody: Record<string, unknown> | null = null;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  lastRpcBody = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/rpc/get_ranked_players")) {
      lastRpcBody = JSON.parse(String(init?.body ?? "{}"));
      if (!rpcOk) return new Response("no rpc", { status: 404 });
      return new Response(JSON.stringify({
        players: [
          { id: "samu", name: "Samu", vsi: 67.4, phv_category: "early", data: SAMU },
          { id: "full", name: "Completo", vsi: 60, phv_category: null, data: COMPLETE },
        ],
        total: 2,
      }));
    }
    if (u.includes("/rest/v1/players")) {
      return new Response(JSON.stringify([
        { id: "samu", data: SAMU, updated_at: "2026-09-01" },
        { id: "full", data: COMPLETE, updated_at: "2026-09-01" },
      ]));
    }
    return new Response("[]");
  });
});
afterEach(() => vi.restoreAllMocks());

async function listPage(qs = ""): Promise<{ players: Array<Record<string, unknown>>; total: number }> {
  const res = await listHandler(
    new Request(`https://x.test/api/rankings/list${qs}`, { headers: { Authorization: "Bearer user-jwt" } }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { players: Array<Record<string, unknown>>; total: number } };
  return body.data;
}

async function list(): Promise<Array<Record<string, unknown>>> {
  return (await listPage()).players;
}

const g = phvGate(COMPLETE);
const expectedCat = g.ok ? (g.category === "ontme" ? "on-time" : g.category) : null;

describe.each([
  // P1 bloque 5: sin la RPC get_ranked_players (daba P0); la ruta en memoria es la única.
  ["ruta única en memoria", false],
])("rankings (%s)", (_label, useRpc) => {
  it("el phvCategory persistido de Samu (sin medidas) NO llega: null + motivo", async () => {
    rpcOk = useRpc as boolean;
    const players = await list();
    const samu = players.find((p) => p.id === "samu")!;
    expect(samu.phvCategory).toBeNull();
    expect(samu.phvOffset).toBeNull();
    expect(String(samu.phvGateReason)).toContain("Falta: talla sentado, longitud de pierna, fecha de nacimiento del jugador");
  });

  it("jugador con entradas completas ⇒ categoría RECALCULADA por el gate (no la persistida)", async () => {
    rpcOk = useRpc as boolean;
    const players = await list();
    const full = players.find((p) => p.id === "full")!;
    expect(g.ok).toBe(true);
    expect(full.phvCategory).toBe(expectedCat);
    expect(full.phvOffset).toBe(g.ok ? g.offset.value : null);
    expect(full.phvGateReason).toBeNull();
  });
});

// Filtro PHV: la RPC filtraba por el phvCategory PERSISTIDO del blob (Samu «early»
// salía al filtrar «early» rotulado «PHV no disponible») y la ruta en memoria por
// el recálculo. Ahora ambas filtran DESPUÉS del gate: lo que se filtra = lo que se ve.
describe.each([
  // P1 bloque 5: sin la RPC get_ranked_players (daba P0); la ruta en memoria es la única.
  ["ruta única en memoria", false],
])("rankings (%s) · filtro PHV sobre la categoría gateada", (_label, useRpc) => {
  it.each(["early", "on-time", "late"])("phv=%s devuelve solo quien el gate clasifica así", async (phv) => {
    rpcOk = useRpc as boolean;
    const { players, total } = await listPage(`?phv=${phv}`);
    const ids = players.map((p) => p.id);
    // Samu (blob «early», sin medidas) NUNCA pasa un filtro PHV: su gate está cerrado.
    expect(ids).not.toContain("samu");
    expect(ids).toEqual(expectedCat === phv ? ["full"] : []);
    expect(total).toBe(ids.length);
    for (const p of players) expect(p.phvCategory).toBe(phv);
    // P1 bloque 5: la RPC (percent_rank ⇒ P0) ya no se llama nunca.
    expect(lastRpcBody).toBeNull();
  });

  it("pagina en memoria (limit/offset) sin llamar a la RPC", async () => {
    rpcOk = useRpc as boolean;
    const { players, total } = await listPage("?limit=1&offset=1");
    expect(total).toBe(2);
    expect(players).toHaveLength(1);
    expect(lastRpcBody).toBeNull();
  });
});

// Filtro «Maduración» de la UI = TIMING vs pares (`timing=`), el MISMO que rotula
// la fila («Madurador tardío ⭐»). Antes el chip «Tardío ⭐» mandaba phv=early y se
// filtraba la FASE (early = pre-PHV): el tardío en PHV quedaba oculto y el pre-PHV
// «en fase» aparecía. Casos del hallazgo, gate de la rama a 2026-09-29.
describe.each([
  // P1 bloque 5: sin la RPC get_ranked_players (daba P0); la ruta en memoria es la única.
  ["ruta única en memoria", false],
])("rankings (%s) · filtro de timing = lo que rotula la fila", (_label, useRpc) => {
  const LATE_IN_PHV = {
    name: "Tardío en PHV", age: 15, position: "MC", height: 160, weight: 48, sittingHeight: 80, legLength: 80,
    birthDate: "2011-09-29", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", vsi: 70, phvCategory: "early",
  };
  const PRE_PHV_ON_TIME = {
    name: "Pre-PHV en fase", age: 10, position: "MC", height: 150, weight: 42, sittingHeight: 78, legLength: 72,
    birthDate: "2016-03-29", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", vsi: 65, phvCategory: "late",
  };
  const rows = [
    { id: "late", data: LATE_IN_PHV },
    { id: "pre", data: PRE_PHV_ON_TIME },
    { id: "samu", data: SAMU },
  ];

  beforeEach(async () => {
    // Fecha fija (edad decimal del gate) y usuario propio: la ruta en memoria
    // cachea por usuario 5 min y no debe servir los jugadores de otros bloques.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const { verifyAuth } = await import("../../_lib/auth");
    vi.mocked(verifyAuth).mockResolvedValue({ userId: `coach-timing-${useRpc ? "rpc" : "mem"}`, error: null } as never);
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/rpc/get_ranked_players")) {
        lastRpcBody = JSON.parse(String(init?.body ?? "{}"));
        if (!useRpc) return new Response("no rpc", { status: 404 });
        return new Response(JSON.stringify({
          players: rows.map((r) => ({ id: r.id, name: r.data.name, vsi: r.data.vsi, data: r.data })),
          total: rows.length,
        }));
      }
      if (u.includes("/rest/v1/players")) {
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, updated_at: "2026-09-01" }))));
      }
      return new Response("[]");
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    const { verifyAuth } = await import("../../_lib/auth");
    vi.mocked(verifyAuth).mockResolvedValue({ userId: "coach-rank", error: null } as never);
  });

  /** Timing que pinta la fila en Rankings.tsx: phvGate sobre la fila del API. */
  const rowTiming = (p: Record<string, unknown>) => {
    const g = phvGate(p as never);
    return g.ok ? g.assessment.timing : null;
  };

  it("timing=late lista al tardío en PHV y NO al pre-PHV en fase (el caso del hallazgo)", async () => {
    const { players, total } = await listPage("?timing=late");
    expect(players.map((p) => p.id)).toEqual(["late"]);
    expect(total).toBe(1);
    expect(players[0].phvCategory).toBe("on-time"); // en PHV: la fase NO decide el filtro
    expect(players[0].phvTiming).toBe("late");
  });

  it.each(["late", "on_time", "early"])("timing=%s ⇒ exactamente las filas rotuladas con ese timing", async (timing) => {
    const all = (await listPage()).players;
    const expected = all.filter((p) => rowTiming(p) === timing).map((p) => p.id);
    const { players, total } = await listPage(`?timing=${timing}`);
    expect(players.map((p) => p.id)).toEqual(expected);
    expect(total).toBe(expected.length);
    for (const p of players) {
      expect(rowTiming(p)).toBe(timing); // el rótulo de la fila = el chip pulsado
      expect(p.phvTiming).toBe(timing);
    }
    // Samu (sin medidas) nunca pasa un filtro de maduración.
    expect(players.map((p) => p.id)).not.toContain("samu");
    if (useRpc) {
      expect(lastRpcBody?.p_phv).toBeNull();
      expect(lastRpcBody?.p_offset).toBe(0);
    }
  });
});
