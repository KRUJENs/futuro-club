/**
 * VITAS · Get Analysis by Video
 * GET /api/analyses/by-video?videoId=xxx
 *
 * Devuelve el análisis asociado a un vídeo · usado por el frontend para
 * polling del estado mientras Modal procesa.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { withLegacyPhvWithheld } from "../../src/lib/reports/legacyNotices";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const querySchema = z.object({
  videoId: z.string().min(1),
});

export default withHandler(
  // method: "GET" — withHandler default es POST; sin esto este endpoint (documentado GET,
  // llamado GET por el polling de progreso: usePlayerAnalysisV2 + VideoUploader) daba 405 y
  // el handler NUNCA corría (el progreso en vivo del análisis quedaba roto, enmascarado por
  // la query directa a Supabase de useSavedAnalysesV2).
  { schema: querySchema, method: "GET", requireAuth: true, allowServiceToken: true, maxRequests: 200 },
  async ({ query, userId, isServiceCall }) => {
    const params = querySchema.safeParse(query);
    if (!params.success) {
      return errorResponse({ code: "invalid_params", message: "videoId requerido", status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: analysis, error } = await supabase
      .from("analyses")
      .select(
        "id, status, status_message, started_at, completed_at, created_at, vsi, phv, total_latency_ms, player_id"
      )
      .eq("video_id", params.data.videoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return errorResponse({ code: "db_error", message: error.message, status: 500 });
    }

    // Ownership: si hay análisis, su jugador debe pertenecer al usuario
    // (cierra el polling de estado/VSI/PHV de vídeos ajenos por videoId).
    if (analysis && !isServiceCall) {
      const owner = (analysis as { player_id?: string | null }).player_id;
      if (!(await ownsPlayer(owner, userId))) {
        return errorResponse({ code: "forbidden", message: "No autorizado para este vídeo", status: 403 });
      }
    }

    // PHV guardado sin maduración verificada (pre-#301 o sexo no registrado entonces) → fuera,
    // con la misma regla que reports/share (withLegacyPhvWithheld, P1 bloque 7b).
    let out = analysis ?? null;
    if (out && out.phv !== null && out.phv !== undefined) {
      const { data: playerRow } = out.player_id
        ? await supabase.from("players").select("data").eq("id", out.player_id).single()
        : { data: null };
      out = withLegacyPhvWithheld(out, playerRow?.data ?? null);
    }

    return successResponse({
      analysis: out,
    });
  }
);
