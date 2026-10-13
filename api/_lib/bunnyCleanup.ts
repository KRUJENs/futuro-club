/**
 * VITAS · Bunny Stream cleanup helper
 *
 * Borra vídeos de Bunny Stream (GDPR Art. 17 — derecho al olvido, y retención
 * automática de datos). Usado por:
 *   - api/account/delete-me.ts        (borrado de cuenta)
 *   - api/crons/data-retention.ts     (purga de vídeos >90 días)
 *
 * Bunny Stream delete API:
 *   DELETE https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}
 *   header: AccessKey: {libraryApiKey}
 *
 * Diseño defensivo:
 *   - Si faltan credenciales, devuelve {configured:false} sin lanzar
 *     (no bloquea el borrado del resto de datos).
 *   - Best-effort por vídeo: un fallo individual no aborta el lote.
 *   - Concurrency limitada para no saturar la API de Bunny.
 */

// Credenciales leídas en CADA llamada (no al cargar el módulo): mismo valor en prod y
// así un llamador que lee el env por petición (p. ej. upload/video-init al deshacer una
// subida sin declaración guardada) borra con la misma librería con la que creó.
function bunnyLibraryId(): string {
  return process.env.BUNNY_STREAM_LIBRARY_ID ?? "";
}
function bunnyApiKey(): string {
  return process.env.BUNNY_STREAM_API_KEY ?? process.env.BUNNY_API_KEY ?? "";
}

export interface BunnyCleanupResult {
  configured: boolean;
  attempted: number;
  deleted: number;
  failed: number;
  errors: string[];
}

/** Borra un único vídeo de Bunny. Devuelve true si 200/404 (404 = ya no existe). */
async function deleteOne(bunnyVideoId: string): Promise<boolean> {
  const res = await fetch(
    `https://video.bunnycdn.com/library/${bunnyLibraryId()}/videos/${bunnyVideoId}`,
    {
      method: "DELETE",
      headers: { AccessKey: bunnyApiKey(), Accept: "application/json" },
    },
  );
  // 404 → el vídeo ya no está en Bunny; lo tratamos como éxito idempotente.
  return res.ok || res.status === 404;
}

/**
 * Borra un lote de vídeos de Bunny por sus bunny_video_id.
 * Ignora ids nulos/vacíos. Concurrency = 3 (respeta rate limit de Bunny).
 */
export async function deleteBunnyVideos(
  bunnyVideoIds: Array<string | null | undefined>,
): Promise<BunnyCleanupResult> {
  const ids = bunnyVideoIds.filter((x): x is string => Boolean(x));
  const result: BunnyCleanupResult = {
    configured: Boolean(bunnyLibraryId() && bunnyApiKey()),
    attempted: ids.length,
    deleted: 0,
    failed: 0,
    errors: [],
  };

  if (!result.configured) {
    // Sin credenciales: no podemos borrar en Bunny, pero no bloqueamos el
    // borrado del resto. El caller debería loguear que quedó pendiente.
    result.failed = ids.length;
    if (ids.length > 0) {
      result.errors.push("Bunny credentials not configured (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY)");
    }
    return result;
  }

  if (ids.length === 0) return result;

  // Concurrency 3 vía slices
  const CONCURRENCY = 3;
  const slices: string[][] = Array.from({ length: CONCURRENCY }, () => []);
  ids.forEach((id, i) => slices[i % CONCURRENCY].push(id));

  await Promise.all(
    slices.map(async (slice) => {
      for (const id of slice) {
        try {
          const ok = await deleteOne(id);
          if (ok) result.deleted++;
          else {
            result.failed++;
            if (result.errors.length < 10) result.errors.push(`Failed to delete ${id}`);
          }
        } catch (err) {
          result.failed++;
          if (result.errors.length < 10) {
            result.errors.push(`${id}: ${err instanceof Error ? err.message : "unknown"}`);
          }
        }
      }
    }),
  );

  return result;
}
