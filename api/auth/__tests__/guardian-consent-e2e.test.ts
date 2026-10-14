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
  /**
   * Carrera simulada: la fila con este id pasa a VERIFICADA justo en el punto de decisión de la
   * sustitución — DESPUÉS de leer las pendientes (código que lee y luego escribe) o JUSTO ANTES de un
   * PATCH condicional (código atómico).
   */
  raceVerifyId: null as string | null,
  /** Carrera simulada: la fila con este id queda RETIRADA justo antes del UPDATE de verify-consent. */
  raceWithdrawId: null as string | null,
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
                // Carrera: el responsable retira JUSTO entre la lectura de verify-consent y su UPDATE.
                if (st.raceWithdrawId && t === "parental_consents") {
                  Object.assign(rows.find((r) => r.id === st.raceWithdrawId)!, { withdrawn_at: new Date().toISOString() });
                  st.raceWithdrawId = null;
                }
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
  st.raceVerifyId = null;
  st.raceWithdrawId = null;
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
    // Como PostgREST: `select` proyecta, `order=col.desc|asc` ordena y `limit` recorta.
    const project = (out: Row[]) => {
      const sel = url.searchParams.get("select");
      return sel && sel !== "*" ? out.map((r) => Object.fromEntries(sel.split(",").map((k) => [k, r[k]]))) : out;
    };
    if (method === "GET") {
      let out = filterRows(rows, url.searchParams);
      const order = url.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1));
      }
      const limit = Number(url.searchParams.get("limit"));
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      const body = project(out);
      // Carrera: el tutor confirma justo DESPUÉS de que la sustitución lea las pendientes.
      if (st.raceVerifyId && table === "parental_consents" && url.searchParams.get("email_verified") === "is.false") {
        Object.assign(rows.find((r) => r.id === st.raceVerifyId)!, { email_verified: true });
        st.raceVerifyId = null;
      }
      return Response.json(body);
    }
    if (method === "POST") {
      rows.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      // Carrera (código atómico): el tutor confirma justo ANTES del PATCH condicional.
      if (st.raceVerifyId && table === "parental_consents") {
        Object.assign(rows.find((r) => r.id === st.raceVerifyId)!, { email_verified: true });
        st.raceVerifyId = null;
      }
      const patch = JSON.parse(String(init?.body)) as Row;
      const hit = filterRows(rows, url.searchParams);
      for (const r of hit) Object.assign(r, patch);
      // `Prefer: return=representation` ⇒ devuelve las filas cambiadas.
      const prefer = String((init?.headers as Record<string, string> | undefined)?.Prefer ?? "");
      return prefer.includes("return=representation") ? Response.json(project(hit)) : new Response(null, { status: 204 });
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
  // El código va tras «#» (el fragmento no viaja a ningún servidor).
  const m = new RegExp(`/auth/${page}[?#]token=([0-9a-f]{64})`).exec(html);
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
      guardian_dni_provided: true, accepted_terms_version: "v1.0", accepted_privacy_version: "v1.0",
    });
    // El hash del DNI NO va a gdpr_audit_log (de solo añadir, no se borra con el jugador).
    expect(JSON.stringify(st.audit)).not.toContain(await sha256Hex(DNI));
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

