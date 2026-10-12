/**
 * VITAS · upload/image
 *  - Regresión: con rawBody:true leía un cuerpo ya consumido
 *    (req.arrayBuffer() tras el req.text() de withHandler) → la subida fallaba siempre.
 *  - Cierre (oct 2026): la ruta la construye el servidor (solo uploads/ o la foto
 *    de un jugador PROPIO) y el tipo se decide por los bytes (JPEG/PNG/WebP/GIF).
 *
 * Run: npm run test:api -- upload/__tests__/image
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null }),
}));

vi.mock("../../_lib/ownership", () => ({
  ownsPlayer: vi.fn(),
}));

import uploadImage, { sniffImageType } from "../_image";
import { ownsPlayer } from "../../_lib/ownership";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // cabecera JPEG, no UTF-8
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // ....ftypisom

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function post(query: string, body: Uint8Array, contentType: string | null = "image/jpeg"): Request {
  const headers: Record<string, string> = { Authorization: "Bearer user-jwt" };
  if (contentType) headers["Content-Type"] = contentType;
  return new Request(`https://x.test/api/upload/image${query}`, {
    method: "POST",
    headers,
    body: body as Uint8Array<ArrayBuffer>,
  });
}

describe("upload/image", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const bunnyPuts = () =>
    (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([u]) => u.startsWith("https://storage.bunnycdn.com/"));

  beforeEach(() => {
    process.env.BUNNY_STORAGE_ZONE = "zone";
    process.env.BUNNY_STORAGE_API_KEY = "key";
    process.env.BUNNY_STORAGE_CDN_URL = "https://cdn.test";
    fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(ownsPlayer).mockReset();
    vi.mocked(ownsPlayer).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUNNY_STORAGE_ZONE;
    delete process.env.BUNNY_STORAGE_API_KEY;
    delete process.env.BUNNY_STORAGE_CDN_URL;
  });

  describe("cuerpo binario", () => {
    it("sube los bytes intactos a Bunny Storage", async () => {
      const res = await uploadImage(post("?path=players/p1/avatar.jpg", JPEG));

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.size).toBe(JPEG.byteLength);
      expect(json.data.url).toMatch(new RegExp(`^https://cdn\\.test/players/p1/avatar-${UUID}\\.jpg$`));

      const [, init] = bunnyPuts()[0];
      expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(JPEG);
    });
  });

  describe("ruta", () => {
    it("sin path → uploads/{uuid}.{ext del tipo real}", async () => {
      const res = await uploadImage(post("", PNG, "image/png"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.path).toMatch(new RegExp(`^uploads/${UUID}\\.png$`));
      const [url, init] = bunnyPuts()[0];
      expect(url).toBe(`https://storage.bunnycdn.com/zone/${json.data.path}`);
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
      expect(ownsPlayer).not.toHaveBeenCalled();
    });

    it("avatar de un jugador PROPIO: comprueba la propiedad con el usuario del JWT", async () => {
      const res = await uploadImage(post("?path=players/p1700000000000_1/avatar", JPEG));
      expect(res.status).toBe(200);
      expect(ownsPlayer).toHaveBeenCalledWith("p1700000000000_1", "user-123");
    });

    it("la extensión la decide el tipo real, no la que pide el cliente", async () => {
      const res = await uploadImage(post("?path=players/p1/avatar.jpg", PNG, "image/png"));
      expect(res.status).toBe(200);
      expect((await res.json()).data.path).toMatch(new RegExp(`^players/p1/avatar-${UUID}\\.png$`));
    });

    it("dos subidas a la misma ruta no se pisan", async () => {
      const a = await (await uploadImage(post("?path=players/p1/avatar.jpg", JPEG))).json();
      const b = await (await uploadImage(post("?path=players/p1/avatar.jpg", JPEG))).json();
      expect(a.data.path).not.toBe(b.data.path);
    });

    it("jugador ajeno o inexistente → 403 y no sube nada", async () => {
      vi.mocked(ownsPlayer).mockResolvedValue(false);
      const res = await uploadImage(post("?path=players/otro/avatar.jpg", JPEG));
      expect(res.status).toBe(403);
      expect(bunnyPuts()).toHaveLength(0);
    });

    it.each([
      "players/p1/a.jpg",
      "players/p1/avatar.svg",
      "players/p1/avatar.html",
      "players/p1/../../index.html",
      "players/../uploads/x.jpg",
      "../x.jpg",
      "/players/p1/avatar.jpg",
      "uploads/x.jpg",
      "videos/match.mp4",
      "players/p1/sub/avatar.jpg",
      "players/p%2F1/avatar.jpg",
      "players/p1/avatar.jpg?x=1",
      "",
    ])("ruta %j → 400 sin consultar propiedad ni subir", async (path) => {
      const res = await uploadImage(post(`?path=${encodeURIComponent(path)}`, JPEG));
      expect(res.status).toBe(400);
      expect(ownsPlayer).not.toHaveBeenCalled();
      expect(bunnyPuts()).toHaveLength(0);
    });

    it("ruta demasiado larga → 400", async () => {
      const res = await uploadImage(post(`?path=players/${"a".repeat(300)}/avatar.jpg`, JPEG));
      expect(res.status).toBe(400);
      expect(bunnyPuts()).toHaveLength(0);
    });
  });

  describe("tipo", () => {
    it.each([
      ["SVG declarado como SVG", SVG, "image/svg+xml"],
      ["SVG declarado como JPEG", SVG, "image/jpeg"],
      ["HTML declarado como HTML", HTML, "text/html"],
      ["HTML declarado como PNG", HTML, "image/png"],
      ["vídeo MP4 declarado como JPEG", MP4, "image/jpeg"],
      ["vídeo MP4 declarado como vídeo", MP4, "video/mp4"],
      ["JPEG declarado como PNG", JPEG, "image/png"],
      ["JPEG declarado como HTML", JPEG, "text/html"],
    ])("%s → 415 y no sube nada", async (_label, body, ct) => {
      const res = await uploadImage(post("", body, ct));
      expect(res.status).toBe(415);
      expect(bunnyPuts()).toHaveLength(0);
    });

    it("image/jpg (alias) con bytes JPEG → 200 y se guarda como image/jpeg", async () => {
      const res = await uploadImage(post("", JPEG, "image/jpg"));
      expect(res.status).toBe(200);
      expect((await res.json()).data.contentType).toBe("image/jpeg");
    });

    it("sin Content-Type → usa el tipo real", async () => {
      const res = await uploadImage(post("", GIF, null));
      expect(res.status).toBe(200);
      expect((await res.json()).data.path).toMatch(/\.gif$/);
    });

    it("cuerpo vacío → 400", async () => {
      const res = await uploadImage(post("", new Uint8Array(0)));
      expect(res.status).toBe(400);
      expect(bunnyPuts()).toHaveLength(0);
    });

    it("sniffImageType reconoce los 4 tipos y nada más", () => {
      expect(sniffImageType(JPEG)?.mime).toBe("image/jpeg");
      expect(sniffImageType(PNG)?.mime).toBe("image/png");
      expect(sniffImageType(WEBP)?.mime).toBe("image/webp");
      expect(sniffImageType(GIF)?.mime).toBe("image/gif");
      expect(sniffImageType(SVG)).toBeNull();
      expect(sniffImageType(HTML)).toBeNull();
      expect(sniffImageType(MP4)).toBeNull();
      expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    });
  });

  it("si Bunny falla → 502 sin devolver su mensaje", async () => {
    fetchMock.mockImplementation(async () => new Response("AccessKey invalid for zone secret-zone", { status: 401 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await uploadImage(post("", JPEG));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret-zone");
    errSpy.mockRestore();
  });
});
