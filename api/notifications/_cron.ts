/**
 * GET /api/notifications/cron
 * Cron diario (09:00 UTC) — detecta triggers y envía Web Push.
 *
 * Improvements:
 * 1. Respects user notification preferences (stored in notification_preferences table)
 * 2. Deduplication: won't send same trigger type for same player within 24h
 * 3. Logs sent notifications in notification_log for audit trail
 * 4. Email fallback via Resend for critical alerts (VSI < 40)
 *
 * Triggers:
 * 1. Low VSI Alert: VSI < 50 → rendimientoBajo
 * 2. Inactivity Reminder: No updates for 30+ days → inactividad
 * 3. Plan Limit Alert: Free plan users at 4/5 players → limitePlan
 *
 * Node.js runtime required — web-push needs Node crypto for VAPID signing.
 */

import webpush from "web-push";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { RESEND_FROM } from "../_lib/email";
import { env } from "../_lib/env";
import { fichaVsiFromBlob } from "../../src/services/real/metricsService";

interface PushSub {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface PlayerRow {
  user_id: string;
  data: {
    name?: string;
    metrics?: Record<string, number>;
    vsi?: number;
  };
  updated_at: string;
}

interface Subscription {
  user_id: string;
  plan: string;
}

interface NotifPreference {
  user_id: string;
  rendimiento_bajo: boolean;
  inactividad: boolean;
  limite_plan: boolean;
  analisis_completado: boolean;
}

interface NotifLog {
  user_id: string;
  trigger_type: string;
  player_id?: string;
  sent_at: string;
}

interface Notification {
  userId: string;
  title: string;
  body: string;
  triggerType: string;
  playerId?: string;
  critical?: boolean;
}

export default withHandler(
  { method: "GET", serviceOnly: true },
  async () => {
    const supabaseUrl  = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const vapidPublic  = process.env.VITE_VAPID_PUBLIC_KEY ?? process.env.VAPID_PUBLIC_KEY ?? "";
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY ?? "";
    const vapidSubject = process.env.VAPID_SUBJECT ?? process.env.VAPID_MAILTO ?? "mailto:Contact@krujens.eu";
    const vapidEmail   = vapidSubject.startsWith("mailto:") ? vapidSubject : `mailto:${vapidSubject}`;
    const resendKey    = process.env.RESEND_API_KEY;

    if (!vapidPrivate || !vapidPublic) {
      console.warn("[notifications] VAPID keys not configured — push notifications disabled. Set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY in Vercel env vars.");
    }

    if (!supabaseUrl || !serviceKey) {
      return errorResponse("Supabase not configured", 500);
    }

    if (!vapidPublic || !vapidPrivate) {
      return errorResponse("VAPID keys not configured — push disabled", 503);
    }

    // Configure web-push with VAPID credentials
    webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);

    const headers = {
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    };

    const base = `${supabaseUrl}/rest/v1`;
    const notifications: Notification[] = [];

    // ─── Fetch all data in parallel ─────────────────────────────────────
    const [playersRes, subsRes, pushRes, prefsRes, logsRes] = await Promise.all([
      fetch(`${base}/players?select=user_id,data,updated_at`, { headers }),
      fetch(`${base}/subscriptions?select=user_id,plan`, { headers }),
      fetch(`${base}/push_subscriptions?select=user_id,endpoint,p256dh,auth`, { headers }),
      fetch(`${base}/notification_preferences?select=*`, { headers }),
      // Get logs from last 24 hours for deduplication
      fetch(`${base}/notification_log?sent_at=gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}&select=user_id,trigger_type,player_id,sent_at`, { headers }),
    ]);

    const players: PlayerRow[] = playersRes.ok ? await playersRes.json() : [];
    const subs: Subscription[] = subsRes.ok ? await subsRes.json() : [];
    const pushSubs: PushSub[] = pushRes.ok ? await pushRes.json() : [];
    const prefs: NotifPreference[] = prefsRes.ok ? await prefsRes.json() : [];
    const recentLogs: NotifLog[] = logsRes.ok ? await logsRes.json() : [];

    // Build preference lookup (default: all enabled)
    const prefMap = new Map<string, NotifPreference>();
    for (const p of prefs) prefMap.set(p.user_id, p);

    function isEnabled(userId: string, type: string): boolean {
      const pref = prefMap.get(userId);
      if (!pref) return true; // Default: all enabled
      switch (type) {
        case "rendimientoBajo": return pref.rendimiento_bajo;
        case "inactividad": return pref.inactividad;
        case "limitePlan": return pref.limite_plan;
        default: return true;
      }
    }

    // Build dedup set: "userId:triggerType:playerId"
    const dedupSet = new Set<string>();
    for (const log of recentLogs) {
      dedupSet.add(`${log.user_id}:${log.trigger_type}:${log.player_id ?? ""}`);
    }

    function isDuplicate(userId: string, type: string, playerId?: string): boolean {
      return dedupSet.has(`${userId}:${type}:${playerId ?? ""}`);
    }

    // ─── Trigger 1: evaluación del entrenador baja ──────────────────────
    // P1 bloque 5b: el VSI de ficha es la EVALUACIÓN DEL ENTRENADOR (6 barras subjetivas)
    // y se lee del valor guardado (calculateFichaVsi al guardar las barras, fuente única).
    // Antes este cron copiaba los pesos y, si faltaba alguno, usaba una MEDIA SIMPLE: un
    // segundo VSI distinto para el mismo niño (invariante #7). Sin evaluación, no avisa.
    for (const p of players) {
      const vsi = fichaVsiFromBlob(p.data);
      if (vsi === null) continue;

      if (vsi < 50 && isEnabled(p.user_id, "rendimientoBajo") && !isDuplicate(p.user_id, "rendimientoBajo", p.data?.name)) {
        notifications.push({
          userId: p.user_id,
          title: "Evaluación del entrenador baja",
          body: `${p.data?.name ?? "Jugador"} tiene una evaluación del entrenador de ${Math.round(vsi)} (valoración subjetiva). Revisa su perfil.`,
          triggerType: "rendimientoBajo",
          playerId: p.data?.name,
          critical: vsi < 40,
        });
      }
    }

    // ─── Trigger 2: Inactivity (30 days) ─────────────────────────────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const p of players) {
      if (p.updated_at < thirtyDaysAgo && isEnabled(p.user_id, "inactividad") && !isDuplicate(p.user_id, "inactividad", p.data?.name)) {
        notifications.push({
          userId: p.user_id,
          title: "Jugador inactivo",
          body: `${p.data?.name ?? "Jugador"} lleva más de 30 días sin nuevos datos.`,
          triggerType: "inactividad",
          playerId: p.data?.name,
        });
      }
    }

