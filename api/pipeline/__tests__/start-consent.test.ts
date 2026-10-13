/**
 * Tests · POST /api/pipeline/start (SoloDrill, /drill) con el gate de consentimiento REAL
 * (decisión del owner, 30 sep): jugador propio, declaración (guardada con la fila `videos`
 * de la subida, o en el body) y consentimiento parental de un menor de 14 conocido, todo
 * ANTES de leer Bunny/jugador y de llamar a Claude.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/pipeline/__tests__/start-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 19, limit: 20, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
const ownsPlayer = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../_lib/ownership", async (orig) => ({
  ...(await orig<typeof import("../../_lib/ownership")>()),
  ownsPlayer: (...a: unknown[]) => ownsPlayer(...a),
}));

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
const claudeCalls = () => mock.calls.filter((c) => c.url.includes("api.anthropic.com"));

beforeAll(async () => {
  handler = (await import("../_start")).default;
});

beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.BUNNY_STREAM_LIBRARY_ID;
  delete process.env.BUNNY_STREAM_API_KEY;
  ownsPlayer.mockReset();
  ownsPlayer.mockImplementation(async () => true);
  db = emptyConsentDb();
  db.birthDates.p1 = null;
  mock = consentFetch(db, {
    fallback: async (url) => {
      if (url.includes("api.anthropic.com")) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

const post = (body: Record<string, unknown>) =>
  handler(
    new Request("https://x.test/api/pipeline/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ videoId: "1b000000-0000-4000-8000-000000000001", playerId: "p1", ...body }),
    }),
  );

describe("pipeline/start · B1/B2: el vídeo y su jugador los resuelve el SERVIDOR", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999";
  const postRaw = (body: Record<string, unknown>) =>
    handler(
      new Request("https://x.test/api/pipeline/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify(body),
      }),
    );

  it("B1 · sin playerId, el vídeo (fila propia) de un menor de 14 sin consentimiento → 403; Claude no se llama", async () => {
    db.videos.push({ id: "1b000000-0000-4000-8000-000000000002", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1b000000-0000-4000-8000-000000000002" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1b000000-0000-4000-8000-000000000002" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const res = await postRaw({ videoId: "1b000000-0000-4000-8000-000000000002" });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(claudeCalls()).toHaveLength(0);
  });

  it("B1 · con el playerId de OTRO jugador propio, el menor del vídeo se sigue comprobando → 403", async () => {
    db.videos.push({ id: "1b000000-0000-4000-8000-000000000002", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1b000000-0000-4000-8000-000000000002" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1b000000-0000-4000-8000-000000000002" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const res = await postRaw({ videoId: "1b000000-0000-4000-8000-000000000002", playerId: "p1" });
    expect(res.status).toBe(403);
    expect(claudeCalls()).toHaveLength(0);
  });

  it("B2 · GUID de Bunny de la fila create-upload de OTRO usuario (id vid-x) → 403 forbidden; ni Claude ni declaración guardada", async () => {
    ownsPlayer.mockImplementation(async (pid) => pid === "p1"); // pMinor NO es del usuario
    db.videos.push({ id: "vid-x", user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const res = await postRaw({ videoId: "1a000000-0000-4000-8000-00000000000a", attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(claudeCalls()).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
    // Control: la MISMA fila pedida por su id (vid-x) ya daba 403 antes del arreglo; desde
    // B4, `vid-x` no es un GUID de Bunny (es lo que iría en la URL) → 400 antes de buscar.
    const byId = await postRaw({ videoId: "vid-x", attestation: ATTESTATION });
    expect(byId.status).toBe(400);
    expect((await byId.json()).errorDetail.code).toBe("invalid_video_reference");
    expect(claudeCalls()).toHaveLength(0);
  });

  it("B2 · fila PROPIA duplicada que apunta al GUID de un vídeo ajeno → 403 (todas las filas de ese vídeo cuentan)", async () => {
    ownsPlayer.mockImplementation(async (pid) => pid === "p1");
    db.videos.push({ id: "mine", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    db.videos.push({ id: "1a000000-0000-4000-8000-00000000000b", user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: "1a000000-0000-4000-8000-00000000000b" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "mine" });
    const res = await postRaw({ videoId: "1a000000-0000-4000-8000-00000000000b" });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(claudeCalls()).toHaveLength(0);
  });

  it("videoId que no es ninguna fila `videos` → 404 video_not_found (el servidor analiza la miniatura de Bunny de ese GUID)", async () => {
    const res = await postRaw({ videoId: "1b000000-0000-4000-8000-000000000004", attestation: ATTESTATION });
    expect(res.status).toBe(404);
    expect((await res.json()).errorDetail.code).toBe("video_not_found");
    expect(claudeCalls()).toHaveLength(0);
  });
});

describe("pipeline/start · consentimiento", () => {
  beforeEach(() => {
    // SoloDrill sube por VideoUpload → fila `videos` propia con id = GUID (video-init).
    db.videos.push({ id: "1b000000-0000-4000-8000-000000000001", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: "1b000000-0000-4000-8000-000000000001" });
  });

  it("jugador AJENO → 403 antes de leer su fecha de nacimiento", async () => {
    ownsPlayer.mockImplementation(async () => false);
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/players"))).toBe(false);
    expect(claudeCalls()).toHaveLength(0);
  });

  it("sin declaración (ni guardada con la fila ni en el body) → 400 attestation_required; Claude no se llama", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(claudeCalls()).toHaveLength(0);
  });

  it("menor de 14 conocido sin consentimiento parental → 403", async () => {
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(claudeCalls()).toHaveLength(0);
  });

  it("vídeo subido por VideoUpload (fila videos propia + declaración guardada) → se analiza", async () => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: "1b000000-0000-4000-8000-000000000001" });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(mock.inserts).toHaveLength(0);
    expect(claudeCalls()).toHaveLength(1);
  });
});

describe("pipeline/start · B4: el id que se busca es EXACTAMENTE el que va en la URL de Bunny", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999";
  const G_OWN = "0a0a0a0a-0000-4000-8000-000000000001";
  const G_VICTIM = "0b0b0b0b-0000-4000-8000-000000000002";
  const bunnyCalls = () => mock.calls.filter((c) => c.url.startsWith("https://video.bunnycdn.com/"));
  const postRaw = (body: Record<string, unknown>) =>
    handler(
      new Request("https://x.test/api/pipeline/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(() => {
    process.env.BUNNY_STREAM_LIBRARY_ID = "123";
    process.env.BUNNY_STREAM_API_KEY = "bunny-key";
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
    mock = consentFetch(db, {
      fallback: async (url) => {
        if (url.includes("api.anthropic.com")) {
          return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
        }
        if (url.startsWith("https://video.bunnycdn.com/library/123/videos/")) {
          return new Response(JSON.stringify({ length: 10, width: 1280, height: 720, status: 4 }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    vi.stubGlobal("fetch", mock.fn);
  });
  afterEach(() => {
    delete process.env.BUNNY_STREAM_LIBRARY_ID;
    delete process.env.BUNNY_STREAM_API_KEY;
    delete process.env.BUNNY_CDN_HOSTNAME;
  });

  it("fila PROPIA con id 'a/../<GUID ajeno>' (sin jugador) → 400 invalid_video_reference; ni base, ni Bunny, ni Claude", async () => {
    db.videos.push({ id: `a/../${G_VICTIM}`, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: null });
    db.videos.push({ id: G_VICTIM, user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: G_VICTIM });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const res = await postRaw({ videoId: `a/../${G_VICTIM}`, attestation: ATTESTATION });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("invalid_video_reference");
    expect(bunnyCalls()).toHaveLength(0);
    expect(claudeCalls()).toHaveLength(0);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
  });

  it.each([`${G_OWN}/../${G_VICTIM}`, `../${G_VICTIM}`, `${G_VICTIM}%2F..`, "guid-1", `${G_VICTIM}?x=1`])(
    "videoId que no es un GUID de Bunny (%j) → 400 sin tocar nada",
    async (videoId) => {
      const res = await postRaw({ videoId, attestation: ATTESTATION });
      expect(res.status).toBe(400);
      expect(bunnyCalls()).toHaveLength(0);
      expect(claudeCalls()).toHaveLength(0);
    },
  );

  it("control: el MISMO truco sobre el GUID ajeno directamente ya daba 403 (fila de otro usuario)", async () => {
    ownsPlayer.mockImplementation(async (pid) => pid === "p1");
    db.videos.push({ id: G_VICTIM, user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: G_VICTIM });
    const res = await postRaw({ videoId: G_VICTIM, attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect(bunnyCalls()).toHaveLength(0);
  });

  it("GUID propio válido → la API de Bunny y la miniatura que va a Claude son las de ESE GUID", async () => {
    db.videos.push({ id: G_OWN, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: G_OWN });
    db.storedAttestations.push({ resource_type: "videos", resource_id: G_OWN });
    const res = await postRaw({ videoId: G_OWN });
    expect(res.status).toBe(200);
    expect(bunnyCalls().map((c) => c.url)).toEqual([`https://video.bunnycdn.com/library/123/videos/${G_OWN}`]);
    const claudeBody = JSON.parse(String(claudeCalls()[0].init.body));
    expect(claudeBody.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "url", url: `https://cdn.test/${G_OWN}/thumbnail.jpg?time=2` },
    });
  });
});
