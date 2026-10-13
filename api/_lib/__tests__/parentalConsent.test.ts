/**
 * Tests · api/_lib/parentalConsent — fuente canónica ÚNICA del consentimiento parental
 * (hallazgo B6 de la review del PR #308). Cuenta SOLO una fila verificada y no retirada CON
 * la emisión del enlace que escribe sign-consent ('consent_token_issued', service_role) y la
 * verificación que escribe verify-consent ('consent_email_verified') con el MISMO token y el
 * MISMO jugador. Ronda 5: la regla de la ronda 4 (solo la verificación) contaba evidencias
 * escritas por el servidor con el jugador y el token que un cliente había puesto en la fila
 * (UPDATE, antes de la 075/076); ahora jugador, email y token salen de la emisión.
 * Run: npx vitest run --config vitest.api.config.ts api/_lib/__tests__/parentalConsent.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CONSENT_TOKEN_HASH_PREFIX,
  ParentalConsentDbError,
  findActiveParentalConsent,
  findIssuedConsentToken,
  hasConsentVerification,
  hashConsentToken,
  recordConsentTokenIssued,
  recordParentalConsentVerified,
  type IssuedConsentToken,
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
const TENANT = "22222222-2222-4222-8222-222222222222";
const H1 = `sha256:${"1".repeat(64)}`;
const H2 = `sha256:${"2".repeat(64)}`;
const verifiedRow = (id: string, playerId: string, extra: Record<string, unknown> = {}) => ({
  id,
  player_id: playerId,
  email_verified: true,
  withdrawn_at: null,
  parent_email: `fila@${id}.test`,
  ...extra,
});
/** Emisión del enlace (sign-consent). */
const issuedEv = (id: string, playerId: string, tokenHash = H1, email = `tutor@${id}.test`) => ({
  action: "consent_token_issued",
  resource_id: id,
  metadata: { player_id: playerId, parent_email: email, token_hash: tokenHash, expires_at: "2099-01-01T00:00:00.000Z" },
});
/** Verificación del tutor (verify-consent). */
const verifiedEv = (id: string, playerId: string, tokenHash = H1) => ({
  action: "consent_email_verified",
  resource_id: id,
  metadata: { player_id: playerId, parent_email: `tutor@${id}.test`, token_hash: tokenHash },
});

