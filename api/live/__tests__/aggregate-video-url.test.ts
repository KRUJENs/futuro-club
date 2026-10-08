/**
 * VITAS · live/aggregate — no reenvía a video-observation una video_url heredada
 * fuera de la allowlist Bunny (filas guardadas antes de validar en escritura).
 *
 * Run: npx vitest run --config vitest.api.config.ts api/live/__tests__/aggregate-video-url.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null }),
}));

vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async () => new Response("{}", { status: 200 })),
  responseText: () => "{}",
}));

// Gate de consentimiento del vídeo del partido (declaración guardada con la fila `videos`).
// Por defecto permite; el bloque "consentimiento" lo fuerza a bloquear.
type StoredGate =
  | { allowed: true; attestation: "stored"; pendingAttestation: null; minor: null }
  | { allowed: false; code: string; status: number; gate_reason: string; minor: null };
const storedGate = vi.fn<(input: Record<string, unknown>) => Promise<StoredGate>>();
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  enforceStoredConsentForVideoUrl: (input: Record<string, unknown>) => storedGate(input),
}));

let storedVideoUrl: string | null = null;

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "update"]) c[m] = () => c;
  c.single = async () => result;
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "live_matches") {
        return chain({
          data: {
            id: "match-1", user_id: "user-123", status: "finished", analysis_result: null,
            team_name: "A", opponent_name: "B", score_home: 1, score_away: 0, duration_seconds: 3000,
            video_url: storedVideoUrl,
          },
          error: null,
        });
      }
      if (table === "live_events") {
        return chain({ data: [{ player_id: null, event_type: "gol", timestamp_seconds: 10 }], error: null });
      }
      return chain({ data: [], error: null });
    },
  }),
}));

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.ANTHROPIC_API_KEY = "test-key";

const CDN = "vz-abc123-456.b-cdn.net";
let fetchMock: ReturnType<typeof vi.fn>;
let aggregate: (req: Request) => Promise<Response>;

beforeEach(async () => {
  process.env.BUNNY_CDN_HOSTNAME = CDN;
  storedGate.mockReset();
  storedGate.mockImplementation(async () => ({ allowed: true, attestation: "stored", pendingAttestation: null, minor: null }));
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ data: { observations: { resumenGeneral: "obs" } } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  aggregate = (await import("../aggregate")).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BUNNY_CDN_HOSTNAME;
});

function run(): Promise<Response> {
  return aggregate(
    new Request("https://x.test/api/live/aggregate?matchId=match-1", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    }),
  );
}

const videoObservationCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/agents/video-observation"));

describe("live/aggregate · video_url heredada", () => {
  it("URL de nuestro CDN → se analiza el vídeo", async () => {
    storedVideoUrl = `https://${CDN}/guid/play_720p.mp4`;
    const res = await run();
    expect(res.status).toBe(200);
    expect(videoObservationCalls()).toHaveLength(1);
    expect((await res.json()).data.analysis.has_video).toBe(true);
  });

  it.each(["https://169.254.169.254/latest/meta-data/", "https://evil.example.com/huge.mp4"])(
    "URL fuera de la allowlist (%s) → no se reenvía; agregado SIN vídeo",
    async (url) => {
      storedVideoUrl = url;
      const res = await run();
      expect(res.status).toBe(200);
      expect(videoObservationCalls()).toHaveLength(0);
      expect((await res.json()).data.analysis.has_video).toBe(false);
    },
  );
});

describe("live/aggregate · consentimiento del vídeo (decisión del owner, 30 sep)", () => {
  it("consulta el gate con la video_url guardada y el usuario del JWT", async () => {
    storedVideoUrl = `https://${CDN}/guid/play_720p.mp4`;
    await run();
    expect(storedGate).toHaveBeenCalledTimes(1);
    expect(storedGate.mock.calls[0][0]).toMatchObject({
      videoUrl: storedVideoUrl,
      actor: { userId: "user-123" },
      endpoint: "live/aggregate",
    });
    // B5: el gate comprueba la propiedad de las filas Y de cada jugador antes de leer nada de él.
    expect(typeof storedGate.mock.calls[0][0].ownsVideo).toBe("function");
    expect(typeof storedGate.mock.calls[0][0].ownsPlayer).toBe("function");
  });

  it.each(["attestation_required", "parental_consent_required", "consent_check_failed"])(
    "bloqueado (%s) → NO se manda el vídeo a Gemini; el informe de eventos sigue y declara el motivo",
    async (code) => {
      storedVideoUrl = `https://${CDN}/guid/play_720p.mp4`;
      storedGate.mockImplementation(async () => ({ allowed: false, code, status: 400, gate_reason: `motivo ${code}`, minor: null }));
      const res = await run();
      expect(res.status).toBe(200);
      expect(videoObservationCalls()).toHaveLength(0);
      const analysis = (await res.json()).data.analysis;
      expect(analysis.has_video).toBe(false);
      expect(analysis.video_consent_gate).toEqual({ code, gate_reason: `motivo ${code}` });
    },
  );

  it("URL fuera de la allowlist → ni siquiera se consulta el gate (no se reenvía nada)", async () => {
    storedVideoUrl = "https://evil.example.com/huge.mp4";
    await run();
    expect(storedGate).not.toHaveBeenCalled();
  });
});
