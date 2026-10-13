/**
 * VITAS · Consentimiento del tutor de punta a punta (P1 bloque 3)
 *
 *   responsable pide la firma (solo nombre + email del tutor; fecha de la FICHA)
 *     → correo al tutor (su idioma) con /auth/verify-consent?token=…
 *     → el tutor confirma en la página con SU DNI + aceptaciones (botón explícito)
 *     → cuenta para el gate (findActiveParentalConsent) y le llega el correo con el enlace
 *       de RETIRADA → el tutor retira con /auth/withdraw-consent?token=… → deja de contar.
 * Más: pedir de nuevo invalida el enlace pendiente anterior; estado para la ficha
 * (consent-status, solo el dueño); casos que se niegan sin escribir nada.
 *
 * PostgREST + supabase-js + Resend simulados en memoria: SIMULACIÓN, no la base real.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/auth/__tests__/guardian-consent-e2e.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const JWT_TENANT = "44444444-4444-4444-8444-444444444444";
const auth = vi.hoisted(() => ({ userId: "11111111-1111-4111-8111-111111111111", tenantId: null as string | null }));
// Como el real: sin «Authorization: Bearer …» no hay sesión.
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn(async (req: Request) =>
    (req.headers.get("Authorization") ?? "").startsWith("Bearer ")
      ? { userId: auth.userId, email: null, tenantId: auth.tenantId, error: null }
      : { userId: null, email: null, tenantId: null, error: "No autenticado" },
  ),
}));

// ── Estado simulado ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  players: [] as Array<Record<string, unknown>>,
  consents: [] as Array<Record<string, unknown>>,
  audit: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; subject: string; html: string }>,
}));

const yearsAgo = (n: number) => `${new Date().getUTCFullYear() - n}-01-01`;

/** Filtro PostgREST (`eq.`, `is.null|true|false`, `in.("a","b")`) aplicado a v. */
function matches(filter: string, v: unknown): boolean {
  if (filter.startsWith("eq.")) return v !== null && v !== undefined && String(v) === filter.slice(3);
  if (filter === "is.null") return v === null || v === undefined;
  if (filter === "is.true") return v === true;
  if (filter === "is.false") return v === false;
  if (filter.startsWith("in.(") && filter.endsWith(")")) {
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(filter.slice(4, -1)))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
    return out.includes(String(v));
  }
  throw new Error(`filtro no simulado: ${filter}`);
}
const RESERVED = new Set(["select", "order", "limit"]);
const field = (r: Row, k: string): unknown => {
  const [col, path] = k.split("->>");
  return path === undefined ? r[col] : (r[col] as Row | null | undefined)?.[path];
};
const filterRows = (rows: Row[], params: URLSearchParams) =>
  rows.filter((r) => [...params.entries()].every(([k, f]) => RESERVED.has(k) || matches(f, field(r, k))));

// supabase-js en memoria sobre los MISMOS arrays (sign-consent / verify-consent lo usan).
vi.mock("@supabase/supabase-js", () => {
  const tableOf = (t: string) => {
    if (t === "players") return st.players;
    if (t === "parental_consents") return st.consents;
    throw new Error(`tabla inesperada ${t}`);
  };
  return {
    createClient: () => ({
      from: (t: string) => {
        const rows = tableOf(t);
        return {
          select: () => {
            const fs: Array<(r: Record<string, unknown>) => boolean> = [];
            const c = {
              eq: (k: string, v: unknown) => (fs.push((r) => r[k] === v), c),
              single: async () => {
                const hit = rows.find((r) => fs.every((f) => f(r)));
                return hit ? { data: { ...hit }, error: null } : { data: null, error: { message: "not found" } };
              },
              maybeSingle: async () => ({ data: rows.find((r) => fs.every((f) => f(r))) ?? null, error: null }),
            };
            return c;
          },
          insert: (row: Record<string, unknown>) => {
            rows.push({ email_verified: false, withdrawn_at: null, signed_at: new Date().toISOString(), ...row });
            const c = { select: () => c, single: async () => ({ data: { id: row.id }, error: null }) };
            return c;
          },
          update: (patch: Record<string, unknown>) => {
            const fs: Array<(r: Record<string, unknown>) => boolean> = [];
            const c = {
              eq: (k: string, v: unknown) => (fs.push((r) => r[k] === v), c),
              is: (k: string, v: unknown) => (fs.push((r) => (r[k] ?? null) === v), c),
              select: async () => {
                const hit = rows.filter((r) => fs.every((f) => f(r)));
                for (const r of hit) Object.assign(r, patch);
                return { data: hit.map((r) => ({ id: r.id })), error: null };
              },
            };
            return c;
          },
        };
      },
    }),
  };
});

