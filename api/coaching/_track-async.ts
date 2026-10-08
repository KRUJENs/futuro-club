/**
 * VITAS · POST /api/coaching/track-async  (Vision V4 · fase V4.2)
 *
 * Enqueue de tracking GPU para vídeos LARGOS (partidos completos). El proxy
 * síncrono (_track-players) rechaza >MAX_SYNC_TRACK_SEC; este endpoint:
 *   1. Deduplica: si ya hay un job queued/processing para el mismo vídeo,
 *      devuelve ese jobId (doble-click ≠ doble GPU).
 *   2. Inserta una fila en tracking_jobs (status=queued) con el service key.
 *   3. Dispara el spawn en Modal (track_async → {call_id}) y marca la fila
 *      processing (el claim RPC solo rescata queued sin modal_call_id).
 *   4. Responde 202 { jobId }; el cliente hace polling por track-status.
 *
 * Env: MODAL_TRACK_ASYNC_URL, MODAL_API_KEY, MODAL_CALLBACK_SECRET (obligatoria:
 * sin ella el webhook no puede autenticar callbacks → fail-fast aquí, no fail-open
 * allí). callback_url se resuelve VITAS_PUBLIC_URL ?? PUBLIC_URL ?? VERCEL_URL
 * (convención de api/webhooks/modal-callback.ts) — nunca queda relativa.
 *
 * El secret NO viaja en el payload: Modal guarda su propia copia (Modal secret,
 * fase V4.3) y firma el rawBody del callback → X-Vitas-Signature.
 *
 * Contrato 503 idéntico al proxy síncrono ({error:"real_inference_disabled"} a
 * pelo) para que el cliente reutilice el mismo check de fallback.
 *
 * videoUrl: solo hosts Bunny de la allowlist (api/_lib/videoUrlGuard). Fuera de
 * ella → 400 sin encolar; sin BUNNY_CDN_HOSTNAME → 503 (falla cerrado).
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): en las
 * llamadas con JWT de USUARIO el servidor resuelve el vídeo por el GUID de la `videoUrl`
 * (y el `videoId` si viene): tiene que haber una fila `videos` de ESE vídeo, todas sus
 * filas tienen que ser del usuario y el jugador de cada fila se comprueba SIEMPRE, además
 * del `playerId` del body (que tiene que ser suyo). Declaración del entrenador (body o
 * guardada con el vídeo) + consentimiento parental si hay un menor de 14 conocido. Va
 * DESPUÉS de los 503/400/413 de siempre y ANTES del dedup, del insert y del spawn; un
 * bloqueo es 400/403/404/500, nunca 503. Para una llamada permitida el spawn a Modal es
 * BYTE A BYTE el de antes (test en api/coaching/__tests__/track-async-consent.test.ts).
 * Las llamadas de servicio y el rescate (crons/rescue-tracking-jobs) no cambian.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import {
  supabaseRestUrl,
  serviceHeaders,
  supabaseConfigured,
  patchTrackingJob,
} from "../_lib/supabaseRest";
import { env } from "../_lib/env";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import { assertAllowedVideoUrl, VideoUrlError } from "../_lib/videoUrlGuard";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = { runtime: "edge" };

/** Techo async (defensa de coste): 3h por defecto, configurable por env. */
const MAX_ASYNC_TRACK_SEC = Number(process.env.MAX_ASYNC_TRACK_SEC ?? 10_800);

const schema = z.object({
  videoUrl: z.string().url(),
  videoId: z.string().optional(),
  playerId: z.string().optional(),
  sampleFps: z.number().int().min(1).max(30).optional(),
  durationSec: z.number().int().positive().optional(),
  orgId: z.string().uuid().optional(),
  /** Solo llamadas de servicio: atribuye el job a un usuario concreto. */
  userId: z.string().uuid().optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (llamadas de usuario). */
  attestation: z.unknown().optional(),
});

