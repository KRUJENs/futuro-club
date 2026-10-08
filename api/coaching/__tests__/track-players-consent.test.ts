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
