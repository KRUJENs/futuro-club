/**
 * Tests · api/upload/_video-init.ts (fase 0 partido completo)
 *  - firma TUS válida 24 h (Bunny valida AuthorizationExpire en cada PATCH y re-firmar
 *    no extiende la caducidad → la ventana debe cubrir la subida de un partido)
 *  - la fila `videos` se inserta con el JWT del USUARIO (anon key + Bearer user), no con
 *    service role (el trigger auto_assign_org_id usa auth.uid()), id = bunny_video_id = guid,
 *    tenant_id del JWT verificado (etiqueta), player_id solo si el usuario es su DUEÑO
 *    (RLS + players.user_id = usuario del JWT, 076)
 *  - sin Supabase configurado → degrada sin romper
 *  - gate de duración de partido con el límite compartido
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sha256Hex } from "../../_lib/edgeCrypto";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: "tenant-9", error: null }),
}));

import videoInit from "../_video-init";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const GUID = "a1b2c3d4-0000-4000-8000-000000000001";
const SVC = "svc-key-must-not-be-used";

type Call = { url: string; init: RequestInit };

let db: ConsentDbState;
let gdprInserts: Array<Record<string, unknown>>;

function setupFetch(opts: { playerVisible?: boolean; insertStatus?: number } = {}) {
  db = emptyConsentDb();
  // Un jugador que el usuario VE bajo RLS existe en la base: fecha de nacimiento
  // desconocida por defecto (cada test que la necesita la fija tras setupFetch).
  if (opts.playerVisible) db.birthDates.p1 = null;
  // Solo las llamadas que NO son del gate (Bunny + RLS/fila con el JWT de usuario): los
  // tests de siempre asertan sobre estas. Las del gate de consentimiento (service role:
  // gdpr_audit_log, players.birth_date, parental_consents) las resuelve consentFetch.
  const calls: Call[] = [];
  const mock = consentFetch(db, {
    serviceKey: SVC,
    fallback: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://video.bunnycdn.com/library/42/videos" && init.method === "POST") {
        return new Response(JSON.stringify({ guid: GUID, title: "Partido" }), { status: 200 });
      }
      if (url === `https://video.bunnycdn.com/library/42/videos/${GUID}` && init.method === "DELETE") {
        return new Response("", { status: 200 });
      }
      if (url.startsWith("https://sb.test/rest/v1/players")) {
        return new Response(JSON.stringify(opts.playerVisible ? [{ id: "p1" }] : []), { status: 200 });
      }
      if (url === "https://sb.test/rest/v1/videos") {
        return new Response("", { status: opts.insertStatus ?? 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  gdprInserts = mock.inserts;
  vi.stubGlobal("fetch", mock.fn);
  return calls;
}

function post(body: Record<string, unknown>, opts: { attest?: boolean } = {}) {
  return new Request("https://x.test/api/upload/video-init", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt-123" },
    body: JSON.stringify(opts.attest === false ? body : { attestation: ATTESTATION, ...body }),
  });
}

describe("video-init", () => {
  beforeEach(() => {
    process.env.BUNNY_STREAM_LIBRARY_ID = "42";
    process.env.BUNNY_STREAM_API_KEY = "lib-key";
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    // La service key la usa SOLO el gate de consentimiento (gdpr_audit_log, fecha de
    // nacimiento, parental_consents), nunca la fila `videos`.
    process.env.SUPABASE_SERVICE_ROLE_KEY = SVC;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.VITE_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("firma TUS con caducidad now + 86400 (24 h) y firma SHA256(lib+key+exp+guid)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
    setupFetch();
    const res = await videoInit(post({ title: "Partido" }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const now = Math.floor(new Date("2026-09-28T12:00:00Z").getTime() / 1000);
    expect(data.authExpire).toBe(now + 86400);
    expect(data.authSignature).toBe(await sha256Hex(`42lib-key${now + 86400}${GUID}`));
    expect(data.videoId).toBe(GUID);
    expect(JSON.stringify(data)).not.toContain("lib-key"); // la API key nunca sale
  });

  it("inserta la fila `videos` con el JWT del USUARIO (no service role): id = bunny_video_id = guid + tenant del JWT", async () => {
    const calls = setupFetch({ playerVisible: true });
    const res = await videoInit(post({ title: "Partido", playerId: "p1", durationSec: 5400 }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.videoRow).toBe("inserted");

    const insert = calls.find((c) => c.url === "https://sb.test/rest/v1/videos")!;
    const headers = insert.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer user-jwt-123");
    expect(headers.apikey).toBe("anon-key");
    expect(JSON.stringify(headers)).not.toContain("svc-key");

    const row = JSON.parse(insert.init.body as string);
    expect(row).toMatchObject({
      id: GUID,
      bunny_video_id: GUID,
      user_id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "tenant-9",
      player_id: "p1",
      duration_sec: 5400,
      status: "created",
    });
    // Nada de métricas inventadas a 0 en la fila ni en el stub `data`
    expect(row).not.toHaveProperty("duration");
    expect(row.data).not.toHaveProperty("duration");
  });

  it("player_id solo si el jugador es visible bajo RLS para este usuario", async () => {
    const calls = setupFetch({ playerVisible: false });
    await videoInit(post({ title: "Partido", playerId: "p-ajeno" }));
    const row = JSON.parse(calls.find((c) => c.url === "https://sb.test/rest/v1/videos")!.init.body as string);
    expect(row).not.toHaveProperty("player_id");
  });

  it("076 · la búsqueda del jugador filtra por DUEÑO (user_id del JWT), no solo por lo que deje ver la RLS", async () => {
    const calls = setupFetch({ playerVisible: true });
    await videoInit(post({ title: "Partido", playerId: "p1" }));
    const lookup = calls.find((c) => c.url.startsWith("https://sb.test/rest/v1/players"))!;
    expect(lookup.url).toContain("id=eq.p1");
    expect(lookup.url).toContain("user_id=eq.11111111-1111-4111-8111-111111111111");
    expect(lookup.url).not.toContain("tenant");
  });

  it("sin duración del navegador NO se inventa duration_sec", async () => {
    const calls = setupFetch();
    await videoInit(post({ title: "Partido" }));
    const row = JSON.parse(calls.find((c) => c.url === "https://sb.test/rest/v1/videos")!.init.body as string);
    expect(row).not.toHaveProperty("duration_sec");
  });

  it("sin anon key (fila con JWT de usuario no posible) → no inserta la fila y la subida sigue", async () => {
    delete process.env.VITE_SUPABASE_ANON_KEY;
    const calls = setupFetch();
    const res = await videoInit(post({ title: "Partido" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.videoRow).toBe("skipped");
    expect(calls.some((c) => c.url.startsWith("https://sb.test"))).toBe(false);
    // …pero la declaración SÍ se guardó (service role) con el GUID.
    expect(gdprInserts).toHaveLength(1);
  });

  it("si el insert falla, la subida NO se rompe (best-effort)", async () => {
    setupFetch({ insertStatus: 403 });
    const res = await videoInit(post({ title: "Partido" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.videoRow).toBe("failed");
  });

  it("vídeo más largo que MAX_MATCH_DURATION_MIN → 422 sin crear nada en Bunny", async () => {
    const calls = setupFetch();
    const res = await videoInit(post({ title: "Maratón", durationSec: 151 * 60 }));
    expect(res.status).toBe(422);
    expect((await res.json()).errorDetail.code).toBe("video_duration_exceeds_match_limit");
    expect(calls).toHaveLength(0);
  });

  it("sin Bunny configurado → degradación elegante (phase2Pending) como antes", async () => {
    delete process.env.BUNNY_STREAM_LIBRARY_ID;
    setupFetch();
    const res = await videoInit(post({ title: "Partido" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: false, phase2Pending: true });
  });
});

describe("video-init · consentimiento (el webhook de Bunny analiza solo con la subida)", () => {
  beforeEach(() => {
    process.env.BUNNY_STREAM_LIBRARY_ID = "42";
    process.env.BUNNY_STREAM_API_KEY = "lib-key";
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SVC;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VITE_SUPABASE_ANON_KEY;
  });

  it("sin declaración → 400 attestation_required y NO se crea nada en Bunny ni en videos", async () => {
    const calls = setupFetch();
    const res = await videoInit(post({ title: "Partido" }, { attest: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail).toMatchObject({ code: "attestation_required", attestationVersion: "2026-09-28.v1" });
    expect(calls).toHaveLength(0);
    expect(gdprInserts).toHaveLength(0);
  });

  it("declaración de otra versión → 400 attestation_required", async () => {
    const calls = setupFetch();
    const res = await videoInit(post({ title: "Partido", attestation: { accepted: true, version: "2020-01-01.v0" } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("jugador visible, menor de 14 conocido, SIN consentimiento parental → 403 y NO se crea nada", async () => {
    const calls = setupFetch({ playerVisible: true });
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    const res = await videoInit(post({ title: "Partido", playerId: "p1" }));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(calls.filter((c) => c.url.includes("bunnycdn"))).toHaveLength(0);
    expect(gdprInserts).toHaveLength(0);
  });

  it("menor de 14 CON consentimiento verificado → sube y guarda la declaración con el GUID", async () => {
    setupFetch({ playerVisible: true });
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    db.activeConsents.push("p1");
    const res = await videoInit(post({ title: "Partido", playerId: "p1" }));
    expect(res.status).toBe(200);
    expect(gdprInserts[0]).toMatchObject({
      user_id: "11111111-1111-4111-8111-111111111111", // quién = usuario del JWT verificado
      action: "video_analysis_attested",
      resource_type: "videos",
      resource_id: GUID,
      metadata: { version: "2026-09-28.v1", player_id: "p1", bunny_video_id: GUID, endpoint: "upload/video-init" },
    });
  });

  it("fecha de nacimiento desconocida → basta la declaración (no se infiere la edad)", async () => {
    setupFetch({ playerVisible: true });
    db.birthDates.p1 = null;
    const res = await videoInit(post({ title: "Partido", playerId: "p1" }));
    expect(res.status).toBe(200);
  });

  it("jugador NO visible bajo RLS → no se ata al vídeo ni se consulta su edad (vídeo sin jugador)", async () => {
    setupFetch({ playerVisible: false });
    db.birthDates.p1 = MINOR_BIRTH_DATE; // si se consultara, bloquearía
    const res = await videoInit(post({ title: "Partido", playerId: "p1" }));
    expect(res.status).toBe(200);
    expect(gdprInserts[0]).toMatchObject({ metadata: { player_id: null } });
  });

  it("no se puede guardar la declaración → 500 consent_check_failed y se BORRA el vídeo de Bunny", async () => {
    const calls = setupFetch();
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    const res = await videoInit(post({ title: "Partido" }));
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("consent_check_failed");
    expect(calls.some((c) => c.init.method === "DELETE" && c.url.endsWith(`/videos/${GUID}`))).toBe(true);
    expect(calls.some((c) => c.url === "https://sb.test/rest/v1/videos")).toBe(false); // sin fila
  });
});
