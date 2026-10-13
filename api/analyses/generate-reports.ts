/**
 * VITAS · Generate Reports from Client-Side Data
 * POST /api/analyses/generate-reports
 *
 * Called by usePlayerAnalysisV2.analyzeWithClientData() when MediaPipe + YOLO
 * data is available from browser-side processing (no Modal dependency).
 *
 * Flow:
 *   1. Receives analysisId + client biomechanics + physicalMetrics + eventSummary
 *   2. Delegates to pipeline-orchestrator to generate 6 Claude reports
 *   3. Returns immediately (orchestrator handles report generation)
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): el tracking
 * corrió en el navegador (el servidor no puede impedirlo), así que ESTE es el punto donde
 * el servidor lo exige, ANTES de tocar el análisis y de llamar al orquestador: el `videoId`
 * se resuelve en el servidor (por id o por bunny_video_id; todas las filas de ese vídeo
 * tienen que ser del usuario), declaración del entrenador (la del body `attestation`, o
 * una guardada con la fila) y, para un menor de 14 conocido —el jugador del análisis Y el
 * `player_id` de cada fila del vídeo (B1/B2)—, consentimiento parental verificado.
 * Bloqueado → 400/403/500 con el código; si el análisis ya existía (el navegador lo crea
 * antes), se marca `failed` con el motivo para que no quede colgado.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { checkUsageQuota, incrementUsage, usageExceededResponse } from "../_lib/usageGuard";
import { createClient } from "@supabase/supabase-js";
import { localeSchema } from "../../src/lib/shared/locale";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  process.env.VITAS_API_BASE_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? process.env.CRON_SECRET ?? "";

const schema = z.object({
  analysisId: z.string().uuid().optional(),
  playerId: z.string(),
  videoId: z.string(),
  biomechanics: z.record(z.unknown()).nullable().optional(),
  physicalMetrics: z.record(z.unknown()).nullable().optional(),
  eventSummary: z.record(z.unknown()).nullable().optional(),
  playedPosition: z.string().nullable().optional(),
  /** FASE 5 · idioma de los reportes; se propaga al orchestrator y agentes */
  locale: localeSchema.optional(),
  /** C1 multi-categoría · override explícito (si falta, el orchestrator deriva de la edad) */
  category: z.enum(["youth", "senior"]).optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (se valida en el gate). */
  attestation: z.unknown().optional(),
});

