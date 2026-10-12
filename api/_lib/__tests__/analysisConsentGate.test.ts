/**
 * Tests · api/_lib/analysisConsentGate — decisión del owner (30 sep): declaración del
 * entrenador SIEMPRE (guardada con el vídeo: quién/cuándo/versión) + consentimiento
 * parental verificado si el jugador es menor de 14 CONOCIDO. Falla cerrado, nunca 503.
 * Run: npx vitest run --config vitest.api.config.ts api/_lib/__tests__/analysisConsentGate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  enforceClipConsent,
  enforceStoredConsentForVideoUrl,
  enforceUserVideoObservationConsent,
  bunnyGuidFromVideoUrl,
  resolveClipVideo,
  gateClipAnalysis,
  clipGateErrorResponse,
  type VideoRowLite,
} from "../analysisConsentGate";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "./consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
/** Mismo predicado que ownership.ownsVideo para filas con user_id/tenant_id (sin fetch). */
// Solo el dueño (076): quien creó la fila. Sin rama por tenant.
const ownsByUser = async (v: VideoRowLite, uid: string | null) => !!v.user_id && v.user_id === uid;
/** Todos los jugadores son del usuario (los tests de B5 usan un predicado propio). */
const ownsAnyPlayer = async () => true;
const NOW = new Date("2026-09-30T12:00:00Z");
const actor = { userId: USER, tenantId: TENANT, ip: "203.0.113.7" };

let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  // Allowlist de hosts de vídeo (videoUrlGuard): `cdn.test` es la pull zone de Stream de los tests.
  process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
  delete process.env.VITE_BUNNY_CDN_HOSTNAME;
  delete process.env.BUNNY_STORAGE_CDN_URL;
  delete process.env.VIDEO_URL_EXTRA_HOSTS;
  delete process.env.BUNNY_STREAM_LIBRARY_ID;
  db = emptyConsentDb();
  mock = consentFetch(db);
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.BUNNY_CDN_HOSTNAME;
  delete process.env.BUNNY_STORAGE_CDN_URL;
  delete process.env.VIDEO_URL_EXTRA_HOSTS;
});

const base = {
  resource: { type: "videos" as const, id: "vid-1", bunnyVideoId: "1a000000-0000-4000-8000-000000000001" },
  actor,
  endpoint: "test",
  now: NOW,
};

