/**
 * VITAS · Cron Worker · Rescue Tracking Jobs (Vision V4 · fase V4.5)
 * Vercel Cron: GET /api/crons/rescue-tracking-jobs
 *
 * Red de seguridad de la cola async de tracking (tracking_jobs). Dos deberes:
 *
 *  1. RESCATE de spawns huérfanos — filas 'queued' SIN modal_call_id (el edge
 *     murió entre insert y spawn, o Modal estaba caído). Se reclaman con la RPC
 *     atómica `claim_queued_tracking_jobs` (FOR UPDATE SKIP LOCKED, filtra
 *     modal_call_id IS NULL, marca processing + attempts+1) y se re-spawnean.
 *     - spawn OK  → PATCH modal_call_id (queda processing, el webhook cierra).
 *     - spawn KO  → attempts < MAX_ATTEMPTS: vuelve a 'queued' (próximo cron);
 *                   attempts >= MAX_ATTEMPTS: 'failed' definitivo.
 *
 *  2. REAPER de 'processing' colgados — started_at más viejo que
 *     STALE_PROCESSING_HOURS sin callback (Modal timeout es 1h; default 2h)
 *     → 'failed' con error explícito. PATCH condicional (no pisa un 'done'
 *     que llegue en la carrera).
 *
 * Mismo contrato de auth que process-analyses-queue: Bearer CRON_SECRET.
 * Nota Vercel Hobby: crons máx. 1×/día → esto es un BACKSTOP, no el camino
 * primario (el spawn directo en track-async lo es). Con plan Pro, subir a
 * cada 15-30 min en vercel.json.
 *
 * CONSENTIMIENTO ANTES DEL RE-SPAWN (hallazgo B3 de la review del PR #308): la RLS de
 * la 052 (`tracking_jobs_insert`) deja a CUALQUIER usuario con sesión insertar una fila
 * con su propio user_id; nace 'queued' con modal_call_id NULL y la RPC de claim la
 * reclama. Así que "un job reclamado" NO prueba que pasara por track-async. Antes de
 * mandar nada a Modal, cada job pasa por el MISMO gate que track-async
 * (api/_lib/analysisConsentGate · gateClipAnalysis), en nombre de su user_id:
 *   - la URL tiene que estar en la allowlist de vídeo (la misma que track-async);
 *   - el job tiene que tener user_id; ese usuario tiene que gestionar TODAS las filas
 *     `videos` del vídeo (por el GUID de la URL y el video_id) y a CADA jugador, antes de
 *     leer ninguna fecha de nacimiento (el job y su `error` los lee quien lo insertó);
 *   - tiene que haber una declaración del entrenador YA GUARDADA con el vídeo (la que
 *     guardó track-async; el rescate no acepta declaraciones);
 *   - menor de 14 conocido ⇒ consentimiento parental verificado.
 * Bloqueado → el job queda `failed` con el motivo y NO se llama a Modal. Un fallo de la
 * base al comprobar (consent_check_failed) devuelve el job a 'queued' (reintento; los
 * intentos ya cuentan). El body del spawn de un job permitido NO cambia (contrato con
 * Modal intacto: test byte a byte en rescue-tracking-jobs-consent.test.ts).
 */

import { errorResponse, successResponse } from "../_lib/apiResponse";
import { timingSafeEqual } from "../_lib/edgeCrypto";
import {
  supabaseRestUrl,
  serviceHeaders,
  supabaseConfigured,
  patchTrackingJob,
} from "../_lib/supabaseRest";
import { env } from "../_lib/env";
import { assertAllowedVideoUrl, VideoUrlError } from "../_lib/videoUrlGuard";
import { gateClipAnalysis } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = { runtime: "edge" };

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 3;
const STALE_PROCESSING_HOURS = Number(process.env.STALE_PROCESSING_HOURS ?? 2);

