/**
 * VITAS · 076 · SOLO EL DUEÑO, endpoint a endpoint (los que decidían la propiedad
 * con lógica inline, no solo con los helpers de api/_lib/ownership.ts).
 *
 * Escenario del P0 (30 sep 2026): dos cuentas, A y B, con el MISMO tenant_id en su
 * JWT (en producción los 3 jugadores comparten un único tenant_id que no es ni un
 * usuario ni una organización). Antes de la 076 la regla «dueño o su tenant» dejaba
 * a B leer/escribir los datos del jugador de A. Ahora:
 *   - B recibe 403 y NO se escribe nada ni se dispara nada;
 *   - A (el dueño) sigue funcionando;
 *   - si no se puede comprobar el dueño, se falla CERRADO.
 *
 * Supabase y Anthropic simulados con un `fetch` que enruta por URL (sin red real).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.SUPABASE_URL = "https://sb.test";
process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.ANTHROPIC_API_KEY = ""; // IDP: arquitecto determinista, sin LLM

const UA = "aaaaaaaa-0000-4000-8000-00000000000a"; // dueño de pA
const UB = "bbbbbbbb-0000-4000-8000-00000000000b"; // otra cuenta, MISMO tenant
const T = "99999999-9999-4999-8999-999999999999"; // tenant compartido (como en prod)

const auth = { userId: UA as string, tenantId: T as string | null };
vi.mock("../_lib/auth", () => ({
  verifyAuth: vi.fn(async () => ({ userId: auth.userId, email: null, tenantId: auth.tenantId, error: null })),
}));
vi.mock("../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60_000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../_lib/usageGuard", () => ({
  checkUsageQuota: vi.fn(async () => ({ allowed: true })),
  incrementUsage: vi.fn(async () => undefined),
  usageExceededResponse: vi.fn(),
}));

/** Base de datos simulada: jugadores con su dueño y el MISMO tenant. */
const PLAYERS: Record<string, { user_id: string; tenant_id: string }> = {
  pA: { user_id: UA, tenant_id: T },
};
const LISTINGS: Record<string, { seller_user_id: string; tenant_id: string }> = {
  "lst-a": { seller_user_id: UA, tenant_id: T },
};

let calls: Array<{ method: string; url: string; body?: unknown }> = [];
let playersStatus = 200;

function playerRows(u: URL) {
  const id = (u.searchParams.get("id") ?? "").replace(/^eq\./, "");
  const uid = u.searchParams.get("user_id")?.replace(/^eq\./, "");
  const p = PLAYERS[id];
  if (!p || (uid !== undefined && p.user_id !== uid)) return [];
  return [{ id, user_id: p.user_id, tenant_id: p.tenant_id }];
}

beforeEach(() => {
  calls = [];
  playersStatus = 200;
  auth.userId = UA;
  auth.tenantId = T;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    if (u.pathname === "/rest/v1/subscriptions") return new Response(JSON.stringify([{ plan: "pro", status: "active" }]));
    if (u.pathname === "/rest/v1/players") {
      if (playersStatus !== 200) return new Response(JSON.stringify({ message: "boom" }), { status: playersStatus });
      return new Response(JSON.stringify(playerRows(u)));
    }
    if (u.pathname === "/rest/v1/transfer_listings" && method === "GET") {
      const id = (u.searchParams.get("id") ?? "").replace(/^eq\./, "");
      const l = LISTINGS[id];
      return new Response(JSON.stringify(l ? [l] : []));
    }
    if (u.pathname === "/rest/v1/transfer_inquiries") return new Response(JSON.stringify([]));
    if (u.pathname === "/rest/v1/development_plans" && method === "GET") return new Response(JSON.stringify([]));
    if (method === "POST") return new Response(JSON.stringify([body]), { status: 201 });
    return new Response("[]");
  });
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: unknown) =>
  new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`https://x.test${path}`, { headers: { Authorization: "Bearer user-jwt" } });
const writesTo = (path: string) => calls.filter((c) => c.method !== "GET" && new URL(c.url).pathname === path);

