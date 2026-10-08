/**
 * Tests · finalize — gate honesto ANTES de encolar la cola Gemini de clips cortos.
 * Un partido completo NO se encola (video-observation descarga el fichero entero en una
 * función de 120 s): 422 con código traducible + duración real. Duración desconocida → no
 * se bloquea ni se inventa.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-1", email: null, tenantId: "t1", error: null }),
}));
const ownsPlayerMock = vi.fn(async (_playerId: string, _userId: string | null) => true);
vi.mock("../../_lib/ownership", () => ({
  ownsVideo: vi.fn(async () => true),
  ownsPlayer: (playerId: string, userId: string | null) => ownsPlayerMock(playerId, userId),
}));
const enqueueMock = vi.fn();
vi.mock("../../_lib/enqueueAnalysis", () => ({
  enqueueAnalysis: (...args: unknown[]) => enqueueMock(...args),
}));
// Gate de consentimiento (resolución del vídeo + declaración). Sus tests:
// api/_lib/__tests__/analysisConsentGate.test.ts y finalize-consent.test.ts (gate REAL).
// Por defecto permite; los tests de consentimiento lo fuerzan a bloquear.
const consentMock = vi.fn();
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  gateClipAnalysis: (...args: unknown[]) => consentMock(...args),
}));
const ALLOWED = { allowed: true, attestation: "recorded", pendingAttestation: null, minor: null, video: null, videoPlayerIds: [] };
const ATTESTATION = { accepted: true, version: "2026-09-28.v1" };

const row: { current: Record<string, unknown> } = { current: {} };
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            table === "players" ? { data: { tenant_id: "t1" }, error: null } : { data: row.current, error: null },
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

function bunnyVideo(length: number, status = 4) {
  return new Response(JSON.stringify({ guid: "1a000000-0000-4000-8000-000000000001", status, length, width: 1920, height: 1080 }), { status: 200 });
}

function post(body: Record<string, unknown>) {
  return new Request("https://x.test/api/videos/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify(body),
  });
}

describe("finalize · gate de clips cortos", () => {
  beforeEach(() => {
    consentMock.mockReset();
    consentMock.mockResolvedValue(ALLOWED);
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
    ownsPlayerMock.mockReset();
    ownsPlayerMock.mockResolvedValue(true);
    row.current = { id: "1a000000-0000-4000-8000-000000000001", bunny_video_id: "1a000000-0000-4000-8000-000000000001", player_id: "p1", tenant_id: "t1", user_id: "user-1", duration_sec: null };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("partido completo (length de Bunny) → 422 con código + duración real, NO encola", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(95 * 60)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.errorDetail).toMatchObject({
      code: "video_too_long_for_sync_analysis",
      durationSec: 5700,
      maxDurationSec: 300,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("Bunny sin length pero la fila tiene duration_sec (metadatos del navegador) → también bloquea", async () => {
    row.current = { ...row.current, duration_sec: 100 * 60 };
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(0)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001" }));
    expect(res.status).toBe(422);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("clip corto → encola como siempre", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(240)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ready: true, queued: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("duración desconocida (Bunny 0 y fila null) → NO bloquea (encola) y no inventa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(0)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("076 · el jugador NO es del usuario (p. ej. otra cuenta del mismo tenant) → 403, sin encolar", async () => {
    ownsPlayerMock.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(240)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(403);
    // Solo el dueño: se pregunta por (jugador, usuario del JWT); el tenant "t1" del JWT no cuenta.
    expect(ownsPlayerMock).toHaveBeenCalledWith("p1", "user-1");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("vídeo aún codificando (API status ≠ 4 Finished) → ready:false, sin gate ni encolado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(95 * 60, 3)));
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.ready).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("finalize · consentimiento (decisión del owner, 30 sep)", () => {
  beforeEach(() => {
    consentMock.mockReset();
    consentMock.mockResolvedValue(ALLOWED);
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
    row.current = { id: "1a000000-0000-4000-8000-000000000001", bunny_video_id: "1a000000-0000-4000-8000-000000000001", player_id: "p1", tenant_id: "t1", user_id: "user-1", duration_sec: null };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pasa al gate la declaración del body, el vídeo (id + GUID de la fila), el jugador y el usuario del JWT (nunca del body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(240)));
    await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1", attestation: ATTESTATION, userId: "intruso" }));
    expect(consentMock).toHaveBeenCalledTimes(1);
    expect(consentMock.mock.calls[0][0]).toMatchObject({
      attestation: ATTESTATION,
      videoId: "1a000000-0000-4000-8000-000000000001",
      bunnyGuid: "1a000000-0000-4000-8000-000000000001",
      requireVideoRow: true,
      playerId: "p1",
      actor: { userId: "user-1", tenantId: "t1" },
      endpoint: "videos/finalize",
    });
  });

  it("fila sin GUID aún → el gate recibe el GUID que se va a sembrar (el del cliente)", async () => {
    row.current = { ...row.current, bunny_video_id: null };
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(240)));
    await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-00000000000f", playerId: "p1", attestation: ATTESTATION }));
    expect(consentMock.mock.calls[0][0]).toMatchObject({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyGuid: "1a000000-0000-4000-8000-00000000000f" });
  });

  it("bloqueo de resolución del vídeo (otra fila ajena con el mismo GUID) → 403 con su código, sin Bunny ni encolar", async () => {
    const fetchMock = vi.fn(async () => bunnyVideo(240));
    vi.stubGlobal("fetch", fetchMock);
    consentMock.mockResolvedValue({ allowed: false, code: "forbidden", status: 403, gate_reason: "No gestionas este vídeo", minor: null });
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1", attestation: ATTESTATION }));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it.each([
    ["attestation_required", 400],
    ["parental_consent_required", 403],
    ["consent_check_failed", 500],
  ] as const)("gate bloquea (%s) → %i con el código, SIN consultar Bunny ni encolar", async (code, status) => {
    const fetchMock = vi.fn(async () => bunnyVideo(240));
    vi.stubGlobal("fetch", fetchMock);
    consentMock.mockResolvedValue({ allowed: false, code, status, gate_reason: "motivo traducido", minor: null });
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1" }));
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.errorDetail).toMatchObject({ code, gate_reason: "motivo traducido", attestationVersion: "2026-09-28.v1" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Bunny
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueueAnalysis bloqueado (defensa en profundidad) → error con su código, no 'ready'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bunnyVideo(240)));
    enqueueMock.mockResolvedValue({ status: "blocked", code: "parental_consent_required", httpStatus: 403, gate_reason: "menor" });
    const res = await handler(post({ videoId: "1a000000-0000-4000-8000-000000000001", bunnyVideoId: "1a000000-0000-4000-8000-000000000001", playerId: "p1", attestation: ATTESTATION }));
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
  });
});
