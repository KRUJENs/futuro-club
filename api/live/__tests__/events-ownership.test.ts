/**
 * VITAS · 074 · POST /api/live/events: solo eventos de jugadores PROPIOS.
 *
 * El endpoint escribe live_events con service_role (salta la RLS y las guardas
 * RESTRICTIVE de la migración 074). Antes solo comprobaba que el PARTIDO era del
 * usuario; el player_id del cuerpo iba tal cual → cualquier cuenta podía colgar
 * eventos del jugador (menor) de OTRA cuenta en su propio partido, y
 * /api/live/aggregate devolvía después el NOMBRE de ese jugador (ver
 * aggregate-player-names.test.ts). Ahora (misma regla que ownsPlayer y que las
 * guardas de la 074: players.user_id = el usuario):
 *   - cada playerId no nulo del lote (o del evento suelto) debe ser del usuario;
 *     se comprueba con UNA consulta `id IN (…)` por petición;
 *   - si alguno no lo es (de otra cuenta o inexistente: misma respuesta, sin
 *     oráculo de existencia) → 403 player_not_owned y NO se escribe NADA del lote;
 *   - si la comprobación no se puede hacer → 503 y no se escribe nada;
 *   - eventos sin jugador (playerId null: «equipo») → como antes.
 * Además el handler ya no vuelve a leer el cuerpo (withHandler ya lo consumió):
 * con la segunda lectura TODO POST respondía 400 (mismo fallo que #288 arregló en
 * live/matches).
 *
 * Supabase simulado: createClient (live_matches / live_events) en memoria y
 * `fetch` para la consulta de propiedad (players), sin red real.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/live/__tests__/events-ownership.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const UA = "aaaaaaaa-0000-4000-8000-00000000000a"; // dueño de pA1
const UB = "bbbbbbbb-0000-4000-8000-00000000000b"; // otra cuenta, dueña de pB1 / pB2
const MATCH_A = "11111111-0000-4000-8000-0000000000a1";
const MATCH_B = "11111111-0000-4000-8000-0000000000b1";

const auth = { userId: UB as string };
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn(async () => ({ userId: auth.userId, email: null, tenantId: null, error: null })),
}));
vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 199, limit: 200, resetAt: Date.now() + 60_000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

const MATCHES: Record<string, { id: string; tenant_id: string; user_id: string }> = {
  [MATCH_A]: { id: MATCH_A, tenant_id: "t-shared", user_id: UA },
  [MATCH_B]: { id: MATCH_B, tenant_id: "t-shared", user_id: UB },
};
// Dueño de cada jugador (players.user_id). Los ids raros prueban el entrecomillado.
const PLAYERS: Record<string, string> = { pA1: UA, pB1: UB, pB2: UB, 'p,"(x)': UB };

let written: Array<Record<string, unknown>> = [];
let playerQueries: string[] = [];
let playersStatus = 200;

function liveMatchesQuery() {
  const filters: Record<string, string> = {};
  const q = {
    select: () => q,
    eq: (k: string, v: string) => { filters[k] = v; return q; },
    single: async () => {
      const m = MATCHES[filters.id];
      return m ? { data: m, error: null } : { data: null, error: { message: "not found" } };
    },
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "live_matches") return liveMatchesQuery();
      if (table === "live_events") {
        return {
          upsert: (rows: Array<Record<string, unknown>>) => {
            written.push(...rows);
            return { select: async () => ({ data: rows, error: null }) };
          },
          insert: (row: Record<string, unknown>) => {
            written.push(row);
            return { select: () => ({ single: async () => ({ data: { id: "ev-1", ...row }, error: null }) }) };
          },
        };
      }
      throw new Error(`tabla inesperada en el test: ${table}`);
    },
  }),
}));

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";

/** Parsea `in.("a","b")` de PostgREST (comillas dobles con escapes \" y \\). */
function parseIn(v: string): string[] {
  const inner = v.replace(/^in\.\(/, "").replace(/\)$/, "");
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push(m[1].replace(/\\(.)/g, "$1"));
  return out;
}

