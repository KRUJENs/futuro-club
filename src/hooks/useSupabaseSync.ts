/**
 * VITAS — useSupabaseSync
 *
 * Sincronización bidireccional con Supabase:
 *   - Pull delta al login (solo registros nuevos/modificados)
 *   - Push inmediato si hay red, encolado si offline
 *   - Procesamiento de cola offline al reconectar
 *   - Estado de sync expuesto para UI
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { SupabasePlayerService } from "@/services/real/supabasePlayerService";
import { SupabaseVideoService } from "@/services/real/supabaseVideoService";
import { SubscriptionService } from "@/services/real/subscriptionService";
import { UserProfileService } from "@/services/real/userProfileService";
import { SyncQueueService } from "@/services/real/syncQueueService";

// ─── Tipos exportados ────────────────────────────────────────────────────────

export interface SyncState {
  syncing:  boolean;
  pending:  number;
  online:   boolean;
  lastSync: string | null;
  error:    string | null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSupabaseSync() {
  const { user, configured } = useAuth();
  const qc = useQueryClient();
  const syncedRef = useRef<string | null>(null);
  const prevUserRef = useRef<string | null>(null);

  const [syncState, setSyncState] = useState<SyncState>({
    syncing: false,
    pending: SyncQueueService.pendingCount(user?.id ?? null),
    online:  navigator.onLine,
    lastSync: null,
    error: null,
  });

  // Invalidar queries relevantes
  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["players-all"] });
    qc.invalidateQueries({ queryKey: ["ranked-players"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["videos"] });
    if (user) {
      qc.invalidateQueries({ queryKey: ["subscription", user.id] });
      qc.invalidateQueries({ queryKey: ["user-profile", user.id] });
      qc.invalidateQueries({ queryKey: ["usage-analytics", user.id] });
    }
  }, [qc, user]);

  // ── Procesar cola offline con backoff exponencial ───────────────────
  const processQueue = useCallback(async () => {
    if (!user || !configured) return;

    // Solo las ops de ESTA cuenta: las de otra cuenta del dispositivo se quedan a
    // su nombre (subirlas aquí escribiría sus cambios en esta cuenta).
    const queue = SyncQueueService.getQueueFor(user.id);
    if (queue.length === 0) return;

    let processed = 0;
    let failed = 0;

    for (const item of queue) {
      // Backoff exponencial: esperar según retries previos (0s, 1s, 2s, 4s, 8s)
      if (item.retries > 0) {
        const delay = Math.min(1000 * Math.pow(2, item.retries - 1), 8000);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        if (item.entity === "player") {
          if (item.action === "delete") {
            await SupabasePlayerService.deleteOne(user.id, item.entityId);
          } else {
            await SupabasePlayerService.pushOne(user.id, item.data as Parameters<typeof SupabasePlayerService.pushOne>[1]);
          }
        } else if (item.entity === "video") {
          if (item.action === "delete") {
            await SupabaseVideoService.deleteOne(user.id, item.entityId);
          } else {
            await SupabaseVideoService.pushOne(user.id, item.data as Parameters<typeof SupabaseVideoService.pushOne>[1]);
          }
        }
        SyncQueueService.dequeue(item.id);
        processed++;
      } catch (err) {
        console.warn(`[Sync] Failed to process ${item.action} ${item.entity}/${item.entityId}:`, err);
        SyncQueueService.incrementRetry(item.id);
        failed++;
      }
    }

    // Limpiar items con demasiados reintentos
    const pruned = SyncQueueService.pruneStale();

    const remaining = SyncQueueService.pendingCount(user.id);
    setSyncState(s => ({ ...s, pending: remaining }));

    // Log resultado para auditoría
    if (processed > 0 || failed > 0 || pruned > 0) {
      console.info(`[Sync] Queue processed: ${processed} ok, ${failed} failed, ${pruned} pruned, ${remaining} pending`);
    }

    return { processed, failed, remaining };
  }, [user, configured]);

  // ── Pull on login (con delta sync) ─────────────────────────────────
  useEffect(() => {
    if (!configured) return;

    if (!user) {
      if (prevUserRef.current !== null) {
        syncedRef.current = null;
        prevUserRef.current = null;
      }
      return;
    }

    prevUserRef.current = user.id;
    if (syncedRef.current === user.id) return;
    syncedRef.current = user.id;

    setSyncState(s => ({ ...s, syncing: true, error: null }));

    Promise.all([
      SupabasePlayerService.pullAll(user.id),
      SupabaseVideoService.pullAll(user.id),
      SubscriptionService.syncFromSupabase(user.id),
      UserProfileService.syncFromSupabase(user.id),
      SubscriptionService.syncAnalysesFromSupabase(user.id),
    ]).then(async () => {
      // Purge mock/fake players AFTER sync to prevent cloud data restoring them
      const { PlayerService } = await import("@/services/real/playerService");
      const { purgedIds } = PlayerService.purgeMockPlayers();
      // Also delete purged fakes from Supabase so they don't come back
      for (const fakeId of purgedIds) {
        SupabasePlayerService.deleteOne(user.id, fakeId).catch(() => {});
      }

      const now = new Date().toISOString();
      SyncQueueService.setTimestamp("player", now);
      SyncQueueService.setTimestamp("video", now);

      invalidateAll();

      setSyncState(s => ({
        ...s,
        syncing: false,
        lastSync: now,
        pending: SyncQueueService.pendingCount(user.id),
      }));

      // Procesar cola offline acumulada
      processQueue();
    }).catch((err) => {
      setSyncState(s => ({
        ...s,
        syncing: false,
        error: err instanceof Error ? err.message : "Error de sincronización",
      }));
    });
  }, [user, configured, invalidateAll, processQueue]);

  // ── Push on reconnect (offline → online) ───────────────────────────
  useEffect(() => {
    if (!configured) return;

    const handleOnline = () => {
      setSyncState(s => ({ ...s, online: true }));

      if (!user) return;

      setSyncState(s => ({ ...s, syncing: true }));

      // Primero procesar cola offline, luego push todo
      processQueue().then(() => {
        return Promise.all([
          SupabasePlayerService.pushAll(user.id),
          SupabaseVideoService.pushAll(user.id),
        ]);
      }).then(() => {
        invalidateAll();
        setSyncState(s => ({
          ...s,
          syncing: false,
          lastSync: new Date().toISOString(),
          pending: SyncQueueService.pendingCount(user.id),
        }));
      }).catch((err) => {
        console.warn("[Sync] Reconnect push failed:", err);
        setSyncState(s => ({ ...s, syncing: false, error: "Error al sincronizar al reconectar" }));
      });
    };

    const handleOffline = () => {
      setSyncState(s => ({ ...s, online: false }));
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [user, configured, invalidateAll, processQueue]);

  return syncState;
}