import signConsent from "../sign-consent";
import verifyConsent from "../verify-consent";
import guardianWithdraw from "../_guardian-withdraw";
import consentStatus from "../_consent-status";
import { findActiveParentalConsent } from "../../_lib/parentalConsent";
import { sha256Hex } from "../../_lib/edgeCrypto";

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  process.env.RESEND_API_KEY = "re-key";
  process.env.VITAS_PUBLIC_URL = "https://vitas.test";
  auth.userId = OWNER;
  auth.tenantId = null;
  st.players = [
    { id: "pMinor", user_id: OWNER, tenant_id: TENANT, name: "Leo", birth_date: yearsAgo(10) },
    { id: "pNoDate", user_id: OWNER, tenant_id: TENANT, name: "Ana", birth_date: null },
    { id: "pAdult", user_id: OWNER, tenant_id: TENANT, name: "Iker", birth_date: yearsAgo(16) },
    { id: "pNoTenant", user_id: OWNER, tenant_id: null, name: "Mar", birth_date: yearsAgo(9) },
    { id: "pOther", user_id: OTHER, tenant_id: TENANT, name: "Ajeno", birth_date: yearsAgo(10) },
  ];
  st.consents = [];
  st.audit = [];
  st.emails = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input instanceof Request ? input.url : input);
    if (href === "https://api.resend.com/emails") {
      st.emails.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const table = url.pathname.replace("/rest/v1/", "");
    const rowsOf: Record<string, Row[]> = { players: st.players, parental_consents: st.consents, gdpr_audit_log: st.audit };
    const rows = rowsOf[table];
    if (!rows) throw new Error(`petición no simulada: ${method} ${href}`);
    if (method === "GET") {
      let out = filterRows(rows, url.searchParams);
      const sel = url.searchParams.get("select");
      if (sel && sel !== "*") out = out.map((r) => Object.fromEntries(sel.split(",").map((k) => [k, r[k]])));
      return Response.json(out);
    }
    if (method === "POST") {
      rows.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body)) as Row;
      for (const r of filterRows(rows, url.searchParams)) Object.assign(r, patch);
      return new Response(null, { status: 204 });
    }
    throw new Error(`método no simulado: ${method} ${href}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const json = (path: string, body: unknown, bearer = true) =>
  new Request(`https://x.test/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: "Bearer user-jwt" } : {}) },
    body: JSON.stringify(body),
  });
const requestSignature = (body: Record<string, unknown> = {}) =>
  signConsent(json("sign-consent", { playerId: "pMinor", parentName: "Marta Tutora", parentEmail: "marta@familia.test", ...body }));
const DNI = "12345678Z";
const confirm = (token: string, extra: Record<string, unknown> = {}) =>
  verifyConsent(json("verify-consent", { token, parentDni: DNI, acceptedTerms: true, acceptedPrivacy: true, ...extra }, false));
const withdraw = (token: string) => guardianWithdraw(json("guardian-withdraw", { token }, false));
const status = async (playerIds: string[]) => {
  const res = await consentStatus(json("consent-status", { playerIds }));
  return { status: res.status, body: (await res.json()) as { data: { statuses: Record<string, Record<string, unknown>> } } };
};
const linkToken = (html: string, page: "verify-consent" | "withdraw-consent") => {
  const m = new RegExp(`/auth/${page}\\?token=([0-9a-f]{64})`).exec(html);
  if (!m) throw new Error(`el correo no trae el enlace ${page}`);
  return m[1];
};

