/**
 * ImageService — Tests
 * Validación, upload, preview de imágenes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mockCreateObjectURL = vi.fn(() => "blob:preview");
const mockRevokeObjectURL = vi.fn();
vi.stubGlobal("URL", {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
});

import { ImageService } from "@/services/real/imageService";

const makeFile = (name: string, type: string, sizeKB = 100) => {
  const file = new File(["x".repeat(sizeKB * 1024)], name, { type });
  return file;
};

describe("ImageService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validate() acepta JPEG válido", () => {
    const result = ImageService.validate(makeFile("photo.jpg", "image/jpeg"));
    expect(result.valid).toBe(true);
  });

  it("validate() acepta PNG válido", () => {
    const result = ImageService.validate(makeFile("photo.png", "image/png"));
    expect(result.valid).toBe(true);
  });

  it("validate() acepta WebP válido", () => {
    const result = ImageService.validate(makeFile("photo.webp", "image/webp"));
    expect(result.valid).toBe(true);
  });

  it("validate() rechaza tipo no soportado", () => {
    const result = ImageService.validate(makeFile("doc.pdf", "application/pdf"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBeDefined();
  });

  it("validate() rechaza archivo >10MB", () => {
    const bigFile = makeFile("huge.jpg", "image/jpeg", 11 * 1024);
    const result = ImageService.validate(bigFile);
    expect(result.valid).toBe(false);
  });

  it("upload() llama a /api/upload/image", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, url: "https://cdn.test/img.jpg", path: "img.jpg" }),
    });
    const result = await ImageService.upload(makeFile("photo.jpg", "image/jpeg"), "players/p1/avatar");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/upload/image?path=players%2Fp1%2Favatar",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.success).toBe(true);
  });

  it("upload() maneja error de red", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const result = await ImageService.upload(makeFile("photo.jpg", "image/jpeg"), "players/p1/avatar");
    expect(result.success).toBe(false);
  });

  it("uploadPlayerAvatar() usa path de jugador", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { url: "https://cdn.test/avatar.jpg", path: "avatars/p1.jpg", size: 1000, contentType: "image/jpeg" } }),
    });
    // El servidor ignora la extensión del nombre: IMG_0001.JPG no debe dar 400.
    const result = await ImageService.uploadPlayerAvatar("p1", makeFile("IMG_0001.JPG", "image/jpeg"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/upload/image?path=players%2Fp1%2Favatar",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.url).toContain("avatar");
  });

  it("createPreview() devuelve blob URL", () => {
    const url = ImageService.createPreview(makeFile("photo.jpg", "image/jpeg"));
    expect(url).toBe("blob:preview");
    expect(mockCreateObjectURL).toHaveBeenCalled();
  });

  it("revokePreview() limpia blob URL", () => {
    ImageService.revokePreview("blob:preview");
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("upload() maneja response no ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "server error" }),
    });
    const result = await ImageService.upload(makeFile("photo.jpg", "image/jpeg"), "players/p1/avatar");
    expect(result.success).toBe(false);
  });
});
