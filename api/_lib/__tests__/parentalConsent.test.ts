/**
 * Tests · api/_lib/parentalConsent — fuente canónica ÚNICA del consentimiento parental
 * (hallazgo B6 de la review del PR #308). Cuenta SOLO una fila verificada y no retirada
 * CON la evidencia que escribe verify-consent (service_role) cuando el tutor usa el token
 * de su email. Un UPDATE del cliente sobre parental_consents (posible mientras la 075 no
 * esté aplicada: VERIFICADO en producción el 9 oct, auth_can_update_consents = true) no
 * crea esa evidencia.
 * Run: npx vitest run --config vitest.api.config.ts api/_lib/__tests__/parentalConsent.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CONSENT_TOKEN_HASH_PREFIX,
  ParentalConsentDbError,
  findActiveParentalConsent,
  hashConsentToken,
  recordParentalConsentVerified,
} from "../parentalConsent";
import { consentFetch, emptyConsentDb, type ConsentDbState } from "./consentFetchMock";

let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  db = emptyConsentDb();
  mock = consentFetch(db);
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const C1 = "c1000000-0000-4000-8000-000000000001";
const C2 = "c2000000-0000-4000-8000-000000000002";
const verifiedRow = (id: string, playerId: string, extra: Record<string, unknown> = {}) => ({
  id,
  player_id: playerId,
  email_verified: true,
  withdrawn_at: null,
  parent_email: `tutor@${id}.test`,
  ...extra,
});
const evidence = (id: string, playerId: string) => ({ action: "consent_email_verified", resource_id: id, metadata: { player_id: playerId } });

describe("findActiveParentalConsent · qué cuenta", () => {
  it("fila verificada + evidencia del servidor (verify-consent) → cuenta; lee con service_role y el predicado canónico", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [evidence(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toEqual({ id: C1, parentEmail: `tutor@${C1}.test` });

    const q = mock.calls.find((c) => c.url.includes("/rest/v1/parental_consents"))!;
    expect(q.url).toContain("player_id=eq.p1");
    expect(q.url).toContain("email_verified=is.true");
    expect(q.url).toContain("withdrawn_at=is.null");
    expect((q.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
    const a = decodeURIComponent(mock.calls.find((c) => c.url.includes("/rest/v1/gdpr_audit_log"))!.url);
    expect(a).toContain('action=in.("consent_email_verified","consent_withdrawn")');
    expect(a).toContain("resource_type=eq.parental_consents");
    expect(a).toContain(`resource_id=in.("${C1}")`);
  });

  it("B6 · fila marcada como verificada por un CLIENTE (UPDATE email_verified=true, sin evidencia) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("B6 · fila verificada de OTRO jugador reapuntada a este (evidencia con otro player_id) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [evidence(C1, "pOtro")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("evidencia SIN player_id en metadata → NO cuenta (no se puede ligar al jugador)", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [{ action: "consent_email_verified", resource_id: C1, metadata: null }];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("retirada auditada (trigger 003 'consent_withdrawn') aunque withdrawn_at vuelva a NULL → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [evidence(C1, "p1"), { action: "consent_withdrawn", resource_id: C1, metadata: { reason: "x" } }];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("withdrawn_at puesto → NO cuenta (filtro de la consulta)", async () => {
    db.consentRows = [verifiedRow(C1, "p1", { withdrawn_at: "2026-10-01T00:00:00Z" })];
    db.consentAudit = [evidence(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("pendiente (email_verified=false) aunque exista evidencia → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1", { email_verified: false })];
    db.consentAudit = [evidence(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("una fila falsificada y otra verificada de verdad → cuenta la verdadera", async () => {
    db.consentRows = [verifiedRow(C1, "p1"), verifiedRow(C2, "p1")];
    db.consentAudit = [evidence(C2, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toMatchObject({ id: C2 });
  });

  it("sin filas → null y NO se consulta gdpr_audit_log", async () => {
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
    expect(mock.calls.some((c) => c.url.includes("/gdpr_audit_log"))).toBe(false);
  });
});

describe("findActiveParentalConsent · falla cerrado (lanza; nunca «concedido»)", () => {
  it.each(["parental_consents", "gdpr_audit_log"])("error de %s → ParentalConsentDbError", async (table) => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [evidence(C1, "p1")];
    db.failures[table] = { status: 500, body: "boom" };
    await expect(findActiveParentalConsent("p1")).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("sin Supabase configurado → lanza", async () => {
    delete process.env.SUPABASE_URL;
    await expect(findActiveParentalConsent("p1")).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("respuesta que no es una lista → lanza", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: C1 }), { status: 200 })));
    await expect(findActiveParentalConsent("p1")).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("demasiadas filas (no se ven todas) → lanza", async () => {
    db.consentRows = Array.from({ length: 50 }, (_, i) => verifiedRow(`c${i}`, "p1"));
    await expect(findActiveParentalConsent("p1")).rejects.toBeInstanceOf(ParentalConsentDbError);
  });
});

describe("token del email y evidencia", () => {
  it("hashConsentToken: 'sha256:' + 64 hex, determinista y distinto del token", async () => {
    const raw = "ab".repeat(32);
    const h = await hashConsentToken(raw);
    expect(h.startsWith(CONSENT_TOKEN_HASH_PREFIX)).toBe(true);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(await hashConsentToken(raw));
    expect(h).not.toContain(raw);
  });

  it("recordParentalConsentVerified: fila append-only con service_role (sin usuario, jugador en metadata)", async () => {
    await recordParentalConsentVerified({ consentId: C1, playerId: "p1", tenantId: "22222222-2222-4222-8222-222222222222" });
    expect(mock.inserts).toEqual([
      {
        user_id: null,
        tenant_id: "22222222-2222-4222-8222-222222222222",
        action: "consent_email_verified",
        resource_type: "parental_consents",
        resource_id: C1,
        metadata: { player_id: "p1" },
      },
    ]);
    const post = mock.calls.find((c) => c.init.method === "POST")!;
    expect((post.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
  });

  it("recordParentalConsentVerified: tenant que no es uuid → null (un INSERT roto no puede bloquear)", async () => {
    await recordParentalConsentVerified({ consentId: C1, playerId: "p1", tenantId: "no-uuid" });
    expect(mock.inserts[0]).toMatchObject({ tenant_id: null });
  });

  it("recordParentalConsentVerified: si la base rechaza el INSERT → lanza", async () => {
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    await expect(recordParentalConsentVerified({ consentId: C1, playerId: "p1", tenantId: null })).rejects.toBeInstanceOf(
      ParentalConsentDbError,
    );
  });

  it("evidencia escrita por recordParentalConsentVerified → findActiveParentalConsent la reconoce (mismo contrato)", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
    await recordParentalConsentVerified({ consentId: C1, playerId: "p1", tenantId: null });
    await expect(findActiveParentalConsent("p1")).resolves.toMatchObject({ id: C1 });
  });
});
