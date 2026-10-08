/**
 * VITAS · POST /api/idp/checkin
 *
 * Records a coach monthly checkin for a plan (or per-goal). Stores the raw
 * questionnaire answers + qualitative notes + proposed adjustments for next
 * month.
 *
 * After receiving the checkin, the client typically follows up with
 * /api/idp/generate-plan for next month, passing previousPlanSummary
 * derived from these checkins.
 *
 * Autorización (074): solo el DUEÑO del jugador del plan (ownsIdpPlan) o una
 * llamada de servicio. Antes cualquier cuenta pro/club añadía revisiones (y con
 * closeMonth cerraba el plan) de cualquier menor conociendo el id del plan.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsIdpPlan } from "../_lib/ownership";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const CheckinSchema = z.object({
  planId: z.string().uuid(),
  goalId: z.string().uuid().optional(),
  reviewerId: z.string().optional(),
  progressScore: z.number().int().min(0).max(100).optional(),
  qualitativeNotes: z.string().optional(),
  questionnaireAnswers: z.record(z.unknown()).optional(),
  adjustmentsProposed: z
    .object({
      nextMonthFocus: z.string().optional(),
      drillsToChange: z.array(z.string()).optional(),
      dimensionsToBoost: z
        .array(
          z.enum(["technical", "tactical", "physical", "mental", "maturation"]),
        )
        .optional(),
      notes: z.string().optional(),
    })
    .optional(),
  /** When true and goalId provided, also marks the plan as completed. */
  closeMonth: z.boolean().optional(),
});

export default withHandler(
  {
    method: "POST",
    schema: CheckinSchema,
    requireAuth: true,
    allowServiceToken: true,
    requiredPlan: "pro,club",
    maxRequests: 60,
  },
  async ({ body, userId, isServiceCall }) => {
    const input = body as z.infer<typeof CheckinSchema>;
    const reviewer = input.reviewerId ?? userId ?? null;
    const checkinId = crypto.randomUUID();

    const row = {
      id: checkinId,
      plan_id: input.planId,
      goal_id: input.goalId ?? null,
      reviewer_id: reviewer,
      reviewed_at: new Date().toISOString(),
      progress_score: input.progressScore ?? null,
      qualitative_notes: input.qualitativeNotes ?? null,
      questionnaire_answers: input.questionnaireAnswers ?? {},
      adjustments_proposed: input.adjustmentsProposed ?? {},
    };

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return successResponse({ checkin: row, source: "client_only" });
    }

    // Solo el dueño del jugador del plan (074). Plan que no existe → 403 (fail-closed).
    if (!isServiceCall && !(await ownsIdpPlan(input.planId, userId))) {
      return errorResponse("No autorizado para este plan", 403, "FORBIDDEN");
    }

    try {
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/idp_checkins`, {
        method: "POST",
        headers,
        body: JSON.stringify(row),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return errorResponse(
          `Supabase insert failed: ${res.status} ${text.slice(0, 200)}`,
          500,
        );
      }

      // Optionally close the plan
      if (input.closeMonth) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/development_plans?id=eq.${input.planId}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "completed" }),
          },
        );
      }

      const rows = await res.json();
      return successResponse({
        checkin: Array.isArray(rows) ? rows[0] : row,
        monthClosed: input.closeMonth ?? false,
      });
    } catch (err) {
      console.error("[checkin] error:", err);
      return errorResponse("Internal error saving checkin", 500);
    }
  },
);
