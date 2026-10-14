/**
 * VITAS · Pedir el consentimiento parental al TUTOR
 * POST /api/auth/sign-consent   { playerId, parentName, parentEmail, locale? }
 *
 * Lo llama el DUEÑO del jugador (entrenador o familia) desde la ficha del jugador o desde
 * /admin/consent. GDPR art. 8 y LOPDGDD art. 7 (datos de menores de 14).
 *
 * Flujo (P1 bloque 3; decisión del owner del 14 oct):
 *   1. El responsable escribe SOLO el nombre y el email del tutor. La fecha de nacimiento del
 *      menor sale de la ficha (players.birth_date), no de lo que se escriba aquí.
 *   2. Se escribe la EMISIÓN del enlace (gdpr_audit_log 'consent_token_issued', service_role)
 *      y luego la fila pendiente (email_verified=false, sin DNI).
 *   3. Se envía al tutor el correo con el enlace /auth/verify-consent#token=… (24 h), en el
 *      idioma de quien pide la firma.
 *   4. El TUTOR abre el enlace, lee qué autoriza, escribe SU DNI, acepta condiciones y
 *      privacidad y pulsa «Confirmo» (api/auth/verify-consent.ts). Nada se verifica al abrir.
 * Antes el formulario lo rellenaba el responsable con el DNI del tutor (que podía no saber) y
 * aceptaba él las condiciones en nombre del tutor (legal_acceptances con SU user_id).
 *
 * B6 (review del PR #308): en la base se guarda el HASH del token (hashConsentToken), no el
 * token: el que llega en el email es el único que verifica. La fila nace pendiente y solo
 * cuenta para el gate de análisis cuando verify-consent escribe su evidencia
 * (api/_lib/parentalConsent.ts). Ronda 5: ANTES de crear la fila se escribe la EMISIÓN con el id
 * de la fila, el jugador, el email del tutor, el hash del token y su caducidad; verify-consent
 * busca el token en ESA fila, nunca en parental_consents. Si la emisión no se puede escribir
 * → 500, sin fila ni email.
 *
 * Pedir de nuevo la firma (p. ej. el email estaba mal escrito) RETIRA antes las solicitudes
 * pendientes del jugador (source "superseded"): un enlace anterior aún vigente deja de valer.
 * Nunca toca un consentimiento ya verificado.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { sendEmail } from "../_lib/email";
import { requestEmail } from "../_lib/consentEmails";
import { createClient } from "@supabase/supabase-js";
import { sha256Hex, randomHex } from "../_lib/edgeCrypto";
import { hashConsentToken, recordConsentTokenIssued, withdrawParentalConsents } from "../_lib/parentalConsent";
import { minorStatusFromBirthDate } from "../../src/lib/shared/videoConsent";
import { normalizeLocale } from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

const consentSchema = z.object({
  playerId: z.string().min(1).max(120), // text en BBDD (compatible con IDs existentes)
  parentName: z.string().trim().min(2).max(120),
  parentEmail: z.string().trim().email().max(254),
  locale: z.string().max(10).optional(),
});

/** Fecha de calendario YYYY-MM-DD de lo que devuelva la base (date o timestamptz). */
function birthDateOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

