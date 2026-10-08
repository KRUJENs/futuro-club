/**
 * VITAS — Supabase Video Sync Service
 * DETERMINISTA — sin IA.
 *
 * Estrategia Supabase-first (Semana 4):
 *   - Supabase es la fuente de verdad
 *   - localStorage como caché de lectura rápida
 *   - Writes: localStorage optimistic → Supabase sync (await cuando online, queue cuando offline)
 *   - Pull: Supabase reemplaza localStorage (cloud es autoritativo)
 */
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { VideoService, type VideoRecord } from "./videoService";
import { SyncQueueService } from "./syncQueueService";
import { OrganizationService } from "./organizationService";

/** Valor numérico CONOCIDO (> 0). En un VideoRecord, 0 = "aún no se sabe" (stub). */
const known = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

// ── Helper: extraer columnas relacionales de un VideoRecord (025_normalize_videos + 031_video_file_hash) ─
// Las métricas de metadatos (duración, tamaño, fps…) SOLO se envían si se conocen: el
// stub local las tiene a 0 = "no se sabe" y un upsert con 0 pisaría lo que ya tenga la
// fila (invariante #2: ausencia ≠ 0). Las columnas que siembra el servidor
// (bunny_video_id, tenant_id, duration_sec — video-init/finalize) NUNCA se envían aquí.
export function videoToColumns(v: VideoRecord): Record<string, unknown> {
  const cols: Record<string, unknown> = {
    title: v.title ?? null,
    status: v.status ?? "unknown",
    status_code: v.statusCode ?? -1,
    encode_progress: v.encodeProgress ?? 0,
    thumbnail_url: v.thumbnailUrl ?? null,
    embed_url: v.embedUrl ?? "",
    stream_url: v.streamUrl ?? null,
    local_path: v.localPath ?? null,
    date_uploaded: v.dateUploaded ?? null,
    analysis_result: v.analysisResult ?? null,
    file_hash: v.fileHash ?? null,
  };
  if (known(v.duration)) cols.duration = v.duration;
  if (known(v.width)) cols.vid_width = v.width;
  if (known(v.height)) cols.vid_height = v.height;
  if (known(v.fps)) cols.fps = v.fps;
  if (known(v.storageSize)) cols.storage_size = v.storageSize;
  return cols;
}

