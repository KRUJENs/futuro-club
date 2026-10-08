/**
 * VITAS · Live Match Aggregation (Sprint B2 · día 4)
 * POST /api/live/aggregate?matchId=<id>
 *
 * Llamado al pitido final. Agrega los live_events del partido por
 * jugador y por equipo, luego llama a Claude para generar 3 reportes:
 *
 *   - team-summary  (Sonnet): resumen del partido + MVP + próximo foco
 *   - per-player    (Haiku):  insights individuales con stats agregadas
 *   - tactical-take (Haiku):  qué funcionó, qué no, ajuste para próximo
 *
 * Persiste el resultado en live_matches.analysis_result (jsonb) para
 * que la summary page lo muestre sin volver a pagar Claude.
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): el vídeo
 * del partido SOLO se manda a Gemini si es una fila `videos` con la declaración del
 * entrenador guardada (VideoUpload la pide al subirlo). Si no, se omite SOLO la
 * observación del vídeo (el informe de eventos sigue) y el resultado lo declara:
 * `has_video: false` + `video_consent_gate: { code, gate_reason }`.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { createClient } from "@supabase/supabase-js";
import { normalizeLocale, languageDirective } from "../../src/lib/shared/locale";
import { isAllowedVideoUrl } from "../_lib/videoUrlGuard";
import { enforceStoredConsentForVideoUrl } from "../_lib/analysisConsentGate";
import { ownsVideo } from "../_lib/ownership";

// Node.js runtime for Gemini video analysis (up to 120s)
export const config = { runtime: "nodejs", maxDuration: 120 };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

const PIPELINE_VERSION = "live-aggregate-v2.0";
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? process.env.CRON_SECRET ?? "";

interface PlayerStats {
  playerId: string | null;
  playerName: string;
  goles: number;
  pases_clave: number;
  recuperaciones: number;
  perdidas: number;
  duelos_ganados: number;
  duelos_perdidos: number;
  asistencias: number;
  tarjetas: number;
  totalEvents: number;
  netImpact: number;       // suma ponderada
}

const EVENT_WEIGHTS: Record<string, number> = {
  gol: +5,
  asistencia: +4,
  pase_clave: +2,
  recuperacion: +1.5,
  duelo_ganado: +1,
  parada_portero: +2,
  penalti_provocado: +3,
  perdida: -1,
  duelo_perdido: -1,
  tarjeta_amarilla: -1,
  tarjeta_roja: -3,
  penalti_cometido: -3,
};

async function callClaude(opts: {
  model: typeof MODELS[keyof typeof MODELS];
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<Record<string, unknown>> {
  const res = await fetchMessages({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      ...modelParams(opts.model, opts.maxTokens ?? 1500),
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = responseText(data) || "{}";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { _raw: raw, _parseError: true }; }
}

function aggregateByPlayer(
  events: Array<{ player_id: string | null; event_type: string }>,
  playerNames: Map<string, string>,
): PlayerStats[] {
  const byPlayer = new Map<string, PlayerStats>();

  for (const e of events) {
    const pid = e.player_id ?? "_team";
    if (!byPlayer.has(pid)) {
      byPlayer.set(pid, {
        playerId: e.player_id,
        playerName: e.player_id ? (playerNames.get(e.player_id) ?? "?") : "Equipo (sin asignar)",
        goles: 0, pases_clave: 0, recuperaciones: 0, perdidas: 0,
        duelos_ganados: 0, duelos_perdidos: 0, asistencias: 0, tarjetas: 0,
        totalEvents: 0, netImpact: 0,
      });
    }
    const s = byPlayer.get(pid)!;
    s.totalEvents++;
    s.netImpact += EVENT_WEIGHTS[e.event_type] ?? 0;

    switch (e.event_type) {
      case "gol":             s.goles++; break;
      case "asistencia":      s.asistencias++; break;
      case "pase_clave":      s.pases_clave++; break;
      case "recuperacion":    s.recuperaciones++; break;
      case "perdida":         s.perdidas++; break;
      case "duelo_ganado":    s.duelos_ganados++; break;
      case "duelo_perdido":   s.duelos_perdidos++; break;
      case "tarjeta_amarilla":
      case "tarjeta_roja":    s.tarjetas++; break;
    }
  }

  return Array.from(byPlayer.values()).sort((a, b) => b.netImpact - a.netImpact);
}

async function analyzeMatchVideo(
  videoUrl: string,
  teamName: string,
  opponentName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${PUBLIC_URL}/api/agents/video-observation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        videoUrl,
        // Observación de EQUIPO del partido: sin identificar a jugadores y sin
        // edad/posición inventadas (antes 13 / "MID" / "formativo" por defecto).
        analysisScope: "team",
        playerContext: { name: `${teamName} vs ${opponentName}` },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data?.observations as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

function buildVideoSection(obs: Record<string, unknown>): string {
  const lines: string[] = ["\n─── ANÁLISIS DE VÍDEO DEL PARTIDO (Gemini) ───"];

  const resumen = obs.resumenGeneral as string | undefined;
  if (resumen) lines.push(`Resumen visual: ${resumen}`);

  const patrones = obs.patronesJuego as string[] | undefined;
  if (patrones?.length) {
    lines.push("Patrones observados (ambos equipos):");
    patrones.forEach((p) => lines.push(`  • ${p}`));
  }

  const dims = obs.dimensiones as Record<string, { observaciones?: string[]; score_estimado?: number }> | undefined;
  if (dims) {
    lines.push("Dimensiones evaluadas:");
    for (const [key, val] of Object.entries(dims)) {
      if (val?.score_estimado != null) {
        lines.push(`  ${key}: ${val.score_estimado}/10`);
        val.observaciones?.slice(0, 2).forEach((o) => lines.push(`    - ${o}`));
      }
    }
  }

  const destacados = obs.momentosDestacados as Array<{ timestamp?: string; tipo?: string; descripcion?: string }> | undefined;
  if (destacados?.length) {
    lines.push("Momentos clave del video:");
    destacados.slice(0, 6).forEach((m) =>
      lines.push(`  [${m.timestamp ?? "?"}] ${m.tipo ?? ""}: ${m.descripcion ?? ""}`)
    );
  }

  const eventos = obs.eventosContados as Record<string, number> | undefined;
  if (eventos && Object.keys(eventos).length > 0) {
    lines.push("Conteo de eventos (video):");
    for (const [k, v] of Object.entries(eventos)) {
      if (v > 0) lines.push(`  ${k}: ${v}`);
    }
  }

  lines.push("\nIMPORTANTE: Usa estas observaciones de vídeo para analizar AMBOS equipos.");
  lines.push("Incluye insights sobre el equipo local Y el rival basados en lo observado.");

  return lines.join("\n");
}

function buildPromptContext(
  match: { team_name: string; opponent_name: string | null; score_home: number; score_away: number; duration_seconds: number },
  stats: PlayerStats[],
  videoObs?: Record<string, unknown> | null,
): string {
  const minutes = Math.floor(match.duration_seconds / 60);
  return `PARTIDO
- ${match.team_name} ${match.score_home}-${match.score_away} ${match.opponent_name ?? "Rival"}
- Duración: ${minutes} minutos
- Total eventos taggeados: ${stats.reduce((a, s) => a + s.totalEvents, 0)}

STATS POR JUGADOR (ordenados por impacto neto ponderado)
${stats
  .filter((s) => s.totalEvents > 0)
  .map((s, i) => `${i + 1}. ${s.playerName}
   gol: ${s.goles} · asist: ${s.asistencias} · pase clave: ${s.pases_clave}
   recup: ${s.recuperaciones} · pérdidas: ${s.perdidas}
   duelos: +${s.duelos_ganados} -${s.duelos_perdidos} · tarjetas: ${s.tarjetas}
   impacto neto: ${s.netImpact > 0 ? "+" : ""}${s.netImpact.toFixed(1)}`)
  .join("\n")}

NOTA: Ponderación impacto neto · gol +5, asist +4, pase clave +2,
recuperación +1.5, parada +2, duelo ganado +1, pérdida -1,
duelo perdido -1, amarilla -1, roja -3.${videoObs ? buildVideoSection(videoObs) : "\n\nSIN VÍDEO · basado solo en eventos taggeados por el coach."}`;
}

const PROMPTS = {
  "team-summary": {
    model: MODELS.reasoning,
    system: `Eres el motor de Match Summary VITAS. Analiza el partido en directo y produce
un resumen para coach + padres. Lenguaje claro, motivador, honesto.

Output JSON:
{
  "title": "Resumen · [Equipo] vs [Rival]",
  "result_phrase": "string max 100 chars · ej. 'Victoria sufrida 2-1'",
  "key_moments": ["string","string","string"],
  "mvp": {"player_name":"string","reason":"string max 140 chars"},
  "team_strengths": ["string","string"],
  "team_weaknesses": ["string","string"],
  "next_focus": "string max 200 chars · qué priorizar entrenamiento siguiente"
}
3 momentos clave. Sin markdown.`,
  },
  "per-player": {
    model: MODELS.fast,
    system: `Eres el motor de Player Insights VITAS post-partido baseline.
Para los TOP 5 jugadores por impacto neto, da un insight breve.

Output JSON:
{
  "players": [
    {
      "player_name": "string",
      "rating": 1-10,
      "summary": "string max 140 chars · cómo jugó",
      "highlight": "string max 100 chars · su mejor momento"
    }
  ]
}
Sin markdown.`,
  },
  "tactical-take": {
    model: MODELS.fast,
    system: `Eres el motor de Tactical Take VITAS post-partido.
Output JSON:
{
  "what_worked": ["string","string"],
  "what_didnt": ["string","string"],
  "next_match_adjustment": "string max 200 chars",
  "recommended_drills": ["string","string","string"]
}
Sin markdown.`,
  },
} as const;

type ReportType = keyof typeof PROMPTS;

export default withHandler(
  { method: "POST", requireAuth: true, maxRequests: 10 },
  async ({ userId, tenantId, query, ip }) => {
    if (!ANTHROPIC_API_KEY) {
      return errorResponse({ code: "no_api_key", message: "ANTHROPIC_API_KEY missing", status: 500 });
    }
    const matchId = query.matchId;
    if (!matchId) {
      return errorResponse({ code: "missing_matchId", message: "matchId requerido", status: 400 });
    }
    // Idioma de SALIDA de los 3 reportes = idioma que pide el caller vía query
    // (?locale=…). Sin ramas por idioma: normalizeLocale + languageDirective.
    const reportLocale = normalizeLocale(query.locale);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar match ────────────────────────────────────────
    const { data: match, error: mErr } = await supabase
      .from("live_matches")
      .select("*")
      .eq("id", matchId)
      .single();
    if (mErr || !match) {
      return errorResponse({ code: "not_found", message: "Partido no existe", status: 404 });
    }
    // Fail-closed: sin el `&&` previo, un partido con user_id null (huérfano por
    // ON DELETE SET NULL del dueño, migración 032) dejaba de gatear y cualquier
    // autenticado agregaba/leía sus stats por jugador. null !== userId → 403.
    if (match.user_id !== userId) {
      return errorResponse({ code: "forbidden", message: "No es tu partido", status: 403 });
    }

    // Si ya hay análisis previo, devolver cacheado
    if (match.analysis_result) {
      return successResponse({
        cached: true,
        match: { id: match.id, status: match.status, score_home: match.score_home, score_away: match.score_away, duration_seconds: match.duration_seconds, team_name: match.team_name, opponent_name: match.opponent_name },
        analysis: match.analysis_result,
      });
    }

    // ── 2. Cargar eventos + nombres jugadores ─────────────────
    const { data: events } = await supabase
      .from("live_events")
      .select("player_id, event_type, timestamp_seconds")
      .eq("match_id", matchId);

    const playerIds = Array.from(new Set((events ?? []).map((e) => e.player_id).filter(Boolean) as string[]));
    const playerNames = new Map<string, string>();
    if (playerIds.length > 0) {
      const { data: players } = await supabase
        .from("players")
        .select("id, name")
        .in("id", playerIds);
      (players ?? []).forEach((p) => playerNames.set(p.id, p.name ?? "?"));
    }

    const stats = aggregateByPlayer(events ?? [], playerNames);

    if (stats.length === 0 || (events ?? []).length === 0) {
      return errorResponse({
        code: "no_events",
        message: "No hay eventos taggeados · imposible generar análisis",
        status: 400,
      });
    }

    // ── 3. Analizar video con Gemini si existe ─────────────────
    let videoObs: Record<string, unknown> | null = null;
    let videoConsentGate: { code: string; gate_reason: string } | null = null;
    // Filas antiguas pueden traer una URL arbitraria (antes no se validaba al guardar):
    // si no pasa la allowlist Bunny no se reenvía (video-observation la rechazaría
    // igual, pero tras contabilizar gasto). Sin vídeo → "SIN VÍDEO" honesto.
    if (match.video_url && isAllowedVideoUrl(match.video_url)) {
      // Consentimiento: solo con la declaración guardada con el vídeo. Si falta, se
      // omite SOLO la observación del vídeo y se declara el motivo.
      const consent = await enforceStoredConsentForVideoUrl({
        videoUrl: match.video_url,
        actor: { userId, tenantId, ip },
        endpoint: "live/aggregate",
        locale: reportLocale,
        ownsVideo: (video, uid) => ownsVideo(video, uid),
      });
      if (consent.allowed) {
        videoObs = await analyzeMatchVideo(
          match.video_url,
          match.team_name,
          match.opponent_name ?? "Rival",
        );
      } else {
        videoConsentGate = { code: consent.code, gate_reason: consent.gate_reason };
      }
    }

    // ── 4. Generar 3 reportes Claude en paralelo ───────────────
    // La directiva de idioma va en el mensaje de usuario compartido → los 3
    // reportes (team-summary, per-player, tactical-take) se redactan en el idioma
    // pedido. Los system prompts se mantienen en su idioma base (instrucciones +
    // esquema JSON); las claves de evento (gol, asistencia…) son tokens, no prosa.
    const userMessage = `${buildPromptContext(match, stats, videoObs)}\n\n${languageDirective(reportLocale)}`;
    const reportPromises = (Object.keys(PROMPTS) as ReportType[]).map(async (type) => {
      const cfg = PROMPTS[type];
      try {
        const content = await callClaude({
          model: cfg.model,
          system: cfg.system,
          user: userMessage,
          maxTokens: type === "team-summary" ? 1800 : 1200,
        });
        return { type, content, model: cfg.model, ok: true as const };
      } catch (err) {
        return { type, content: null, model: cfg.model, ok: false as const, error: err instanceof Error ? err.message : "unknown" };
      }
    });

    const results = await Promise.all(reportPromises);
    const successful = results.filter((r) => r.ok);

    // ── 5. (RETIRADO) NO se muta el VSI del jugador desde el partido en vivo ──
    // Antes: se derivaba un delta de VSI de los taps manuales (netImpact) y se
    // ESCRIBÍA en players.vsi / vsi_history, además usando `?? 50` (fabricaba un VSI
    // para un jugador sin evaluar). Eso viola los invariantes de VSI (una sola
    // procedencia real; nunca un 50 por defecto; el compuesto no se altera por un
    // canal lateral). Los eventos del partido son datos observados legítimos y viven
    // en `stats_by_player` (contadores por jugador); NO se convierten en VSI.

    const analysisResult = {
      pipeline: PIPELINE_VERSION,
      generated_at: new Date().toISOString(),
      stats_by_player: stats,
      total_events: (events ?? []).length,
      reports: successful.map((r) => ({ type: r.type, content: r.content, model: r.model })),
      reports_failed: results.length - successful.length,
      has_video: !!videoObs,
      video_observation: videoObs ?? undefined,
      // Vídeo omitido por consentimiento (declaración no guardada / menor sin consentimiento).
      video_consent_gate: videoConsentGate ?? undefined,
    };

    // ── 6. Persistir en match.analysis_result ──────────────────
    await supabase
      .from("live_matches")
      .update({
        analysis_result: analysisResult,
        analysis_at: new Date().toISOString(),
      })
      .eq("id", matchId);

    return successResponse({
      cached: false,
      match: {
        id: match.id, status: match.status, score_home: match.score_home, score_away: match.score_away,
        duration_seconds: match.duration_seconds, team_name: match.team_name, opponent_name: match.opponent_name,
      },
      analysis: analysisResult,
    });
  }
);
