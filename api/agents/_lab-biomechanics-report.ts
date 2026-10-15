/**
 * VITAS · LAB Biomechanics Report (NUEVO · LLM Sonnet)
 * POST /api/agents/lab-biomechanics-report
 *
 * Genera el reporte técnico LAB usando Claude Sonnet 4.5.
 * Recibe métricas reales de _biomechanics-extractor + PHV + VSI subscores
 * y produce un informe detallado en español dirigido a coaches.
 *
 * Output: JSON con estructura del reporte + markdown render.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hashInput, getCached, setCached } from "../_lib/agentCache";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { normalizeLocale, languageDirective, type ReportLocale } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective, type PlayerCategory } from "../../src/lib/shared/category";

export const config = { runtime: "edge" };

const labSchema = z.object({
  playerId: z.string(),
  videoId: z.string(),
  biomechanics: z.record(z.unknown()).nullable(),
  phv: z.record(z.unknown()).nullable().optional(),
  vsi: z.record(z.unknown()).nullable().optional(),
  scanning: z.record(z.unknown()).nullable().optional(),
  playerContext: z.object({
    // Opcional (P1 bloque 5d): el orquestador mandaba 12 por defecto si no había edad.
    // Sin edad, el contexto la omite y la categoría queda en «youth» (el framing protegido).
    chronologicalAge: z.number().optional(),
    position: z.string().optional(),
  }),
}).passthrough();

const PROMPT_VERSION = "lab-biomech-v1.1.0"; // v1.1 · añadido scanning rate

function buildLabSystemPrompt(locale: ReportLocale, category: PlayerCategory): string {
  const catDirective = categoryDirective(category, locale);
  return `Eres el motor de generación de reportes biomecánicos LAB de VITAS Football Intelligence.

Tu misión: producir un informe técnico denso y profesional dirigido a entrenadores y preparadores físicos sobre las métricas biomecánicas extraídas del análisis automático de vídeo.

ESTILO OBLIGATORIO:
- Lenguaje técnico pero claro
- Cita números concretos siempre
- Identifica fortalezas y debilidades sin endulzar
- Si una asimetría es >12% señálala como riesgo de lesión
- Si trunkInclination >35° en sprint, indica posible déficit de core
${category === "senior" ? "- Si strideFrequency <2.5 Hz, indica déficit explosividad" : "- Si strideFrequency <2.5 Hz para edad >12, indica déficit explosividad"}
${category === "senior" ? "- Interpreta las métricas contra estándares de rendimiento adulto/profesional (sin ajuste madurativo)" : "- Adapta a la edad biológica (no cronológica) si tienes PHV"}

SCANNING (lectura de juego):
- Si recibes datos de scanning, INCLUYE una sección dedicada
- Cita scan_rate (scans/segundo) y comparalo con el percentil
${category === "senior" ? "- Compara con la referencia de élite profesional: los mediocentros de mayor nivel superan ~0.5 scans/seg antes de recibir" : "- Pedri sub-12 = 0.51 scans/seg · si está cerca, mencionar comparable"}
- Bilateralidad >40% = jugador equilibrado mirando a ambos lados
- Bilateralidad <20% = "punto ciego" hacia un lado (CRÍTICO en mediocentros)
- scan_rate < p25 = trabajar "shoulder check" antes de recibir

ESTRUCTURA OBLIGATORIA (JSON):
{
  "title": "string",
  "summary": "string max 240 chars · resumen 1-2 frases",
  "metrics_table": [
    { "metric": "string", "value": "string con unidad", "interpretation": "string", "alert": "ok|warning|critical" }
  ],
  "strengths": ["string"],     // 2-4 fortalezas observadas
  "concerns": ["string"],      // 0-4 alertas técnicas (si las hay)
  "recommendations": ["string"], // 3-5 recomendaciones concretas para coach
  "next_focus": "string max 200 chars · qué priorizar próximas 2 semanas",
  "confidence_score": "number 0-100 · confianza real en este análisis según los datos disponibles",
  "data_completeness": "number 0-100 · % de dimensiones evaluadas con datos reales, no inferidos",
  "not_evaluated": ["string · aspectos que no se pudieron evaluar por falta de datos"]
}

CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el análisis según los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.

NO incluyas markdown ni texto fuera del JSON.

${languageDirective(locale)}${catDirective ? `\n\n${catDirective}` : ""}`;
}

interface LabReportInput {
  playerId: string;
  videoId: string;
  biomechanics: unknown;
  phv?: unknown;
  vsi?: unknown;
  playerContext: { chronologicalAge?: number; position?: string };
}

async function callClaude(systemPrompt: string, userMessage: string, apiKey: string) {
  const res = await fetchMessages({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      ...modelParams(MODELS.reasoning, 2500),
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }, // prompt caching
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = responseText(data) || "{}";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export default withHandler(
  { schema: labSchema, requireAuth: true, allowServiceToken: true, maxRequests: 50 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorResponse({
        code: "no_api_key",
        message: "Claude API key not configured",
        status: 500,
      });
    }

    const input = body as LabReportInput;
    const locale = normalizeLocale((body as { locale?: unknown }).locale);
    const category = resolveCategory({
      age: input.playerContext.chronologicalAge,
      category: (body as { category?: unknown }).category,
    });

    // ── Cache: mismo input → mismo reporte ──────────────────────
    const cacheKey = await hashInput({ ...input, promptVersion: PROMPT_VERSION });
    const cached = await getCached(cacheKey);
    if (cached) {
      // incrementHitCount(cacheKey) requires sbUrl/sbKey · skipping in fallback path
      return successResponse({ ...cached, fromCache: true });
    }

    // ── Construir mensaje contextualizado ──────────────────────
    const userMessage = `DATOS DEL JUGADOR:
${JSON.stringify({ ...input.playerContext, chronologicalAge: input.playerContext.chronologicalAge ?? "no disponible" }, null, 2)}

MÉTRICAS BIOMECÁNICAS (extracción automática MediaPipe Pose):
${JSON.stringify(input.biomechanics, null, 2)}

SCANNING (lectura de juego · Sprint 4):
${JSON.stringify((input as { scanning?: unknown }).scanning ?? "no_data", null, 2)}

MADURACIÓN BIOLÓGICA (Mirwald):
${JSON.stringify(input.phv ?? "no_data", null, 2)}

VSI ACTUAL:
${JSON.stringify(input.vsi ?? "no_data", null, 2)}

Genera el reporte LAB en JSON estricto. Si hay datos de scanning, INCLUYE
una sección "Lectura de juego (Scanning)" con la frecuencia, comparable
y recomendación.`;

    try {
      const report = await callClaude(buildLabSystemPrompt(locale, category), userMessage, apiKey);

      const result = {
        playerId: input.playerId,
        videoId: input.videoId,
        promptVersion: PROMPT_VERSION,
        model: MODELS.reasoning,
        report,
        generatedAt: new Date().toISOString(),
      };

      await setCached(cacheKey, result, 86400 * 7); // 7 días cache

      return successResponse(result);
    } catch (err) {
      return errorResponse({
        code: "lab_generation_failed",
        message: err instanceof Error ? err.message : "Unknown LAB error",
        status: 500,
      });
    }
  }
);
