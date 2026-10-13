/**
 * VITAS · Parental Consent Service (RGPD)
 *
 * Spanish RGPD requires parental consent for players under 14. This
 * service tracks the consent workflow:
 *   - pending  → awaiting parent action
 *   - granted  → parent approved
 *   - denied   → parent denied (player data must be removed/anonymized)
 *   - not_required → player ≥14 (automated)
 *
 * Used by:
 *   - /admin/consent — workflow management UI
 *   - /family/:playerId — parent self-service
 *   - PlayerHub — shows consent badge
 *
 * Migration 036 adds 4 columns to `players` table:
 *   parental_consent_status, parental_consent_granted_at,
 *   parental_consent_guardian_name, parental_consent_guardian_email
 */

import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getAuthHeaders } from "@/lib/apiAuth";

const STORAGE_KEY = "vitas_parental_consents";

/**
 * Retira en el SERVIDOR los consentimientos parentales activos del jugador
 * (POST /api/auth/withdraw-consent; solo el dueño del jugador). Es lo único que hace que una
 * revocación cuente: players.parental_consent_status es solo un rótulo de la pantalla y el gate
 * de análisis no lo mira. Lanza si el servidor no confirma la retirada → la UI NO debe mostrar
 * «revocado» en ese caso. Devuelve cuántos consentimientos se retiraron.
 */
export async function withdrawConsentOnServer(playerId: string, reason?: string): Promise<number> {
  const res = await fetch("/api/auth/withdraw-consent", {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify({ playerId, ...(reason ? { reason } : {}) }),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: { withdrawn?: number } } | null;
  if (!res.ok || !json?.success) throw new Error(`withdraw_consent_failed_${res.status}`);
  return json.data?.withdrawn ?? 0;
}

export type ConsentStatus = "pending" | "granted" | "denied" | "not_required";

export interface ParentalConsent {
  playerId: string;
  playerName?: string;
  playerAge?: number;
  status: ConsentStatus;
  grantedAt?: string;
  guardianName?: string;
  guardianEmail?: string;
  /** Optional: token for the email-based consent form */
  consentToken?: string;
  /** When the latest reminder was sent to the guardian */
  lastReminderAt?: string;
}

interface DbPlayerRow {
  id: string;
  name: string;
  age?: number;
  parental_consent_status?: ConsentStatus;
  parental_consent_granted_at?: string;
  parental_consent_guardian_name?: string;
  parental_consent_guardian_email?: string;
}

// ── Cache helpers ────────────────────────────────────────────────────
function readCache(): ParentalConsent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ParentalConsent[]) : [];
  } catch {
    return [];
  }
}

function writeCache(items: ParentalConsent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 500)));
  } catch (err) {
    console.error("[parentalConsentService] cache write failed", err);
  }
}

function inferStatusFromAge(age?: number): ConsentStatus {
  if (age === undefined || age === null) return "pending";
  return age >= 14 ? "not_required" : "pending";
}