describe("revisión del PR #314", () => {
  const pendingRow = (i: number) => ({
    id: `9${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
    player_id: "pMinor", tenant_id: TENANT, parent_email: `x${i}@x.test`, parent_name: "X",
    email_verified: false, withdrawn_at: null, signed_at: new Date(Date.now() - 86_400_000 - i * 1000).toISOString(),
  });

  it("A · con ≥50 solicitudes pendientes el enlace del TUTOR sigue retirando su consentimiento (antes 500 y seguía contando)", async () => {
    await requestSignature();
    await confirm(linkToken(st.emails[0].html, "verify-consent"));
    const withdrawToken = linkToken(st.emails[1].html, "withdraw-consent");
    for (let i = 0; i < 55; i++) st.consents.push(pendingRow(i)); // p. ej. creadas en paralelo
    const res = await withdraw(withdrawToken);
    expect(res.status).toBe(200);
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
    // Solo SU consentimiento: las pendientes no se tocan.
    expect(st.consents.filter((c) => c.withdrawn_at).map((c) => c.id)).toEqual([st.consents[0].id]);
  });

  it("C · el estado no se queda en «no disponible» tras muchas solicitudes", async () => {
    for (let i = 0; i < 60; i++) st.consents.push({ ...pendingRow(i), withdrawn_at: new Date().toISOString() });
    await requestSignature();
    expect((await status(["pMinor"])).body.data.statuses.pMinor).toMatchObject({ state: "pending", guardianEmail: "marta@familia.test" });
  });

  it("D · pedir de nuevo NO marca como sustituido un consentimiento que el tutor confirmó entretanto", async () => {
    await requestSignature();
    const first = st.consents[0];
    // El tutor confirma EN MEDIO de la nueva solicitud (entre su lectura y su escritura).
    st.raceVerifyId = first.id as string;
    await requestSignature({ parentEmail: "otro@familia.test" });
    expect(first.email_verified).toBe(true); // la carrera ocurrió
    expect(first.withdrawn_at ?? null).toBeNull();
    expect(st.audit.some((a) => a.action === "consent_withdrawn" && a.resource_id === first.id)).toBe(false);
  });

  it("una retirada registrada (aunque su PATCH fallara) ⇒ confirmar responde que el enlace no vale, no «confirmado»", async () => {
    await requestSignature();
    const token = linkToken(st.emails[0].html, "verify-consent");
    st.audit.push({ action: "consent_withdrawn", resource_type: "parental_consents", resource_id: st.consents[0].id, metadata: { player_id: "pMinor", source: "owner_revoke" } });
    expect((await confirm(token)).status).toBe(404);
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
  });
});

describe("revisión 2 del PR #314", () => {
  const withdrawIssuances = () => st.audit.filter((a) => a.action === "consent_withdraw_token_issued");

  it("confirmar otra vez uno ya confirmado da un enlace de retirada NUEVO que funciona, sin repetir el correo", async () => {
    await requestSignature();
    const verifyToken = linkToken(st.emails[0].html, "verify-consent");
    const first = (await (await confirm(verifyToken)).json()).data as { withdrawToken: string };
    expect(st.emails).toHaveLength(2);

    const again = await confirm(verifyToken);
    expect(again.status).toBe(200);
    const data = (await again.json()).data as { alreadyVerified: boolean; withdrawToken: string; confirmationEmailSent: boolean };
    expect(data).toMatchObject({ alreadyVerified: true, confirmationEmailSent: false });
    expect(data.withdrawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(data.withdrawToken).not.toBe(first.withdrawToken);
    expect(st.emails).toHaveLength(2); // ya se le mandó uno: no se repite
    expect(withdrawIssuances()).toHaveLength(2);
    // Una sola evidencia de verificación (no se duplica al confirmar otra vez).
    expect(st.audit.filter((a) => a.action === "consent_email_verified")).toHaveLength(1);

    // El enlace nuevo retira; el anterior, después, responde «ya retirado».
    expect((await (await withdraw(data.withdrawToken)).json()).data).toEqual({ withdrawn: true });
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
    expect((await (await withdraw(first.withdrawToken)).json()).data).toEqual({ alreadyWithdrawn: true });
  });

  it("si la primera vez NO se emitió el enlace de retirada, al confirmar otra vez sí llega el correo con él", async () => {
    await requestSignature();
    const verifyToken = linkToken(st.emails[0].html, "verify-consent");
    await confirm(verifyToken);
    // Como si la emisión del enlace de retirada (y su correo) hubiera fallado la primera vez.
    st.audit = st.audit.filter((a) => a.action !== "consent_withdraw_token_issued");
    st.emails = st.emails.slice(0, 1);

    const data = (await (await confirm(verifyToken)).json()).data as { alreadyVerified: boolean; withdrawToken: string; confirmationEmailSent: boolean };
    expect(data).toMatchObject({ alreadyVerified: true, confirmationEmailSent: true });
    expect(st.emails).toHaveLength(2);
    expect(st.emails[1]).toMatchObject({ to: "marta@familia.test" });
    expect(linkToken(st.emails[1].html, "withdraw-consent")).toBe(data.withdrawToken);
    expect((await withdraw(data.withdrawToken)).status).toBe(200);
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
  });

  it("retirado entre la lectura y el UPDATE de verify-consent ⇒ 404 (enlace no válido), sin «confirmado» ni enlace de retirada", async () => {
    await requestSignature();
    const token = linkToken(st.emails[0].html, "verify-consent");
    st.raceWithdrawId = st.consents[0].id as string;
    const res = await confirm(token);
    expect(st.consents[0].withdrawn_at).not.toBeNull(); // la carrera ocurrió
    expect(res.status).toBe(404);
    expect((await res.json()).errorDetail).toMatchObject({ code: "invalid_token" });
    expect(st.consents[0].email_verified).toBe(false);
    expect(withdrawIssuances()).toHaveLength(0);
    expect(st.emails).toHaveLength(1);
    expect(await findActiveParentalConsent("pMinor")).toBeNull();
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