describe("declaración del entrenador", () => {
  it("sin declaración (ni body ni guardada) → 400 attestation_required, sin guardar nada", async () => {
    const r = await enforceClipConsent({ ...base, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required", status: 400 });
    expect(mock.inserts).toHaveLength(0);
  });

  it.each([
    [{ accepted: false, version: "2026-09-28.v1" }],
    [{ accepted: true, version: "2020-01-01.v0" }],
    [{ accepted: true }],
    ["true"],
  ])("declaración inválida o de otra versión (%j) → attestation_required", async (attestation) => {
    const r = await enforceClipConsent({ ...base, attestation, playerId: null });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("attestation_required");
  });

  it("declaración del body → se GUARDA: quién = usuario del JWT, versión, recurso, sin tomar nada más del body", async () => {
    const r = await enforceClipConsent({ ...base, attestation: { ...ATTESTATION }, playerId: null, scope: "team" });
    expect(r).toMatchObject({ allowed: true, attestation: "recorded" });
    expect(mock.inserts).toHaveLength(1);
    expect(mock.inserts[0]).toEqual({
      user_id: USER,
      tenant_id: TENANT,
      action: "video_analysis_attested",
      resource_type: "videos",
      resource_id: "vid-1",
      metadata: { version: "2026-09-28.v1", scope: "team", player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001", endpoint: "test" },
      ip: "203.0.113.7",
    });
    // "cuándo" = reloj de la base (DEFAULT now()): el cliente no manda created_at.
    expect(mock.inserts[0]).not.toHaveProperty("created_at");
    const post = mock.calls.find((c) => c.init.method === "POST")!;
    expect((post.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key");
  });

  it("idempotente: la misma declaración del mismo usuario para el mismo vídeo no se duplica", async () => {
    await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    expect(mock.inserts).toHaveLength(1);
  });

  it("declaración ya GUARDADA para la fila videos → basta en rutas automáticas (storedOnly)", async () => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: "vid-1" });
    const r = await enforceClipConsent({ ...base, storedOnly: true, playerId: null, actor: { userId: null, tenantId: null } });
    expect(r).toMatchObject({ allowed: true, attestation: "stored" });
  });

  it("storedOnly ignora la declaración del body (una ruta sin usuario no puede declarar)", async () => {
    const r = await enforceClipConsent({ ...base, storedOnly: true, attestation: ATTESTATION, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
    expect(mock.inserts).toHaveLength(0);
  });

  it("sin usuario, una declaración en el body no cuenta", async () => {
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, actor: { userId: null, tenantId: null } });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("una declaración 'video_ref' guardada NUNCA desbloquea un vídeo 'videos'", async () => {
    db.storedAttestations.push({ resource_type: "video_ref", resource_id: "vid-1" });
    const r = await enforceClipConsent({ ...base, storedOnly: true, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("una declaración guardada de OTRA versión no cuenta", async () => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: "vid-1", version: "2026-01-01.v0" });
    const r = await enforceClipConsent({ ...base, storedOnly: true, playerId: null });
    expect(r.allowed).toBe(false);
  });

  it("video_ref: no se busca guardada, la declaración tiene que venir en la petición", async () => {
    db.storedAttestations.push({ resource_type: "video_ref", resource_id: "local-1" });
    const r = await enforceClipConsent({ ...base, resource: { type: "video_ref", id: "local-1" }, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("record:false → decide pero NO guarda (el llamador la guarda cuando existe el id)", async () => {
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, record: false, lookupStored: false });
    expect(r).toMatchObject({ allowed: true, attestation: "pending", pendingAttestation: ATTESTATION });
    expect(mock.inserts).toHaveLength(0);
  });

  it("tenant/ip raros no van a columnas uuid/inet (un INSERT roto bloquearía todo)", async () => {
    await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, actor: { userId: USER, tenantId: "no-uuid", ip: "unknown" } });
    expect(mock.inserts[0]).toMatchObject({ tenant_id: null, ip: null });
  });
});

describe("menor de 14 conocido → consentimiento parental de parental_consents", () => {
  it("fecha de nacimiento desconocida (NULL) → basta la declaración; NO se consulta parental_consents", async () => {
    db.birthDates.p1 = null;
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: true, minor: "unknown" });
    expect(mock.calls.some((c) => c.url.includes("parental_consents"))).toBe(false);
  });

  it("14 años cumplidos → basta la declaración", async () => {
    db.birthDates.p1 = "2012-09-30"; // cumple 14 hoy
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: true, minor: "not_minor" });
  });

  it("13 años (la víspera de cumplir 14) sin consentimiento → 403 parental_consent_required, sin guardar la declaración", async () => {
    db.birthDates.p1 = "2012-10-01";
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required", status: 403, minor: "minor" });
    expect(mock.inserts).toHaveLength(0);
  });

  it("13 años con consentimiento verificado y no retirado → permitido; la consulta usa el predicado canónico", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.activeConsents.push("p1");
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: true, minor: "minor" });
    const q = mock.calls.find((c) => c.url.includes("/parental_consents"))!.url;
    expect(q).toContain("email_verified=is.true");
    expect(q).toContain("withdrawn_at=is.null");
    expect(q).toContain("player_id=eq.p1");
  });

  it("vídeo de EQUIPO (sin jugador) → la comprobación por jugador no aplica", async () => {
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    expect(r.allowed).toBe(true);
    expect(mock.calls.some((c) => c.url.includes("/players"))).toBe(false);
  });

  it("columna birth_date inexistente (036 sin aplicar) → fecha desconocida, basta la declaración", async () => {
    db.failures.players = { status: 400, body: JSON.stringify({ code: "42703", message: "column players.birth_date does not exist" }) };
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: true, minor: "unknown" });
  });

  it("jugador inexistente → falla cerrado (500), nunca 'permitido'", async () => {
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "no-existe" });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });

  it("fecha que no es una fecha → falla cerrado", async () => {
    db.birthDates.p1 = "2014-02-30";
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed" });
  });
});

