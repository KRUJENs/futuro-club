/**
 * VITAS Phase 2 — Bunny Stream Video Init
 * POST /api/upload/video-init
 *
 * Flow: Client calls this → we create a Bunny video entry → return signed TUS
 * credentials. Client then uploads DIRECTLY to Bunny (bypasses Vercel 4.5MB body limit).
 *
 * Además (fase 0 partido completo) SIEMBRA la fila `videos` server-side:
 *   - con el JWT del USUARIO vía PostgREST (NO service role): el trigger
 *     auto_assign_org_id (mig 038) usa auth.uid() y la RLS de insert exige
 *     user_id = auth.uid() → con service role el org_id quedaría NULL.
 *   - id = bunny_video_id = GUID de Bunny (misma convención que el cliente:
 *     useVideoUpload usa el GUID como id del VideoRecord y pushOne hace upsert por id).
 *   - tenant_id del JWT verificado (etiqueta, no da acceso); player_id SOLO si el
 *     usuario es el DUEÑO del jugador (RLS + players.user_id = usuario, 076).
 *   - duration_sec SOLO si el navegador la leyó de los metadatos (nunca un default).
 *   Así el webhook de Bunny encuentra la fila por bunny_video_id aunque el cliente
 *   cierre la pestaña antes de su upsert. Sin Supabase configurado → se omite (no rompe).
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): el webhook
 * de Bunny encola el análisis SOLO con la subida, así que la declaración se exige AQUÍ:
 *   - sin `attestation` vigente → 400 attestation_required, sin crear nada en Bunny;
 *   - jugador (visible bajo RLS) menor de 14 conocido sin consentimiento parental
 *     verificado → 403 parental_consent_required, sin crear nada;
 *   - con Bunny creado, la declaración se guarda con el GUID (= id de la fila `videos`);
 *     si no se puede guardar → 500 consent_check_failed y se borra el vídeo de Bunny
 *     (best-effort): no queda un vídeo que el webhook analizaría sin declaración.
 *
 * Env vars needed (Vercel):
 *   BUNNY_STREAM_LIBRARY_ID  — numeric Library ID from Bunny dashboard
 *   BUNNY_STREAM_API_KEY     — library-level API key (AccessKey)
 *   VITE_SUPABASE_URL / SUPABASE_URL + VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY (opcional)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse, degradedResponse } from "../_lib/apiResponse";
import { signTusUpload } from "../_lib/bunnyStream";
import {
  checkMatchDuration,
  durationMinutesForDisplay,
  MATCH_DURATION_GATE_CODE,
  MAX_MATCH_DURATION_MIN,
} from "../../src/lib/shared/videoLimits";
import { enforceClipConsent, recordClipAttestation, clipConsentErrorResponse } from "../_lib/analysisConsentGate";
import { deleteBunnyVideos } from "../_lib/bunnyCleanup";
import { CLIP_ATTESTATION_VERSION, CLIP_CONSENT_HTTP_STATUS, clipConsentGateReason } from "../../src/lib/shared/videoConsent";

const BodySchema = z.object({
  title: z.string().min(1).max(200),
  playerId: z.string().optional(),
  collection: z.string().optional(), // Bunny collection GUID (optional)
  /** Duración leída de los metadatos del NAVEGADOR (s). Opcional: si no se leyó, no viene. */
  durationSec: z.number().positive().finite().optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (se valida en el gate). */
  attestation: z.unknown().optional(),
});

const BUNNY_BASE = "https://video.bunnycdn.com/library";

type VideoRowResult = "inserted" | "skipped" | "failed";

function userRest(userJwt: string | null): { sbUrl: string; authHeaders: Record<string, string> } | null {
  const sbUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";
  if (!sbUrl || !anonKey || !userJwt) return null;
  return { sbUrl, authHeaders: { apikey: anonKey, Authorization: `Bearer ${userJwt}` } };
}

/**
 * player_id solo si ESTE usuario es el DUEÑO del jugador (no se adjuntan vídeos a menores
 * ajenos). La FK a players no aplica RLS → este check es obligatorio. Además de la RLS, se
 * filtra por user_id = el usuario del JWT verificado (076): así vale aunque la RLS de
 * players de la base aún tenga una rama por tenant u organización (players_tenant_isolation
 * de 003 / 038) que dejaría «ver» al jugador de otra cuenta. Se resuelve ANTES de crear
 * nada: el gate de consentimiento necesita saber qué jugador lleva el vídeo.
 */
