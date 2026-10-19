/**
 * VITAS · Telegram Webhook (Sprint B5 · día 2-3)
 * POST /api/telegram/webhook
 *
 * Recibe los Update de Telegram, identifica al usuario por telegram_chat_id,
 * y responde usando Claude con tool use sobre la data del coach.
 *
 * Flujo:
 *   1. Telegram POST update {message: {chat: {id}, text}}
 *   2. Verificar secret_token header (configurado al setWebhook)
 *   3. Si /start <token> → vincular chat_id ↔ user_id
 *   4. Si /help, /jugadores, etc. → respuesta canned
 *   5. Si texto libre → Claude Haiku con tool use
 *      tools: get_player, list_players, get_latest_analysis,
 *             get_team_stats, get_drill_plan, get_benchmark
 *   6. Persistir mensaje en telegram_messages para context window
 *
 * Sin TELEGRAM_BOT_TOKEN configurado → endpoint devuelve 503 health
 * pero NO crashea (permite que Vercel lo deploye sin romper).
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { timingSafeEqual } from "../_lib/edgeCrypto";
import { createClient } from "@supabase/supabase-js";
import { MODELS } from "../_lib/models";
import { avgEvaluatedVsi, countElite, formatVsi, ELITE_MIN } from "../_lib/vsiStats";
import { pendingVsiReviewIds, withPendingVsiExcluded } from "../_lib/vsiPendingReview";

/** Fila de «/equipo» y get_team_stats (players: id, vsi, PHV de columna, edad, sexo). */
interface TeamStatsRow {
  id?: unknown;
  vsi: number | null;
  phv_category?: string;
  age?: number | null;
  gender?: unknown;
  sexConfirmedAt?: unknown;
}

const PENDING_REVIEWS_UNAVAILABLE ="No se pudo comprobar qué evaluaciones están pendientes de revisión: inténtalo de nuevo más tarde.";
import { normalizeLocale, languageDirective, type ReportLocale } from "../../src/lib/shared/locale";
import { withoutUndatedVsiSeries } from "../../src/lib/scoring/vsiDelta";
import { phvColumnsForPlayer, trustAnthroForPlayer } from "../../src/lib/shared/sexGatedAnthro";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "vitas_copilot_bot";

// ─── Telegram API helpers ────────────────────────────────────────

