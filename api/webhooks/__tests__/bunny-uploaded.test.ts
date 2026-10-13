/**
 * Tests · webhook de Bunny Stream (api/webhooks/bunny-uploaded.ts)
 *
 * Contrato OFICIAL (https://bunny.net/docs/stream-webhook):
 *   X-BunnyStream-Signature = HMAC-SHA256(body CRUDO) hex minúsculas, clave = Read-Only
 *   API key de la librería (en VITAS: env BUNNY_WEBHOOK_SECRET).
 *   Status 3 = Finished (único terminal) · 4 = Resolution finished (por resolución).
 *
 * La firma se calcula con el edgeCrypto REAL sobre el body EXACTO que se envía.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { hmacSha256Hex } from "../../_lib/edgeCrypto";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 199, limit: 200, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: null, email: null, tenantId: null, error: null }),
}));

const enqueueMock = vi.fn();
vi.mock("../../_lib/enqueueAnalysis", () => ({
  enqueueAnalysis: (...args: unknown[]) => enqueueMock(...args),
}));

// Supabase mock: from("videos").select(...).eq(...).single() / .maybeSingle(); update().eq()
const videoRow: { current: Record<string, unknown> | null } = { current: null };
const updateSpy = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => (videoRow.current ? { data: videoRow.current, error: null } : { data: null, error: { message: "no rows" } }),
          maybeSingle: async () => ({ data: { locale: "en" }, error: null }),
        }),
      }),
      update: (patch: unknown) => {
        updateSpy(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const SECRET = "bunny-readonly-api-key";

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../bunny-uploaded")).default;
});

async function signedRequest(
  payload: unknown,
  opts: { header?: string; secret?: string; version?: string; algorithm?: string; rawOverride?: string } = {},
): Promise<Request> {
  const raw = JSON.stringify(payload);
  const sig = await hmacSha256Hex(opts.secret ?? SECRET, raw);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [opts.header ?? "X-BunnyStream-Signature"]: sig,
    "X-BunnyStream-Signature-Version": opts.version ?? "v1",
    "X-BunnyStream-Signature-Algorithm": opts.algorithm ?? "hmac-sha256",
  };
  return new Request("https://example.com/api/webhooks/bunny-uploaded", {
    method: "POST",
    headers,
    body: opts.rawOverride ?? raw,
  });
}

const FINISHED = { VideoLibraryId: 133, VideoGuid: "657bb740-a71b-4529-a012-528021c31a92", Status: 3 };

describe("webhook bunny-uploaded · firma", () => {
  beforeEach(() => {
    process.env.BUNNY_WEBHOOK_SECRET = SECRET;
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    delete process.env.BUNNY_STREAM_LIBRARY_ID;
    delete process.env.BUNNY_STREAM_API_KEY;
    enqueueMock.mockReset();
    updateSpy.mockReset();
    videoRow.current = { id: "657bb740-a71b-4529-a012-528021c31a92", tenant_id: "t1", player_id: "p1", duration_sec: 120 };
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 con payload firmado correctamente (X-BunnyStream-Signature) y Status=3 Finished → encola", async () => {
    const res = await handler(await signedRequest(FINISHED));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("queued");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({ videoId: FINISHED.VideoGuid, tenantId: "t1", playerId: "p1", locale: "en" });
  });

  it("401 con firma inválida", async () => {
    const res = await handler(await signedRequest(FINISHED, { secret: "otra-clave" }));
    expect(res.status).toBe(401);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("401 sin firma", async () => {
    const req = new Request("https://example.com/api/webhooks/bunny-uploaded", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FINISHED),
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("401 con la cabecera antigua NO documentada (x-bunny-signature)", async () => {
    const res = await handler(await signedRequest(FINISHED, { header: "x-bunny-signature" }));
    expect(res.status).toBe(401);
  });

  it("401 si el body cambia tras firmar (la firma es del body crudo)", async () => {
    const res = await handler(
      await signedRequest(FINISHED, { rawOverride: JSON.stringify({ ...FINISHED, VideoGuid: "otro" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("401 con versión/algoritmo de firma no soportados", async () => {
    expect((await handler(await signedRequest(FINISHED, { version: "v2" }))).status).toBe(401);
    expect((await handler(await signedRequest(FINISHED, { algorithm: "hmac-sha1" }))).status).toBe(401);
  });

  it("503 fail-closed sin BUNNY_WEBHOOK_SECRET", async () => {
    delete process.env.BUNNY_WEBHOOK_SECRET;
    const res = await handler(await signedRequest(FINISHED));
    expect(res.status).toBe(503);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("webhook bunny-uploaded · estados", () => {
  beforeEach(() => {
    process.env.BUNNY_WEBHOOK_SECRET = SECRET;
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
    videoRow.current = { id: "v1", tenant_id: "t1", player_id: "p1", duration_sec: 120 };
  });

  it.each([
    [0, "Queued"],
    [1, "Processing"],
    [2, "Encoding"],
    [4, "Resolution finished (llega por resolución)"],
    [5, "Failed"],
    [9, "CaptionsGenerated"],
  ])("Status=%i (%s) → 200 skipped, NO encola", async (status) => {
    const res = await handler(await signedRequest({ ...FINISHED, Status: status }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.skipped).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("400 con payload firmado pero sin VideoGuid", async () => {
    const res = await handler(await signedRequest({ VideoLibraryId: 1, Status: 3 }));
    expect(res.status).toBe(400);
  });
});

describe("webhook bunny-uploaded · consentimiento (auto-encolado)", () => {
  beforeEach(() => {
    process.env.BUNNY_WEBHOOK_SECRET = SECRET;
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    delete process.env.BUNNY_STREAM_LIBRARY_ID;
    delete process.env.BUNNY_STREAM_API_KEY;
    enqueueMock.mockReset();
    videoRow.current = { id: "v1", tenant_id: "t1", player_id: "p1", duration_sec: 120 };
  });

  it.each(["attestation_required", "parental_consent_required", "consent_check_failed"])(
    "enqueueAnalysis bloquea (%s) → 200 { skipped, reason: código } para que Bunny NO reintente",
    async (code) => {
      enqueueMock.mockResolvedValue({ status: "blocked", code, httpStatus: 400, gate_reason: "motivo" });
      const res = await handler(await signedRequest(FINISHED));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toMatchObject({ skipped: true, reason: code, gate_reason: "motivo" });
      expect(json.data.status).toBeUndefined(); // no "queued"
    },
  );

  it("encola por el helper compartido identificándose (endpoint) para el gate", async () => {
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
    await handler(await signedRequest(FINISHED));
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({ endpoint: "webhooks/bunny-uploaded", videoId: "v1", playerId: "p1" });
  });
});

describe("webhook bunny-uploaded · gate de clips cortos", () => {
  beforeEach(() => {
    process.env.BUNNY_WEBHOOK_SECRET = SECRET;
    process.env.VITE_SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    process.env.BUNNY_STREAM_LIBRARY_ID = "42";
    process.env.BUNNY_STREAM_API_KEY = "lib-key";
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ status: "queued", analysisId: "an-1", triggered: false });
    updateSpy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("partido completo (duration_sec de la fila) → 200 skipped con el código del gate, NO encola", async () => {
    videoRow.current = { id: "v1", tenant_id: "t1", player_id: "p1", duration_sec: 95 * 60 };
    const res = await handler(await signedRequest(FINISHED));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ skipped: true, reason: "video_too_long_for_sync_analysis", durationSec: 5700 });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("sin duración en la fila → usa la de la API de Bunny (real) y la persiste", async () => {
    videoRow.current = { id: "v1", tenant_id: "t1", player_id: "p1", duration_sec: null };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ guid: FINISHED.VideoGuid, status: 4, length: 6000 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handler(await signedRequest(FINISHED));
    expect(res.status).toBe(200);
    expect((await res.json()).data.reason).toBe("video_too_long_for_sync_analysis");
    expect(updateSpy).toHaveBeenCalledWith({ duration_sec: 6000 });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("duración desconocida en todas partes → NO bloquea (encola) y no inventa", async () => {
    videoRow.current = { id: "v1", tenant_id: "t1", player_id: "p1", duration_sec: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ guid: "g", status: 4, length: 0 }), { status: 200 })));
    const res = await handler(await signedRequest(FINISHED));
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
