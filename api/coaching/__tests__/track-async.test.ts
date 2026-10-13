/**
 * Tests · V4 async tracking — enqueue (track-async) + polling (track-status)
 * Patrón de mocks idéntico a api/_lib/__tests__/withHandler.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { isOverBudget } from "../../_lib/budgetGuard";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-123", error: null }),
}));

// El tripwire de presupuesto (054) hace fetch a Supabase; se mockea para no
// descuadrar la secuencia de fetchMock (el guard tiene sus propios tests). Por
// defecto NO bloquea; un test lo fuerza a true para verificar el corte.
vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(
    () => new Response(JSON.stringify({ ok: false, code: "BUDGET_EXCEEDED" }), { status: 429 }),
  ),
}));

// Gate de consentimiento (llamadas de usuario: resolución del vídeo + declaración): aquí
// se prueba la mecánica enqueue/spawn con la secuencia exacta de fetchMock, así que
// permite sin tocar la red. El gate REAL contra esta misma ruta (B1/B2 incluidos, y el
// spawn a Modal byte a byte para un vídeo declarado) está en
// api/coaching/__tests__/track-async-consent.test.ts.
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  gateClipAnalysis: vi.fn(async () => ({
    allowed: true, attestation: "recorded", pendingAttestation: null, minor: null, video: null, videoPlayerIds: [],
  })),
}));

// Env de módulo (SUPABASE_*) se lee vía env.ts en cada llamada → fijar antes.
process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";

let trackAsync: (req: Request) => Promise<Response>;
let trackStatus: (req: Request) => Promise<Response>;

beforeAll(async () => {
  trackAsync = (await import("../_track-async")).default;
  trackStatus = (await import("../_track-status")).default;
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function post(body: unknown): Request {
  return new Request("https://example.com/api/coaching/track-async", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer jwt" },
    body: JSON.stringify(body),
  });
}

function get(url: string): Request {
  return new Request(url, { method: "GET", headers: { Authorization: "Bearer jwt" } });
}

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

/** dedup query devuelve vacío (no hay job pendiente) por defecto. */
function noDup(): Response {
  return jsonRes([]);
}