async function sendMessage(chatId: number, text: string, opts: {
  parseMode?: "Markdown" | "HTML";
  replyMarkup?: Record<string, unknown>;
} = {}): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!BOT_TOKEN) {
    console.error("[telegram] BOT_TOKEN missing · cannot send");
    return { ok: false, status: 0, error: "no_bot_token" };
  }
  const useParseMode = opts.parseMode === "HTML" ? "HTML" : undefined;
  const cleanText = useParseMode
    ? text
    : text.replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1");

  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: cleanText,
      reply_markup: opts.replyMarkup,
    };
    if (useParseMode) payload.parse_mode = useParseMode;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage failed ${res.status}: ${body.slice(0, 300)}`);
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram] sendMessage exception:", msg);
    return { ok: false, status: 0, error: msg };
  }
}

async function sendTyping(chatId: number): Promise<void> {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => null);
}

// ─── Tools para Claude ──────────────────────────────────────────

const TOOLS = [
  {
    name: "list_players",
    description: "Lista todos los jugadores del coach con sus stats principales (vsi = evaluación del entrenador, valoración subjetiva 0-100; edad, posición, fase PHV). Usa cuando el coach pregunta '¿cómo va el equipo?', 'jugadores', 'mi plantilla'.",
    input_schema: {
      type: "object",
      properties: {
        sort_by: { type: "string", enum: ["vsi", "name", "age"], description: "Ordenar por (default vsi desc)" },
        limit: { type: "integer", default: 20 },
      },
    },
  },
  {
    name: "get_player",
    description: "Detalle de un jugador específico: vsi (evaluación del entrenador, subjetiva), evaluacion_entrenador (sus 6 barras), PHV, fase, último análisis si existe. Usa cuando el coach menciona un nombre.",
    input_schema: {
      type: "object",
      required: ["name_query"],
      properties: {
        name_query: { type: "string", description: "Nombre o parcial del jugador (ej. 'Samu')" },
      },
    },
  },
  {
    name: "get_latest_match",
    description: "Resumen del último partido en directo registrado: score, MVP, eventos clave, stats por jugador.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_match_stats",
    description: "Stats del último video analizado de un jugador: pases (precisión, completados/fallados), recuperaciones, robos, anticipaciones, pérdidas, disparos, físicas (vel máx/prom, distancia, sprints). Usa cuando piden 'estadísticas de X', 'cómo jugó X', 'stats de pase de X'.",
    input_schema: {
      type: "object",
      required: ["name_query"],
      properties: {
        name_query: { type: "string", description: "Nombre del jugador" },
      },
    },
  },
  {
    name: "get_team_stats",
    description: "Stats agregadas del equipo: media de la evaluación del entrenador (avgVsi, subjetiva), distribución PHV, número de jugadores y cuántos están en el tramo Élite (eliteCount).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_drill_recommendations",
    description: "Drills recomendados para entrenar una debilidad específica (ej. 'lectura defensiva', 'pase impreciso').",
    input_schema: {
      type: "object",
      required: ["weakness"],
      properties: {
        weakness: { type: "string", description: "Debilidad o área a trabajar" },
        player_age: { type: "integer", description: "Edad del jugador (afecta drill apropiado)" },
        phv_phase: { type: "string", enum: ["pre_phv", "in_phv", "post_phv"], description: "Fase PHV opcional" },
      },
    },
  },
  {
    name: "get_phv_advice",
    description: "Consejo específico para entrenar a un jugador según su fase PHV. Usa cuando se pregunta sobre cargas, riesgos, ventana neuromotora.",
    input_schema: {
      type: "object",
      required: ["name_query"],
      properties: {
        name_query: { type: "string" },
      },
    },
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extrae stats clave (pases, recup, físicas) del report.metricasCuantitativas
 * Devuelve null si no hay datos. Sin duelos (P1 bloque 6): sin criterio validado de
 * duelo (src/lib/tracking/duels.ts); los informes antiguos que los traen no se citan.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractKeyStats(report: any): Record<string, unknown> | null {
  const m = report?.metricasCuantitativas;
  if (!m) return null;
  return {
    pases:           m.pases ? { completados: m.pases.completados, fallados: m.pases.fallados, precision: m.pases.precision } : null,
    recuperaciones:  m.eventos?.recuperaciones ?? null,
    robos:           m.eventos?.robos ?? null,
    anticipaciones:  m.eventos?.anticipaciones ?? null,
    perdidas:        m.eventos?.perdidas ?? null,
    disparos:        m.disparos ? { alArco: m.disparos.alArco, fuera: m.disparos.fuera } : null,
    fisicas:         m.fisicas ? {
      velocidadMaxKmh:  m.fisicas.velocidadMaxKmh,
      velocidadPromKmh: m.fisicas.velocidadPromKmh,
      distanciaM:       m.fisicas.distanciaM,
      sprints:          m.fisicas.sprints,
    } : null,
  };
}

// ─── Tool implementations ────────────────────────────────────────

interface ToolContext {
  userId: string;
  tenantId: string;
  chatId: number;
}

type SupabaseClient = ReturnType<typeof createClient>;

/** Ejecuta una herramienta del bot. Exportada solo para tests (no es una ruta). */
export async function execTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (toolName) {
    case "list_players": {
      const sortBy = (input.sort_by as string) ?? "vsi";
      const limit = Math.min(20, (input.limit as number) ?? 10);
      const { data } = await supabase
        .from("players")
        .select("id, name, age, position, vsi, phv_category, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", ctx.userId)
        // nulls last: los no evaluados (vsi null) no truncan a los evaluados con el limit (invariante #2)
        .order(sortBy === "vsi" ? "vsi" : sortBy === "age" ? "age" : "name", { ascending: sortBy !== "vsi", nullsFirst: false })
        .limit(limit);

      if (!data || data.length === 0) return "Sin jugadores registrados.";
      // Revisión VSI pendiente (070, D3): su VSI no va al modelo como evaluación.
      let pending: Set<string>;
      try {
        pending = await pendingVsiReviewIds(supabase);
      } catch {
        return PENDING_REVIEWS_UNAVAILABLE;
      }
      return JSON.stringify(withPendingVsiExcluded<TeamStatsRow>(data, pending).map(phvColumnsForPlayer), null, 2);
    }

    case "get_player": {
      const q = ((input.name_query as string) ?? "").toLowerCase().trim();
      const { data: matchesRaw } = await supabase
        .from("players")
        // Barras del entrenador del BLOB (null si no está evaluado): las columnas metric_*
        // valen 0 para quien no lo está (trigger 069 + DEFAULT 0 de la 024) y el modelo
        // leía «velocidad 0» de un niño sin evaluar (P1 bloque 5).
        .select("id, name, age, position, foot, height_cm, weight_kg, vsi, vsi_history, phv_category, phv_offset, evaluacion_entrenador:data->metrics, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", ctx.userId)
        .ilike("name", `%${q}%`)
        .limit(3);
      // PHV de la columna solo con sexo registrado (P1 bloque 7).
      const matches = matchesRaw?.map(phvColumnsForPlayer) ?? null;

      if (!matches || matches.length === 0) return `No encontré jugador con "${q}".`;
      if (matches.length === 1) {
        const playerId = matches[0].id;
        // Último análisis (pipeline GPU)
        const { data: lastAnalysis } = await supabase
          .from("analyses")
          .select("id, status, vsi, completed_at")
          .eq("player_id", playerId)
          .in("status", ["completed", "completed_partial"])
          .order("completed_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Último report con metricasCuantitativas (pase/recup/duelos/etc)
        const { data: lastReport } = await supabase
          .from("player_analyses")
          .select("id, report, created_at")
          .eq("player_id", playerId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const stats = extractKeyStats(lastReport?.report);
        // Al LLM no le llega el historial legacy SIN fechas (vsi_history, con el 57.5
        // fabricado antes de #146) ni la serie retirada de analyses.vsi (trend/history):
        // narraría una «subida» que la app no puede calcular (src/lib/scoring/vsiDelta.ts).
        const player = { ...matches[0] };
        delete player.vsi_history;
        const analysisForLlm = lastAnalysis
          ? { ...lastAnalysis, vsi: withoutUndatedVsiSeries(lastAnalysis.vsi) }
          : lastAnalysis;
        return JSON.stringify({ player, lastAnalysis: analysisForLlm, lastVideoStats: stats }, null, 2);
      }
      return `Múltiples coincidencias: ${matches.map((m: { name: string }) => m.name).join(", ")}. Especifica más.`;
    }

    case "get_match_stats": {
      const q = ((input.name_query as string) ?? "").toLowerCase().trim();
      const { data: matches } = await supabase
        .from("players")
        .select("id, name")
        .eq("user_id", ctx.userId)
        .ilike("name", `%${q}%`)
        .limit(1);
      if (!matches || matches.length === 0) return `No encontré jugador "${q}".`;
      const { data: report } = await supabase
        .from("player_analyses")
        .select("report, created_at")
        .eq("player_id", matches[0].id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!report?.report) return `Sin análisis de video para ${matches[0].name}. Sube uno desde la app.`;
      const stats = extractKeyStats(report.report);
      return JSON.stringify({ player: matches[0].name, stats, analysisDate: report.created_at }, null, 2);
    }

    case "get_latest_match": {
      const { data: match } = await supabase
        .from("live_matches")
        .select("id, team_name, opponent_name, status, started_at, ended_at, duration_seconds, score_home, score_away, analysis_result")
        .eq("user_id", ctx.userId)
        .eq("status", "finished")
        .order("ended_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!match) return "Sin partidos finalizados aún. Usa /api/live/matches para empezar uno.";
      return JSON.stringify(match, null, 2);
    }

    case "get_team_stats": {
      const { data: playersRaw } = await supabase
        .from("players")
        .select("id, vsi, phv_category, age, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", ctx.userId);
      // Revisión VSI pendiente (070, D3): no cuenta como evaluado (lector único).
      let pending: Set<string>;
      try {
        pending = await pendingVsiReviewIds(supabase);
      } catch {
        return PENDING_REVIEWS_UNAVAILABLE;
      }
      const players = playersRaw ? withPendingVsiExcluded<TeamStatsRow>(playersRaw, pending).map(phvColumnsForPlayer) : null; // P1 bloque 7
      if (!players || players.length === 0) return "Sin jugadores.";

      const n = players.length;
      // Media y élite SOLO sobre evaluados (vsi != null); un no evaluado no es 0
      // ni élite (invariante #2). avgVsi = null si nadie tiene VSI de ficha.
      const avgVsi = avgEvaluatedVsi(players as Array<{ vsi: number | null }>);
      const phvDist = {
        early: players.filter((p: { phv_category?: string }) => p.phv_category === "early").length,
        ontime: players.filter((p: { phv_category?: string }) => p.phv_category === "ontime" || p.phv_category === "ontme").length,
        late: players.filter((p: { phv_category?: string }) => p.phv_category === "late").length,
        unknown: players.filter((p: { phv_category?: string }) => !p.phv_category).length,
      };
      const elite = countElite(players as Array<{ vsi: number | null }>);
      return JSON.stringify({
        teamSize: n,
        avgVsi, // number | null (null = ningún jugador evaluado)
        phvDistribution: phvDist,
        eliteCount: elite,
      }, null, 2);
    }

    case "get_drill_recommendations": {
      const weakness = (input.weakness as string) ?? "";
      const phase = input.phv_phase as string | undefined;
      const lower = weakness.toLowerCase();
      // Lookup en knowledge base local · 6 áreas comunes
      const drills: Record<string, string[]> = {
        "lectura defensiva":   ["TAC-001 Posicionamiento táctico", "TAC-002 Pressing coordinado"],
        "pase":                ["TEC-002 Circuito de pases", "TAC-004 Posesión 5v5+2"],
        "primer toque":        ["TEC-001 Rondo 4v2", "TEC-005 Recepción bajo presión"],
        "regate":              ["TEC-003 Circuito 1v1", "POS-WG-001 Desborde y centro"],
        "velocidad":           ["FIS-001 Sprints con cambio dirección", "FIS-004 Velocidad de reacción"],
        "resistencia":         ["FIS-003 HIIT fútbol", "FIS-005 Fuerza preventiva"],
      };
      let recommended: string[] = [];
      for (const [key, val] of Object.entries(drills)) {
        if (lower.includes(key)) { recommended = val; break; }
      }
      if (recommended.length === 0) {
        recommended = ["TEC-001 Rondo 4v2 (versátil)", "TAC-001 Posicionamiento táctico"];
      }
      return JSON.stringify({ weakness, phase: phase ?? "no_indicada", drills: recommended });
    }

    case "get_phv_advice": {
      const q = ((input.name_query as string) ?? "").toLowerCase();
      const { data: pRaw } = await supabase
        .from("players")
        .select("id, name, age, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", ctx.userId)
        .ilike("name", `%${q}%`)
        .limit(1)
        .maybeSingle();
      if (!pRaw) return `No encontré jugador "${q}".`;
      // Consejo de CARGA para un menor: fase SOLO desde la última medición fiable y
      // calculada con su sexo registrado (P1 bloque 7; misma regla que el plan de
      // ventana PHV), nunca desde la columna players.phv_category.
      const { data: latest } = await supabase
        .from("player_latest_anthropometrics")
        .select("*")
        .eq("player_id", pRaw.id)
        .maybeSingle();
      const trust = trustAnthroForPlayer(latest, pRaw);
      const p = { name: pRaw.name, age: pRaw.age };
      const phase = trust.trusted ? trust.category : null;
      const advice = phase === "early"
        ? "PRE-PHV (pre-estirón). Ventana neuromotora abierta. Carga: bajo volumen + alta variabilidad técnica. EVITAR gym pesado. Foco: coordinación y técnica."
        : phase === "late"
        ? "POST-PHV (post-estirón). Ventana de fuerza. Incorporar gym progresivo + HIIT con balón. Buen momento para potencia."
        : phase === "ontme"
        ? "EN PHV (estirón). Período sensible. BAJAR intensidad cognitiva, gestionar cargas para evitar Osgood-Schlatter. Mantener técnica básica."
        : `Sin fase PHV fiable: ${trust.gate_reason ?? "sin medición antropométrica"}. Sin ella no se da consejo de carga.`;
      return JSON.stringify({ name: p.name, age: p.age, phv: phase, advice }, null, 2);
    }

    default:
      return `Tool ${toolName} no implementado.`;
  }
}

// ─── Claude con tool use ────────────────────────────────────────

/**
 * Prompt de sistema del Copilot. Locale-aware: el idioma de la respuesta lo fija
 * `languageDirective` a partir del idioma del coach (Telegram `language_code`) →
 * responde en el idioma del coach, no en español fijo. Multi-idioma sin hardcodeo:
 * cuando se añada un idioma al registro, el bot lo respeta automáticamente.
 */
function buildSystemPrompt(locale: ReportLocale): string {
  return `Eres VITAS Copilot, asistente conversacional para coaches de fútbol juvenil