beforeEach(() => {
  written = [];
  playerQueries = [];
  playersStatus = 200;
  auth.userId = UB;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const u = new URL(url);
    if (u.pathname !== "/rest/v1/players") throw new Error(`fetch inesperado en el test: ${url}`);
    playerQueries.push(url);
    if (playersStatus !== 200) return new Response(JSON.stringify({ message: "boom" }), { status: playersStatus });
    const uid = (u.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
    const ids = parseIn(u.searchParams.get("id") ?? "");
    return new Response(JSON.stringify(ids.filter((id) => PLAYERS[id] && PLAYERS[id] === uid).map((id) => ({ id }))), { status: 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function post(body: unknown): Promise<Response> {
  const { default: handler } = await import("../events");
  return handler(
    new Request("https://x.test/api/live/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify(body),
    }),
  );
}

const ev = (playerId: string | null, extra: Record<string, unknown> = {}) => ({
  playerId, eventType: "gol", timestampSeconds: 10, clientEventId: `c-${playerId ?? "team"}-${Math.random()}`, ...extra,
});

describe("POST /api/live/events · lote (sync de la cola offline)", () => {
  it("regresión: un lote válido NO se rechaza como invalid_body (el handler ya no relee el cuerpo que consumió withHandler)", async () => {
    const res = await post({ matchId: MATCH_B, events: [ev(null)] });
    const body = await res.json();
    expect(body.errorDetail?.code).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it("el dueño sincroniza eventos de SUS jugadores y de equipo (sin jugador): 200 y se escriben, con UNA consulta de propiedad", async () => {
    const res = await post({ matchId: MATCH_B, events: [ev("pB1"), ev("pB2"), ev("pB1"), ev(null)] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.inserted).toBe(4);
    expect(written.map((r) => r.player_id)).toEqual(["pB1", "pB2", "pB1", null]);
    expect(written.every((r) => r.user_id === UB && r.match_id === MATCH_B)).toBe(true);
    expect(playerQueries).toHaveLength(1);
    const q = new URL(playerQueries[0]);
    expect(q.searchParams.get("user_id")).toBe(`eq.${UB}`);
    expect(parseIn(q.searchParams.get("id") ?? "").sort()).toEqual(["pB1", "pB2"]);
  });

  it("otra cuenta mete UN evento de un jugador AJENO en su partido → 403 player_not_owned y NO se escribe nada del lote", async () => {
    const res = await post({ matchId: MATCH_B, events: [ev("pB1"), ev("pA1"), ev(null)] });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorDetail.code).toBe("player_not_owned");
    expect(JSON.stringify(body)).not.toContain("pA1");
    expect(written).toHaveLength(0);
  });

  it("un id que NO existe da la MISMA respuesta que uno de otra cuenta (sin oráculo de existencia) y no escribe", async () => {
    const foreign = await (await post({ matchId: MATCH_B, events: [ev("pA1")] })).json();
    const missing = await (await post({ matchId: MATCH_B, events: [ev("p1700000000000_1")] })).json();
    expect(missing).toEqual(foreign);
    expect(written).toHaveLength(0);
  });

  it("si la comprobación de propiedad no se puede hacer → 503 y no se escribe nada", async () => {
    playersStatus = 500;
    const res = await post({ matchId: MATCH_B, events: [ev("pB1")] });
    expect(res.status).toBe(503);
    expect(written).toHaveLength(0);
  });

  it("partido de otra cuenta → 403 forbidden (como antes), sin consultar jugadores ni escribir", async () => {
    const res = await post({ matchId: MATCH_A, events: [ev("pB1")] });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(written).toHaveLength(0);
  });

  it("lote solo de equipo (sin jugadores) → 200 sin consultar jugadores", async () => {
    const res = await post({ matchId: MATCH_B, events: [ev(null), ev(null)] });
    expect(res.status).toBe(200);
    expect(written).toHaveLength(2);
    expect(playerQueries).toHaveLength(0);
  });

  it("ids con comas, comillas y paréntesis van entrecomillados (no rompen ni amplían el IN)", async () => {
    const res = await post({ matchId: MATCH_B, events: [ev('p,"(x)')] });
    expect(res.status).toBe(200);
    expect(written.map((r) => r.player_id)).toEqual(['p,"(x)']);
    expect(parseIn(new URL(playerQueries[0]).searchParams.get("id") ?? "")).toEqual(['p,"(x)']);
  });
});

describe("POST /api/live/events · evento suelto", () => {
  it("jugador AJENO → 403 player_not_owned y no se escribe", async () => {
    const res = await post({ matchId: MATCH_B, ...ev("pA1") });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("player_not_owned");
    expect(written).toHaveLength(0);
  });

  it("jugador PROPIO → 200 y se escribe con el usuario como autor", async () => {
    const res = await post({ matchId: MATCH_B, ...ev("pB1") });
    expect(res.status).toBe(200);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ player_id: "pB1", user_id: UB, match_id: MATCH_B });
  });

  it("sin jugador (evento de equipo) → 200 sin consultar jugadores", async () => {
    const res = await post({ matchId: MATCH_B, ...ev(null) });
    expect(res.status).toBe(200);
    expect(written).toHaveLength(1);
    expect(playerQueries).toHaveLength(0);
  });
});