export const SupabaseVideoService = {

  // ── PULL: Supabase → localStorage (Supabase-first: cloud es autoritativo) ──
  async pullAll(userId: string): Promise<VideoRecord[]> {
    if (!SUPABASE_CONFIGURED) return VideoService.getAll();
    try {
      const { data, error } = await supabase
        .from("videos")
        .select("id, data")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
      if (error) throw error;

      // Vídeos con cambios locales pendientes DE ESTA CUENTA. Las ops de otra cuenta
      // del dispositivo (p.ej. un jugador que A editó sin red antes de salir) no
      // cuentan: antes un recuento del dispositivo entero hacía que la nube vacía de
      // B conservara y mostrara los vídeos locales de A (y pushAll los subiera como B).
      const pendingVideoIds = new Set(
        SyncQueueService.getQueueFor(userId)
          .filter((op) => op.entity === "video")
          .map((op) => op.entityId),
      );

      if (!data || data.length === 0) {
        // Nube vacía: solo sobreviven los vídeos locales pendientes de subir de esta cuenta.
        const kept = VideoService.getAll().filter((v) => pendingVideoIds.has(v.id));
        const { StorageService } = await import("./storageService");
        StorageService.set("videos", kept);
        return kept;
      }

      // Supabase-first: cloud reemplaza localStorage. Filas sin `data` (sembradas por
      // el servidor y aún sin upsert del cliente) se omiten en vez de romper el pull.
      const cloudVideos = data
        .map((row) => row.data as VideoRecord | null)
        .filter((v): v is VideoRecord => !!v && typeof v === "object" && typeof v.id === "string");

      // Excepción: preservar analysisResult local si cloud no lo tiene
      const localVideos = VideoService.getAll();
      const localMap = new Map(localVideos.map((v) => [v.id, v]));

      const result = cloudVideos.map((cv) => {
        const lv = localMap.get(cv.id);
        if (lv?.analysisResult && !cv.analysisResult) {
          return { ...cv, analysisResult: lv.analysisResult };
        }
        return cv;
      });

      // Preservar videos locales con operaciones pendientes de ESTA cuenta (antes se
      // filtraba por `op.status`, un campo que SyncQueueItem no tiene → nunca nada).
      const cloudIds = new Set(cloudVideos.map((v) => v.id));
      for (const lv of localVideos) {
        if (pendingVideoIds.has(lv.id) && !cloudIds.has(lv.id)) {
          result.push(lv);
        }
      }

      const { StorageService } = await import("./storageService");
      StorageService.set("videos", result);
      return result;
    } catch (err) {
      console.warn("[SupabaseVideoService] pullAll failed — using local cache:", err);
      return VideoService.getAll();
    }
  },

  async pushAll(userId: string): Promise<void> {
    if (!SUPABASE_CONFIGURED) return;
    const videos = VideoService.getAll();
    if (!videos.length) return;
    try {
      // Check which players exist in Supabase to avoid FK violations. Solo jugadores
      // DEL usuario (user_id, 076): la RLS de players puede tener aún una rama por
      // tenant u organización que dejaría «ver» (y adjuntar vídeos a) un menor ajeno.
      const playerIds = [...new Set(videos.map(v => v.playerId).filter(Boolean))];
      const existingPlayerIds = new Set<string>();
      if (playerIds.length) {
        const { data } = await supabase
          .from("players")
          .select("id")
          .eq("user_id", userId)
          .in("id", playerIds as string[]);
        (data ?? []).forEach(r => existingPlayerIds.add(r.id));
      }
      const orgId = OrganizationService.getOrgId();
      const rows = videos.map((v) => ({
        id: v.id,
        user_id: userId,
        ...(orgId ? { org_id: orgId } : {}),
        player_id: v.playerId && existingPlayerIds.has(v.playerId) ? v.playerId : null,
        data: v,
        updated_at: new Date().toISOString(),
        ...videoToColumns(v),
      }));
      const { error } = await supabase
        .from("videos")
        .upsert(rows, { onConflict: "id" });
      if (error) throw error;
    } catch (err) {
      console.warn("[SupabaseVideoService] pushAll failed:", err);
    }
  },

  async pushOne(userId: string, video: VideoRecord): Promise<void> {
    if (!SUPABASE_CONFIGURED) return;
    try {
      // Verify player exists in Supabase if video has playerId.
      // - sin jugador en el registro → player_id: null explícito (desasignar es legítimo)
      // - con jugador DEL usuario (user_id, 076; no basta con que la RLS lo deje ver) → se envía
      // - con jugador NO encontrado (local, ajeno o fallo transitorio) → NO se envía la columna:
      //   así el upsert no borra el player_id que ya sembró el servidor (video-init/finalize).
      let playerColumn: { player_id: string | null } | Record<string, never> = { player_id: null };
      if (video.playerId) {
        const { data } = await supabase
          .from("players")
          .select("id")
          .eq("id", video.playerId)
          .eq("user_id", userId)
          .maybeSingle();
        playerColumn = data ? { player_id: video.playerId } : {};
      }
      const orgId = OrganizationService.getOrgId();
      const { error } = await supabase
        .from("videos")
        .upsert({
          id: video.id,
          user_id: userId,
          ...(orgId ? { org_id: orgId } : {}),
          ...playerColumn,
          data: video,
          updated_at: new Date().toISOString(),
          ...videoToColumns(video),
        }, { onConflict: "id" });
      if (error) throw error;
    } catch (err) {
      console.warn("[SupabaseVideoService] pushOne failed:", err);
    }
  },

  async deleteOne(userId: string, videoId: string): Promise<void> {
    if (!SUPABASE_CONFIGURED) return;
    try {
      const { error } = await supabase
        .from("videos")
        .delete()
        .eq("id", videoId)
        .eq("user_id", userId);
      if (error) throw error;
    } catch (err) {
      console.warn("[SupabaseVideoService] deleteOne failed:", err);
    }
  },

  // ── Supabase-first: localStorage optimistic + await Supabase sync ──

  save(userId: string, video: VideoRecord): void {
    // Optimistic: localStorage primero para UI inmediata
    VideoService.save(video);
    // Sync a Supabase (await si online, queue si offline)
    this.pushOne(userId, video).catch((err) => {
      console.warn("[SupabaseVideoService] save: Supabase failed, queuing:", err);
      SyncQueueService.enqueue("update", "video", video.id, video, userId);
    });
  },

  updateStatus(userId: string, id: string, status: VideoRecord["status"], progress?: number): VideoRecord | null {
    const updated = VideoService.updateStatus(id, status, progress);
    if (updated) {
      this.pushOne(userId, updated).catch((err) => {
        console.warn("[SupabaseVideoService] updateStatus: Supabase failed, queuing:", err);
        SyncQueueService.enqueue("update", "video", id, updated, userId);
      });
    }
    return updated;
  },

  saveAnalysis(userId: string, id: string, analysis: Parameters<typeof VideoService.saveAnalysis>[1]): VideoRecord | null {
    const updated = VideoService.saveAnalysis(id, analysis);
    if (updated) {
      this.pushOne(userId, updated).catch((err) => {
        console.warn("[SupabaseVideoService] saveAnalysis: Supabase failed, queuing:", err);
        SyncQueueService.enqueue("update", "video", id, updated, userId);
      });
    }
    return updated;
  },

  delete(userId: string, id: string): void {
    VideoService.delete(id);
    this.deleteOne(userId, id).catch((err) => {
      console.warn("[SupabaseVideoService] delete: Supabase failed, queuing:", err);
      SyncQueueService.enqueue("delete", "video", id, null, userId);
    });
  },
};
