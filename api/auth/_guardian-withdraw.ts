/**
 * POST /api/auth/guardian-withdraw   { token }
 * El TUTOR retira SU consentimiento con el enlace del correo de confirmación (P1 bloque 3;
 * decisión del plan P1: «el tutor retira con un enlace firmado en el correo»). El tutor no tiene
 * cuenta: el enlace es la prueba (RGPD art. 7.3: retirar tan fácil como dar).
 *
 * Lo llama la página pública /auth/withdraw-consent SOLO cuando el tutor pulsa «Retirar» (nada
 * se retira al abrir la página: un escáner de enlaces del correo podría hacerlo, CWE-650).
 *
 *   1. el token se busca por su HASH en la EMISIÓN de retirada que escribió verify-consent con
 *      service_role (gdpr_audit_log 'consent_withdraw_token_issued'); un token que el servidor
 *      no emitió → 404. Un token de VERIFICACIÓN nunca vale aquí (otra acción);
 *   2. se retira SOLO ese consentimiento (evidencia 'consent_withdrawn' con source
 *      "guardian_link" + withdrawn_at), con api/_lib/parentalConsent.ts withdrawParentalConsents;
 *   3. si ya estaba retirado → 200 alreadyWithdrawn (reintentar es seguro).
 * Desde ahí el gate de análisis ya no lo cuenta (findActiveParentalConsent).
 *
 * Respuestas: 200 { withdrawn: true } | { alreadyWithdrawn: true } · 404 invalid_token ·
 * 500 si no se pudo (la página NO dice «retirado»).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import {
  findConsentWithdrawToken,
  hashConsentToken,
  withdrawParentalConsents,
  type IssuedWithdrawToken,
} from "../_lib/parentalConsent";

const schema = z.object({
  token: z.string().min(32).max(128),
});

const failed = () =>
  errorResponse({
    code: "consent_withdraw_failed",
    message: "No se pudo completar la retirada. Inténtalo de nuevo desde el enlace del correo.",
    status: 500,
  });

export default withHandler(
  { method: "POST", schema, requireAuth: false, maxRequests: 10 },
  async ({ body }) => {
    const { token } = body as z.infer<typeof schema>;

    let issued: IssuedWithdrawToken | null;
    try {
      issued = await findConsentWithdrawToken(await hashConsentToken(token));
    } catch (err) {
      console.error("[guardian-withdraw] no se pudo comprobar el enlace:", err instanceof Error ? err.message : err);
      return failed();
    }
    if (!issued) {
      return errorResponse({ code: "invalid_token", message: "Enlace de retirada no válido.", status: 404 });
    }

    let withdrawn: number;
    try {
      withdrawn = await withdrawParentalConsents({
        playerId: issued.playerId,
        userId: null, // el tutor no tiene cuenta en VITAS
        tenantId: issued.tenantId,
        reason: null,
        consentIds: [issued.consentId],
        source: "guardian_link",
      });
    } catch (err) {
      console.error("[guardian-withdraw] no se pudo retirar:", err instanceof Error ? err.message : err);
      return failed();
    }

    return withdrawn > 0 ? successResponse({ withdrawn: true }) : successResponse({ alreadyWithdrawn: true });
  },
);

export const config = { runtime: "edge" };
