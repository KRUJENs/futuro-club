/**
 * VITAS · Borrado RGPD (art. 17) de los datos de UNA cuenta.
 *
 * Una sola implementación (invariante #7): la usan api/account/delete-me.ts
 * (borrado inmediato) y api/crons/data-retention.ts (borrados programados a 72 h).
 * Antes el cron tenía su propia copia, que borraba por tenant.
 *
 * SOLO los datos del DUEÑO (migración 076, decisión del 30 sep 2026): sus
 * jugadores (players.user_id), los vídeos que subió o que son de sus jugadores,
 * sus jobs de partido y los que otra cuenta lanzó sobre sus vídeos, los
 * consentimientos de sus jugadores, sus suscripciones y sus embeddings. NUNCA por
 * tenant: antes se borraban `players` / `parental_consents` (y en el cron también
 * `videos`, `analyses`, `reports` y `subscriptions`) WHERE tenant_id = <tenant del
 * usuario>, y con un tenant compartido la baja de una cuenta borraba los datos de
 * TODAS las demás cuentas de ese tenant.
 */
import { deleteBunnyVideos } from "./bunnyCleanup";
import { purgeMatchAnalysesForOwner, purgeMatchAnalysesForVideos } from "./matchJob/retention";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deleteUserDataCompletely(supabase: any, userId: string): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};

  // 0. Jugadores del usuario (dueño = players.user_id).
  const { data: ownPlayers } = await supabase.from("players").select("id").eq("user_id", userId);
  const playerIds: string[] = (ownPlayers ?? [])
    .map((p: { id: string | null }) => p.id)
    .filter((id: string | null): id is string => !!id);

  // 0-a. Vídeos a borrar, capturando bunny_video_id ANTES (al borrar players la FK
  //      videos.player_id pasa a NULL y perderíamos el vínculo): los que subió el
  //      usuario (incluidos los de partido/equipo, player_id NULL) y los de SUS
  //      jugadores aunque los subiera otra cuenta.
  const videoRows = new Map<string, string | null>();
  const addVideos = (rows: Array<{ id: string; bunny_video_id: string | null }> | null | undefined) => {
    for (const v of rows ?? []) if (v?.id) videoRows.set(v.id, v.bunny_video_id ?? null);
  };
  const { data: uploadedVideos } = await supabase.from("videos").select("id, bunny_video_id").eq("user_id", userId);
  addVideos(uploadedVideos);
  if (playerIds.length > 0) {
    const { data: playerVideos } = await supabase.from("videos").select("id, bunny_video_id").in("player_id", playerIds);
    addVideos(playerVideos);
  }
  const videoIds = [...videoRows.keys()];
  const bunnyVideoIds: Array<string | null> = [...videoRows.values()];

  // 0-bis. Jobs de partido completo (+ su fichero en Gemini) ANTES de borrar vídeos:
  //        la cascada borra la fila, pero NO el proxy del partido en Google. Los del
  //        usuario y los que otra cuenta lanzó sobre SUS vídeos.
  const matchPurge = await purgeMatchAnalysesForOwner(userId);
  const videoJobsPurge = await purgeMatchAnalysesForVideos(videoIds);
  summary.match_analyses_deleted = matchPurge.match_analyses_deleted + videoJobsPurge.match_analyses_deleted;
  summary.gemini_files_deleted = matchPurge.gemini_files_deleted + videoJobsPurge.gemini_files_deleted;
  summary.gemini_delete_errors = matchPurge.gemini_delete_errors + videoJobsPurge.gemini_delete_errors;

  // 1. Consentimientos de SUS jugadores (el audit log se conserva). Explícito,
  //    aunque la FK parental_consents.player_id → players sea ON DELETE CASCADE (003).
  let consentsDeleted = 0;
  if (playerIds.length > 0) {
    const { count: consentCount } = await supabase
      .from("parental_consents")
      .delete({ count: "exact" })
      .in("player_id", playerIds);
    consentsDeleted = consentCount ?? 0;
  }
  summary.consents_deleted = consentsDeleted;

  // 2. Players del usuario (cascade a analyses, reports… vía FK ON DELETE CASCADE).
  const { count: playersCount } = await supabase
    .from("players")
    .delete({ count: "exact" })
    .eq("user_id", userId);
  summary.players_deleted = playersCount ?? 0;

  // 2-bis. Vídeos capturados en 0-a (la cascada de players NO los borra: la FK de
  //        videos.player_id es ON DELETE SET NULL en 000_full_schema.sql).
  let videosDeleted = 0;
  if (videoIds.length > 0) {
    const { count: videosCount } = await supabase
      .from("videos")
      .delete({ count: "exact" })
      .in("id", videoIds);
    videosDeleted = videosCount ?? 0;
  }
  summary.videos_deleted = videosDeleted;

  // 3a. Embeddings de la knowledge_base que pertenezcan al user
  const { count: embedCount } = await supabase
    .from("knowledge_base")
    .delete({ count: "exact" })
    .eq("metadata->>user_id", userId);
  summary.embeddings_deleted = embedCount ?? 0;

  // 3b. Suscripciones (del usuario, nunca del tenant)
  const { count: subCount } = await supabase
    .from("subscriptions")
    .delete({ count: "exact" })
    .eq("user_id", userId);
  summary.subscriptions_deleted = subCount ?? 0;

  // 4. Bunny Stream cleanup (vídeos) — borrado real del library
  const bunnyResult = await deleteBunnyVideos(bunnyVideoIds);
  summary.bunny_deleted = bunnyResult.deleted;
  summary.bunny_failed = bunnyResult.failed;
  if (!bunnyResult.configured && bunnyVideoIds.length > 0) {
    console.warn(
      `[account-erasure] Bunny sin configurar: ${bunnyVideoIds.length} vídeos NO borrados del CDN para el usuario ${userId}`,
    );
  }

  // 5. Auth user (último paso)
  await supabase.auth.admin.deleteUser(userId);
  summary.auth_user_deleted = 1;

  return summary;
}
