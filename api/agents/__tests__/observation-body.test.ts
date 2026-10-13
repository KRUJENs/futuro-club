/**
 * VITAS · Regresión: cuerpo leído dos veces con rawBody:true (P0)
 *
 * withHandler({ rawBody: true }) lee el cuerpo antes de llamar al handler. Los
 * agentes Gemini hacían además `req.json()` → "Body is unusable" → toda
 * observación de vídeo fallaba (video-observation lo devolvía como 413 falso) y
 * las llamadas internas con token de servicio recibían 401.
 *
 * Run: npm run test:api -- observation-body
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.clearAllMocks(); // limpia llamadas entre tests; conserva las implementaciones mock
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn(),
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

// Gate de consentimiento: aquí se prueba la lectura del cuerpo, así que permite. Sus
// tests propios: api/_lib/__tests__/analysisConsentGate.test.ts y
// api/agents/__tests__/clip-consent-agents.test.ts.
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  gateClipAnalysis: vi.fn(async () => ({ allowed: true, attestation: "recorded", pendingAttestation: null, minor: null, video: null, videoPlayerIds: [] })),
  enforceUserVideoObservationConsent: vi.fn(async () => ({
    allowed: true,
    video: { id: "g-1", user_id: "user-123", tenant_id: null, player_id: null, bunny_video_id: "g-1" },
  })),
}));

import { verifyAuth } from "../../_lib/auth";
import videoObservation from "../video-observation";
import teamObservation from "../team-observation";
import teamIntelligence from "../_team-intelligence";

const OBSERVATIONS = { timeline: [], dimensiones: {}, momentosDestacados: [], patronesJuego: [], resumenGeneral: "ok" };

function geminiResponse() {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(OBSERVATIONS) }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

const PLAYER_BODY = JSON.stringify({
  videoBase64: "AAAA", // 3 bytes → inlineData
  mediaType: "video/mp4",
  playerContext: { age: 14, position: "ST", name: "Test" },
});

describe("video-observation · cuerpo y auth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.INTERNAL_API_TOKEN = "svc-token";
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test"; // allowlist de videoUrl (api/_lib/videoUrlGuard)
    vi.mocked(verifyAuth).mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null } as never);
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(":generateContent")) return geminiResponse();
      return new Response(new Uint8Array([0, 0, 0]), { status: 200, headers: { "content-type": "video/mp4" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.BUNNY_CDN_HOSTNAME;
  });

  it("un JSON pequeño con JWT de usuario llega a Gemini (no 413)", async () => {
    const res = await videoObservation(
      post("https://x.test/api/agents/video-observation", PLAYER_BODY, { Authorization: "Bearer user-jwt" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.observations.resumenGeneral).toBe("ok");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes(":generateContent"))).toBe(true);
  });

  it("acepta la llamada interna con token de servicio (cola / pipeline / live)", async () => {
    vi.mocked(verifyAuth).mockResolvedValue({ userId: null, email: null, tenantId: null, error: "not a JWT" } as never);
    const body = JSON.stringify({
      videoUrl: "https://cdn.test/v/play_720p.mp4",
      playerContext: { age: 14, position: "ST" },
    });
    const res = await videoObservation(
      post("https://x.test/api/agents/video-observation", body, { Authorization: "Bearer svc-token" }),
    );
    expect(res.status).toBe(200);
    expect(verifyAuth).not.toHaveBeenCalled();
  });

  it("sin token de servicio ni JWT válido sigue siendo 401", async () => {
    vi.mocked(verifyAuth).mockResolvedValue({ userId: null, email: null, tenantId: null, error: "No autenticado" } as never);
    const res = await videoObservation(
      post("https://x.test/api/agents/video-observation", PLAYER_BODY, { Authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("JSON inválido es 400 PARSE_ERROR, no un 413 falso", async () => {
    const res = await videoObservation(
      post("https://x.test/api/agents/video-observation", "{no-json", { Authorization: "Bearer user-jwt" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorDetail.code).toBe("PARSE_ERROR");
  });
});

describe("team-observation · cuerpo", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    vi.mocked(verifyAuth).mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null } as never);
    vi.stubGlobal("fetch", vi.fn(async () => geminiResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  it("un JSON pequeño llega a Gemini y devuelve observaciones", async () => {
    const body = JSON.stringify({ videoBase64: "AAAA", mediaType: "video/mp4", teamContext: { teamColor: "naranja" } });
    const res = await teamObservation(
      post("https://x.test/api/agents/team-observation", body, { Authorization: "Bearer user-jwt" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.observations.resumenGeneral).toBe("ok");
  });
});

describe("team-intelligence · cuerpo", () => {
  beforeEach(() => {
    vi.mocked(verifyAuth).mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null } as never);
  });

  it("lee el cuerpo (valida teamContext) en vez de fallar al re-leer la request", async () => {
    const res = await teamIntelligence(
      post("https://x.test/api/agents/team-intelligence", JSON.stringify({}), { Authorization: "Bearer user-jwt" }),
    );
    const text = await res.text();
    expect(text).toContain("Faltan datos requeridos (teamContext)");
    expect(text).not.toMatch(/unusable|already/i);
  });
});