export default withHandler(
  { schema: consentSchema, requireAuth: true, maxRequests: 10 },
  async ({ body, userId, tenantId, isServiceCall, ip }) => {
    const input = body as z.infer<typeof consentSchema>;
    const locale = normalizeLocale(input.locale);

    // Autorización a nivel de objeto: sin esto, cualquier autenticado podía FORJAR el
    // consentimiento parental de un menor ajeno y filtrar su nombre por email a un parentEmail
    // que él controla. Solo el DUEÑO del jugador (076): nunca por tenant.
    if (!isServiceCall && !(await ownsPlayer(input.playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    // Misma precedencia que api/_lib/env.ts (SUPABASE_URL primero), la que usan
    // verify-consent, la evidencia (parentalConsent.ts) y el gate de análisis.
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse({ code: "config_missing", message: "DB not configured", status: 500 });
    }

    const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ── El jugador: grupo, nombre y fecha de nacimiento (la de la ficha) ─────────
    const { data: player } = await supabase
      .from("players")
      .select("tenant_id, name, birth_date")
      .eq("id", input.playerId)
      .single();

    if (!player) {
      return errorResponse({ code: "player_not_found", message: "Player no existe", status: 404 });
    }

    // Solo para un menor de 14 CONOCIDO (misma regla que el gate, 036): sin fecha no se sabe
    // si hace falta, y la fecha del consentimiento tiene que ser la de la ficha.
    const childBirthdate = birthDateOf(player.birth_date);
    const minor = minorStatusFromBirthDate(childBirthdate);
    if (minor === "unknown" || minor === "invalid") {
      return errorResponse({
        code: "birth_date_required",
        message: "Añade la fecha de nacimiento del jugador en su ficha antes de pedir el consentimiento.",
        status: 409,
      });
    }
    if (minor === "not_minor") {
      return errorResponse({
        code: "consent_not_required",
        message: "El jugador tiene 14 años o más: no hace falta el consentimiento del tutor.",
        status: 409,
      });
    }

    // parental_consents.tenant_id es NOT NULL (003): el del jugador o, si no lo tiene, el del
    // propio responsable (JWT). Sin ninguno no se puede guardar: se dice, no se inventa.
    const consentTenant = (player.tenant_id as string | null) ?? tenantId ?? null;
    if (!consentTenant) {
      return errorResponse({
        code: "tenant_missing",
        message: "No se puede registrar el consentimiento: el jugador no tiene club o grupo asignado.",
        status: 409,
      });
    }

    const parentEmail = input.parentEmail.toLowerCase();

    // ── 0 · Una nueva solicitud SUSTITUYE a las pendientes (nunca a una verificada) ──
    // ANTES de crear la nueva, a propósito: si se hiciera después (retirando todas menos la
    // propia), dos solicitudes simultáneas (doble clic) se retirarían la una a la otra y el tutor
    // recibiría dos enlaces muertos. El precio (revisión #314): si lo de abajo falla, la anterior
    // ya no vale; el responsable ve el error y la pide otra vez, que es lo que quería hacer.
    try {
      await withdrawParentalConsents({
        playerId: input.playerId,
        userId: userId ?? null,
        tenantId: consentTenant,
        reason: null,
        onlyUnverified: true,
        source: "superseded",
      });
    } catch (err) {
      console.error("[sign-consent] no se pudieron retirar las solicitudes pendientes:", err instanceof Error ? err.message : err);
      return errorResponse({
        code: "consent_save_failed",
        message: "No se pudo registrar la solicitud. Inténtalo de nuevo más tarde.",
        status: 500,
      });
    }

    // ── Hash de lo que se pide (bundle de campos clave) ───────────
    const signatureHash = await sha256Hex(
      JSON.stringify({
        playerId: input.playerId,
        parentEmail,
        childBirthdate,
        requestedBy: userId ?? null,
        timestamp: Date.now(),
      }),
    );

    // ── Token de verificación (24h validez) ───────────────────────
    // El token en claro SOLO viaja en el email del tutor; en la base se guarda su hash (B6).
    const verificationToken = randomHex(32);
    const verificationTokenHash = await hashConsentToken(verificationToken);
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // ── 1 · EMISIÓN del enlace ligada en el servidor (ANTES de la fila) ──
    const consentId = crypto.randomUUID();
    try {
      await recordConsentTokenIssued({
        consentId,
        playerId: input.playerId,
        parentEmail,
        tokenHash: verificationTokenHash,
        expiresAt: verificationExpires,
        tenantId: consentTenant,
        userId: userId ?? null,
        locale,
      });
    } catch (err) {
      console.error("[sign-consent] no se pudo registrar la emisión del enlace (no se crea nada):", err instanceof Error ? err.message : err);
      return errorResponse({
        code: "consent_save_failed",
        message: "No se pudo registrar la solicitud. Inténtalo de nuevo más tarde.",
        status: 500,
      });
    }

    // ── 2 · Fila pendiente (con el id de la emisión). El DNI lo pone el tutor al confirmar. ──
    const { error } = await supabase
      .from("parental_consents")
      .insert({
        id: consentId,
        player_id: input.playerId,
        tenant_id: consentTenant,
        parent_email: parentEmail,
        parent_name: input.parentName,
        parent_dni_hash: null,
        child_birthdate: childBirthdate,
        signed_ip: ip,
        signature_hash: signatureHash,
        verification_token: verificationTokenHash,
        verification_expires_at: verificationExpires,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[sign-consent] no se pudo crear la fila:", error.message);
      return errorResponse({
        code: "consent_save_failed",
        message: "No se pudo registrar la solicitud. Inténtalo de nuevo más tarde.",
        status: 500,
      });
    }

    // ── 3 · Correo al tutor ───────────────────────────────────────
    const baseUrl = process.env.VITAS_PUBLIC_URL ?? "https://futuro-club.vercel.app";
    const mail = requestEmail({
      locale,
      parentName: input.parentName,
      childName: (player.name as string | null) ?? "—",
      // El código va tras «#»: el fragmento no viaja a ningún servidor (ni a sus registros).
      link: `${baseUrl}/auth/verify-consent#token=${verificationToken}`,
    });
    const emailSent = await sendEmail({ to: parentEmail, subject: mail.subject, html: mail.html });

    return successResponse({
      consentId,
      status: "pending_verification",
      emailSent,
      expiresAt: verificationExpires,
    });
  },
);
