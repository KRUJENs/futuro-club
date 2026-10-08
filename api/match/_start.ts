/**
 * VITAS · POST /api/match/start — arranca un job de partido completo por vídeo
 *
 * Orden de comprobaciones (docs/diseno-partido-completo.md §5.1):
 *   1. requireAuth (sin allowServiceToken) + requiredPlan (fail-closed, withHandler).
 *   2. matchStartRequestSchema (estricto: `playerContext` o cualquier clave por jugador = 400).
 *      Declaración ausente / falsa / versión distinta → 400 attestation_required.
 *   3. MATCH_VIDEO_ENABLED === "true" → si no, 503 match_video_disabled ("análisis de
 *      partido completo en validación": APAGADO por defecto, decisión del owner del
 *      2026-09-29 hasta que el motor supere scripts/validate-match-observation.mjs). Variables
 *      necesarias ausentes → 503 real_inference_disabled con los NOMBRES (nunca valores).
 *      ANTHROPIC_API_KEY no bloquea: sin ella el informe se abstiene (report_engine_unavailable).
 *   4. Fila `videos` (service role) + ownsVideo → 404 / 403.
 *   5. `length` de la API de Bunny (nunca videos.duration) > MAX_MATCH_DURATION_MIN → 422.
 *   6. Dedup: job activo del mismo vídeo + purpose + kits → se devuelve (deduplicated:true).
 *   7. Concurrencia: 1 activo por usuario (+ índice único en BD) y tope global → 429.
 *   8. Presupuesto: gastado + reservas activas + estimación ≥ GLOBAL_MONTHLY_BUDGET_USD → 429.
 *   9. Insert (service role) con la declaración (attested_by = usuario del JWT, reloj del
 *      servidor) y la reserva; si Bunny ya terminó el encode, se despacha en el acto.
 */
import { withHandler } from "../_lib/withHandler";
import { errorResponse, successResponse } from "../_lib/apiResponse";
import { ownsVideo } from "../_lib/ownership";
import { sha256Hex } from "../_lib/edgeCrypto";
import { wouldExceedBudget } from "../_lib/budgetGuard";
import { BUNNY_API_VIDEO_STATUS } from "../_lib/bunnyStream";
import {
  MATCH_ATTESTATION_VERSION,
  matchStartRequestSchema,
  matchStartResponseSchema,
  usdAmountSchema,
  type MatchStartRequest,
} from "../../src/lib/shared/matchJob/contract";
import { GEMINI_MODEL } from "../../src/lib/shared/geminiModel";
import { MAX_MATCH_DURATION_SEC, knownDurationSec } from "../../src/lib/shared/videoLimits";
import { MATCH_VIDEO_CONFIG as CFG } from "../_lib/matchJob/config";
import { isMatchVideoEnabled, missingMatchEnv } from "../_lib/matchJob/availability";
import { availabilityReason } from "../_lib/matchJob/messages";
import { estimateMatchCost } from "../_lib/matchJob/costing";
import { processAwaitingJob, readBunnyVideo } from "../_lib/matchJob/driver";
import * as repo from "../_lib/matchJob/repo";

export { missingMatchEnv };

/** Huella de dedup: purpose + equipo foco + colores declarados (normalizados). */
export async function kitFingerprint(req: MatchStartRequest): Promise<string> {
  const kit = (k: MatchStartRequest["home"]["kit"]) =>
    k ? [k.shirt.hex.toLowerCase(), k.shorts?.hex.toLowerCase() ?? "", k.gk?.hex.toLowerCase() ?? ""].join("/") : "";
  return sha256Hex(JSON.stringify([req.purpose, req.focusTeam ?? "", kit(req.home.kit), kit(req.away.kit)]));
}

