/**
 * VITAS · Consentimiento parental de un menor — fuente canónica ÚNICA (invariante #7)
 *
 * Qué cuenta como «consentimiento parental concedido» para un jugador menor de 14
 * CONOCIDO (regla de la 036): una fila de public.parental_consents que el TUTOR firmó y
 * confirmó desde su email, ligada por el SERVIDOR al jugador y al email del tutor en el
 * momento de emitir el enlace. En concreto, TODO esto a la vez:
 *   1. la fila: player_id = el jugador, email_verified = true, withdrawn_at IS NULL
 *      (predicado del índice idx_consents_active, 003:43);
 *   2. la EMISIÓN del enlace: una fila de public.gdpr_audit_log con
 *      action = 'consent_token_issued', resource_type = 'parental_consents',
 *      resource_id = el id de esa fila y metadata = { player_id = el jugador, parent_email,
 *      token_hash, expires_at }. La escribe SOLO api/auth/sign-consent.ts (service_role), ANTES
 *      de crear la fila, después de comprobar que quien firma es el DUEÑO del jugador;
 *   3. la VERIFICACIÓN: una fila de gdpr_audit_log con action = 'consent_email_verified',
 *      el mismo resource_id, metadata.player_id = el jugador y metadata.token_hash = el de la
 *      emisión. La escribe SOLO api/auth/verify-consent.ts (service_role) cuando llega el token
 *      del email del tutor, y la busca por el hash de ESE token en la emisión, nunca en la fila;
 *   4. ninguna fila 'consent_withdrawn' para ese consentimiento (la escribe el trigger
 *      audit_consent_changes de la 003 al retirarlo).
 * El email del tutor que se devuelve (el orquestador le manda el resultado) es el de la
 * emisión, no el de la fila.
 *
 * Por qué (hallazgo B6 de la review del PR #308). Antes de la 075/076, un `authenticated`
 * puede hacer UPDATE en parental_consents (política 003 consent_tenant_isolation, FOR ALL, si
 * su JWT trae el tenant de la fila; la 076 la retira y la 075 retira además los permisos;
 * que alguna de las dos esté aplicada en producción NO está verificado). La ronda 4 añadió la
 * evidencia de verificación, pero verify-consent buscaba la fila por
 * `parental_consents.verification_token` y escribía la evidencia con el `player_id` de la
 * propia fila, dos columnas que ese UPDATE puede cambiar. Ronda 5 (revisor, SIMULACIÓN PGlite,
 * no la base real): con UPDATE del hash del token a sha256(X) + caducidad, y POST público
 * /api/auth/verify-consent {token: X}, el SERVIDOR escribía la evidencia para un menor ajeno
 * (o para otro menor tras reapuntar una fila propia con un email elegido por el atacante), y
 * la regla de la ronda 4 lo contaba. La frase de la ronda 4 «el código NO depende de que la
 * 075 esté aplicada» era FALSA. Desde la ronda 5 el token, el jugador y el email del tutor
 * salen de la emisión que escribe el servidor (2), que un cliente no puede escribir ni cambiar:
 * gdpr_audit_log no admite INSERT/UPDATE/DELETE de `authenticated` desde la 072 (aplicada en
 * producción según la lista verificada del 29-30 sep; la comprobación previa del PR lo mide:
 * auth_can_insert_audit / auth_can_update_audit) y los triggers de la 003 solo escriben
 * 'consent_signed' y 'consent_withdrawn'. Así, ni un UPDATE de la fila ni un token elegido
 * por el cliente crean un consentimiento que cuente, con o sin la 075.
 *
 * Una verificación anterior a este cambio (sin emisión) deja de contar: el tutor tiene que
 * firmar de nuevo. Con el dato verificado del 29-30 sep (ningún jugador de producción tiene
 * fecha de nacimiento) eso no bloquea hoy a nadie; cuántas hay: supabase/checks/075_previa.sql.
 *
 * players.parental_consent_status NUNCA cuenta: lo pone el propio entrenador desde
 * /admin/consent (ParentalConsentPage) sin ninguna verificación del tutor, y lo puede volver a
 * poner en 'granted' cuando quiera (ronda 6: por eso NO sirve ni para quitar). La retirada se
 * guarda en el consentimiento mismo: withdrawParentalConsents (abajo).
 *
 * Límite que NO cierra este módulo (documentado en docs/pendientes-metricas.md §E): la
 * verificación por email prueba que alguien controla ESE buzón, no que sea el tutor. Un
 * entrenador que escriba un email suyo como «email del tutor» recibe el enlace él mismo.
 *
 * Sin `node:*` → vale para Edge y Node. Lee y escribe con service_role (REST).
 */

