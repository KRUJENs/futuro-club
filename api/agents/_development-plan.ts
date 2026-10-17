/**
 * VITAS · Development Plan (NUEVO · LLM Haiku + RAG drills)
 * POST /api/agents/development-plan
 *
 * Genera el Plan de Desarrollo de 12 semanas.
 *
 * Flow:
 *   1. Recibe debilidades detectadas (de subscores VSI bajos)
 *   2. Hace RAG sobre la knowledge_base buscando drills relacionados
 *   3. Claude Haiku redacta el plan estructurado en 12 semanas
 *
 * Cost: ~€0,003 por reporte (Haiku + 1 RAG query)
 */

import { z } from "zod";
import { MODELS } from "../_lib/models";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hashInput, getCached, setCached } from "../_lib/agentCache";
import { normalizeLocale, languageDirective, type ReportLocale } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective, type PlayerCategory } from "../../src/lib/shared/category";

export const config = { runtime: "edge" };

// Schema tolerante con scanning (Sprint 4)
const planSchema = z.object({
  playerId: z.string(),
  videoId: z.string().optional(),
  analysisId: z.string().optional(),
  vsi: z.record(z.unknown()).nullable().optional(),
  phv: z.record(z.unknown()).nullable().optional(),
  biomechanics: z.record(z.unknown()).nullable().optional(),
  scanning: z.record(z.unknown()).nullable().optional(),
  similarity: z.record(z.unknown()).nullable().optional(),
  videoObservations: z.record(z.unknown()).nullable().optional(),
  videoContext: z.record(z.unknown()).nullable().optional(),
  playerContext: z.object({
    chronologicalAge: z.number().optional(),
    position: z.string().optional(),
  }).passthrough(),
}).passthrough();

const PROMPT_VERSION = "dev-plan-v1.3.0"; // v1.2 = deficits observados del vídeo + scanning serializado (docx #14 P2); v1.3 = sin duelos (P1 bloque 6)

function buildSystemPrompt(locale: ReportLocale, category: PlayerCategory): string {
  return `Eres el motor de generación de Planes de Desarrollo de VITAS.

Tu misión: producir un plan estructurado de 12 semanas para ${category === "senior" ? "un jugador sénior/profesional de fútbol" : "un jugador juvenil de fútbol"}, priorizando sus debilidades detectadas y ${category === "senior" ? "orientándolo al rendimiento y la forma actual" : "respetando su ventana de desarrollo PHV"}.

REGLAS:
${category === "senior" ? `- Ajusta las cargas al calendario competitivo y al estado de forma actual del jugador.` : `- Si phvStatus es "during_phv" (estirón): NO programes cargas pesadas. Foco técnico-coordinativo.
- Si offset PHV es "early" (estirón en curso): reduce trabajo de fuerza absoluta.`}
- Si VSI subscore "technique" <60: priorizar drills técnicos.
${category === "senior" ? `- Si VSI subscore "physical" <60: fuerza progresiva.` : `- Si VSI subscore "physical" <60 y phvStatus="post_phv": fuerza progresiva.`}
- Si VSI subscore "tactical" <60: situaciones de juego reducidas.
- Si scanning.scan_rate < p25 de su edad: AÑADIR drill "shoulder check pre-recepción"
  (girar cabeza 2-3 veces antes de recibir el balón) en el primer bloque.
- Si scanning.bilateralityPct < 30: AÑADIR drill de pase ciego al lado débil.
- Estructura el plan en 4 bloques de 3 semanas cada uno.
- Usa los drills sugeridos del RAG context si encajan; no inventes drills nuevos.
- EVIDENCIA (docx #14): las DEBILIDADES incluyen deficits OBSERVADOS en el vídeo (p. ej. "precisión de pase (observada)", "escaneo/lectura de juego (observado)"). El objetivo de cada bloque DEBE atacar un gap concreto de esa lista y, cuando venga de OBSERVACIÓN DIRECTA DEL VÍDEO, citarlo (p. ej. "mejorar precisión de pase — 55% observado"). Si la lista es "ninguna con datos suficientes", NO inventes debilidades: haz un plan de mantenimiento/desarrollo general y dilo explícitamente.

POLIVALENCIA · si player.secondaryPositions[] tiene elementos:
- El plan debe afianzar la polivalencia: incluir drills específicos de cada posición declarada
- Ejemplo: principal LB + secundarias DM/CAM → 60% drills LB, 25% DM, 15% CAM
${category === "senior" ? `- Ajusta la carga según la posición más exigente del set declarado` : `- Ajusta carga PHV según la posición más exigente del set declarado`}
- Si videoContext.playedPosition existe, prioriza drills correctivos de la posición jugada
- Si el agente detecta una posición no declarada con potencial, sugiérela en metrics_to_track como discovery

ESTRUCTURA OBLIGATORIA (JSON):
{
  "title": "string",
  "duration_weeks": 12,
  "primary_focus": "technique|physical|tactical|mixed",
  "phv_consideration": "string max 200 chars",
  "blocks": [
    {
      "block_number": 1,
      "weeks": "1-3",
      "theme": "string",
      "objectives": ["string"],
      "weekly_sessions": 3,
      "drills": [
        { "name": "string", "frequency": "string", "duration_min": number, "description": "string" }
      ]
    }
  ],
  "metrics_to_track": ["string"],
  "review_checkpoints": ["string fecha relativa"],
  "confidence_score": number,
  "data_completeness": number,
  "not_evaluated": ["string · aspectos que NO se pudieron evaluar por falta de datos; array vacío si todo cubierto"]
}

REGLAS ABSOLUTAS DE DATOS:
1. Si no tienes un dato concreto, di "No disponible" o "Sin datos suficientes". NUNCA inventes valores.
2. NUNCA uses "aproximadamente", "más o menos", "alrededor de", "cercano a" para fabricar datos.
3. NUNCA compares con jugadores famosos ("el próximo Messi", "recuerda a Iniesta").
4. Si faltan >30% de las dimensiones de evaluación, penaliza el score explícitamente y menciona: "Evaluación parcial — datos insuficientes en: [dimensiones faltantes]".
5. Separa siempre observación directa (visto en video) de inferencia (estimado por modelo).
6. NUNCA menciones decisiones contractuales, económicas o de transferencias — no es nuestro dominio.
7. Banderas rojas (lesiones recurrentes, edad fuera de target, datos contradictorios) → mencionarlas SIEMPRE.
8. CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el análisis según los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.

NO incluyas markdown ni texto fuera del JSON.

${languageDirective(locale)}${category === "senior" ? "\n\n" : ""}${categoryDirective(category, locale)}`;
}

