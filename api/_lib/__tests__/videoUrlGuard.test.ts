/**
 * VITAS · Allowlist de URLs de vídeo (SSRF + coste) — api/_lib/videoUrlGuard
 *
 * Espejo de vision-pipeline/test_video_url_guard.py (misma política en Python).
 * Sin red: `fetchImpl` inyectado.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/_lib/__tests__/videoUrlGuard.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import {
  assertAllowedVideoUrl,
  isAllowedVideoUrl,
  videoHostPolicy,
  maxVideoBytes,
  fetchAllowedVideo,
  streamVideoFromUrl,
  VideoUrlError,
  DEFAULT_MAX_VIDEO_BYTES,
  MAX_VIDEO_REDIRECTS,
} from "../videoUrlGuard";

const CDN = "vz-abc123-456.b-cdn.net";
const ENV = {
  BUNNY_CDN_HOSTNAME: CDN,
  BUNNY_STORAGE_CDN_URL: "https://vitas-storage.b-cdn.net",
  BUNNY_STREAM_LIBRARY_ID: "123456",
};
const GOOD = `https://${CDN}/0f1e2d3c-guid/play_720p.mp4`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof VideoUrlError) return err.code;
    throw err;
  }
  throw new Error("expected a VideoUrlError");
}

async function codeOfAsync(p: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof VideoUrlError) return { code: err.code, status: err.status };
    throw err;
  }
  throw new Error("expected a VideoUrlError");
}

// ── Validador (sin red) ─────────────────────────────────────────────

describe("assertAllowedVideoUrl · permitidas", () => {
  it.each([
    GOOD,
    `https://${CDN.toUpperCase()}/guid/play_480p.mp4`,
    `https://${CDN}:443/guid/play_720p.mp4`,
    "https://vitas-storage.b-cdn.net/clips/a.mp4",
    "https://video.bunnycdn.com/library/123456/videos/guid/play.mp4",
  ])("%s", (url) => {
    expect(assertAllowedVideoUrl(url, ENV)).toBeInstanceOf(URL);
    expect(isAllowedVideoUrl(url, ENV)).toBe(true);
  });

  it("acepta el alias VITE_ y normaliza esquema/barra/mayúsculas de la env", () => {
    expect(isAllowedVideoUrl(GOOD, { VITE_BUNNY_CDN_HOSTNAME: `https://${CDN.toUpperCase()}/` })).toBe(true);
  });

  it("VIDEO_URL_EXTRA_HOSTS (CSV) añade hosts exactos", () => {
    const env = { ...ENV, VIDEO_URL_EXTRA_HOSTS: " legacy-zone.b-cdn.net , https://other.example.com/x " };
    expect(isAllowedVideoUrl("https://legacy-zone.b-cdn.net/v.mp4", env)).toBe(true);
    expect(isAllowedVideoUrl("https://other.example.com/v.mp4", env)).toBe(true);
  });

  it("devuelve la URL normalizada (href) para usar en el fetch", () => {
    expect(assertAllowedVideoUrl(`https://${CDN.toUpperCase()}:443/g/play_720p.mp4`, ENV).href)
      .toBe(`https://${CDN}/g/play_720p.mp4`);
  });
});

describe("streamVideoFromUrl · qué vídeo de Bunny STREAM sirve la URL (B7, ronda 5 del PR #308)", () => {
  it("pull zone de Stream (también el alias VITE_) → primer segmento; librería → tras /videos/", () => {
    expect(streamVideoFromUrl(`https://${CDN}/g-1/play_720p.mp4`, ENV).guid).toBe("g-1");
    expect(streamVideoFromUrl(`https://${CDN}/g-1/play_720p.mp4`, { VITE_BUNNY_CDN_HOSTNAME: CDN }).guid).toBe("g-1");
    expect(streamVideoFromUrl("https://video.bunnycdn.com/library/123456/videos/g-2/play.mp4", ENV).guid).toBe("g-2");
  });

  it("devuelve la URL normalizada (la que se manda a Modal)", () => {
    const r = streamVideoFromUrl(`https://${CDN.toUpperCase()}:443/./g-1/play_720p.mp4`, ENV);
    expect(r.url.href).toBe(`https://${CDN}/g-1/play_720p.mp4`);
    expect(r.guid).toBe("g-1");
  });

  it("Storage y hosts extra están en la allowlist pero NO identifican un vídeo → guid null", () => {
    expect(streamVideoFromUrl("https://vitas-storage.b-cdn.net/g-1/x.mp4", ENV).guid).toBeNull();
    expect(streamVideoFromUrl("https://legacy.b-cdn.net/g-1/x.mp4", { ...ENV, VIDEO_URL_EXTRA_HOSTS: "legacy.b-cdn.net" }).guid).toBeNull();
    expect(streamVideoFromUrl(`https://${CDN}/`, ENV).guid).toBeNull();
  });

  it("fuera de la allowlist o sin hosts configurados → lanza (como assertAllowedVideoUrl)", () => {
    expect(codeOf(() => streamVideoFromUrl("https://attacker.example/g-1/x.mp4", ENV))).toBe("VIDEO_URL_NOT_ALLOWED");
    expect(codeOf(() => streamVideoFromUrl(`https://${CDN}/g-1/x.mp4`, {}))).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
  });
});

describe("assertAllowedVideoUrl · falla cerrado", () => {
  it("sin BUNNY_CDN_HOSTNAME ni VITE_ → VIDEO_HOSTS_NOT_CONFIGURED (503), nunca abierto", () => {
    expect(codeOf(() => assertAllowedVideoUrl(GOOD, {}))).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    expect(new VideoUrlError("VIDEO_HOSTS_NOT_CONFIGURED", "x").status).toBe(503);
    expect(isAllowedVideoUrl(GOOD, {})).toBe(false);
  });

  it("storage/librería solos no bastan: sin host de CDN no se sabe qué es nuestro", () => {
    const { BUNNY_CDN_HOSTNAME: _omit, ...onlyStorage } = ENV;
    expect(codeOf(() => assertAllowedVideoUrl("https://vitas-storage.b-cdn.net/a.mp4", onlyStorage)))
      .toBe("VIDEO_HOSTS_NOT_CONFIGURED");
  });

  it.each(["169.254.169.254", "127.0.0.1", "localhost", "[::1]", "metadata.internal"])(
    "un host de env que es IP/interno (%s) se ignora → falla cerrado",
    (bad) => {
      expect(codeOf(() => videoHostPolicy({ BUNNY_CDN_HOSTNAME: bad }))).toBe("VIDEO_HOSTS_NOT_CONFIGURED");
    },
  );
});

describe("assertAllowedVideoUrl · bloqueadas", () => {
  it.each<[unknown, string]>([
    [`http://${CDN}/guid/play_720p.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    ["https://evil.example.com/play_720p.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://attacker-zone.b-cdn.net/big.mp4", "VIDEO_URL_NOT_ALLOWED"], // sin comodín *.b-cdn.net
    [`https://${CDN}.evil.com/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    [`https://evil-${CDN}/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    [`https://${CDN}@evil.com/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    [`https://user:pw@${CDN}/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    [`https://${CDN}:8443/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    ["https://169.254.169.254/latest/meta-data/", "VIDEO_URL_NOT_ALLOWED"],
    ["https://127.0.0.1/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://10.0.0.8/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://[::1]/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://2130706433/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://0x7f.1/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://localhost/a.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://metadata.google.internal/computeMetadata/v1/", "VIDEO_URL_NOT_ALLOWED"],
    ["https://video.bunnycdn.com/library/999/videos/guid/play.mp4", "VIDEO_URL_NOT_ALLOWED"],
    ["https://video.bunnycdn.com/library/123456/videos/../../999/videos/x", "VIDEO_URL_NOT_ALLOWED"],
    ["https://video.bunnycdn.com/library/123456/videos/%2e%2e/%2e%2e/999/x", "VIDEO_URL_NOT_ALLOWED"],
    ["blob:https://futuro-club.vercel.app/2b1c-local", "VIDEO_URL_NOT_ALLOWED"],
    ["data:video/mp4;base64,AAAA", "VIDEO_URL_NOT_ALLOWED"],
    ["file:///etc/passwd", "VIDEO_URL_NOT_ALLOWED"],
    [`ftp://${CDN}/a.mp4`, "VIDEO_URL_NOT_ALLOWED"],
    [`https://${CDN}\\@evil.com/a.mp4`, "VIDEO_URL_INVALID"],
    [`https://${CDN}/a b.mp4`, "VIDEO_URL_INVALID"],
    ["not a url", "VIDEO_URL_INVALID"],
    ["", "VIDEO_URL_INVALID"],
    [null, "VIDEO_URL_INVALID"],
    [12345, "VIDEO_URL_INVALID"],
    [`https://${CDN}/${"a".repeat(3000)}`, "VIDEO_URL_INVALID"],
  ])("%s → %s", (url, code) => {
    expect(codeOf(() => assertAllowedVideoUrl(url, ENV))).toBe(code);
    expect(isAllowedVideoUrl(url, ENV)).toBe(false);
  });
});

describe("maxVideoBytes", () => {
  it("default + override por env; valores inválidos → default", () => {
    expect(maxVideoBytes({})).toBe(DEFAULT_MAX_VIDEO_BYTES);
    expect(maxVideoBytes({ VIDEO_FETCH_MAX_BYTES: "1024" })).toBe(1024);
    expect(maxVideoBytes({ VIDEO_FETCH_MAX_BYTES: "nope" })).toBe(DEFAULT_MAX_VIDEO_BYTES);
    expect(maxVideoBytes({ VIDEO_FETCH_MAX_BYTES: "-5" })).toBe(DEFAULT_MAX_VIDEO_BYTES);
  });
});

// ── Descarga (fetch inyectado, sin red) ────────────────────────────

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function video(body: BodyInit | null = MP4, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "video/mp4", ...headers } });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("fetchAllowedVideo", () => {
  it("happy path: descarga con redirect:'manual' y devuelve bytes + content-type esencial", async () => {
    const fetchImpl = vi.fn(async () => video(MP4, { "content-type": "video/mp4; codecs=avc1" }));
    const out = await fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.bytes).toEqual(MP4);
    expect(out.contentType).toBe("video/mp4");
    expect(out.finalUrl).toBe(GOOD);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(GOOD);
    expect(init.redirect).toBe("manual");
  });

  it("URL fuera de la allowlist → rechaza SIN hacer ninguna petición", async () => {
    const fetchImpl = vi.fn(async () => video());
    const err = await codeOfAsync(
      fetchAllowedVideo("https://169.254.169.254/latest/meta-data/", { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(err).toEqual({ code: "VIDEO_URL_NOT_ALLOWED", status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sin env de CDN → 503 falla cerrado, sin petición", async () => {
    const fetchImpl = vi.fn(async () => video());
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err).toEqual({ code: "VIDEO_HOSTS_NOT_CONFIGURED", status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redirección a otro host permitido se sigue (re-validada)", async () => {
    const target = "https://vitas-storage.b-cdn.net/moved.mp4";
    const fetchImpl = vi.fn(async (url: string) => (url === GOOD ? redirect(target) : video()));
    const out = await fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.finalUrl).toBe(target);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([GOOD, target]);
  });

  it("redirección relativa se resuelve contra la URL actual", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("play_720p.mp4") ? redirect("/guid/play_480p.mp4", 301) : video(),
    );
    const out = await fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.finalUrl).toBe(`https://${CDN}/guid/play_480p.mp4`);
  });

  it.each([
    "https://evil.example.com/x.mp4",
    "http://169.254.169.254/latest/meta-data/",
    `http://${CDN}/downgrade.mp4`,
    "//evil.example.com/x.mp4",
  ])("redirección a %s → bloqueada sin seguirla", async (location) => {
    const fetchImpl = vi.fn(async () => redirect(location));
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("VIDEO_REDIRECT_NOT_ALLOWED");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`más de ${MAX_VIDEO_REDIRECTS} redirecciones → VIDEO_TOO_MANY_REDIRECTS`, async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => redirect(`/hop${++n}.mp4`));
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("VIDEO_TOO_MANY_REDIRECTS");
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_VIDEO_REDIRECTS + 1);
  });

  it.each([
    ["text/html", "<h1>login</h1>"],
    ["application/json", "{}"],
    ["", "x"],
  ])("content-type '%s' → VIDEO_NOT_VIDEO (415)", async (ctype, body) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: ctype ? { "content-type": ctype } : {} }));
    // new Response(string) pone text/plain por defecto → también se rechaza.
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err).toEqual({ code: "VIDEO_NOT_VIDEO", status: 415 });
  });

  it("Content-Length por encima del techo → 413 ANTES de leer el cuerpo", async () => {
    let pulled = false;
    // highWaterMark 0 → el stream solo produce cuando alguien LEE (no pre-llena la cola).
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(50));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn(async () => video(body, { "content-length": "50" }));
    const err = await codeOfAsync(
      fetchAllowedVideo(GOOD, { env: ENV, maxBytes: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(err).toEqual({ code: "VIDEO_TOO_LARGE", status: 413 });
    expect(pulled).toBe(false);
  });

  it("sin Content-Length el techo se aplica mientras se lee y corta el stream", async () => {
    let chunksServed = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksServed++;
        controller.enqueue(new Uint8Array(8));
        if (chunksServed >= 100) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => video(body));
    const err = await codeOfAsync(
      fetchAllowedVideo(GOOD, { env: ENV, maxBytes: 20, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(err).toEqual({ code: "VIDEO_TOO_LARGE", status: 413 });
    expect(cancelled).toBe(true);
    expect(chunksServed).toBeLessThan(100);
  });

  it("HTTP 404 → VIDEO_DOWNLOAD_FAILED (502)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err).toEqual({ code: "VIDEO_DOWNLOAD_FAILED", status: 502 });
  });

  it("cuerpo vacío → VIDEO_DOWNLOAD_FAILED", async () => {
    const fetchImpl = vi.fn(async () => video(new Uint8Array(0)));
    const err = await codeOfAsync(fetchAllowedVideo(GOOD, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("VIDEO_DOWNLOAD_FAILED");
  });
});
