/**
 * VITAS Phase 2 — Image Upload Service
 * DETERMINISTA — no IA.
 *
 * Uploads images to Bunny Storage via /api/upload/image.
 * Used for player avatars, team logos, etc.
 */
import { supabase } from "@/lib/supabase";

export interface ImageUploadResult {
  url: string;
  path: string;
  size: number;
  contentType: string;
}

export const ImageService = {
  /**
   * Upload a File/Blob to Bunny Storage.
   * @param file   - the image file
   * @param path   - requested path; the server only accepts "players/{playerId}/avatar"
   *                 for a player the user owns, and builds the final path itself
   * @returns public CDN URL
   */
  async upload(
    file: File | Blob,
    path: string
  ): Promise<{ success: true; data: ImageUploadResult } | { success: false; error: string; phase2Pending?: boolean }> {
    try {
      const qs = `?path=${encodeURIComponent(path)}`;
      const headers: Record<string, string> = { "Content-Type": file.type || "image/jpeg" };
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) {
          headers["Authorization"] = `Bearer ${data.session.access_token}`;
        }
      } catch { /* no session */ }
      const res = await fetch(`/api/upload/image${qs}`, {
        method: "POST",
        headers,
        body: file,
      });

      const data = await res.json() as {
        success: boolean;
        data?: ImageUploadResult;
        error?: string;
        phase2Pending?: boolean;
      };

      if (!data.success) {
        return {
          success: false,
          error: data.error ?? "Upload failed",
          phase2Pending: data.phase2Pending,
        };
      }

      return { success: true, data: data.data! };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  },

  /**
   * Upload a player avatar (only the player's owner may).
   * The server stores it as players/{playerId}/avatar-{uuid}.{ext}, with the
   * extension taken from the file's real type, and returns that URL.
   */
  async uploadPlayerAvatar(
    playerId: string,
    file: File
  ): Promise<{ success: true; url: string } | { success: false; error: string }> {
    const result = await this.upload(file, `players/${playerId}/avatar`);
    if (!result.success) return result;
    return { success: true, url: result.data.url };
  },

  /**
   * Validate image before upload.
   */
  validate(file: File): { valid: true } | { valid: false; error: string } {
    const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

    if (!ALLOWED.includes(file.type)) {
      return { valid: false, error: `Tipo no permitido: ${file.type}. Usa JPG, PNG, WebP o GIF.` };
    }
    if (file.size > MAX_SIZE) {
      return { valid: false, error: `Archivo muy grande (max 10 MB). Tamaño actual: ${(file.size / 1024 / 1024).toFixed(1)} MB.` };
    }
    return { valid: true };
  },

  /**
   * Create a local preview URL (blob URL) for instant preview before upload.
   */
  createPreview(file: File): string {
    return URL.createObjectURL(file);
  },

  revokePreview(url: string): void {
    URL.revokeObjectURL(url);
  },
};
