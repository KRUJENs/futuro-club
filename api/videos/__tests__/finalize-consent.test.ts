/**
 * Tests · POST /api/videos/finalize con el gate de consentimiento REAL (resolución del
 * vídeo + declaración + consentimiento parental). Mismo defecto que B1 de la review del
 * PR #308: antes el jugador del consentimiento era `body.playerId ?? videos.player_id`,
 * así que elegir OTRO jugador al analizar dejaba sin comprobar al menor del vídeo; y la
 * fila se leía solo por id, sin mirar otras filas con el mismo GUID de Bunny.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/videos/__tests__/finalize-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
// El jugador elegido es del usuario (ownership.ts tiene sus propios tests); ownsVideo es el REAL.
vi.mock("../../_lib/ownership", async (orig) => ({
  ...(await orig<typeof import("../../_lib/ownership")>()),
  ownsPlayer: vi.fn(async (pid: string) => pid === "p1"),
}));
const enqueueMock = vi.fn();
vi.mock("../../_lib/enqueueAnalysis", () => ({
  enqueueAnalysis: (...args: unknown[]) => enqueueMock(...args),
}));

/** La fila que finalize lee con supabase-js (select … eq(id) … single). */
const row: { current: Record<string, unknown> } = { current: {} };
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => (table === "players" ? { data: { tenant_id: null }, error: null } : { data: row.current, error: null }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

process.env.BUNNY_STREAM_LIBRARY_ID = "42";
process.env.BUNNY_STREAM_API_KEY = "lib-key";
process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../finalize")).default;
});

let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
const bunnyCalls = () => mock.calls.filter((c) => c.url.startsWith("https://video.bunnycdn.com/"));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
  db = emptyConsentDb();
  mock = consentFetch(db, {
    fallback: async (url) => {
      if (url.startsWith("https://video.bunnycdn.com/library/42/videos/")) {
        return new Response(JSON.stringify({ guid: "g-1", status: 4, length: 60, width: 1920, height: 1080 }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: Record<string, unknown>) =>
  handler(
    new Request("https://x.test/api/videos/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify(body),
    }),
  );

function videoRow(r: { id: string; user_id: string | null; player_id: string | null; bunny_video_id: string | null }) {
  row.current = { ...r, tenant_id: null, duration_sec: null };
  db.videos.push({ ...r, tenant_id: null });
}

describe("finalize · el jugador del VÍDEO cuenta aunque se elija otro al analizar (B1)", () => {
  it("vídeo de un menor de 14 sin consentimiento + playerId de OTRO jugador propio → 403; ni Bunny ni encolar", async () => {
    videoRow({ id: "g-1", user_id: USER, player_id: "pMinor", bunny_video_id: "g-1" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.birthDates.p1 = null;
    const res = await post({ videoId: "g-1", bunnyVideoId: "g-1", playerId: "p1", attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(bunnyCalls()).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(mock.inserts).toHaveLength(0);
  });

  it("control: el mismo vídeo con su menor CON consentimiento verificado → se encola para el jugador elegido", async () => {
    videoRow({ id: "g-1", user_id: USER, player_id: "pMinor", bunny_video_id: "g-1" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.activeConsents.push("pMinor");
    db.birthDates.p1 = null;
    const res = await post({ videoId: "g-1", bunnyVideoId: "g-1", playerId: "p1", attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({ videoId: "g-1", playerId: "p1" });
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "g-1", metadata: { player_id: "p1", endpoint: "videos/finalize" } });
  });
});

describe("finalize · todas las filas del vídeo de Bunny (B2)", () => {
  it("la fila propia aún sin GUID + otra fila AJENA que ya apunta a ese GUID → 403 (no se siembra un vídeo ajeno)", async () => {
    videoRow({ id: "mine", user_id: USER, player_id: null, bunny_video_id: null });
    db.videos.push({ id: "vid-v", user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: "g-v" });
    db.birthDates.p1 = null;
    const res = await post({ videoId: "mine", bunnyVideoId: "g-v", playerId: "p1", attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(bunnyCalls()).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("la fila propia aún sin GUID y nadie más con ese GUID → se siembra y se encola (sin regresión)", async () => {
    videoRow({ id: "mine", user_id: USER, player_id: null, bunny_video_id: null });
    db.birthDates.p1 = null;
    const res = await post({ videoId: "mine", bunnyVideoId: "g-new", playerId: "p1", attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: "mine", metadata: { bunny_video_id: "g-new" } });
  });
});
