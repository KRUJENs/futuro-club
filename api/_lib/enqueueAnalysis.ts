/**
 * VITAS · enqueueAnalysis — encola un análisis de vídeo (idempotente)
 *
 * Una sola implementación (invariante #7) compartida por:
 *   - api/webhooks/bunny-uploaded.ts  (webhook real de Bunny, encode-complete)
 *   - api/videos/finalize.ts          (finalize del Lab / flujo A, in-process)
 *
 * Crea la fila `analyses` con status='queued' si no existe ya una activa para ese
 * vídeo, y dispara el cron de procesamiento de forma inmediata (best-effort). El
 * cron diario queda de backstop.
 *
 * GUARDA CRÍTICA: `analyses.player_id` es NOT NULL + FK a players. Sin playerId NO se
 * encola (un vídeo sin jugador atado no produce análisis). Sin tenantId tampoco: se
 * rompería el aislamiento multi-tenant de datos de menores (analyses.tenant_id null).
 *
 * CONSENTIMIENTO (decisión del owner, 30 sep): antes de crear un análisis NUEVO se exige
 * una declaración del entrenador YA GUARDADA para este vídeo y, si hay un menor de 14
 * conocido —el jugador del análisis o el `player_id` de cualquier fila `videos` de ese
 * vídeo de Bunny (gateClipAnalysis, B1)—, su consentimiento parental verificado
 * (api/_lib/analysisConsentGate). Este helper no acepta declaraciones del body (lo llama
 * el webhook de Bunny, sin usuario): finalize guarda la del body ANTES de llamarlo.
 * Bloqueado → `status: "blocked"` (webhook: 200 skipped · finalize: 400/403/404/500 con
 * el código).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { gateClipAnalysis, type ClipAnalysisGateResult } from "./analysisConsentGate";

export interface EnqueueAnalysisInput {
  supabase: SupabaseClient;
  videoId: string;
  tenantId: string | null;
  playerId: string | null;
  playedPosition?: string | null;
  /**
   * Idioma pedido para los informes (código del LANGUAGE_REGISTRY, ya normalizado).
   * Se persiste en `analyses.locale` (mig 064) porque el orquestador, cuando lo
   * dispara el cron o modal-callback, solo recibe { analysisId } y no puede saber el
   * idioma de otra forma. Null → el orquestador degrada a "es".
   */
  locale?: string | null;
  /** Base URL para disparar el cron (VITAS_PUBLIC_URL / VERCEL_URL). */
  publicUrl: string;
  /** CRON_SECRET: si falta, no se dispara el cron (el cron diario recogerá la cola). */
  cronSecret: string;
  /** Quién llama (queda en el log del gate). */
  endpoint?: string;
  /** Inyectable en tests; por defecto el gate real. */
  checkConsent?: (input: Parameters<typeof gateClipAnalysis>[0]) => Promise<ClipAnalysisGateResult>;
}

export type EnqueueAnalysisResult =
  | { status: "queued"; analysisId: string; triggered: boolean }
  | { status: "exists"; analysisId: string }
  | { status: "skipped"; reason: string }
  /** `code`: un ClipConsentCode o un código de resolución del vídeo (p. ej. video_not_found). */
  | { status: "blocked"; code: string; httpStatus: number; gate_reason: string }
  | { status: "error"; error: string };

export async function enqueueAnalysis(input: EnqueueAnalysisInput): Promise<EnqueueAnalysisResult> {
  const { supabase, videoId, tenantId, playerId, playedPosition, locale, publicUrl, cronSecret } = input;

  // Sin jugador o sin tenant → NO se encola (FK NOT NULL + RLS de menores).
  if (!playerId) return { status: "skipped", reason: "no_player" };
  if (!tenantId) return { status: "skipped", reason: "no_tenant" };

  // Idempotencia por (vídeo, JUGADOR): un mismo vídeo analizado para OTRO jugador es su
  // propio análisis. Sin el filtro player_id, el análisis del jugador A bloqueaba el
  // encolado del jugador B (mismo vídeo) — y con varios análisis del mismo vídeo,
  // `.maybeSingle()` recibía >1 fila y erroraba. Incluye 'processing_reports' (Gemini
  // hecho, informes en curso): también es activo → no re-encolar (evita el duplicado en
  // la carrera webhook-Bunny vs finalize durante la fase de informes).
  const { data: existing } = await supabase
    .from("analyses")
    .select("id, status")
    .eq("video_id", videoId)
    .eq("player_id", playerId)
    .in("status", ["queued", "processing", "processing_reports", "completed"])
    .maybeSingle();

  if (existing) return { status: "exists", analysisId: existing.id };

  // Gate de consentimiento ANTES de crear el análisis (solo declaración GUARDADA). Ruta
  // sin usuario: la propiedad la comprobó finalize / la firma del webhook.
  const consent = await (input.checkConsent ?? gateClipAnalysis)({
    videoId,
    requireVideoRow: true,
    storedOnly: true,
    playerId,
    actor: { userId: null, tenantId },
    endpoint: input.endpoint ?? "enqueueAnalysis",
    scope: "player",
    locale,
    ownsVideo: null,
    ownsPlayer: null,
  });
  if (!consent.allowed) {
    return { status: "blocked", code: consent.code, httpStatus: consent.status, gate_reason: consent.gate_reason };
  }

  const baseRow = {
    tenant_id: tenantId,
    player_id: playerId,
    video_id: videoId,
    status: "queued",
    pipeline_version: "v1.0",
    played_position: playedPosition ?? null,
  };

  // Idioma en la fila (mig 064) para que el orquestador lo lea. DEFENSIVO frente al
  // orden de despliegue: si la migración aún no está aplicada, PostgREST rechaza la
  // columna desconocida (PGRST204 / "schema cache") → reintentamos SIN locale para
  // no romper el encolado (los informes saldrían en "es", como antes de 064).
  let { data: analysis, error } = await supabase
    .from("analyses")
    .insert(locale ? { ...baseRow, locale } : baseRow)
    .select("id")
    .single();

  if (error && locale && /locale|PGRST204|schema cache/i.test(error.message ?? "")) {
    ({ data: analysis, error } = await supabase
      .from("analyses")
      .insert(baseRow)
      .select("id")
      .single());
  }

  if (error || !analysis) {
    return { status: "error", error: error?.message ?? "insert_failed" };
  }

  // Dispara el procesamiento inmediato (fire-and-forget). Sin CRON_SECRET, el cron
  // diario (vercel.json) recoge la cola como backstop.
  let triggered = false;
  if (cronSecret) {
    triggered = true;
    void fetch(`${publicUrl}/api/crons/process-analyses-queue`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cronSecret}` },
    }).catch((err) => console.error("[enqueueAnalysis] trigger de cola falló:", err));
  }

  return { status: "queued", analysisId: analysis.id, triggered };
}
