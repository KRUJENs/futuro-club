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
 * (api/_lib/parentalConsent.ts):
 *   - el token se busca por su HASH (sign-consent guarda solo el hash): quien pueda leer la
 *     fila no tiene el token;
 *   - ANTES de marcar la fila se escribe la EVIDENCIA del servidor (gdpr_audit_log
 *     'consent_email_verified' con el id de la fila y su jugador, service_role). Si no se
 *     puede escribir → 500 y la fila NO se marca (el token sigue valiendo para reintentar).
 *     Antes se marcaba y el registro de auditoría se intentaba después sin mirar el error;
 *   - el marcado es condicional (aún sin verificar y sin retirar): dos clics no hacen dos
 *     verificaciones distintas.
 * Un UPDATE directo de la fila desde el cliente (posible mientras la 075 no esté aplicada)
 * no crea la evidencia, así que no desbloquea ningún análisis.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { hashConsentToken, recordParentalConsentVerified } from "../_lib/parentalConsent";

export const config = { runtime: "edge" };

const verifySchema = z.object({
  token: z.string().min(32).max(128),
});

interface PendingConsentRow {
  id: string;
  player_id: string;
  tenant_id: string | null;
  email_verified: boolean;
  verification_expires_at: string | null;
  withdrawn_at: string | null;
}

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

    // ── Buscar consentimiento por el HASH del token ───────────────
    const { data, error } = await supabase
      .from("parental_consents")
      .select("id, player_id, tenant_id, email_verified, verification_expires_at, withdrawn_at")
      .eq("verification_token", await hashConsentToken(token))
      .maybeSingle();

    if (error) {
      return errorResponse({
        code: "verify_failed",
        message: "No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.",
        status: 500,
      });
    }
    const consent = data as PendingConsentRow | null;
    if (!consent || consent.withdrawn_at) {
      return errorResponse({
        code: "invalid_token",
        message: "Token de verificación inválido o ya usado",
        status: 404,
      });
    }

    // ── Token caducado ────────────────────────────────────────────
    if (consent.verification_expires_at && new Date(consent.verification_expires_at) < new Date()) {
      return errorResponse({
        code: "token_expired",
        message: "El enlace ha caducado. Solicita uno nuevo.",
        status: 410,
      });
    }

    // ── Ya verificado previamente ─────────────────────────────────
    if (consent.email_verified) {
      return successResponse({
        consentId: consent.id,
        playerId: consent.player_id,
        alreadyVerified: true,
        message: "Este consentimiento ya estaba verificado.",
      });
    }

    // ── 1 · Evidencia del servidor ANTES de marcar (si falla, no se marca) ──
    try {
      await recordParentalConsentVerified({
        consentId: consent.id,
        playerId: consent.player_id,
        tenantId: consent.tenant_id,
      });
    } catch (err) {
      console.error("[verify-consent] no se pudo registrar la evidencia (no se marca):", err instanceof Error ? err.message : err);
      return errorResponse({
        code: "verify_failed",
        message: "No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.",
        status: 500,
      });
    }

    // ── 2 · Marcar como verificado (condicional: pendiente y sin retirar) ──
    const { data: updated, error: updateError } = await supabase
      .from("parental_consents")
      .update({
        email_verified: true,
        email_verified_at: new Date().toISOString(),
        verification_token: null, // invalidar token tras uso
        verification_expires_at: null,
      })
      .eq("id", consent.id)
      .eq("email_verified", false)
      .is("withdrawn_at", null)
      .select("id");

    if (updateError) {
      return errorResponse({
        code: "verify_failed",
        message: "No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.",
        status: 500,
      });
    }
    if (!Array.isArray(updated) || updated.length === 0) {
      // Otra petición la marcó entre la lectura y el UPDATE (doble clic).
      return successResponse({
        consentId: consent.id,
        playerId: consent.player_id,
        alreadyVerified: true,
        message: "Este consentimiento ya estaba verificado.",
      });
    }

    return successResponse({
      consentId: consent.id,
      playerId: consent.player_id,
      verified: true,
      message: "Consentimiento verificado · el menor ya puede usar VITAS",
    });
  }
);