// ── Service ───────────────────────────────────────────────────────────
export const ParentalConsentService = {
  /** Get consent state for a specific player */
  async getForPlayer(playerId: string): Promise<ParentalConsent | null> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, name, age, parental_consent_status, parental_consent_granted_at, parental_consent_guardian_name, parental_consent_guardian_email",
          )
          .eq("id", playerId)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          const row = data as DbPlayerRow;
          return {
            playerId: row.id,
            playerName: row.name,
            playerAge: row.age,
            status: row.parental_consent_status ?? inferStatusFromAge(row.age),
            grantedAt: row.parental_consent_granted_at,
            guardianName: row.parental_consent_guardian_name,
            guardianEmail: row.parental_consent_guardian_email,
          };
        }
      } catch (err) {
        console.warn("[parentalConsentService] get failed:", err);
      }
    }
    return readCache().find((c) => c.playerId === playerId) ?? null;
  },

  /** Returns all players with their consent state (for /admin/consent dashboard) */
  async listAll(): Promise<ParentalConsent[]> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, name, age, parental_consent_status, parental_consent_granted_at, parental_consent_guardian_name, parental_consent_guardian_email",
          )
          .order("name");
        if (error) throw error;
        if (data) {
          return (data as DbPlayerRow[]).map((row) => ({
            playerId: row.id,
            playerName: row.name,
            playerAge: row.age,
            status: row.parental_consent_status ?? inferStatusFromAge(row.age),
            grantedAt: row.parental_consent_granted_at,
            guardianName: row.parental_consent_guardian_name,
            guardianEmail: row.parental_consent_guardian_email,
          }));
        }
      } catch (err) {
        console.warn("[parentalConsentService] list failed:", err);
      }
    }
    return readCache();
  },

  /** Returns only consents that need attention (pending under 14yo) */
  async listPending(): Promise<ParentalConsent[]> {
    const all = await this.listAll();
    return all.filter((c) => c.status === "pending");
  },

  /** Grant consent — typically called from /family by the guardian */
  async grant(
    playerId: string,
    guardianName: string,
    guardianEmail: string,
  ): Promise<ParentalConsent> {
    const updated: ParentalConsent = {
      playerId,
      status: "granted",
      grantedAt: new Date().toISOString(),
      guardianName,
      guardianEmail,
    };

    const all = readCache().filter((c) => c.playerId !== playerId);
    all.unshift(updated);
    writeCache(all);

    if (SUPABASE_CONFIGURED) {
      try {
        await supabase
          .from("players")
          .update({
            parental_consent_status: "granted",
            parental_consent_granted_at: updated.grantedAt,
            parental_consent_guardian_name: guardianName,
            parental_consent_guardian_email: guardianEmail,
          })
          .eq("id", playerId);
      } catch (err) {
        console.warn("[parentalConsentService] grant failed:", err);
      }
    }
    return updated;
  },

  /**
   * Deny consent — must trigger data removal/anonymization per RGPD.
   * Con Supabase, la retirada se hace PRIMERO en el servidor (withdrawConsentOnServer); si
   * falla, lanza y no se marca nada como denegado.
   */
  async deny(playerId: string, guardianName?: string): Promise<ParentalConsent> {
    if (SUPABASE_CONFIGURED) await withdrawConsentOnServer(playerId);

    const updated: ParentalConsent = {
      playerId,
      status: "denied",
      guardianName,
    };

    const all = readCache().filter((c) => c.playerId !== playerId);
    all.unshift(updated);
    writeCache(all);

    if (SUPABASE_CONFIGURED) {
      try {
        await supabase
          .from("players")
          .update({
            parental_consent_status: "denied",
            parental_consent_guardian_name: guardianName,
          })
          .eq("id", playerId);
      } catch (err) {
        console.warn("[parentalConsentService] deny failed:", err);
      }
    }
    return updated;
  },

  /** Send a reminder email to the guardian (server-side via Edge Function) */
  async sendReminder(playerId: string): Promise<{ ok: boolean; reason?: string }> {
    // Best-effort: only works once the edge function api/consent/_send-reminder is in place
    try {
      const resp = await fetch("/api/consent/_send-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      if (resp.ok) {
        const all = readCache();
        const idx = all.findIndex((c) => c.playerId === playerId);
        if (idx >= 0) {
          all[idx] = { ...all[idx], lastReminderAt: new Date().toISOString() };
          writeCache(all);
        }
        return { ok: true };
      }
      if (resp.status === 503) return { ok: false, reason: "email_service_not_configured" };
      return { ok: false, reason: `http_${resp.status}` };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  },

  /** Stats for the dashboard widget */
  async getStats(): Promise<{
    total: number;
    pending: number;
    granted: number;
    denied: number;
    notRequired: number;
  }> {
    const all = await this.listAll();
    const stats = {
      total: all.length,
      pending: 0,
      granted: 0,
      denied: 0,
      notRequired: 0,
    };
    for (const c of all) {
      if (c.status === "pending") stats.pending++;
      else if (c.status === "granted") stats.granted++;
      else if (c.status === "denied") stats.denied++;
      else if (c.status === "not_required") stats.notRequired++;
    }
    return stats;
  },
};