describe("consentimiento del tutor · de punta a punta", () => {
  it("pedir → confirmar (DNI + aceptación del TUTOR) → cuenta → el tutor retira con su enlace → deja de contar", async () => {
    // 1 · El responsable pide la firma (inglés): solo nombre y email; la fecha sale de la ficha.
    const req = await requestSignature({ locale: "en" });
    expect(req.status).toBe(200);
    expect((await req.json()).data).toMatchObject({ status: "pending_verification", emailSent: true });
    expect(st.consents).toHaveLength(1);
    expect(st.consents[0]).toMatchObject({ player_id: "pMinor", tenant_id: TENANT, child_birthdate: yearsAgo(10), parent_dni_hash: null, email_verified: false });
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0]).toMatchObject({ to: "marta@familia.test", subject: "VITAS · Confirm your consent as legal guardian" });
    const verifyToken = linkToken(st.emails[0].html, "verify-consent");
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "pending", guardianEmail: "marta@familia.test", guardianName: "Marta Tutora" });
    expect(await findActiveParentalConsent("pMinor")).toBeNull();

    // 2 · El tutor confirma: sin marcar las casillas o sin DNI NO vale.
    expect((await confirm(verifyToken, { acceptedTerms: false })).status).toBe(400);
    expect((await confirm(verifyToken, { parentDni: "" })).status).toBe(400);
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
    const ok = await confirm(verifyToken);
    expect(ok.status).toBe(200);
    const okData = (await ok.json()).data as { verified: boolean; withdrawToken: string; confirmationEmailSent: boolean };
    expect(okData).toMatchObject({ verified: true, confirmationEmailSent: true });
    expect(okData.withdrawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(await findActiveParentalConsent("pMinor")).toMatchObject({ id: st.consents[0].id, parentEmail: "marta@familia.test" });
    // El DNI solo hasheado, en la fila y en la evidencia; nunca en claro.
    expect(st.consents[0].parent_dni_hash).toBe(await sha256Hex(DNI));
    expect(JSON.stringify(st.consents) + JSON.stringify(st.audit)).not.toContain(DNI);
    expect(st.audit.find((a) => a.action === "consent_email_verified")!.metadata).toMatchObject({
      guardian_dni_hash: await sha256Hex(DNI), accepted_terms_version: "v1.0", accepted_privacy_version: "v1.0",
    });
    // Correo de confirmación (mismo idioma) con el enlace de RETIRADA (el mismo que ve la página).
    expect(st.emails).toHaveLength(2);
    expect(st.emails[1]).toMatchObject({ to: "marta@familia.test", subject: "VITAS · Consent confirmed" });
    const withdrawToken = linkToken(st.emails[1].html, "withdraw-consent");
    expect(withdrawToken).toBe(okData.withdrawToken);
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "verified", guardianEmail: "marta@familia.test" });

    // 3 · Un token NO vale para lo otro.
    expect((await withdraw(verifyToken)).status).toBe(404);
    expect((await confirm(withdrawToken)).status).toBe(404);
    expect(await findActiveParentalConsent("pMinor")).not.toBeNull();

    // 4 · El tutor retira con su enlace → deja de contar; reintentar es seguro.
    const w = await withdraw(withdrawToken);
    expect(w.status).toBe(200);
    expect((await w.json()).data).toEqual({ withdrawn: true });
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
    expect(st.consents[0].withdrawn_at).not.toBeNull();
    expect(st.audit.some((a) => a.action === "consent_withdrawn" && (a.metadata as Row).source === "guardian_link")).toBe(true);
    expect((await (await withdraw(withdrawToken)).json()).data).toEqual({ alreadyWithdrawn: true });
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "withdrawn" });
  });

  it("pedir de nuevo (p. ej. email mal escrito) invalida el enlace pendiente anterior; el nuevo sí vale", async () => {
    await requestSignature({ parentEmail: "equivocado@x.test" });
    const oldToken = linkToken(st.emails[0].html, "verify-consent");
    await requestSignature({ parentEmail: "marta@familia.test" });
    const newToken = linkToken(st.emails[1].html, "verify-consent");
    expect(st.consents[0]).toMatchObject({ withdrawn_at: expect.any(String) });
    expect(st.audit.some((a) => a.action === "consent_withdrawn" && (a.metadata as Row).source === "superseded")).toBe(true);
    expect((await confirm(oldToken)).status).toBe(404);
    expect((await confirm(newToken)).status).toBe(200);
    expect(await findActiveParentalConsent("pMinor")).toMatchObject({ parentEmail: "marta@familia.test" });
  });

  it("pedir otra firma NO retira un consentimiento ya verificado (sigue contando)", async () => {
    await requestSignature();
    await confirm(linkToken(st.emails[0].html, "verify-consent"));
    const active = await findActiveParentalConsent("pMinor");
    await requestSignature({ parentEmail: "otro.tutor@familia.test" });
    expect(await findActiveParentalConsent("pMinor")).toEqual(active);
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "verified" });
  });

  it("enlace sin confirmar que caduca → estado «expired»", async () => {
    await requestSignature();
    (st.audit.find((a) => a.action === "consent_token_issued")!.metadata as Row).expires_at = "2020-01-01T00:00:00.000Z";
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "expired" });
  });

  it("nombres escritos por personas van ESCAPADOS en el correo", async () => {
    await requestSignature({ parentName: "<script>alert(1)</script>" });
    expect(st.emails[0].html).not.toContain("<script>");
    expect(st.emails[0].html).toContain("&lt;script&gt;");
  });
});

