/**
 * VITAS · Retirada del consentimiento parental (ronda 6 de la review del PR #308)
 *
 * Antes «revocar» en /admin/consent solo ponía players.parental_consent_status = 'denied',
 * y el entrenador lo podía volver a poner en 'granted' («Solicitar de nuevo») sin el tutor:
 * el consentimiento verificado volvía a contar. Ahora la retirada se guarda en el propio
 * consentimiento (withdrawn_at + evidencia 'consent_withdrawn' en gdpr_audit_log) desde el
 * servidor, y parental_consent_status no cuenta para nada.
 *
 * PostgREST simulado en memoria (parental_consents, gdpr_audit_log, players): SIMULACIÓN, no la
 * base real.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/auth/__tests__/withdraw-consent.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let caller = OWNER;

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn(async () => ({ userId: caller, email: null, tenantId: null, error: null })),
}));

import withdrawConsent from "../_withdraw-consent";
import { findActiveParentalConsent, withdrawParentalConsents } from "../../_lib/parentalConsent";

const SB = "https://sb.test";
const C1 = "c1000000-0000-4000-8000-000000000001";
const C2 = "c2000000-0000-4000-8000-000000000002";

interface Consent { id: string; player_id: string; email_verified: boolean; withdrawn_at: string | null; withdrawn_reason?: string | null; signed_at: string }
interface Audit { action: string; resource_type: string; resource_id: string; metadata: Record<string, unknown> }

let consents: Consent[];
let audit: Audit[];
let players: Array<{ id: string; user_id: string; parental_consent_status: string }>;
let calls: Array<{ method: string; table: string; url: string }>;
let failPatch = false;

/** Valor de un filtro PostgREST (`eq.x`, `is.null`, `is.true`, `in.("a","b")`) aplicado a v. */
function matches(filter: string, v: unknown): boolean {
  if (filter.startsWith("eq.")) return String(v) === filter.slice(3);
  if (filter === "is.null") return v === null || v === undefined;
  if (filter === "is.true") return v === true;
  if (filter.startsWith("in.(")) {
    const list = filter.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
    return list.includes(String(v));
  }
  throw new Error(`filtro no simulado: ${filter}`);
}
const RESERVED = new Set(["select", "order", "limit"]);
function filterRows<T extends Record<string, unknown>>(rows: T[], params: URLSearchParams): T[] {
  return rows.filter((r) => [...params.entries()].every(([k, f]) => RESERVED.has(k) || matches(f, r[k])));
}

function addVerifiedConsent(id: string, playerId: string, token = `sha256:${id}`) {
  consents.push({ id, player_id: playerId, email_verified: true, withdrawn_at: null, signed_at: new Date().toISOString() });
  audit.push({ action: "consent_token_issued", resource_type: "parental_consents", resource_id: id, metadata: { player_id: playerId, parent_email: "tutor@x.test", token_hash: token } });
  audit.push({ action: "consent_email_verified", resource_type: "parental_consents", resource_id: id, metadata: { player_id: playerId, token_hash: token } });
}

