/**
 * VITAS · Webhook Bunny Stream
 * POST /api/webhooks/bunny-uploaded
 *
 * Llamado por Bunny cuando cambia el estado de codificación de un vídeo.
 * Contrato OFICIAL (https://bunny.net/docs/stream-webhook):
 *
 *   Body:  { "VideoLibraryId": 133, "VideoGuid": "657bb740-…", "Status": 3 }
 *   Cabeceras de firma:
 *     X-BunnyStream-Signature-Version:   v1
 *     X-BunnyStream-Signature-Algorithm: hmac-sha256
 *     X-BunnyStream-Signature:           HMAC-SHA256(body CRUDO) en hex minúsculas,
 *                                        con la Read-Only API key de la librería.
 *
 * Estados del WEBHOOK (≠ estados de la API REST · ver api/_lib/bunnyStream.ts):
 *   3 = Finished (codificación terminada, vídeo disponible) → ÚNICO que dispara trabajo.
 *   4 = Resolution finished → llega UNA VEZ POR RESOLUCIÓN → se ignora (antes se trataba
 *       como "terminado" por confusión con el enum de la API, donde 4 = Finished).
 *   5 = Failed → se registra.
 *
 * Operador: BUNNY_WEBHOOK_SECRET debe contener la **Read-Only API key** de la librería
 * de Bunny Stream (Stream → librería → API). Sin ella: 503 fail-closed.
 *
 * Flujo (solo Status = 3):
 *   1. Validar firma (fail-closed, tiempo constante) sobre el body CRUDO
 *   2. Buscar la fila `videos` (por bunny_video_id; la crea video-init / create-upload)
 *   3. Gate honesto: un vídeo más largo que SYNC_ANALYSIS_MAX_DURATION_SEC NO se encola
 *      en la cola Gemini de clips cortos (fallaría). El partido completo lo analizará el
 *      futuro match-analysis job. Duración desconocida → no se bloquea, no se inventa.
 *   4. Encolar el análisis (impl compartida con finalize, inv #7). enqueueAnalysis exige
 *      la declaración del entrenador GUARDADA con el vídeo (y el consentimiento parental
 *      de un menor de 14 conocido); si falta → 200 { skipped, reason: <código> } para que
 *      Bunny no reintente (api/_lib/analysisConsentGate).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { enqueueAnalysis } from "../_lib/enqueueAnalysis";
import {
  BUNNY_WEBHOOK_STATUS,
  getBunnyVideo,
  verifyBunnyWebhookSignature,
} from "../_lib/bunnyStream";
import {
  evaluateSyncAnalysisGate,
  knownDurationSec,
  SYNC_ANALYSIS_GATE_CODE,
} from "../../src/lib/shared/videoLimits";

export const config = { runtime: "edge" };

const bunnySchema = z.object({
  VideoLibraryId: z.number(),
  VideoGuid: z.string().min(1),
  Status: z.number(),
});

export default withHandler(
  // rawBody: la firma es del body EXACTO; sin esto ctx.rawBody era null y el HMAC se
  // calculaba sobre "" → ninguna firma real podía coincidir (webhook muerto).
  { rawBody: true, requireAuth: false, maxRequests: 200 },
  async ({ headers, rawBody }) => {
    // Env leída por request (no a nivel de módulo): sin estado global y testeable.
    const webhookSecret = process.env.BUNNY_WEBHOOK_SECRET ?? "";

    // ── Fail-CLOSED sin secret ──────────────────────────────
    if (!webhookSecret) {
      console.error("[VITAS] BUNNY_WEBHOOK_SECRET no configurado — rechazando webhook (fail-closed)");
      return errorResponse({
        code: "webhook_not_configured",
        message: "Webhook signature secret not configured",
        status: 503,
      });
    }

    // ── Validar firma Bunny (ANTES de parsear nada) ──────────
    const raw = rawBody ?? "";
    if (!(await verifyBunnyWebhookSignature(webhookSecret, raw, headers))) {
      return errorResponse({
        code: "invalid_signature",
        message: "Bunny webhook signature mismatch",
        status: 401,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return errorResponse({ code: "invalid_json", message: "Invalid JSON body", status: 400 });
    }
    const parsed = bunnySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return errorResponse({ code: "invalid_payload", message: "Invalid Bunny webhook payload", status: 400 });
    }
    const payload = parsed.data;

    // Solo "Finished" (3) es terminal. "Resolution finished" (4) llega por resolución.
    if (payload.Status !== BUNNY_WEBHOOK_STATUS.FINISHED) {
      if (payload.Status === BUNNY_WEBHOOK_STATUS.FAILED) {
        console.error(`[VITAS] Bunny reporta fallo de codificación en video ${payload.VideoGuid}`);
      }
      return successResponse({
        skipped: true,
        reason: `status=${payload.Status} (only Status=${BUNNY_WEBHOOK_STATUS.FINISHED} Finished triggers processing)`,
      });
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!supabaseUrl || !serviceKey) {
      return errorResponse({ code: "supabase_not_configured", message: "Database not configured", status: 503 });
    }
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // ── Buscar el video en nuestra BBDD ────────────────────
    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("id, tenant_id, player_id, target_player_bbox, played_position, duration_sec")
      .eq("bunny_video_id", payload.VideoGuid)
      .single();

    if (videoError || !video) {
      console.warn(`[VITAS] Video ${payload.VideoGuid} no encontrado en BBDD`);
      return errorResponse({
        code: "video_not_found",
        message: "Video record not found",
        status: 404,
      });
    }

    const vrow = video as {
      id: string;
      tenant_id: string | null;
      player_id: string | null;
      played_position?: string | null;
      duration_sec?: number | null;
    };

    // ── Gate honesto de duración (clips cortos) ────────────────────────────
    // Duración REAL: la de la fila (Bunny vía finalize, o metadatos del navegador vía
    // video-init) y, si falta, la de la API de Bunny. Nunca se inventa.
    let durationSec = knownDurationSec(vrow.duration_sec);
    if (durationSec === null) {
      const bunny = await getBunnyVideo({
        libraryId: process.env.BUNNY_STREAM_LIBRARY_ID ?? "",
        apiKey: process.env.BUNNY_STREAM_API_KEY ?? process.env.BUNNY_API_KEY ?? "",
        videoGuid: payload.VideoGuid,
      });
      durationSec = knownDurationSec(bunny?.length);
      if (durationSec !== null) {
        await supabase.from("videos").update({ duration_sec: durationSec }).eq("id", vrow.id);
      }
    }
    const gate = evaluateSyncAnalysisGate(durationSec);
    if (!gate.allowed) {
      return successResponse({
        skipped: true,
        reason: SYNC_ANALYSIS_GATE_CODE,
        durationSec: gate.durationSec,
        maxDurationSec: gate.maxDurationSec,
      });
    }

    // ── Idioma del usuario (mig 064) ───────────────────────────────────────
    // Este webhook es servidor-a-servidor (Bunny) y no tiene usuario: el idioma lo
    // dejó `finalize` en `videos.locale`. Lectura SEPARADA y best-effort a propósito:
    // si la migración aún no está aplicada, PostgREST devuelve error (no lanza) y
    // `loc` queda null → el orquestador degrada a "es" sin tumbar el webhook.
    const { data: loc } = await supabase
      .from("videos")
      .select("locale")
      .eq("id", vrow.id)
      .maybeSingle();
    const videoLocale = (loc as { locale?: string | null } | null)?.locale ?? null;

    const publicUrl =
      process.env.VITAS_PUBLIC_URL ??
      `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;

    // ── Encolar (idempotente) · impl compartida con finalize (inv #7) ──────
    const result = await enqueueAnalysis({
      supabase,
      videoId: vrow.id,
      tenantId: vrow.tenant_id,
      playerId: vrow.player_id,
      playedPosition: vrow.played_position ?? null,
      locale: videoLocale,
      publicUrl,
      cronSecret: process.env.CRON_SECRET ?? "",
      endpoint: "webhooks/bunny-uploaded",
    });

    if (result.status === "error") {
      return errorResponse({ code: "create_analysis_failed", message: result.error, status: 500 });
    }
    if (result.status === "blocked") {
      // Consentimiento (declaración guardada / consentimiento parental de un menor de 14
      // conocido): no se analiza. 200 para que Bunny NO reintente — no es un fallo del
      // webhook; el análisis se lanzará cuando el entrenador declare desde la app.
      console.warn(`[VITAS] Video ${vrow.id}: análisis NO encolado por consentimiento (${result.code})`);
      return successResponse({ skipped: true, reason: result.code, gate_reason: result.gate_reason });
    }
    if (result.status === "skipped") {
      // Vídeo sin jugador/tenant atado → no se encola (no es un fallo del webhook).
      return successResponse({ skipped: true, reason: result.reason });
    }
    if (result.status === "exists") {
      return successResponse({ skipped: true, reason: "analysis_already_exists", analysisId: result.analysisId });
    }

    console.log(`[VITAS] Analysis ${result.analysisId} encolado para video ${vrow.id}`);
    return successResponse({
      analysisId: result.analysisId,
      videoId: vrow.id,
      status: "queued",
      estimatedStartIn: result.triggered
        ? "inmediato (procesamiento disparado)"
        : "<24h (cron diario · CRON_SECRET no configurado)",
    });
  }
);
