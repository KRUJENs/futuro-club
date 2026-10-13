/**
 * Tests · POST /api/videos/create-upload con el gate de consentimiento REAL (decisión del
 * owner, 30 sep). La subida siembra un análisis automático (webhook de Bunny → cola), así
 * que la declaración se exige y se GUARDA con el id del vídeo ANTES de crear nada en Bunny.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/videos/__tests__/create-upload-consent.test.ts
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
vi.mock("../../_lib/ownership", async (orig) => ({
  ...(await orig<typeof import("../../_lib/ownership")>()),
  ownsPlayer: vi.fn(async () => true),
}));

const videoInserts: Array<Record<string, unknown>> = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "players") {
        const c = { select: () => c, eq: () => c, single: async () => ({ data: { id: "p1", tenant_id: null, name: "Jugador" }, error: null }) };
        return c;
      }
      if (table === "videos") {
        return {
          insert: (row: Record<string, unknown>) => {
            videoInserts.push(row);
            const c = { select: () => c, single: async () => ({ data: { id: row.id }, error: null }) };
            return c;
          },
        };
      }
      throw new Error(`tabla inesperada ${table}`);
    },
  }),
}));

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
let bunnyCreates = 0;

beforeAll(async () => {
  // create-upload lee el env de Bunny al cargar el módulo.
  process.env.BUNNY_STREAM_LIBRARY_ID = "42";
  process.env.BUNNY_STREAM_API_KEY = "lib-key";
  process.env.VITE_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  handler = (await import("../create-upload")).default;
});

beforeEach(() => {
  videoInserts.length = 0;
  bunnyCreates = 0;
  db = emptyConsentDb();
  db.birthDates.p1 = null;
  mock = consentFetch(db, {
    fallback: async (url, init) => {
      if (url === "https://video.bunnycdn.com/library/42/videos" && init.method === "POST") {
        bunnyCreates++;
        return new Response(JSON.stringify({ guid: "bunny-guid-1" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: Record<string, unknown>) =>
  handler(
    new Request("https://x.test/api/videos/create-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerId: "p1", title: "Clip", ...body }),
    }),
  );

describe("create-upload · consentimiento", () => {
  it("sin declaración → 400 attestation_required; ni Bunny ni fila videos", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail).toMatchObject({ code: "attestation_required", attestationVersion: "2026-09-28.v1" });
    expect(bunnyCreates).toBe(0);
    expect(videoInserts).toHaveLength(0);
  });

  it("menor de 14 conocido sin consentimiento parental → 403; ni Bunny ni fila", async () => {
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(bunnyCreates).toBe(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it("declarada → la declaración se guarda con el MISMO id que la fila videos (la usa el webhook)", async () => {
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(videoInserts).toHaveLength(1);
    expect(json.data.videoId).toBe(videoInserts[0].id);
    expect(mock.inserts[0]).toMatchObject({
      user_id: USER,
      action: "video_analysis_attested",
      resource_type: "videos",
      resource_id: videoInserts[0].id,
      metadata: { version: "2026-09-28.v1", scope: "player", player_id: "p1", endpoint: "videos/create-upload" },
    });
  });

  it("no se puede guardar la declaración → 500 consent_check_failed y NO se crea el vídeo", async () => {
    db.failures.gdpr_insert = { status: 401, body: "permission denied" };
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(500);
    expect((await res.json()).errorDetail.code).toBe("consent_check_failed");
    expect(bunnyCreates).toBe(0);
    expect(videoInserts).toHaveLength(0);
  });
});
