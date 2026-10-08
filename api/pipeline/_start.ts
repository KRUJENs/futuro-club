/**
 * VITAS · Pipeline Start v3
 * POST /api/pipeline/start
 *
 * Llama a la API de Anthropic directamente con fetch() — SIN SDK.
 * Body: { videoId, playerId, analysisMode?, attestation }
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): ANTES de
 * leer nada del jugador o de Bunny y de llamar a Claude:
 *   - si se manda `playerId`, el jugador tiene que ser del usuario (el gate lee su fecha
 *     de nacimiento; sin este check su resultado revelaría la edad de un menor ajeno);
 *   - `videoId` es el GUID de Bunny cuya miniatura se manda a Claude: tiene que existir una
 *     fila `videos` de ESE vídeo (por id o por bunny_video_id) y todas las filas que lo
 *     referencian tienen que ser del usuario (sin fila → 404, ajena → 403). Cuenta la
 *     declaración guardada con la fila (SoloDrill sube por VideoUpload) o la del body;
 *   - el jugador del VÍDEO (videos.player_id) se comprueba siempre, además del del body:
 *     menor de 14 conocido → su consentimiento parental verificado (hallazgos B1/B2).
 * PENDIENTE (fuera de este cambio, ver docs/pendientes-metricas.md): este endpoint rellena
 * edad/posición/nota por defecto (invariantes #1/#2).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS } from "../_lib/models";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = { runtime: "edge" };

const PipelineSchema = z.object({
  videoId: z.string().min(1, "videoId es requerido"),
  playerId: z.string().optional(),
  analysisMode: z.string().optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (se valida en el gate). */
  attestation: z.unknown().optional(),
});

interface BunnyVideoInfo {
  length: number;
  width:  number;
  height: number;
  status: number;
}

