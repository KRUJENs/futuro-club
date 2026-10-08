/**
 * VITAS · Compare to Rival (Sprint B3 · día 3-5)
 * POST /api/team/compare-rival
 *
 * Compara TU equipo contra un rival descrito por el coach.
 * Opcionalmente acepta video-análisis de Gemini para enriquecer el plan.
 * Claude analiza la asimetría de fortalezas/debilidades y genera plan
 * de partido + drills específicos para entrenar la semana previa.
 *
 * Body:
 *   {
 *     rivalName: string,
 *     rivalFormation?: string,
 *     rivalNotes?: string,         // texto libre con lo que sabe el coach
 *     rivalStrengths?: string[],   // hasta 3
 *     rivalWeaknesses?: string[],  // hasta 3
 *     rivalKeyPlayers?: Array<{ name: string; position: string; threat: string }>,
 *     matchContext?: string,       // local/visitante, eliminatoria, etc.
 *     rivalVideoAnalysis?: object, // Gemini video observation (Sprint 3)
 *   }
 *
 * Returns: { plan: { tactical, key_matchups, exploitable, vulnerabilities, drills } }
 *
 * Cost: ~€0.05 por análisis (1x Sonnet con prompt cache).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { avgEvaluatedVsi, byVsiDescNullsLast, formatVsi } from "../_lib/vsiStats";
import { createClient } from "@supabase/supabase-js";
import { localeSchema, normalizeLocale, languageDirective } from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

const PIPELINE_VERSION = "compare-rival-v1.0";

const bodySchema = z.object({
  rivalName: z.string().min(1).max(80),
  rivalFormation: z.string().max(40).optional(),
  rivalNotes: z.string().max(800).optional(),
  rivalStrengths: z.array(z.string().max(120)).max(5).optional(),
  rivalWeaknesses: z.array(z.string().max(120)).max(5).optional(),
  rivalKeyPlayers: z
    .array(
      z.object({
        name: z.string().max(80),
        position: z.string().max(40),
        threat: z.string().max(160),
      }),
    )
    .max(5)
    .optional(),
  matchContext: z.string().max(200).optional(),
  rivalVideoAnalysis: z.record(z.unknown()).optional(),
  locale: localeSchema.optional(),
});

const SYSTEM_PROMPT = `Eres el motor Compare-to-Rival VITAS. Comparas DOS equipos juveniles
y produces plan de partido + drills.

ENFOQUE:
- Identifica matchups críticos (qué jugador tuyo defiende a qué rival clave)
- Detecta vulnerabilidades del rival que TU equipo puede explotar
- Detecta vulnerabilidades TUYAS que ellos pueden explotar
- Da plan de partido en 3 fases (inicio · medio · cierre)
- Recomienda drills concretos para entrenar la semana previa

CONSIDERA SIEMPRE:
- Distribución PHV de tu equipo (precoces / on-time / tardíos)
- Asimetría física esperada por categoría/edad
- Que el rival tiene su propia distribución desconocida (asumir mixta)
- POLIVALENCIA: si un jugador tiene secondary_positions, eso da flexibilidad táctica
  · Para key_matchups específicos sugiere mover jugadores polivalentes a la posición ideal contra ese rival
  · Ej: "Samu (LB principal · también DM): jugar de DM para neutralizar al 10 rival"

Output JSON estricto:
{
  "tldr": "string max 200 chars · resumen 1 frase del plan",
  "tactical_approach": {
    "formation_recommended": "string · ej. 1-3-2-3",
    "high_press":  boolean,
    "compactness": "alta|media|baja",
    "tempo": "rapido|controlado|paciente",
    "key_principle": "string max 160 chars"
  },
  "key_matchups": [
    {
      "ours": "string · jugador o posición tuya",
      "theirs": "string · rival",
      "approach": "string max 140 chars · cómo defenderlo/atacarlo"
    }
  ],
  "exploit_their_weaknesses": [
    {"weakness": "string", "how_to_exploit": "string max 140 chars"}
  ],
  "guard_our_vulnerabilities": [
    {"our_vulnerability": "string", "mitigation": "string max 140 chars"}
  ],
  "match_phases": {
    "first_15min":  "string max 160 chars",
    "mid_match":    "string max 160 chars",
    "last_15min":   "string max 160 chars"
  },
  "training_week": {
    "monday":    "string · ej. recuperación + análisis vídeo rival",
    "wednesday": "string · drill principal",
    "friday":    "string · activación pre-partido"
  },
  "recommended_drills": [
    {"drill": "string", "purpose": "string max 100 chars", "duration_min": integer}
  ],
  "wildcards": [
    {"scenario": "string · ej. si nos meten gol pronto", "response": "string max 140 chars"}
  ]
}

3 matchups, 2-3 weaknesses, 2-3 vulnerabilities, 3-5 drills, 2 wildcards.
Sin markdown.`;

interface PlayerSummary {
  name: string | null;
  age: number | null;
  position: string | null;
  vsi: number | null;
  phv_category: string | null;
}

function buildVideoSection(video: Record<string, unknown>): string {
  const lines: string[] = ["\n─── ANÁLISIS DE VÍDEO RIVAL (Gemini) ───"];

  const resumen = video.resumenGeneral as string | undefined;
  if (resumen) lines.push(`Resumen: ${resumen}`);

  const patrones = video.patronesJuego as string[] | undefined;
  if (patrones?.length) {
    lines.push("Patrones de juego observados:");
    patrones.forEach((p) => lines.push(`  • ${p}`));
  }

  const dims = video.dimensiones as Record<string, { observaciones?: string[]; score_estimado?: number }> | undefined;
  if (dims) {
    lines.push("Dimensiones evaluadas:");
    for (const [key, val] of Object.entries(dims)) {
      if (val?.score_estimado != null) {
        lines.push(`  ${key}: ${val.score_estimado}/10`);
        val.observaciones?.slice(0, 2).forEach((o) => lines.push(`    - ${o}`));
      }
    }
  }

  const destacados = video.momentosDestacados as Array<{ timestamp?: string; tipo?: string; descripcion?: string }> | undefined;
  if (destacados?.length) {
    lines.push("Momentos destacados:");
    destacados.slice(0, 5).forEach((m) =>
      lines.push(`  [${m.timestamp ?? "?"}] ${m.tipo ?? ""}: ${m.descripcion ?? ""}`)
    );
  }

  const eventos = video.eventosContados as Record<string, number> | undefined;
  if (eventos && Object.keys(eventos).length > 0) {
    lines.push("Eventos contados:");
    for (const [k, v] of Object.entries(eventos)) {
      if (v > 0) lines.push(`  ${k}: ${v}`);
    }
  }

  return lines.join("\n");
}

function buildContext(
  ours: PlayerSummary[],
  ourTeamName: string,
  rival: z.infer<typeof bodySchema>,
): string {
  const phvCounts = {
    early:   ours.filter((p) => p.phv_category === "early").length,
    ontime:  ours.filter((p) => p.phv_category === "ontime" || p.phv_category === "ontme").length,
    late:    ours.filter((p) => p.phv_category === "late").length,
    unknown: ours.filter((p) => !p.phv_category).length,
  };
  // Media SOLO sobre evaluados (vsi != null); "sin evaluar" si ninguno (invariante #2).
  const avgVsiNum = avgEvaluatedVsi(ours);
  const avgVsi = avgVsiNum === null ? "sin evaluar" : avgVsiNum.toFixed(1);
  const ages = ours.map((p) => p.age ?? 0).filter((a) => a > 0);
  const avgAge = ages.length > 0 ? (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : "?";

  return `─── NUESTRO EQUIPO ───
Nombre: ${ourTeamName}
Plantilla: ${ours.length} jugadores · Edad promedio ${avgAge}a
VSI promedio: ${avgVsi}
PHV: pre-estirón ${phvCounts.early} · ontime ${phvCounts.ontime} · post-estirón ${phvCounts.late}${phvCounts.unknown ? ` · sin medir ${phvCounts.unknown}` : ""}

Top 8 por VSI ("—" = sin evaluar, al final):
${[...ours]
  .sort(byVsiDescNullsLast)
  .slice(0, 8)
  .map((p, i) => `  ${i + 1}. ${p.name ?? "?"} (${p.position ?? "?"}, ${p.age ?? "?"}a, VSI ${formatVsi(p.vsi)}, PHV ${p.phv_category ?? "?"})`)
  .join("\n")}

─── RIVAL ───
Nombre: ${rival.rivalName}
${rival.rivalFormation   ? `Formación reportada: ${rival.rivalFormation}` : "Formación: desconocida"}
${rival.matchContext     ? `Contexto: ${rival.matchContext}` : ""}
${rival.rivalNotes       ? `\nNotas del coach:\n${rival.rivalNotes}` : ""}
${rival.rivalStrengths?.length ? `\nFortalezas conocidas:\n${rival.rivalStrengths.map((s) => `  - ${s}`).join("\n")}` : ""}
${rival.rivalWeaknesses?.length ? `\nDebilidades conocidas:\n${rival.rivalWeaknesses.map((w) => `  - ${w}`).join("\n")}` : ""}
${rival.rivalKeyPlayers?.length ? `\nJugadores clave:\n${rival.rivalKeyPlayers.map((k) => `  - ${k.name} (${k.position}): ${k.threat}`).join("\n")}` : ""}

${rival.rivalVideoAnalysis
    ? `${buildVideoSection(rival.rivalVideoAnalysis as Record<string, unknown>)}

VENTAJA: Análisis CON VÍDEO del rival via Gemini · usa las observaciones
de vídeo para hacer el plan más preciso. Prioriza evidencia del vídeo
sobre las notas del coach cuando haya contradicción.`
    : `LIMITACIÓN: Análisis SIN VÍDEO del rival · basado en lo que reporta
el coach. Genera plan accionable y honesto sobre incertidumbre.`}`;
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
      ...modelParams(MODELS.reasoning, 2500),
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
  { schema: bodySchema, requireAuth: true, maxRequests: 10 },
  async ({ body, userId }) => {
    if (!ANTHROPIC_API_KEY) {
      return errorResponse({ code: "no_api_key", message: "missing", status: 500 });
    }
    if (!userId) {
      return errorResponse({ code: "unauthorized", message: "Login requerido", status: 401 });
    }
    const input = body as z.infer<typeof bodySchema>;
    const reportLocale = normalizeLocale(input.locale);
    const startedAt = Date.now();

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar nuestro equipo (top 40 por VSI) ──────────────
    // Incluimos secondary_positions para que el agente considere polivalencia al
    // diseñar el matchup (un LB que también es DM da más flexibilidad táctica)
    const { data: players, error } = await supabase
      .from("players")
      .select("name, age, position, secondary_positions, vsi, phv_category")
      // Ownership a nivel de fila: "nuestro equipo" son SOLO los jugadores del usuario
      // (players.user_id, 076), no el top-40 GLOBAL (que filtraba nombres de menores
      // ajenos al plan y al ourTeamSize) ni los de otras cuentas del mismo tenant.
      .eq("user_id", userId)
      // nulls last: los NO evaluados (vsi null) no deben truncar a los evaluados
      // con el limit (invariante #2; Postgres ordena DESC con NULLS FIRST).
      .order("vsi", { ascending: false, nullsFirst: false })
      .limit(40);

    if (error || !players || players.length === 0) {
      return errorResponse({
        code: "no_players",
        message: "Sin jugadores en plantilla · imposible comparar",
        status: 400,
      });
    }

    // ── 2. Generar plan ────────────────────────────────────────
    let plan: Record<string, unknown>;
    try {
      // El idioma de salida se inyecta como directiva dinámica al final del
      // system prompt; el resto del prompt se mantiene en su idioma base.
      const systemPrompt = `${SYSTEM_PROMPT}\n\n${languageDirective(reportLocale)}`;
      plan = await callClaude(systemPrompt, buildContext(players as PlayerSummary[], "Mi equipo", input));
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
      ourTeamSize: players.length,
      rivalName: input.rivalName,
      generatedBy: userId,
    });
  }
);
