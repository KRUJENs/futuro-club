/**
 * VITAS · PHV Window Plan (Sprint B3 · día 1-2)
 * POST /api/players/phv-window-plan
 *
 * Genera un plan de carga de entrenamiento periodizado SEGÚN la fase
 * PHV actual del jugador (pre / in / post APHV). Único en el mercado:
 * Wyscout/Hudl/Veo ignoran completamente la maduración biológica.
 *
 * Body: { playerId: string }
 * Returns: { plan: { ... } }
 *
 * Cost: 1 call Claude Sonnet (~€0.04)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import {
  localeSchema,
  normalizeLocale,
  languageDirective,
  type ReportLocale,
} from "../../src/lib/shared/locale";
import { trustAnthroForPlayer } from "../../src/lib/shared/sexGatedAnthro";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

const PIPELINE_VERSION = "phv-window-v1.0";

const bodySchema = z.object({
  playerId: z.string().min(1),
  locale: localeSchema.optional(),
});

const SYSTEM_PROMPT = `Eres el motor de PHV Window Plan VITAS · diferenciador biológico
único en el mercado. Generas un plan de carga PERIODIZADO según la fase
de maduración del jugador.

Marco científico:
- PRE-PHV (offset < -1, "early" / pre-estirón):
    Ventana neuromotora dorada · alta plasticidad técnica/coordinativa.
    Carga: bajo volumen, alta variabilidad técnica. Evitar gym pesado.
- IN-PHV (-1 ≤ offset ≤ +1, "ontime" / en estirón):
    Período sensible · descoordinación temporal por crecimiento rápido.
    Carga: BAJAR intensidad cognitiva, mantener técnica básica, gestión
    de cargas para evitar Osgood-Schlatter / Sever.
- POST-PHV (offset > +1, "late" / post-estirón):
    Ventana de fuerza y potencia · capacidad anaeróbica máxima.
    Carga: incorporar gym progresivo, intervalos HIIT con balón.

Considera SIEMPRE la edad cronológica como límite seguro
(no recomendar gym pesado a un 11yo aunque sea late maturer).

Output JSON estricto:
{
  "current_phase": "pre_phv|in_phv|post_phv",
  "phase_label": "string · ej. Pre-estirón (ventana neuromotora dorada)",
  "phase_description": "string max 220 chars · qué le pasa al cuerpo ahora",
  "neuromotor_window": {
    "is_open": boolean · true si está en ventana óptima coordinativa,
    "months_remaining": integer · meses estimados de ventana o 0 si cerrada,
    "advice": "string max 180 chars"
  },
  "training_load": {
    "intensity":  1-10 · recomendada esta fase,
    "volume":     "alto|medio|bajo",
    "frequency":  "string · ej. 3x/semana técnico + 1 partido",
    "main_focus": "string max 140 chars · qué priorizar entrenamiento"
  },
  "do": [
    {"action": "string", "why": "string max 100 chars"}
  ],
  "avoid": [
    {"action": "string", "risk": "string max 100 chars"}
  ],
  "monitoring": {
    "metrics_to_track": ["string","string","string"],
    "remeasure_in_months": integer · cuándo volver a medir antropometría
  },
  "next_phase_preview": "string max 180 chars · qué esperar próxima fase"
}

3-5 do, 2-3 avoid. Output SOLO JSON · sin markdown.`;

interface PlayerCtx {
  name: string | null;
  age: number | null;
  position: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  phv_category: string;
  phv_offset: number;
  /** Edad DECIMAL de la medición (la usada en Mirwald), no el entero `age`. */
  measurement_age: number | null;
}

