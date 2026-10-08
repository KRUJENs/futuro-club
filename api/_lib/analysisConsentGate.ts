/**
 * VITAS · Gate de consentimiento ANTES de analizar un clip (servidor)
 *
 * Una sola implementación (invariante #7) de la decisión del owner del 30 sep 2026
 * (regla pura en src/lib/shared/videoConsent.ts). La usan:
 *   - creación de subidas: api/upload/_video-init.ts, api/videos/create-upload.ts
 *   - inicio de análisis:  api/videos/finalize.ts, api/_lib/enqueueAnalysis.ts (webhook de
 *     Bunny + finalize), api/crons/process-analyses-queue.ts (defensa en profundidad),
 *     api/agents/video-observation.ts (llamadas con JWT de usuario), team-observation,
 *     _team-intelligence, api/pipeline/_start.ts, api/analyses/generate-reports.ts,
 *     api/coaching/_track-players.ts / _track-async.ts (llamadas de usuario),
 *     api/tactical/_compute-from-video.ts (llamadas de usuario), api/live/aggregate.ts.
 *
 * QUÉ VÍDEO Y QUÉ JUGADOR (B1/B2 · una sola regla, ver resolveClipVideo / gateClipAnalysis):
 * el servidor busca TODAS las filas `videos` del clip (por id o por bunny_video_id, y por
 * el GUID cuyos píxeles va a leer), exige que el usuario las gestione y comprueba el
 * consentimiento del jugador pedido Y del `player_id` de cada fila. El `playerId` del
 * body nunca sustituye al jugador que el servidor liga al vídeo.
 *
 * DÓNDE SE GUARDA LA DECLARACIÓN (sin migración nueva): una fila append-only, escrita
 * SOLO por el servidor con service_role, en public.gdpr_audit_log (migración 003):
 *   user_id       = usuario del JWT verificado (nunca del body)   → QUIÉN
 *   created_at    = reloj de la base (DEFAULT now())             → CUÁNDO
 *   metadata      = { version, scope, player_id, bunny_video_id, endpoint } (jsonb) → VERSIÓN
 *   action        = 'video_analysis_attested'
 *   resource_type = 'videos' (fila de videos con propiedad comprobada) | 'video_ref'
 *   resource_id   = id del vídeo (o referencia del cliente)
 * Por qué no una columna jsonb de `videos`: `videos.data` lo sobrescribe entero el
 * navegador en cada sincronización (supabaseVideoService: `data: v`) y la RLS de update
 * deja al dueño cambiar cualquier columna; `analysis_result` también lo reenvía el
 * cliente; `target_player_bbox` tiene semántica de identidad. PRECONDICIÓN (no
 * verificada en prod): la 072 cerró el INSERT de authenticated en gdpr_audit_log; antes,
 * la política 003 `audit_insert_authenticated` (WITH CHECK true) permitía falsificarla.
 *
 * FALLA CERRADO: sin Supabase, con un error de la base o si no se puede guardar la
 * declaración → consent_check_failed (500). Nunca 503 (ver CLIP_CONSENT_HTTP_STATUS).
 * Única degradación: si la columna players.birth_date no existiera (036 sin aplicar), la
 * fecha se trata como DESCONOCIDA (regla 3 del owner: basta la declaración) y se registra
 * en el log; nunca se infiere la edad.
 *
 * Sin `node:*` → vale para Edge y Node.
 */

import { errorResponse } from "./apiResponse";
import {
  CLIP_ATTESTATION_VERSION,
  CLIP_CONSENT_HTTP_STATUS,
  VIDEO_ANALYSIS_ATTESTED_ACTION,
  clipConsentGateReason,
  evaluateClipConsent,
  isClipConsentCode,
  minorStatusFromBirthDate,
  parseClipAttestation,
  type ClipAttestation,
  type ClipAttestationResourceType,
  type ClipConsentCode,
  type MinorStatus,
} from "../../src/lib/shared/videoConsent";
import { isMissingBirthDateColumnError } from "../../src/lib/shared/birthDate";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Quién hace la petición (null en rutas automáticas: webhook de Bunny, cola). */
export interface ConsentActor {
  userId: string | null;
  tenantId: string | null;
  ip?: string | null;
}

/** El clip: una fila `videos` propia (ya comprobada por el llamador) o una referencia. */
export type ConsentResource =
  | { type: "videos"; id: string; bunnyVideoId?: string | null }
  | { type: "video_ref"; id: string | null };