describe("B6 · la fuente del consentimiento la firma y la verifica el TUTOR; el entrenador no la fabrica", () => {
  const C1 = "c1000000-0000-4000-8000-000000000001";

  it("fila marcada como verificada por un CLIENTE (UPDATE, sin evidencia de verify-consent) → 403 parental_consent_required", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.consentRows = [{ id: C1, player_id: "p1", email_verified: true, withdrawn_at: null }];
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required", status: 403, minor: "minor" });
    expect(mock.inserts).toHaveLength(0);
  });

  it("consentimiento verificado de OTRO jugador reapuntado a este menor → 403", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.consentRows = [{ id: C1, player_id: "p1", email_verified: true, withdrawn_at: null }];
    db.consentAudit = [{ action: "consent_email_verified", resource_id: C1, metadata: { player_id: "pOtro" } }];
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("consentimiento retirado (auditado por el trigger 003) → 403 aunque withdrawn_at se haya vaciado", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.activeConsents.push("p1");
    db.consentAudit = [{ action: "consent_withdrawn", resource_id: "consent-p1", metadata: null }];
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  /** Todas las filas de players que devuelva la base llevan este parental_consent_status. */
  const withPlayerConsentStatus = (status: string) => {
    const inner = mock.fn;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/rest/v1/players?") && res.ok) {
          const rows = (await res.json()) as Array<Record<string, unknown>>;
          const out = rows.length ? rows : url.includes("select=parental_consent_status") ? [{}] : rows;
          return new Response(JSON.stringify(out.map((r) => ({ ...r, parental_consent_status: status }))), { status: 200 });
        }
        return res;
      }),
    );
  };

  it("players.parental_consent_status = 'granted' (lo pone el entrenador en /admin/consent) NO desbloquea", async () => {
    db.birthDates.p1 = "2013-05-01";
    withPlayerConsentStatus("granted");
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  // Ronda 6: «revocar» en /admin/consent solo pone 'denied' (nunca withdrawn_at). Una retirada
  // tiene que parar el análisis aunque haya un consentimiento verificado por el tutor.
  it("consentimiento VERIFICADO + el entrenador lo revoca ('denied') → bloqueado", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.activeConsents.push("p1");
    // Control positivo: con el consentimiento verificado y sin revocar, pasa.
    expect(await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1", record: false }))
      .toMatchObject({ allowed: true });
    withPlayerConsentStatus("denied");
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1", record: false });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("error al leer la evidencia (gdpr_audit_log) de un menor con fila verificada → 500 consent_check_failed, nunca permitido", async () => {
    db.birthDates.p1 = "2013-05-01";
    db.activeConsents.push("p1");
    // La declaración viene en el body (no se busca guardada), así que el único GET de
    // gdpr_audit_log es el de la evidencia del consentimiento.
    db.failures.gdpr_audit_log = { status: 500, body: "boom" };
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1", lookupStored: false, record: false });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });
});

describe("falla cerrado (nunca 503)", () => {
  it.each(["gdpr_audit_log", "parental_consents"])("error de %s → consent_check_failed 500", async (table) => {
    db.birthDates.p1 = "2014-01-01";
    db.failures[table] = { status: 500, body: "boom" };
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1", storedOnly: table === "gdpr_audit_log" });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });

  it("no se puede GUARDAR la declaración → no se analiza (500)", async () => {
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });

  it("gdpr_audit_log inexistente (PGRST205) → 500, no permitido", async () => {
    db.failures.gdpr_audit_log = { status: 404, body: JSON.stringify({ code: "PGRST205" }) };
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed" });
  });

  it("sin Supabase configurado → 500 sin llamar a nada", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
    expect(mock.calls).toHaveLength(0);
  });

  it("el motivo sale en el idioma pedido", async () => {
    const r = await enforceClipConsent({ ...base, playerId: null, locale: "en" });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.gate_reason).toMatch(/declaration/i);
  });
});

describe("varios jugadores: el pedido Y los que el servidor liga al vídeo (B1)", () => {
  it("jugador pedido adulto + jugador del vídeo menor sin consentimiento → 403 (el body no lo esquiva)", async () => {
    db.birthDates.pAdult = "1990-01-01";
    db.birthDates.pMinor = "2016-01-01";
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "pAdult", videoPlayerIds: ["pMinor"] });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required", minor: "minor" });
    expect(mock.inserts).toHaveLength(0);
  });

  it("sin jugador pedido, el jugador del vídeo menor sin consentimiento → 403 aunque se pida 'de equipo'", async () => {
    db.birthDates.pMinor = "2016-01-01";
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, videoPlayerIds: ["pMinor"], scope: "team" });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("todos pasan (menor con consentimiento + fecha desconocida) → permitido; metadata.player_id = el pedido", async () => {
    db.birthDates.pMinor = "2016-01-01";
    db.activeConsents.push("pMinor");
    db.birthDates.p1 = null;
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: "p1", videoPlayerIds: ["pMinor", "p1", null] });
    expect(r).toMatchObject({ allowed: true, minor: "unknown" });
    expect((mock.inserts[0].metadata as Record<string, unknown>).player_id).toBe("p1");
    // p1 se consulta UNA vez (sin duplicar) y pMinor también.
    expect(mock.calls.filter((c) => c.url.includes("/rest/v1/players?id=eq.p1"))).toHaveLength(1);
  });

  it("sin jugador pedido, la metadata guarda el jugador del vídeo", async () => {
    db.birthDates.pV = null;
    await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, videoPlayerIds: ["pV"] });
    expect((mock.inserts[0].metadata as Record<string, unknown>).player_id).toBe("pV");
  });

  it("un jugador del vídeo que no existe → falla cerrado (500)", async () => {
    const r = await enforceClipConsent({ ...base, attestation: ATTESTATION, playerId: null, videoPlayerIds: ["borrado"] });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });
});

