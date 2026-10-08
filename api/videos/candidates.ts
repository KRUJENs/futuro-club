/**
 * VITAS · Get Player Candidates from Video
 * GET /api/videos/candidates?videoId=xxx
 *
 * Devuelve los candidatos de jugador que Modal extrajo del vídeo.
 * Usado por la pantalla de identificación para que el padre seleccione
 * cuál es su hijo.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsVideo } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const querySchema = z.object({
  videoId: z.string().min(1),
});

export default withHandler(
  // method: "GET" — withHandler default es POST; sin esto el endpoint (documentado GET,
  // llamado GET por PlayerIdentifier) daba 405 y el handler (con el guard IDOR) NUNCA
  // corría. Arreglar el método SIN el guard re-expondría el IDOR, así que van juntos.
  { schema: querySchema, method: "GET", requireAuth: true, maxRequests: 200 },
  async ({ query, userId, isServiceCall }) => {
    const params = querySchema.safeParse(query);
    if (!params.success) {
      return errorResponse({ code: "invalid_params", message: "videoId requerido", status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Anti-IDOR (datos de menores): esta lectura devuelve los candidatos (personas
    // detectadas) y el bbox del vídeo. Con service_role (salta RLS) hay que verificar
    // propiedad ANTES de exponer nada, o un autenticado A leería el vídeo del menor del
    // tenant B por videoId. Se comprueba primero la fila `videos`. Ver ownsVideo.
    const { data: ownRow, error: ownErr } = await supabase
      .from("videos")
      .select("id, user_id, tenant_id, player_id, target_player_bbox")
      .eq("id", params.data.videoId)
      .single();
    if (ownErr || !ownRow) {
      return errorResponse({ code: "video_not_found", message: "Video no existe", status: 404 });
    }
    const vrow = ownRow as { user_id?: string | null; tenant_id?: string | null; player_id?: string | null; target_player_bbox?: unknown };
    if (!(await ownsVideo(vrow, userId, isServiceCall))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este vídeo", status: 403 });
    }

    // Obtener el último análisis del vídeo (que contiene los candidates)
    const { data: analysis } = await supabase
      .from("analyses")
      .select("id, status, biomechanics, video_id")
      .eq("video_id", params.data.videoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!analysis) {
      return successResponse({
        ready: false,
        message: "Análisis aún no completado, reintenta en unos segundos",
      });
    }

    // ¿Ya hay un jugador identificado? (target_player_bbox ya lo trajimos en el guard)
    if (vrow.target_player_bbox) {
      return successResponse({
        ready: true,
        alreadyIdentified: true,
        targetBbox: vrow.target_player_bbox,
      });
    }

    // Los candidates vienen en el JSON del biomechanics o en una columna dedicada.
    // Por ahora, los modelos guardan en `analyses` table (extender si es necesario).
    // En la query actual buscamos en una columna jsonb `candidates` dentro de analyses.

    const { data: analysisFull } = await supabase
      .from("analyses")
      .select("*")
      .eq("id", analysis.id)
      .single();

    const candidates =
      (analysisFull as { candidates?: unknown })?.candidates ?? [];

    return successResponse({
      ready: true,
      alreadyIdentified: false,
      analysisId: analysis.id,
      analysisStatus: analysis.status,
      candidates,
    });
  }
);