async function fetchRagDrills(weaknesses: string[], baseUrl: string, authToken: string) {
  // Llama a /api/rag/query buscando drills relevantes para las debilidades
  try {
    const query = `drills para mejorar ${weaknesses.join(", ")} en jugador juvenil`;
    const res = await fetch(`${baseUrl}/api/rag/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ query, category: "drill", limit: 8 }),
    });
    const data = await res.json();
    return data?.results ?? [];
  } catch {
    return [];
  }
}

function detectWeaknesses(subscores: Record<string, unknown>): string[] {
  const weaknesses: string[] = [];
  for (const [key, val] of Object.entries(subscores)) {
    const raw =
      typeof val === "object" && val !== null && "value" in val
        ? (val as { value: unknown }).value
        : val;
    // Sub-score sin valor real (null / CONSTANTE / bloqueado · G4) NO es una debilidad:
    // se omite en vez de tratarlo como 0 (que lo marcaría siempre por debajo de 60).
    if (typeof raw !== "number") continue;
    if (raw < 60) weaknesses.push(key);
  }
  return weaknesses;
}

/**
 * docx #14 · P2 · Deficits OBSERVADOS en el vídeo (eventos reales), para que el plan
 * apunte a gaps vistos y no solo a subscores (que suelen venir null en vídeo). Solo
 * marca un déficit con muestra suficiente (≥3) y señal real — nunca desde un 0/ausencia.
 */
export function detectObservedWeaknesses(videoObservations: unknown): string[] {
  const obs = videoObservations as
    | { gemini?: { eventosContados?: Record<string, unknown> } | null; eventSummary?: Record<string, unknown> | null }
    | null;
  const out: string[] = [];
  // null/ausente = NO observado (Gemini: "0 = lo vio y no ocurrió; null = no pudo
  // observarlo"). Un déficit solo se marca si TODOS sus datos se observaron: antes
  // null→0 y un `escaneos` no visible acababa como "escaneo … (observado en vídeo)".
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const ec = obs?.gemini?.eventosContados ?? null;
  const es = obs?.eventSummary ?? null;
  if (ec) {
    const pc = n(ec.pasesCompletados), pf = n(ec.pasesFallados);
    const passTot = pc !== null && pf !== null ? pc + pf : null;
    if (passTot !== null && pc !== null && passTot >= 3 && pc / passTot < 0.6) out.push("precisión de pase (observada en vídeo)");
    // Sin déficit de «duelos» (P1 bloque 6): sin criterio validado de duelo (src/lib/tracking/duels.ts).
    const scans = n(ec.escaneos);
    if (passTot !== null && scans !== null && passTot >= 5 && scans <= 2) out.push("escaneo/lectura de juego (observado en vídeo)");
    // Muestra mínima ≥3 (como los demás): un n=1 (1 pérdida, 0 recuperaciones) NO es
    // un déficit — evita fabricar "control bajo presión" desde casi nada (revisión #179).
    const losses = n(ec.perdidas), recs = n(ec.recuperaciones);
    if (losses !== null && recs !== null && losses + recs >= 3 && losses > recs) out.push("control bajo presión (observado en vídeo)");
  } else if (es) {
    if (typeof es.passCompletionPct === "number" && es.passCompletionPct < 60) out.push("precisión de pase (observada en vídeo)");
  }
  return out;
}

async function callClaudeHaiku(systemPrompt: string, userMessage: string, apiKey: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELS.fast,
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error ${res.status}`);
  const data = await res.json();
  const text: string = data.content?.[0]?.text ?? "";
  // Extracción robusta: el modelo puede envolver el JSON en prosa o ```json.
  // Un JSON.parse crudo sobre esa salida lanzaría y tumbaría todo el plan; el
  // resto de agentes Haiku ya extraen el objeto con este mismo patrón.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON object in Claude response");
  return JSON.parse(jsonMatch[0]);
}

export default withHandler(
  { schema: planSchema, requireAuth: true, allowServiceToken: true, maxRequests: 50 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.VITAS_PUBLIC_URL
      ?? process.env.VITAS_API_BASE_URL
      ?? `https://${process.env.VERCEL_URL ?? "localhost:3000"}`;
    const authToken = process.env.INTERNAL_API_TOKEN ?? "";

    if (!apiKey) {
      return errorResponse({ code: "no_api_key", message: "Claude API key missing", status: 500 });
    }

    const input = body as z.infer<typeof planSchema>;
    const locale = normalizeLocale((input as { locale?: unknown }).locale);
    // C1 multi-categoría · override explícito > edad cronológica > default youth
    const category = resolveCategory({
      age: input.playerContext.chronologicalAge,
      category: (input as { category?: unknown }).category,
    });
    const cacheKey = await hashInput({ ...input, promptVersion: PROMPT_VERSION });
    const cached = await getCached(cacheKey);
    if (cached) return successResponse({ ...cached, fromCache: true });

    try {
      // ── 1. Detectar debilidades ────────────────────────────────
      type VsiShape = { vsi?: number; subscores?: Record<string, unknown> };
      const inputVsi = input.vsi as VsiShape | null | undefined;
      const subscores = (inputVsi?.subscores ?? {}) as Record<string, unknown>;
      // P2: debilidades de subscores (suelen venir vacías en vídeo) + deficits OBSERVADOS
      // en los eventos del vídeo → el plan apunta a gaps vistos, no a un template genérico.
      const weaknesses = [
        ...detectWeaknesses(subscores),
        ...detectObservedWeaknesses(input.videoObservations),
      ];

      // ── 2. RAG: buscar drills relacionados ─────────────────────
      const ragDrills =
        weaknesses.length > 0
          ? await fetchRagDrills(weaknesses, baseUrl, authToken)
          : [];

      // ── 3. Construir mensaje y llamar Claude ───────────────────
      const userMessage = `JUGADOR:
${JSON.stringify(input.playerContext, null, 2)}

OBSERVACIÓN DIRECTA DEL VÍDEO (eventos contados — base de los objetivos del plan):
${JSON.stringify(input.videoObservations ?? "no_data", null, 2)}

ESCANEO (scan-rate; dispara los drills de shoulder-check/bilateralidad si aplica):
${JSON.stringify(input.scanning ?? "no_data", null, 2)}

VSI:
${JSON.stringify(input.vsi, null, 2)}

PHV:
${JSON.stringify(input.phv ?? "no_data", null, 2)}

DEBILIDADES DETECTADAS (subscores <60 + deficits observados en el vídeo):
${weaknesses.join(", ") || "ninguna con datos suficientes"}

DRILLS DISPONIBLES (de la knowledge base de VITAS):
${ragDrills.map((d: { content?: string }, i: number) => `${i + 1}. ${d.content?.slice(0, 200)}`).join("\n") || "ningún drill encontrado"}

Genera el Plan de Desarrollo de 12 semanas en JSON estricto.`;

      const plan = await callClaudeHaiku(buildSystemPrompt(locale, category), userMessage, apiKey);

      const result = {
        playerId: input.playerId,
        videoId: input.videoId,
        promptVersion: PROMPT_VERSION,
        model: MODELS.fast,
        weaknessesDetected: weaknesses,
        ragDrillsUsed: ragDrills.length,
        plan,
        generatedAt: new Date().toISOString(),
      };

      await setCached(cacheKey, result, 86400 * 7);
      return successResponse(result);
    } catch (err) {
      return errorResponse({
        code: "plan_generation_failed",
        message: err instanceof Error ? err.message : "Unknown error",
        status: 500,
      });
    }
  }
);
