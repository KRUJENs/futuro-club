/**
 * VITAS · Finalize Video Upload
 * POST /api/videos/finalize
 *
 * Llamado por el frontend tras completar el upload TUS a Bunny, en el momento en que
 * el jugador YA se conoce (en el Lab la subida no lleva jugador; se elige al analizar).
 *
 * Hace, server-side:
 *   1. Comprueba el status del vídeo en Bunny (encoded ready = 4).
 *   2. SIEMBRA en `videos` las columnas que el pipeline necesita —bunny_video_id,
 *      player_id, tenant_id (resuelto del jugador; el cliente solo tiene org_id),
 *      duration_sec, played_position— con check de OWNERSHIP (anti-IDOR de menor ajeno).
 *   3. Gate honesto: un vídeo más largo que SYNC_ANALYSIS_MAX_DURATION_SEC (partido
 *      completo) NO se encola en la cola Gemini de clips cortos → 422
 *      `video_too_long_for_sync_analysis` con la duración real (el cliente lo traduce).
 *   4. Encola el análisis IN-PROCESS (impl compartida con el webhook, inv #7).
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): justo tras
 * la propiedad, ANTES de tocar Bunny, se exige la declaración del entrenador (la del
 * body `attestation` —se guarda con el vídeo— o una ya guardada) y, si hay un menor de 14
 * conocido, su consentimiento parental verificado. Los jugadores que cuentan son el
 * elegido al analizar Y el `player_id` de CADA fila `videos` de ese vídeo de Bunny (el
 * elegido nunca sustituye al del vídeo; B1), y todas esas filas tienen que ser del
 * usuario (B2: otra fila ajena con el mismo GUID → 403). Sin ello: 400/403/500 con el
 * código, sin sembrar ni encolar. Así un vídeo subido antes pide la declaración al
 * re-analizarlo (la UI nunca la marca sola).
 *
 * Antes disparaba el webhook por HTTP SIN firma → el webhook fail-closed lo rechazaba
 * siempre (503/401) y el análisis nunca se encolaba, pero respondía ready:true → la UI
 * hacía polling 5 min y moría en timeout. Eso queda corregido.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { ownsVideo, ownsPlayer } from "../_lib/ownership";
import { enqueueAnalysis } from "../_lib/enqueueAnalysis";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { BUNNY_API_VIDEO_STATUS, getBunnyVideo } from "../_lib/bunnyStream";
import { localeSchema, normalizeLocale } from "../../src/lib/shared/locale";
import {
  evaluateSyncAnalysisGate,
  knownDurationSec,
  SYNC_ANALYSIS_GATE_CODE,
  SYNC_ANALYSIS_MAX_DURATION_MIN,
  durationMinutesForDisplay,
} from "../../src/lib/shared/videoLimits";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID ?? "";
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY ?? "";
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;
const CRON_SECRET = process.env.CRON_SECRET ?? "";

const finalizeSchema = z.object({
  videoId: z.string().min(1),
  bunnyVideoId: z.string().min(1),
  playerId: z.string().min(1).optional(),      // jugador elegido al analizar (Lab)
  playedPosition: z.string().optional(),        // posición jugada en este video
  /** Idioma de la UI del usuario → informes en ese idioma (mig 064; registry-driven). */
  locale: localeSchema.optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (se valida en el gate, no aquí). */
  attestation: z.unknown().optional(),
});