export default withHandler(
  { method: ["POST"], schema, requireAuth: true, allowServiceToken: true, maxRequests: 10 },
  async ({ body, userId, tenantId, isServiceCall, ip }) => {
    const modalAsyncUrl = process.env.MODAL_TRACK_ASYNC_URL;
    const modalKey = process.env.MODAL_API_KEY;
    const callbackSecret = process.env.MODAL_CALLBACK_SECRET;

    // Config incompleta → mismo shape a pelo que _track-players (el cliente
    // comprueba body.error === "real_inference_disabled" para su fallback).
    if (!modalAsyncUrl || !modalKey || !callbackSecret) {
      return bare(
        {
          error: "real_inference_disabled",
          reason:
            "MODAL_TRACK_ASYNC_URL / MODAL_API_KEY / MODAL_CALLBACK_SECRET no configurados.",
        },
        503,
      );
    }
    if (!supabaseConfigured()) {
      return errorResponse({
        code: "no_supabase",
        message: "Supabase no configurado — la cola de tracking requiere persistencia.",
        status: 503,
      });
    }

    // Allowlist de host (api/_lib/videoUrlGuard): Modal descargará esta URL, así que
    // solo se encolan vídeos de NUESTRO CDN Bunny (antes: cualquier URL → SSRF/coste
    // GPU). Sin BUNNY_CDN_HOSTNAME falla cerrado (503 → el cliente cae a su fallback).
    // Modal re-valida con la misma env (defensa en profundidad).
    let videoUrl: string;
    try {
      videoUrl = assertAllowedVideoUrl(body.videoUrl).href;
    } catch (err) {
      if (err instanceof VideoUrlError) {
        return errorResponse({ code: err.code, message: err.message, status: err.status });
      }
      throw err;
    }

    // Techo de duración (el proxy síncrono tiene el suyo; este es el async).
    if (typeof body.durationSec === "number" && body.durationSec > MAX_ASYNC_TRACK_SEC) {
      return errorResponse({
        code: "video_too_long",
        message: `Vídeo de ${Math.round(body.durationSec / 60)} min supera el máximo async (${Math.round(MAX_ASYNC_TRACK_SEC / 60)} min).`,
        status: 413,
      });
    }

    // Consentimiento de las llamadas de USUARIO: antes del dedup, del insert y del spawn.
    if (!isServiceCall) {
      if (body.playerId && !(await ownsPlayer(body.playerId, userId))) {
        return errorResponse({ code: "forbidden", message: "No gestionas este jugador", status: 403 });
      }
      const consent = await gateClipAnalysis({
        videoId: body.videoId,
        videoUrl, // Modal descargará ESTA URL → su GUID es el vídeo que se analiza
        requireVideoRow: true,
        attestation: body.attestation,
        playerId: body.playerId ?? null,
        actor: { userId, tenantId, ip },
        endpoint: "coaching/track-async",
        scope: body.playerId ? "player" : "team",
        ownsVideo: (video, uid) => ownsVideo(video, uid),
      });
      if (!consent.allowed) return clipGateErrorResponse(consent);
    }

    // Atribución: usuario del JWT; las llamadas de servicio pueden atribuir
    // explícitamente (body.userId) para que el dueño real vea su job.
    const ownerId = userId ?? (isServiceCall ? body.userId ?? null : null);

    // 1 ── Dedup: job pendiente para el mismo vídeo → devolver el existente.
    const dedupUrl =
      `${supabaseRestUrl()}/rest/v1/tracking_jobs` +
      `?video_url=eq.${encodeURIComponent(videoUrl)}` +
      `&status=in.(queued,processing)` +
      (ownerId ? `&user_id=eq.${encodeURIComponent(ownerId)}` : "") +
      `&select=id,status&limit=1`;
    const dup = await fetch(dedupUrl, { headers: serviceHeaders() });
    if (dup.ok) {
      const rows = (await dup.json().catch(() => [])) as Array<{ id: string; status: string }>;
      if (rows.length) {
        return successResponse({ jobId: rows[0].id, status: rows[0].status, deduped: true }, 200);
      }
    }
    // dedup no-ok → seguimos (peor caso: job duplicado; mejor que bloquear).

    // Tripwire de presupuesto (054): solo tras el dedup (un dedup-hit no gasta
    // GPU). Si el mes superó el tope → no encolar ni spawnear. Fail-open.
    if (await isOverBudget()) return budgetExceededResponse();

    // 2 ── Insertar el job (queued). Sin try/catch local: un throw de red debe
    // burbujear a withHandler, que SÍ loguea estructurado (el catch local lo
    // silenciaba — hallazgo de la review).
    const ins = await fetch(`${supabaseRestUrl()}/rest/v1/tracking_jobs`, {
      method: "POST",
      headers: serviceHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        video_id: body.videoId ?? null,
        video_url: videoUrl,
        player_id: body.playerId ?? null,
        user_id: ownerId,
        org_id: body.orgId ?? null,
        sample_fps: body.sampleFps ?? 5,
        duration_sec: body.durationSec ?? null,
      }),
    });
    if (!ins.ok) {
      const t = await ins.text().catch(() => "");
      return errorResponse({
        code: "enqueue_failed",
        message: `No se pudo crear el job: ${ins.status} ${t.slice(0, 200)}`,
        status: 500,
      });
    }
    const inserted = (await ins.json().catch(() => [])) as Array<{ id: string }>;
    const jobId = inserted[0]?.id;
    if (!jobId) {
      // 201 sin representación (proxy que quita el Prefer) → sin id no podemos
      // continuar el flujo; error explícito mejor que TypeError.
      return errorResponse({
        code: "enqueue_failed",
        message: "Insert OK pero sin representación de la fila (Prefer: return=representation).",
        status: 500,
      });
    }

    // 3 ── Spawn en Modal. Errores de red → markFailed + 502.
    let spawn: Response;
    try {
      spawn = await fetch(modalAsyncUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modalKey}`,
        },
        body: JSON.stringify({
          video_url: videoUrl,
          sample_fps: body.sampleFps ?? 5,
          classes: [0, 32],
          job_id: jobId,
          callback_url: `${env.publicUrl}/api/webhooks/modal-tracking`,
        }),
      });
    } catch (err) {
      await markFailed(jobId, err instanceof Error ? err.message : "modal unreachable");
      return errorResponse({
        code: "modal_unreachable",
        message: "No se pudo contactar con Modal para lanzar el tracking.",
        status: 502,
      });
    }
    if (!spawn.ok) {
      const detail = await spawn.text().catch(() => "");
      await markFailed(jobId, `modal spawn ${spawn.status}: ${detail.slice(0, 300)}`);
      return errorResponse({
        code: "modal_spawn_failed",
        message: `Modal rechazó el spawn (${spawn.status}).`,
        status: 502,
      });
    }

    // El parse del body es INFORMATIVO (call_id): si falla, el job sigue corriendo
    // en Modal — nunca marcar failed por esto (review C3).
    const spawnData = (await spawn.json().catch(() => ({}))) as {
      call_id?: string;
      status?: string;
      reason?: string;
    };

    // Modal responde 200 con {status:"error", reason} cuando RECHAZA sin spawnear
    // (p. ej. URL fuera de su allowlist o sin configurar). Sin call_id no hay nada
    // corriendo → marcar failed ya, en vez de dejar un "processing" colgado.
    if (!spawnData.call_id && spawnData.status === "error") {
      await markFailed(jobId, `modal rejected: ${String(spawnData.reason ?? "unknown").slice(0, 200)}`);
      return errorResponse({
        code: "modal_rejected",
        message: `Modal rechazó el tracking (${String(spawnData.reason ?? "unknown").slice(0, 80)}).`,
        status: 502,
      });
    }

    // Spawn aceptado → contabiliza el gasto estimado (la llamada de pago más cara).
    await recordSpendUsd("modal-track-async");

    // 4 ── Marcar processing (+call_id). Crítico para que el claim RPC (rescate
    // de spawns fallidos: queued AND modal_call_id IS NULL) no re-lance jobs
    // que ya corren. Si este PATCH falla lo logueamos alto y claro.
    const mark = await patchTrackingJob(jobId, {
      status: "processing",
      started_at: new Date().toISOString(),
      modal_call_id: spawnData.call_id ?? null,
    }).catch(() => null);
    if (!mark || !mark.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          scope: "track-async",
          msg: "job spawned but could not be marked processing — rescue cron may double-spawn",
          jobId,
        }),
      );
    }

    return successResponse({ jobId, status: "processing" }, 202);
  },
);

async function markFailed(jobId: string, error: string): Promise<void> {
  try {
    await patchTrackingJob(jobId, {
      status: "failed",
      error,
      finished_at: new Date().toISOString(),
    });
  } catch {
    // best-effort — el cron V4.5 detectará el job colgado
  }
}

/** Shape a pelo (sin envelope) — contrato compartido con _track-players. */
function bare(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
