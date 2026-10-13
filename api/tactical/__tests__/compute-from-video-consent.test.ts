/**
 * Tests · POST /api/tactical/compute-from-video con el gate de consentimiento REAL
 * (decisión del owner, 30 sep). SOLO las llamadas con JWT de usuario traen y guardan la
 * declaración; la ruta de SERVICIO (cadena de modal-callback) NO cambia: ni se consulta
 * el gate ni cambia la petición a Modal.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/tactical/__tests__/compute-from-video-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: "22222222-2222-4222-8222-222222222222", error: null }),
}));
vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(),
}));
vi.mock("../../_lib/ownership", async (orig) => ({
  ...(await orig<typeof import("../../_lib/ownership")>()),
  ownsMatch: vi.fn(async () => true),
}));

const MODAL_URL = "https://modal.test/track";
const VIDEO_URL = "https://cdn.test/1a000000-0000-4000-8000-000000000001/play_720p.mp4";
const MODAL_OK = {
  status: "ok", duration_sec: 10, fps_source: 25, sample_fps: 5,
  players: [{ track_id: 1, timestamp_ms: 0, bbox: [0, 0, 10, 10], confidence: 0.9 }],
  ball: [],
};

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
let modalCalls: Array<{ url: string; init: RequestInit }>;

beforeAll(async () => {
  // El módulo lee MODAL_TRACK_URL / MODAL_API_KEY / INTERNAL_API_TOKEN al cargarse.
  process.env.MODAL_TRACK_URL = MODAL_URL;
  process.env.MODAL_API_KEY = "modal-key";
  process.env.INTERNAL_API_TOKEN = "svc-token";
  process.env.VITAS_PUBLIC_URL = "https://vitas.test";
  handler = (await import("../_compute-from-video")).default;
});

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  // Allowlist de hosts de vídeo (api/_lib/videoUrlGuard): la pull zone de Stream de los tests.
  process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
  delete process.env.VITE_BUNNY_CDN_HOSTNAME;
  delete process.env.BUNNY_STORAGE_CDN_URL;
  delete process.env.VIDEO_URL_EXTRA_HOSTS;
  db = emptyConsentDb();
  db.videos.push({ id: "1a000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-000000000001" });
  modalCalls = [];
  mock = consentFetch(db, {
    fallback: async (url, init) => {
      if (url === MODAL_URL) {
        modalCalls.push({ url, init });
        return new Response(JSON.stringify(MODAL_OK), { status: 200 });
      }
      if (url === "https://vitas.test/api/tactical/compute-heatmap") {
        return new Response(JSON.stringify({ data: { phasesDetected: 1, heatmapsComputed: 1, playerCount: 1 } }), { status: 200 });
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
    new Request("https://x.test/api/tactical/compute-from-video", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ matchId: "m-1", videoUrl: VIDEO_URL, ...body }),
    }),
  );

const EXPECTED_MODAL_BODY = JSON.stringify({ video_url: VIDEO_URL, sample_fps: 5, classes: [0, 32] });

describe("compute-from-video · consentimiento", () => {
  it("usuario sin declaración → 400 attestation_required; Modal no se llama", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(modalCalls).toHaveLength(0);
  });

  it("usuario declarado → se guarda y Modal recibe el body de siempre", async () => {
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "1a000000-0000-4000-8000-000000000001", metadata: { endpoint: "tactical/compute-from-video" } });
    expect(modalCalls[0].init.body).toBe(EXPECTED_MODAL_BODY);
  });

  it("B1 · vídeo (fila propia) de un menor de 14 sin consentimiento → 403; Modal no se llama", async () => {
    db.videos[0].player_id = "pMinor";
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.playerOwners.pMinor = USER; // jugador propio (B5)
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(modalCalls).toHaveLength(0);
  });

  it("B2 · vídeo de OTRO usuario por el GUID de la URL → 403; URL sin fila → 404; Modal no se llama", async () => {
    db.videos[0].user_id = "99999999-9999-4999-8999-999999999999";
    expect((await post({ attestation: ATTESTATION })).status).toBe(403);
    expect((await post({ attestation: ATTESTATION, videoUrl: "https://cdn.test/1c000000-0000-4000-8000-000000000001/play.mp4" })).status).toBe(404);
    expect(modalCalls).toHaveLength(0);
  });

  it("SERVICIO (cadena de modal-callback) → sin gate y misma petición a Modal", async () => {
    const res = await post({}, "Bearer svc-token");
    expect(res.status).toBe(200);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(modalCalls).toHaveLength(1);
    expect(modalCalls[0].init.body).toBe(EXPECTED_MODAL_BODY);
    expect((modalCalls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer modal-key");
  });
});

// Ronda 5 de la review del PR #308 (B7): la declaración tiene que quedar ligada a los PÍXELES
// que analiza Modal (antes: `https://atacante/<GUID propio declarado>/otro.mp4` pasaba el gate
// y Modal recibía esa URL cruda).
describe("compute-from-video · ronda 5 (B7): Modal recibe EXACTAMENTE la URL que comprobó el gate", () => {
  const OWN_GUID = "1a000000-0000-4000-8000-000000000001"; // fila propia de beforeEach

  it.each([
    ["con la declaración en el body", { attestation: ATTESTATION }],
    ["con la declaración ya guardada con el vídeo", {}],
  ])("host AJENO con el GUID de un vídeo propio (%s) → 400 VIDEO_URL_NOT_ALLOWED; ni gate, ni Modal", async (_l, extra) => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: OWN_GUID });
    const res = await post({ videoUrl: `https://attacker.example/${OWN_GUID}/other.mp4`, ...extra });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_URL_NOT_ALLOWED");
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(mock.inserts).toHaveLength(0);
    expect(modalCalls).toHaveLength(0);
  });

  it("pull zone de STORAGE con el GUID propio como carpeta → 400 invalid_video_reference; ni Modal", async () => {
    process.env.BUNNY_STORAGE_CDN_URL = "https://storage.test";
    const res = await post({ videoUrl: `https://storage.test/${OWN_GUID}/x.mp4`, attestation: ATTESTATION });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("invalid_video_reference");
    expect(modalCalls).toHaveLength(0);
  });

  it("sin BUNNY_CDN_HOSTNAME → 500 VIDEO_HOSTS_NOT_CONFIGURED (nunca 503); ni Modal", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    expect(modalCalls).toHaveLength(0);
  });

  it("la URL NORMALIZADA es la que se comprueba y la que recibe Modal (misma cadena)", async () => {
    const res = await post({ videoUrl: `https://CDN.TEST/./${OWN_GUID}/play_720p.mp4`, attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(modalCalls[0].init.body).toBe(EXPECTED_MODAL_BODY);
  });

  it("SERVICIO: sin allowlist ni gate (contrato intacto), también sin BUNNY_CDN_HOSTNAME", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await post({}, "Bearer svc-token");
    expect(res.status).toBe(200);
    expect(modalCalls[0].init.body).toBe(EXPECTED_MODAL_BODY);
  });
});
