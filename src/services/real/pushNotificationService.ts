/**
 * VITAS — Push Notification Service
 * Gestiona suscripciones Web Push para notificaciones nativas.
 * Requiere: VITE_VAPID_PUBLIC_KEY en env vars.
 */

// Leído en tiempo de llamada (no en carga de módulo): así los tests pueden
// stubbear el env con vi.stubEnv (el import estático se iza por encima del stub)
// y no depende de que exista un .env en el entorno. Vite inlinea igual en prod.
function getVapidPublicKey(): string | undefined {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export const PushNotificationService = {
  isSupported(): boolean {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  },

  async getPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) return "denied";
    return Notification.permission;
  },

  async requestPermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    const permission = await Notification.requestPermission();
    return permission === "granted";
  },

  async subscribe(): Promise<PushSubscription | null> {
    if (!this.isSupported()) return null;
    const vapidKey = getVapidPublicKey();
    if (!vapidKey || vapidKey.startsWith("placeholder")) {
      console.warn("[Push] VITE_VAPID_PUBLIC_KEY not configured");
      return null;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return existing;

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      // Save subscription to backend (include JWT for auth)
      const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
      try {
        const { supabase } = await import("@/lib/supabase");
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) {
          authHeaders["Authorization"] = `Bearer ${data.session.access_token}`;
        }
      } catch { /* no session */ }

      await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ subscription }),
      }).catch(() => {});

      return subscription;
    } catch (err) {
      console.warn("[Push] Subscribe failed:", err);
      return null;
    }
  },

  async unsubscribe(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
        try {
          const { supabase } = await import("@/lib/supabase");
          const { data } = await supabase.auth.getSession();
          if (data.session?.access_token) {
            authHeaders["Authorization"] = `Bearer ${data.session.access_token}`;
          }
        } catch { /* no session */ }

        await fetch("/api/notifications/subscribe", {
          method: "DELETE",
          headers: authHeaders,
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      console.warn("[Push] Unsubscribe failed:", err);
      return false;
    }
  },

  /**
   * Show a local notification immediately (no server needed).
   * Useful for analysis completion events.
   */
  async showLocal(title: string, body: string, icon = "/pwa-192x192.png", url = "/"): Promise<void> {
    if (!this.isSupported()) return;
    if (Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body,
        icon,
        badge: "/pwa-64x64.png",
        vibrate: [200, 100, 200],
        data: { url },
      });
    } catch {
      // Fallback to browser notification
      new Notification(title, { body, icon });
    }
  },

  // (Sin notifySessionAnalysisReady: no tenía llamadores y llevaba a la pestaña «Sesión»
  //  del panel del entrenador, que pintaba datos de ejemplo y queda oculto hasta P2 —
  //  P1 bloque 5c. Al conectar las sesiones reales se vuelve a añadir.)
};
