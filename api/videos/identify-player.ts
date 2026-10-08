/**
 * VITAS · Identify Player in Video
 * POST /api/videos/identify-player
 *
 * Llamado tras Modal procesar el vídeo con candidatos.
 * El padre/coach selecciona cuál de las personas detectadas es su jugador.
 *
 * Body:
 *   { videoId: string, candidateIdx: number, bbox: {x,y,w,h} }
 *
 * Persiste en `videos.target_player_bbox` para:
 *   1. Saber a cuál persona analizar (no a las 22)
 *   2. Re-identificar automáticamente en vídeos futuros del mismo jugador
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsVideo } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const identifySchema = z.object({
  videoId: z.string().min(1),
  candidateIdx: z.number().int().nonnegative(),
  frameIdx: z.number().int().nonnegative(),
  timestamp: z.number().nonnegative(),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  }),
});

export default withHandler(
  { schema: identifySchema, requireAuth: true, maxRequests: 30 },
  async ({ body, userId, isServiceCall }) => {
    const input = body as z.infer<typeof identifySchema>;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("id, tenant_id, player_id, user_id")
      .eq("id", input.videoId)
      .single();

    if (videoError || !video) {
      return errorResponse({ code: "video_not_found", message: "Video no existe", status: 404 });
    }

    // Anti-IDOR (datos de menores): este handler MUTA una fila `videos` con service_role
    // (salta RLS). Sin este guard, un autenticado A podía reescribir el target_player_bbox
    // del vídeo de un menor del tenant B (redirigir a quién analiza). Mismo patrón fail-
    // closed que finalize.ts. Ver ownsVideo (ownership.ts).
    const vrow = video as { user_id?: string | null; tenant_id?: string | null; player_id?: string | null };
    if (!(await ownsVideo(vrow, userId, isServiceCall))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este vídeo", status: 403 });
    }

    // Persistir bbox del jugador objetivo
    const targetBbox = {
      x: input.bbox.x,
      y: input.bbox.y,
      w: input.bbox.w,
      h: input.bbox.h,
      frame_idx: input.frameIdx,
      timestamp: input.timestamp,
      candidate_idx: input.candidateIdx,
      identified_by: userId,
      identified_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from("videos")
      .update({ target_player_bbox: targetBbox })
      .eq("id", video.id);

    if (updateError) {
      return errorResponse({
        code: "update_failed",
        message: updateError.message,
        status: 500,
      });
    }

    // Audit log GDPR
    await supabase.rpc("log_gdpr_action", {
      p_user_id: userId,
      p_tenant_id: video.tenant_id,
      p_action: "player_identified_in_video",
      p_resource_type: "videos",
      p_resource_id: video.id,
      p_metadata: { player_id: video.player_id, bbox: targetBbox },
      p_ip: null,
    });

    return successResponse({
      videoId: video.id,
      identified: true,
      message: "Jugador identificado · análisis se enfocará en él",
    });
  }
);
