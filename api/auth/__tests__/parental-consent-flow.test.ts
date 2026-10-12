/**
 * Tests · flujo del consentimiento parental (sign-consent → email del tutor → verify-consent)
 * y su efecto en el gate de análisis de clips (hallazgo B6 de la review del PR #308).
 *
 * El consentimiento que desbloquea el análisis del vídeo de un menor de 14 CONOCIDO es el
 * que el tutor firma y verifica con el token de su email; el entrenador no puede crearlo ni
 * cambiarlo:
 *   - sign-consent guarda el HASH del token (el token en claro solo va en el email);
 *   - verify-consent busca por hash, escribe la evidencia del servidor ANTES de marcar la
 *     fila (si no puede, no marca) y marca de forma condicional;
 *   - un UPDATE de cliente sobre parental_consents (VERIFICADO posible en producción el
 *     9 oct: auth_can_update_consents = true) no desbloquea nada.
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
      const id = `c${rows.length + 1}000000-0000-4000-8000-000000000001`;
      rows.push({ id, email_verified: false, withdrawn_at: null, ...(row as Partial<Row>) } as Row);
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
    const stored = String(rows[0].verification_token);
    const res = await verify(stored.replace(/^sha256:/, ""));
    expect(res.status).toBe(404);
    expect(rows[0].email_verified).toBe(false);
    expect(ops).not.toContain("audit.insert");
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });
});

describe("verify-consent · evidencia ANTES de marcar; si falla, no marca", () => {
  it("orden: búsqueda por hash → evidencia (service_role) → UPDATE condicional", async () => {
    await sign();
    ops.length = 0;
    await verify(tokenFromEmail());
    expect(ops).toEqual(["consents.lookup", "audit.insert", "consents.update"]);
    const ev = mock.inserts.find((r) => r.resource_type === "parental_consents")!;
    expect(ev).toMatchObject({
      user_id: null,
      action: "consent_email_verified",
      resource_type: "parental_consents",
      resource_id: rows[0].id,
      metadata: { player_id: "pMinor" },
    });
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

  it("enlace caducado → 410, sin evidencia ni marcado", async () => {
    await sign();
    rows[0].verification_expires_at = "2020-01-01T00:00:00Z";
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(410);
    expect(ops).not.toContain("audit.insert");
    expect(rows[0].email_verified).toBe(false);
  });

  it("consentimiento retirado → 404 invalid_token, sin evidencia", async () => {
    await sign();
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

  it("error de la base al buscar el token → 500 (no 404: no se confunde con un enlace inválido)", async () => {
    await sign();
    failLookup = true;
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(500);
    expect(ops).not.toContain("audit.insert");
  });

  it("error al marcar → 500; la evidencia sola NO desbloquea (la fila sigue pendiente)", async () => {
    await sign();
    failUpdate = true;
    const res = await verify(tokenFromEmail());
    expect(res.status).toBe(500);
    expect(rows[0].email_verified).toBe(false);
    expect(await gate()).toMatchObject({ allowed: false, code: "parental_consent_required" });
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