describe("findActiveParentalConsent · qué cuenta", () => {
  it("fila verificada + emisión + verificación del MISMO token y jugador → cuenta; el email es el de la EMISIÓN; service_role y predicado canónico", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1"), verifiedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toEqual({ id: C1, parentEmail: `tutor@${C1}.test` });

    const q = mock.calls.find((c) => c.url.includes("/rest/v1/parental_consents"))!;
    expect(q.url).toContain("player_id=eq.p1");
    expect(q.url).toContain("email_verified=is.true");
    expect(q.url).toContain("withdrawn_at=is.null");
    expect(q.url).not.toContain("parent_email"); // el email de la fila ya no se lee
    expect((q.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
    const a = decodeURIComponent(mock.calls.find((c) => c.url.includes("/rest/v1/gdpr_audit_log"))!.url);
    expect(a).toContain('action=in.("consent_token_issued","consent_email_verified","consent_withdrawn")');
    expect(a).toContain("resource_type=eq.parental_consents");
    expect(a).toContain(`resource_id=in.("${C1}")`);
  });

  it("B6 · fila marcada como verificada por un CLIENTE (sin emisión ni verificación) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("ronda 5 · verificación SIN emisión del servidor (p. ej. del verify-consent anterior, o con el token que puso un cliente) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [verifiedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("ronda 5 · emisión SIN verificación del tutor → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("ronda 5 · verificación con OTRO token que el de la emisión → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1", H1), verifiedEv(C1, "p1", H2)];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("B6 · fila de OTRO jugador reapuntada a este (emisión y verificación con el otro jugador) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "pOtro"), verifiedEv(C1, "pOtro")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("ronda 5 · emisión de otro jugador + verificación escrita con el jugador de la fila (lo que hacía verify-consent antes) → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "pOtro"), verifiedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("evidencia SIN metadata → NO cuenta (no se puede ligar al jugador)", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1"), { action: "consent_email_verified", resource_id: C1, metadata: null }];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("emisión con un token SIN el prefijo del hash → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1", "1".repeat(64)), verifiedEv(C1, "p1", "1".repeat(64))];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("retirada auditada (trigger 003 'consent_withdrawn') aunque withdrawn_at vuelva a NULL → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1"), verifiedEv(C1, "p1"), { action: "consent_withdrawn", resource_id: C1, metadata: { reason: "x" } }];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("withdrawn_at puesto → NO cuenta (filtro de la consulta)", async () => {
    db.consentRows = [verifiedRow(C1, "p1", { withdrawn_at: "2026-10-01T00:00:00Z" })];
    db.consentAudit = [issuedEv(C1, "p1"), verifiedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("pendiente (email_verified=false) aunque exista la evidencia → NO cuenta", async () => {
    db.consentRows = [verifiedRow(C1, "p1", { email_verified: false })];
    db.consentAudit = [issuedEv(C1, "p1"), verifiedEv(C1, "p1")];
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
  });

  it("una fila falsificada y otra verificada de verdad → cuenta la verdadera", async () => {
    db.consentRows = [verifiedRow(C1, "p1"), verifiedRow(C2, "p1")];
    db.consentAudit = [verifiedEv(C1, "p1"), issuedEv(C2, "p1", H2), verifiedEv(C2, "p1", H2)];
    await expect(findActiveParentalConsent("p1")).resolves.toMatchObject({ id: C2, parentEmail: `tutor@${C2}.test` });
  });

  it("sin filas → null y NO se consulta gdpr_audit_log", async () => {
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
    expect(mock.calls.some((c) => c.url.includes("/gdpr_audit_log"))).toBe(false);
  });
});

describe("findActiveParentalConsent · falla cerrado (lanza; nunca «concedido»)", () => {
  it.each(["parental_consents", "gdpr_audit_log"])("error de %s → ParentalConsentDbError", async (table) => {
    db.consentRows = [verifiedRow(C1, "p1")];
    db.consentAudit = [issuedEv(C1, "p1"), verifiedEv(C1, "p1")];
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

describe("token del email · emisión y verificación", () => {
  const issued: IssuedConsentToken = {
    consentId: C1,
    playerId: "p1",
    parentEmail: "tutor@x.test",
    tokenHash: H1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    tenantId: TENANT,
    locale: null, // P1 bloque 3: idioma del correo al tutor (sin dato en esta emisión)
  };

  it("hashConsentToken: 'sha256:' + 64 hex, determinista y distinto del token", async () => {
    const raw = "ab".repeat(32);
    const h = await hashConsentToken(raw);
    expect(h.startsWith(CONSENT_TOKEN_HASH_PREFIX)).toBe(true);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(await hashConsentToken(raw));
    expect(h).not.toContain(raw);
  });

  it("recordConsentTokenIssued: fila append-only con service_role (quien firma, jugador, email en minúsculas, hash y caducidad)", async () => {
    await recordConsentTokenIssued({
      consentId: C1, playerId: "p1", parentEmail: "Tutor@X.test", tokenHash: H1,
      expiresAt: "2099-01-01T00:00:00.000Z", tenantId: TENANT, userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mock.inserts).toEqual([
      {
        user_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: TENANT,
        action: "consent_token_issued",
        resource_type: "parental_consents",
        resource_id: C1,
        metadata: { player_id: "p1", parent_email: "tutor@x.test", token_hash: H1, expires_at: "2099-01-01T00:00:00.000Z" },
      },
    ]);
    const post = mock.calls.find((c) => c.init.method === "POST")!;
    expect((post.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
  });

  it.each([
    ["id que no es uuid", { consentId: "x" }],
    ["token sin hashear", { tokenHash: "1".repeat(64) }],
    ["caducidad inválida", { expiresAt: "mañana" }],
    ["sin email", { parentEmail: "" }],
  ])("recordConsentTokenIssued: %s → lanza sin escribir", async (_l, over) => {
    await expect(
      recordConsentTokenIssued({ consentId: C1, playerId: "p1", parentEmail: "t@x.test", tokenHash: H1, expiresAt: "2099-01-01T00:00:00.000Z", tenantId: null, userId: null, ...over }),
    ).rejects.toBeInstanceOf(ParentalConsentDbError);
    expect(mock.inserts).toHaveLength(0);
  });

  it("recordConsentTokenIssued: si la base rechaza el INSERT → lanza", async () => {
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    await expect(
      recordConsentTokenIssued({ consentId: C1, playerId: "p1", parentEmail: "t@x.test", tokenHash: H1, expiresAt: "2099-01-01T00:00:00.000Z", tenantId: null, userId: null }),
    ).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("findIssuedConsentToken: busca la EMISIÓN por el hash del token (service_role) y devuelve lo que ligó el servidor", async () => {
    db.consentAudit = [{ ...issuedEv(C1, "p1", H1, "tutor@x.test"), tenant_id: TENANT }];
    await expect(findIssuedConsentToken(H1)).resolves.toEqual(issued);
    const q = decodeURIComponent(mock.calls[0].url);
    expect(q).toContain("action=eq.consent_token_issued");
    expect(q).toContain("resource_type=eq.parental_consents");
    expect(q).toContain(`metadata->>token_hash=eq.${H1}`);
    expect((mock.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
  });

  it("findIssuedConsentToken: sin emisión → null; token sin prefijo → null sin consultar", async () => {
    await expect(findIssuedConsentToken(H1)).resolves.toBeNull();
    mock.calls.length = 0;
    await expect(findIssuedConsentToken("1".repeat(64))).resolves.toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    ["sin jugador", { player_id: undefined }],
    ["sin email", { parent_email: undefined }],
    ["sin caducidad", { expires_at: undefined }],
    ["caducidad inválida", { expires_at: "x" }],
  ])("findIssuedConsentToken: emisión incompleta (%s) → null (el enlace no vale)", async (_l, over) => {
    const ev = issuedEv(C1, "p1");
    db.consentAudit = [{ ...ev, metadata: { ...ev.metadata, ...over } }];
    await expect(findIssuedConsentToken(H1)).resolves.toBeNull();
  });

  it("findIssuedConsentToken: dos emisiones con el mismo hash (ambiguo) o error de la base → lanza", async () => {
    db.consentAudit = [issuedEv(C1, "p1"), issuedEv(C2, "p2")];
    await expect(findIssuedConsentToken(H1)).rejects.toBeInstanceOf(ParentalConsentDbError);
    db.consentAudit = [issuedEv(C1, "p1")];
    db.failures.gdpr_audit_log = { status: 500, body: "boom" };
    await expect(findIssuedConsentToken(H1)).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("recordParentalConsentVerified: con lo que ligó la emisión (jugador, email, hash), sin usuario", async () => {
    await recordParentalConsentVerified(issued);
    expect(mock.inserts).toEqual([
      {
        user_id: null,
        tenant_id: TENANT,
        action: "consent_email_verified",
        resource_type: "parental_consents",
        resource_id: C1,
        metadata: { player_id: "p1", parent_email: "tutor@x.test", token_hash: H1 },
      },
    ]);
  });

  it("recordParentalConsentVerified: tenant que no es uuid → null (un INSERT roto no puede bloquear); INSERT rechazado → lanza", async () => {
    await recordParentalConsentVerified({ ...issued, tenantId: "no-uuid" });
    expect(mock.inserts[0]).toMatchObject({ tenant_id: null });
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    await expect(recordParentalConsentVerified(issued)).rejects.toBeInstanceOf(ParentalConsentDbError);
  });

  it("hasConsentVerification: solo la verificación de ESTA emisión (mismo token y jugador)", async () => {
    await expect(hasConsentVerification(issued)).resolves.toBe(false);
    db.consentAudit = [verifiedEv(C1, "p1", H2), verifiedEv(C1, "pOtro", H1)];
    await expect(hasConsentVerification(issued)).resolves.toBe(false);
    db.consentAudit.push(verifiedEv(C1, "p1", H1));
    await expect(hasConsentVerification(issued)).resolves.toBe(true);
  });

  it("emisión + verificación escritas por estas funciones → findActiveParentalConsent las reconoce (mismo contrato)", async () => {
    db.consentRows = [verifiedRow(C1, "p1")];
    await recordConsentTokenIssued({ ...issued, userId: null });
    await expect(findActiveParentalConsent("p1")).resolves.toBeNull();
    await recordParentalConsentVerified(issued);
    await expect(findActiveParentalConsent("p1")).resolves.toEqual({ id: C1, parentEmail: "tutor@x.test" });
  });
});