import { sha256Hex } from "./edgeCrypto";
import { serviceHeaders, supabaseRestUrl } from "./supabaseRest";

/** Acción de la EMISIÓN del enlace que escribe api/auth/sign-consent.ts (y nadie más). */
export const CONSENT_TOKEN_ISSUED_ACTION = "consent_token_issued" as const;
/** Acción de la evidencia que escribe api/auth/verify-consent.ts (y nadie más). */
export const CONSENT_VERIFIED_ACTION = "consent_email_verified" as const;
/** Acción que escribe el trigger audit_consent_changes (003) al retirar un consentimiento. */
export const CONSENT_WITHDRAWN_ACTION = "consent_withdrawn" as const;
/**
 * EMISIÓN del enlace de RETIRADA que recibe el tutor al confirmar (P1 bloque 3). La escribe SOLO
 * api/auth/verify-consent.ts. Acción distinta de la del enlace de verificación: un token de
 * retirada nunca verifica, y uno de verificación nunca retira.
 */
export const CONSENT_WITHDRAW_TOKEN_ISSUED_ACTION = "consent_withdraw_token_issued" as const;
/** resource_type de esas filas de gdpr_audit_log. */
export const CONSENT_RESOURCE_TYPE = "parental_consents" as const;

/**
 * El token del email se guarda HASHEADO (sha256) con este prefijo, en la emisión y en la fila:
 * quien pueda leerlas no puede verificar el consentimiento él mismo con el token. El prefijo
 * distingue los tokens antiguos en claro (la comprobación previa de la 075 los cuenta: esos
 * enlaces dejan de funcionar).
 */
export const CONSENT_TOKEN_HASH_PREFIX = "sha256:" as const;

/** Lo que se guarda (emisión y fila) para un token del email. */
export async function hashConsentToken(rawToken: string): Promise<string> {
  return `${CONSENT_TOKEN_HASH_PREFIX}${await sha256Hex(rawToken)}`;
}

/** Fallo de la base al comprobar o registrar el consentimiento: quien llama falla CERRADO. */
export class ParentalConsentDbError extends Error {}

export interface ActiveParentalConsent {
  /** parental_consents.id */
  id: string;
  /** Email del tutor que ligó el SERVIDOR al emitir el enlace (no el de la fila, que es mutable). */
  parentEmail: string | null;
}

/** Lo que el servidor ligó al emitir el enlace del email (fila 'consent_token_issued'). */
export interface IssuedConsentToken {
  /** parental_consents.id al que se emitió el enlace. */
  consentId: string;
  /** Jugador cuyo dueño firmó (sign-consent comprueba la propiedad). */
  playerId: string;
  /** Email del tutor (minúsculas) al que se mandó el enlace. */
  parentEmail: string;
  /** hashConsentToken(token del email). */
  tokenHash: string;
  /** Caducidad del enlace (ISO), la del servidor. */
  expiresAt: string;
  /** tenant del jugador al firmar (solo para el registro de auditoría). */
  tenantId: string | null;
  /** Idioma en que se escribió al tutor (el del correo de confirmación); null si no consta. */
  locale: string | null;
}

/** Lo que el TUTOR aporta al confirmar (P1 bloque 3): su DNI (hasheado) y sus aceptaciones. */
export interface GuardianConfirmation {
  /** sha256 del DNI del tutor en mayúsculas (nunca en claro). */
  dniHash: string;
  /** Versión de las condiciones y de la política de privacidad que aceptó el tutor. */
  consentVersion: string;
}

