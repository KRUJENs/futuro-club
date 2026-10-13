/**
 * VITAS · Consentimiento del TUTOR de un menor de 14 (RGPD art. 8 · LOPDGDD art. 7)
 *
 * El único consentimiento que cuenta es el que el TUTOR confirma desde el enlace de su correo
 * (servidor: api/_lib/parentalConsent.ts). Desde el P1 bloque 3 el navegador:
 *   - consulta el estado REAL en el servidor (fetchConsentStatus → /api/auth/consent-status);
 *     antes leía players.parental_consent_status, un rótulo que el propio entrenador ponía en
 *     «concedido» sin el tutor (y que el gate de análisis nunca miró);
 *   - pide la firma al tutor (requestGuardianSignature → /api/auth/sign-consent): solo nombre y
 *     email del tutor; el DNI y la aceptación los pone el TUTOR al confirmar;
 *   - retira (withdrawConsentOnServer → /api/auth/withdraw-consent).
 * Nada de esto se puede «conceder» desde el navegador.
 *
 * Usado por: GuardianConsentCard (ficha del jugador y vista de familia) y /admin/consent.
 */

// El singleton de i18next (lo inicializa src/i18n): solo se lee el idioma actual, sin arrastrar
// la configuración de la app (ni react-i18next) a quien importe este servicio.
import i18next from "i18next";
import { getAuthHeaders } from "@/lib/apiAuth";

export type GuardianConsentState =
  | "verified" //    el tutor confirmó: cuenta para analizar sus vídeos
  | "pending" //     firma pedida, el tutor aún no ha confirmado
  | "expired" //     el enlace caducó sin confirmar
  | "withdrawn" //   retirado (por el tutor o por el responsable)
  | "none" //        nunca se pidió
  | "unavailable"; // no se pudo comprobar (nunca se trata como «verificado»)

export interface GuardianConsentStatus {
  state: GuardianConsentState;
  guardianName?: string | null;
  guardianEmail?: string | null;
  requestedAt?: string | null;
  expiresAt?: string | null;
  verifiedAt?: string | null;
  withdrawnAt?: string | null;
}

/** Error con el `code` del servidor (birth_date_required, consent_not_required, tenant_missing…). */
export class ConsentRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type ApiJson<T> = { success?: boolean; data?: T; error?: string; errorDetail?: { code?: string; message?: string } } | null;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: await getAuthHeaders(), body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as ApiJson<T>;
  if (!res.ok || !json?.success || json.data === undefined || json.data === null) {
    throw new ConsentRequestError(json?.errorDetail?.code ?? `http_${res.status}`, json?.errorDetail?.message ?? "request_failed");
  }
  return json.data;
}

/**
 * Estado del consentimiento del tutor de estos jugadores (solo los que son del usuario). Si
 * el servidor no responde, cada jugador queda «unavailable» (nunca «verificado»). Un jugador que
 * el servidor no devuelve (p. ej. aún no sincronizado, o que no es del usuario) también queda
 * «unavailable»: antes la tarjeta se quedaba cargando para siempre (revisión del PR #314).
 */
export async function fetchConsentStatus(playerIds: string[]): Promise<Record<string, GuardianConsentStatus>> {
  const ids = Array.from(new Set(playerIds.filter(Boolean))).slice(0, 50);
  if (ids.length === 0) return {};
  const unavailable = { state: "unavailable" as const };
  try {
    const data = await postJson<{ statuses?: Record<string, GuardianConsentStatus> }>("/api/auth/consent-status", { playerIds: ids });
    const got = data.statuses ?? {};
    return Object.fromEntries(ids.map((id) => [id, got[id] ?? unavailable]));
  } catch {
    return Object.fromEntries(ids.map((id) => [id, unavailable]));
  }
}

/**
 * Pide la firma al tutor: el servidor le manda el correo (en el idioma actual) con el enlace
 * para confirmar. Una solicitud nueva invalida la anterior pendiente. Lanza ConsentRequestError.
 */
export async function requestGuardianSignature(input: {
  playerId: string;
  guardianName: string;
  guardianEmail: string;
}): Promise<{ emailSent: boolean; expiresAt?: string }> {
  return postJson("/api/auth/sign-consent", {
    playerId: input.playerId,
    parentName: input.guardianName.trim(),
    parentEmail: input.guardianEmail.trim(),
    locale: i18next.language,
  });
}

/**
 * Retira en el SERVIDOR los consentimientos parentales activos del jugador
 * (POST /api/auth/withdraw-consent; solo el dueño del jugador). Lanza si el servidor no confirma
 * la retirada → la UI NO debe mostrar «retirado» en ese caso. Devuelve cuántos se retiraron.
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