export default withHandler(
  { schema: PipelineSchema, requireAuth: true, maxRequests: 20 },
  async ({ body, userId, tenantId, ip }) => {
    const { videoId, playerId, analysisMode } = body;

    const actor = { userId, tenantId, ip };
    if (playerId && !(await ownsPlayer(playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este jugador", status: 403 });
    }
    // videoId = GUID de Bunny de la miniatura que se manda a Claude (abajo).
    const consent = await gateClipAnalysis({
      videoId,
      bunnyGuid: videoId,
      requireVideoRow: true,
      attestation: body.attestation,
      playerId: playerId ?? null,
      actor,
      endpoint: "pipeline/start",
      scope: playerId ? "player" : "team",
      ownsVideo: (video, uid) => ownsVideo(video, uid),
    });
    if (!consent.allowed) return clipGateErrorResponse(consent);

    const bunnyLibraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
    const bunnyApiKey    = process.env.BUNNY_STREAM_API_KEY ?? process.env.BUNNY_API_KEY;
    const bunnyCdnHost   = process.env.BUNNY_CDN_HOSTNAME || process.env.VITE_BUNNY_CDN_HOSTNAME;
    const supabaseUrl    = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseKey    = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const anthropicKey   = process.env.ANTHROPIC_API_KEY;

    // 1. Fetch video info from Bunny
    let videoDuration = 0;
    let frameUrl = "";

    if (bunnyLibraryId && bunnyApiKey) {
      try {
        const r = await fetch(
          `https://video.bunnycdn.com/library/${bunnyLibraryId}/videos/${videoId}`,
          { headers: { AccessKey: bunnyApiKey } }
        );
        if (r.ok) {
          const info = await r.json() as BunnyVideoInfo;
          videoDuration = info.length ?? 0;
          const cdn = bunnyCdnHost || `${videoId}.b-cdn.net`;
          const t = videoDuration > 0 ? Math.round(videoDuration * 0.2) : 0;
          frameUrl = `https://${cdn}/${videoId}/thumbnail.jpg` + (t > 0 ? `?time=${t}` : "");
        }
      } catch { /* Bunny unavailable */ }
    }

    // 2. Fetch player context from Supabase
    let playerName = "Jugador";
    let playerAge  = 15;
    let playerPos  = "CM";

    if (supabaseUrl && supabaseKey && playerId) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/players?id=eq.${encodeURIComponent(playerId)}&select=data&limit=1`,
          { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
        );
        if (r.ok) {
          const rows = await r.json() as Array<{ data: Record<string, unknown> }>;
          if (rows.length > 0) {
            const pd = rows[0].data ?? {};
            playerName = (pd.name as string) ?? playerName;
            playerAge  = (pd.age  as number) ?? playerAge;
            playerPos  = (pd.position as string) ?? playerPos;
          }
        }
      } catch { /* fallback defaults */ }
    }

    // 3. Call Claude via raw fetch (NO SDK)
    if (!anthropicKey) {
      return successResponse({
        success: true,
        report: fallback(playerName, playerPos, playerAge),
        pipelineMeta: buildMeta(0, videoDuration, analysisMode, !!(bunnyLibraryId && bunnyApiKey)),
      });
    }

    try {
      const prompt =
        `Analiza este fotograma de futbol del jugador ${playerName} ` +
        `(${playerAge} años, ${playerPos}). ` +
        `Responde SOLO con JSON válido sin markdown:\n` +
        `{"executiveSummary":"string","technicalAnalysis":{"strengths":["..."],"areasForImprovement":["..."],"overallRating":number},"tacticalProfile":{"playingStyle":"string","keyAttributes":["..."]},"recommendation":"string","framesAnalyzed":1}`;

      const content: unknown[] = [];
      if (frameUrl && frameUrl.startsWith("http")) {
        content.push({ type: "image", source: { type: "url", url: frameUrl } });
      }
      content.push({ type: "text", text: prompt });

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      MODELS.fast,
          max_tokens: 800,
          messages:   [{ role: "user", content }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text().catch(() => "");
        console.error("[pipeline] Claude API error:", claudeRes.status, errText);
        return successResponse({
          success: true,
          report: fallback(playerName, playerPos, playerAge),
          pipelineMeta: buildMeta(0, videoDuration, analysisMode, !!(bunnyLibraryId && bunnyApiKey)),
          warning: `Claude API ${claudeRes.status}`,
        });
      }

      const claudeData = await claudeRes.json() as {
        content: Array<{ type: string; text?: string }>;
      };

      let fullText = "";
      for (const block of claudeData.content) {
        if (block.type === "text" && block.text) fullText += block.text;
      }

      let report: Record<string, unknown> | null = null;
      if (fullText) {
        try {
          const m = fullText.match(/\{[\s\S]*\}/);
          if (m) report = JSON.parse(m[0]) as Record<string, unknown>;
        } catch { /* parse error */ }
      }

      return successResponse({
        success: true,
        report: report ?? fallback(playerName, playerPos, playerAge),
        pipelineMeta: buildMeta(frameUrl ? 1 : 0, videoDuration, analysisMode, !!(bunnyLibraryId && bunnyApiKey)),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[pipeline] error:", msg);
      return successResponse({
        success: true,
        report: fallback(playerName, playerPos, playerAge),
        pipelineMeta: buildMeta(0, videoDuration, analysisMode, !!(bunnyLibraryId && bunnyApiKey)),
        warning: msg,
      });
    }
  }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fallback(name: string, pos: string, age: number) {
  return {
    executiveSummary: `Análisis de ${name} completado. ${pos}, ${age} años.`,
    technicalAnalysis: {
      strengths: ["Posicionamiento", "Capacidad atlética", "Dinamismo"],
      areasForImprovement: ["Requiere más footage para análisis completo"],
      overallRating: 68,
    },
    tacticalProfile: {
      playingStyle: `Jugador de ${pos} en desarrollo`,
      keyAttributes: ["Determinación", "Adaptabilidad", "Presencia"],
    },
    recommendation: `Continuar seguimiento de ${name} con más sesiones de video.`,
    framesAnalyzed: 0,
    isFallback: true,
  };
}

function buildMeta(frames: number, duration: number, mode?: string, bunny?: boolean) {
  return {
    keyframesUsed: frames, videoDuration: duration,
    analysisMode: mode ?? "all", bunnyConfigured: !!bunny,
    ranAt: new Date().toISOString(),
  };
}
