/**
 * VITAS Phase 2 — Bunny Storage Image Upload
 * POST /api/upload/image
 *
 * Cuerpo: los bytes de la imagen (no multipart). Query opcional `path`.
 * Sube a Bunny Storage y devuelve la URL pública del CDN.
 *
 * CERRADO (oct 2026). Antes cualquier cuenta con sesión podía escribir
 * CUALQUIER byte, con CUALQUIER Content-Type, en CUALQUIER ruta de la zona:
 * pisar la foto de un menor ajeno, alojar HTML/SVG en el CDN, o subir un vídeo
 * a un host que está en la allowlist de vídeo (videoUrlGuard añade
 * BUNNY_STORAGE_CDN_URL). Ahora:
 *   · TIPO: se decide por los bytes (cabecera mágica), no por el Content-Type
 *     del cliente. Solo JPEG, PNG, WebP y GIF. SVG/HTML/vídeo → 415. Si el
 *     cliente declara otro tipo de imagen distinto del real → 415.
 *   · RUTA: la construye el servidor. El cliente solo puede pedir
 *       - nada                         → uploads/{uuid}.{ext}
 *       - players/{playerId}/avatar[.ext] → players/{playerId}/avatar-{uuid}.{ext}
 *         y SOLO si el usuario es el DUEÑO del jugador (ownsPlayer, 076).
 *     Cualquier otra ruta → 400. La extensión sale del tipo real, no del cliente.
 *     El uuid hace que la URL de la foto de un menor no se pueda adivinar (los
 *     ids de jugador llevan un timestamp) y que nadie pise un fichero existente.
 *
 * Env vars needed:
 *   BUNNY_STORAGE_ZONE        — storage zone name (e.g. "vitas-images")
 *   BUNNY_STORAGE_API_KEY     — storage zone API key
 *   BUNNY_STORAGE_CDN_URL     — CDN pull zone URL (e.g. "https://vitas-images.b-cdn.net")
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";

const QuerySchema = z.object({
  path: z.string().max(200).optional(), // e.g. "players/abc123/avatar.jpg"
});

const BUNNY_STORAGE_BASE = "https://storage.bunnycdn.com";
const MAX_BYTES = 10 * 1024 * 1024;

/** Única forma de ruta que puede pedir el cliente (además de ninguna). */
const PLAYER_AVATAR_PATH = /^players\/([A-Za-z0-9_-]{1,64})\/avatar(?:\.(?:jpe?g|png|webp|gif))?$/;

type ImageType = { mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; ext: string };

/** Tipo real por la cabecera mágica. null = no es una imagen permitida. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50  // WEBP
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && // GIF8
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61                  // 7a | 9a
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  return null;
}

/** Content-Type declarado → mime canónico (image/jpg es un alias común de JPEG). */
function declaredMime(header: string | null): string | null {
  if (!header) return null;
  const mime = header.split(";")[0].trim().toLowerCase();
  if (!mime) return null;
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

export default withHandler(
  { method: "POST", requireAuth: true, maxRequests: 30, rawBody: true },
  async ({ req, userId }) => {
    const storageZone = process.env.BUNNY_STORAGE_ZONE;
    const apiKey = process.env.BUNNY_STORAGE_API_KEY;
    const cdnUrl = process.env.BUNNY_STORAGE_CDN_URL;

    if (!storageZone || !apiKey || !cdnUrl) {
      return errorResponse(
        "BUNNY_STORAGE_ZONE / BUNNY_STORAGE_API_KEY / BUNNY_STORAGE_CDN_URL no configuradas",
        503,
        "CONFIG_MISSING",
      );
    }

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return errorResponse("Ruta de imagen no permitida", 400, "INVALID_PATH");
    }
    const requestedPath = parsed.data.path;

    // La ruta se valida ANTES de leer el cuerpo: una ruta prohibida no gasta nada.
    let playerId: string | null = null;
    if (requestedPath !== undefined) {
      const m = PLAYER_AVATAR_PATH.exec(requestedPath);
      if (!m) {
        return errorResponse(
          "Ruta de imagen no permitida. Solo se admite players/{id}/avatar.",
          400,
          "INVALID_PATH",
        );
      }
      playerId = m[1];
      // Mismo 403 para un jugador ajeno y para uno que no existe.
      if (!(await ownsPlayer(playerId, userId))) {
        return errorResponse("No autorizado para este jugador", 403, "FORBIDDEN");
      }
    }

    const fileBuffer = await req.arrayBuffer();

    if (fileBuffer.byteLength === 0) {
      return errorResponse("Empty file body", 400);
    }
    if (fileBuffer.byteLength > MAX_BYTES) {
      return errorResponse("File too large (max 10 MB)", 413);
    }

    const type = sniffImageType(new Uint8Array(fileBuffer, 0, Math.min(16, fileBuffer.byteLength)));
    if (!type) {
      return errorResponse(
        "Tipo de archivo no permitido. Usa JPG, PNG, WebP o GIF.",
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }
    const declared = declaredMime(req.headers.get("Content-Type"));
    if (declared && declared !== "application/octet-stream" && declared !== type.mime) {
      return errorResponse(
        "El contenido del archivo no coincide con su tipo declarado.",
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }

    const name = crypto.randomUUID();
    const uploadPath = playerId
      ? `players/${playerId}/avatar-${name}.${type.ext}`
      : `uploads/${name}.${type.ext}`;

    const uploadUrl = `${BUNNY_STORAGE_BASE}/${encodeURIComponent(storageZone)}/${uploadPath}`;

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        AccessKey: apiKey,
        "Content-Type": type.mime,
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      // El cuerpo de error de Bunny va al log, no al cliente.
      const errText = await uploadRes.text().catch(() => "");
      console.error(`[upload/image] Bunny Storage ${uploadRes.status}: ${errText.slice(0, 300)}`);
      return errorResponse("No se pudo subir la imagen", 502, "UPLOAD_FAILED");
    }

    const publicUrl = `${cdnUrl.replace(/\/+$/, "")}/${uploadPath}`;

    return successResponse({
      url: publicUrl,
      path: uploadPath,
      size: fileBuffer.byteLength,
      contentType: type.mime,
    });
  },
);

export const config = { runtime: "edge" };
