/**
 * VITAS · Consentimiento parental de un menor — fuente canónica ÚNICA (invariante #7)
 *
 * Qué cuenta como «consentimiento parental concedido» para un jugador menor de 14
 * CONOCIDO (regla de la 036): una fila de public.parental_consents que el TUTOR firmó y
 * confirmó desde su email, y que el entrenador no puede crear ni cambiar. En concreto,
 * las TRES cosas a la vez:
 *   1. la fila: player_id = el jugador, email_verified = true, withdrawn_at IS NULL
 *      (predicado del índice idx_consents_active, 003:43);
 *   2. la EVIDENCIA del servidor: una fila de public.gdpr_audit_log con
 *      action = 'consent_email_verified', resource_type = 'parental_consents',
 *      resource_id = el id de esa fila y metadata.player_id = el jugador. La escribe SOLO
 *      api/auth/verify-consent.ts (service_role) cuando llega el token del email del tutor;
 *   3. ninguna fila 'consent_withdrawn' para ese consentimiento (la escribe el trigger
 *      audit_consent_changes de la 003 al retirarlo).
 *
 * Por qué la evidencia (hallazgo B6 de la review del PR #308, VERIFICADO en producción por
 * la comprobación previa del dueño del 9 oct: auth_can_update_consents = true): un
 * `authenticated` puede hacer UPDATE en parental_consents (política 003
 * consent_tenant_isolation, FOR ALL, si su JWT trae el tenant de la fila; la 076 la retira
 * y la 075 retira además los permisos, pero ninguna de las dos consta aplicada). Con ese
 * UPDATE un entrenador pondría email_verified = true en una fila pendiente, o reapuntaría
 * el player_id de una fila verificada a otro jugador. Ninguna de esas dos cosas crea la
 * evidencia: gdpr_audit_log no admite INSERT de `authenticated` desde la 072 (aplicada en
 * producción, VERIFICADO; la comprobación previa del PR lo mide: auth_can_insert_audit) y
 * el trigger de la 003 solo audita el INSERT y la retirada. Así el código NO depende de que
 * la 075 esté aplicada: ni deja entrar una fila falsificada antes, ni bloquea a nadie con
 * un consentimiento verificado de verdad después.
 *
 * players.parental_consent_status NUNCA cuenta: lo pone el propio entrenador desde
 * /admin/consent (ParentalConsentPage) sin ninguna verificación del tutor.
 *
 * Límite que NO cierra este módulo (documentado en docs/pendientes-metricas.md §E): la
 * verificación por email prueba que alguien controla ESE buzón, no que sea el tutor. Un
 * entrenador que escriba un email suyo como «email del tutor» recibe el enlace él mismo.
 *
 * Sin `node:*` → vale para Edge y Node. Lee con service_role (REST).
 */

import { sha256Hex } from "./edgeCrypto";
import { serviceHeaders, supabaseRestUrl } from "./supabaseRest";

/** Acción de la evidencia que escribe api/auth/verify-consent.ts (y nadie más). */
export const CONSENT_VERIFIED_ACTION = "consent_email_verified" as const;
/** Acción que escribe el trigger audit_consent_changes (003) al retirar un consentimiento. */
export const CONSENT_WITHDRAWN_ACTION = "consent_withdrawn" as const;
/** resource_type de esas filas de gdpr_audit_log. */
export const CONSENT_RESOURCE_TYPE = "parental_consents" as const;

/**
 * El token del email se guarda HASHEADO (sha256) con este prefijo: quien pueda leer la
 * fila (p. ej. un `authenticated` antes de la 075/076) no puede verificar el consentimiento
 * él mismo con el token. El prefijo distingue los tokens antiguos en claro (la comprobación
 * previa de la 075 los cuenta: esos enlaces dejan de funcionar).
 */
export const CONSENT_TOKEN_HASH_PREFIX = "sha256:" as const;

/** Lo que se guarda en parental_consents.verification_token para un token del email. */
export async function hashConsentToken(rawToken: string): Promise<string> {
  return `${CONSENT_TOKEN_HASH_PREFIX}${await sha256Hex(rawToken)}`;
}

/** Fallo de la base al comprobar el consentimiento: quien llama falla CERRADO. */
export class ParentalConsentDbError extends Error {}

export interface ActiveParentalConsent {
  /** parental_consents.id */
  id: string;
  /** parental_consents.parent_email (para el email al tutor; null si no viene). */
  parentEmail: string | null;
}

/** Tope de filas por consulta: si se alcanza no se ven todas → falla cerrado. */
const MAX_ROWS = 50;

