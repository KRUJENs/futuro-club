/**
 * VITAS · Right to Erasure (GDPR Art. 17)
 * POST   /api/account/delete-me      → solicita borrado (programa para 72h)
 * DELETE /api/account/delete-me      → ejecuta borrado inmediato (admin)
 * GET    /api/account/delete-me?cancellationToken=... → cancela solicitud
 *
 * Flujo:
 *   1. Usuario solicita borrado → se programa para 72h después
 *   2. Email confirmando + link de cancelación
 *   3. Cron (run-scheduled-deletions) ejecuta a las 72h
 *   4. Borra de TODAS las tablas (cascada manual + Bunny + storage)
 *   5. Audit log permanece (obligación legal)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { randomHex } from "../_lib/edgeCrypto";
import { RESEND_FROM } from "../_lib/email";
import { deleteUserDataCompletely } from "../_lib/accountErasure";

export const config = { runtime: "edge" };

const deleteSchema = z.object({
  reason: z.string().max(500).optional(),
  confirmText: z.literal("ELIMINAR MI CUENTA"), // confirmación explícita anti-error
});

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL = process.env.VITAS_PUBLIC_URL ?? "https://futuro-club.vercel.app";
const RETENTION_HOURS = 72;

async function sendDeletionEmail(to: string, cancellationLink: string, scheduledFor: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  const html = `
<!DOCTYPE html><html><body style="font-family:system-ui;color:#0F172A;background:#F4F7FB;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #E2E8F0;">
    <h1 style="font-size:22px;color:#EB1D1D;">Solicitud de eliminación recibida</h1>
    <p>Has solicitado eliminar tu cuenta y todos tus datos en VITAS.</p>
    <p><strong>Programado para:</strong> ${scheduledFor}</p>
    <p>Tienes <strong>72 horas</strong> para cancelar la solicitud si cambias de opinión:</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${cancellationLink}" style="display:inline-block;padding:14px 32px;background:#0066CC;color:#fff;text-decoration:none;border-radius:100px;font-weight:600;">
        Cancelar solicitud
      </a>
    </p>
    <p style="font-size:13px;color:#64748b;">Pasadas las 72h, tus datos serán eliminados permanentemente y no podrán recuperarse.</p>
    <p style="font-size:12px;color:#94a3b8;">Conforme a GDPR Art. 17 (derecho al olvido).</p>
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: "VITAS · Solicitud de eliminación de cuenta",
      html,
    }),
  });
  return res.ok;
}

// Borrado RGPD de UNA cuenta: implementación única en api/_lib/accountErasure.ts
// (la comparte el cron api/crons/data-retention.ts). Solo datos del DUEÑO (076).
export { deleteUserDataCompletely };

export default withHandler(
  { schema: deleteSchema, requireAuth: true, maxRequests: 3 },
  async ({ body, userId, ip, method }) => {
    if (!userId) {
      return errorResponse({ code: "unauthenticated", message: "Sesión requerida", status: 401 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Perfil del usuario (email del aviso; tenant_id solo como etiqueta del registro
    // RGPD: el borrado es por DUEÑO, nunca por tenant — 076)
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("tenant_id, email")
      .eq("user_id", userId)
      .single();

    if (!profile) {
      return errorResponse({ code: "profile_not_found", message: "Perfil no existe", status: 404 });
    }

    const isAdminImmediateDelete = method === "DELETE";

    // ── Modo borrado inmediato (admin only) ──────────────────────
    if (isAdminImmediateDelete) {
      const summary = await deleteUserDataCompletely(supabase, userId);

      await supabase.rpc("log_gdpr_action", {
        p_user_id: userId,
        p_tenant_id: profile.tenant_id,
        p_action: "data_deleted_immediate",
        p_resource_type: "user_account",
        p_resource_id: userId,
        p_metadata: summary,
        p_ip: ip,
      });

      return successResponse({
        status: "completed",
        deletedAt: new Date().toISOString(),
        summary,
      });
    }

    // ── Modo programado (72h) · POST ─────────────────────────────
    const scheduledFor = new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000);
    const cancellationToken = randomHex(32);

    const { data: req, error } = await supabase
      .from("deletion_requests")
      .insert({
        user_id: userId,
        tenant_id: profile.tenant_id,
        requested_ip: ip,
        scheduled_for: scheduledFor.toISOString(),
        cancellation_token: cancellationToken,
      })
      .select()
      .single();

    if (error) {
      return errorResponse({
        code: "request_save_failed",
        message: error.message,
        status: 500,
      });
    }

    // Email confirmación con link de cancelación
    const cancelLink = `${PUBLIC_URL}/account/cancel-deletion?token=${cancellationToken}`;
    await sendDeletionEmail(profile.email, cancelLink, scheduledFor.toLocaleString("es-ES"));

    // Audit
    await supabase.rpc("log_gdpr_action", {
      p_user_id: userId,
      p_tenant_id: profile.tenant_id,
      p_action: "deletion_requested",
      p_resource_type: "deletion_requests",
      p_resource_id: req.id,
      p_metadata: { reason: (body as z.infer<typeof deleteSchema>).reason ?? null, scheduled_for: scheduledFor.toISOString() },
      p_ip: ip,
    });

    return successResponse({
      status: "scheduled",
      requestId: req.id,
      scheduledFor: scheduledFor.toISOString(),
      hoursToCancel: RETENTION_HOURS,
      message: `Tu cuenta será eliminada en ${RETENTION_HOURS} horas. Hemos enviado un email con un enlace para cancelar la solicitud.`,
    });
  }
);
