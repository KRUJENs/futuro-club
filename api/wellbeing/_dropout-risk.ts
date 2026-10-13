/**
 * VITAS · Dropout Risk Endpoint (Sprint 22 · real scorer)
 * GET /api/wellbeing/dropout-risk?playerId=xxx
 *
 * Computa el riesgo de abandono a partir de SEÑALES REALES en Supabase
 * (attendance_records, engagement_snapshots, fatigue_sessions) → construye las
 * entradas del scorer → scoreDropoutRisk() + generateIntervention().
 * La construcción de entradas vive en `api/_lib/dropoutAssessment.ts` (ÚNICA
 * implementación de servidor, inv #7): la comparte con el resumen mensual al
 * director (`api/crons/director-risk-digest.ts`), así panel y email coinciden.
 * (behavioralScores/resilience aún no se lee → se pasa null; el scorer redistribuye
 *  su peso. vsiStagnation/injuryRecurrence/growthSpurtStress: neutros hasta cablear.)
 *
 * HONESTIDAD (invariante #2): si el jugador NO tiene ninguna señal real, NO se
 * inventa un riesgo (un 0 vestido de "riesgo bajo" también es mentira). Se devuelve
 * un estado "insufficient_data" (el cliente lo trata como «riesgo sin calcular» y no
 * pinta sus números: fetchDropoutRisk en src/hooks/useWellbeing.ts, P1 bloque 2) y NO
 * se persiste ninguna fila.
 *
 * Antes este endpoint devolvía SIEMPRE un valor derivado del HASH del id del
 * jugador (mock disfrazado, prohibido por rules/metricas.md). Eso se retira.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import {
  computeDropoutAssessment,
  fetchDropoutSignals,
  insufficientAssessment,
  makeRowSelector,
} from "../_lib/dropoutAssessment";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dropoutRiskQuerySchema = z.object({
  playerId: z.string().min(1, "playerId is required"),
});

export default withHandler(
  { method: "GET", requireAuth: true, maxRequests: 60, allowServiceToken: true, requiredPlan: "pro,club" },
  async ({ query, userId, isServiceCall }) => {
    const parsed = dropoutRiskQuerySchema.safeParse(query);
    if (!parsed.success) return errorResponse("playerId query parameter required", 400);
    const { playerId } = parsed.data;

    // Ownership: el service_role salta RLS → hay que comprobar la propiedad en código.
    if (!isServiceCall && !(await ownsPlayer(playerId, userId))) {
      return errorResponse("No autorizado para este jugador", 403, "FORBIDDEN");
    }

    // Sin Supabase → NO se inventa riesgo (mock por hash retirado): estado honesto.
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return successResponse({
        assessment: insufficientAssessment(playerId),
        source: "insufficient_data",
        computedAt: new Date().toISOString(),
      });
    }

    const rows = await fetchDropoutSignals(playerId, makeRowSelector(SUPABASE_URL, SUPABASE_KEY));
    const result = computeDropoutAssessment(playerId, rows);

    // Invariante #2: sin NINGUNA señal real → no se computa ni se persiste nada.
    if (result.source !== "computed") {
      return successResponse({
        assessment: result.assessment,
        source: "insufficient_data",
        computedAt: new Date().toISOString(),
      });
    }

    // Persistir SOLO una evaluación real computada (nunca el estado insufficient).
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/dropout_risk_assessments`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          player_id: playerId,
          risk_score: result.out.riskScore,
          risk_level: result.out.riskLevel,
          factors: result.out.factors,
          intervention: result.assessment.intervention,
        }),
      });
    } catch {
      // La persistencia es best-effort; la respuesta se devuelve igual.
    }

    return successResponse({
      assessment: result.assessment,
      source: "computed",
      computedAt: new Date().toISOString(),
    });
  },
);