async function getRows<T>(path: string): Promise<T[]> {
  let url: string;
  let headers: Record<string, string>;
  try {
    url = `${supabaseRestUrl()}/rest/v1/${path}`;
    headers = serviceHeaders();
  } catch {
    throw new ParentalConsentDbError("supabase_not_configured");
  }
  const res = await fetch(url, { headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ParentalConsentDbError(`${res.status} ${text.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ParentalConsentDbError("invalid_json");
  }
  if (!Array.isArray(parsed)) throw new ParentalConsentDbError("not_an_array");
  if (parsed.length >= MAX_ROWS) throw new ParentalConsentDbError("too_many_rows");
  return parsed as T[];
}

/** Lista PostgREST `("a","b")` con comillas y escapes (mismo formato que analysisConsentGate). */
function pgInList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

function metadataPlayerId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).player_id;
  return typeof v === "string" ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Escribe la EVIDENCIA de que el tutor verificó el consentimiento con el token de su email
 * (append-only, service_role). La llama SOLO api/auth/verify-consent.ts, ANTES de marcar la
 * fila como verificada: si no se puede escribir, la fila no se marca y el token sigue
 * valiendo para reintentar. Lanza ParentalConsentDbError si falla.
 */
export async function recordParentalConsentVerified(input: {
  consentId: string;
  playerId: string;
  tenantId: string | null;
}): Promise<void> {
  let url: string;
  let headers: Record<string, string>;
  try {
    url = `${supabaseRestUrl()}/rest/v1/gdpr_audit_log`;
    headers = serviceHeaders({ Prefer: "return=minimal" });
  } catch {
    throw new ParentalConsentDbError("supabase_not_configured");
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: null, // la acción es del tutor (sin cuenta), no de un usuario de VITAS
      tenant_id: input.tenantId && UUID_RE.test(input.tenantId) ? input.tenantId : null,
      action: CONSENT_VERIFIED_ACTION,
      resource_type: CONSENT_RESOURCE_TYPE,
      resource_id: input.consentId,
      metadata: { player_id: input.playerId },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ParentalConsentDbError(`insert ${res.status} ${text.slice(0, 300)}`);
  }
}

/**
 * El consentimiento parental VIGENTE del jugador según la regla de arriba (el más reciente
 * por signed_at), o null si no hay ninguno que cuente. Lanza ParentalConsentDbError si no
 * se puede comprobar (sin Supabase, error de la base, respuesta rara o demasiadas filas):
 * el llamador NUNCA lo interpreta como «concedido».
 */
export async function findActiveParentalConsent(playerId: string): Promise<ActiveParentalConsent | null> {
  const rows = await getRows<{ id: unknown; player_id: unknown; parent_email: unknown }>(
    `parental_consents?player_id=eq.${encodeURIComponent(playerId)}` +
      `&email_verified=is.true&withdrawn_at=is.null` +
      `&select=id,player_id,parent_email&order=signed_at.desc&limit=${MAX_ROWS}`,
  );
  const candidates = rows.filter(
    (r): r is { id: string; player_id: string; parent_email: unknown } =>
      typeof r?.id === "string" && r.id !== "" && r.player_id === playerId,
  );
  if (candidates.length === 0) return null;

  const audit = await getRows<{ action: unknown; resource_id: unknown; metadata: unknown }>(
    `gdpr_audit_log?action=in.${encodeURIComponent(pgInList([CONSENT_VERIFIED_ACTION, CONSENT_WITHDRAWN_ACTION]))}` +
      `&resource_type=eq.${CONSENT_RESOURCE_TYPE}` +
      `&resource_id=in.${encodeURIComponent(pgInList(candidates.map((c) => c.id)))}` +
      `&select=action,resource_id,metadata&limit=${MAX_ROWS}`,
  );
  const withdrawn = new Set(
    audit.filter((a) => a?.action === CONSENT_WITHDRAWN_ACTION && typeof a.resource_id === "string").map((a) => a.resource_id as string),
  );
  const verified = new Set(
    audit
      .filter(
        (a) =>
          a?.action === CONSENT_VERIFIED_ACTION &&
          typeof a.resource_id === "string" &&
          metadataPlayerId(a.metadata) === playerId,
      )
      .map((a) => a.resource_id as string),
  );

  const found = candidates.find((c) => verified.has(c.id) && !withdrawn.has(c.id));
  if (!found) return null;
  return { id: found.id, parentEmail: typeof found.parent_email === "string" ? found.parent_email : null };
}