en Telegram. Eres conciso (máximo 4-5 líneas por respuesta).

CONTEXTO: el coach te pregunta sobre sus jugadores y equipo. Tienes herramientas
para consultar la base de datos (list_players, get_player, get_latest_match,
get_team_stats, get_drill_recommendations, get_phv_advice).

ESTILO:
- Lenguaje claro · sin jerga excesiva
- Emojis con moderación (1-2 por respuesta · 🏆 ⚽ 📈 ⚠️ 🌱)
- Markdown ligero: *negrita* _cursiva_
- Datos concretos · números siempre que puedas
- Si necesitas datos, USA HERRAMIENTAS · no inventes

LIMITACIONES:
- No puedes crear/modificar/borrar nada · solo leer y aconsejar
- Si el coach pide acciones (iniciar partido, generar reporte), dile que las
  haga desde la app web/PWA · no las hagas tú
- Si la pregunta no tiene sentido o falta contexto, pide clarificación

Saluda solo cuando el coach inicia conversación con /start o "hola".

${languageDirective(locale)}
Si el coach te escribe en otro idioma soportado, respóndele en ESE idioma.`;
}

async function callClaudeWithTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  ctx: ToolContext,
  userMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  locale: ReportLocale,
): Promise<{ text: string; toolsUsed: string[]; tokensIn: number; tokensOut: number }> {
  if (!ANTHROPIC_API_KEY) {
    return { text: "_(Bot no configurado · falta ANTHROPIC_API_KEY)_", toolsUsed: [], tokensIn: 0, tokensOut: 0 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];
  const toolsUsed: string[] = [];
  let totalIn = 0, totalOut = 0;

  // Loop hasta 3 iteraciones de tool use
  for (let i = 0; i < 3; i++) {
    // Fetch con retry para errores transitorios (429, 529, 500+)
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELS.fast,
          max_tokens: 800,
          system: [{ type: "text", text: buildSystemPrompt(locale), cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          messages,
        }),
      });
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
      // Esperar antes de reintentar: 1s, 2s, 4s
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (2 ** attempt)));
    }
    if (!res || !res.ok) {
      return { text: `_(Error Claude ${res?.status ?? "?"} · intenta de nuevo en unos segundos)_`, toolsUsed, tokensIn: totalIn, tokensOut: totalOut };
    }
    const data = await res.json();
    totalIn += data.usage?.input_tokens ?? 0;
    totalOut += data.usage?.output_tokens ?? 0;

    const content = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    const textBlocks = content.filter((b) => b.type === "text").map((b) => b.text).filter(Boolean) as string[];
    const toolUses = content.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      // No más tools · respuesta final
      return { text: textBlocks.join("\n\n").trim() || "_(sin respuesta)_", toolsUsed, tokensIn: totalIn, tokensOut: totalOut };
    }

    // Ejecutar tools y preparar respuesta
    messages.push({ role: "assistant", content });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await execTool(supabase, ctx, tu.name!, tu.input ?? {});
      toolsUsed.push(tu.name!);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { text: "_(Demasiados pasos · simplifica la pregunta)_", toolsUsed, tokensIn: totalIn, tokensOut: totalOut };
}

// ─── Webhook handler ────────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string; language_code?: string };
    text?: string;
  };
}

export default withHandler(
  { method: "POST", maxRequests: 600 },         // sin auth · webhook público
  async ({ req, body }) => {
    if (!BOT_TOKEN) {
      return errorResponse({ code: "bot_not_configured", message: "TELEGRAM_BOT_TOKEN missing", status: 503 });
    }

    // Fail-CLOSED: exige el secret. Sin TELEGRAM_WEBHOOK_SECRET, cualquiera podía
    // accionar el bot (agente Claude con tools sobre supabase execTool) → abuso de
    // coste LLM y acceso a datos. Antes solo validaba si el secret estaba definido.
    if (!WEBHOOK_SECRET) {
      console.error("[tg] TELEGRAM_WEBHOOK_SECRET no configurado — rechazando (fail-closed)");
      return errorResponse({ code: "webhook_not_configured", message: "TELEGRAM_WEBHOOK_SECRET missing", status: 503 });
    }
    const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqual(got, WEBHOOK_SECRET)) {
      return errorResponse({ code: "unauthorized_webhook", message: "Bad secret", status: 401 });
    }

    const debugSteps: string[] = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => {
      const entry = `${step}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`;
      debugSteps.push(entry);
      console.log(JSON.stringify({ level: "debug", msg: `[tg] ${step}`, ...extra }));
    };

    log("webhook_hit", {
      hasBotToken: !!BOT_TOKEN,
      botTokenLen: BOT_TOKEN.length,
      hasAnthropicKey: !!ANTHROPIC_API_KEY,
      hasSecret: !!WEBHOOK_SECRET,
      botUsername: BOT_USERNAME,
    });

    // Debug mode: si chatId es 0, devuelve los pasos en la response
    const isDebug = req.headers.get("x-vitas-debug") === "1";

    // withHandler ya consumió el body via req.text() · usar ctx.body, no req.json()
    const update = (body ?? null) as TelegramUpdate | null;
    log("parsed", { hasMsg: !!update?.message, hasText: !!update?.message?.text });
    if (!update?.message?.text || !update.message.chat?.id) {
      return successResponse({ ok: true });           // ignorar updates sin texto
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    const tgUsername = update.message.from?.username;
    const tgFirstName = update.message.from?.first_name;
    log("got_message", { chatId, text: text.slice(0, 40), tgFirstName });

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── /start con token · vincular ───────────────────────────
    if (text.startsWith("/start ")) {
      const token = text.slice(7).trim();
      const { data: linkRow } = await supabase
        .from("telegram_link_tokens")
        .select("user_id, tenant_id, expires_at, consumed_at")
        .eq("token", token)
        .maybeSingle();

      if (!linkRow || linkRow.consumed_at || new Date(linkRow.expires_at) < new Date()) {
        await sendMessage(chatId,
          "❌ *Link inválido o expirado*\n\nVuelve a la web VITAS → Ajustes → Conectar Telegram para generar uno nuevo (válido 10 min).");
        return successResponse({ ok: true });
      }

      // Crear mapping (upsert por chat_id)
      const { error: mErr } = await supabase
        .from("coach_telegram_mapping")
        .upsert({
          user_id: linkRow.user_id,
          tenant_id: linkRow.tenant_id,
          telegram_chat_id: chatId,
          telegram_username: tgUsername,
          telegram_first_name: tgFirstName,
          linked_at: new Date().toISOString(),
          unlinked_at: null,
        }, { onConflict: "telegram_chat_id" });

      if (mErr) {
        await sendMessage(chatId, `❌ Error vinculando: ${mErr.message}`);
        return successResponse({ ok: true });
      }

      // Consumir token
      await supabase
        .from("telegram_link_tokens")
        .update({ consumed_at: new Date().toISOString() })
        .eq("token", token);

      await sendMessage(chatId,
        `✅ Vinculado correctamente\n\n` +
        `Hola ${tgFirstName ?? "coach"} 👋\n\n` +
        `Soy VITAS Copilot. Pruébalos:\n\n` +
        `/jugadores — top 15 por evaluación del entrenador\n` +
        `/equipo — stats agregadas\n` +
        `/ultimo — último partido\n` +
        `/drill <tema> — drills al instante\n\n` +
        `O escríbeme en lenguaje natural:\n` +
        `• "¿cómo va Samu?"\n` +
        `• "fase PHV de Marcos"\n` +
        `• "drills para lectura defensiva"\n\n` +
        `/help para más.`);
      return successResponse({ ok: true });
    }

    // ── Identificar usuario por chat_id ──────────────────────
    log("checking_mapping", { chatId });
    const { data: mapping, error: mappingErr } = await supabase
      .from("coach_telegram_mapping")
      .select("user_id, tenant_id")
      .eq("telegram_chat_id", chatId)
      .is("unlinked_at", null)
      .maybeSingle();
    log("mapping_check_done", { hasMapping: !!mapping, err: mappingErr?.message });

    if (!mapping) {
      log("no_mapping_sending_welcome", { chatId });
      const r = await sendMessage(chatId,
        "👋 No estás vinculado a una cuenta VITAS.\n\nVe a la web → Ajustes → Conectar Telegram y abre el link que te genere.\n\n(Si lo hiciste y no funciona, vuelve a generar el token · expira a los 10 min)");
      log("welcome_sent", { chatId, ok: r.ok, status: r.status, err: r.error });
      return successResponse(isDebug ? { ok: true, debug: debugSteps } : { ok: true });
    }

    // ── Comandos canned ──────────────────────────────────────
    if (text === "/start") {
      await sendMessage(chatId,
        `Hola 👋 Ya estabas vinculado.\n\nPregúntame lo que quieras: "¿cómo va el equipo?", un nombre de jugador, drills, fases PHV…\n\n/help para más.`);
      return successResponse({ ok: true });
    }

    if (text === "/help") {
      await sendMessage(chatId,
        `📋 Comandos\n\n` +
        `/jugadores — top 15 por evaluación del entrenador\n` +
        `/equipo — stats agregadas (evaluación del entrenador, PHV)\n` +
        `/stats <nombre> [como <pos>] — pase/recup del último video\n` +
        `/posiciones <nombre> — polivalencia (videos por posición jugada)\n` +
        `/ultimo — último partido finalizado\n` +
        `/drill <tema> — drills para entrenar (pase, regate, etc.)\n` +
        `/help — este mensaje\n` +
        `/desvincular — cerrar conexión\n\n` +
        `💬 O escribe en lenguaje natural:\n` +
        `• "¿cómo va Samu?"\n` +
        `• "fase PHV de Marcos"\n` +
        `• "drills para lectura defensiva"\n` +
        `• "¿qué entreno hoy?"`);
      return successResponse({ ok: true });
    }

    if (text === "/desvincular") {
      await supabase
        .from("coach_telegram_mapping")
        .update({ unlinked_at: new Date().toISOString() })
        .eq("telegram_chat_id", chatId);
      await sendMessage(chatId, "🔓 Desvinculado. Tus mensajes se borran. Hasta otra coach 👋");
      return successResponse({ ok: true });
    }

    // ── Slash commands directos (sin LLM · rápido + barato) ───────────
    const lowerText = text.toLowerCase().trim();

    if (lowerText === "/jugadores") {
      const { data: dataRaw } = await supabase
        .from("players")
        .select("name, age, position, vsi, phv_category, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", mapping.user_id)
        // nulls last: los no evaluados (vsi null) no truncan a los evaluados con el limit (invariante #2)
        .order("vsi", { ascending: false, nullsFirst: false })
        .limit(15);
      const data = dataRaw?.map(phvColumnsForPlayer) ?? null; // P1 bloque 7
      if (!data || data.length === 0) {
        await sendMessage(chatId, "📋 Aún no tienes jugadores registrados.\n\nAñade el primero desde la app → Equipo → +");
      } else {
        const phvIcon = (cat?: string) => cat === "early" ? "🟢" : cat === "ontime" || cat === "ontme" ? "🟡" : cat === "late" ? "🔵" : "⚪";
        const rows = (data as Array<{ name: string; age: number | null; position: string | null; vsi: number | null; phv_category: string | null }>)
          .map((p, i) => `${i + 1}. ${p.name} · ${p.age ?? "?"}a · ${p.position ?? "—"} · Eval. entrenador ${p.vsi == null ? "sin evaluar" : formatVsi(p.vsi)} ${phvIcon(p.phv_category ?? undefined)}`)
          .join("\n");
        await sendMessage(chatId, `🏆 Tu plantilla (top ${data.length} por evaluación del entrenador)\n\n${rows}\n\n🟢 pre-PHV · 🟡 en PHV · 🔵 post-PHV · ⚪ sin datos`);
      }
      return successResponse({ ok: true });
    }

    if (lowerText === "/equipo") {
      const { data: playersRaw } = await supabase
        .from("players")
        .select("id, vsi, phv_category, age, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
        .eq("user_id", mapping.user_id);
      // Revisión VSI pendiente (070, D3): no cuenta como evaluado (lector único).
      let pending: Set<string> | null;
      try {
        pending = await pendingVsiReviewIds(supabase);
      } catch {
        pending = null;
      }
      const players = playersRaw && pending ? withPendingVsiExcluded<TeamStatsRow>(playersRaw, pending).map(phvColumnsForPlayer) : null; // P1 bloque 7
      if (pending === null) {
        await sendMessage(chatId, PENDING_REVIEWS_UNAVAILABLE);
      } else if (!players || players.length === 0) {
        await sendMessage(chatId, "Aún no tienes jugadores. Añade desde la app → Equipo.");
      } else {
        const n = players.length;
        const ps = players as Array<{ vsi: number | null; phv_category: string | null; age: number | null }>;
        // Media y élite SOLO sobre evaluados; el hueco no promedia ni cuenta como 0
        // (invariante #2). "sin evaluar" si ninguno tiene VSI de ficha.
        const avgVsi = avgEvaluatedVsi(ps);
        const elite = countElite(ps);
        const early = ps.filter(p => p.phv_category === "early").length;
        const ontime = ps.filter(p => p.phv_category === "ontime" || p.phv_category === "ontme").length;
        const late = ps.filter(p => p.phv_category === "late").length;
        const ages = ps.map(p => Number(p.age || 0)).filter(a => a > 0);
        const avgAge = ages.length ? (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : "—";
        await sendMessage(chatId,
          `📊 Stats del equipo\n\n` +
          `👥 Plantilla: ${n} jugadores · edad media ${avgAge}\n` +
          `⚡ Evaluación del entrenador media (subjetiva): ${avgVsi === null ? "sin evaluar" : avgVsi.toFixed(1)}\n` +
          `🌟 Tramo Élite (≥${ELITE_MIN}): ${elite}\n\n` +
          `Distribución PHV:\n` +
          `🟢 Pre-PHV: ${early}\n` +
          `🟡 En PHV: ${ontime}\n` +
          `🔵 Post-PHV: ${late}\n` +
          `⚪ Sin datos: ${n - early - ontime - late}`);
      }
      return successResponse({ ok: true });
    }

    if (lowerText === "/ultimo") {
      const { data: match } = await supabase
        .from("live_matches")
        .select("team_name, opponent_name, status, ended_at, duration_seconds, score_home, score_away")
        .eq("user_id", mapping.user_id)
        .eq("status", "finished")
        .order("ended_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!match) {
        await sendMessage(chatId, "⚽ Sin partidos finalizados aún.\n\nAbre Match-day Live desde la app → Equipo → Match-day Live para empezar uno.");
      } else {
        const m = match as { team_name: string; opponent_name: string | null; ended_at: string; duration_seconds: number | null; score_home: number; score_away: number };
        const dur = m.duration_seconds ? `${Math.round(m.duration_seconds / 60)}min` : "—";
        const date = m.ended_at ? new Date(m.ended_at).toLocaleDateString("es-ES") : "—";
        const result = m.score_home > m.score_away ? "✅ Victoria" : m.score_home < m.score_away ? "❌ Derrota" : "🤝 Empate";
        await sendMessage(chatId,
          `⚽ Último partido\n\n` +
          `${m.team_name} ${m.score_home} – ${m.score_away} ${m.opponent_name ?? "Rival"}\n` +
          `${result}\n\n` +
          `📅 ${date} · ⏱ ${dur}\n\n` +
          `Para análisis detallado: abre la app → Reportes → Match-day Live.`);
      }
      return successResponse({ ok: true });
    }

    if (lowerText.startsWith("/posiciones")) {
      const name = text.slice(11).trim();
      if (!name) {
        await sendMessage(chatId, "🧭 Polivalencia de un jugador\n\nUso: /posiciones <nombre>\nEj: /posiciones Samu");
        return successResponse({ ok: true });
      }
      const { data: matches } = await supabase
        .from("players")
        .select("id, name, position, secondary_positions")
        .eq("user_id", mapping.user_id)
        .ilike("name", `%${name.toLowerCase()}%`)
        .limit(1);
      if (!matches || matches.length === 0) {
        await sendMessage(chatId, `No encontré jugador "${name}".`);
        return successResponse({ ok: true });
      }
      const player = matches[0] as { id: string; name: string; position: string; secondary_positions: string[] | null };
      // Rollup por played_position
      const { data: rows } = await supabase
        .from("player_analyses")
        .select("played_position, report, created_at")
        .eq("player_id", player.id);
      const groups = new Map<string, { count: number; vsiSum: number; vsiN: number }>();
      const fallbackPos = player.position;
      for (const r of (rows ?? []) as Array<{ played_position: string | null; report: { vsi?: number | { score?: number } } | null }>) {
        const pos = r.played_position ?? fallbackPos;
        const v = typeof r.report?.vsi === "number" ? r.report.vsi : (r.report?.vsi as { score?: number })?.score ?? null;
        const g = groups.get(pos) ?? { count: 0, vsiSum: 0, vsiN: 0 };
        g.count += 1;
        if (v !== null && v !== undefined) { g.vsiSum += v; g.vsiN += 1; }
        groups.set(pos, g);
      }
      const declared = new Set([player.position, ...(player.secondary_positions ?? [])].filter(Boolean));
      const lines: string[] = [`🧭 ${player.name} · polivalencia`, ""];
      lines.push(`Declaradas: ⭐ ${player.position}` + (player.secondary_positions?.length ? ` · ${player.secondary_positions.join(", ")}` : ""));
      if (groups.size === 0) {
        lines.push("\nAún no hay videos analizados.");
      } else {
        lines.push("\nVideos por posición jugada:");
        for (const [pos, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
          const avg = g.vsiN > 0 ? (g.vsiSum / g.vsiN).toFixed(0) : "—";
          const tag = pos === player.position ? "⭐" : declared.has(pos) ? "✓" : "🔍";
          lines.push(`${tag} ${pos}: ${g.count} video${g.count > 1 ? "s" : ""} · VSI medio ${avg}`);
        }
      }
      await sendMessage(chatId, lines.join("\n"));
      return successResponse({ ok: true });
    }

    if (lowerText.startsWith("/stats")) {
      const args = text.slice(6).trim();
      // Soporta "/stats Samu" o "/stats Samu como CAM"
      const comoMatch = args.match(/^(.+?)\s+como\s+(.+)$/i);
      const name = comoMatch ? comoMatch[1].trim() : args;
      const positionFilter = comoMatch ? comoMatch[2].trim() : null;
      if (!name) {
        await sendMessage(chatId, "📊 Stats de un jugador\n\nUso:\n/stats <nombre>\n/stats <nombre> como <posición>\n\nEj: /stats Samu como Pivote");
        return successResponse({ ok: true });
      }
      const { data: matches } = await supabase
        .from("players")
        .select("id, name")
        .eq("user_id", mapping.user_id)
        .ilike("name", `%${name.toLowerCase()}%`)
        .limit(1);
      if (!matches || matches.length === 0) {
        await sendMessage(chatId, `No encontré jugador "${name}".`);
        return successResponse({ ok: true });
      }
      let query = supabase
        .from("player_analyses")
        .select("report, created_at, played_position")
        .eq("player_id", matches[0].id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (positionFilter) {
        query = query.ilike("played_position", `%${positionFilter}%`);
      }
      const { data: row } = await query.maybeSingle();
      const stats = row?.report ? extractKeyStats(row.report) : null;
      if (!stats) {
        const filterMsg = positionFilter ? ` jugando como "${positionFilter}"` : "";
        await sendMessage(chatId,
          `📊 ${matches[0].name}\n\n` +
          `Aún no tiene análisis de video con stats${filterMsg}.\n\n` +
          `Sube un video desde la app → Reportes → analizar.`);
        return successResponse({ ok: true });
      }
      const date = row?.created_at ? new Date(row.created_at as string).toLocaleDateString("es-ES") : "—";
      const playedPos = (row as { played_position?: string | null } | null)?.played_position;
      const headerSuffix = playedPos ? ` · jugó de ${playedPos}` : "";
      const lines: string[] = [`📊 ${matches[0].name} · último video (${date})${headerSuffix}`, ""];
      const p = stats.pases as { completados: number; fallados: number; precision: number } | null;
      if (p) lines.push(`⚽ Pases: ${p.completados}/${p.completados + p.fallados} (${p.precision}% precisión)`);
      if (stats.recuperaciones != null) lines.push(`🛡 Recuperaciones: ${stats.recuperaciones}`);
      if (stats.robos != null) lines.push(`🔪 Robos: ${stats.robos}`);
      if (stats.anticipaciones != null) lines.push(`👁 Anticipaciones: ${stats.anticipaciones}`);
      if (stats.perdidas != null) lines.push(`❌ Pérdidas: ${stats.perdidas}`);
      const s = stats.disparos as { alArco: number; fuera: number } | null;
      if (s) lines.push(`🎯 Disparos: ${s.alArco} al arco · ${s.fuera} fuera`);
      const f = stats.fisicas as { velocidadMaxKmh: number; velocidadPromKmh: number; distanciaM: number; sprints: number } | null;
      if (f) {
        lines.push("");
        lines.push(`🏃 Físicas:`);
        lines.push(`   Vel máx: ${f.velocidadMaxKmh} km/h · prom ${f.velocidadPromKmh} km/h`);
        lines.push(`   Distancia: ${f.distanciaM}m · ${f.sprints} sprints`);
      }
      await sendMessage(chatId, lines.join("\n"));
      return successResponse({ ok: true });
    }

    if (lowerText.startsWith("/drill")) {
      const tema = text.slice(6).trim();
      if (!tema) {
        await sendMessage(chatId,
          "💪 Drill recomendado\n\n" +
          "Uso: /drill <tema>\n\n" +
          "Ejemplos:\n" +
          "• /drill lectura defensiva\n" +
          "• /drill pase\n" +
          "• /drill primer toque\n" +
          "• /drill regate\n" +
          "• /drill velocidad\n" +
          "• /drill resistencia");
      } else {
        const lower = tema.toLowerCase();
        const drills: Record<string, string[]> = {
          "lectura defensiva":   ["TAC-001 Posicionamiento táctico", "TAC-002 Pressing coordinado"],
          "pase":                ["TEC-002 Circuito de pases", "TAC-004 Posesión 5v5+2"],
          "primer toque":        ["TEC-001 Rondo 4v2", "TEC-005 Recepción bajo presión"],
          "regate":              ["TEC-003 Circuito 1v1", "POS-WG-001 Desborde y centro"],
          "velocidad":           ["FIS-001 Sprints con cambio dirección", "FIS-004 Velocidad de reacción"],
          "resistencia":         ["FIS-003 HIIT fútbol", "FIS-005 Fuerza preventiva"],
        };
        let recommended: string[] = [];
        let matched = "";
        for (const [key, val] of Object.entries(drills)) {
          if (lower.includes(key)) { recommended = val; matched = key; break; }
        }
        if (recommended.length === 0) {
          recommended = ["TEC-001 Rondo 4v2 (versátil)", "TAC-001 Posicionamiento táctico"];
          matched = "general";
        }
        const lines = recommended.map((d, i) => `${i + 1}. ${d}`).join("\n");
        await sendMessage(chatId,
          `💪 Drills para "${tema}"\n\n` +
          `Categoría: ${matched}\n\n${lines}\n\n` +
          `📚 Detalle completo en la app → VITAS Lab → Drill Library.`);
      }
      return successResponse({ ok: true });
    }

    // ── Pregunta libre · Claude con tool use ─────────────────
    await sendTyping(chatId);

    // Cargar historial reciente (últimos 8 turnos)
    const { data: historyRows } = await supabase
      .from("telegram_messages")
      .select("role, content")
      .eq("telegram_chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(8);

    const history = (historyRows ?? []).reverse() as Array<{ role: "user" | "assistant"; content: string }>;

    // Persistir mensaje del user
    await supabase.from("telegram_messages").insert({
      user_id: mapping.user_id,
      telegram_chat_id: chatId,
      role: "user",
      content: text,
    });

    // Idioma del coach desde Telegram (language_code de su app) → el Copilot
    // responde en su idioma. normalizeLocale cae al idioma por defecto si no está
    // en el registro (y lo respeta automáticamente cuando se añada).
    const coachLocale = normalizeLocale(update.message.from?.language_code);
    const result = await callClaudeWithTools(
      supabase,
      { userId: mapping.user_id, tenantId: mapping.tenant_id ?? mapping.user_id, chatId },
      text,
      history,
      coachLocale,
    );

    // Persistir respuesta + métricas
    const costEur = (result.tokensIn / 1_000_000) * 0.8 + (result.tokensOut / 1_000_000) * 4; // Haiku 4.5 pricing aprox
    await supabase.from("telegram_messages").insert({
      user_id: mapping.user_id,
      telegram_chat_id: chatId,
      role: "assistant",
      content: result.text,
      tool_used: result.toolsUsed[0] ?? null,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_eur: costEur,
    });

    // Update last_active + counter
    await supabase
      .from("coach_telegram_mapping")
      .update({
        last_active_at: new Date().toISOString(),
        conversation_count: (await supabase
          .from("coach_telegram_mapping")
          .select("conversation_count")
          .eq("telegram_chat_id", chatId)
          .single()).data?.conversation_count + 1 || 1,
      })
      .eq("telegram_chat_id", chatId);

    await sendMessage(chatId, result.text);
    return successResponse({ ok: true });
  }
);