describe("se niega sin escribir nada", () => {
  const nothingWritten = () => {
    expect(st.consents).toHaveLength(0);
    expect(st.audit).toHaveLength(0);
    expect(st.emails).toHaveLength(0);
  };

  it("jugador SIN fecha de nacimiento → 409 birth_date_required", async () => {
    const res = await requestSignature({ playerId: "pNoDate" });
    expect(res.status).toBe(409);
    expect((await res.json()).errorDetail.code).toBe("birth_date_required");
    nothingWritten();
  });

  it("jugador de 14 años o más → 409 consent_not_required", async () => {
    const res = await requestSignature({ playerId: "pAdult" });
    expect(res.status).toBe(409);
    expect((await res.json()).errorDetail.code).toBe("consent_not_required");
    nothingWritten();
  });

  it("jugador ajeno → 403", async () => {
    const res = await requestSignature({ playerId: "pOther" });
    expect(res.status).toBe(403);
    nothingWritten();
  });

  it("sin grupo en el jugador ni en la sesión → 409 tenant_missing; con el de la sesión → se usa ese", async () => {
    const res = await requestSignature({ playerId: "pNoTenant" });
    expect(res.status).toBe(409);
    expect((await res.json()).errorDetail.code).toBe("tenant_missing");
    nothingWritten();
    auth.tenantId = JWT_TENANT;
    expect((await requestSignature({ playerId: "pNoTenant" })).status).toBe(200);
    expect(st.consents[0]).toMatchObject({ tenant_id: JWT_TENANT });
  });

  it("el responsable ya NO puede mandar el DNI ni aceptar por el tutor (se ignora, no se guarda)", async () => {
    const res = await requestSignature({ parentDni: DNI, acceptedTerms: true, acceptedPrivacy: true });
    expect(res.status).toBe(200);
    expect(st.consents[0].parent_dni_hash).toBeNull();
    expect(JSON.stringify(st.audit)).not.toContain(await sha256Hex(DNI));
  });
});

describe("consent-status · solo el dueño", () => {
  it("los jugadores ajenos o inexistentes no aparecen; los propios sin solicitud = «none»", async () => {
    const { status: code, body } = await status(["pMinor", "pOther", "no-existe"]);
    expect(code).toBe(200);
    expect(Object.keys(body.data.statuses)).toEqual(["pMinor"]);
    expect(body.data.statuses.pMinor).toMatchObject({ state: "none" });
  });

  it("sin sesión → 401", async () => {
    const res = await consentStatus(json("consent-status", { playerIds: ["pMinor"] }, false));
    expect(res.status).toBe(401);
  });
});
