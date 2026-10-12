/**
 * VITAS · 074 · escrituras de planes IDP por API: solo el DUEÑO del jugador.
 *
 * /api/idp/approve-plan, /checkin, /update-goal y /update-milestone escriben con
 * service_role (saltan la RLS). Antes NO comprobaban propiedad: cualquier cuenta
 * pro/club activaba, revisaba (y cerraba con closeMonth) o editaba el plan de
 * cualquier menor conociendo un id. Ahora (misma regla que las guardas RESTRICTIVE
 * de la migración 074 y que la RLS solo-dueño de la 076):
 *   - otra cuenta (B) → 403 FORBIDDEN y NO se escribe nada;
 *   - id que no existe o comprobación que falla → 403 (fail-closed), nada escrito;
 *   - el dueño (A) → 200 y se escribe como antes;
 *   - llamada de servicio (token interno) → como antes, sin comprobación de dueño.
 *
 * Supabase simulado con un `fetch` que enruta por URL (sin red real).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.SUPABASE_URL = "https://sb.test";
process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.INTERNAL_API_TOKEN = "internal-token";

const UA = "aaaaaaaa-0000-4000-8000-00000000000a"; // dueño de pA
const UB = "bbbbbbbb-0000-4000-8000-00000000000b"; // otra cuenta (dueño de pB)
const PLAN_A = "11111111-0000-4000-8000-0000000000a1";
const PLAN_B = "11111111-0000-4000-8000-0000000000b1";
const GOAL_A = "22222222-0000-4000-8000-0000000000a1";
const MS_A = "33333333-0000-4000-8000-0000000000a1";
const MISSING = "99999999-0000-4000-8000-000000000099";

const auth = { userId: UA as string };
vi.mock("../_lib/auth", () => ({
  verifyAuth: vi.fn(async () => ({ userId: auth.userId, email: null, tenantId: null, error: null })),
}));
vi.mock("../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60_000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

const PLAYERS: Record<string, string> = { pA: UA, pB: UB };
const PLANS: Record<string, string> = { [PLAN_A]: "pA", [PLAN_B]: "pB" };
const GOALS: Record<string, string> = { [GOAL_A]: PLAN_A };
const MILESTONES: Record<string, string> = { [MS_A]: PLAN_A };

let calls: Array<{ method: string; path: string; url: string; body?: unknown }> = [];
let plansStatus = 200;

const eq = (u: URL, k: string) => (u.searchParams.get(k) ?? "").replace(/^eq\./, "");

beforeEach(() => {
  calls = [];
  plansStatus = 200;
  auth.userId = UA;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const u = new URL(url);
    calls.push({ method, path: u.pathname, url, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (u.pathname === "/rest/v1/subscriptions") return json([{ plan: "pro", status: "active" }]);
    if (method === "GET") {
      if (u.pathname === "/rest/v1/players") {
        const id = eq(u, "id");
        const uid = u.searchParams.has("user_id") ? eq(u, "user_id") : undefined;
        const owner = PLAYERS[id];
        return json(owner && (uid === undefined || owner === uid) ? [{ id }] : []);
      }
      if (u.pathname === "/rest/v1/development_plans") {
        if (plansStatus !== 200) return json({ message: "boom" }, plansStatus);
        const p = PLANS[eq(u, "id")];
        return json(p ? [{ player_id: p }] : []);
      }
      if (u.pathname === "/rest/v1/idp_goals") {
        const p = GOALS[eq(u, "id")];
        return json(p ? [{ plan_id: p }] : []);
      }
      if (u.pathname === "/rest/v1/idp_milestones") {
        const p = MILESTONES[eq(u, "id")];
        return json(p ? [{ plan_id: p }] : []);
      }
      return json([]);
    }
    // PATCH / POST: devuelven la fila (Prefer: return=representation)
    return json([{ id: eq(u, "id") || "new", ...(body ?? {}) }], method === "POST" ? 201 : 200);
  });
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: unknown, bearer = "user-jwt") =>
  new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
const writes = (path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);
const code = async (res: Response) => ((await res.clone().json()) as { errorDetail?: { code?: string } }).errorDetail?.code;

interface Case {
  name: string;
  module: () => Promise<{ default: (req: Request) => Promise<Response> }>;
  route: string;
  ownBody: Record<string, unknown>;
  foreignBody: Record<string, unknown>;
  missingBody: Record<string, unknown>;
  writePath: string;
}

const CASES: Case[] = [
  {
    name: "approve-plan (activar el plan)",
    module: () => import("../idp/_approve-plan"),
    route: "/api/idp/approve-plan",
    ownBody: { planId: PLAN_A },
    foreignBody: { planId: PLAN_A },
    missingBody: { planId: MISSING },
    writePath: "/rest/v1/development_plans",
  },
  {
    name: "checkin (revisión mensual + cerrar el mes)",
    module: () => import("../idp/_checkin"),
    route: "/api/idp/checkin",
    ownBody: { planId: PLAN_A, progressScore: 60, closeMonth: true },
    foreignBody: { planId: PLAN_A, progressScore: 1, closeMonth: true },
    missingBody: { planId: MISSING, progressScore: 1 },
    writePath: "/rest/v1/idp_checkins",
  },
  {
    name: "update-goal (editar un objetivo)",
    module: () => import("../idp/_update-goal"),
    route: "/api/idp/update-goal",
    ownBody: { goalId: GOAL_A, title: "Primer toque orientado" },
    foreignBody: { goalId: GOAL_A, title: "Cambiado por otra cuenta" },
    missingBody: { goalId: MISSING, title: "No existe este objetivo" },
    writePath: "/rest/v1/idp_goals",
  },
  {
    name: "update-milestone (marcar un hito)",
    module: () => import("../idp/_update-milestone"),
    route: "/api/idp/update-milestone",
    ownBody: { milestoneId: MS_A, status: "completed" },
    foreignBody: { milestoneId: MS_A, status: "missed" },
    missingBody: { milestoneId: MISSING, status: "completed" },
    writePath: "/rest/v1/idp_milestones",
  },
];

describe.each(CASES)("idp/$name · solo el dueño del jugador del plan", (c) => {
  it("otra cuenta (B, NO dueña del jugador del plan) → 403 FORBIDDEN y no se escribe nada", async () => {
    const { default: handler } = await c.module();
    auth.userId = UB;
    const res = await handler(post(c.route, c.foreignBody));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("FORBIDDEN");
    expect(calls.filter((x) => x.method !== "GET")).toEqual([]);
  });

  it("id que no existe → 403 (fail-closed), nada escrito", async () => {
    const { default: handler } = await c.module();
    const res = await handler(post(c.route, c.missingBody));
    expect(res.status).toBe(403);
    expect(calls.filter((x) => x.method !== "GET")).toEqual([]);
  });

  it("no se puede leer el plan (consulta no-ok) → 403 (fail-closed), nada escrito", async () => {
    const { default: handler } = await c.module();
    plansStatus = 500;
    const res = await handler(post(c.route, c.ownBody));
    expect(res.status).toBe(403);
    expect(calls.filter((x) => x.method !== "GET")).toEqual([]);
  });

  it("el dueño (A) → 200 y se escribe como antes", async () => {
    const { default: handler } = await c.module();
    const res = await handler(post(c.route, c.ownBody));
    expect(res.status).toBe(200);
    expect(writes(c.writePath)).toHaveLength(1);
    // La propiedad se comprobó contra players.user_id del JWT, no contra el cuerpo.
    expect(calls.some((x) => x.path === "/rest/v1/players" && x.url.includes(`user_id=eq.${UA}`))).toBe(true);
  });

  it("llamada de servicio (token interno) → como antes: sin comprobación de dueño", async () => {
    const { default: handler } = await c.module();
    const res = await handler(post(c.route, c.foreignBody, "internal-token"));
    expect(res.status).toBe(200);
    expect(writes(c.writePath)).toHaveLength(1);
    expect(calls.some((x) => x.path === "/rest/v1/players")).toBe(false);
  });
});

describe("idp/checkin · closeMonth", () => {
  it("el dueño cierra SU plan; B no cierra el de A (ni se inserta la revisión)", async () => {
    const { default: handler } = await import("../idp/_checkin");
    const own = await handler(post("/api/idp/checkin", { planId: PLAN_A, closeMonth: true }));
    expect(own.status).toBe(200);
    expect(writes("/rest/v1/development_plans")).toHaveLength(1);
    calls = [];
    auth.userId = UB;
    const foreign = await handler(post("/api/idp/checkin", { planId: PLAN_A, closeMonth: true }));
    expect(foreign.status).toBe(403);
    expect(writes("/rest/v1/development_plans")).toEqual([]);
    expect(writes("/rest/v1/idp_checkins")).toEqual([]);
  });
});
