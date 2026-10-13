/**
 * POST /api/auth/withdraw-consent
 * Retira el consentimiento parental de un jugador (ronda 6 de la review del PR #308).
 *
 * Body: { playerId: string, reason?: string }
 *
 * Solo el DUEÑO del jugador (ownsPlayer, 076; nunca por tenant). Con service_role marca como
 * retirados (withdrawn_at) TODOS los consentimientos activos del jugador y deja la evidencia
 * 'consent_withdrawn' en gdpr_audit_log (api/_lib/parentalConsent.ts withdrawParentalConsents).
 * Desde ahí el gate de análisis ya no cuenta esos consentimientos, y el entrenador no puede
 * deshacerlo desde la pantalla: players.parental_consent_status no cuenta para nada. Volver a
 * tener consentimiento exige que el tutor firme y verifique uno nuevo.
 *
 * Respuestas: 200 { withdrawn: n } · 403 jugador ajeno o inexistente (mismo texto) ·
 * 500 si no se pudo retirar (el cliente NO debe mostrar «revocado»; reintentar es seguro).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { withdrawParentalConsents } from "../_lib/parentalConsent";

const schema = z.object({
  playerId: z.string().min(1).max(120),
  reason: z.string().max(500).optional(),
});

export default withHandler(
  { method: "POST", schema, requireAuth: true, maxRequests: 10 },
  async ({ body, userId, tenantId }) => {
    const { playerId, reason } = body as z.infer<typeof schema>;

    if (!(await ownsPlayer(playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    try {
      const withdrawn = await withdrawParentalConsents({ playerId, userId, tenantId, reason: reason ?? null });
      return successResponse({ withdrawn });
    } catch (err) {
      console.error("[withdraw-consent] no se pudo retirar:", err instanceof Error ? err.message : err);
      return errorResponse({
        code: "consent_withdraw_failed",
        message: "No se pudo completar la retirada del consentimiento. Inténtalo de nuevo.",
        status: 500,
      });
    }
  },
);

export const config = { runtime: "edge" };
