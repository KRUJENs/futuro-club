/**
 * VITAS · Projection Report (NUEVO · LLM Haiku)
 * POST /api/agents/projection-report
 *
 * Genera la proyección VSI a 1, 2 y 3 años usando:
 *   - VSI actual + subscores
 *   - PHV adjusted offset (Mirwald)
 *   - Edad biológica vs cronológica
 *   - Tendencia histórica (si existen análisis previos del mismo jugador)
 *
 * El cálculo de la curva es PARCIALMENTE determinista (curva PHV típica)
 * y la narrativa la añade Claude Haiku.
 *
 * Cost: ~€0,002 por reporte
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hashInput, getCached, setCached } from "../_lib/agentCache";
import { MODELS } from "../_lib/models";
import { normalizeLocale, languageDirective, type ReportLocale } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective, type PlayerCategory } from "../../src/lib/shared/category";

export const config = { runtime: "edge" };

// Schema tolerante: PHV puede ser null si player no tiene anthropometrics
const projectionSchema = z.object({
  playerId: z.string(),
  videoId: z.string().optional(),
  analysisId: z.string().optional(),
  vsi: z.record(z.unknown()).nullable().optional(),
  phv: z.record(z.unknown()).nullable().optional(),
  biomechanics: z.record(z.unknown()).nullable().optional(),
  scanning: z.record(z.unknown()).nullable().optional(),
  similarity: z.record(z.unknown()).nullable().optional(),
  historicalVsi: z.array(z.unknown()).optional(),
  vsiHistory: z.array(z.unknown()).nullable().optional(), // nombre real del sharedContext (P1)
  videoObservations: z.record(z.unknown()).nullable().optional(),
  videoContext: z.record(z.unknown()).nullable().optional(),
  playerContext: z.object({
    chronologicalAge: z.number().optional(),
    position: z.string().optional(),
  }).passthrough(),
}).passthrough();

const PROMPT_VERSION = "projection-v1.3.0"; // v1.3 = sin duelos como ejemplo de key_driver (P1 bloque 6); v1.2 = tendencia real (vsiHistory) + key_drivers desde observaciones (docx #14 P2)

function buildSystemPrompt(locale: ReportLocale, category: PlayerCategory): string {
  return `Eres el motor de Proyección 3 años de VITAS.

Recibes la curva proyectada ${category === "senior" ? "(calculada deterministicamente)" : "(calculada deterministicamente con coeficientes PHV)"} y las debilidades actuales. Tu misión es narrar qué significa esa proyección para el jugador.

REGLAS:
- Sé HONESTO: si la curva sube poco, no la infles
- ${category === "senior" ? "Explica la volatilidad de la proyección según forma reciente e historial de rendimiento (sin maduración)" : `Si está en "during_phv", explica que la proyección es más volátil`}
- Identifica los 2-3 sub-scores que más impactarán el VSI futuro
- Sugiere qué pasa si trabaja sus debilidades (escenario optimista) vs si no (escenario base)

POLIVALENCIA · si player.secondaryPositions[] tiene elementos:
- Genera UNA proyección por cada posición declarada: positionProjections: { [code]: { y1, y2, y3, headline } }
- Identifica cuál posición tiene el techo más alto a 3 años
- El headline principal debe mencionar la posición de mayor techo proyectado
- key_drivers pueden ser distintos por posición (ej. CAM necesita visión, LB necesita velocidad)

ESTRUCTURA OBLIGATORIA (JSON):
{
  "title": "string",
  "headline": "string max 140 chars",
  "current_vsi": number,
  "year_1_vsi": number,
  "year_2_vsi": number,
  "year_3_vsi": number,
  "phv_consideration": "string max 240 chars",
  "key_drivers": ["string"],
  "scenarios": {
    "base": "string max 200 chars",
    "with_focused_work": "string max 200 chars"
  },
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

${languageDirective(locale)}${category === "senior" ? `\n\n${categoryDirective(category, locale)}` : ""}`;
}

/**
 * Curva determinista de proyección VSI según etapa PHV.
 * Refleja el "boost" típico durante el estirón y la consolidación post-PHV.
 */
function projectVsiCurve(currentVsi: number, phv: { offset: number; category: "early" | "ontime" | "late" }): {
  year1: number;
  year2: number;
  year3: number;
} {
  const base = currentVsi;
  let r1 = 0, r2 = 0, r3 = 0;

  if (phv.category === "early") {
    // Pre-PHV: crecimiento progresivo, máximo en año 2 (estirón)
    r1 = base + 4;
    r2 = base + 9;
    r3 = base + 12;
  } else if (phv.category === "ontime") {
    // Durante PHV: año 1 más volátil, consolidación años 2-3
    r1 = base + 2;
    r2 = base + 6;
    r3 = base + 10;
  } else {
    // Post-PHV: ya muestra su nivel, crecimiento moderado
    r1 = base + 3;
    r2 = base + 6;
    r3 = base + 8;
  }

  return {
    year1: Math.min(100, Number(r1.toFixed(1))),
    year2: Math.min(100, Number(r2.toFixed(1))),
    year3: Math.min(100, Number(r3.toFixed(1))),
  };
}