describe("resolveClipVideo · el vídeo y sus jugadores los resuelve el servidor (B1/B2)", () => {
  const resolve = (over: Partial<Parameters<typeof resolveClipVideo>[0]> = {}) =>
    resolveClipVideo({ requireVideoRow: true, actor, ownsVideo: ownsByUser, endpoint: "t", ...over });

  it("por el GUID de la URL encuentra la fila create-upload (id vid-x ≠ GUID) y su jugador", async () => {
    db.videos.push({ id: "vid-x", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const r = await resolve({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-00000000000a/play_720p.mp4" });
    expect(r).toMatchObject({ ok: true, video: { id: "vid-x" }, videoPlayerIds: ["p1"], resource: { type: "videos", id: "vid-x", bunnyVideoId: "1a000000-0000-4000-8000-00000000000a" } });
  });

  it("por un videoId que es el GUID (no el id) también la encuentra (B2)", async () => {
    db.videos.push({ id: "vid-x", user_id: OTHER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const r = await resolve({ videoId: "1a000000-0000-4000-8000-00000000000a", bunnyGuid: "1a000000-0000-4000-8000-00000000000a" });
    expect(r).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("TODAS las filas del vídeo cuentan: una propia + otra ajena con el mismo GUID → 403", async () => {
    db.videos.push({ id: "mine", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    db.videos.push({ id: "1a000000-0000-4000-8000-00000000000b", user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    expect(await resolve({ videoId: "mine", videoUrl: "https://cdn.test/1a000000-0000-4000-8000-00000000000b/x.mp4" })).toMatchObject({ ok: false, status: 403 });
    // Contenido del navegador (sin GUID de píxeles): la fila ajena aparece por expansión.
    expect(await resolve({ videoId: "mine", requireVideoRow: false })).toMatchObject({ ok: false, status: 403 });
  });

  it("varias filas propias del mismo vídeo → los jugadores de todas, sin duplicar", async () => {
    db.videos.push({ id: "vid-x", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    db.videos.push({ id: "1a000000-0000-4000-8000-00000000000a", user_id: USER, tenant_id: TENANT, player_id: "p2", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    db.videos.push({ id: "g-x-copy", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const r = await resolve({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-00000000000a/play.mp4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.videoPlayerIds].sort()).toEqual(["p1", "p2"]);
      expect(r.video?.id).toBe("1a000000-0000-4000-8000-00000000000a"); // la fila cuyo id ES el GUID de los píxeles
    }
  });

  it("URL con otro vídeo y el GUID propio en segmentos de más → 400 invalid_video_reference (ronda 6: no identifica un vídeo)", async () => {
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
    expect(await resolve({ videoId: "1a000000-0000-4000-8000-000000000001", videoUrl: "https://cdn.test/1c000000-0000-4000-8000-000000000003/1a000000-0000-4000-8000-000000000001/play.mp4" })).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
  });

  it("videoId de un vídeo y GUID de otro (ambos propios) → 400 video_url_mismatch", async () => {
    db.videos.push({ id: "a", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000c" });
    db.videos.push({ id: "b", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000d" });
    expect(await resolve({ videoId: "a", bunnyGuid: "1a000000-0000-4000-8000-00000000000d" })).toMatchObject({ ok: false, code: "video_url_mismatch" });
  });

  it("videoId de una fila SIN GUID (otro vídeo) + URL de un vídeo con fila → 400 (no pasa en silencio)", async () => {
    db.videos.push({ id: "local-1", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: null });
    db.videos.push({ id: "1a000000-0000-4000-8000-00000000000d", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000d" });
    expect(await resolve({ videoId: "local-1", videoUrl: "https://cdn.test/1a000000-0000-4000-8000-00000000000d/x.mp4" })).toMatchObject({ ok: false, code: "video_url_mismatch" });
  });

  it("fila sin GUID todavía: SOLO finalize (seedRow) la cuenta como fila de ese vídeo", async () => {
    db.videos.push({ id: "local-1", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: null });
    // Una ruta que lee píxeles por URL no puede tomar una fila ajena al GUID como "la del vídeo".
    expect(await resolve({ videoId: "local-1", bunnyGuid: "1a000000-0000-4000-8000-00000000000f" })).toMatchObject({ ok: false, code: "video_url_mismatch" });
    // finalize: la va a sembrar con ese GUID → es la fila del vídeo.
    expect(await resolve({ videoId: "local-1", bunnyGuid: "1a000000-0000-4000-8000-00000000000f", seedRow: true })).toMatchObject({
      ok: true, video: { id: "local-1" }, videoPlayerIds: ["p1"], resource: { type: "videos", id: "local-1", bunnyVideoId: "1a000000-0000-4000-8000-00000000000f" },
    });
    // ...pero si OTRA fila ajena ya apunta a ese GUID, 403 (no se siembra un vídeo ajeno).
    db.videos.push({ id: "vid-o", user_id: OTHER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000f" });
    expect(await resolve({ videoId: "local-1", bunnyGuid: "1a000000-0000-4000-8000-00000000000f", seedRow: true })).toMatchObject({ ok: false, status: 403 });
  });

  it("sin fila: 404 si el servidor lee píxeles; video_ref (sin jugadores) si el contenido es del navegador", async () => {
    expect(await resolve({ videoUrl: "https://cdn.test/1c000000-0000-4000-8000-000000000002/x.mp4" })).toMatchObject({ ok: false, status: 404, code: "video_not_found" });
    expect(await resolve({ videoId: "local-9", requireVideoRow: false })).toEqual({
      ok: true, video: null, rows: [], resource: { type: "video_ref", id: "local-9" }, videoPlayerIds: [],
    });
  });

  it("sin referencia: 400 si se exige fila; video_ref null si no", async () => {
    expect(await resolve({})).toMatchObject({ ok: false, status: 400, code: "video_reference_required" });
    expect(await resolve({ requireVideoRow: false })).toMatchObject({ ok: true, resource: { type: "video_ref", id: null } });
  });

  it("URL que no se puede leer → 400 invalid_video_reference (nunca se analiza) · desde la ronda 5 (antes 404)", async () => {
    expect(await resolve({ videoUrl: "no es una url" })).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
    expect(mock.calls).toHaveLength(0);
  });

  describe("B7 (ronda 5) · el GUID solo sale de una URL de la allowlist y de la pull zone de Stream", () => {
    const OWN = "1a000000-0000-4000-8000-00000000000a";
    beforeEach(() => {
      db.videos.push({ id: OWN, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: OWN });
    });

    it("control positivo: pull zone de Stream → la fila propia", async () => {
      expect(await resolve({ videoUrl: `https://cdn.test/${OWN}/play_720p.mp4` })).toMatchObject({ ok: true, video: { id: OWN } });
    });

    it("host AJENO con el GUID propio → 400 invalid_video_reference, sin buscar nada", async () => {
      expect(await resolve({ videoUrl: `https://attacker.example/${OWN}/other.mp4` })).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
      expect(mock.calls).toHaveLength(0);
    });

    it.each([
      ["pull zone de Storage", { BUNNY_STORAGE_CDN_URL: "https://storage.test" }, "storage.test"],
      ["host extra (VIDEO_URL_EXTRA_HOSTS)", { VIDEO_URL_EXTRA_HOSTS: "legacy.test" }, "legacy.test"],
    ])("%s (en la allowlist, pero su primer segmento no identifica un vídeo) → 400", async (_l, env, host) => {
      Object.assign(process.env, env);
      expect(await resolve({ videoUrl: `https://${host}/${OWN}/x.mp4` })).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
      expect(mock.calls).toHaveLength(0);
    });

    it("sin BUNNY_CDN_HOSTNAME → 500 consent_check_failed (falla cerrado, nunca 503)", async () => {
      delete process.env.BUNNY_CDN_HOSTNAME;
      expect(await resolve({ videoUrl: `https://cdn.test/${OWN}/play_720p.mp4` })).toMatchObject({ ok: false, status: 500, code: "consent_check_failed" });
      expect(mock.calls).toHaveLength(0);
    });

    it("gateClipAnalysis con host ajeno y declaración YA guardada para el GUID propio → bloqueado, sin guardar nada", async () => {
      db.storedAttestations.push({ resource_type: "videos", resource_id: OWN });
      const r = await gateClipAnalysis({
        videoUrl: `https://attacker.example/${OWN}/other.mp4`, requireVideoRow: true, playerId: null, actor, endpoint: "t",
        ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer,
      });
      expect(r).toMatchObject({ allowed: false, status: 400, code: "invalid_video_reference" });
      expect(mock.inserts).toHaveLength(0);
    });
  });

  it("ruta automática (ownsVideo null) → no comprueba propiedad, sí junta los jugadores", async () => {
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: OTHER, tenant_id: null, player_id: "p9", bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
    expect(await resolve({ videoId: "1a000000-0000-4000-8000-000000000001", ownsVideo: null, actor: { userId: null, tenantId: null } })).toMatchObject({ ok: true, videoPlayerIds: ["p9"] });
  });

  it("error de la base → consent_check_failed 500 (falla cerrado, nunca 503)", async () => {
    db.failures.videos = { status: 500, body: "boom" };
    expect(await resolve({ videoId: "1a000000-0000-4000-8000-000000000001" })).toMatchObject({ ok: false, status: 500, code: "consent_check_failed" });
  });

  it("la consulta usa id=in y bunny_video_id=in con valores entre comillas (PostgREST)", async () => {
    const G = "1a000000-0000-4000-8000-000000000001";
    await resolve({ videoId: "vid-1", bunnyGuid: G });
    const urls = mock.calls.filter((c) => c.url.includes("/rest/v1/videos")).map((c) => decodeURIComponent(c.url));
    expect(urls.some((u) => u.includes(`id=in.("vid-1","${G}")`))).toBe(true);
    expect(urls.some((u) => u.includes(`bunny_video_id=in.("vid-1","${G}")`))).toBe(true);
    // Un valor con comas o comillas ya no llega a la consulta (B4: forma segura, ver abajo).
    mock.calls.length = 0;
    expect(await resolve({ videoId: 'raro,"id"', requireVideoRow: false })).toMatchObject({ ok: false, code: "invalid_video_reference" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("gateClipAnalysis · resolución + consentimiento", () => {
  it("B1 · fila propia de un menor de 14 sin consentimiento, sin jugador en el body → 403", async () => {
    db.videos.push({ id: "1b000000-0000-4000-8000-000000000002", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1b000000-0000-4000-8000-000000000002" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const r = await gateClipAnalysis({
      videoUrl: "https://cdn.test/1b000000-0000-4000-8000-000000000002/play_720p.mp4", requireVideoRow: true, attestation: ATTESTATION,
      playerId: null, actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer,
    });
    expect(r).toMatchObject({ allowed: false, status: 403, code: "parental_consent_required" });
    expect(mock.inserts).toHaveLength(0);
  });

  it("permitido → guarda la declaración CON la fila resuelta y devuelve el vídeo y sus jugadores", async () => {
    db.videos.push({ id: "vid-x", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    db.birthDates.p1 = null;
    const r = await gateClipAnalysis({
      videoId: "1a000000-0000-4000-8000-00000000000a", requireVideoRow: false, attestation: ATTESTATION, playerId: null, actor, endpoint: "t",
      scope: "team", ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer,
    });
    expect(r).toMatchObject({ allowed: true, attestation: "recorded", video: { id: "vid-x" }, videoPlayerIds: ["p1"] });
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "vid-x", metadata: { bunny_video_id: "1a000000-0000-4000-8000-00000000000a", player_id: "p1" } });
  });

  it("clipGateErrorResponse: código de consentimiento → motivo + versión; de resolución → su código y estado", async () => {
    const consent = clipGateErrorResponse({ allowed: false, status: 403, code: "parental_consent_required", gate_reason: "m", minor: "minor" });
    expect(consent.status).toBe(403);
    expect((await consent.json()).errorDetail).toMatchObject({ code: "parental_consent_required", gate_reason: "m", attestationVersion: "2026-09-28.v1" });
    const res = clipGateErrorResponse({ allowed: false, status: 404, code: "video_not_found", gate_reason: "no", minor: null });
    expect(res.status).toBe(404);
    expect((await res.json()).errorDetail.code).toBe("video_not_found");
  });

  it("sin Supabase → consent_check_failed sin llamar a nada", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await gateClipAnalysis({ videoId: "x", requireVideoRow: true, playerId: null, actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("helpers de vídeo", () => {
  it("bunnyGuidFromVideoUrl: pull zone de Stream (primer segmento) y API de librería (tras /videos/)", () => {
    const env = { BUNNY_CDN_HOSTNAME: "vz-1.b-cdn.net", BUNNY_STREAM_LIBRARY_ID: "42" };
    expect(bunnyGuidFromVideoUrl("https://vz-1.b-cdn.net/abc-guid/play_720p.mp4", env)).toBe("abc-guid");
    expect(bunnyGuidFromVideoUrl("https://video.bunnycdn.com/library/42/videos/abc-guid/play.mp4", env)).toBe("abc-guid");
    // Ronda 6: solo la forma exacta /<guid>/<fichero> identifica un vídeo; con segmentos de
    // más no se sabe qué píxeles sirve el CDN → null (antes: el primer segmento).
    expect(bunnyGuidFromVideoUrl("https://vz-1.b-cdn.net/1c000000-0000-4000-8000-000000000003/abc-guid/play.mp4", env)).toBeNull();
    expect(bunnyGuidFromVideoUrl("https://vz-1.b-cdn.net/x/play.mp4?abc-guid", env)).toBe("x");
    expect(bunnyGuidFromVideoUrl("not a url", env)).toBeNull();
  });

  it("bunnyGuidFromVideoUrl (B7, ronda 5): host ajeno, otra librería, Storage o sin hosts configurados → null", () => {
    const env = { BUNNY_CDN_HOSTNAME: "vz-1.b-cdn.net", BUNNY_STREAM_LIBRARY_ID: "42", BUNNY_STORAGE_CDN_URL: "https://st.b-cdn.net" };
    // Antes: el primer segmento de CUALQUIER host.
    expect(bunnyGuidFromVideoUrl("https://attacker.example/abc-guid/other.mp4", env)).toBeNull();
    expect(bunnyGuidFromVideoUrl("https://video.bunnycdn.com/library/7/videos/abc-guid/play.mp4", env)).toBeNull();
    expect(bunnyGuidFromVideoUrl("https://st.b-cdn.net/abc-guid/x.mp4", env)).toBeNull();
    expect(bunnyGuidFromVideoUrl("https://vz-1.b-cdn.net/abc-guid/play.mp4", {})).toBeNull();
  });

  it("enforceStoredConsentForVideoUrl: otra fila AJENA con el mismo GUID → bloqueado (aunque la propia tenga declaración)", async () => {
    db.videos.push({ id: "mine", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    db.videos.push({ id: "1a000000-0000-4000-8000-00000000000b", user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "mine" });
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-00000000000b/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("enforceStoredConsentForVideoUrl: base caída → consent_check_failed (no un 'sin vídeo' silencioso)", async () => {
    db.failures.videos = { status: 500, body: "boom" };
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "consent_check_failed", status: 500 });
  });

  const ownsYes = async () => true;
  const ownsNo = async () => false;

  it("enforceStoredConsentForVideoUrl: fila videos PROPIA por GUID + declaración guardada → permitido", async () => {
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: TENANT, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000001" });
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsYes, ownsPlayer: ownsAnyPlayer });
    expect(r.allowed).toBe(true);
  });

  it("enforceStoredConsentForVideoUrl: vídeo AJENO con declaración de su dueño → bloqueado (no vale para otro)", async () => {
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000001" });
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsNo, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("enforceStoredConsentForVideoUrl: sin fila videos → attestation_required", async () => {
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000009/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsYes, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("enforceStoredConsentForVideoUrl: vídeo con jugador menor de 14 sin consentimiento → parental_consent_required", async () => {
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000002", user_id: USER, tenant_id: TENANT, player_id: "p1", bunny_video_id: "1a000000-0000-4000-8000-000000000002" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000002" });
    // Este helper usa el reloj real: 10 años antes de hoy ⇒ menor de 14 siempre.
    db.birthDates.p1 = `${new Date().getUTCFullYear() - 10}-01-01`;
    const r = await enforceStoredConsentForVideoUrl({ videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000002/play_720p.mp4", actor, endpoint: "t", ownsVideo: ownsYes, ownsPlayer: ownsAnyPlayer });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });
});

describe("enforceUserVideoObservationConsent (llamadas de usuario a video-observation)", () => {
  const owns = vi.fn(async () => true);
  const call = (over: Record<string, unknown> = {}) =>
    enforceUserVideoObservationConsent({
      videoId: "1a000000-0000-4000-8000-000000000001",
      videoUrl: "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4",
      hasBase64: false,
      attestation: ATTESTATION,
      scope: "team",
      actor,
      ownsVideo: owns,
      ownsPlayer: ownsAnyPlayer,
      ...over,
    });

  beforeEach(() => {
    owns.mockResolvedValue(true);
    db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: TENANT, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
  });

  it("fichero en base64 → 400 video_reference_required", async () => {
    const r = await call({ hasBase64: true });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.response.status).toBe(400);
      expect((await r.response.json()).errorDetail.code).toBe("video_reference_required");
    }
  });

  it("sin videoId → 400 video_reference_required", async () => {
    const r = await call({ videoId: undefined });
    expect(r.allowed).toBe(false);
  });

  it("vídeo ajeno → 403", async () => {
    owns.mockResolvedValue(false);
    const r = await call();
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.response.status).toBe(403);
  });

  it("URL de OTRO vídeo → 400 video_url_mismatch", async () => {
    const r = await call({ videoUrl: "https://cdn.test/1c000000-0000-4000-8000-000000000004/play_720p.mp4" });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect((await r.response.json()).errorDetail.code).toBe("video_url_mismatch");
  });

  it("ámbito jugador sobre un vídeo sin jugador → 400 (no se puede comprobar al menor)", async () => {
    const r = await call({ scope: "player" });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect((await r.response.json()).errorDetail.code).toBe("player_scope_requires_player_video");
  });

  it("sin declaración → 400 attestation_required", async () => {
    const r = await call({ attestation: undefined });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect((await r.response.json()).errorDetail.code).toBe("attestation_required");
  });

  it("vídeo propio + URL correcta + declaración → permitido y guardado con la fila", async () => {
    const r = await call();
    expect(r.allowed).toBe(true);
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000001" });
  });
});

// ─── B4 / B5 (review del PR #308, ronda 3) ─────────────────────────────────────
describe("B4 · el id que se busca es EXACTAMENTE el que el servidor usa en la URL", () => {
  const G_OWN = "0a0a0a0a-0000-4000-8000-000000000001";
  const G_VICTIM = "0b0b0b0b-0000-4000-8000-000000000002";
  const resolveB4 = (over: Partial<Parameters<typeof resolveClipVideo>[0]> = {}) =>
    resolveClipVideo({ requireVideoRow: true, actor, ownsVideo: ownsByUser, endpoint: "t", ...over });

  it.each([
    `a/../${G_VICTIM}`,
    `../${G_VICTIM}`,
    `${G_OWN}/../${G_VICTIM}`,
    `a%2F..%2F${G_VICTIM}`,
    `${G_VICTIM}.`,
    `${G_VICTIM} `,
    `"${G_VICTIM}"`,
  ])("videoId con barras, puntos, porcentajes, comillas o espacios (%j) → 400 invalid_video_reference sin consultar nada", async (videoId) => {
    db.videos.push({ id: videoId, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: null });
    const r = await resolveB4({ videoId, requireVideoRow: false });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
    expect(mock.calls).toHaveLength(0);
  });

  it.each([`a/../${G_VICTIM}`, "g-1", `${G_VICTIM}x`])("GUID de píxeles (bunnyGuid) que no es un UUID (%j) → 400 sin consultar nada", async (bunnyGuid) => {
    const r = await resolveB4({ videoId: G_OWN, bunnyGuid });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
    expect(mock.calls).toHaveLength(0);
  });

  it("URL cuyo primer segmento lleva barras codificadas (a%2F..%2F<GUID>) → 400, no se toma como ese GUID", async () => {
    db.videos.push({ id: G_VICTIM, user_id: OTHER, tenant_id: null, player_id: null, bunny_video_id: G_VICTIM });
    const r = await resolveB4({ videoUrl: `https://cdn.test/a%2F..%2F${G_VICTIM}/play_720p.mp4` });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid_video_reference" });
    expect(mock.calls).toHaveLength(0);
  });

  it("control: GUID con forma de UUID y videoId vid-<hex> / local-<ts>-<rand> → se resuelven", async () => {
    db.videos.push({ id: "vid-0a1b2c3d", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: G_OWN });
    expect(await resolveB4({ videoId: "vid-0a1b2c3d", bunnyGuid: G_OWN })).toMatchObject({ ok: true, video: { id: "vid-0a1b2c3d" } });
    expect(await resolveB4({ videoId: "local-mf3k2a-x9y8z7", requireVideoRow: false })).toMatchObject({
      ok: true, resource: { type: "video_ref", id: "local-mf3k2a-x9y8z7" },
    });
  });

  it("el motivo de un error de resolución sale en el idioma pedido", async () => {
    const r = await resolveB4({ videoId: "a/../b", requireVideoRow: false, locale: "en" });
    expect(r).toMatchObject({ ok: false, code: "invalid_video_reference" });
    if (!r.ok) expect(r.message).toMatch(/video reference/i);
  });
});

describe("B5 · propiedad de CADA jugador ANTES de leer su fecha de nacimiento (rutas de usuario)", () => {
  const G = "0c0c0c0c-0000-4000-8000-000000000003";
  const ownsPlayerOf = (owner: Record<string, string>) => async (pid: string, uid: string | null) => !!uid && owner[pid] === uid;
  const birthDateReads = () => mock.calls.filter((c) => c.url.includes("/rest/v1/players?") && c.url.includes("select=birth_date"));
  const consentReads = () => mock.calls.filter((c) => c.url.includes("/rest/v1/parental_consents"));

  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
    ["fecha desconocida", null],
  ])("fila propia ligada a un jugador AJENO (%s) → 403 forbidden igual en los tres casos; no se lee nada del jugador", async (_label, bd) => {
    db.videos.push({ id: G, user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: G });
    db.birthDates.pForeign = bd as string | null;
    const r = await gateClipAnalysis({
      videoId: G, bunnyGuid: G, requireVideoRow: true, attestation: ATTESTATION, playerId: null, actor, endpoint: "t",
      ownsVideo: ownsByUser, ownsPlayer: ownsPlayerOf({ pForeign: OTHER }),
    });
    expect(r).toMatchObject({ allowed: false, status: 403, code: "forbidden" });
    expect(birthDateReads()).toHaveLength(0);
    expect(consentReads()).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it("jugador PEDIDO ajeno o inexistente → el mismo 403 (no se distingue uno de otro)", async () => {
    db.videos.push({ id: G, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: G });
    db.birthDates.pForeign = MINOR_BIRTH_DATE;
    const owns = ownsPlayerOf({ pForeign: OTHER });
    const a = await gateClipAnalysis({ videoId: G, requireVideoRow: false, attestation: ATTESTATION, playerId: "pForeign", actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: owns });
    const b = await gateClipAnalysis({ videoId: G, requireVideoRow: false, attestation: ATTESTATION, playerId: "no-existe", actor, endpoint: "t", ownsVideo: ownsByUser, ownsPlayer: owns });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ allowed: false, status: 403, code: "forbidden" });
    expect(birthDateReads()).toHaveLength(0);
  });

  it("control: jugadores propios → se comprueba su edad como siempre (menor sin consentimiento → 403 parental)", async () => {
    db.videos.push({ id: G, user_id: USER, tenant_id: null, player_id: "pMine", bunny_video_id: G });
    db.birthDates.pMine = MINOR_BIRTH_DATE;
    const r = await gateClipAnalysis({
      videoId: G, bunnyGuid: G, requireVideoRow: true, attestation: ATTESTATION, playerId: null, actor, endpoint: "t",
      ownsVideo: ownsByUser, ownsPlayer: ownsPlayerOf({ pMine: USER }),
    });
    expect(r).toMatchObject({ allowed: false, code: "parental_consent_required" });
  });

  it("enforceStoredConsentForVideoUrl (live/aggregate): vídeo propio declarado ligado a un jugador ajeno → attestation_required genérico, sin leer su fecha", async () => {
    db.videos.push({ id: G, user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: G });
    db.storedAttestations.push({ resource_type: "videos", resource_id: G });
    db.birthDates.pForeign = MINOR_BIRTH_DATE;
    const r = await enforceStoredConsentForVideoUrl({
      videoUrl: `https://cdn.test/${G}/play_720p.mp4`, actor, endpoint: "t",
      ownsVideo: ownsByUser, ownsPlayer: ownsPlayerOf({ pForeign: OTHER }),
    });
    expect(r).toMatchObject({ allowed: false, code: "attestation_required" });
    expect(birthDateReads()).toHaveLength(0);
  });

  it("actAsPlayerOwner (cola): actúa en nombre del dueño del jugador pedido; una fila creada por OTRA cuenta → 403", async () => {
    db.playerOwners.p1 = USER;
    db.birthDates.p1 = null;
    db.videos.push({ id: G, user_id: OTHER, tenant_id: null, player_id: "p1", bunny_video_id: G });
    db.storedAttestations.push({ resource_type: "videos", resource_id: G });
    const auto = (over: Record<string, unknown> = {}) =>
      gateClipAnalysis({
        videoId: G, bunnyGuid: G, requireVideoRow: true, storedOnly: true, playerId: "p1",
        actor: { userId: null, tenantId: null }, endpoint: "t", ownsVideo: null, ownsPlayer: null, actAsPlayerOwner: true, ...over,
      });
    expect(await auto()).toMatchObject({ allowed: false, status: 403, code: "forbidden" });
    // Control: la misma fila creada por el dueño → permitido (solo la declaración guardada).
    db.videos[0].user_id = USER;
    expect(await auto()).toMatchObject({ allowed: true, attestation: "stored" });
    // Fila antigua SIN creador → cuenta la del dueño de su jugador.
    db.videos[0].user_id = null;
    expect(await auto()).toMatchObject({ allowed: true });
    // Jugador sin dueño → 403 sin leer nada del vídeo.
    delete db.playerOwners.p1;
    mock.calls.length = 0;
    expect(await auto()).toMatchObject({ allowed: false, status: 403, code: "forbidden" });
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/videos"))).toBe(false);
  });

  it("enforceUserVideoObservationConsent: vídeo propio ligado a un jugador ajeno → 403 sin leer su fecha", async () => {
    db.videos.push({ id: G, user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: G });
    db.birthDates.pForeign = MINOR_BIRTH_DATE;
    const r = await enforceUserVideoObservationConsent({
      videoId: G, videoUrl: `https://cdn.test/${G}/play_720p.mp4`, hasBase64: false, attestation: ATTESTATION, scope: "team",
      actor, ownsVideo: ownsByUser, ownsPlayer: ownsPlayerOf({ pForeign: OTHER }),
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.response.status).toBe(403);
      expect((await r.response.json()).errorDetail.code).toBe("forbidden");
    }
    expect(birthDateReads()).toHaveLength(0);
  });
});
