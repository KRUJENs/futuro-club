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
 *
 * P1 bloque 3 (decisión del owner, 14 oct): este POST solo llega cuando el TUTOR pulsa
 * «Confirmo como tutor legal» en la página (antes la página hacía el POST al abrirse: un
 * escáner de enlaces del correo podía «firmar», CWE-650). Trae SU DNI (se guarda solo el hash) y
 * su aceptación de las condiciones y la privacidad, que quedan en la evidencia. Al confirmar se
 * le envía un segundo correo con un enlace de RETIRADA (api/auth/_guardian-withdraw.ts).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { sha256Hex, randomHex } from "../_lib/edgeCrypto";
import { sendEmail } from "../_lib/email";
import { confirmationEmail } from "../_lib/consentEmails";
import {
  countConsentWithdrawTokens,
  findIssuedConsentToken,
  hasConsentVerification,
  hasConsentWithdrawal,
  hashConsentToken,
  recordConsentWithdrawTokenIssued,
  recordParentalConsentVerified,
  type IssuedConsentToken,
} from "../_lib/parentalConsent";

export const config = { runtime: "edge" };

/** Versión de las condiciones y de la privacidad que acepta el tutor en la página. */
export const GUARDIAN_CONSENT_VERSION = "v1.0";

/**
 * Tope de enlaces de RETIRADA por consentimiento. Volver a confirmar uno ya confirmado da un enlace
 * nuevo; cada uno es una fila de gdpr_audit_log (de solo añadir), así que sin tope quien tenga el
 * enlace de verificación podría llenarla (revisión 2 del PR #314). 10 sobra para un tutor real; al
 * llegar, la página le dice que lo retire el responsable del jugador, y los anteriores siguen valiendo.
 * Tope BLANDO (contar y luego emitir no es atómico): varias reconfirmaciones simultáneas pueden
 * pasarlo por poco; basta para acotar el crecimiento (revisión 3).
 */
export const MAX_WITHDRAW_LINKS_PER_CONSENT = 10;