async function callHaiku(systemPrompt: string, userMessage: string, apiKey: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELS.fast,
      max_tokens: 1500,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.content?.[0]?.text ?? "{}");
}

export default withHandler(
  { schema: projectionSchema, requireAuth: true, allowServiceToken: true, maxRequests: 100 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorResponse({ code: "no_api_key", message: "missing", status: 500 });
    }

    const input = body as z.infer<typeof projectionSchema>;

    // Tipado defensivo · vsi y phv pueden ser null/undefined según schema
    type VsiShape = { vsi: number; tier?: string; subscores?: Record<string, unknown> };
    type PhvShape = { offset: number; category?: string };
    const inputVsi = input.vsi as VsiShape | null | undefined;
    const inputPhv = input.phv as PhvShape | null | undefined;

    if (!inputVsi || typeof inputVsi.vsi !== "number") {
      return errorResponse({ code: "missing_vsi", message: "VSI requerido para proyección", status: 400 });
    }
    if (!inputPhv || typeof inputPhv.offset !== "number") {
      return errorResponse({ code: "missing_phv", message: "PHV requerido para proyección", status: 400 });
    }

    const cacheKey = await hashInput({ ...input, promptVersion: PROMPT_VERSION });
    const cached = await getCached(cacheKey);
    if (cached) return successResponse({ ...cached, fromCache: true });

    try {
      // Cálculo determinista de la curva
      const curve = projectVsiCurve(inputVsi.vsi, {
        offset: inputPhv.offset,
        category: (inputPhv.category ?? "ontime") as "early" | "ontime" | "late",
      });

      // El sharedContext trae vsiHistory MÁS-RECIENTE-PRIMERO; se ordena ascendente
      // (antiguo→reciente) para que el modelo narre la tendencia en el sentido correcto
      // (evita "bajó de X a Y" cuando en realidad subió · revisión #179).
      const vsiHistAsc = [
        ...((input.vsiHistory ?? input.historicalVsi ?? []) as Array<Record<string, unknown>>),
      ].sort((a, b) => String(a?.date ?? "").localeCompare(String(b?.date ?? "")));

      const userMessage = `JUGADOR:
${JSON.stringify(input.playerContext, null, 2)}

VSI ACTUAL: ${inputVsi.vsi} (tier: ${inputVsi.tier ?? "?"})
Subscores: ${JSON.stringify(inputVsi.subscores, null, 2)}

PHV:
${JSON.stringify(inputPhv, null, 2)}

CURVA PROYECTADA (calculada deterministicamente):
- Año 1: ${curve.year1}
- Año 2: ${curve.year2}
- Año 3: ${curve.year3}

HISTÓRICO VSI PREVIO (orden cronológico antiguo→reciente; ≥2 puntos = tendencia REAL; vacío = primer análisis):
${JSON.stringify(vsiHistAsc, null, 2)}

OBSERVACIÓN DIRECTA DEL VÍDEO (eventos — base de key_drivers/factores de la proyección):
${JSON.stringify(input.videoObservations ?? "no_data", null, 2)}

Genera el reporte Proyección 3 años en JSON estricto, usando los valores de la curva proyectada.
REGLAS docx #14: la curva ya es determinista — NO la infles. Si el HISTÓRICO tiene ≥2 puntos, narra la tendencia REAL (subió/bajó de X a Y); si está vacío, di "primer análisis — sin tendencia". Los key_drivers/factores deben citar un evento observado concreto de la OBSERVACIÓN DIRECTA (p. ej. pases progresivos, recuperaciones); si no hay observaciones, márcalos como "sin observación de vídeo" en vez de genéricos. DUELOS: VITAS no cuenta duelos (no hay un criterio validado de qué es un duelo ni de quién lo gana): NUNCA cites duelos ganados/perdidos ni un % de duelos como factor, aunque aparezcan en datos antiguos.`;

      const locale = normalizeLocale(input.locale);
      // C1 multi-categoría: override explícito > edad cronológica > default youth
      const category = resolveCategory({
        age: input.playerContext?.chronologicalAge,
        category: (input as { category?: unknown }).category,
      });
      const narrative = await callHaiku(buildSystemPrompt(locale, category), userMessage, apiKey);

      const result = {
        playerId: input.playerId,
        videoId: input.videoId,
        promptVersion: PROMPT_VERSION,
        model: MODELS.fast,
        deterministicCurve: { current: inputVsi.vsi, ...curve },
        narrative,
        generatedAt: new Date().toISOString(),
      };

      await setCached(cacheKey, result, 86400 * 7);
      return successResponse(result);
    } catch (err) {
      return errorResponse({
        code: "projection_failed",
        message: err instanceof Error ? err.message : "Unknown",
        status: 500,
      });
    }
  }
);