// ─────────────────────────────────────────────────────────────────────────────
describe("transfer/create-listing · publicar a un menor en el mercado", () => {
  const body = { playerId: "pA", listingType: "sale" };

  it("B (mismo tenant, NO dueño) → 403 y no se inserta nada", async () => {
    const { default: handler } = await import("../transfer/_create-listing");
    auth.userId = UB;
    const res = await handler(post("/api/transfer/create-listing", body));
    expect(res.status).toBe(403);
    expect(writesTo("/rest/v1/transfer_listings")).toEqual([]);
  });

  it("no se puede comprobar el dueño (consulta no-ok) → 503 fail-closed, no se inserta nada", async () => {
    const { default: handler } = await import("../transfer/_create-listing");
    playersStatus = 500;
    const res = await handler(post("/api/transfer/create-listing", body));
    expect(res.status).toBe(503);
    expect(writesTo("/rest/v1/transfer_listings")).toEqual([]);
  });

  it("A (dueño) → 200; el vendedor sale del JWT", async () => {
    const { default: handler } = await import("../transfer/_create-listing");
    const res = await handler(post("/api/transfer/create-listing", body));
    expect(res.status).toBe(200);
    const ins = writesTo("/rest/v1/transfer_listings");
    expect(ins).toHaveLength(1);
    expect(ins[0].body).toMatchObject({ player_id: "pA", seller_user_id: UA });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("transfer/list-inquiries · buzón de ofertas sobre un menor", () => {
  it("B (mismo tenant que la ficha) → 403", async () => {
    const { default: handler } = await import("../transfer/_list-inquiries");
    auth.userId = UB;
    const res = await handler(get("/api/transfer/list-inquiries?listingId=lst-a"));
    expect(res.status).toBe(403);
    expect(calls.some((c) => new URL(c.url).pathname === "/rest/v1/transfer_inquiries")).toBe(false);
  });

  it("A (vendedor) → 200", async () => {
    const { default: handler } = await import("../transfer/_list-inquiries");
    const res = await handler(get("/api/transfer/list-inquiries?listingId=lst-a"));
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("idp/generate-plan · plan de desarrollo de un menor", () => {
  // Con una dimensión con dato (técnica, de vídeo): sin ninguna no se genera plan (5d).
  const architectInput = {
    player: { id: "pA", name: "Jugador A", position: "MC", chronologicalAge: 12 },
    vsi: { overall: 70, technical: 64, tactical: null, physical: null, mental: null },
  };

  it("A (dueño) SIN ninguna dimensión con dato → 422 idp_no_dimension_data y no escribe nada (P1 5d)", async () => {
    const { default: handler } = await import("../idp/_generate-plan");
    const res = await handler(
      post("/api/idp/generate-plan", { architectInput: { player: architectInput.player, vsi: { overall: 70, technical: null, tactical: null, physical: null, mental: null } } }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errorDetail: { code: string } };
    expect(body.errorDetail.code).toBe("idp_no_dimension_data");
    expect(writesTo("/rest/v1/development_plans")).toEqual([]);
  });

  it("B (mismo tenant, NO dueño) → 403: ni consulta si ya existe un plan ni escribe nada", async () => {
    const { default: handler } = await import("../idp/_generate-plan");
    auth.userId = UB;
    const res = await handler(post("/api/idp/generate-plan", { architectInput, coachId: UB, tenantId: T }));
    expect(res.status).toBe(403);
    expect(calls.some((c) => new URL(c.url).pathname === "/rest/v1/development_plans")).toBe(false);
    expect(writesTo("/rest/v1/idp_goals")).toEqual([]);
  });

  it("A (dueño) → 200; coach_id y tenant_id salen del JWT, nunca del cuerpo", async () => {
    const { default: handler } = await import("../idp/_generate-plan");
    const res = await handler(
      post("/api/idp/generate-plan", { architectInput, coachId: UB, tenantId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(res.status).toBe(200);
    const plans = writesTo("/rest/v1/development_plans");
    expect(plans).toHaveLength(1);
    expect(plans[0].body).toMatchObject({ player_id: "pA", coach_id: UA, tenant_id: T });
  });

  it("jugador que no existe en la base (o local, sin sincronizar) → 403, mismo criterio que idp/get-plan", async () => {
    const { default: handler } = await import("../idp/_generate-plan");
    const res = await handler(
      post("/api/idp/generate-plan", { architectInput: { ...architectInput, player: { ...architectInput.player, id: "p-local" } } }),
    );
    expect(res.status).toBe(403);
    expect(writesTo("/rest/v1/development_plans")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generate-reports usa supabase-js (service role): se simula el cliente.
const sbLog: string[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => {
            sbLog.push(`select ${table}.${cols} ${col}=${val}`);
            return { data: table === "analyses" && val === "aaaaaaaa-1111-4111-8111-000000000001" ? { player_id: "pA" } : null };
          },
        }),
      }),
      update: (patch: unknown) => ({
        eq: async (col: string, val: unknown) => {
          sbLog.push(`update ${table} ${col}=${val} ${JSON.stringify(patch).slice(0, 40)}`);
          return { error: null };
        },
      }),
    }),
  }),
}));

describe("analyses/generate-reports · sobrescribir el análisis de un menor y disparar el orquestador", () => {
  const AN = "aaaaaaaa-1111-4111-8111-000000000001"; // análisis de pA (pipeline: user_id NULL)

  it("B (mismo tenant, NO dueño) → 403: ni se actualiza el análisis ni se llama al orquestador", async () => {
    const { default: handler } = await import("../analyses/generate-reports");
    sbLog.length = 0;
    auth.userId = UB;
    const res = await handler(post("/api/analyses/generate-reports", { analysisId: AN, playerId: "pA", videoId: "v1" }));
    expect(res.status).toBe(403);
    expect(sbLog.some((l) => l.startsWith("update"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/api/agents/pipeline-orchestrator"))).toBe(false);
  });

  it("análisis pedido que no existe → 404 fail-closed (antes se saltaba la comprobación)", async () => {
    const { default: handler } = await import("../analyses/generate-reports");
    sbLog.length = 0;
    const res = await handler(
      post("/api/analyses/generate-reports", { analysisId: "aaaaaaaa-1111-4111-8111-000000000999", playerId: "pA", videoId: "v1" }),
    );
    expect(res.status).toBe(404);
    expect(sbLog.some((l) => l.startsWith("update"))).toBe(false);
  });

  it("A (dueño del jugador del análisis) → 200 y se dispara el orquestador", async () => {
    const { default: handler } = await import("../analyses/generate-reports");
    sbLog.length = 0;
    // Con la declaración del entrenador (gate de consentimiento de clips, PR #308): sin ella
    // el servidor responde 400 attestation_required antes de tocar el análisis.
    const attestation = { accepted: true, version: "2026-09-28.v1" };
    const res = await handler(post("/api/analyses/generate-reports", { analysisId: AN, playerId: "pA", videoId: "v1", attestation }));
    expect(res.status).toBe(200);
    expect(sbLog.some((l) => l.startsWith(`update analyses id=${AN}`))).toBe(true);
    expect(calls.some((c) => c.url.includes("/api/agents/pipeline-orchestrator"))).toBe(true);
  });
});