/** Fila que devuelve claim_queued_tracking_jobs (RETURNING * de tracking_jobs, 052). */
interface ClaimedJob {
  id: string;
  video_url: string;
  sample_fps: number;
  attempts: number;
  video_id?: string | null;
  player_id?: string | null;
  user_id?: string | null;
}

type JobGate =
  /** `videoUrl` = la URL normalizada que comprobó el gate (la que track-async ya guardó). */
  | { allowed: true; videoUrl: string }
  | { allowed: false; code: string; reason: string; retry: boolean };

/**
 * B3: el MISMO gate que track-async, en nombre del usuario que insertó el job. Nunca
 * acepta una declaración (solo una guardada con el vídeo). `retry` = fallo de la base al
 * comprobar (se reintenta en el próximo cron), no una decisión.
 */
async function gateRescuedJob(job: ClaimedJob): Promise<JobGate> {
  let videoUrl: string;
  try {
    videoUrl = assertAllowedVideoUrl(job.video_url).href;
  } catch (err) {
    // Sin hosts de Bunny configurados es configuración, no una decisión sobre el job:
    // vuelve a la cola (los intentos ya cuentan). Fuera de la allowlist → failed.
    if (err instanceof VideoUrlError) {
      return { allowed: false, code: err.code, reason: err.message, retry: err.code === "VIDEO_HOSTS_NOT_CONFIGURED" };
    }
    return { allowed: false, code: "VIDEO_URL_INVALID", reason: "URL de vídeo no válida", retry: false };
  }
  if (!job.user_id) {
    return {
      allowed: false,
      code: "no_user",
      reason: "Job sin usuario: no se puede comprobar la declaración ni la propiedad del vídeo.",
      retry: false,
    };
  }
  const gate = await gateClipAnalysis({
    videoId: job.video_id ?? undefined,
    videoUrl, // Modal descargará ESTA URL → su GUID es el vídeo que se analiza
    requireVideoRow: true,
    storedOnly: true,
    playerId: job.player_id ?? null,
    actor: { userId: job.user_id, tenantId: null },
    endpoint: "crons/rescue-tracking-jobs",
    scope: job.player_id ? "player" : "team",
    ownsVideo: (video, uid) => ownsVideo(video, uid),
    ownsPlayer: (pid, uid) => ownsPlayer(pid, uid),
  });
  if (gate.allowed) return { allowed: true, videoUrl };
  return { allowed: false, code: gate.code, reason: gate.gate_reason, retry: gate.code === "consent_check_failed" };
}

