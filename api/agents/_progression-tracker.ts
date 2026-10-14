/**
 * VITAS · Progression Tracker (Sprint 9)
 * POST /api/agents/progression-tracker
 *
 * Saves a metric snapshot after each completed analysis.
 * Called by pipeline-orchestrator after all reports are generated.
 *
 * Input: { playerId, analysisId, vsi,
 *          injuryRisk, fatigueIndex, acwr, eventSummary, xgAccumulated }
 *
 * Deterministic — no LLM calls. Cost: $0.
 *
 * P1 bloque 4b:
 *   - SOLO servidor (serviceOnly): escribe con la service key en datos de menores y no
 *     comprueba de quién es el jugador; antes bastaba cualquier sesión iniciada.
 *   - ya no recibe ni escribe PHV: su historia vive en player_anthropometrics, tras la
 *     puerta del PHV (antes podía guardar un offset sin pasar por ella).
 *   - injuryRisk es SOLO el riesgo compuesto del modelo de lesión (o null).
 * Sigue exigiendo un playerId uuid y players.id es texto: hoy no escribe filas
 * (documentado en docs/pendientes-metricas.md).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { localeSchema } from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const snapshotSchema = z.object({
  playerId: z.string().uuid(),
  analysisId: z.string().uuid().optional(),
  vsi: z.number().nullable().optional(),
  injuryRisk: z.number().min(0).max(100).nullable().optional(),
  fatigueIndex: z.number().min(0).max(100).nullable().optional(),
  acwr: z.number().nullable().optional(),
  eventSummary: z.record(z.unknown()).nullable().optional(),
  xgAccumulated: z.number().nullable().optional(),
  valuationTier: z.string().nullable().optional(),
  probabilityPro: z.number().nullable().optional(),
  ceilingEstimate: z.number().nullable().optional(),
  source: z.enum(["video_analysis", "manual", "combined"]).optional().default("video_analysis"),
  // Idioma de redacción (default "es"). Aceptado defensivamente para uniformidad de
  // contrato; este agente es determinista y NO genera prosa LLM, así que no se usa.
  locale: localeSchema.optional(),
});

export default withHandler(
  { schema: snapshotSchema, serviceOnly: true, maxRequests: 100 },
  async ({ body }) => {
    const input = body as z.infer<typeof snapshotSchema>;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const today = new Date().toISOString().slice(0, 10);

    // Upsert: one snapshot per player per day per source
    const { data, error } = await supabase
      .from("player_metric_snapshots")
      .upsert(
        {
          player_id: input.playerId,
          snapshot_date: today,
          vsi: input.vsi ?? null,
          injury_risk: input.injuryRisk ?? null,
          fatigue_index: input.fatigueIndex ?? null,
          acwr: input.acwr ?? null,
          event_summary: input.eventSummary ?? null,
          xg_accumulated: input.xgAccumulated ?? null,
          valuation_tier: input.valuationTier ?? null,
          probability_pro: input.probabilityPro ?? null,
          ceiling_estimate: input.ceilingEstimate ?? null,
          source: input.source,
          analysis_id: input.analysisId ?? null,
        },
        { onConflict: "player_id,snapshot_date,source" },
      )
      .select()
      .single();

    if (error) {
      console.error("[progression-tracker] Upsert failed:", error.message);
      return errorResponse({
        code: "snapshot_failed",
        message: error.message,
        status: 500,
      });
    }

    return successResponse({
      snapshotId: data?.id,
      playerId: input.playerId,
      date: today,
      source: input.source,
    });
  },
);
