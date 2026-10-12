/**
 * VITAS · Allowlist de URLs de vídeo para fetches server-side (SSRF + coste)
 *
 * Antes, cualquier usuario autenticado podía mandar un `videoUrl` arbitrario y el
 * backend lo descargaba (video-observation), lo reenviaba a Modal (track-async) o lo
 * guardaba para descargarlo después (live/matches → live/aggregate). Eso permitía
 * apuntar a endpoints internos (metadata de la nube, redes privadas) y a ficheros
 * enormes que se pagan en Gemini/Modal.
 *
 * Política (única, compartida por todos los callers; espejo en Python en
 * vision-pipeline/app.py → misma env, mismas reglas):
 *   - Solo `https:`, sin credenciales en la URL, sin puerto explícito (≠ 443).
 *   - Host EXACTO dentro de los hosts Bunny configurados por env:
 *       BUNNY_CDN_HOSTNAME / VITE_BUNNY_CDN_HOSTNAME  (pull zone de Stream: play_*.mp4)
 *       BUNNY_STORAGE_CDN_URL                        (pull zone de Storage)
 *       VIDEO_URL_EXTRA_HOSTS                        (lista CSV opcional, hosts exactos)
 *     + `video.bunnycdn.com` SOLO bajo `/library/<BUNNY_STREAM_LIBRARY_ID>/videos/`.
 *     NO se admite el comodín `*.b-cdn.net`: cualquier cuenta Bunny puede crear una
 *     zona ahí, así que el sufijo no prueba que el contenido sea nuestro.
 *   - Nunca IPs literales ni nombres internos (localhost, *.local, *.internal),
 *     tampoco si vienen de la env.
 *   - Sin BUNNY_CDN_HOSTNAME (ni su alias VITE_) → FALLA CERRADO
 *     (VIDEO_HOSTS_NOT_CONFIGURED), nunca abierto.
 *
 * `fetchAllowedVideo` además: redirecciones MANUALES re-validando cada salto
 * (máx. 3), content-type `video/*` obligatorio y techo de tamaño comprobado por
 * Content-Length ANTES de leer y otra vez mientras se lee (por si falta o miente).
 *
 * Sin `node:*` imports → vale para funciones Edge y Node.
 */

type Env = Record<string, string | undefined>;

/** Saltos de redirección que se siguen como máximo (cada uno re-validado). */
export const MAX_VIDEO_REDIRECTS = 3;

/**
 * Techo por defecto para vídeo que se BUFFERIZA en memoria (video-observation:
 * bytes → base64 → Gemini, ~4× el tamaño en pico). Configurable con
 * VIDEO_FETCH_MAX_BYTES. 200 MiB cubre clips de varios minutos a 720p.
 */
export const DEFAULT_MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Host de la API de Bunny Stream (URL de respaldo cuando no hay pull zone). */
const BUNNY_LIBRARY_API_HOST = "video.bunnycdn.com";
const MAX_URL_LENGTH = 2048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type VideoUrlErrorCode =
  | "VIDEO_HOSTS_NOT_CONFIGURED"
  | "VIDEO_URL_INVALID"
  | "VIDEO_URL_NOT_ALLOWED"
  | "VIDEO_REDIRECT_NOT_ALLOWED"
  | "VIDEO_TOO_MANY_REDIRECTS"
  | "VIDEO_NOT_VIDEO"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_DOWNLOAD_FAILED";

const STATUS_BY_CODE: Record<VideoUrlErrorCode, number> = {
  VIDEO_HOSTS_NOT_CONFIGURED: 503,
  VIDEO_URL_INVALID: 400,
  VIDEO_URL_NOT_ALLOWED: 400,
  VIDEO_REDIRECT_NOT_ALLOWED: 502,
  VIDEO_TOO_MANY_REDIRECTS: 502,
  VIDEO_NOT_VIDEO: 415,
  VIDEO_TOO_LARGE: 413,
  VIDEO_DOWNLOAD_FAILED: 502,
};

export class VideoUrlError extends Error {
  readonly code: VideoUrlErrorCode;
  /** HTTP status sugerido para devolver al cliente. */
  readonly status: number;

