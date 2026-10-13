/**
 * VITAS · Match job — URLs de Bunny construidas SOLO en servidor
 *
 *   - Fuente del worker: playlist HLS de la variante más pequeña ≥ proxyHeight, desde
 *     bunny_video_id (de la fila `videos` propia) + BUNNY_CDN_HOSTNAME. Nunca una URL del
 *     cliente. Validada con la allowlist compartida (api/_lib/videoUrlGuard.ts, #288).
 *     La ruta exacta de la variante está "pendiente de validar" (spike h) → vive en
 *     config (hlsVariantPathTemplate). Sin firmar: si el pull zone usa token auth, el
 *     spike (h) lo dirá (403) y se añadirá la firma aquí (sourceUrlExpiresAt hoy null).
 *   - Embed para los chips de evidencia (UI): player.mediadelivery.net/embed/{lib}/{guid};
 *     si BUNNY_EMBED_TOKEN_KEY está definida, `token = sha256_hex(key + videoId + expires)`
 *     (https://docs.bunny.net/docs/stream-embed-token-authentication). La UI añade `t`.
 */
import { sha256Hex } from "../edgeCrypto";
import { assertAllowedVideoUrl } from "../videoUrlGuard";
import { BUNNY_GUID_RE as GUID_RE } from "../bunnyGuid";
import { MATCH_VIDEO_CONFIG as CFG } from "./config";
const VARIANT_RE = /^(\d{3,4})p$/;

/** Variante más pequeña ≥ minHeight; si ninguna llega, la mayor disponible; null si no hay. */
export function pickTargetVariant(available: readonly string[], minHeight: number): string | null {
  const heights = available
    .map((r) => VARIANT_RE.exec(r.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  if (heights.length === 0) return null;
  const pick = heights.find((h) => h >= minHeight) ?? heights[heights.length - 1];
  return `${pick}p`;
}

function cdnHost(): string | null {
  const v = (process.env.BUNNY_CDN_HOSTNAME ?? process.env.VITE_BUNNY_CDN_HOSTNAME ?? "").trim();
  if (!v) return null;
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).hostname;
  } catch {
    return null;
  }
}

/** URL HLS de la variante (lanza VideoUrlError si el host no está en la allowlist). */
export function hlsSourceUrl(videoGuid: string, variant: string): string {
  if (!GUID_RE.test(videoGuid)) throw new Error("bunny_video_id no es un GUID válido");
  if (!VARIANT_RE.test(variant)) throw new Error("variante no válida");
  const host = cdnHost();
  if (!host) throw new Error("BUNNY_CDN_HOSTNAME no configurado");
  const path = CFG.hlsVariantPathTemplate.replace("{videoId}", videoGuid).replace("{variant}", variant);
  return assertAllowedVideoUrl(`https://${host}${path}`).href;
}

/** URL base del embed (firmada si hay embed token auth). null si falta la librería o el GUID no es válido. */
export async function playbackEmbed(videoGuid: string, nowMs = Date.now()): Promise<{ embedUrl: string; tokenExpiresAt: string | null } | null> {
  const libraryId = (process.env.BUNNY_STREAM_LIBRARY_ID ?? "").trim();
  if (!/^\d+$/.test(libraryId) || !GUID_RE.test(videoGuid)) return null;
  const base = `${CFG.embedBaseUrl.replace(/\/+$/, "")}/${libraryId}/${videoGuid}`;
  const key = process.env.BUNNY_EMBED_TOKEN_KEY;
  if (!key) return { embedUrl: base, tokenExpiresAt: null };
  const expires = Math.floor(nowMs / 1000) + CFG.playbackTokenTtlSec;
  const token = await sha256Hex(`${key}${videoGuid}${expires}`);
  return { embedUrl: `${base}?token=${token}&expires=${expires}`, tokenExpiresAt: new Date(expires * 1000).toISOString() };
}
