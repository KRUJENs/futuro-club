/**
 * ALLOWLIST del lint de SECURITY DEFINER (securityDefinerLint.ts).
 *
 * Cada entrada es una función SECURITY DEFINER que NO se revoca a authenticated
 * (o a nadie) a propósito. Añadir una entrada exige justificarla aquí; el lint
 * falla si la entrada queda obsoleta (la firma ya no existe o dejó de ser DEFINER),
 * si una "client-callable" sigue ejecutable por anon, o si una "client-callable" /
 * "rls-helper" no usa auth.uid() en su cuerpo.
 *
 * Claves = firma normalizada: esquema.nombre(tipos de entrada normalizados).
 */
import type { Allowlist } from "./securityDefinerLint";

export const SECURITY_DEFINER_ALLOWLIST: Allowlist = {
  "public.user_org_ids()": {
    category: "rls-helper",
    justification:
      "La evalúan políticas RLS SIN cláusula TO (también para anon) de players, videos, player_analyses, " +
      "tracking_sessions y consent_audit_log (038), player_knowledge y evaluation_history (039) y tracking_jobs " +
      "(052). PostgreSQL comprueba EXECUTE al evaluar la política: revocarla haría fallar esas lecturas. Solo " +
      "devuelve los org_id del propio auth.uid() (vacío para anon).",
  },
  "public.user_in_org(uuid)": {
    category: "rls-helper",
    justification:
      "La evalúan las políticas INSERT WITH CHECK de players, videos, player_analyses y tracking_sessions (038). " +
      "Solo responde si el propio auth.uid() pertenece a esa organización.",
  },
  "public.handle_new_user()": {
    category: "trigger",
    justification:
      "Trigger on_auth_user_created sobre auth.users (000/001). RETURNS trigger: PostgreSQL no permite invocarla " +
      "fuera de un trigger, así que /rest/v1/rpc no puede ejecutarla.",
  },
  "public.dsar_export_player_data(text)": {
    category: "client-callable",
    justification:
      "La llama /admin/consent (ParentalConsentPage) desde el navegador con sesión. 072 la limita al dueño del " +
      "jugador (players.user_id = auth.uid()) y la revoca a anon; 076 retira la rama por tenant del JWT (espejo de " +
      "ownsPlayer, api/_lib/ownership.ts).",
  },
  "public.dsar_request_deletion(text,text)": {
    category: "client-callable",
    justification:
      "La llama /admin/consent (ParentalConsentPage) desde el navegador con sesión. Misma comprobación de dueño que " +
      "la exportación DSAR (072); el solicitante sale del JWT, nunca del parámetro.",
  },
};
