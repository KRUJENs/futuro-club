/**
 * VITAS · Cron Data Retention
 * Vercel Cron: ejecuta cada noche a las 03:00 UTC
 *
 * Configuración en vercel.json:
 *   {
 *     "crons": [
 *       {
 *         "path": "/api/crons/data-retention",
 *         "schedule": "0 3 * * *"
 *       }
 *     ]
 *   }
 *
 * Tareas:
 *   1. Purgar vídeos brutos >90 días (data_retention_policies)
 *   2. Ejecutar deletion_requests programadas que ya cumplieron 72h
 *   3. Anonimizar métricas históricas pendientes
 *   4. Notificar a Slack si se eliminó >1000 registros (señal de bug)
 */

import { successResponse, errorResponse } from "../_lib/apiResponse";
import { timingSafeEqual } from "../_lib/edgeCrypto";
import { createClient } from "@supabase/supabase-js";
import { deleteBunnyVideos } from "../_lib/bunnyCleanup";
import { deleteUserDataCompletely } from "../_lib/accountErasure";
import { purgeMatchAnalysesForVideos, sweepTerminalGeminiFiles } from "../_lib/matchJob/retention";

/** Ficheros Gemini de jobs terminales barridos por ejecución (respaldo del tick de Modal). */
const GEMINI_SWEEP_LIMIT = 20;

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SLACK_WEBHOOK = process.env.SLACK_RETENTION_WEBHOOK ?? "";
const ALERT_THRESHOLD = 1000;

async function notifySlack(message: string) {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch {
    /* silent */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function purgeOldVideos(supabase: any, retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Marcar como soft-deleted primero (para auditoría)
  const { data: videosToDelete } = await supabase
    .from("videos")
    .select("id, bunny_video_id, tenant_id")
    .lt("created_at", cutoff)
    .is("deleted_at", null)
    .limit(500);

  if (!videosToDelete || videosToDelete.length === 0) return { count: 0, bunny_pending: 0 };

  // Soft delete en BBDD
  const ids = videosToDelete.map((v: { id: string }) => v.id);
  await supabase
    .from("videos")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", ids);

  // Cleanup real en Bunny Stream (borrado del fichero en el CDN)
  const bunnyIds = videosToDelete.map(
    (v: { bunny_video_id: string | null }) => v.bunny_video_id,
  );
  const bunnyResult = await deleteBunnyVideos(bunnyIds);

  // Jobs de partido de esos vídeos (+ fichero Gemini): el soft-delete NO dispara la
  // cascada de la FK → sin esto quedarían observaciones/informes huérfanos del vídeo purgado.
  const matchPurge = await purgeMatchAnalysesForVideos(ids);

  return {
    count: ids.length,
    bunny_deleted: bunnyResult.deleted,
    bunny_failed: bunnyResult.failed,
    bunny_configured: bunnyResult.configured,
    match_analyses_deleted: matchPurge.match_analyses_deleted,
    gemini_files_deleted: matchPurge.gemini_files_deleted,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executePendingDeletions(supabase: any) {
  const { data: pending } = await supabase
    .from("deletion_requests")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString());

  if (!pending || pending.length === 0) return { count: 0 };

  let executed = 0;

  for (const req of pending) {
    try {
      // Marcar como processing
      await supabase
        .from("deletion_requests")
        .update({ status: "processing" })
        .eq("id", req.id);

      // Borrar SOLO los datos de la cuenta que lo pidió (076): la misma implementación
      // que el borrado inmediato (api/_lib/accountErasure.ts, inv #7). Antes este bucle
      // borraba players, videos, analyses, reports, subscriptions y parental_consents
      // WHERE tenant_id = req.tenant_id: con un tenant compartido, la baja de UNA cuenta
      // borraba los datos de todas las demás cuentas de ese tenant.
      const summary = await deleteUserDataCompletely(supabase, req.user_id);

      // Marcar request como completed
      await supabase
        .from("deletion_requests")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          records_deleted_summary: summary,
        })
        .eq("id", req.id);

      // Audit
      await supabase.rpc("log_gdpr_action", {
        p_user_id: req.user_id,
        p_tenant_id: req.tenant_id,
        p_action: "data_deleted_scheduled",
        p_resource_type: "deletion_requests",
        p_resource_id: req.id,
        p_metadata: summary,
        p_ip: null,
      });

      executed++;
    } catch (err) {
      console.error(`[VITAS] Falló borrado ${req.id}:`, err);
      // Revertir a pending para reintento
      await supabase
        .from("deletion_requests")
        .update({ status: "pending" })
        .eq("id", req.id);
    }
  }

  return { count: executed };
}

export default async function handler(req: Request) {
  // Verificar que viene de Vercel Cron (header secreto). Fail-closed: sin
  // CRON_SECRET configurado el cron queda DESHABILITADO (503) en vez de aceptar
  // "Bearer undefined"; comparación en tiempo constante contra el secreto.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return errorResponse({ code: "cron_disabled", message: "CRON_SECRET not configured", status: 503 });
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return errorResponse({ code: "unauthorized", message: "Invalid cron auth", status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    // ── Tarea 1: purgar vídeos >90 días ────────────────────────────
    const { data: policy } = await supabase
      .from("data_retention_policies")
      .select("retention_days")
      .eq("data_type", "raw_video")
      .single();

    const retentionDays = policy?.retention_days ?? 90;
    const videoPurge = await purgeOldVideos(supabase, retentionDays);

    // ── Tarea 2: ejecutar deletion requests programadas ────────────
    const deletionExecution = await executePendingDeletions(supabase);

    // ── Tarea 2-bis: respaldo diario del borrado de proxies de partido en Gemini ──
    // (el conductor normal es el tick de Modal; esto cubre un Modal caído)
    const geminiSweep = await sweepTerminalGeminiFiles(GEMINI_SWEEP_LIMIT);

    // ── Tarea 3: alertar si volúmenes anormales ────────────────────
    const totalDeleted = videoPurge.count + deletionExecution.count;
    if (totalDeleted > ALERT_THRESHOLD) {
      await notifySlack(
        `⚠️ Cron retention eliminó ${totalDeleted} registros (>${ALERT_THRESHOLD}). Verificar.`
      );
    }

    // ── Audit ───────────────────────────────────────────────────────
    await supabase.rpc("log_gdpr_action", {
      p_user_id: null,
      p_tenant_id: null,
      p_action: "retention_cron_completed",
      p_resource_type: "system",
      p_resource_id: null,
      p_metadata: {
        videos_purged: videoPurge.count,
        deletions_executed: deletionExecution.count,
        retention_days: retentionDays,
      },
      p_ip: null,
    });

    return successResponse({
      success: true,
      executedAt: new Date().toISOString(),
      videosPurged: videoPurge.count,
      bunnyDeleted: videoPurge.bunny_deleted,
      bunnyFailed: videoPurge.bunny_failed,
      bunnyConfigured: videoPurge.bunny_configured,
      deletionsExecuted: deletionExecution.count,
      matchAnalysesPurged: videoPurge.match_analyses_deleted ?? 0,
      geminiFilesSwept: geminiSweep.deleted,
      geminiSweepErrors: geminiSweep.errors,
      retentionDays,
    });
  } catch (err) {
    await notifySlack(`🚨 Cron retention FALLÓ: ${err instanceof Error ? err.message : "unknown"}`);
    return errorResponse({
      code: "cron_failed",
      message: err instanceof Error ? err.message : "Unknown error",
      status: 500,
    });
  }
}
