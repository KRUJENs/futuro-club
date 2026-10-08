/**
 * VITAS · Get Analysis Reports
 * GET /api/analyses/reports?analysisId=xxx
 *
 * Devuelve los 6 reportes generados para un análisis,
 * más metadata del análisis (VSI, PHV, etc).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsRowOrItsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import { withoutUndatedVsiSeries } from "../../src/lib/scoring/vsiDelta";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const querySchema = z.object({
  analysisId: z.string().uuid(),
});

export default withHandler(
  // GET explícito: sin `method`, withHandler default a POST-only → un GET devolvía
  // 405 (antes del auth), rompiendo "Ver Completo" y loadAnalysis del hook.
  { schema: querySchema, method: ["GET"], requireAuth: true, maxRequests: 200 },
  async ({ query, userId, isServiceCall }) => {
    const params = querySchema.safeParse(query);
    if (!params.success) {
      return errorResponse({ code: "invalid_params", message: "analysisId requerido", status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Cargar analysis + reports en paralelo
    const [analysisRes, reportsRes] = await Promise.all([
      supabase
        .from("analyses")
        .select("id, status, vsi, phv, similarity, biomechanics, completed_at, total_latency_ms, player_id, video_id, user_id")
        .eq("id", params.data.analysisId)
        .single(),
      supabase
        .from("reports")
        .select("report_type, content, model, prompt_version, generated_at, feedback_useful")
        .eq("analysis_id", params.data.analysisId)
        .eq("is_latest", true)
        .order("generated_at", { ascending: true }),
    ]);

    if (analysisRes.error || !analysisRes.data) {
      return errorResponse({
        code: "analysis_not_found",
        message: analysisRes.error?.message ?? "Not found",
        status: 404,
      });
    }

    // Autorización a nivel de objeto: requireAuth solo garantiza que hay un usuario,
    // NO que sea dueño. Como el cliente usa SERVICE_KEY (salta RLS), el check es
    // obligatorio. Sin él, cualquier autenticado leía los informes (VSI/PHV/
    // biomecánica) de un menor ajeno con solo su id. Solo el dueño (076): quien creó
    // el análisis o el dueño de su jugador; el mismo predicado que share.ts
    // (ownsRowOrItsPlayer). Nunca por tenant: un tenant compartido abría los informes
    // de todos los menores de ese tenant a cualquier cuenta con ese tenant.
    const a = analysisRes.data as { user_id?: string | null; player_id?: string | null };
    if (!isServiceCall) {
      const owns = await ownsRowOrItsPlayer(a, userId);
      if (!owns) {
        return errorResponse({
          code: "forbidden",
          message: "No autorizado para este análisis",
          status: 403,
        });
      }
    }

    return successResponse({
      // vsi.trend / vsi.history de filas antiguas = serie legacy SIN fechas (57.5
      // fabricado): se retiran al leer, nunca llegan a la UI (src/lib/scoring/vsiDelta.ts).
      analysis: { ...analysisRes.data, vsi: withoutUndatedVsiSeries(analysisRes.data.vsi) },
      reports: reportsRes.data ?? [],
      reportCount: reportsRes.data?.length ?? 0,
    });
  }
);
