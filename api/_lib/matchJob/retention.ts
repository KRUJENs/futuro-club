/**
 * VITAS · Match job — borrado RGPD y retención (una implementación, inv #7)
 *
 * Lo usan api/account/delete-me.ts (borrado de cuenta), api/crons/data-retention.ts
 * (borrados programados + purga de vídeos a los 90 días + barrido de ficheros Gemini) y
 * el conductor del job (driver.ts) al llegar a terminal.
 *
 *   - Antes de borrar filas se borra el fichero Gemini (proxy del partido, menores): la
 *     FK en cascada borra la fila pero NO el fichero en Google.
 *   - data-retention hace SOFT-delete de `videos` → la cascada de la FK no salta → aquí se
 *     borran explícitamente los jobs de esos vídeos (sin informes huérfanos).
 * Sin imports de config/ (JSON): se carga también desde funciones Edge.
 */
import { deleteFile } from "../gemini/files";
import { supabaseConfigured } from "../supabaseRest";
import * as repo from "./repo";
import type { MatchJobRow } from "./repo";

export interface MatchPurgeResult {
  match_analyses_deleted: number;
  gemini_files_deleted: number;
  gemini_delete_errors: number;
}

const EMPTY: MatchPurgeResult = { match_analyses_deleted: 0, gemini_files_deleted: 0, gemini_delete_errors: 0 };

/** Borra el fichero Gemini de un job (idempotente) y marca gemini_file_deleted_at. */
export async function deleteJobGeminiFile(job: MatchJobRow, now = new Date()): Promise<{ deleted: boolean; error: boolean }> {
  if (!job.gemini_file_name || job.gemini_file_deleted_at) return { deleted: false, error: false };
  if (!process.env.GEMINI_API_KEY) return { deleted: false, error: true };
  const ok = await deleteFile(job.gemini_file_name);
  if (!ok) return { deleted: false, error: true };
  await repo.patchJob(job.id, { gemini_file_deleted_at: now.toISOString() }, { raw: "&gemini_file_deleted_at=is.null" }).catch(() => null);
  return { deleted: true, error: false };
}

async function purgeJobs(jobs: readonly MatchJobRow[]): Promise<MatchPurgeResult> {
  const out = { ...EMPTY };
  for (const job of jobs) {
    const r = await deleteJobGeminiFile(job);
    if (r.deleted) out.gemini_files_deleted++;
    if (r.error) out.gemini_delete_errors++;
  }
  out.match_analyses_deleted = await repo.deleteJobs(jobs.map((j) => j.id));
  return out;
}

/**
 * Jobs que CREÓ el usuario (borrado de cuenta). Solo por user_id (076): antes también
 * por tenant, y con un tenant compartido la baja de una cuenta borraba los partidos
 * de las demás. Best-effort: nunca rompe el borrado del resto.
 */
export async function purgeMatchAnalysesForOwner(userId: string): Promise<MatchPurgeResult> {
  if (!supabaseConfigured()) return { ...EMPTY };
  try {
    return await purgeJobs(await repo.listJobsForUser(userId));
  } catch (err) {
    console.error("[match/retention] purga por propietario fallida:", err instanceof Error ? err.message : err);
    return { ...EMPTY, gemini_delete_errors: 1 };
  }
}

/** Jobs de vídeos purgados (retención de 90 días, soft-delete de `videos`). */
export async function purgeMatchAnalysesForVideos(videoIds: readonly string[]): Promise<MatchPurgeResult> {
  if (!supabaseConfigured() || videoIds.length === 0) return { ...EMPTY };
  try {
    return await purgeJobs(await repo.listJobsForVideos(videoIds));
  } catch (err) {
    console.error("[match/retention] purga por vídeo fallida:", err instanceof Error ? err.message : err);
    return { ...EMPTY, gemini_delete_errors: 1 };
  }
}

/** Respaldo diario: ficheros Gemini de jobs terminales que no se borraron (p. ej. Modal caído). */
export async function sweepTerminalGeminiFiles(limit: number): Promise<{ deleted: number; errors: number }> {
  if (!supabaseConfigured() || !process.env.GEMINI_API_KEY) return { deleted: 0, errors: 0 };
  let deleted = 0;
  let errors = 0;
  try {
    for (const job of await repo.listTerminalJobsWithFiles(limit)) {
      const r = await deleteJobGeminiFile(job);
      if (r.deleted) deleted++;
      if (r.error) errors++;
    }
  } catch {
    errors++;
  }
  return { deleted, errors };
}