async function resolveVisiblePlayerId(
  userJwt: string | null,
  userId: string | null,
  playerId: string | undefined,
): Promise<string | null> {
  const rest = userRest(userJwt);
  if (!rest || !playerId || !userId) return null;
  try {
    const pRes = await fetch(
      `${rest.sbUrl}/rest/v1/players?id=eq.${encodeURIComponent(playerId)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      { headers: rest.authHeaders },
    );
    if (!pRes.ok) return null;
    const rows = (await pRes.json().catch(() => [])) as Array<{ id?: string }>;
    return Array.isArray(rows) && rows.some((r) => r?.id === playerId) ? playerId : null;
  } catch {
    return null;
  }
}

/**
 * Inserta la fila `videos` con el JWT del usuario (RLS + trigger de org con auth.uid()).
 * Best-effort: cualquier fallo se registra y NO rompe la subida (el cliente sigue
 * pudiendo crear la fila con su upsert; el webhook solo la necesita para encolar).
 */
async function insertVideoRow(opts: {
  userJwt: string | null;
  userId: string;
  tenantId: string | null;
  guid: string;
  title: string;
  /** Ya comprobado: el usuario es su dueño (resolveVisiblePlayerId). */
  safePlayerId: string | null;
  durationSec: number | null;
}): Promise<VideoRowResult> {
  const rest = userRest(opts.userJwt);
  if (!rest) return "skipped";
  const { sbUrl, authHeaders } = rest;
  const safePlayerId = opts.safePlayerId;

  try {
    const nowIso = new Date().toISOString();
    // `data` = stub mínimo con SOLO lo conocido (pullAll del cliente lee row.data).
    // Sin duration/width/height/fps a 0: no se sabe todavía (invariante #2).
    const dataStub = {
      id: opts.guid,
      title: opts.title,
      playerId: safePlayerId,
      status: "created",
      statusCode: 0,
      encodeProgress: 0,
      thumbnailUrl: null,
      embedUrl: "",
      streamUrl: null,
      dateUploaded: nowIso,
      analysisResult: null,
    };

    const row: Record<string, unknown> = {
      id: opts.guid,
      user_id: opts.userId,
      bunny_video_id: opts.guid,
      title: opts.title,
      status: "created",
      status_code: 0,
      date_uploaded: nowIso,
      data: dataStub,
    };
    if (opts.tenantId) row.tenant_id = opts.tenantId;
    if (safePlayerId) row.player_id = safePlayerId;
    if (opts.durationSec !== null) row.duration_sec = opts.durationSec;

    const res = await fetch(`${sbUrl}/rest/v1/videos`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[video-init] insert videos ${res.status}: ${txt.slice(0, 200)}`);
      return "failed";
    }
    return "inserted";
  } catch (err) {
    console.warn("[video-init] insert videos falló (best-effort):", err);
    return "failed";
  }
}