export interface EnforceClipConsentInput {
  /** `body.attestation` tal cual (se valida aquí). Ignorado si `storedOnly`. */
  attestation?: unknown;
  /**
   * Ruta automática (webhook, cola): solo cuenta una declaración YA guardada para una
   * fila `videos`; el body no puede declarar nada.
   */
  storedOnly?: boolean;
  /**
   * false ⇒ no se busca una declaración guardada (la petición DEBE traerla). Por
   * defecto se busca solo para `type: "videos"`.
   */
  lookupStored?: boolean;
  resource: ConsentResource;
  /**
   * Jugador para el que se pide el análisis (ya comprobado por el llamador); queda en la
   * metadata de la declaración. null = sin jugador pedido.
   */
  playerId: string | null;
  /**
   * Jugadores que el SERVIDOR liga al vídeo (`videos.player_id` de TODAS las filas que
   * apuntan a ese vídeo de Bunny, ver resolveClipVideo). Se comprueban SIEMPRE, además de
   * `playerId`: el body no puede esquivar al menor del vídeo omitiendo o cambiando el
   * jugador (B1). Sin ninguno (y sin `playerId`) = vídeo de equipo.
   */
  videoPlayerIds?: ReadonlyArray<string | null>;
  actor: ConsentActor;
  /** Endpoint que declara (queda en metadata). */
  endpoint: string;
  scope?: "player" | "team";
  locale?: unknown;
  /**
   * false ⇒ se decide pero NO se guarda la declaración del body (el llamador la guarda
   * luego con recordClipAttestation, p. ej. cuando el id del vídeo aún no existe).
   */
  record?: boolean;
  now?: Date;
}

export type ClipConsentGateResult =
  | {
      allowed: true;
      /** "recorded" = se guardó ahora · "stored" = ya estaba · "pending" = el llamador la guardará. */
      attestation: "recorded" | "stored" | "pending";
      /** Declaración del body lista para guardar (solo si `attestation === "pending"`). */
      pendingAttestation: ClipAttestation | null;
      minor: MinorStatus | null;
    }
  | {
      allowed: false;
      code: ClipConsentCode;
      status: 400 | 403 | 500;
      gate_reason: string;
      minor: MinorStatus | null;
    };

// ─── REST (service role) ─────────────────────────────────────────────────────

function sbEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

class ConsentDbError extends Error {}

