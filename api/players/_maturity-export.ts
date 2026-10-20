/**
 * GET /api/players/maturity-export?playerId=…
 *
 * Salida del estado de maduración para FICHA/Grada (P2 bloque 10, decisión D11): contrato
 * `vitas.maturity.v1` = estado + fecha estimada del PHV + confianza. Nada más del jugador.
 *  - Solo el DUEÑO del jugador (ownsPlayer; sin token de servicio).
 *  - Menor (o edad desconocida) ⇒ consentimiento ACTIVO del tutor (fuente canónica
 *    hasActiveParentalConsent); sin él, 403 sin decir nada del PHV. Un fallo de la base
 *    falla cerrado (500).
 *  - El PHV pasa por las mismas puertas que el resto del servidor (buildMaturityExport).
 * Contrato: docs/contrato-maduracion-ficha.md.
 */
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { hasActiveParentalConsent } from "../_lib/analysisConsentGate";
import { buildMaturityExport, requiresGuardianConsent } from "../../src/lib/shared/maturityExport";
import { toIsoBirthDate } from "../../src/lib/shared/birthDate";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const querySchema = z.object({ playerId: z.string().min(1).max(200) });

const STATUS_BY_CODE = { consent_required: 403, phv_unavailable: 422 } as const;

export default withHandler(
  { method: ["GET"], requireAuth: true, maxRequests: 60 },
  async ({ query, userId }) => {
    const params = querySchema.safeParse(query);
    if (!params.success) {
      return errorResponse({ code: "invalid_params", message: "playerId requerido", status: 400 });
    }
    const { playerId } = params.data;
    if (!(await ownsPlayer(playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: player, error: pErr } = await supabase
      .from("players")
      .select("birth_date, data")
      .eq("id", playerId)
      .single();
    if (pErr || !player) {
      return errorResponse({ code: "player_not_found", message: pErr?.message ?? "Jugador no existe", status: 404 });
    }
    const blob = (player.data ?? {}) as Record<string, unknown>;
    const birthDate =
      toIsoBirthDate(player.birth_date) ?? toIsoBirthDate(typeof blob.birthDate === "string" ? blob.birthDate : null);

    let hasConsent = false;
    if (requiresGuardianConsent(birthDate)) {
      try {
        hasConsent = await hasActiveParentalConsent(playerId);
      } catch (e) {
        return errorResponse({ code: "db_error", message: (e as Error).message, status: 500 });
      }
      if (!hasConsent) {
        // Sin consentimiento no se lee ni la medición.
        const blocked = buildMaturityExport({ playerId, birthDate, blob, row: null, hasConsent: false });
        if (!blocked.ok) {
          return errorResponse({ code: blocked.code, message: blocked.gate_reason, status: STATUS_BY_CODE[blocked.code] });
        }
      }
    }

    const { data: row, error: aErr } = await supabase
      .from("player_latest_anthropometrics")
      .select("*")
      .eq("player_id", playerId)
      .maybeSingle();
    if (aErr) {
      return errorResponse({ code: "db_error", message: aErr.message, status: 500 });
    }

    const result = buildMaturityExport({ playerId, birthDate, blob, row: row ?? null, hasConsent });
    if (!result.ok) {
      return errorResponse({ code: result.code, message: result.gate_reason, status: STATUS_BY_CODE[result.code] });
    }
    return successResponse(result.payload);
  },
);
