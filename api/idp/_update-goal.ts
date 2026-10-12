/**
 * VITAS · POST /api/idp/update-goal
 *
 * Coach edits an individual goal of an IDP. Automatically marks
 * `coach_edited = true`.
 *
 * Body: partial goal fields + required goalId.
 * Returns the updated row.
 *
 * Autorización (074): solo el DUEÑO del jugador del plan del objetivo
 * (ownsIdpPlanItem) o una llamada de servicio. Antes cualquier cuenta pro/club
 * editaba objetivos del plan de cualquier menor conociendo su id.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsIdpPlanItem } from "../_lib/ownership";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const UpdateGoalSchema = z.object({
  goalId: z.string().uuid("goalId must be a UUID"),
  title: z.string().min(5).max(120).optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  baselineMetric: z
    .object({
      metric: z.string(),
      value: z.number(),
      label: z.string().optional(),
      unit: z.string().optional(),
    })
    .optional(),
  targetMetric: z
    .object({
      metric: z.string(),
      value: z.number(),
      label: z.string().optional(),
      unit: z.string().optional(),
    })
    .optional(),
  currentValue: z.number().optional(),
  drillsAssigned: z.array(z.string()).optional(),
  weight: z.number().int().min(1).max(5).optional(),
  status: z.enum(["pending", "in_progress", "achieved", "missed", "cancelled"]).optional(),
});

export default withHandler(
  {
    method: "POST",
    schema: UpdateGoalSchema,
    requireAuth: true,
    maxRequests: 100,
    allowServiceToken: true,
    requiredPlan: "pro,club",
  },
  async ({ body, userId, isServiceCall }) => {
    const input = body as z.infer<typeof UpdateGoalSchema>;
    const { goalId, ...changes } = input;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return successResponse({
        goalId,
        status: "client_only",
        changes,
      });
    }

    // Solo el dueño del jugador del plan (074). Objetivo que no existe → 403 (fail-closed).
    if (!isServiceCall && !(await ownsIdpPlanItem("idp_goals", goalId, userId))) {
      return errorResponse("No autorizado para este plan", 403, "FORBIDDEN");
    }

    const patch: Record<string, unknown> = {
      coach_edited: true,
    };
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.rationale !== undefined) patch.rationale = changes.rationale;
    if (changes.baselineMetric !== undefined) patch.baseline_metric = changes.baselineMetric;
    if (changes.targetMetric !== undefined) patch.target_metric = changes.targetMetric;
    if (changes.currentValue !== undefined) patch.current_value = changes.currentValue;
    if (changes.drillsAssigned !== undefined) patch.drills_assigned = changes.drillsAssigned;
    if (changes.weight !== undefined) patch.weight = changes.weight;
    if (changes.status !== undefined) patch.status = changes.status;

    try {
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/idp_goals?id=eq.${goalId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return errorResponse(
          `Supabase update failed: ${res.status} ${text.slice(0, 200)}`,
          500,
        );
      }

      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return errorResponse("Goal not found", 404);
      }

      return successResponse({ goal: rows[0] });
    } catch (err) {
      console.error("[update-goal] error:", err);
      return errorResponse("Internal error updating goal", 500);
    }
  },
);