function buildContext(p: PlayerCtx, locale: ReportLocale): string {
  const offset = p.phv_offset;
  const aphv = p.measurement_age !== null ? Number((p.measurement_age - offset).toFixed(2)) : null;
  return `JUGADOR
- Nombre: ${p.name ?? "—"}
- Edad cronológica: ${p.age ?? "?"} años
- Posición: ${p.position ?? "?"}
- Altura: ${p.height_cm ?? "?"} cm · Peso: ${p.weight_kg ?? "?"} kg

MADURACIÓN PHV (Mirwald)
- Categoría: ${p.phv_category ?? "no calculada"}
- Offset: ${offset > 0 ? "+" : ""}${offset.toFixed(2)} años
- APHV estimado: ${aphv ? `${aphv}a` : "—"}
- Fase: ${
    offset < -1 ? "PRE-PHV (pre-estirón)"
    : offset > 1 ? "POST-PHV (post-estirón)"
    : "IN-PHV (en estirón · período sensible)"
  }

Genera plan ESPECÍFICO para esta fase + edad cronológica + posición.

${languageDirective(locale)}`;
}

async function callClaude(system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetchMessages({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      ...modelParams(MODELS.reasoning, 2200),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = responseText(data) || "{}";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { _raw: raw, _parseError: true }; }
}

export default withHandler(
  { schema: bodySchema, requireAuth: true, allowServiceToken: true, maxRequests: 10 },
  async ({ body, userId, isServiceCall }) => {
    if (!ANTHROPIC_API_KEY) {
      return errorResponse({ code: "no_api_key", message: "missing", status: 500 });
    }
    const input = body as z.infer<typeof bodySchema>;
    const reportLocale = normalizeLocale(input.locale);
    const startedAt = Date.now();

    // Perfil de jugador + generación LLM de pago → ownership obligatorio.
    if (!isServiceCall && !(await ownsPlayer(input.playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar player + última antropometría ────────────────
    const { data: pRow, error: pErr } = await supabase
      .from("players")
      .select("name, age, position, height_cm, weight_kg, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
      .eq("id", input.playerId)
      .single();

    if (pErr || !pRow) {
      return errorResponse({ code: "player_not_found", message: pErr?.message ?? "no encontrado", status: 404 });
    }

    // PHV SOLO desde la última fila FIABLE de player_anthropometrics (gate único ·
    // regla del owner 28-sep: 4 medidas + edad decimal por fecha de nacimiento +
    // sexo). NO desde players.phv_category: antes de aplicar 069 guarda aún el valor
    // naive legacy (p.ej. un pre-púber sin medidas «early», offset −1.2). select=*
    // ⇒ sin 069 la fila no trae age_source ⇒ no fiable ⇒ no_phv (falla cerrado).
    const { data: anthroRaw } = await supabase
      .from("player_latest_anthropometrics")
      .select("*")
      .eq("player_id", input.playerId)
      .maybeSingle();
    // + sexo registrado del jugador (P1 bloque 7): un «M» sin confirmar no aporta PHV.
    const trust = trustAnthroForPlayer(anthroRaw, pRow);
    if (!trust.trusted || trust.category === null || trust.offset === null) {
      return errorResponse({
        code: "no_phv",
        message: `PHV no disponible · ${trust.gate_reason ?? "registra una medición antropométrica completa"}`,
        status: 400,
      });
    }

    const ctx: PlayerCtx = {
      name: pRow.name,
      age: pRow.age,
      position: pRow.position,
      height_cm: pRow.height_cm,
      weight_kg: pRow.weight_kg,
      phv_category: trust.category === "ontme" ? "ontime" : trust.category,
      phv_offset: trust.offset,
      measurement_age: trust.chronologicalAge,
    };

    // ── 2. Generar plan ────────────────────────────────────────
    let plan: Record<string, unknown>;
    try {
      plan = await callClaude(SYSTEM_PROMPT, buildContext(ctx, reportLocale));
    } catch (err) {
      return errorResponse({
        code: "claude_error",
        message: err instanceof Error ? err.message : "Claude failed",
        status: 502,
      });
    }

    return successResponse({
      plan,
      pipelineVersion: PIPELINE_VERSION,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      context: {
        chronologicalAge: ctx.age,
        phvCategory: ctx.phv_category,
        phvOffset: ctx.phv_offset,
      },
    });
  }
);