export default withHandler(
  { schema: finalizeSchema, requireAuth: true, maxRequests: 30 },
  async ({ body, userId, tenantId, isServiceCall, ip }) => {
    const input = body as z.infer<typeof finalizeSchema>;

    if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) {
      return errorResponse({ code: "bunny_not_configured", message: "Bunny no configurado", status: 503 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Verificar que el video existe (+ leer dueño y lo que ya tenga)
    const { data: video } = await supabase
      .from("videos")
      .select("id, bunny_video_id, player_id, tenant_id, user_id, duration_sec")
      .eq("id", input.videoId)
      .single();

    if (!video) {
      return errorResponse({ code: "video_not_found", message: "Video no existe", status: 404 });
    }

    const vrow = video as {
      id: string;
      bunny_video_id?: string | null;
      player_id?: string | null;
      tenant_id?: string | null;
      user_id?: string | null;
      duration_sec?: number | null;
    };

    // ── AUTORIZACIÓN A NIVEL DE OBJETO (anti-IDOR de menores) ────────────────
    // finalize MUTA una fila `videos` EXISTENTE (siembra bunny_video_id/player_id/
    // tenant_id y encola un análisis). Sin esto, un autenticado A podía finalizar el
    // vídeo de otro tenant B (por id), atribuirlo a un jugador PROPIO y procesar el
    // contenido de Bunny de un menor ajeno. Fail-closed vía ownsVideo (inv #7: el mismo
    // helper que identify-player/candidates; autoriza por uploader o dueño del jugador
    // del vídeo — nunca por tenant, 076).
    if (!(await ownsVideo(vrow, userId, isServiceCall))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este vídeo", status: 403 });
    }

    // El bunnyVideoId del cliente NO es de fiar: si la fila ya tiene uno grabado, debe
    // coincidir — nunca se sobreescribe con lo que mande el cliente (evita apuntar la
    // fila a un GUID de Bunny ajeno).
    if (vrow.bunny_video_id && vrow.bunny_video_id !== input.bunnyVideoId) {
      return errorResponse({ code: "bunny_id_mismatch", message: "bunnyVideoId no coincide con el vídeo", status: 403 });
    }

    // Jugador: el que llega al analizar, o el que ya tuviera la fila.
    const playerId: string | null = input.playerId ?? vrow.player_id ?? null;

    // Ownership + tenant SIEMPRE server-side (el cliente no conoce el tenant_id del
    // jugador). Fail-closed: no eres el DUEÑO del jugador → 403, sin sembrar ni
    // encolar (076: nunca por tenant). El tenant_id solo se copia como etiqueta de la
    // fila (analyses.tenant_id es NOT NULL); ya no da acceso a nadie.
    let resolvedTenantId: string | null = vrow.tenant_id ?? tenantId ?? null;
    if (playerId) {
      if (!isServiceCall && !(await ownsPlayer(playerId, userId))) {
        return errorResponse({ code: "forbidden", message: "No gestionas este jugador", status: 403 });
      }
      const { data: player } = await supabase
        .from("players")
        .select("tenant_id")
        .eq("id", playerId)
        .single();
      if (player?.tenant_id) resolvedTenantId = player.tenant_id as string;
    }

    // ── Consentimiento ANTES de tocar Bunny (se guarda la declaración del body) ──
    // GUID = el de la fila o, si aún no tiene, el que se va a sembrar (el del cliente).
    const consent = await gateClipAnalysis({
      videoId: video.id,
      bunnyGuid: vrow.bunny_video_id ?? input.bunnyVideoId,
      requireVideoRow: true,
      seedRow: true, // una fila aún sin GUID se siembra abajo con el del cliente
      attestation: input.attestation,
      playerId,
      actor: { userId, tenantId, ip },
      endpoint: "videos/finalize",
      scope: playerId ? "player" : "team",
      locale: input.locale,
      ownsVideo: (v, uid) => ownsVideo(v, uid, isServiceCall),
    });
    if (!consent.allowed) return clipGateErrorResponse(consent);

    // Idioma del usuario en la fila `videos` (mig 064) — se escribe AQUÍ, ANTES del
    // gate de Bunny-ready. Motivo (carrera): el cliente sondea `finalize` mientras
    // Bunny codifica; la PRIMERA llamada suele caer en "not ready" y sale antes. Pero
    // el webhook de Bunny (servidor-a-servidor, sin usuario) dispara justo al terminar
    // la codificación y encola leyendo `videos.locale`. Si el idioma se escribiera
    // después del gate, el webhook podría encolar con locale=null → informes en
    // español. Escribirlo en el primer `finalize` (antes de que exista el vídeo
    // codificado) garantiza que el webhook lo vea. Best-effort: si la mig 064 aún no
    // está aplicada, el update falla sin tumbar el resto (locale se degrada a "es").
    if (input.locale) {
      await supabase.from("videos").update({ locale: normalizeLocale(input.locale) }).eq("id", video.id);
    }

    // Status del vídeo en Bunny (enum de la API REST: 4 = Finished, 5 = Error)
    const bunnyStatus = await getBunnyVideo({
      libraryId: BUNNY_LIBRARY_ID,
      apiKey: BUNNY_API_KEY,
      videoGuid: input.bunnyVideoId,
    });
    if (!bunnyStatus) {
      return errorResponse({ code: "bunny_query_failed", message: "No se pudo consultar Bunny", status: 502 });
    }

    if (bunnyStatus.status === BUNNY_API_VIDEO_STATUS.ERROR) {
      return errorResponse({ code: "bunny_encoding_failed", message: "Bunny falló encoding", status: 422 });
    }

    if (bunnyStatus.status !== BUNNY_API_VIDEO_STATUS.FINISHED) {
      return successResponse({
        ready: false,
        status: bunnyStatus.status,
        message: "Vídeo aún en procesamiento, reintentar en 5-10 segundos",
        retryAfterSec: 5,
      });
    }

    // ── Sembrar en `videos` las columnas del pipeline (solo lo que aporte valor) ──
    const updateData: Record<string, unknown> = { bunny_video_id: input.bunnyVideoId };
    if (playerId) updateData.player_id = playerId;
    if (resolvedTenantId) updateData.tenant_id = resolvedTenantId;
    if (bunnyStatus.length > 0) updateData.duration_sec = bunnyStatus.length;
    if (input.playedPosition) updateData.played_position = input.playedPosition;
    await supabase.from("videos").update(updateData).eq("id", video.id);

    // ── Gate honesto ANTES de encolar: la cola Gemini es de CLIPS CORTOS ────────
    // video-observation descarga el fichero entero dentro de una función de 120 s → un
    // partido completo fallaría tras gastar cómputo. Se rechaza con un código que el
    // cliente traduce (7 idiomas). Duración REAL (Bunny, o la de la fila — metadatos del
    // navegador vía video-init); si no se conoce, no se bloquea y no se inventa.
    const gate = evaluateSyncAnalysisGate(knownDurationSec(bunnyStatus.length, vrow.duration_sec));
    if (!gate.allowed) {
      return errorResponse({
        code: SYNC_ANALYSIS_GATE_CODE,
        message:
          `El vídeo dura ${durationMinutesForDisplay(gate.durationSec)} min y el análisis rápido admite ` +
          `hasta ${SYNC_ANALYSIS_MAX_DURATION_MIN} min. El análisis de partido completo llegará con el ` +
          `nuevo análisis de partido; el vídeo queda guardado.`,
        status: 422,
        details: { durationSec: gate.durationSec, maxDurationSec: gate.maxDurationSec },
      });
    }

    // ── Encolar el análisis (idempotente, impl compartida con el webhook) ──
    const result = await enqueueAnalysis({
      supabase,
      videoId: video.id,
      tenantId: resolvedTenantId,
      playerId,
      playedPosition: input.playedPosition ?? null,
      locale: input.locale ? normalizeLocale(input.locale) : null,
      publicUrl: PUBLIC_URL,
      cronSecret: CRON_SECRET,
      endpoint: "videos/finalize",
    });

    if (result.status === "error") {
      return errorResponse({ code: "enqueue_failed", message: result.error, status: 500 });
    }
    if (result.status === "blocked") {
      return clipGateErrorResponse({
        allowed: false,
        code: result.code,
        status: result.httpStatus,
        gate_reason: result.gate_reason,
        minor: null,
      });
    }
    if (result.status === "skipped") {
      // Sin jugador atado: el vídeo queda almacenado, pero no hay análisis por jugador.
      return successResponse({
        ready: true,
        queued: false,
        videoId: video.id,
        reason: result.reason,
        message: "Vídeo listo. Elige un jugador para generar su informe.",
      });
    }

    const analysisId = result.analysisId;
    return successResponse({
      ready: true,
      queued: true,
      videoId: video.id,
      analysisId,
      alreadyQueued: result.status === "exists",
      message: "Vídeo listo · análisis encolado · ETA ~2 minutos",
    });
  }
);