async function getRows<T>(path: string): Promise<T[]> {
  const env = sbEnv();
  if (!env) throw new ConsentDbError("supabase_not_configured");
  const res = await fetch(`${env.url}/rest/v1/${path}`, { headers: headers(env.key) });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ConsentDbError(`${res.status} ${text.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConsentDbError("invalid_json");
  }
  if (!Array.isArray(parsed)) throw new ConsentDbError("not_an_array");
  return parsed as T[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

/** Solo un uuid va a una columna uuid (un valor raro haría fallar el INSERT → bloquearía todo). */
function uuidOrNull(v: string | null | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

/** Solo una IP literal va a la columna inet (getClientIP puede dar "unknown"). */
function ipOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  if (IPV4_RE.test(v)) return v;
  if (v.includes(":") && IPV6_RE.test(v)) return v;
  return null;
}

function resourceFilter(resource: ConsentResource): string {
  const idFilter = resource.id === null ? "resource_id=is.null" : `resource_id=eq.${encodeURIComponent(resource.id)}`;
  return (
    `action=eq.${VIDEO_ANALYSIS_ATTESTED_ACTION}` +
    `&resource_type=eq.${resource.type}` +
    `&${idFilter}` +
    `&metadata->>version=eq.${encodeURIComponent(CLIP_ATTESTATION_VERSION)}`
  );
}

/** ¿Hay una declaración VIGENTE guardada para esta fila `videos`? (cualquier usuario autorizado). */
export async function hasStoredClipAttestation(videoId: string): Promise<boolean> {
  const rows = await getRows<{ id: unknown }>(
    `gdpr_audit_log?${resourceFilter({ type: "videos", id: videoId })}&select=id&limit=1`,
  );
  return rows.length > 0;
}

/**
 * Guarda la declaración (append-only, service role). Idempotente por (recurso, versión,
 * usuario): si ya existe no se duplica (finalize se sondea hasta 12 veces).
 * Lanza ConsentDbError si no se puede comprobar o insertar.
 */
export async function recordClipAttestation(input: {
  attestation: ClipAttestation;
  resource: ConsentResource;
  actor: ConsentActor;
  playerId: string | null;
  endpoint: string;
  scope?: "player" | "team";
}): Promise<void> {
  const env = sbEnv();
  if (!env) throw new ConsentDbError("supabase_not_configured");
  const userId = uuidOrNull(input.actor.userId);
  if (!userId) throw new ConsentDbError("attestation_without_user");

  const existing = await getRows<{ id: unknown }>(
    `gdpr_audit_log?${resourceFilter(input.resource)}&user_id=eq.${userId}&select=id&limit=1`,
  );
  if (existing.length > 0) return;

  const row = {
    user_id: userId,
    tenant_id: uuidOrNull(input.actor.tenantId),
    action: VIDEO_ANALYSIS_ATTESTED_ACTION,
    resource_type: input.resource.type as ClipAttestationResourceType,
    resource_id: input.resource.id,
    metadata: {
      version: input.attestation.version,
      scope: input.scope ?? (input.playerId ? "player" : "team"),
      player_id: input.playerId,
      bunny_video_id: input.resource.type === "videos" ? input.resource.bunnyVideoId ?? null : null,
      endpoint: input.endpoint,
    },
    ip: ipOrNull(input.actor.ip),
  };
  const res = await fetch(`${env.url}/rest/v1/gdpr_audit_log`, {
    method: "POST",
    headers: headers(env.key, { Prefer: "return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ConsentDbError(`insert ${res.status} ${text.slice(0, 300)}`);
  }
}

/**
 * players.birth_date del jugador. `found:false` = no hay fila. Si la columna no existe
 * (036 sin aplicar) → fecha DESCONOCIDA (null) con aviso en el log: nunca se infiere.
 */
async function readPlayerBirthDate(playerId: string): Promise<{ found: boolean; birthDate: string | null }> {
  try {
    const rows = await getRows<{ birth_date: string | null }>(
      `players?id=eq.${encodeURIComponent(playerId)}&select=birth_date&limit=1`,
    );
    if (rows.length === 0) return { found: false, birthDate: null };
    const bd = rows[0]?.birth_date;
    return { found: true, birthDate: typeof bd === "string" && bd !== "" ? bd : null };
  } catch (err) {
    if (err instanceof ConsentDbError && isMissingBirthDateColumnError(err.message)) {
      console.warn("[consent-gate] players.birth_date no existe (¿036 sin aplicar?) → fecha desconocida, basta la declaración");
      return { found: true, birthDate: null };
    }
    throw err;
  }
}

/**
 * ¿Consentimiento parental CONCEDIDO? Fuente canónica única: parental_consents con
 * email_verified = true AND withdrawn_at IS NULL (predicado de idx_consents_active, 003).
 * La fila solo la crea api/auth/sign-consent.ts y solo se verifica cuando el TUTOR pulsa
 * el enlace de api/auth/verify-consent.ts.
 */
export async function hasActiveParentalConsent(playerId: string): Promise<boolean> {
  const rows = await getRows<{ id: unknown }>(
    `parental_consents?player_id=eq.${encodeURIComponent(playerId)}` +
      `&email_verified=is.true&withdrawn_at=is.null&select=id&limit=1`,
  );
  return rows.length > 0;
}

// ─── Gate ────────────────────────────────────────────────────────────────────

type BlockedGateResult = Extract<ClipConsentGateResult, { allowed: false }>;

function blockedResult(code: ClipConsentCode, locale: unknown, minor: MinorStatus | null): BlockedGateResult {
  return {
    allowed: false,
    code,
    status: CLIP_CONSENT_HTTP_STATUS[code],
    gate_reason: clipConsentGateReason(locale, code),
    minor,
  };
}

function toBlocked(decision: Extract<ReturnType<typeof evaluateClipConsent>, { allowed: false }>): BlockedGateResult {
  return {
    allowed: false,
    code: decision.code,
    status: CLIP_CONSENT_HTTP_STATUS[decision.code],
    gate_reason: decision.gate_reason,
    minor: decision.minor,
  };
}

/** Strings no vacíos, sin duplicar, en el orden de entrada. */
function uniqueIds(values: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v !== "" && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Decide (y, si procede, guarda la declaración) antes de analizar un clip.
 * Orden: declaración (body o guardada) → CADA jugador (el pedido y los que el servidor
 * liga al vídeo: fecha de nacimiento → si es menor de 14 conocido, consentimiento
 * parental) → regla pura → guardar la declaración del body.
 */
export async function enforceClipConsent(input: EnforceClipConsentInput): Promise<ClipConsentGateResult> {
  const { locale, resource, playerId, actor } = input;
  try {
    if (!sbEnv()) {
      console.error("[consent-gate] Supabase no configurado → no se puede comprobar ni guardar la declaración (falla cerrado)");
      return blockedResult("consent_check_failed", locale, null);
    }

    // 1 · Declaración: la del body (solo si hay un usuario que la haga) o una guardada.
    const bodyAttestation =
      input.storedOnly || !actor.userId ? null : parseClipAttestation(input.attestation);
    let attestationSource: "body" | "stored" | null = bodyAttestation ? "body" : null;
    const canLookup = resource.type === "videos" && input.lookupStored !== false;
    if (!attestationSource && canLookup && (await hasStoredClipAttestation(resource.id))) {
      attestationSource = "stored";
    }
    const attestation = attestationSource ? { accepted: true, version: CLIP_ATTESTATION_VERSION } : null;

    // 2 · Jugadores: el pedido + los que el servidor liga al vídeo (todos, sin duplicar).
    //     Ninguno = vídeo de equipo (la comprobación por jugador no aplica).
    const subjects = uniqueIds([playerId, ...(input.videoPlayerIds ?? [])]);
    let decisionMinor: MinorStatus | null = null;
    if (!attestation || subjects.length === 0) {
      // 3a · Regla pura (la misma que usa la UI): sin declaración → attestation_required.
      const decision = evaluateClipConsent({ attestation, player: null, locale, now: input.now });
      if (!decision.allowed) return toBlocked(decision);
    } else {
      for (const subject of subjects) {
        const bd = await readPlayerBirthDate(subject);
        if (!bd.found) {
          console.error(`[consent-gate] jugador ${subject} no encontrado → falla cerrado`);
          return blockedResult("consent_check_failed", locale, null);
        }
        const minor = minorStatusFromBirthDate(bd.birthDate, input.now ?? new Date());
        // 3b · Regla pura por jugador; el primero que bloquea, bloquea el análisis.
        const decision = evaluateClipConsent({
          attestation,
          player: {
            birthDate: bd.birthDate,
            parentalConsentGranted: minor === "minor" ? await hasActiveParentalConsent(subject) : null,
          },
          locale,
          now: input.now,
        });
        if (!decision.allowed) return toBlocked(decision);
        if (subject === playerId || decisionMinor === null) decisionMinor = decision.minor;
      }
    }

    // 4 · Guardar la declaración del body (quién/cuándo/versión) — si no se puede, NO se analiza.
    if (attestationSource === "body" && bodyAttestation) {
      if (input.record === false) {
        return { allowed: true, attestation: "pending", pendingAttestation: bodyAttestation, minor: decisionMinor };
      }
      await recordClipAttestation({
        attestation: bodyAttestation,
        resource,
        actor,
        playerId: playerId ?? subjects[0] ?? null,
        endpoint: input.endpoint,
        scope: input.scope,
      });
      return { allowed: true, attestation: "recorded", pendingAttestation: null, minor: decisionMinor };
    }
    return { allowed: true, attestation: "stored", pendingAttestation: null, minor: decisionMinor };
  } catch (err) {
    console.error("[consent-gate] error comprobando el consentimiento (falla cerrado):", err instanceof Error ? err.message : err);
    return blockedResult("consent_check_failed", locale, null);
  }
}

/** Respuesta HTTP estándar de un bloqueo (código + motivo en el idioma pedido + versión vigente). */
export function clipConsentErrorResponse(result: BlockedGateResult): Response {
  return errorResponse({
    message: result.gate_reason,
    status: result.status,
    code: result.code,
    details: { gate_reason: result.gate_reason, attestationVersion: CLIP_ATTESTATION_VERSION },
  });
}

// ─── El vídeo del análisis lo resuelve el SERVIDOR (una sola regla · inv #7) ──
//
// Hallazgos B1/B2 (review del PR #308): varios endpoints decidían el jugador del
// consentimiento con el `playerId` del body (o null) y buscaban la fila `videos` solo
// por `id`; con el GUID de Bunny (o sin playerId) se saltaban la propiedad y al menor
// del vídeo. Regla única para TODAS las entradas que analizan un clip:
//   1. Se buscan TODAS las filas `videos` del vídeo: por id o por bunny_video_id = la
//      referencia del cliente, y por el GUID de Bunny cuyos píxeles va a leer el servidor
//      (URL o GUID directo). bunny_video_id no es UNIQUE (060) y la RLS 038 deja al dueño
//      escribirlo, así que puede haber varias.
//   2. En rutas de usuario TODAS tienen que ser del usuario/tenant (ownsVideo) → si no, 403.
//   3. Si el servidor lee píxeles por referencia, ninguna fila puede apuntar a OTRO GUID
//      (400 video_url_mismatch) y tiene que existir una fila del vídeo (404 video_not_found).
//   4. El consentimiento comprueba el jugador pedido Y el `player_id` de cada fila
//      (enforceClipConsent · videoPlayerIds). Un jugador distinto en el body no se rechaza
//      (un mismo clip se analiza para varios jugadores: enqueueAnalysis por (vídeo,
//      jugador)), pero nunca sustituye al del vídeo.

export interface VideoRowLite {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  player_id: string | null;
  bunny_video_id: string | null;
}

/** Predicado de propiedad (api/_lib/ownership.ownsVideo); null = ruta automática sin usuario. */
export type OwnsVideoFn = (video: VideoRowLite, userId: string | null) => Promise<boolean>;

/**
 * GUID de Bunny de una URL de vídeo de Bunny: el segmento tras `/videos/` en
 * video.bunnycdn.com, o el PRIMER segmento de la ruta en una pull zone (`/<guid>/play_720p.mp4`).
 * Es el vídeo que el CDN sirve; un GUID en un segmento posterior NO lo identifica.
 */
export function bunnyGuidFromVideoUrl(videoUrl: string): string | null {
  try {
    const u = new URL(videoUrl);
    const segs = u.pathname.split("/").filter(Boolean);
    if (u.hostname.toLowerCase() === "video.bunnycdn.com") {
      const i = segs.indexOf("videos");
      return i >= 0 && segs[i + 1] ? segs[i + 1] : null;
    }
    return segs[0] ?? null;
  } catch {
    return null;
  }
}

/** Lista PostgREST `("a","b")` con comillas y escapes (mismo formato que matchJob/repo). */
function pgInList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

const VIDEO_ROW_SELECT = "id,user_id,tenant_id,player_id,bunny_video_id";
/** Tope de filas por consulta: si se alcanza no se ven todas → falla cerrado. */
const MAX_VIDEO_ROWS = 50;

/** Filas `videos` cuyo id O bunny_video_id está en `keys` (service role). */
async function loadVideoRowsByKeys(keys: readonly string[]): Promise<VideoRowLite[]> {
  if (keys.length === 0) return [];
  const list = encodeURIComponent(pgInList(keys));
  const byId = await getRows<VideoRowLite>(`videos?id=in.${list}&select=${VIDEO_ROW_SELECT}&limit=${MAX_VIDEO_ROWS}`);
  const byGuid = await getRows<VideoRowLite>(`videos?bunny_video_id=in.${list}&select=${VIDEO_ROW_SELECT}&limit=${MAX_VIDEO_ROWS}`);
  if (byId.length >= MAX_VIDEO_ROWS || byGuid.length >= MAX_VIDEO_ROWS) throw new ConsentDbError("too_many_video_rows");
  return mergeRows([], [...byId, ...byGuid]);
}

function mergeRows(a: VideoRowLite[], b: VideoRowLite[]): VideoRowLite[] {
  const out = [...a];
  for (const r of b) {
    if (r && typeof r.id === "string" && !out.some((x) => x.id === r.id)) out.push(r);
  }
  return out;
}

export type ClipVideoResolution =
  | {
      ok: true;
      /** Fila principal (la del id pedido o la del GUID); null = sin fila (solo si no se exige). */
      video: VideoRowLite | null;
      /** Todas las filas `videos` del mismo vídeo. */
      rows: VideoRowLite[];
      resource: ConsentResource;
      /** `player_id` distintos de esas filas: el consentimiento los comprueba TODOS. */
      videoPlayerIds: string[];
    }
  | { ok: false; status: 400 | 403 | 404 | 500; code: string; message: string };

const RESOLUTION_MESSAGES = {
  video_reference_required: "Falta la referencia del vídeo: el análisis debe referirse a un vídeo guardado.",
  video_not_found: "Vídeo no encontrado: el análisis debe referirse a un vídeo guardado.",
  video_url_mismatch: "La URL no corresponde a ese vídeo.",
  forbidden: "No gestionas este vídeo",
} as const;

function resolutionFailure(status: 400 | 403 | 404 | 500, code: keyof typeof RESOLUTION_MESSAGES | "consent_check_failed"): Extract<ClipVideoResolution, { ok: false }> {
  return { ok: false, status, code, message: code === "consent_check_failed" ? code : RESOLUTION_MESSAGES[code] };
}

/**
 * Resuelve en el servidor qué vídeo se va a analizar y qué jugadores tiene (regla de
 * arriba). Error de la base → consent_check_failed (falla cerrado; nunca 503).
 *
 * - `videoId`: referencia que manda el CLIENTE (videos.id, GUID de Bunny o id solo del navegador).
 * - `videoUrl` / `bunnyGuid`: el vídeo de Bunny cuyos PÍXELES va a leer el servidor.
 * - `requireVideoRow`: true cuando el servidor lee píxeles por referencia (Modal, Gemini,
 *   miniatura de Bunny): sin fila no hay a quién ligar la declaración ni el jugador.
 *   false cuando el contenido llega del navegador (fichero local, fotogramas, métricas):
 *   sin fila el recurso es `video_ref` y la declaración tiene que venir en la petición.
 */
export async function resolveClipVideo(input: {
  videoId?: unknown;
  videoUrl?: unknown;
  bunnyGuid?: unknown;
  requireVideoRow: boolean;
  /**
   * SOLO finalize: la fila `videoId` aún sin bunny_video_id se va a SEMBRAR con
   * `bunnyGuid` → cuenta como fila de ese vídeo (si no, sería un vídeo distinto).
   */
  seedRow?: boolean;
  actor: ConsentActor;
  ownsVideo: OwnsVideoFn | null;
  endpoint: string;
}): Promise<ClipVideoResolution> {
  const videoId = typeof input.videoId === "string" && input.videoId.trim() !== "" ? input.videoId : null;
  let pixelGuid = typeof input.bunnyGuid === "string" && input.bunnyGuid.trim() !== "" ? input.bunnyGuid : null;
  if (!pixelGuid && typeof input.videoUrl === "string" && input.videoUrl !== "") {
    pixelGuid = bunnyGuidFromVideoUrl(input.videoUrl);
    if (!pixelGuid) return resolutionFailure(404, "video_not_found");
  }
  const keys = uniqueIds([videoId, pixelGuid]);
  if (keys.length === 0) {
    return input.requireVideoRow
      ? resolutionFailure(400, "video_reference_required")
      : { ok: true, video: null, rows: [], resource: { type: "video_ref", id: null }, videoPlayerIds: [] };
  }

  let rows: VideoRowLite[];
  try {
    rows = await loadVideoRowsByKeys(keys);
    // Contenido del navegador (sin GUID de píxeles): las demás filas del MISMO vídeo de
    // Bunny también cuentan (otra fila puede ligarlo a un jugador).
    if (!pixelGuid && rows.length > 0) {
      const more = uniqueIds(rows.map((r) => r.bunny_video_id)).filter((g) => !keys.includes(g));
      if (more.length > 0) rows = mergeRows(rows, await loadVideoRowsByKeys(more));
    }
  } catch (err) {
    console.error(`[consent-gate] ${input.endpoint}: no se pudo leer el vídeo (falla cerrado):`, err instanceof Error ? err.message : err);
    return resolutionFailure(500, "consent_check_failed");
  }

  if (rows.length === 0) {
    return input.requireVideoRow
      ? resolutionFailure(404, "video_not_found")
      : { ok: true, video: null, rows: [], resource: { type: "video_ref", id: videoId }, videoPlayerIds: [] };
  }
  // Filas del vídeo cuyos píxeles se leen. Con keys = [GUID] son todas; si además vino un
  // videoId cuya fila es OTRO vídeo, quedan fuera → mismatch (abajo).
  const pixelRows = pixelGuid
    ? rows.filter(
        (r) =>
          r.id === pixelGuid ||
          r.bunny_video_id === pixelGuid ||
          (input.seedRow === true && r.id === videoId && r.bunny_video_id === null),
      )
    : rows;

  // Propiedad ANTES de comparar GUIDs (a quien no gestiona el vídeo no se le cuenta nada más).
  if (input.ownsVideo) {
    for (const row of rows) {
      if (!(await input.ownsVideo(row, input.actor.userId))) {
        console.warn(`[consent-gate] ${input.endpoint}: la fila videos ${row.id} no es de quien pide el análisis`);
        return resolutionFailure(403, "forbidden");
      }
    }
  }

  // Un solo vídeo de Bunny: TODAS las filas encontradas tienen que ser de los píxeles que se
  // leen (si el videoId del cliente es otro vídeo, o una fila apunta a otro GUID → 400).
  if (pixelGuid && (pixelRows.length === 0 || pixelRows.length !== rows.length)) {
    return resolutionFailure(400, "video_url_mismatch");
  }

  const candidates = pixelRows.length > 0 ? pixelRows : rows;
  const video =
    candidates.find((r) => r.id === videoId) ??
    candidates.find((r) => r.id === pixelGuid) ??
    candidates.find((r) => videoId !== null && r.bunny_video_id === videoId) ??
    [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
  return {
    ok: true,
    video,
    rows,
    resource: { type: "videos", id: video.id, bunnyVideoId: video.bunny_video_id ?? pixelGuid ?? null },
    videoPlayerIds: uniqueIds(rows.map((r) => r.player_id)),
  };
}

/** Bloqueo del gate completo: un código de consentimiento o uno de resolución del vídeo. */
export interface ClipAnalysisBlocked {
  allowed: false;
  status: number;
  code: string;
  gate_reason: string;
  minor: MinorStatus | null;
}

export type ClipAnalysisGateResult =
  | (Extract<ClipConsentGateResult, { allowed: true }> & { video: VideoRowLite | null; videoPlayerIds: string[] })
  | ClipAnalysisBlocked;

/**
 * Gate COMPLETO antes de analizar un clip: resolveClipVideo + enforceClipConsent con los
 * jugadores del vídeo. Lo usan todas las entradas que reciben una referencia de vídeo
 * (pipeline/start, track-*, compute-from-video, team-*, generate-reports, finalize, la
 * cola, enqueueAnalysis, live/aggregate y video-observation).
 */
export async function gateClipAnalysis(input: {
  videoId?: unknown;
  videoUrl?: unknown;
  bunnyGuid?: unknown;
  requireVideoRow: boolean;
  /** SOLO finalize (ver resolveClipVideo). */
  seedRow?: boolean;
  /** Jugador para el que se pide el análisis (propiedad ya comprobada por el llamador). */
  playerId: string | null;
  attestation?: unknown;
  storedOnly?: boolean;
  actor: ConsentActor;
  endpoint: string;
  scope?: "player" | "team";
  locale?: unknown;
  ownsVideo: OwnsVideoFn | null;
  now?: Date;
}): Promise<ClipAnalysisGateResult> {
  if (!sbEnv()) {
    console.error("[consent-gate] Supabase no configurado → no se puede comprobar ni guardar la declaración (falla cerrado)");
    return blockedResult("consent_check_failed", input.locale, null);
  }
  const target = await resolveClipVideo(input);
  if (!target.ok) {
    if (target.code === "consent_check_failed") return blockedResult("consent_check_failed", input.locale, null);
    return { allowed: false, status: target.status, code: target.code, gate_reason: target.message, minor: null };
  }
  const consent = await enforceClipConsent({
    attestation: input.attestation,
    storedOnly: input.storedOnly,
    resource: target.resource,
    playerId: input.playerId,
    videoPlayerIds: target.videoPlayerIds,
    actor: input.actor,
    endpoint: input.endpoint,
    scope: input.scope,
    locale: input.locale,
    now: input.now,
  });
  if (!consent.allowed) return consent;
  return { ...consent, video: target.video, videoPlayerIds: target.videoPlayerIds };
}

/**
 * Respuesta HTTP de un bloqueo del gate completo: los de consentimiento con su motivo
 * traducido + versión vigente (clipConsentErrorResponse); los de resolución con su código.
 */
export function clipGateErrorResponse(result: ClipAnalysisBlocked): Response {
  if (isClipConsentCode(result.code)) {
    return clipConsentErrorResponse({ ...result, code: result.code, status: CLIP_CONSENT_HTTP_STATUS[result.code] });
  }
  return errorResponse({ message: result.gate_reason, status: result.status, code: result.code });
}

/**
 * Ruta SIN declaración en el body (live/aggregate, que analiza la `video_url` guardada de
 * un partido): el vídeo tiene que ser una fila `videos` QUE GESTIONE quien pide el
 * análisis y con una declaración YA guardada (la de VideoUpload al subirlo). Sin fila, de
 * otro usuario o de otro vídeo → attestation_required (no consta una declaración de quien
 * analiza para ESE vídeo). El jugador de CADA fila del vídeo se comprueba (gateClipAnalysis).
 */
export async function enforceStoredConsentForVideoUrl(input: {
  videoUrl: string;
  actor: ConsentActor;
  endpoint: string;
  locale?: unknown;
  ownsVideo: OwnsVideoFn;
}): Promise<ClipConsentGateResult> {
  const gate = await gateClipAnalysis({
    videoUrl: input.videoUrl,
    requireVideoRow: true,
    playerId: null,
    storedOnly: true,
    actor: input.actor,
    endpoint: input.endpoint,
    locale: input.locale,
    ownsVideo: input.ownsVideo,
  });
  if (gate.allowed) {
    return { allowed: true, attestation: gate.attestation, pendingAttestation: gate.pendingAttestation, minor: gate.minor };
  }
  if (isClipConsentCode(gate.code)) return { ...gate, code: gate.code, status: CLIP_CONSENT_HTTP_STATUS[gate.code] };
  console.warn(`[consent-gate] ${input.endpoint}: ${gate.code} → sin declaración de quien analiza para ese vídeo`);
  return blockedResult("attestation_required", input.locale, null);
}

export type UserVideoGateResult =
  | { allowed: true; video: VideoRowLite }
  | { allowed: false; response: Response };

/**
 * Llamada con JWT de USUARIO a /api/agents/video-observation. Para que la declaración
 * quede guardada CON el vídeo y el menor se pueda comprobar, la petición tiene que
 * identificar una fila `videos` que gestione el usuario y la URL tiene que ser la de ESE
 * vídeo (primer segmento de la pull zone). Sin fichero en base64 (no se podría ligar a
 * ningún vídeo). Las llamadas de servicio (cola, gemini-analyze, live/aggregate) NO pasan
 * por aquí: su gate va antes.
 */
export async function enforceUserVideoObservationConsent(input: {
  videoId: unknown;
  videoUrl: unknown;
  hasBase64: boolean;
  attestation: unknown;
  scope: "player" | "team";
  actor: ConsentActor;
  locale?: unknown;
  ownsVideo: OwnsVideoFn;
}): Promise<UserVideoGateResult> {
  const reject = (status: number, code: string, message: string): UserVideoGateResult => ({
    allowed: false,
    response: errorResponse({ status, code, message }),
  });
  if (input.hasBase64) {
    return reject(400, "video_reference_required", "Las llamadas de usuario deben analizar un vídeo guardado (videoId + videoUrl), no un fichero en el cuerpo.");
  }
  if (typeof input.videoId !== "string" || input.videoId.trim() === "" || typeof input.videoUrl !== "string") {
    return reject(400, "video_reference_required", "Falta videoId: el análisis debe referirse a un vídeo guardado.");
  }
  const endpoint = "agents/video-observation";
  const target = await resolveClipVideo({
    videoId: input.videoId,
    videoUrl: input.videoUrl,
    requireVideoRow: true,
    actor: input.actor,
    ownsVideo: input.ownsVideo,
    endpoint,
  });
  if (!target.ok) {
    if (target.code === "consent_check_failed") {
      return { allowed: false, response: clipConsentErrorResponse(blockedResult("consent_check_failed", input.locale, null)) };
    }
    return reject(target.status, target.code, target.message);
  }
  const video = target.video as VideoRowLite; // requireVideoRow ⇒ hay fila
  // Ámbito jugador sin jugador en el vídeo: no se puede comprobar al menor → no se analiza.
  if (input.scope === "player" && target.videoPlayerIds.length === 0) {
    return reject(400, "player_scope_requires_player_video", "El análisis por jugador solo se hace sobre un vídeo con jugador asignado.");
  }
  const gate = await enforceClipConsent({
    attestation: input.attestation,
    resource: target.resource,
    playerId: video.player_id,
    videoPlayerIds: target.videoPlayerIds,
    actor: input.actor,
    endpoint,
    scope: input.scope,
    locale: input.locale,
  });
  if (!gate.allowed) return { allowed: false, response: clipConsentErrorResponse(gate) };
  return { allowed: true, video };
}
