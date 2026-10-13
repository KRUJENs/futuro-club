/**
 * VITAS · video-observation — descarga server-side de videoUrl (SSRF + coste)
 *
 * Antes: fetch(videoUrl) a CUALQUIER host, siguiendo redirecciones, sin mirar
 * content-type y bufferizando el fichero entero → SSRF (metadata/red interna) y
 * gasto Gemini/memoria sin techo. Ahora: allowlist Bunny (api/_lib/videoUrlGuard).
 *
 * withHandler se sustituye por un passthrough que entrega `req` intacto y
 * `rawBody` (el parseo del cuerpo es otro PR); aquí solo se prueba el bloque de
 * descarga.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/video-observation-url.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `serviceCall` = llamada server-to-server (cola, gemini-analyze, live/aggregate).
let serviceCall = false;
vi.mock("../../_lib/withHandler", () => ({
  withHandler:
    (_opts: unknown, handler: (ctx: Record<string, unknown>) => Promise<Response>) =>
    async (req: Request) => {
      const rawBody = await req.clone().text();
      return handler({
        req, rawBody, body: rawBody,
        userId: serviceCall ? null : "user-123",
        isServiceCall: serviceCall,
        query: {}, headers: {},
      });
    },
}));

// Gate de consentimiento de las llamadas de USUARIO: aquí se prueba la descarga, así que
// permite. Sus tests propios: api/agents/__tests__/clip-consent-agents.test.ts.
const userGate = vi.fn(async () => ({
  allowed: true,
  video: { id: "0f1e2d3c-guid", user_id: "user-123", tenant_id: null, player_id: null, bunny_video_id: "0f1e2d3c-guid" },
}));
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  enforceUserVideoObservationConsent: (...args: unknown[]) => userGate(...(args as [])),
}));

vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(),
}));

import { recordSpendUsd } from "../../_lib/budgetGuard";
import videoObservation from "../video-observation";

const CDN = "vz-abc123-456.b-cdn.net";
const GOOD = `https://${CDN}/0f1e2d3c-guid/play_720p.mp4`;
const OBS = { timeline: [], dimensiones: {}, momentosDestacados: [], patronesJuego: [], resumenGeneral: "ok" };

function gemini(): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(OBS) }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mp4(headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), {
    status: 200,
    headers: { "content-type": "video/mp4", ...headers },
  });
}

function call(body: Record<string, unknown>): Promise<Response> {
  return videoObservation(
    new Request("https://x.test/api/agents/video-observation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerContext: { age: 14, position: "ST", name: "Test" }, ...body }),
    }),
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
let downloadResponse: () => Response;

const isGemini = (u: unknown) => String(u).includes("generativelanguage.googleapis.com");
const downloadCalls = () => fetchMock.mock.calls.filter(([u]) => !isGemini(u));
const geminiCalls = () => fetchMock.mock.calls.filter(([u]) => isGemini(u));

beforeEach(() => {
  vi.clearAllMocks();
  serviceCall = false;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.BUNNY_CDN_HOSTNAME = CDN;
  delete process.env.VITE_BUNNY_CDN_HOSTNAME;
  delete process.env.VIDEO_FETCH_MAX_BYTES;
  downloadResponse = () => mp4();
  fetchMock = vi.fn(async (url: string) => (isGemini(url) ? gemini() : downloadResponse()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
  delete process.env.BUNNY_CDN_HOSTNAME;
  delete process.env.VIDEO_FETCH_MAX_BYTES;
});

describe("video-observation · videoUrl", () => {
  it("URL de nuestro CDN Bunny → descarga con redirect:'manual' y llega a Gemini", async () => {
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(200);
    expect((await res.json()).data.observations.resumenGeneral).toBe("ok");
    expect(downloadCalls()).toHaveLength(1);
    const [url, init] = downloadCalls()[0] as [string, RequestInit];
    expect(url).toBe(GOOD);
    expect(init.redirect).toBe("manual");
    // El mimeType que va a Gemini es el content-type real (video/*).
    const geminiBody = JSON.parse((geminiCalls()[0][1] as RequestInit).body as string);
    expect(geminiBody.contents[0].parts[0].inlineData.mimeType).toBe("video/mp4");
  });

  it.each([
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "https://10.0.0.8/internal.mp4",
    "https://evil.example.com/huge.mp4",
    "https://attacker-zone.b-cdn.net/huge.mp4",
    `http://${CDN}/0f1e2d3c-guid/play_720p.mp4`,
  ])("%s → 400 VIDEO_URL_NOT_ALLOWED sin ninguna petición saliente ni gasto", async (videoUrl) => {
    const res = await call({ videoUrl });
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_URL_NOT_ALLOWED");
    expect(fetchMock).not.toHaveBeenCalled();
    // Rechazada ANTES del tripwire: no infla el ledger de presupuesto global.
    expect(recordSpendUsd).not.toHaveBeenCalled();
  });

  it("sin BUNNY_CDN_HOSTNAME → 503 VIDEO_HOSTS_NOT_CONFIGURED (falla cerrado), sin fetch", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(503);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirección del CDN a otro host → 502 sin seguirla ni llamar a Gemini", async () => {
    downloadResponse = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(502);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_REDIRECT_NOT_ALLOWED");
    expect(downloadCalls()).toHaveLength(1);
    expect(geminiCalls()).toHaveLength(0);
  });

  it("recurso que no es vídeo (text/html) → 415 sin llamar a Gemini", async () => {
    downloadResponse = () => new Response("<h1>login</h1>", { status: 200, headers: { "content-type": "text/html" } });
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(415);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_NOT_VIDEO");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("Content-Length por encima del techo → 413 sin bufferizar ni llamar a Gemini", async () => {
    process.env.VIDEO_FETCH_MAX_BYTES = "4";
    downloadResponse = () => mp4({ "content-length": "8" });
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(413);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_TOO_LARGE");
    expect(geminiCalls()).toHaveLength(0);
  });

  it("CDN caído (HTTP 404) → 502 VIDEO_DOWNLOAD_FAILED (contrato previo)", async () => {
    downloadResponse = () => new Response("nope", { status: 404 });
    const res = await call({ videoUrl: GOOD });
    expect(res.status).toBe(502);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_DOWNLOAD_FAILED");
  });

  it("videoBase64 directo (sin URL) en una llamada de SERVICIO sigue funcionando aunque no haya allowlist", async () => {
    // Las llamadas de USUARIO con fichero en el cuerpo las rechaza el gate de
    // consentimiento (clip-consent-agents.test.ts); el camino de servicio no cambia.
    serviceCall = true;
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await call({ videoBase64: "AAAA", mediaType: "video/mp4" });
    expect(res.status).toBe(200);
    expect(downloadCalls()).toHaveLength(0);
    expect(geminiCalls()).toHaveLength(1);
    expect(userGate).not.toHaveBeenCalled();
  });
});