export default withHandler(
  { method: "POST", requireAuth: true, requiredPlan: "pro,club", maxRequests: 10 },
  async ({ body, userId, tenantId }) => {
    if (!userId) return errorResponse({ message: "No autenticado", status: 401, code: "unauthorized" });

    // 2 · contrato estricto
    const parsed = matchStartRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const attestationIssue = parsed.error.issues.some((i) => i.path[0] === "attestation");
      if (attestationIssue) {
        return errorResponse({
          message: "Falta la declaración de consentimiento y derechos sobre el vídeo (o su versión no es la vigente).",
          status: 400,
          code: "attestation_required",
          details: { attestationVersion: MATCH_ATTESTATION_VERSION },
        });
      }
      return errorResponse({
        message: "Datos inválidos",
        status: 400,
        code: "invalid_input",
        details: { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const req = parsed.data;

    // 3 · kill switch (APAGADO por defecto hasta superar la validación) + claves
    if (!isMatchVideoEnabled()) {
      const reason = availabilityReason(req.locale, "match_video_disabled");
      return errorResponse({ message: reason, status: 503, code: "match_video_disabled", details: { gate_reason: reason } });
    }
    const missing = missingMatchEnv();
    if (missing.length > 0) {
      const reason = availabilityReason(req.locale, "real_inference_disabled");
      return errorResponse({
        message: reason,
        status: 503,
        code: "real_inference_disabled",
        details: { gate_reason: reason, missing },
      });
    }

    // 4 · propiedad del vídeo (service role salta RLS → se comprueba en código)
    const video = await repo.getVideoRow(req.videoId);
    if (!video || !video.bunny_video_id) {
      return errorResponse({ message: "Vídeo no encontrado", status: 404, code: "video_not_found" });
    }
    if (!(await ownsVideo(video, userId))) {
      return errorResponse({ message: "No autorizado para este vídeo", status: 403, code: "not_owner" });
    }

    // 5 · duración REAL (API de Bunny; lectura)
    const bunny = await readBunnyVideo({ bunny_video_id: video.bunny_video_id });
    const lengthSec = knownDurationSec(bunny?.length);
    if (lengthSec !== null && lengthSec > MAX_MATCH_DURATION_SEC) {
      return errorResponse({
        message: "El vídeo supera la duración máxima de un partido.",
        status: 422,
        code: "video_too_long",
        details: { durationSec: lengthSec, maxDurationSec: MAX_MATCH_DURATION_SEC },
      });
    }

    // 6 · dedup
    const fingerprint = await kitFingerprint(req);
    const existing = await repo.findActiveDedup({ userId, videoId: video.id, purpose: req.purpose, kitFingerprint: fingerprint });
    if (existing) {
      const estimate = usdAmountSchema.safeParse(existing.estimate);
      if (estimate.success) {
        return successResponse(
          matchStartResponseSchema.parse({ jobId: existing.id, status: existing.status, deduplicated: true, estimate: estimate.data }),
        );
      }
    }

    // 7 · concurrencia
    if ((await repo.countActiveJobs({ userId })) >= CFG.maxActiveJobsPerUser) {
      return errorResponse({ message: "Ya tienes un análisis de partido en curso.", status: 429, code: "concurrency_limit", details: { scope: "user" } });
    }
    if ((await repo.countActiveJobs()) >= CFG.maxActiveJobsGlobal) {
      return errorResponse({
        message: "Hay demasiados análisis de partido en curso; inténtalo más tarde.",
        status: 429,
        code: "concurrency_limit",
        details: { scope: "global" },
      });
    }

    // 8 · presupuesto con reserva
    const est = estimateMatchCost({ durationSec: lengthSec, purpose: req.purpose, geminiModel: GEMINI_MODEL });
    const budget = await wouldExceedBudget(est.amount.usd);
    if (budget.exceeded) {
      return errorResponse({
        message: "Presupuesto mensual de IA insuficiente para este partido.",
        status: 429,
        code: "budget_exceeded",
        details: { estimate: est.amount },
      });
    }

    // 9 · insert (service role) + despacho inmediato si ya está codificado
    const now = new Date();
    const inserted = await repo.insertJob({
      user_id: userId,
      org_id: video.org_id,
      tenant_id: tenantId ?? video.tenant_id,
      video_id: video.id,
      bunny_video_id: video.bunny_video_id,
      purpose: req.purpose,
      home: req.home,
      away: req.away,
      focus_team: req.focusTeam ?? null,
      attacking_dir_1h: req.attackingDir1h ?? null,
      notes: req.notes && req.notes.length > 0 ? req.notes : null,
      category: req.category ?? null,
      locale: req.locale,
      kit_fingerprint: fingerprint,
      attested_by: userId,
      attested_at: now.toISOString(),
      attestation_version: req.attestation.version,
      status: "awaiting_encode",
      duration_sec: lengthSec,
      bunny_status: bunny ? bunny.status : null,
      estimate: est.amount,
      estimate_usd: est.amount.usd,
      reservation_usd: est.amount.usd,
    });
    if (!inserted.ok) {
      if (inserted.conflict) {
        return errorResponse({ message: "Ya tienes un análisis de partido en curso.", status: 429, code: "concurrency_limit", details: { scope: "user" } });
      }
      return errorResponse({ message: "No se pudo crear el análisis de partido.", status: 500, code: "internal_error" });
    }

    let current = inserted.job;
    if (bunny && bunny.status === BUNNY_API_VIDEO_STATUS.FINISHED) {
      await processAwaitingJob(inserted.job, now, bunny);
      current = (await repo.getJob(inserted.job.id)) ?? inserted.job;
    }
    const estimate = usdAmountSchema.safeParse(current.estimate);
    return successResponse(
      matchStartResponseSchema.parse({
        jobId: inserted.job.id,
        status: current.status,
        deduplicated: false,
        estimate: estimate.success ? estimate.data : est.amount,
      }),
    );
  },
);