export default withHandler(
  { method: "POST", schema: BodySchema, requireAuth: true, maxRequests: 10 },
  async ({ req, body, userId, tenantId, ip }) => {
    const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
    const apiKey = process.env.BUNNY_STREAM_API_KEY ?? process.env.BUNNY_API_KEY;

    // Degradación elegante: sin almacenamiento en la nube configurado, el cliente
    // procesa el vídeo LOCALMENTE (el análisis de visión corre en el navegador).
    // Devolvemos 200 + { success:false, phase2Pending:true } a nivel raíz — el contrato
    // que useVideoUpload ya consume — en vez de un 503 con jerga: NUNCA exponemos
    // nombres de variables de entorno al usuario final.
    if (!libraryId || !apiKey) {
      return degradedResponse({ phase2Pending: true });
    }

    const { title, playerId, collection } = body;
    const durationSec = body.durationSec ?? null;

    // Mismo gate de duración que el cliente (límite compartido · inv #7). Solo aplica si
    // el navegador leyó la duración; si no, no se bloquea ni se inventa.
    const durationGate = checkMatchDuration(durationSec);
    if (!durationGate.allowed) {
      return errorResponse({
        code: MATCH_DURATION_GATE_CODE,
        message: `El vídeo dura ${durationMinutesForDisplay(durationGate.durationSec)} min; el máximo es ${MAX_MATCH_DURATION_MIN} min.`,
        status: 422,
        details: { durationSec: durationGate.durationSec, maxDurationSec: durationGate.maxDurationSec },
      });
    }

    // Step 0: consentimiento ANTES de crear nada (el webhook de Bunny analiza solo con la
    // subida). La declaración se GUARDA tras crear el vídeo (su id es el GUID de Bunny).
    const authHeader = req.headers.get("Authorization") ?? "";
    const userJwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() || null : null;
    const safePlayerId = await resolveVisiblePlayerId(userJwt, userId, playerId);
    const actor = { userId, tenantId, ip };
    const consent = await enforceClipConsent({
      attestation: body.attestation,
      lookupStored: false, // vídeo nuevo: la declaración tiene que venir en ESTA petición
      resource: { type: "videos", id: "pending" },
      playerId: safePlayerId,
      actor,
      endpoint: "upload/video-init",
      record: false,
    });
    if (!consent.allowed) return clipConsentErrorResponse(consent);

    // Step 1: Create video entry in Bunny Stream
    const createPayload: Record<string, string> = { title };
    if (collection) createPayload.collectionId = collection;

    const createRes = await fetch(`${BUNNY_BASE}/${libraryId}/videos`, {
      method: "POST",
      headers: {
        AccessKey: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createPayload),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      console.warn(`[video-init] Bunny Stream API ${createRes.status}: ${errText || "sin cuerpo"}`);
      return errorResponse(
        `Almacenamiento de vídeo no disponible temporalmente (${createRes.status}). Inténtalo de nuevo en unos minutos.`,
        502,
        "BUNNY_ERROR",
      );
    }

    const video = (await createRes.json()) as { guid: string; title: string };

    // Step 1b: guardar la declaración CON el vídeo (quién = JWT, cuándo = reloj de la base,
    // versión). Sin ella el vídeo no puede existir: se borra de Bunny y se responde 500.
    try {
      if (!consent.pendingAttestation) throw new Error("no pending attestation");
      await recordClipAttestation({
        attestation: consent.pendingAttestation,
        resource: { type: "videos", id: video.guid, bunnyVideoId: video.guid },
        actor,
        playerId: safePlayerId,
        endpoint: "upload/video-init",
      });
    } catch (err) {
      console.error("[video-init] no se pudo guardar la declaración → se borra el vídeo de Bunny:", err instanceof Error ? err.message : err);
      await deleteBunnyVideos([video.guid]).catch(() => null);
      const gate_reason = clipConsentGateReason(null, "consent_check_failed");
      return errorResponse({
        message: gate_reason,
        status: CLIP_CONSENT_HTTP_STATUS.consent_check_failed,
        code: "consent_check_failed",
        details: { gate_reason, attestationVersion: CLIP_ATTESTATION_VERSION },
      });
    }

    // Step 2: Firma TUS válida 24 h (Bunny valida AuthorizationExpire en CADA
    // POST/HEAD/PATCH y re-firmar NO extiende la caducidad del recurso → la ventana
    // debe cubrir la subida completa de un partido). Helper compartido con create-upload.
    const { signature, expire } = await signTusUpload({
      libraryId,
      apiKey,
      videoGuid: video.guid,
    });

    // Step 3: fila `videos` con el JWT del usuario (best-effort, ver insertVideoRow).
    const videoRow = await insertVideoRow({
      userJwt,
      userId: userId as string,
      tenantId,
      guid: video.guid,
      title: video.title ?? title,
      safePlayerId,
      durationSec,
    });

    // Return upload credentials — use signed auth, NEVER expose raw API key
    return successResponse({
      videoId:        video.guid,
      libraryId:      Number(libraryId),
      uploadUrl:      `${BUNNY_BASE}/${libraryId}/videos/${video.guid}`,
      authSignature:  signature,
      authExpire:     expire,
      title:          video.title,
      playerId:       playerId ?? null,
      cdnHostname:    process.env.BUNNY_CDN_HOSTNAME ?? process.env.VITE_BUNNY_CDN_HOSTNAME ?? null,
      videoRow,
    });
  },
);

export const config = { runtime: "edge" };