export default async function handler(req: Request): Promise<Response> {
  // Fail-closed: sin CRON_SECRET el cron queda deshabilitado (503) en vez de
  // aceptar "Bearer undefined"; comparación en tiempo constante contra el secreto.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return errorResponse({ code: "cron_disabled", message: "CRON_SECRET not configured", status: 503 });
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return errorResponse({ code: "unauthorized", message: "Invalid cron auth", status: 401 });
  }
  if (!supabaseConfigured()) {
    return errorResponse({ code: "no_supabase", message: "Supabase no configurado", status: 503 });
  }

  const details: Array<Record<string, unknown>> = [];

  // ── 1 · Reaper de processing colgados ─────────────────────────────────
  const cutoff = new Date(Date.now() - STALE_PROCESSING_HOURS * 3_600_000).toISOString();
  let reaped = 0;
  const reap = await fetch(
    `${supabaseRestUrl()}/rest/v1/tracking_jobs` +
      `?status=eq.processing&started_at=lt.${encodeURIComponent(cutoff)}`,
    {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        status: "failed",
        error: `Sin callback tras ${STALE_PROCESSING_HOURS}h — job dado por muerto (reaper V4.5)`,
        finished_at: new Date().toISOString(),
      }),
    },
  );
  if (reap.ok) {
    const rows = (await reap.json().catch(() => [])) as Array<{ id: string }>;
    reaped = rows.length;
    for (const r of rows) details.push({ id: r.id, action: "reaped_stale_processing" });
  } else {
    details.push({ action: "reap_failed", status: reap.status });
  }

  // ── 2 · Rescate de spawns huérfanos (RPC atómica) ─────────────────────
  const modalAsyncUrl = process.env.MODAL_TRACK_ASYNC_URL;
  const modalKey = process.env.MODAL_API_KEY;
  const callbackSecret = process.env.MODAL_CALLBACK_SECRET;
  let rescued = 0;
  let buried = 0;

  if (!modalAsyncUrl || !modalKey || !callbackSecret) {
    // Sin Modal configurado no hay re-spawn posible; el reaper ya corrió.
    return successResponse({
      timestamp: new Date().toISOString(),
      reaped,
      rescued: 0,
      buried: 0,
      skippedRescue: "modal_env_missing",
      details,
    });
  }

  const claim = await fetch(`${supabaseRestUrl()}/rest/v1/rpc/claim_queued_tracking_jobs`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ batch_size: BATCH_SIZE }),
  });
  if (!claim.ok) {
    const t = await claim.text().catch(() => "");
    details.push({ action: "claim_failed", status: claim.status, detail: t.slice(0, 200) });
    return successResponse({
      timestamp: new Date().toISOString(),
      reaped,
      rescued,
      buried,
      details,
    });
  }
  const jobs = (await claim.json().catch(() => [])) as ClaimedJob[];

  for (const job of jobs) {
    // La RPC ya incrementó attempts al reclamar.
    if (job.attempts > MAX_ATTEMPTS) {
      await patchTrackingJob(job.id, {
        status: "failed",
        error: `Spawn fallido tras ${MAX_ATTEMPTS} intentos (cron V4.5)`,
        finished_at: new Date().toISOString(),
      }).catch(() => null);
      buried++;
      details.push({ id: job.id, action: "buried_max_attempts", attempts: job.attempts });
      continue;
    }

    // B3: el gate de consentimiento ANTES de mandar nada a Modal.
    const gate = await gateRescuedJob(job);
    if (!gate.allowed) {
      if (gate.retry) {
        await patchTrackingJob(job.id, { status: "queued", error: gate.reason.slice(0, 300) }).catch(() => null);
        details.push({ id: job.id, action: "requeued_consent_check_failed", code: gate.code, attempts: job.attempts });
      } else {
        await patchTrackingJob(job.id, {
          status: "failed",
          error: gate.reason.slice(0, 300),
          finished_at: new Date().toISOString(),
        }).catch(() => null);
        details.push({ id: job.id, action: "consent_blocked", code: gate.code });
      }
      continue;
    }

    let ok = false;
    let detail = "";
    try {
      const spawn = await fetch(modalAsyncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${modalKey}` },
        body: JSON.stringify({
          // La URL que comprobó el gate (normalizada); para un job de track-async es
          // idéntica a job.video_url, que ya se guardó normalizada.
          video_url: gate.videoUrl,
          sample_fps: job.sample_fps ?? 5,
          classes: [0, 32],
          job_id: job.id,
          callback_url: `${env.publicUrl}/api/webhooks/modal-tracking`,
        }),
      });
      if (spawn.ok) {
        const data = (await spawn.json().catch(() => ({}))) as { call_id?: string };
        await patchTrackingJob(job.id, { modal_call_id: data.call_id ?? null }).catch(() => null);
        ok = true;
      } else {
        detail = `modal ${spawn.status}`;
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : "modal unreachable";
    }

    if (ok) {
      rescued++;
      details.push({ id: job.id, action: "respawned", attempts: job.attempts });
    } else {
      // Devolver a la cola para el próximo cron (attempts ya cuenta el intento).
      await patchTrackingJob(job.id, { status: "queued", error: detail.slice(0, 300) }).catch(
        () => null,
      );
      details.push({ id: job.id, action: "requeued_spawn_failed", attempts: job.attempts, detail });
    }
  }

  return successResponse({
    timestamp: new Date().toISOString(),
    reaped,
    rescued,
    buried,
    claimed: jobs.length,
    details,
  });
}
