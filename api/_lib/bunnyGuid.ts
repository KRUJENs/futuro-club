/**
 * VITAS · Forma de los identificadores de vídeo que el servidor mete en una URL
 *
 * Una sola implementación (invariante #7) para:
 *   - el GUID de Bunny Stream (`videos.bunny_video_id`, el primer segmento de la pull
 *     zone, `/library/<lib>/videos/<guid>` de la API). Es un UUID: la misma forma que ya
 *     exigía el job de partido completo (api/_lib/matchJob/bunnySource.ts).
 *   - la referencia de vídeo que manda el CLIENTE (`videos.id`, el GUID, `vid-<hex>` de
 *     create-upload o `local-<ts>-<rand>` de un vídeo solo del navegador).
 *
 * Por qué (hallazgo B4 de la review del PR #308): `pipeline/start` metía el `videoId` del
 * body tal cual en la URL de la API de Bunny y de la miniatura. Con `a/../<GUID ajeno>`
 * el gate buscaba la fila `a/../…` (propia) pero `fetch` resolvía los puntos y el servidor
 * leía el vídeo `<GUID ajeno>`. Un GUID con otra forma (barras, puntos, `%`, espacios) se
 * rechaza ANTES de buscar nada; además, donde un id entra en una URL se escapa con
 * encodeURIComponent (defensa en profundidad).
 *
 * Sin `node:*` → vale para Edge y Node.
 */

/** UUID (8-4-4-4-12, hex). */
export const BUNNY_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Es un GUID de Bunny Stream (UUID)? */
export function isBunnyGuid(v: unknown): v is string {
  return typeof v === "string" && BUNNY_GUID_RE.test(v);
}

/**
 * Referencia de vídeo del cliente: letras/dígitos ASCII, `-` y `_`, empieza por letra o
 * dígito, hasta 128. Cubre los formatos que genera la app (GUID, `vid-<hex>`,
 * `local-<ts>-<rand>`, `video_<ts>_<rand>`). Nunca `/`, `.`, `%`, espacios ni comillas.
 */
export const SAFE_VIDEO_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** ¿Es una referencia de vídeo con forma segura? */
export function isSafeVideoRef(v: unknown): v is string {
  return typeof v === "string" && SAFE_VIDEO_REF_RE.test(v);
}
