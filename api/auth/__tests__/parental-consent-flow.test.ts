/**
 * Tests · flujo del consentimiento parental (sign-consent → email del tutor → verify-consent)
 * y su efecto en el gate de análisis de clips (hallazgo B6 de la review del PR #308).
 *
 * El consentimiento que desbloquea el análisis del vídeo de un menor de 14 CONOCIDO es el
 * que el tutor firma y verifica con el token de su email; el entrenador no puede crearlo ni
 * cambiarlo:
 *   - sign-consent escribe la EMISIÓN del enlace (gdpr_audit_log 'consent_token_issued',
 *     service_role: id de la fila, jugador, email del tutor, hash del token y caducidad) ANTES
 *     de la fila, y guarda solo el HASH del token (el token en claro solo va en el email);
 *   - verify-consent busca el token en ESA emisión (no en la fila), exige que la fila siga
 *     siendo la firmada, escribe la evidencia ANTES de marcar (si no puede, no marca) y marca
 *     de forma condicional;
 *   - un UPDATE de cliente sobre parental_consents (posible antes de la 075/076; el PR registra
 *     que la previa del dueño del 9 oct dio auth_can_update_consents = true) no desbloquea nada:
 *     ni marcar la fila, ni reescribir el hash del token y su caducidad, ni reapuntar el
 *     jugador o el email (ronda 5: los tres últimos SÍ desbloqueaban con el código de la ronda 4).
 *
 * Run: npx vitest run --config vitest.api.config.ts api/auth/__tests__/parental-consent-flow.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
const ownsPlayerMock = vi.fn(async (_playerId: string, _userId: string | null) => true);
vi.mock("../../_lib/ownership", async (orig) => ({
  ...(await orig<typeof import("../../_lib/ownership")>()),
  ownsPlayer: (playerId: string, userId: string | null) => ownsPlayerMock(playerId, userId),
}));

// ── supabase-js en memoria sobre las MISMAS filas que ve el REST del gate (consentFetch) ──
type Row = {
  id: string;
  player_id: string;
  tenant_id: string | null;
  email_verified: boolean;
  email_verified_at?: string | null;
  withdrawn_at: string | null;
  parent_email?: string | null;
  verification_token?: string | null;
  verification_expires_at?: string | null;
};
let rows: Row[] = [];
const ops: string[] = [];
let failLookup = false;
let failUpdate = false;
let raceUpdate = false;

function consentsTable() {
  return {
    insert: (row: Record<string, unknown>) => {
      // sign-consent pone el id (ronda 5: lo liga antes en la emisión); si no, uno del mock.
      const id = typeof row.id === "string" ? row.id : `c${rows.length + 1}000000-0000-4000-8000-000000000001`;
      rows.push({ email_verified: false, withdrawn_at: null, ...(row as Partial<Row>), id } as Row);
      ops.push("consents.insert");
      const c = { select: () => c, single: async () => ({ data: { id }, error: null }) };
      return c;
    },
    select: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const c = {
        eq: (col: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[col] === v), c),
        maybeSingle: async () => {
          ops.push("consents.lookup");
          if (failLookup) return { data: null, error: { message: "boom" } };
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          return { data: hit[0] ? { ...hit[0] } : null, error: null };
        },
      };
      return c;
    },
    update: (patch: Partial<Row>) => {
      const filters: Array<(r: Row) => boolean> = [];
      const c = {
        eq: (col: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[col] === v), c),
        is: (col: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[col] === v), c),
        select: async () => {
          ops.push("consents.update");
          if (failUpdate) return { data: null, error: { message: "boom" } };
          if (raceUpdate) return { data: [], error: null };
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, patch);
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        },
      };
      return c;
    },
  };
}

const clientUrls: string[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string) => (clientUrls.push(url), {
    from: (table: string) => {
      if (table === "parental_consents") return consentsTable();
      if (table === "players") {
        const c = { select: () => c, eq: () => c, single: async () => ({ data: { tenant_id: TENANT, name: "Menor" }, error: null }) };
        return c;
      }
      if (table === "legal_acceptances") return { insert: async () => ({ error: null }) };
      throw new Error(`tabla inesperada ${table}`);
    },
  }),
}));

let signConsent: (req: Request) => Promise<Response>;
let verifyConsent: (req: Request) => Promise<Response>;
let enforceClipConsent: typeof import("../../_lib/analysisConsentGate").enforceClipConsent;
let hashConsentToken: typeof import("../../_lib/parentalConsent").hashConsentToken;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
let emails: Array<{ to: string[]; html: string }>;

beforeAll(async () => {
  process.env.VITE_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  process.env.RESEND_API_KEY = "re-key";
  process.env.VITAS_PUBLIC_URL = "https://vitas.test";
  signConsent = (await import("../sign-consent")).default;
  verifyConsent = (await import("../verify-consent")).default;
  ({ enforceClipConsent } = await import("../../_lib/analysisConsentGate"));
  ({ hashConsentToken } = await import("../../_lib/parentalConsent"));
});

beforeEach(() => {
  rows = [];
  ops.length = 0;
  failLookup = false;
  failUpdate = false;
  raceUpdate = false;
  ownsPlayerMock.mockImplementation(async () => true);
  emails = [];
  db = emptyConsentDb();
  db.birthDates.pMinor = MINOR_BIRTH_DATE;
  // Las filas de parental_consents que ve el REST del gate SON las de supabase-js (mismo array).
  Object.defineProperty(db, "consentRows", { get: () => rows, configurable: true });
  mock = consentFetch(db, {
    fallback: async (url, init) => {
      if (url === "https://api.resend.com/emails") {
        emails.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rest/v1/gdpr_audit_log") && (init?.method ?? "GET").toUpperCase() === "POST") ops.push("audit.insert");
    return mock.fn(input, init);
  });
});
afterEach(() => vi.unstubAllGlobals());

const sign = (body: Record<string, unknown> = {}) =>
  signConsent(
    new Request("https://x.test/api/auth/sign-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({
        playerId: "pMinor",
        parentName: "Tutor Legal",
        parentEmail: "tutor@familia.test",
        parentDni: "12345678Z",
        childBirthdate: MINOR_BIRTH_DATE,
        acceptedTerms: true,
        acceptedPrivacy: true,
        ...body,
      }),
    }),
  );
const verify = (token: string) =>
  verifyConsent(
    new Request("https://x.test/api/auth/verify-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
const tokenFromEmail = () => {
  const m = /verify-consent\?token=([0-9a-f]+)/.exec(emails[0]?.html ?? "");
  if (!m) throw new Error("el email no trae el enlace con el token");
  return m[1];
};
const gate = () =>
  enforceClipConsent({
    attestation: ATTESTATION,
    resource: { type: "videos", id: "vid-1" },
    playerId: "pMinor",
    actor: { userId: USER, tenantId: TENANT },
    endpoint: "test",
    record: false,
  });

describe("sign-consent · el token del email se guarda HASHEADO", () => {
  it("la fila guarda sha256(token); el token en claro solo va en el email del tutor", async () => {
    const res = await sign();
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    const raw = tokenFromEmail();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].verification_token).toBe(await hashConsentToken(raw));
    expect(rows[0].verification_token).not.toContain(raw);
    expect(rows[0]).toMatchObject({ player_id: "pMinor", tenant_id: TENANT, email_verified: false });
    // La respuesta no devuelve el token (ni en claro ni hasheado).
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(raw);
    expect(text).not.toContain("sha256:");
  });

  it("control: quien no es dueño del jugador → 403 y no se crea nada", async () => {
    ownsPlayerMock.mockImplementation(async () => false);
    const res = await sign();
    expect(res.status).toBe(403);
    expect(rows).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it("ronda 5 · la EMISIÓN del enlace (service_role) se escribe ANTES de la fila, con el id de la fila, el jugador, el email, el hash y la caducidad", async () => {
    const res = await sign({ parentEmail: "Tutor@Familia.test" });
    expect(res.status).toBe(200);
    expect(ops).toEqual(["audit.insert", "consents.insert"]);
    const issued = mock.inserts.find((r) => r.action === "consent_token_issued")!;
    expect(issued).toMatchObject({
      user_id: USER,
      tenant_id: TENANT,
      resource_type: "parental_consents",
      resource_id: rows[0].id,
      metadata: {
        player_id: "pMinor",
        parent_email: "tutor@familia.test",
        token_hash: await hashConsentToken(tokenFromEmail()),
      },
    });
    expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Date.parse(String((issued.metadata as Record<string, unknown>).expires_at))).toBeGreaterThan(Date.now());
    expect((await res.json()).data.consentId).toBe(rows[0].id);
  });

  it("ronda 5 · si la emisión no se puede escribir → 500, sin fila y sin email", async () => {
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    const res = await sign();
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("consent_save_failed");
    expect(rows).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});

describe("B6 · solo el tutor (token del email) desbloquea el análisis del menor", () => {
  it("pendiente → 403; el entrenador marca la fila como verificada (UPDATE de cliente) → sigue 403; el tutor verifica → permitido", async () => {
    await sign();
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });

    // Lo que permite hoy la base (VERIFICADO en producción: authenticated puede UPDATE):
    rows[0].email_verified = true;
    rows[0].email_verified_at = new Date().toISOString();
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });
    rows[0].email_verified = false;
    rows[0].email_verified_at = null;

    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ verified: true, playerId: "pMinor" });
    expect(await gate()).toMatchObject({ allowed: true, minor: "minor" });
  });

  it("el HASH guardado (lo que podría leer un cliente de la fila) no sirve como token", async () => {
    await sign();
    ops.length = 0;
    const stored = String(rows[0].verification_token);
    const res = await verify(stored.replace(/^sha256:/, ""));
    expect(res.status).toBe(404);
    expect(rows[0].email_verified).toBe(false);
    expect(ops).not.toContain("audit.insert");
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });
});

// Ronda 5 de la review del PR #308: B6 NO estaba cerrado. verify-consent buscaba la fila por
// `parental_consents.verification_token` y escribía la evidencia con el `player_id` de la propia
// fila: dos columnas que un cliente puede cambiar (UPDATE, antes de la 075/076). Reproducido
// por el revisor en una SIMULACIÓN PGlite (no la base real). Ahora el token queda ligado EN EL
// SERVIDOR al emitirse (gdpr_audit_log 'consent_token_issued', service_role) y el jugador y el
// email del tutor salen de esa fila, no de la fila mutable.
describe("ronda 5 · B6: el token y el jugador los liga el SERVIDOR al emitir el enlace", () => {
  const gateFor = (playerId: string) =>
    enforceClipConsent({
      attestation: ATTESTATION,
      resource: { type: "videos", id: "vid-1" },
      playerId,
      actor: { userId: USER, tenantId: TENANT },
      endpoint: "test",
      record: false,
    });

  it("un cliente reescribe el hash del token (y la caducidad) de la fila PENDIENTE de un menor ajeno → verify con SU token = 404; sin evidencia; sigue bloqueado", async () => {
    await sign(); // el dueño de pMinor firma; el token real solo lo tiene el tutor
    const X = "f".repeat(64);
    // Lo que permite un UPDATE de cliente antes de la 075/076 (simulación del revisor: 1 fila):
    rows[0].verification_token = await hashConsentToken(X);
    rows[0].verification_expires_at = new Date(Date.now() + 86_400_000).toISOString();
    ops.length = 0;
    const res = await verify(X);
    expect(res.status).toBe(404);
    expect(ops).not.toContain("audit.insert");
    expect(ops).not.toContain("consents.update");
    expect(rows[0].email_verified).toBe(false);
    expect(await gateFor("pMinor")).toMatchObject({ allowed: false, code: "parental_consent_required" });
    // Control positivo: el enlace REAL del tutor sigue funcionando (el token lo liga el servidor, no la columna).
    expect((await verify(tokenFromEmail())).status).toBe(200);
    expect(await gateFor("pMinor")).toMatchObject({ allowed: true, minor: "minor" });
  });

  it("variante: el cliente REAPUNTA su propia fila pendiente (email del tutor elegido por él) a un menor AJENO → verify = 409; sin evidencia; el menor ajeno sigue bloqueado", async () => {
    db.birthDates.pMinor2 = MINOR_BIRTH_DATE;
    await sign({ playerId: "pOwnB", parentEmail: "atacante@x.test" }); // su propio jugador: sign-consent lo permite
    const token = tokenFromEmail(); // le llega a SU buzón (límite conocido §E: prueba un buzón, no la tutela)
    rows[0].player_id = "pMinor2"; // UPDATE de cliente
    ops.length = 0;
    const res = await verify(token);
    expect(res.status).toBe(409);
    expect((await res.json()).errorDetail.code).toBe("consent_changed");
    expect(ops).not.toContain("audit.insert");
    expect(rows[0].email_verified).toBe(false);
    expect(await gateFor("pMinor2")).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("variante: reapuntar DESPUÉS de verificar tampoco sirve (la evidencia es del jugador que se firmó)", async () => {
    db.birthDates.pMinor2 = MINOR_BIRTH_DATE;
    await sign({ playerId: "pOwnB", parentEmail: "atacante@x.test" });
    expect((await verify(tokenFromEmail())).status).toBe(200);
    rows[0].player_id = "pMinor2";
    expect(await gateFor("pMinor2")).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("el email del tutor para el orquestador sale de lo que ligó el servidor, no de la fila (un UPDATE de parent_email no lo cambia)", async () => {
    await sign();
    expect((await verify(tokenFromEmail())).status).toBe(200);
    rows[0].parent_email = "atacante@x.test"; // UPDATE de cliente tras verificar
    const { findActiveParentalConsent } = await import("../../_lib/parentalConsent");
    expect(await findActiveParentalConsent("pMinor")).toMatchObject({ parentEmail: "tutor@familia.test" });
  });

  it("alargar la caducidad en la fila no alarga el enlace: manda la que guardó el servidor → 410", async () => {
    await sign();
    const issued = mock.inserts.find((r) => r.action === "consent_token_issued")!;
    (issued.metadata as Record<string, unknown>).expires_at = "2020-01-01T00:00:00.000Z"; // caducó
    rows[0].verification_expires_at = new Date(Date.now() + 86_400_000).toISOString(); // UPDATE de cliente
    ops.length = 0;
    expect((await verify(tokenFromEmail())).status).toBe(410);
    expect(ops).not.toContain("audit.insert");
  });

  it("evidencia 'consent_email_verified' SIN la emisión del servidor (p. ej. escrita por el verify-consent anterior) → no cuenta", async () => {
    rows.push({ id: "legacy-2", player_id: "pMinor", tenant_id: TENANT, email_verified: true, withdrawn_at: null, parent_email: "t@x.test" });
    db.consentAudit = [{ action: "consent_email_verified", resource_id: "legacy-2", metadata: { player_id: "pMinor" } }];
    expect(await gateFor("pMinor")).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });
});

describe("verify-consent · evidencia ANTES de marcar; si falla, no marca", () => {
  it("orden: emisión por hash → fila por id → evidencia (service_role) → UPDATE condicional", async () => {
    await sign();
    const token = tokenFromEmail();
    ops.length = 0;
    await verify(token);
    expect(ops).toEqual(["consents.lookup", "audit.insert", "consents.update"]);
    const ev = mock.inserts.find((r) => r.action === "consent_email_verified")!;
    expect(ev).toEqual({
      user_id: null,
      tenant_id: TENANT,
      action: "consent_email_verified",
      resource_type: "parental_consents",
      resource_id: rows[0].id,
      metadata: { player_id: "pMinor", parent_email: "tutor@familia.test", token_hash: await hashConsentToken(token) },
    });
    // La emisión se buscó por el hash del token (no la columna de la fila).
    const lookup = mock.calls.find((c) => decodeURIComponent(c.url).includes("metadata->>token_hash=eq."))!;
    expect(decodeURIComponent(lookup.url)).toContain(`action=eq.consent_token_issued`);
    expect(decodeURIComponent(lookup.url)).toContain(`metadata->>token_hash=eq.${await hashConsentToken(token)}`);
    expect(rows[0]).toMatchObject({ email_verified: true, verification_token: null, verification_expires_at: null });
  });

  it("no se puede escribir la evidencia → 500, la fila NO se marca y el MISMO enlace sirve para reintentar", async () => {
    await sign();
    const token = tokenFromEmail();
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    const res = await verify(token);
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("verify_failed");
    expect(rows[0].email_verified).toBe(false);
    expect(ops).not.toContain("consents.update");

    delete db.failures.gdpr_insert;
    expect((await verify(token)).status).toBe(200);
    expect(await gate()).toMatchObject({ allowed: true });
  });

  it("enlace caducado (caducidad de la EMISIÓN) → 410, sin evidencia ni marcado", async () => {
    await sign();
    const issued = mock.inserts.find((r) => r.action === "consent_token_issued")!;
    (issued.metadata as Record<string, unknown>).expires_at = "2020-01-01T00:00:00Z";
    ops.length = 0;
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(410);
    expect(ops).not.toContain("audit.insert");
    expect(rows[0].email_verified).toBe(false);
  });

  it("consentimiento retirado → 404 invalid_token, sin evidencia", async () => {
    await sign();
    ops.length = 0;
    rows[0].withdrawn_at = "2026-10-01T00:00:00Z";
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(404);
    expect(ops).not.toContain("audit.insert");
  });

  it("fila ANTIGUA con el token en claro (antes de este cambio) → 404: el enlace deja de valer (cambio declarado)", async () => {
    const raw = "ab".repeat(32);
    rows.push({ id: "legacy-1", player_id: "pMinor", tenant_id: TENANT, email_verified: false, withdrawn_at: null, verification_token: raw });
    const res = await verify(raw);
    expect(res.status).toBe(404);
    expect(rows[0].email_verified).toBe(false);
  });

  it("error de la base al buscar la emisión del token → 500 (no 404: no se confunde con un enlace inválido)", async () => {
    await sign();
    ops.length = 0;
    db.failures.gdpr_audit_log = { status: 500, body: "boom" };
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(500);
    expect(ops).not.toContain("audit.insert");
    expect(ops).not.toContain("consents.lookup");
  });

  it("error de la base al leer la fila → 500, sin evidencia", async () => {
    await sign();
    ops.length = 0;
    failLookup = true;
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(500);
    expect(ops).not.toContain("audit.insert");
  });

  it("error al marcar → 500; la evidencia sola NO desbloquea; reintentar con el MISMO enlace marca sin duplicar la evidencia", async () => {
    await sign();
    const token = tokenFromEmail();
    failUpdate = true;
    const res = await verify(token);
    expect(res.status).toBe(500);
    expect(rows[0].email_verified).toBe(false);
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });

    failUpdate = false;
    const retry = await verify(token);
    expect(retry.status).toBe(200);
    expect((await retry.json()).data).toMatchObject({ alreadyVerified: true });
    expect(mock.inserts.filter((r) => r.action === "consent_email_verified")).toHaveLength(1);
    expect(rows[0].email_verified).toBe(true);
    expect(await gate()).toMatchObject({ allowed: true });
  });

  it("sign/verify usan el MISMO proyecto que la evidencia y el gate (SUPABASE_URL antes que VITE_SUPABASE_URL)", async () => {
    process.env.VITE_SUPABASE_URL = "https://otro-proyecto.test";
    try {
      clientUrls.length = 0;
      await sign();
      await verify(tokenFromEmail());
      expect(clientUrls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(clientUrls)).toEqual(new Set(["https://sb.test"]));
      // La evidencia (REST de parentalConsent) fue al mismo https://sb.test.
      expect(mock.inserts.some((r) => r.resource_type === "parental_consents")).toBe(true);
    } finally {
      process.env.VITE_SUPABASE_URL = "https://sb.test";
    }
  });

  it("carrera (otro clic la marcó entre la lectura y el UPDATE) → 200 alreadyVerified", async () => {
    await sign();
    raceUpdate = true;
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ alreadyVerified: true });
  });
});
