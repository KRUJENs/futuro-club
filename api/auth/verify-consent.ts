/**
 * VITAS · Verify Parental Consent
 * POST /api/auth/verify-consent  { token }
 *
 * Lo llama la página pública /auth/verify-consent (src/pages/VerifyConsentPage.tsx) con el
 * token del email que sign-consent mandó al tutor. Marca el consentimiento como
 * email_verified=true si el token es válido. Tras esto, el menor puede usar VITAS.
 *
 * B6 (review del PR #308) — el consentimiento que cuenta para analizar el vídeo de un
 * menor de 14 es el que el TUTOR verifica aquí, y el entrenador no puede fabricarlo
 * (api/_lib/parentalConsent.ts).
 *
 * Ronda 5 — CORRECCIÓN: la ronda 4 decía aquí que «un UPDATE directo de la fila desde el
 * cliente no crea la evidencia, así que no desbloquea ningún análisis». Era FALSO: este
 * endpoint buscaba la fila por `parental_consents.verification_token` y escribía la evidencia
 * con el `player_id` de la propia fila, y un cliente puede cambiar las dos columnas antes de la
 * 075/076 (reescribir el hash del token a sha256(X), alargar la caducidad y llamar aquí con X;
 * o reapuntar una fila propia a un menor ajeno). Reproducido por el revisor en una SIMULACIÓN
 * PGlite (no la base real). Ahora:
 *   1. el token se busca por su HASH en la EMISIÓN que escribió sign-consent con service_role
 *      (gdpr_audit_log 'consent_token_issued'), nunca en la fila. Un token que el servidor no
 *      emitió no existe → 404;
 *   2. la caducidad, el jugador y el email del tutor salen de esa emisión. Si la fila ya no
 *      apunta a ese jugador o a ese email (alguien la cambió) → 409 consent_changed, sin
 *      evidencia: hay que firmar de nuevo;
 *   3. la EVIDENCIA ('consent_email_verified', con el jugador, el email y el hash del token de
 *      la emisión) se escribe ANTES de marcar la fila; si no se puede → 500 y la fila NO se
 *      marca (el enlace sigue valiendo para reintentar);
 *   4. el marcado es condicional (sin retirar y aún pendiente). Si la evidencia ya estaba (un
 *      intento anterior no pudo marcar la fila), no se duplica: solo se marca.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import {
  findIssuedConsentToken,
  hasConsentVerification,
  hashConsentToken,
  recordParentalConsentVerified,
  type IssuedConsentToken,
} from "../_lib/parentalConsent";

export const config = { runtime: "edge" };

const verifySchema = z.object({
  token: z.string().min(32).max(128),
});

interface ConsentRow {
  id: string;
  player_id: string;
  parent_email: string | null;
  email_verified: boolean;
  withdrawn_at: string | null;
}

const verifyFailed = (message: string) => errorResponse({ code: "verify_failed", message, status: 500 });
const invalidToken = () =>
  errorResponse({ code: "invalid_token", message: "Token de verificación inválido o ya usado", status: 404 });

export default withHandler(
  { schema: verifySchema, requireAuth: false, maxRequests: 30 },
  async ({ body }) => {
    const { token } = body as z.infer<typeof verifySchema>;

    // Misma precedencia que api/_lib/env.ts (SUPABASE_URL primero), la que usan la
    // evidencia (parentalConsent.ts) y el gate: la fila y su evidencia van al MISMO proyecto.
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse({ code: "config_missing", message: "DB not configured", status: 500 });
    }

    const supabase = createClient(
      supabaseUrl,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // ── 1 · El token se busca en la EMISIÓN del servidor (no en la fila) ──
    let issued: IssuedConsentToken | null;
    try {
      issued = await findIssuedConsentToken(await hashConsentToken(token));
    } catch (err) {
      console.error("[verify-consent] no se pudo comprobar el enlace:", err instanceof Error ? err.message : err);
      return verifyFailed("No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.");
    }
    if (!issued) return invalidToken();

    // ── 2 · La fila a la que se emitió el enlace ──────────────────
    const { data, error } = await supabase
      .from("parental_consents")
      .select("id, player_id, parent_email, email_verified, withdrawn_at")
      .eq("id", issued.consentId)
      .maybeSingle();
    if (error) return verifyFailed("No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.");
    const consent = data as ConsentRow | null;
    if (!consent || consent.withdrawn_at) return invalidToken();

    // ── 3 · Tiene que seguir siendo lo que se firmó (jugador y email del tutor) ──
    if (consent.player_id !== issued.playerId || String(consent.parent_email ?? "").toLowerCase() !== issued.parentEmail) {
      console.warn(`[verify-consent] la fila ${issued.consentId} cambió desde que se emitió el enlace (jugador o email) → no se verifica`);
      return errorResponse({
        code: "consent_changed",
        message: "Este consentimiento ha cambiado desde que se envió el enlace. Hay que firmarlo de nuevo.",
        status: 409,
      });
    }

    // ── 4 · ¿Ya verificado con ESTE enlace? (evidencia del servidor, no la columna) ──
    let alreadyVerified: boolean;
    try {
      alreadyVerified = await hasConsentVerification(issued);
    } catch (err) {
      console.error("[verify-consent] no se pudo comprobar la evidencia:", err instanceof Error ? err.message : err);
      return verifyFailed("No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.");
    }

    if (!alreadyVerified) {
      // ── 5 · Caducidad: la que guardó el servidor al emitir el enlace ──
      if (Date.parse(issued.expiresAt) < Date.now()) {
        return errorResponse({
          code: "token_expired",
          message: "El enlace ha caducado. Solicita uno nuevo.",
          status: 410,
        });
      }
      // ── 6 · Evidencia del servidor ANTES de marcar (si falla, no se marca) ──
      try {
        await recordParentalConsentVerified(issued);
      } catch (err) {
        console.error("[verify-consent] no se pudo registrar la evidencia (no se marca):", err instanceof Error ? err.message : err);
        return verifyFailed("No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.");
      }
    }

    // ── 7 · Marcar como verificado (condicional: pendiente y sin retirar) ──
    const { data: updated, error: updateError } = await supabase
      .from("parental_consents")
      .update({
        email_verified: true,
        email_verified_at: new Date().toISOString(),
        verification_token: null, // informativo: el que cuenta es el de la emisión
        verification_expires_at: null,
      })
      .eq("id", consent.id)
      .eq("email_verified", false)
      .is("withdrawn_at", null)
      .select("id");

    if (updateError) {
      return verifyFailed("No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.");
    }
    if (alreadyVerified || !Array.isArray(updated) || updated.length === 0) {
      // Ya verificado con este enlace (doble clic, o reintento tras un fallo al marcar), u otra
      // petición la marcó entre la lectura y el UPDATE.
      return successResponse({
        consentId: consent.id,
        playerId: issued.playerId,
        alreadyVerified: true,
        message: "Este consentimiento ya estaba verificado.",
      });
    }

    return successResponse({
      consentId: consent.id,
      playerId: issued.playerId,
      verified: true,
      message: "Consentimiento verificado · el menor ya puede usar VITAS",
    });
  }
);
