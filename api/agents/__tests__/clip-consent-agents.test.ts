/**
 * Tests · gate de consentimiento REAL en los agentes de vídeo (decisión del owner, 30 sep):
 *   - video-observation (llamadas con JWT de USUARIO: TeamBaselinePage, CompareRivalPage):
 *     vídeo guardado propio + URL de ESE vídeo + declaración (del body o guardada con el
 *     vídeo) + consentimiento parental si el jugador del vídeo es menor de 14 conocido.
 *     Las llamadas de SERVICIO (cola, gemini-analyze, live/aggregate) no pasan por aquí.
 *   - team-observation y team-intelligence (vídeo de equipo del navegador): la declaración
 *     viaja en CADA petición y se guarda; la comprobación por jugador no aplica.
 * Siempre ANTES del tripwire de gasto y de Gemini/Claude.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/clip-consent-agents.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("../../_lib/usageGuard", () => ({
  checkUsageQuota: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  usageExceededResponse: vi.fn(),
}));

vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async () => new Response("{}", { status: 500 })),
}));

import { recordSpendUsd } from "../../_lib/budgetGuard";
import { fetchMessages } from "../../_lib/anthropic";
import videoObservation from "../video-observation";
import teamObservation from "../team-observation";
import teamIntelligence from "../_team-intelligence";

const CDN = "cdn.test";
const GUID = "1a000000-0000-4000-8000-000000000001";
const VIDEO_URL = `https://${CDN}/${GUID}/play_720p.mp4`;
const OBS = { resumenGeneral: "ok" };

let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
const isGemini = (u: string) => u.includes("generativelanguage.googleapis.com");
const geminiCalls = () => mock.calls.filter((c) => isGemini(c.url));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.BUNNY_CDN_HOSTNAME = CDN;
  process.env.INTERNAL_API_TOKEN = "svc-token";
  process.env.ANTHROPIC_API_KEY = "test-key";
  db = emptyConsentDb();
  db.videos.push({ id: GUID, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: GUID });
  mock = consentFetch(db, {
    fallback: async (url) => {
      if (isGemini(url)) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(OBS) }] } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith(`https://${CDN}/`)) {
        return new Response(new Uint8Array([0, 0, 0, 0x18]), { status: 200, headers: { "content-type": "video/mp4" } });
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
});

function post(path: string, body: Record<string, unknown>, auth = "Bearer user-jwt"): Request {
  return new Request(`https://x.test/api/agents/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
}

const teamObsBody = (extra: Record<string, unknown> = {}) => ({
  analysisScope: "team",
  playerContext: { name: "Equipo propio" },
  videoUrl: VIDEO_URL,
  ...extra,
});

describe("video-observation · llamadas de USUARIO", () => {
  it("sin videoId → 400 video_reference_required; ni gasto ni Gemini", async () => {
    const res = await videoObservation(post("video-observation", teamObsBody({ attestation: ATTESTATION })));
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("video_reference_required");
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(geminiCalls()).toHaveLength(0);
  });

  it("fichero en base64 → 400 (no se puede ligar a ningún vídeo guardado)", async () => {
    const res = await videoObservation(
      post("video-observation", { analysisScope: "team", playerContext: { name: "x" }, videoBase64: "AAAA", videoId: GUID }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("video_reference_required");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("vídeo sin declaración guardada ni en el body → 400 attestation_required", async () => {
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID })));
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("vídeo AJENO → 403 aunque traiga declaración", async () => {
    db.videos[0].user_id = "99999999-9999-4999-8999-999999999999";
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect(geminiCalls()).toHaveLength(0);
  });

  it("URL de OTRO vídeo de nuestro CDN → 400 video_url_mismatch", async () => {
    const res = await videoObservation(
      post("video-observation", teamObsBody({ videoId: GUID, attestation: ATTESTATION, videoUrl: `https://${CDN}/1c000000-0000-4000-8000-000000000003/play_720p.mp4` })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("video_url_mismatch");
  });

  it("declaración YA guardada con el vídeo (la de VideoUpload) → se analiza sin pedirla otra vez", async () => {
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID });
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID })));
    expect(res.status).toBe(200);
    expect(geminiCalls()).toHaveLength(1);
    expect(mock.inserts).toHaveLength(0); // no se re-declara nada
  });

  it("vídeo con jugador menor de 14 conocido y sin consentimiento parental → 403", async () => {
    db.videos[0].player_id = "p1";
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    db.playerOwners.p1 = USER; // jugador propio (B5)
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID });
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("URL de OTRO vídeo que solo CONTIENE el GUID propio en un segmento posterior → 400 video_url_mismatch", async () => {
    // Pull zone: el vídeo que se descarga es el del PRIMER segmento (`otro`), no el del GUID propio.
    const res = await videoObservation(
      post("video-observation", teamObsBody({ videoId: GUID, attestation: ATTESTATION, videoUrl: `https://${CDN}/1c000000-0000-4000-8000-000000000003/${GUID}/play_720p.mp4` })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("video_url_mismatch");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("B2 · otra fila (de OTRO usuario) apunta al mismo vídeo de Bunny → 403; Gemini no se llama", async () => {
    db.videos.push({ id: "vid-v", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: "pMinor", bunny_video_id: GUID });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID });
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID })));
    expect(res.status).toBe(403);
    expect(geminiCalls()).toHaveLength(0);
  });

  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
  ])("B5 · vídeo PROPIO ligado a un jugador AJENO (%s) → 403 forbidden igual; sin leer su fecha; Gemini no se llama", async (_label, bd) => {
    db.videos[0].player_id = "pForeign";
    db.birthDates.pForeign = bd;
    db.playerOwners.pForeign = "99999999-9999-4999-8999-999999999999";
    const res = await videoObservation(post("video-observation", teamObsBody({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(mock.calls.some((c) => c.url.includes("select=birth_date"))).toBe(false);
    expect(geminiCalls()).toHaveLength(0);
  });

  it("llamada de SERVICIO (cola / live) → el gate no se consulta", async () => {
    const res = await videoObservation(post("video-observation", teamObsBody(), "Bearer svc-token"));
    expect(res.status).toBe(200);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/"))).toBe(false);
    expect(geminiCalls()).toHaveLength(1);
  });
});

describe("team-observation (vídeo de equipo del navegador)", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    videoBase64: "AAAA",
    mediaType: "video/mp4",
    videoId: "local-123",
    teamContext: { teamColor: "rojo" },
    ...extra,
  });

  it("sin declaración → 400 attestation_required; ni gasto ni Gemini", async () => {
    const res = await teamObservation(post("team-observation", body()));
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(geminiCalls()).toHaveLength(0);
  });

  it("con declaración → se GUARDA (video_ref, quién = JWT) y llega a Gemini; sin consultar jugadores", async () => {
    const res = await teamObservation(post("team-observation", body({ attestation: ATTESTATION })));
    expect(res.status).toBe(200);
    expect(mock.inserts[0]).toMatchObject({
      user_id: USER,
      resource_type: "video_ref",
      resource_id: "local-123",
      metadata: { version: "2026-09-28.v1", scope: "team", player_id: null, endpoint: "agents/team-observation" },
    });
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/players"))).toBe(false);
    expect(geminiCalls()).toHaveLength(1);
  });

  it("B1 · el videoId es una fila `videos` propia de un menor de 14 sin consentimiento → 403 aunque se pida 'de equipo'", async () => {
    db.videos[0].player_id = "pMinor";
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.playerOwners.pMinor = USER; // jugador propio (B5)
    const res = await teamObservation(post("team-observation", body({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(recordSpendUsd).not.toHaveBeenCalled();
    expect(geminiCalls()).toHaveLength(0);
  });

  it("B2 · el videoId es el GUID de la fila de OTRO usuario → 403", async () => {
    db.videos.push({ id: "vid-x", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const res = await teamObservation(post("team-observation", body({ videoId: "1a000000-0000-4000-8000-00000000000a", attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect(geminiCalls()).toHaveLength(0);
  });

  it("B5 · el videoId es una fila propia ligada a un jugador AJENO → 403 forbidden sin leer su fecha; Gemini no se llama", async () => {
    db.videos[0].player_id = "pForeign";
    db.birthDates.pForeign = MINOR_BIRTH_DATE;
    db.playerOwners.pForeign = "99999999-9999-4999-8999-999999999999";
    const res = await teamObservation(post("team-observation", body({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(mock.calls.some((c) => c.url.includes("select=birth_date"))).toBe(false);
    expect(geminiCalls()).toHaveLength(0);
  });

  it("fila `videos` propia SIN jugador → la declaración se guarda CON la fila (resource_type videos)", async () => {
    const res = await teamObservation(post("team-observation", body({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(200);
    expect(mock.inserts[0]).toMatchObject({ resource_type: "videos", resource_id: GUID, metadata: { scope: "team", player_id: null } });
  });
});

describe("team-intelligence (informe de equipo)", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    videoId: "local-123",
    teamContext: { teamColor: "rojo" },
    keyframes: ["data:image/jpeg;base64,AAAA"],
    ...extra,
  });

  it("sin declaración → 400 JSON (no stream) y Claude no se llama", async () => {
    const res = await teamIntelligence(post("team-intelligence", body()));
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("con declaración → se guarda y se abre el stream", async () => {
    const res = await teamIntelligence(post("team-intelligence", body({ attestation: ATTESTATION })));
    expect(res.status).toBe(200);
    await res.text();
    expect(mock.inserts[0]).toMatchObject({ resource_type: "video_ref", resource_id: "local-123", metadata: { endpoint: "agents/team-intelligence" } });
    expect(fetchMessages).toHaveBeenCalled();
  });

  it("B1 · el videoId es una fila `videos` propia de un menor de 14 sin consentimiento → 403 JSON, Claude no se llama", async () => {
    db.videos[0].player_id = "pMinor";
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.playerOwners.pMinor = USER; // jugador propio (B5)
    const res = await teamIntelligence(post("team-intelligence", body({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("B2 · el videoId es el GUID de la fila de OTRO usuario → 403", async () => {
    db.videos.push({ id: "vid-x", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const res = await teamIntelligence(post("team-intelligence", body({ videoId: "1a000000-0000-4000-8000-00000000000a", attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("B5 · el videoId es una fila propia ligada a un jugador AJENO → 403 forbidden sin leer su fecha; Claude no se llama", async () => {
    db.videos[0].player_id = "pForeign";
    db.birthDates.pForeign = "1990-01-01";
    db.playerOwners.pForeign = "99999999-9999-4999-8999-999999999999";
    const res = await teamIntelligence(post("team-intelligence", body({ videoId: GUID, attestation: ATTESTATION })));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(mock.calls.some((c) => c.url.includes("select=birth_date"))).toBe(false);
    expect(fetchMessages).not.toHaveBeenCalled();
  });
});