export default withHandler(
  { schema, requireAuth: true, maxRequests: 10 },
  async ({ body, userId, tenantId, ip }) => {
    // ── Quota check before expensive pipeline ─────────────────────
    if (userId) {
      const usage = await checkUsageQuota(userId);
      if (!usage.allowed) return usageExceededResponse(usage);
    }

    const {
      analysisId: providedId,
      playerId,
      videoId,
      biomechanics,
      physicalMetrics,
      eventSummary,
      playedPosition,
      locale,
      category,
    } = body as z.infer<typeof schema>;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Upsert analysis with client data ──────────────────────────
    let analysisId = providedId;

    if (!analysisId) {
      // Find existing or create
      const { data: existing } = await supabase
        .from("analyses")
        .select("id")
        .eq("video_id", videoId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      analysisId = existing?.id;
    }

    // Ownership sobre el análisis que se va a tocar (el player_id de ESE análisis,
    // no el playerId del body, que podría no coincidir con un providedId ajeno).
    // Cierra el IDOR indirecto: sin esto un autenticado sobrescribía el análisis de
    // OTRO tenant y disparaba el orchestrator (coste + email a la familia) sobre un
    // menor ajeno. Solo el DUEÑO del jugador (players.user_id, 076): nunca por
    // tenant. Fail-closed: si el análisis pedido no existe o no tiene jugador, no se
    // escribe nada ni se dispara el orquestador.
    const ownerTargetPlayerId: string | null | undefined = analysisId
      ? (await supabase.from("analyses").select("player_id").eq("id", analysisId).maybeSingle()).data?.player_id
      : playerId;
    if (!ownerTargetPlayerId) {
      return errorResponse({ code: "analysis_not_found", message: "Análisis no encontrado", status: 404 });
    }
    if (!(await ownsPlayer(ownerTargetPlayerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este jugador", status: 403 });
    }

    // ── 0b. Consentimiento ANTES de tocar el análisis y de llamar al orquestador ──
    // videoId puede ser una fila `videos` (por id o por su GUID de Bunny: propia → cuenta
    // una declaración guardada; ajena → 403) o un id solo del navegador (la declaración
    // tiene que venir en ESTA petición). El jugador de cada fila del vídeo se comprueba
    // además del jugador del análisis.
    const actor = { userId, tenantId, ip };
    const consentPlayerId = (ownerTargetPlayerId as string | undefined) ?? playerId;
    const consent = await gateClipAnalysis({
      videoId,
      requireVideoRow: false, // tracking del navegador: el vídeo puede no tener fila
      attestation: body.attestation,
      playerId: consentPlayerId,
      actor,
      endpoint: "analyses/generate-reports",
      scope: "player",
      locale,
      ownsVideo: (video, uid) => ownsVideo(video, uid),
      ownsPlayer: (pid, uid) => ownsPlayer(pid, uid),
    });
    if (!consent.allowed) {
      // El navegador ya dejó el análisis en "processing_reports" (upsert previo): se cierra
      // con el motivo en vez de dejarlo colgado hasta el reaper. SOLO en ese estado: un
      // análisis ya completado o fallido no se toca.
      if (analysisId) {
        await supabase
          .from("analyses")
          .update({ status: "failed", status_message: consent.gate_reason })
          .eq("id", analysisId)
          .eq("status", "processing_reports");
      }
      return clipGateErrorResponse(consent);
    }

    if (analysisId) {
      // Update existing analysis with client data
      await supabase
        .from("analyses")
        .update({
          status: "processing_reports",
          biomechanics: biomechanics ?? undefined,
          played_position: playedPosition ?? undefined,
          client_metrics: {
            physicalMetrics: physicalMetrics ?? null,
            eventSummary: eventSummary ?? null,
            source: "client_mediapipe_yolo",
            processedAt: new Date().toISOString(),
          },
        })
        .eq("id", analysisId);
    } else {
      // Create new analysis
      const { data: newAnalysis, error: insertError } = await supabase
        .from("analyses")
        .insert({
          player_id: playerId,
          video_id: videoId,
          user_id: userId,
          status: "processing_reports",
          biomechanics: biomechanics ?? null,
          played_position: playedPosition ?? null,
          client_metrics: {
            physicalMetrics: physicalMetrics ?? null,
            eventSummary: eventSummary ?? null,
            source: "client_mediapipe_yolo",
            processedAt: new Date().toISOString(),
          },
        })
        .select("id")
        .single();

      if (insertError || !newAnalysis) {
        return errorResponse({
          code: "insert_failed",
          message: insertError?.message ?? "Cannot create analysis",
          status: 500,
        });
      }
      analysisId = newAnalysis.id;
    }

    // ── 2. Dispatch to pipeline-orchestrator (fire-and-forget) ───────
    // The orchestrator generates 6 Claude reports and marks as completed
    try {
      const orchestratorRes = await fetch(
        `${PUBLIC_URL}/api/agents/pipeline-orchestrator`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${INTERNAL_TOKEN}`,
          },
          body: JSON.stringify({ analysisId, locale, category }),
        }
      );

      if (!orchestratorRes.ok) {
        const errText = await orchestratorRes.text().catch(() => "unknown");
        console.error(`[generate-reports] Orchestrator failed: ${orchestratorRes.status} ${errText}`);
        // Don't fail — analysis is still saved with biomechanics
      }
    } catch (err) {
      console.error("[generate-reports] Orchestrator dispatch error:", err);
      // Don't fail — analysis is still saved with biomechanics
    }

    // Increment usage after successful dispatch. AWAIT: en runtime edge una promesa
    // sin await ni waitUntil se descarta al devolver la respuesta → la cuota no se
    // aplicaría. incrementUsage captura sus errores internamente (Promise<void>),
    // así que awaitarla no puede romper la request.
    if (userId) {
      await incrementUsage(userId, "generate-reports");
    }

    return successResponse({
      analysisId,
      status: "processing_reports",
      message: "Reports generation started",
    });
  }
);