/** Lo que ligó el servidor al emitir un enlace de RETIRADA (fila 'consent_withdraw_token_issued'). */
export interface IssuedWithdrawToken {
  consentId: string;
  playerId: string;
  parentEmail: string;
  tenantId: string | null;
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

/** INSERT append-only en gdpr_audit_log con service_role. Lanza ParentalConsentDbError si falla. */
async function insertAudit(row: Record<string, unknown>): Promise<void> {
  let url: string;
  let headers: Record<string, string>;
  try {
    url = `${supabaseRestUrl()}/rest/v1/gdpr_audit_log`;
    headers = serviceHeaders({ Prefer: "return=minimal" });
  } catch {
    throw new ParentalConsentDbError("supabase_not_configured");
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ParentalConsentDbError(`insert ${res.status} ${text.slice(0, 300)}`);
  }
}

/** Lista PostgREST `("a","b")` con comillas y escapes (mismo formato que analysisConsentGate). */
function pgInList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

/** metadata[key] si es un string no vacío; null si no. */
function metaString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Solo un uuid va a una columna uuid (un valor raro haría fallar el INSERT). */
function uuidOrNull(v: string | null | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

const isTokenHash = (v: string | null): v is string => v !== null && v.startsWith(CONSENT_TOKEN_HASH_PREFIX);

/**
 * Escribe la EMISIÓN del enlace (append-only, service_role). La llama SOLO
 * api/auth/sign-consent.ts, después de comprobar que quien firma es el dueño del jugador y
 * ANTES de crear la fila: si no se puede escribir, no se crea la fila ni se manda el email.
 * Lanza ParentalConsentDbError si falla.
 */
export async function recordConsentTokenIssued(input: {
  consentId: string;
  playerId: string;
  parentEmail: string;
  tokenHash: string;
  expiresAt: string;
  tenantId: string | null;
  /** Quien firma (JWT verificado); null en una llamada de servicio. */
  userId: string | null;
  /** Idioma del correo al tutor (se reutiliza para el de confirmación). */
  locale?: string | null;
}): Promise<void> {
  if (!UUID_RE.test(input.consentId)) throw new ParentalConsentDbError("consent_id_not_uuid");
  if (!isTokenHash(input.tokenHash)) throw new ParentalConsentDbError("token_not_hashed");
  if (!input.playerId || !input.parentEmail || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new ParentalConsentDbError("incomplete_issue");
  }
  await insertAudit({
    user_id: uuidOrNull(input.userId),
    tenant_id: uuidOrNull(input.tenantId),
    action: CONSENT_TOKEN_ISSUED_ACTION,
    resource_type: CONSENT_RESOURCE_TYPE,
    resource_id: input.consentId,
    metadata: {
      player_id: input.playerId,
      parent_email: input.parentEmail.toLowerCase(),
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      ...(input.locale ? { locale: input.locale } : {}),
    },
  });
}

/**
 * La EMISIÓN cuyo token_hash es `tokenHash`, o null si no hay ninguna (o está incompleta: el
 * enlace no vale). Lanza ParentalConsentDbError si no se puede comprobar o si hay más de una
 * (ambigua: falla cerrado). La usa SOLO api/auth/verify-consent.ts.
 */
export async function findIssuedConsentToken(tokenHash: string): Promise<IssuedConsentToken | null> {
  if (!isTokenHash(tokenHash)) return null;
  const rows = await getRows<{ resource_id: unknown; tenant_id: unknown; metadata: unknown }>(
    `gdpr_audit_log?action=eq.${CONSENT_TOKEN_ISSUED_ACTION}&resource_type=eq.${CONSENT_RESOURCE_TYPE}` +
      `&metadata->>token_hash=eq.${encodeURIComponent(tokenHash)}` +
      `&select=resource_id,tenant_id,metadata&limit=2`,
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new ParentalConsentDbError("ambiguous_token");
  const r = rows[0];
  const consentId = typeof r?.resource_id === "string" && UUID_RE.test(r.resource_id) ? r.resource_id : null;
  const playerId = metaString(r?.metadata, "player_id");
  const parentEmail = metaString(r?.metadata, "parent_email");
  const expiresAt = metaString(r?.metadata, "expires_at");
  if (
    !consentId ||
    !playerId ||
    !parentEmail ||
    !expiresAt ||
    Number.isNaN(Date.parse(expiresAt)) ||
    metaString(r?.metadata, "token_hash") !== tokenHash
  ) {
    console.warn("[parental-consent] emisión del enlace incompleta → el enlace no vale");
    return null;
  }
  return {
    consentId,
    playerId,
    parentEmail,
    tokenHash,
    expiresAt,
    tenantId: typeof r.tenant_id === "string" ? uuidOrNull(r.tenant_id) : null,
    locale: metaString(r?.metadata, "locale"),
  };
}

/**
 * ¿Ya hay una VERIFICACIÓN de esta emisión (mismo consentimiento, jugador y token)? La usa
 * verify-consent para no duplicar la evidencia y para terminar de marcar la fila si un intento
 * anterior escribió la evidencia pero no pudo marcarla. Lanza si no se puede comprobar.
 */
export async function hasConsentVerification(issued: IssuedConsentToken): Promise<boolean> {
  const rows = await getRows<{ metadata: unknown }>(
    `gdpr_audit_log?action=eq.${CONSENT_VERIFIED_ACTION}&resource_type=eq.${CONSENT_RESOURCE_TYPE}` +
      `&resource_id=eq.${encodeURIComponent(issued.consentId)}&select=metadata&limit=${MAX_ROWS}`,
  );
  return rows.some(
    (r) => metaString(r?.metadata, "token_hash") === issued.tokenHash && metaString(r?.metadata, "player_id") === issued.playerId,
  );
}

/**
 * Escribe la VERIFICACIÓN del tutor (append-only, service_role) con lo que ligó la EMISIÓN
 * (jugador, email y hash del token), nunca con lo que diga la fila. La llama SOLO
 * api/auth/verify-consent.ts, ANTES de marcar la fila: si no se puede escribir, la fila no se
 * marca y el enlace sigue valiendo para reintentar. Lanza ParentalConsentDbError si falla.
 */
export async function recordParentalConsentVerified(
  issued: IssuedConsentToken,
  guardian?: GuardianConfirmation,
): Promise<void> {
  await insertAudit({
    user_id: null, // la acción es del tutor (sin cuenta), no de un usuario de VITAS
    tenant_id: uuidOrNull(issued.tenantId),
    action: CONSENT_VERIFIED_ACTION,
    resource_type: CONSENT_RESOURCE_TYPE,
    resource_id: issued.consentId,
    metadata: {
      player_id: issued.playerId,
      parent_email: issued.parentEmail,
      token_hash: issued.tokenHash,
      // P1 bloque 3 (decisión del owner, 14 oct): el DNI y la aceptación de las condiciones y de
      // la privacidad los pone el TUTOR al confirmar, no el entrenador al pedir la firma. La
      // evidencia queda a su nombre aquí (el tutor no tiene cuenta: no va a legal_acceptances).
      ...(guardian
        ? {
            guardian_dni_hash: guardian.dniHash,
            accepted_terms_version: guardian.consentVersion,
            accepted_privacy_version: guardian.consentVersion,
          }
        : {}),
    },
  });
}

/**
 * Escribe la EMISIÓN del enlace de RETIRADA para el tutor (append-only, service_role). La llama
 * SOLO api/auth/verify-consent.ts, después de verificar. Lanza ParentalConsentDbError si falla.
 */
export async function recordConsentWithdrawTokenIssued(input: {
  consentId: string;
  playerId: string;
  parentEmail: string;
  tokenHash: string;
  tenantId: string | null;
}): Promise<void> {
  if (!UUID_RE.test(input.consentId)) throw new ParentalConsentDbError("consent_id_not_uuid");
  if (!isTokenHash(input.tokenHash)) throw new ParentalConsentDbError("token_not_hashed");
  if (!input.playerId || !input.parentEmail) throw new ParentalConsentDbError("incomplete_issue");
  await insertAudit({
    user_id: null,
    tenant_id: uuidOrNull(input.tenantId),
    action: CONSENT_WITHDRAW_TOKEN_ISSUED_ACTION,
    resource_type: CONSENT_RESOURCE_TYPE,
    resource_id: input.consentId,
    metadata: {
      player_id: input.playerId,
      parent_email: input.parentEmail.toLowerCase(),
      token_hash: input.tokenHash,
    },
  });
}

/**
 * La EMISIÓN de retirada cuyo token_hash es `tokenHash`, o null si no hay ninguna (o está
 * incompleta). Lanza si no se puede comprobar o si es ambigua. La usa SOLO
 * api/auth/_guardian-withdraw.ts.
 */
export async function findConsentWithdrawToken(tokenHash: string): Promise<IssuedWithdrawToken | null> {
  if (!isTokenHash(tokenHash)) return null;
  const rows = await getRows<{ resource_id: unknown; tenant_id: unknown; metadata: unknown }>(
    `gdpr_audit_log?action=eq.${CONSENT_WITHDRAW_TOKEN_ISSUED_ACTION}&resource_type=eq.${CONSENT_RESOURCE_TYPE}` +
      `&metadata->>token_hash=eq.${encodeURIComponent(tokenHash)}` +
      `&select=resource_id,tenant_id,metadata&limit=2`,
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new ParentalConsentDbError("ambiguous_token");
  const r = rows[0];
  const consentId = typeof r?.resource_id === "string" && UUID_RE.test(r.resource_id) ? r.resource_id : null;
  const playerId = metaString(r?.metadata, "player_id");
  const parentEmail = metaString(r?.metadata, "parent_email");
  if (!consentId || !playerId || !parentEmail || metaString(r?.metadata, "token_hash") !== tokenHash) {
    console.warn("[parental-consent] emisión del enlace de retirada incompleta → el enlace no vale");
    return null;
  }
  return {
    consentId,
    playerId,
    parentEmail,
    tenantId: typeof r.tenant_id === "string" ? uuidOrNull(r.tenant_id) : null,
  };
}

type AuditRow = { action: unknown; resource_id: unknown; metadata: unknown };

/**
 * El consentimiento parental VIGENTE del jugador según la regla de arriba (el más reciente
 * por signed_at), o null si no hay ninguno que cuente. Lanza ParentalConsentDbError si no
 * se puede comprobar (sin Supabase, error de la base, respuesta rara o demasiadas filas):
 * el llamador NUNCA lo interpreta como «concedido».
 */
export async function findActiveParentalConsent(playerId: string): Promise<ActiveParentalConsent | null> {
  const rows = await getRows<{ id: unknown; player_id: unknown }>(
    `parental_consents?player_id=eq.${encodeURIComponent(playerId)}` +
      `&email_verified=is.true&withdrawn_at=is.null` +
      `&select=id,player_id&order=signed_at.desc&limit=${MAX_ROWS}`,
  );
  const candidates = rows.filter(
    (r): r is { id: string; player_id: string } => typeof r?.id === "string" && r.id !== "" && r.player_id === playerId,
  );
  if (candidates.length === 0) return null;

  const audit = await getRows<AuditRow>(
    `gdpr_audit_log?action=in.${encodeURIComponent(
      pgInList([CONSENT_TOKEN_ISSUED_ACTION, CONSENT_VERIFIED_ACTION, CONSENT_WITHDRAWN_ACTION]),
    )}` +
      `&resource_type=eq.${CONSENT_RESOURCE_TYPE}` +
      `&resource_id=in.${encodeURIComponent(pgInList(candidates.map((c) => c.id)))}` +
      `&select=action,resource_id,metadata&limit=${MAX_ROWS}`,
  );
  const of = (action: string, consentId: string) =>
    audit.filter((a) => a?.action === action && a.resource_id === consentId);

  for (const c of candidates) {
    if (of(CONSENT_WITHDRAWN_ACTION, c.id).length > 0) continue;
    // La emisión del servidor para ESTE jugador…
    const issued = of(CONSENT_TOKEN_ISSUED_ACTION, c.id).filter(
      (a) => metaString(a.metadata, "player_id") === playerId && isTokenHash(metaString(a.metadata, "token_hash")),
    );
    // …y una verificación del tutor de ESA emisión (mismo jugador y mismo token).
    const verified = of(CONSENT_VERIFIED_ACTION, c.id).filter((a) => metaString(a.metadata, "player_id") === playerId);
    const match = issued.find((i) =>
      verified.some((v) => metaString(v.metadata, "token_hash") === metaString(i.metadata, "token_hash")),
    );
    if (match) return { id: c.id, parentEmail: metaString(match.metadata, "parent_email") };
  }
  return null;
}

/** Estado del consentimiento del tutor que ve el DUEÑO del jugador (P1 bloque 3). */
export type GuardianConsentState =
  | "verified" //  cuenta para el gate (regla de findActiveParentalConsent, la ÚNICA)
  | "pending" //   firma pedida, enlace aún vigente, el tutor no ha confirmado
  | "expired" //   firma pedida, el enlace caducó sin confirmar
  | "withdrawn" // el último consentimiento se retiró (tutor o responsable)
  | "none"; //     nunca se pidió (o lo que hay no cuenta)

export interface GuardianConsentStatus {
  state: GuardianConsentState;
  /** Nombre del tutor que escribió el responsable al pedir la firma. */
  guardianName: string | null;
  /** Email del tutor que ligó el SERVIDOR al emitir el enlace (no el de la fila). */
  guardianEmail: string | null;
  requestedAt: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  withdrawnAt: string | null;
}

const NO_CONSENT: GuardianConsentStatus = {
  state: "none", guardianName: null, guardianEmail: null, requestedAt: null, expiresAt: null, verifiedAt: null, withdrawnAt: null,
};

type ConsentRowView = {
  id: string;
  player_id: string;
  parent_name: string | null;
  email_verified: boolean;
  email_verified_at: string | null;
  withdrawn_at: string | null;
  signed_at: string | null;
};

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Estado del consentimiento del tutor de UN jugador, para la ficha y /admin/consent. «verified»
 * sale SIEMPRE de findActiveParentalConsent (la regla única del gate); el resto describe la
 * solicitud más reciente. Lanza ParentalConsentDbError si no se puede comprobar: el llamador
 * NUNCA lo muestra como «verificado».
 */
export async function consentStatusForPlayer(playerId: string): Promise<GuardianConsentStatus> {
  const raw = await getRows<Record<string, unknown>>(
    `parental_consents?player_id=eq.${encodeURIComponent(playerId)}` +
      `&select=id,player_id,parent_name,email_verified,email_verified_at,withdrawn_at,signed_at` +
      `&order=signed_at.desc&limit=${MAX_ROWS}`,
  );
  const rows: ConsentRowView[] = raw
    .filter((r) => typeof r?.id === "string" && UUID_RE.test(r.id as string) && r.player_id === playerId)
    .map((r) => ({
      id: r.id as string,
      player_id: playerId,
      parent_name: strOrNull(r.parent_name),
      email_verified: r.email_verified === true,
      email_verified_at: strOrNull(r.email_verified_at),
      withdrawn_at: strOrNull(r.withdrawn_at),
      signed_at: strOrNull(r.signed_at),
    }));
  if (rows.length === 0) return NO_CONSENT;

  // 1 · ¿Hay uno que CUENTE? Misma regla que el gate de análisis (una sola implementación).
  const active = await findActiveParentalConsent(playerId);
  if (active) {
    const row = rows.find((r) => r.id === active.id);
    return {
      state: "verified",
      guardianName: row?.parent_name ?? null,
      guardianEmail: active.parentEmail,
      requestedAt: row?.signed_at ?? null,
      expiresAt: null,
      verifiedAt: row?.email_verified_at ?? null,
      withdrawnAt: null,
    };
  }

  // 2 · Si no, la solicitud MÁS RECIENTE y su emisión (email del tutor y caducidad del enlace).
  const latest = rows[0];
  const audit = await getRows<AuditRow>(
    `gdpr_audit_log?action=in.${encodeURIComponent(pgInList([CONSENT_TOKEN_ISSUED_ACTION, CONSENT_WITHDRAWN_ACTION]))}` +
      `&resource_type=eq.${CONSENT_RESOURCE_TYPE}&resource_id=eq.${encodeURIComponent(latest.id)}` +
      `&select=action,resource_id,metadata&limit=${MAX_ROWS}`,
  );
  const issued = audit.find(
    (a) => a?.action === CONSENT_TOKEN_ISSUED_ACTION && metaString(a.metadata, "player_id") === playerId,
  );
  const base = {
    guardianName: latest.parent_name,
    guardianEmail: issued ? metaString(issued.metadata, "parent_email") : null,
    requestedAt: latest.signed_at,
    verifiedAt: null,
  };
  const withdrawnEvidence = audit.some((a) => a?.action === CONSENT_WITHDRAWN_ACTION);
  if (latest.withdrawn_at || withdrawnEvidence) {
    return { ...base, state: "withdrawn", expiresAt: null, withdrawnAt: latest.withdrawn_at };
  }
  // Verificada en la fila pero sin la evidencia del servidor: NO cuenta (B6) ⇒ «none».
  if (latest.email_verified || !issued) return { ...NO_CONSENT, guardianName: latest.parent_name };
  const expiresAt = metaString(issued.metadata, "expires_at");
  const expired = !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) < Date.now();
  return { ...base, state: expired ? "expired" : "pending", expiresAt, withdrawnAt: null };
}

/**
 * RETIRA los consentimientos parentales activos del jugador (ronda 6 de la review del PR #308).
 * La llama SOLO api/auth/_withdraw-consent.ts, después de comprobar que quien retira es el DUEÑO
 * del jugador. Antes, «revocar» en /admin/consent solo ponía players.parental_consent_status =
 * 'denied', que el entrenador puede volver a poner en 'granted' sin el tutor, y el
 * consentimiento verificado seguía contando.
 *
 * Orden pensado para que la retirada valga aunque algo falle a mitad:
 *   1. lee las filas activas (withdrawn_at IS NULL) del jugador;
 *   2. escribe por cada una la evidencia 'consent_withdrawn' en gdpr_audit_log (append-only,
 *      service_role): desde aquí findActiveParentalConsent ya no la cuenta, aunque luego un
 *      cliente con permisos (antes de la 075) volviera a poner withdrawn_at a NULL;
 *   3. pone withdrawn_at = ahora (y withdrawn_reason) en esas filas. El trigger
 *      audit_consent_changes de la 003 escribe además su propia 'consent_withdrawn'.
 * Si falla 2 o 3, lanza ParentalConsentDbError y el llamador responde 500: reintentar es seguro
 * (repetir 2 solo añade otra fila de auditoría). Un consentimiento nuevo que el tutor firme y
 * verifique DESPUÉS sí cuenta: es otra fila, con su propia emisión y verificación.
 * Devuelve cuántos consentimientos se retiraron (0 si no había ninguno activo).
 *
 * P1 bloque 3 — también lo usan:
 *   - api/auth/_guardian-withdraw.ts (el TUTOR, con el enlace de su correo): `consentIds` = SU
 *     consentimiento y `source: "guardian_link"`;
 *   - api/auth/sign-consent.ts al pedir de nuevo la firma: `onlyUnverified` + `source:
 *     "superseded"`, para que un enlace anterior aún vigente (p. ej. enviado a un email mal
 *     escrito) deje de valer. Nunca retira uno ya verificado.
 */
export type WithdrawSource = "owner_revoke" | "guardian_link" | "superseded";

const DEFAULT_WITHDRAW_REASON: Record<WithdrawSource, string> = {
  owner_revoke: "revocado por el responsable del jugador",
  guardian_link: "retirado por el tutor desde el enlace de su correo",
  superseded: "sustituido por una nueva solicitud de firma",
};

export async function withdrawParentalConsents(input: {
  playerId: string;
  /** Quien retira (JWT verificado); null si es el tutor (sin cuenta). */
  userId: string | null;
  tenantId: string | null;
  reason: string | null;
  /** Solo estos consentimientos (si no, todos los activos del jugador). */
  consentIds?: readonly string[];
  /** Solo los que el tutor aún NO ha verificado. */
  onlyUnverified?: boolean;
  source?: WithdrawSource;
}): Promise<number> {
  const source: WithdrawSource = input.source ?? "owner_revoke";
  const rows = await getRows<{ id: unknown; player_id: unknown }>(
    `parental_consents?player_id=eq.${encodeURIComponent(input.playerId)}` +
      `&withdrawn_at=is.null${input.onlyUnverified ? "&email_verified=is.false" : ""}` +
      `&select=id,player_id&limit=${MAX_ROWS}`,
  );
  const only = input.consentIds ? new Set(input.consentIds) : null;
  const ids = rows
    .filter((r): r is { id: string; player_id: string } => typeof r?.id === "string" && UUID_RE.test(r.id) && r.player_id === input.playerId)
    .map((r) => r.id)
    .filter((id) => only === null || only.has(id));
  if (ids.length === 0) return 0;

  for (const id of ids) {
    await insertAudit({
      user_id: uuidOrNull(input.userId),
      tenant_id: uuidOrNull(input.tenantId),
      action: CONSENT_WITHDRAWN_ACTION,
      resource_type: CONSENT_RESOURCE_TYPE,
      resource_id: id,
      metadata: { player_id: input.playerId, source },
    });
  }

  let url: string;
  let headers: Record<string, string>;
  try {
    url =
      `${supabaseRestUrl()}/rest/v1/parental_consents?id=in.${encodeURIComponent(pgInList(ids))}` +
      `&player_id=eq.${encodeURIComponent(input.playerId)}&withdrawn_at=is.null`;
    headers = serviceHeaders({ Prefer: "return=minimal" });
  } catch {
    throw new ParentalConsentDbError("supabase_not_configured");
  }
  const res = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      withdrawn_at: new Date().toISOString(),
      withdrawn_reason: (input.reason ?? "").trim().slice(0, 500) || DEFAULT_WITHDRAW_REASON[source],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ParentalConsentDbError(`withdraw ${res.status} ${text.slice(0, 300)}`);
  }
  return ids.length;
}