describe("track-async (enqueue + spawn)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.MODAL_TRACK_ASYNC_URL = "https://modal.test/track_async";
    process.env.MODAL_API_KEY = "modal-key";
    process.env.MODAL_CALLBACK_SECRET = "cb-secret";
    process.env.VITAS_PUBLIC_URL = "https://vitas.test";
    delete process.env.PUBLIC_URL;
    // Allowlist de videoUrl (api/_lib/videoUrlGuard): cdn.test es "nuestro" CDN aquí.
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
    delete process.env.VITE_BUNNY_CDN_HOSTNAME;
  });

  it("videoUrl fuera de la allowlist Bunny → 400 sin dedup/insert/spawn (SSRF)", async () => {
    for (const videoUrl of [
      "https://169.254.169.254/latest/meta-data/",
      "https://evil.example.com/huge.mp4",
      "http://cdn.test/match.mp4",
      "https://attacker-zone.b-cdn.net/match.mp4",
    ]) {
      const res = await trackAsync(post({ videoUrl }));
      expect(res.status).toBe(400);
      expect((await res.json()).errorDetail.code).toBe("VIDEO_URL_NOT_ALLOWED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin BUNNY_CDN_HOSTNAME → 503 falla cerrado (el cliente cae a su fallback), sin fetch", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(503);
    expect((await res.json()).errorDetail.code).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Modal rechaza sin spawnear ({status:'error'} sin call_id) → job failed + 502, no queda 'processing'", async () => {
    fetchMock
      .mockResolvedValueOnce(noDup())                                                    // dedup
      .mockResolvedValueOnce(jsonRes([{ id: "job-3" }], 201))                            // insert
      .mockResolvedValueOnce(jsonRes({ status: "error", reason: "video_url_not_allowed" })) // spawn 200 + error
      .mockResolvedValueOnce(jsonRes([{ id: "job-3" }]));                                // PATCH failed

    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(502);
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.status).toBe("failed");
    expect(patchBody.error).toContain("video_url_not_allowed");
  });

  it("presupuesto excedido (054) → 429 BUDGET_EXCEEDED y NO spawnea Modal", async () => {
    vi.mocked(isOverBudget).mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce(noDup()); // dedup se consulta ANTES del gate
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(429);
    // El gate corta tras el dedup: ni insert ni spawn a Modal.
    const calledModal = fetchMock.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("modal.test"),
    );
    expect(calledModal).toBe(false);
  });

  it("503 real_inference_disabled (shape a pelo) sin MODAL_TRACK_ASYNC_URL", async () => {
    delete process.env.MODAL_TRACK_ASYNC_URL;
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    // Mismo contrato que _track-players: campo top-level `error`.
    expect(body.error).toBe("real_inference_disabled");
  });

  it("503 real_inference_disabled sin MODAL_CALLBACK_SECRET (fail-fast, no fail-open en el webhook)", async () => {
    delete process.env.MODAL_CALLBACK_SECRET;
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("real_inference_disabled");
  });

  it("400 si videoUrl falta o no es URL", async () => {
    const res = await trackAsync(post({ videoUrl: "not-a-url" }));
    expect(res.status).toBe(400);
  });

  it("413 si el vídeo supera el techo async", async () => {
    process.env.MAX_ASYNC_TRACK_SEC = "7200";
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/m.mp4", durationSec: 999999 }));
    expect(res.status).toBe(413);
    delete process.env.MAX_ASYNC_TRACK_SEC;
  });

  it("dedup: job pendiente para el mismo vídeo → devuelve el existente, sin spawn", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([{ id: "job-existing", status: "processing" }])); // dedup HIT
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.jobId).toBe("job-existing");
    expect(body.data.deduped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // solo el dedup, nunca insert/spawn
  });

  it("happy path: dedup vacío → inserta, spawnea, marca processing, 202", async () => {
    fetchMock
      .mockResolvedValueOnce(noDup())                                   // 0 dedup
      .mockResolvedValueOnce(jsonRes([{ id: "job-1" }], 201))           // 1 insert
      .mockResolvedValueOnce(jsonRes({ call_id: "call-9" }))            // 2 spawn
      .mockResolvedValueOnce(jsonRes([{ id: "job-1" }]));              // 3 PATCH processing

    const res = await trackAsync(
      post({ videoUrl: "https://cdn.test/match.mp4", durationSec: 5400, sampleFps: 5 }),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.jobId).toBe("job-1");
    expect(body.data.status).toBe("processing");

    // insert lleva user_id del JWT
    const insertCall = fetchMock.mock.calls[1];
    expect(String(insertCall[0])).toContain("/rest/v1/tracking_jobs");
    expect(JSON.parse(insertCall[1].body).user_id).toBe("user-123");

    // spawn: job_id + callback_url absoluto, SIN callback_token (Modal firma su lado)
    const spawnCall = fetchMock.mock.calls[2];
    expect(String(spawnCall[0])).toBe("https://modal.test/track_async");
    const spawnBody = JSON.parse(spawnCall[1].body);
    expect(spawnBody.job_id).toBe("job-1");
    expect(spawnBody.callback_url).toBe("https://vitas.test/api/webhooks/modal-tracking");
    expect(spawnBody.callback_token).toBeUndefined();

    // PATCH marca processing + modal_call_id (crítico para el claim RPC)
    const patchCall = fetchMock.mock.calls[3];
    expect(String(patchCall[0])).toContain("tracking_jobs?id=eq.job-1");
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.status).toBe("processing");
    expect(patchBody.modal_call_id).toBe("call-9");
  });

  it("spawn fallido → job marcado failed y 502", async () => {
    fetchMock
      .mockResolvedValueOnce(noDup())                             // dedup
      .mockResolvedValueOnce(jsonRes([{ id: "job-2" }], 201))     // insert
      .mockResolvedValueOnce(new Response("boom", { status: 500 })) // spawn 500
      .mockResolvedValueOnce(jsonRes([{ id: "job-2" }]));         // PATCH failed

    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(502);
    const patchCall = fetchMock.mock.calls[3];
    expect(JSON.parse(patchCall[1].body).status).toBe("failed");
  });

  it("insert fallido → 500 sin tocar Modal", async () => {
    fetchMock
      .mockResolvedValueOnce(noDup())                              // dedup
      .mockResolvedValueOnce(new Response("rls", { status: 403 })); // insert 403
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2); // dedup + insert, nunca spawn
  });

  it("insert 201 sin representación → 500 enqueue_failed (no TypeError)", async () => {
    fetchMock
      .mockResolvedValueOnce(noDup())
      .mockResolvedValueOnce(jsonRes([], 201)); // representación vacía
    const res = await trackAsync(post({ videoUrl: "https://cdn.test/match.mp4" }));
    expect(res.status).toBe(500);
  });
});

describe("track-status (polling)", () => {
  beforeEach(() => fetchMock.mockReset());

  const row = (over: Record<string, unknown> = {}) => [{
    id: "job-1", user_id: "user-123", status: "processing", error: null, ...over,
  }];

  it("400 sin jobId", async () => {
    const res = await trackStatus(get("https://example.com/api/coaching/track-status"));
    expect(res.status).toBe(400);
  });

  it("404 si el job no existe", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]));
    const res = await trackStatus(get("https://example.com/api/coaching/track-status?jobId=nope"));
    expect(res.status).toBe(404);
  });

  it("403 si el job es de otro usuario", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(row({ user_id: "otro" })));
    const res = await trackStatus(get("https://example.com/api/coaching/track-status?jobId=job-1"));
    expect(res.status).toBe(403);
  });

  it("200 processing: sin result y sin segundo fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(row()));
    const res = await trackStatus(get("https://example.com/api/coaching/track-status?jobId=job-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("processing");
    expect(body.data.result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no se pide result mientras no está done
  });

  it("200 done: segundo fetch trae el result", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(row({ status: "done" })))              // status row
      .mockResolvedValueOnce(jsonRes([{ result: { totalPlayerTracks: 22 } }])); // result aparte
    const res = await trackStatus(get("https://example.com/api/coaching/track-status?jobId=job-1"));
    const body = await res.json();
    expect(body.data.status).toBe("done");
    expect(body.data.result.totalPlayerTracks).toBe(22);
    // el primer SELECT no pide result
    expect(String(fetchMock.mock.calls[0][0])).toContain("select=id,user_id,status,error");
  });
});