const verifySchema = z.object({
  token: z.string().min(32).max(128),
  // DNI/NIE o documento del tutor: lo escribe ÉL (nunca el responsable del jugador).
  parentDni: z.string().trim().min(5).max(20).regex(/^[A-Z0-9]+$/i),
  // Acción afirmativa del tutor (RGPD): ambas casillas marcadas en la página.
  acceptedTerms: z.literal(true),
  acceptedPrivacy: z.literal(true),
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
    const { token, parentDni } = body as z.infer<typeof verifySchema>;

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

    // ── 3b · ¿Ya retirado? (evidencia del servidor, aunque el PATCH de la retirada fallara a
    //        mitad): no se dice «confirmado» a un consentimiento que no puede contar (revisión #314).
    //        Queda una ventana: si el responsable lo retira JUSTO mientras el tutor confirma, el
    //        tutor puede ver «confirmado» y el consentimiento acabar retirado. Falla en cerrado (no
    //        cuenta: la evidencia de retirada manda) y la ficha muestra «retirado».
    try {
      if (await hasConsentWithdrawal(consent.id)) return invalidToken();
    } catch (err) {
      console.error("[verify-consent] no se pudo comprobar la retirada:", err instanceof Error ? err.message : err);
      return verifyFailed("No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.");
    }

    // ── 4 · ¿Ya verificado con ESTE enlace? (evidencia del servidor, no la columna) ──
    let alreadyVerified: boolean;
    try {
      alreadyVerified = await hasConsentVerification(issued);
    } catch (err) {
      console.error("[verify-consent] no se pudo comprobar la evidencia:", err instanceof Error ? err.message : err);
      return verifyFailed("No se pudo comprobar el enlace. Inténtalo de nuevo más tarde.");
    }

    // DNI del tutor: solo su hash (nunca en claro), igual que antes en sign-consent. Va SOLO a la
    // fila (que se borra con el jugador), no a la evidencia de gdpr_audit_log (de solo añadir).
    const dniHash = await sha256Hex(parentDni.toUpperCase());

    if (!alreadyVerified) {
      // ── 5 · Caducidad: la que guardó el servidor al emitir el enlace ──
      if (Date.parse(issued.expiresAt) < Date.now()) {
        return errorResponse({
          code: "token_expired",
          message: "El enlace ha caducado. Solicita uno nuevo.",
          status: 410,
        });
      }
      // ── 6 · Evidencia del servidor ANTES de marcar (si falla, no se marca), con las
      //       aceptaciones del TUTOR (y que aportó su DNI) ──
      try {
        await recordParentalConsentVerified(issued, { consentVersion: GUARDIAN_CONSENT_VERSION });
      } catch (err) {
        console.error("[verify-consent] no se pudo registrar la evidencia (no se marca):", err instanceof Error ? err.message : err);
        return verifyFailed("No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.");
      }
    }

    // Enlace de RETIRADA para el tutor y, si `sendMail`, el correo de confirmación con él. Si algo
    // falla aquí el consentimiento YA vale: se avisa en la respuesta y el responsable puede retirarlo.
    const issueWithdrawLink = async (sendMail: boolean): Promise<{ withdrawToken: string | null; confirmationSent: boolean }> => {
      const withdrawToken = randomHex(32);
      try {
        await recordConsentWithdrawTokenIssued({
          consentId: consent.id,
          playerId: issued.playerId,
          parentEmail: issued.parentEmail,
          tokenHash: await hashConsentToken(withdrawToken),
          tenantId: issued.tenantId,
        });
      } catch (err) {
        console.error("[verify-consent] no se pudo emitir el enlace de retirada:", err instanceof Error ? err.message : err);
        return { withdrawToken: null, confirmationSent: false };
      }
      if (!sendMail) return { withdrawToken, confirmationSent: false };
      const { data: player } = await supabase.from("players").select("name").eq("id", issued.playerId).maybeSingle();
      const { data: row } = await supabase.from("parental_consents").select("parent_name").eq("id", consent.id).maybeSingle();
      const baseUrl = process.env.VITAS_PUBLIC_URL ?? "https://futuro-club.vercel.app";
      const mail = confirmationEmail({
        locale: issued.locale,
        parentName: ((row as { parent_name?: string } | null)?.parent_name as string | undefined) ?? "",
        childName: ((player as { name?: string } | null)?.name as string | undefined) ?? "—",
        // El código va tras «#»: el fragmento no viaja a ningún servidor (ni a sus registros).
        withdrawLink: `${baseUrl}/auth/withdraw-consent#token=${withdrawToken}`,
      });
      return { withdrawToken, confirmationSent: await sendEmail({ to: issued.parentEmail, subject: mail.subject, html: mail.html }) };
    };

    // ── 7 · Marcar como verificado (condicional: pendiente y sin retirar) ──
    const { data: updated, error: updateError } = await supabase
      .from("parental_consents")
      .update({
        email_verified: true,
        email_verified_at: new Date().toISOString(),
        parent_dni_hash: dniHash,
        consent_version: GUARDIAN_CONSENT_VERSION,
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
    if (!Array.isArray(updated) || updated.length === 0) {
      // ESTA petición no marcó la fila. Se mira por qué (revisión #314): retirada o sustituida
      // entre la lectura y el UPDATE ⇒ el enlace ya no vale; ya verificada (doble clic u otra
      // petición) ⇒ «ya estaba confirmado» (el tutor tiene el enlace de retirada de la primera).
      const { data: now, error: nowError } = await supabase
        .from("parental_consents")
        .select("id, player_id, parent_email, email_verified, withdrawn_at")
        .eq("id", consent.id)
        .maybeSingle();
      if (nowError) return verifyFailed("No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.");
      const row = now as ConsentRow | null;
      if (!row || row.withdrawn_at) return invalidToken();
      if (row.email_verified) {
        // Ya confirmado (doble clic, otra pestaña o una confirmación anterior). El tutor recibe en
        // la página un enlace de retirada NUEVO (los anteriores siguen valiendo), y el correo solo si
        // nunca se le EMITIÓ ninguno: si la primera vez falló la emisión, antes se le remitía a un
        // correo que no existía (revisión #314). Si se emitió pero el correo no salió, no se reenvía:
        // el enlace está en la página. Retirar es lo seguro: dárselo a quien tiene SU enlace no abre
        // nada. Tope por consentimiento (MAX_WITHDRAW_LINKS_PER_CONSENT); si no se puede contar, sin
        // enlace nuevo (la página le dice cómo retirarlo).
        let issuedCount: number | null = null;
        try {
          issuedCount = await countConsentWithdrawTokens(consent.id, MAX_WITHDRAW_LINKS_PER_CONSENT);
        } catch (err) {
          console.error("[verify-consent] no se pudo comprobar el enlace de retirada:", err instanceof Error ? err.message : err);
        }
        const link =
          issuedCount === null || issuedCount >= MAX_WITHDRAW_LINKS_PER_CONSENT
            ? { withdrawToken: null, confirmationSent: false }
            : await issueWithdrawLink(issuedCount === 0);
        return successResponse({
          consentId: consent.id,
          alreadyVerified: true,
          withdrawToken: link.withdrawToken,
          confirmationEmailSent: link.confirmationSent,
          message: "Este consentimiento ya estaba verificado.",
        });
      }
      return verifyFailed("No se pudo registrar la verificación. Inténtalo de nuevo desde el enlace del email.");
    }
    // Desde aquí ESTA petición marcó la fila: primera confirmación o reintento tras un fallo al
    // marcar (la evidencia ya estaba). En los dos casos el tutor recibe su enlace de retirada
    // (antes, en el reintento, no se emitía: revisión #314, punto B).
    void alreadyVerified;

    // ── 8 · Enlace de RETIRADA para el tutor (correo de confirmación) ──
    const link = await issueWithdrawLink(true);

    return successResponse({
      consentId: consent.id,
      verified: true,
      // El tutor está en la página con SU enlace y su DNI: si el correo no sale, la página le
      // ofrece el enlace de retirada igualmente. Si NO se pudo emitir (null), la página se lo dice
      // y le indica que pida la retirada al responsable del jugador.
      withdrawToken: link.withdrawToken,
      confirmationEmailSent: link.confirmationSent,
      message: "Consentimiento verificado.",
    });
  }
);
