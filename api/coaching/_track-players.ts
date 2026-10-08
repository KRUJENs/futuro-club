/**
 * VITAS · /api/coaching/_track-players
 *
 * Edge proxy that forwards player-tracking requests to the Modal pipeline
 * defined in `vision-pipeline/app.py`.
 *
 * Env vars expected on Vercel:
 *   MODAL_TRACK_URL   — Modal HTTP endpoint for `track`
 *   MODAL_API_KEY     — bearer token (the one stored as a Modal secret)
 *
 * If either env var is missing the endpoint returns 503 so the client
 * can gracefully fall back to the mock pipeline (zero downtime).
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): en las
 * llamadas con JWT de USUARIO el servidor resuelve el vídeo por el GUID de la `videoUrl`
 * (fila `videos` propia obligatoria; el body no identifica jugador, así que se comprueba
 * el `player_id` de cada fila de ese vídeo) y exige la declaración del entrenador (body o
 * guardada con el vídeo) DESPUÉS de los 503/400 de siempre y ANTES del tripwire de gasto
 * y de Modal. Un bloqueo es 400/403/404/500, NUNCA 503 (el cliente trata 503 como
 * «inferencia apagada → mock»). Las llamadas de servicio no cambian. El contrato con
 * Modal (payload, Bearer MODAL_API_KEY) no cambia.
 */

import { withHandler } from "../_lib/withHandler";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = {
  runtime: "edge",
};

interface TrackingRequest {
  videoUrl: string;
  sampleFps?: number;
  classes?: number[];
  /** Duración del vídeo en segundos (el cliente la conoce del archivo). */
  durationSec?: number;
  /** Declaración del entrenador `{ accepted: true, version }` (llamadas de usuario). */
  attestation?: unknown;
}

/**
 * Techo de duración para el proxy SÍNCRONO. El runtime edge corta a ~25s y
 * Modal procesa a sample_fps → un vídeo largo (p.ej. 90 min) SIEMPRE haría
 * timeout, y hoy el cliente caía a mock silenciosamente (datos falsos).
 * Este guard rechaza el vídeo largo por adelantado (fail-fast, sin bloquear la
 * GPU) para que vaya por el flujo async (upload → cola). Configurable por env.
 */
const MAX_SYNC_TRACK_SEC = Number(process.env.MAX_SYNC_TRACK_SEC ?? 240);

interface ModalResponse {
  status: string;
  reason?: string;
  duration_sec: number;
  frames_processed: number;
  fps_source: number;
  sample_fps: number;
  players: Array<{
    track_id: number;
    timestamp_ms: number;
    bbox: number[];
    confidence: number;
    // V2 · identidad de equipo (color de camiseta). Opcional: Modal antiguo o
    // clips con <2 tracks no los rellenan → el cliente los trata como undefined.
    team?: string | null;
    team_color?: number[] | null;
  }>;
  ball: Array<{
    timestamp_ms: number;
    x: number;
    y: number;
    confidence: number;
  }>;
  ball_stops: Array<{
    start_ms: number;
    end_ms: number;
    avg_x: number;
    avg_y: number;
  }>;
  total_player_tracks: number;
  total_ball_detections: number;
  // V2 · leyenda de equipos {"team_a": [r,g,b], ...}. Opcional (compat.).
  teams?: Record<string, number[]>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Auth: solo usuarios autenticados (JWT) o llamadas internas con service token.
// Antes era un proxy público → cualquiera podía disparar GPU de pago en Modal.
export default withHandler(
  { method: ["POST"], requireAuth: true, allowServiceToken: true },
  async ({ body: ctxBody, userId, tenantId, isServiceCall, ip }): Promise<Response> => {
  const modalUrl = process.env.MODAL_TRACK_URL;
  const modalKey = process.env.MODAL_API_KEY;
  if (!modalUrl || !modalKey) {
    return json(
      {
        error: "real_inference_disabled",
        reason:
          "MODAL_TRACK_URL and MODAL_API_KEY are not configured. The client should fall back to the mock pipeline.",
      },
      503,
    );
  }

  const body = (ctxBody ?? {}) as TrackingRequest;
  if (!body.videoUrl) {
    return json({ error: "missing_fields", required: ["videoUrl"] }, 400);
  }

  // Consentimiento de las llamadas de USUARIO: tras los 503/400, antes de gastar.
  if (!isServiceCall) {
    const consent = await gateClipAnalysis({
      videoUrl: String(body.videoUrl), // Modal descargará ESTA URL
      requireVideoRow: true,
      attestation: body.attestation,
      playerId: null, // el body no identifica jugador; el de cada fila del vídeo sí cuenta
      actor: { userId, tenantId, ip },
      endpoint: "coaching/track-players",
      scope: "team",
      ownsVideo: (video, uid) => ownsVideo(video, uid),
      ownsPlayer: (pid, uid) => ownsPlayer(pid, uid),
    });
    if (!consent.allowed) return clipGateErrorResponse(consent);
  }

  // Tripwire de presupuesto (054): GPU Modal es la llamada más cara → corta si
  // el mes ya superó el tope. Fail-open si el ledger no está disponible.
  if (await isOverBudget()) return budgetExceededResponse();
  await recordSpendUsd("modal-track-sync");

  // GUARD: el proxy síncrono es SOLO para clips. Un vídeo largo haría timeout
  // en edge (~25s) → se rechaza por adelantado para que vaya por la cola async.
  if (typeof body.durationSec === "number" && body.durationSec > MAX_SYNC_TRACK_SEC) {
    return json(
      {
        error: "video_too_long_for_sync",
        maxSyncSec: MAX_SYNC_TRACK_SEC,
        durationSec: body.durationSec,
        hint: "Vídeo demasiado largo para tracking en vivo. Súbelo por el flujo de análisis completo (cola async); el proxy síncrono es solo para clips cortos.",
      },
      413,
    );
  }

  let modalResp: Response;
  try {
    modalResp = await fetch(modalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${modalKey}`,
      },
      body: JSON.stringify({
        video_url: body.videoUrl,
        sample_fps: body.sampleFps ?? 5,
        classes: body.classes ?? [0, 32],
      }),
    });
  } catch (err) {
    return json(
      { error: "modal_unreachable", detail: (err as Error).message },
      502,
    );
  }

  if (!modalResp.ok) {
    const detail = await modalResp.text().catch(() => "");
    return json(
      { error: "modal_error", status: modalResp.status, detail },
      modalResp.status,
    );
  }

  const data = (await modalResp.json()) as ModalResponse;

  if (data.status !== "ok") {
    return json({ error: "modal_processing_failed", detail: data.reason }, 500);
  }

  // Repackage to camelCase for the TS client
  return json({
    source: "modal",
    durationSec: data.duration_sec,
    framesProcessed: data.frames_processed,
    sourceFps: data.fps_source,
    sampleFps: data.sample_fps,
    players: data.players.map((p) => ({
      trackId: p.track_id,
      timestampMs: p.timestamp_ms,
      bbox: p.bbox,
      confidence: p.confidence,
      team: p.team ?? null,
      teamColor: p.team_color ?? null,
    })),
    ball: data.ball.map((b) => ({
      timestampMs: b.timestamp_ms,
      x: b.x,
      y: b.y,
      confidence: b.confidence,
    })),
    ballStops: data.ball_stops.map((s) => ({
      startMs: s.start_ms,
      endMs: s.end_ms,
      x: s.avg_x,
      y: s.avg_y,
    })),
    totalPlayerTracks: data.total_player_tracks,
    totalBallDetections: data.total_ball_detections,
    teams: data.teams ?? {},
  });
  },
);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
