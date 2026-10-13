/**
 * POST /api/auth/consent-status   { playerIds: string[] }   (máx. 50)
 * Estado del consentimiento del TUTOR de cada jugador, para la ficha del jugador, /admin/consent
 * y la vista de familia (P1 bloque 3).
 *
 * Desde la 075 `parental_consents` es solo del servidor: el navegador ya no puede leerla (y lo
 * que leía antes, players.parental_consent_status, era un rótulo que el propio entrenador ponía
 * sin el tutor). El estado sale de api/_lib/parentalConsent.ts consentStatusForPlayer, cuyo
 * «verified» es EXACTAMENTE la regla del gate de análisis (findActiveParentalConsent).
 *
 * Solo el DUEÑO de cada jugador (ownedPlayerIdsAmong, 076); los ajenos o inexistentes no
 * aparecen en la respuesta (mismo trato, no revela cuáles existen). Si no se puede comprobar el
 * estado de un jugador → `state: "unavailable"` para ese jugador (nunca «verificado»).
 *
 * Respuesta: 200 { statuses: { [playerId]: GuardianConsentStatus | { state: "unavailable" } } }
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownedPlayerIdsAmong } from "../_lib/ownership";
import { consentStatusForPlayer, type GuardianConsentStatus } from "../_lib/parentalConsent";

const schema = z.object({
  playerIds: z.array(z.string().min(1).max(120)).min(1).max(50),
});

type StatusOrUnavailable = GuardianConsentStatus | { state: "unavailable" };

export default withHandler(
  { method: "POST", schema, requireAuth: true, maxRequests: 30 },
  async ({ body, userId }) => {
    const { playerIds } = body as z.infer<typeof schema>;

    const owned = await ownedPlayerIdsAmong(playerIds, userId);
    if (owned === null) {
      return errorResponse({ code: "ownership_check_failed", message: "No se pudo comprobar la propiedad", status: 500 });
    }

    // En lotes de 10 en paralelo (cada jugador son 2-4 consultas): 50 jugadores en serie podían
    // rozar el límite de tiempo de Edge (revisión del PR #314).
    const ids = Array.from(new Set(playerIds.filter((id) => owned.has(id))));
    const statuses: Record<string, StatusOrUnavailable> = {};
    const one = async (id: string) => {
      try {
        statuses[id] = await consentStatusForPlayer(id);
      } catch (err) {
        console.error("[consent-status] no se pudo comprobar:", err instanceof Error ? err.message : err);
        statuses[id] = { state: "unavailable" };
      }
    };
    for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map(one));
    return successResponse({ statuses });
  },
);

export const config = { runtime: "edge" };