    // ─── Trigger 3: Plan limit (90%) ─────────────────────────────────────
    for (const sub of subs) {
      if (sub.plan === "free") {
        const playerCount = players.filter((p) => p.user_id === sub.user_id).length;
        if (playerCount >= 4 && isEnabled(sub.user_id, "limitePlan") && !isDuplicate(sub.user_id, "limitePlan")) {
          notifications.push({
            userId: sub.user_id,
            title: "Límite de jugadores",
            body: `Tienes ${playerCount}/5 jugadores. Actualiza a Pro para añadir más.`,
            triggerType: "limitePlan",
          });
        }
      }
    }

    // ─── Send notifications ──────────────────────────────────────────────
    let sent = 0;
    let failed = 0;
    const logEntries: Array<{ user_id: string; trigger_type: string; player_id: string; channel: string; sent_at: string }> = [];
    const now = new Date().toISOString();

    for (const notif of notifications) {
      const userPushSubs = pushSubs.filter((s) => s.user_id === notif.userId);

      for (const sub of userPushSubs) {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({ title: notif.title, body: notif.body, url: "/" }),
          );
          sent++;
          logEntries.push({
            user_id: notif.userId,
            trigger_type: notif.triggerType,
            player_id: notif.playerId ?? "",
            channel: "push",
            sent_at: now,
          });
        } catch (err) {
          failed++;
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 410) {
            // Subscription expired — clean up
            await fetch(
              `${base}/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
              { method: "DELETE", headers },
            ).catch(() => {});
          }
        }
      }

      // Email fallback for critical alerts via Resend
      if (notif.critical && resendKey) {
        try {
          // Fetch user email from auth.users via service role
          const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${notif.userId}`, {
            headers: {
              "apikey": serviceKey,
              "Authorization": `Bearer ${serviceKey}`,
            },
          });
          if (userRes.ok) {
            const userData = await userRes.json();
            const email = userData.email;
            if (email) {
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${resendKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: RESEND_FROM,
                  to: [email],
                  subject: `⚠️ ${notif.title}`,
                  html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
                    <h2 style="color:#ef4444;">${notif.title}</h2>
                    <p>${notif.body}</p>
                    <a href="${env.publicUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;">Ver en VITAS</a>
                  </div>`,
                }),
              });
              logEntries.push({
                user_id: notif.userId,
                trigger_type: notif.triggerType,
                player_id: notif.playerId ?? "",
                channel: "email",
                sent_at: now,
              });
            }
          }
        } catch (emailErr) {
          console.error("[notifications] Email fallback failed:", emailErr instanceof Error ? emailErr.message : emailErr);
          // Don't throw — push was already attempted
        }
      }
    }

    // ─── Log sent notifications for deduplication ────────────────────────
    if (logEntries.length > 0) {
      await fetch(`${base}/notification_log`, {
        method: "POST",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify(logEntries),
      }).catch(() => {});
    }

    return successResponse({ success: true, notifications: notifications.length, sent, failed });
  },
);
