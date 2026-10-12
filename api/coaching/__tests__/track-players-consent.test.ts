/**
 * Tests · POST /api/coaching/track-players (proxy síncrono a Modal) con el gate de
 * consentimiento REAL (decisión del owner, 30 sep). Las llamadas de USUARIO traen la
 * declaración; un bloqueo es 400/500, NUNCA 503 (el cliente trata 503 como «inferencia
 * apagada → mock»). El contrato con Modal no cambia y las llamadas de servicio tampoco.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/coaching/__tests__/track-players-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(),
}));

import { recordSpendUsd } from "../../_lib/budgetGuard";

const MODAL_URL = "https://modal.test/track";
const VIDEO_URL = "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4";
const MODAL_OK = {
  status: "ok", duration_sec: 10, frames_processed: 50, fps_source: 25, sample_fps: 5,
  players: [], ball: [], ball_stops: [], total_player_tracks: 0, total_ball_detections: 0,
};

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
let modalCalls: Array<{ url: string; init: RequestInit }>;

beforeAll(async () => {
  handler = (await import("../_track-players")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MODAL_TRACK_URL = MODAL_URL;
  process.env.MODAL_API_KEY = "modal-key";
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  process.env.INTERNAL_API_TOKEN = "svc-token";
  // Allowlist de hosts de vídeo (api/_lib/videoUrlGuard): la pull zone de Stream de los tests.
  process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
  delete process.env.VITE_BUNNY_CDN_HOSTNAME;
  delete process.env.BUNNY_STORAGE_CDN_URL;
  delete process.env.VIDEO_URL_EXTRA_HOSTS;
  db = emptyConsentDb();
  // Vídeo de equipo propio (sin jugador) en nuestro CDN → fila `videos` id = GUID.
  db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
  modalCalls = [];
  mock = consentFetch(db, {
    fallback: async (url, init) => {
      if (url === MODAL_URL) {
        modalCalls.push({ url, init });
        return new Response(JSON.stringify(MODAL_OK), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.BUNNY_CDN_HOSTNAME;
  delete process.env.BUNNY_STORAGE_CDN_URL;
  delete process.env.VIDEO_URL_EXTRA_HOSTS;
});

const post = (body: Record<string, unknown>, auth = "Bearer user-jwt") =>
  handler(
    new Request("https://x.test/api/coaching/track-players", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    }),
  );

describe("track-players · consentimiento", () => {
  it("sin declaración → 400 attestation_required (no 503); ni gasto ni Modal", async () => {
    const res = await post({ videoUrl: VIDEO_URL });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it("base caída → 500 consent_check_failed (nunca 503 → el cliente no cae a mock en silencio)", async () => {
    db.failures.gdpr_audit_log = { status: 500, body: "boom" };
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(500);
    expect(modalCalls).toHaveLength(0);
  });

  it("los 503/400 de siempre van ANTES del gate (pingTrackingPipeline manda videoUrl vacío)", async () => {
    const res = await post({ videoUrl: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_fields");
    expect(mock.calls).toHaveLength(0);
  });

  it("declarada → se guarda y Modal recibe el MISMO body y Bearer que antes", async () => {
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000001", metadata: { endpoint: "coaching/track-players" } });
    expect(modalCalls).toHaveLength(1);
    expect((modalCalls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer modal-key");
    const sent = JSON.parse(String(modalCalls[0].init.body));
    expect(sent).not.toHaveProperty("attestation");
    expect(sent.video_url).toBe(VIDEO_URL);
  });

  it("llamada de SERVICIO → el gate no se consulta", async () => {
    const res = await post({ videoUrl: VIDEO_URL }, "Bearer svc-token");
    expect(res.status).toBe(200);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(modalCalls).toHaveLength(1);
  });
});

describe("track-players · B1/B2: el jugador del vídeo lo resuelve el SERVIDOR", () => {
  it("B1 · vídeo (fila propia) de un menor de 14 sin consentimiento → 403 (no 503); ni gasto ni Modal", async () => {
    db.videos[0].player_id = "pMinor";
    db.playerOwners.pMinor = USER; // su propio jugador (B5: uno ajeno daría forbidden)
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it("B2 · vídeo de OTRO usuario (fila create-upload encontrada por el GUID de la URL) → 403", async () => {
    db.videos[0] = { id: "vid-x", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" };
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect(modalCalls).toHaveLength(0);
  });

  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
  ])("B5 · fila PROPIA ligada a un jugador AJENO (%s) → 403 forbidden igual; sin leer su fecha; ni gasto ni Modal", async (_label, bd) => {
    db.videos[0].player_id = "pForeign";
    db.birthDates.pForeign = bd;
    db.playerOwners.pForeign = "99999999-9999-4999-8999-999999999999";
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(mock.calls.some((c) => c.url.includes("select=birth_date"))).toBe(false);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/parental_consents"))).toBe(false);
    expect(mock.inserts).toHaveLength(0);
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it("URL sin fila `videos` → 404 video_not_found (nunca 503); ni gasto ni Modal", async () => {
    const res = await post({ videoUrl: "https://cdn.test/1c000000-0000-4000-8000-000000000001/play.mp4", attestation: ATTESTATION });
    expect(res.status).toBe(404);
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });
});

// Ronda 5 de la review del PR #308 (B7): la declaración tiene que quedar ligada a los PÍXELES
// que analiza Modal. Antes el gate sacaba el GUID del primer segmento de la ruta de CUALQUIER
// host y Modal recibía la URL cruda del body: `https://atacante/<GUID propio declarado>/otro.mp4`
// pasaba el gate (fila propia, declaración) y Modal analizaba un contenido sin declaración.
describe("track-players · ronda 5 (B7): Modal recibe EXACTAMENTE la URL que comprobó el gate", () => {
  const OWN_GUID = "1a000000-0000-4000-8000-000000000001"; // fila propia de beforeEach

  it.each([
    ["con la declaración en el body", { attestation: ATTESTATION }],
    ["con la declaración ya guardada con el vídeo", {}],
  ])("host AJENO con el GUID de un vídeo propio (%s) → 400 VIDEO_URL_NOT_ALLOWED; ni gate, ni gasto, ni Modal", async (_l, extra) => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: OWN_GUID });
    const res = await post({ videoUrl: `https://attacker.example/${OWN_GUID}/other.mp4`, ...extra });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_URL_NOT_ALLOWED");
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(mock.inserts).toHaveLength(0);
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it("pull zone de STORAGE (en la allowlist, pero su primer segmento es una carpeta, no un vídeo) → 400 invalid_video_reference; ni Modal", async () => {
    // api/upload/image escribe en Storage en la ruta que manda el cliente: `<GUID propio>/x.mp4`
    // no identifica el vídeo de Stream cuya declaración se comprueba.
    process.env.BUNNY_STORAGE_CDN_URL = "https://storage.test";
    const res = await post({ videoUrl: `https://storage.test/${OWN_GUID}/x.mp4`, attestation: ATTESTATION });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("invalid_video_reference");
    expect(mock.inserts).toHaveLength(0);
    expect(modalCalls).toHaveLength(0);
  });

  // Ronda 6 (B7 residual): tras el GUID declarado, `..%2F<GUID ajeno>%2F…` llegaba a Modal tal
  // cual (WHATWG no resuelve %2F). Ahora la ruta tiene que ser exactamente /<guid>/<fichero>.
  it.each([
    `https://cdn.test/${OWN_GUID}/..%2F1c000000-0000-4000-8000-000000000009%2Fplay_720p.mp4`,
    `https://cdn.test/${OWN_GUID}/1c000000-0000-4000-8000-000000000009/play_720p.mp4`,
  ])("GUID propio declarado + ruta hacia OTRO vídeo (%s) → 400 invalid_video_reference; ni gasto ni Modal", async (videoUrl) => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: OWN_GUID });
    const res = await post({ videoUrl, attestation: ATTESTATION });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("invalid_video_reference");
    expect(mock.inserts).toHaveLength(0);
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it("sin BUNNY_CDN_HOSTNAME → 500 VIDEO_HOSTS_NOT_CONFIGURED (NUNCA 503: el cliente lo trataría como «mock»); ni Modal", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    expect(modalCalls).toHaveLength(0);
  });

  it("la URL NORMALIZADA es la que se comprueba y la que recibe Modal (misma cadena)", async () => {
    const res = await post({ videoUrl: `https://CDN.TEST/./${OWN_GUID}/play_720p.mp4`, attestation: ATTESTATION });
    expect(res.status).toBe(200);
    const videoQueries = mock.calls.filter((c) => c.url.includes("/rest/v1/videos")).map((c) => decodeURIComponent(c.url));
    expect(videoQueries.some((u) => u.includes(OWN_GUID))).toBe(true);
    expect(JSON.parse(String(modalCalls[0].init.body)).video_url).toBe(`https://cdn.test/${OWN_GUID}/play_720p.mp4`);
  });

  it("control positivo: la MISMA petición con nuestra pull zone → 200 y Modal", async () => {
    const res = await post({ videoUrl: VIDEO_URL, attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(modalCalls).toHaveLength(1);
  });

  it("SERVICIO: sin allowlist ni gate (contrato de Modal intacto) · body.videoUrl tal cual, también sin BUNNY_CDN_HOSTNAME", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await post({ videoUrl: VIDEO_URL, sampleFps: 3 }, "Bearer svc-token");
    expect(res.status).toBe(200);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(String(modalCalls[0].init.body)).toBe(JSON.stringify({ video_url: VIDEO_URL, sample_fps: 3, classes: [0, 32] }));
    expect((modalCalls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer modal-key");
  });
});
