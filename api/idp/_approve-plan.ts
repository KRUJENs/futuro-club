/**
 * VITAS · POST /api/idp/approve-plan
 *
 * Coach transitions a draft plan to active.
 * Body: { planId: string, coachId?: string }
 *
 * Side effects:
 *   - status: draft → active
 *   - approved_by = coachId / userId
 *   - approved_at = now
 *
 * Autorización (074): solo el DUEÑO del jugador del plan (ownsIdpPlan) o una
 * llamada de servicio. Antes cualquier cuenta pro/club activaba el plan de
 * cualquier menor conociendo su id.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsIdpPlan } from "../_lib/ownership";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const ApprovePlanSchema = z.object({
  planId: z.string().uuid("planId must be a UUID"),
  coachId: z.string().optional(),
});

export default withHandler(
  {
    method: "POST",
    schema: ApprovePlanSchema,
    requireAuth: true,
    allowServiceToken: true,
    requiredPlan: "pro,club",
    maxRequests: 50,
  },
  async ({ body, userId, isServiceCall }) => {
    const { planId, coachId } = body as z.infer<typeof ApprovePlanSchema>;
    const approver = coachId ?? userId ?? null;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      // Without Supabase, the client manages this transition locally
      return successResponse({
        planId,
        status: "active",
        approvedBy: approver,
        source: "client_only",
      });
    }

    // Solo el dueño del jugador del plan (074). Plan que no existe → 403 (fail-closed).
    if (!isServiceCall && !(await ownsIdpPlan(planId, userId))) {
      return errorResponse("No autorizado para este plan", 403, "FORBIDDEN");
    }

    try {
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/development_plans?id=eq.${planId}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "active",
            approved_by: approver,
            approved_at: new Date().toISOString(),
          }),
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return errorResponse(
          `Supabase update failed: ${res.status} ${text.slice(0, 200)}`,
          500,
        );
      }

      const rows = (await res.json()) as Array<{ id: string; status: string }>;
      if (!rows.length) {
        return errorResponse("Plan not found", 404);
      }

      return successResponse({
        planId,
        status: rows[0].status,
        approvedBy: approver,
        approvedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[approve-plan] error:", err);
      return errorResponse("Internal error approving plan", 500);
    }
  },
);