  constructor(code: VideoUrlErrorCode, message: string) {
    super(message);
    this.name = "VideoUrlError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export interface VideoHostPolicy {
  /** Hosts exactos permitidos (minúsculas, sin punto final). */
  hosts: ReadonlySet<string>;
  /** Prefijo de ruta permitido en video.bunnycdn.com, o null si no hay librería. */
  libraryPathPrefix: string | null;
}

/** IP literal (v4/v6) o nombre que solo resuelve dentro de una red privada. */
function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h) return true;
  if (h.includes(":")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 literal (WHATWG ya normaliza 0x7f.1, 2130706433…)
  // Última etiqueta numérica/hex → forma de IP que otro parser podría resolver (127.1, 0x7f000001).
  const last = h.split(".").pop() ?? "";
  if (/^(0x[0-9a-f]*|\d+)$/.test(last)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

/** Normaliza un host de env ("vz-x.b-cdn.net", "https://vz-x.b-cdn.net/") → hostname o null. */
function hostFromEnvValue(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  try {
    const host = new URL(v.includes("://") ? v : `https://${v}`).hostname.replace(/\.$/, "").toLowerCase();
    if (!host || isInternalHost(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Construye la política desde env. Lanza VIDEO_HOSTS_NOT_CONFIGURED si no hay
 * host de CDN de Bunny válido: sin él no sabemos qué es "nuestro" → falla cerrado.
 */
export function videoHostPolicy(env: Env = process.env): VideoHostPolicy {
  const cdnHosts = [env.BUNNY_CDN_HOSTNAME, env.VITE_BUNNY_CDN_HOSTNAME]
    .map(hostFromEnvValue)
    .filter((h): h is string => !!h);
  if (cdnHosts.length === 0) {
    throw new VideoUrlError(
      "VIDEO_HOSTS_NOT_CONFIGURED",
      "Descarga de vídeo deshabilitada: BUNNY_CDN_HOSTNAME no está configurado (allowlist de hosts vacía).",
    );
  }
  const hosts = new Set<string>(cdnHosts);
  const storageHost = hostFromEnvValue(env.BUNNY_STORAGE_CDN_URL);
  if (storageHost) hosts.add(storageHost);
  for (const extra of (env.VIDEO_URL_EXTRA_HOSTS ?? "").split(",")) {
    const h = hostFromEnvValue(extra);
    if (h) hosts.add(h);
  }
  const libraryId = (env.BUNNY_STREAM_LIBRARY_ID ?? "").trim();
  const libraryPathPrefix = /^\d+$/.test(libraryId) ? `/library/${libraryId}/videos/` : null;
  return { hosts, libraryPathPrefix };
}

/**
 * Valida (sin red) que `raw` es una URL de vídeo nuestra. Devuelve la URL
 * normalizada — usar SIEMPRE `url.href` para el fetch, no el string original.
 */
export function assertAllowedVideoUrl(raw: unknown, env: Env = process.env): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new VideoUrlError("VIDEO_URL_INVALID", "videoUrl debe ser una URL https no vacía.");
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new VideoUrlError("VIDEO_URL_INVALID", "videoUrl demasiado larga.");
  }
  // Espacios, backslashes o caracteres de control: fuente clásica de diferencias
  // entre parsers (validador vs cliente HTTP). Se rechazan en vez de normalizar.
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) {
    throw new VideoUrlError("VIDEO_URL_INVALID", "videoUrl contiene caracteres no permitidos.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VideoUrlError("VIDEO_URL_INVALID", "videoUrl no es una URL válida.");
  }
  if (url.protocol !== "https:") {
    throw new VideoUrlError("VIDEO_URL_NOT_ALLOWED", "Solo se admiten URLs https de nuestro CDN de vídeo.");
  }
  if (url.username || url.password) {
    throw new VideoUrlError("VIDEO_URL_NOT_ALLOWED", "videoUrl no puede llevar credenciales.");
  }
  if (url.port && url.port !== "443") {
    throw new VideoUrlError("VIDEO_URL_NOT_ALLOWED", "videoUrl no puede usar un puerto no estándar.");
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (isInternalHost(host)) {
    throw new VideoUrlError("VIDEO_URL_NOT_ALLOWED", "videoUrl apunta a una IP o a un host interno.");
  }

  const policy = videoHostPolicy(env);
  if (policy.hosts.has(host)) return url;
  if (
    host === BUNNY_LIBRARY_API_HOST &&
    policy.libraryPathPrefix !== null &&
    url.pathname.startsWith(policy.libraryPathPrefix)
  ) {
    return url;
  }
  throw new VideoUrlError("VIDEO_URL_NOT_ALLOWED", `Host de vídeo no permitido: ${host}`);
}

/** URL de la allowlist + el vídeo de Bunny STREAM que sirve (null si el host no es de Stream). */
export interface StreamVideoUrl {
  /** URL normalizada (assertAllowedVideoUrl): usar SIEMPRE `url.href` para el fetch/Modal. */
  url: URL;
  /** GUID del vídeo de Stream cuyos píxeles sirve la URL; null = la URL no identifica un vídeo. */
  guid: string | null;
}

/**
 * Qué vídeo de Bunny STREAM sirve una URL (ronda 5 de la review del PR #308, B7). Lanza
 * VideoUrlError si la URL no pasa la allowlist (host ajeno, sin BUNNY_CDN_HOSTNAME…).
 *   - pull zone de Stream (BUNNY_CDN_HOSTNAME / VITE_BUNNY_CDN_HOSTNAME): el PRIMER segmento
 *     de la ruta es el GUID del vídeo (`/<guid>/play_720p.mp4`);
 *   - video.bunnycdn.com/library/<BUNNY_STREAM_LIBRARY_ID>/videos/<guid>/…: el segmento tras
 *     `/videos/`;
 *   - los DEMÁS hosts de la allowlist (pull zone de Storage, VIDEO_URL_EXTRA_HOSTS) → guid null:
 *     ahí el primer segmento es una carpeta (hasta el PR #310 api/upload/image escribía en
 *     Storage en la ruta que mandaba el cliente), no un vídeo, así que no sirve para ligar la
 *     declaración del entrenador a los píxeles.
 * El GUID se devuelve tal cual (sin decodificar); quien lo use comprueba su forma (bunnyGuid).
 *
 * Ronda 6 (B7 residual): la ruta tiene que tener la forma EXACTA de un fichero de ese vídeo,
 * `/<guid>/<fichero>` (o `/library/<id>/videos/<guid>[/<fichero>]`), sin `%` ni segmentos de
 * más. Antes solo se miraba el PRIMER segmento: `/<guid propio>/..%2F<guid ajeno>%2Fplay.mp4`
 * pasaba con el GUID declarado y llegaba así a Modal (la URL de WHATWG no resuelve `%2F`), y
 * si el CDN lo decodifica serviría los píxeles del vídeo ajeno. Cualquier otra forma → guid null
 * (la URL no identifica un vídeo y el gate la bloquea).
 */
const STREAM_FILE_PATH = /^\/([A-Za-z0-9_-]{1,128})\/((?!\.+$)[A-Za-z0-9._-]{1,128})$/;
const LIBRARY_VIDEO_PATH = /^\/library\/\d+\/videos\/([A-Za-z0-9_-]{1,128})(?:\/((?!\.+$)[A-Za-z0-9._-]{1,128}))?$/;

export function streamVideoFromUrl(raw: unknown, env: Env = process.env): StreamVideoUrl {
  const url = assertAllowedVideoUrl(raw, env);
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const streamHosts = new Set(
    [env.BUNNY_CDN_HOSTNAME, env.VITE_BUNNY_CDN_HOSTNAME].map(hostFromEnvValue).filter((h): h is string => !!h),
  );
  if (streamHosts.has(host)) return { url, guid: STREAM_FILE_PATH.exec(url.pathname)?.[1] ?? null };
  if (host === BUNNY_LIBRARY_API_HOST) {
    return { url, guid: LIBRARY_VIDEO_PATH.exec(url.pathname)?.[1] ?? null };
  }
  return { url, guid: null };
}

/** Variante booleana (sin lanzar) para pre-checks baratos. */
export function isAllowedVideoUrl(raw: unknown, env: Env = process.env): boolean {
  try {
    assertAllowedVideoUrl(raw, env);
    return true;
  } catch {
    return false;
  }
}

/** Techo de bytes efectivo: VIDEO_FETCH_MAX_BYTES si es un entero positivo, si no el default. */
export function maxVideoBytes(env: Env = process.env): number {
  const n = Number(env.VIDEO_FETCH_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_VIDEO_BYTES;
}

export interface FetchedVideo {
  bytes: Uint8Array;
  /** Content-type esencial (sin parámetros), garantizado `video/*`. */
  contentType: string;
  /** URL final tras las redirecciones permitidas. */
  finalUrl: string;
}

export interface FetchVideoOptions {
  env?: Env;
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* sin cuerpo o ya consumido */
  }
}

function tooLarge(cap: number): VideoUrlError {
  const mb = (cap / (1024 * 1024)).toFixed(0);
  return new VideoUrlError("VIDEO_TOO_LARGE", `El vídeo supera el máximo permitido (${mb} MB).`);
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(cap);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Descarga un vídeo de la allowlist con redirecciones manuales re-validadas,
 * content-type `video/*` y techo de tamaño. Lanza VideoUrlError (con `status`
 * HTTP sugerido); errores de red del fetch se propagan tal cual.
 */
export async function fetchAllowedVideo(raw: unknown, opts: FetchVideoOptions = {}): Promise<FetchedVideo> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchImpl ?? fetch;
  const cap = opts.maxBytes ?? maxVideoBytes(env);
  const maxRedirects = opts.maxRedirects ?? MAX_VIDEO_REDIRECTS;

  let current = assertAllowedVideoUrl(raw, env);
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(current.href, { redirect: "manual", signal: opts.signal });

    if (REDIRECT_STATUSES.has(res.status)) {
      await discardBody(res);
      if (hop >= maxRedirects) {
        throw new VideoUrlError("VIDEO_TOO_MANY_REDIRECTS", `Demasiadas redirecciones (máx. ${maxRedirects}).`);
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new VideoUrlError("VIDEO_DOWNLOAD_FAILED", `Redirección HTTP ${res.status} sin cabecera Location.`);
      }
      let next: URL;
      try {
        next = assertAllowedVideoUrl(new URL(location, current).href, env);
      } catch (err) {
        if (err instanceof VideoUrlError && err.code === "VIDEO_HOSTS_NOT_CONFIGURED") throw err;
        throw new VideoUrlError("VIDEO_REDIRECT_NOT_ALLOWED", "El CDN redirigió a un host no permitido.");
      }
      current = next;
      continue;
    }
    // Runtimes tipo navegador devuelven una redirección opaca (sin Location legible).
    if (res.type === "opaqueredirect") {
      throw new VideoUrlError("VIDEO_REDIRECT_NOT_ALLOWED", "Redirección no verificable.");
    }
    if (!res.ok) {
      await discardBody(res);
      throw new VideoUrlError(
        "VIDEO_DOWNLOAD_FAILED",
        `No se pudo descargar el video desde CDN: HTTP ${res.status}`,
      );
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("video/")) {
      await discardBody(res);
      throw new VideoUrlError(
        "VIDEO_NOT_VIDEO",
        `El recurso no es un vídeo (content-type: ${contentType || "ausente"}).`,
      );
    }

    const declared = res.headers.get("content-length");
    if (declared !== null && declared.trim() !== "") {
      const n = Number(declared);
      if (Number.isFinite(n) && n > cap) {
        await discardBody(res);
        throw tooLarge(cap);
      }
    }

    const bytes = await readCapped(res, cap);
    if (bytes.byteLength === 0) {
      throw new VideoUrlError("VIDEO_DOWNLOAD_FAILED", "El CDN devolvió un vídeo vacío.");
    }
    return { bytes, contentType, finalUrl: current.href };
  }
}