beforeEach(() => {
  process.env.SUPABASE_URL = SB;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  caller = OWNER;
  failPatch = false;
  consents = [];
  audit = [];
  players = [{ id: "p1", user_id: OWNER, parental_consent_status: "granted" }];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const table = url.pathname.replace("/rest/v1/", "");
    calls.push({ method, table, url: url.href });
    const params = url.searchParams;
    if (table === "parental_consents" && method === "GET") return Response.json(filterRows(consents as never[], params));
    if (table === "parental_consents" && method === "PATCH") {
      if (failPatch) return new Response("boom", { status: 500 });
      const patch = JSON.parse(String(init?.body)) as Partial<Consent>;
      for (const r of filterRows(consents as never[], params) as Consent[]) Object.assign(r, patch);
      return new Response(null, { status: 204 });
    }
    if (table === "gdpr_audit_log" && method === "GET") return Response.json(filterRows(audit as never[], params));
    if (table === "gdpr_audit_log" && method === "POST") {
      audit.push(JSON.parse(String(init?.body)) as Audit);
      return new Response(null, { status: 201 });
    }
    if (table === "players" && method === "GET") return Response.json(filterRows(players as never[], params));
    throw new Error(`petición no simulada: ${method} ${url.href}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const post = (body: Record<string, unknown>) =>
  withdrawConsent(new Request("https://x.test/api/auth/withdraw-consent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify(body),
  }));

describe("withdrawParentalConsents · la retirada se guarda en el consentimiento", () => {
  it("control positivo: un consentimiento verificado por el tutor cuenta", async () => {
    addVerifiedConsent(C1, "p1");
    expect(await findActiveParentalConsent("p1")).toMatchObject({ id: C1 });
  });

  it("verificado → retirado → ya no cuenta (withdrawn_at + evidencia consent_withdrawn)", async () => {
    addVerifiedConsent(C1, "p1");
    expect(await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: "el tutor lo pide" })).toBe(1);
    expect(consents[0].withdrawn_at).not.toBeNull();
    expect(consents[0].withdrawn_reason).toBe("el tutor lo pide");
    expect(audit.filter((a) => a.action === "consent_withdrawn" && a.resource_id === C1)).toHaveLength(1);
    expect(await findActiveParentalConsent("p1")).toBeNull();
  });

  it("verificado → retirado → el entrenador pone 'granted' → SIGUE bloqueado (parental_consent_status no cuenta)", async () => {
    addVerifiedConsent(C1, "p1");
    await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null });
    players[0].parental_consent_status = "granted";
    expect(await findActiveParentalConsent("p1")).toBeNull();
    // Ni siquiera se consulta players: esa columna no entra en la decisión.
    calls = [];
    await findActiveParentalConsent("p1");
    expect(calls.some((c) => c.table === "players")).toBe(false);
  });

  it("la evidencia aguanta aunque un cliente vuelva a poner withdrawn_at = NULL (antes de la 075)", async () => {
    addVerifiedConsent(C1, "p1");
    await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null });
    consents[0].withdrawn_at = null;
    expect(await findActiveParentalConsent("p1")).toBeNull();
  });

  it("un consentimiento NUEVO que el tutor firma y verifica después SÍ cuenta", async () => {
    addVerifiedConsent(C1, "p1");
    await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null });
    addVerifiedConsent(C2, "p1", "sha256:nuevo");
    expect(await findActiveParentalConsent("p1")).toMatchObject({ id: C2 });
  });

  it("sin consentimientos activos → 0 y no escribe nada", async () => {
    expect(await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null })).toBe(0);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("solo toca los consentimientos de ESE jugador", async () => {
    addVerifiedConsent(C1, "p1");
    addVerifiedConsent(C2, "p2");
    await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null });
    expect(await findActiveParentalConsent("p2")).toMatchObject({ id: C2 });
  });

  it("si falla el PATCH, lanza; la evidencia ya escrita mantiene la retirada (reintentar es seguro)", async () => {
    addVerifiedConsent(C1, "p1");
    failPatch = true;
    await expect(withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null })).rejects.toThrow();
    expect(await findActiveParentalConsent("p1")).toBeNull();
    failPatch = false;
    expect(await withdrawParentalConsents({ playerId: "p1", userId: OWNER, tenantId: null, reason: null })).toBe(1);
    expect(consents[0].withdrawn_at).not.toBeNull();
  });
});

describe("POST /api/auth/withdraw-consent", () => {
  it("el DUEÑO retira → 200 { withdrawn: 1 } y el consentimiento deja de contar", async () => {
    addVerifiedConsent(C1, "p1");
    const res = await post({ playerId: "p1", reason: "revocado" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ withdrawn: 1 });
    expect(await findActiveParentalConsent("p1")).toBeNull();
  });

  it("otra cuenta → 403 y no escribe nada", async () => {
    addVerifiedConsent(C1, "p1");
    caller = OTHER;
    const res = await post({ playerId: "p1" });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    expect(await findActiveParentalConsent("p1")).toMatchObject({ id: C1 });
  });

  it("jugador que no existe → el mismo 403", async () => {
    const res = await post({ playerId: "no-existe" });
    expect(res.status).toBe(403);
  });

  it("fallo de la base → 500 consent_withdraw_failed (la pantalla no debe decir «revocado»)", async () => {
    addVerifiedConsent(C1, "p1");
    failPatch = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ playerId: "p1" });
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail?.code ?? "").toBe("consent_withdraw_failed");
  });

  it("sin playerId → 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });
});
