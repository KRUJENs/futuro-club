/**
 * VITAS · Auth Router
 * Routes /api/auth/{action} to the correct handler.
 *
 * Acciones soportadas:
 *   POST /api/auth/verify-captcha → valida token de Cloudflare Turnstile
 *   POST /api/auth/welcome        → dispara email de bienvenida tras registro
 *   POST /api/auth/withdraw-consent → el dueño retira el consentimiento parental del jugador
 *   POST /api/auth/guardian-withdraw → el TUTOR retira el suyo con el enlace de su correo
 *   POST /api/auth/consent-status   → estado del consentimiento del tutor (solo el dueño)
 */
import { errorResponse } from "../_lib/apiResponse";

import verifyCaptcha from "./_verify-captcha";
import welcome from "./_welcome";
import withdrawConsent from "./_withdraw-consent";
import guardianWithdraw from "./_guardian-withdraw";
import consentStatus from "./_consent-status";

export const config = { runtime: "edge" };

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "verify-captcha": verifyCaptcha,
  "welcome": welcome,
  "withdraw-consent": withdrawConsent,
  "guardian-withdraw": guardianWithdraw,
  "consent-status": consentStatus,
};

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const fn = routes[action];
  if (!fn) return errorResponse(`Auth action "${action}" not found`, 404);
  return fn(req);
}
