/**
 * VITAS · DNA Profile (NUEVO · LLM Haiku)
 * POST /api/agents/dna-profile
 *
 * FUSIÓN de _tactical-label.ts + _role-profile.ts en un único agente.
 *
 * Genera el "ADN Futbolístico" del jugador:
 *   - Estilo de juego (técnico, físico, mixto, creativo, defensivo)
 *   - Rol natural sugerido vs rol actual
 *   - Comportamiento bajo presión
 *   - Lectura de juego
 *   - 3-5 etiquetas tácticas (proxy de estilo)
 *
 * Inputs combinados de los 2 antiguos agentes:
 *   - subscores VSI (técnica, físico, mental, táctica)
 *   - métricas biomecánicas
 *   - posición actual del jugador
 *
 * Cost: ~€0,002 (Haiku con prompt caching)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hashInput, getCached, setCached } from "../_lib/agentCache";
import { MODELS } from "../_lib/models";
import { normalizeLocale, languageDirective, type ReportLocale } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective, type PlayerCategory } from "../../src/lib/shared/category";

export const config = { runtime: "edge" };

const dnaSchema = z.object({
  playerId: z.string(),
  videoId: z.string().optional(),
  analysisId: z.string().optional(),
  vsi: z.record(z.unknown()).nullable().optional(),
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

const PROMPT_VERSION = "dna-profile-v1.3.0"; // v1.3 = sin duelos (P1 bloque 6); v1.2 = estilo/rol desde observaciones + gate pressure/game_reading (docx #14 P2)

function buildSystemPrompt(locale: ReportLocale, category: PlayerCategory): string {
  const catDirective = categoryDirective(category, locale);
  return `Eres el motor de ADN Futbolístico de VITAS.

Tu misión: producir el "ADN" del jugador combinando análisis de estilo (anteriormente _tactical-label) con análisis de rol natural (anteriormente _role-profile).

REGLAS:
- Estilo se deriva del balance de subscores:
  * Físico>Técnico → estilo "físico"
  * Técnico>Físico → estilo "técnico"
  * Equilibrado → estilo "mixto"
  * Mental alto + Táctica alta → "creativo"
  * Táctica alta + Físico alto + Técnica baja → "defensivo"
- Rol natural se sugiere comparando posición actual con perfil de subscores
- 3-5 etiquetas tácticas (ej. "box-to-box", "carrilero ofensivo", "destructor", "mediapunta llegador")
- Si rol natural ≠ posición actual, indícalo como sugerencia, NO como verdad absoluta

POLIVALENCIA · si recibes player.secondaryPositions[] o videoContext.playedPosition:
- player.position: posición principal declarada
- player.secondaryPositions[]: posiciones secundarias declaradas (jugador polivalente)
- videoContext.playedPosition: posición jugada en este video específico
- Si playedPosition existe, evalúa el ADN desde la perspectiva de esa posición
- Las sugerencias de rol natural NUNCA deben coincidir con una posición ya declarada (sería redundante)
- Si detectas potencial en una posición no declarada → mencionarlo como descubrimiento

ESTRUCTURA OBLIGATORIA (JSON):
{
  "title": "string",
  "primary_style": "técnico|físico|mixto|creativo|defensivo",
  "style_summary": "string max 220 chars",
  "natural_role": "string · ej. 'Mediocentro box-to-box'",
  "current_role": "string · de input",
  "role_alignment": "aligned|adjacent|misaligned",
  "tactical_labels": ["string"],
  "pressure_behavior": "string max 180 chars · cómo se comporta bajo presión",
  "game_reading": "string max 180 chars · capacidad de lectura del juego",
  "confidence_score": "number 0-100 · confianza real en este análisis según los datos disponibles",
  "data_completeness": "number 0-100 · % de dimensiones evaluadas con datos reales, no inferidos",
  "not_evaluated": ["string · aspectos que no se pudieron evaluar por falta de datos"]
}

REGLAS ABSOLUTAS DE DATOS:
1. Si no tienes un dato concreto, di "No disponible" o "Sin datos suficientes". NUNCA inventes valores.
2. NUNCA uses "aproximadamente", "más o menos", "alrededor de", "cercano a" para fabricar datos.
3. NUNCA compares con jugadores famosos ("el próximo Messi", "recuerda a Iniesta").
4. Si faltan >30% de las dimensiones de evaluación, penaliza el score explícitamente y menciona: "Evaluación parcial — datos insuficientes en: [dimensiones faltantes]".
5. Separa siempre observación directa (visto en video) de inferencia (estimado por modelo).
6. NUNCA menciones decisiones contractuales, económicas o de transferencias — no es nuestro dominio.
7. Banderas rojas (lesiones recurrentes, edad fuera de target, datos contradictorios) → mencionarlas SIEMPRE.

CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el análisis según los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.

EVIDENCIA DEL VÍDEO (obligatorio · el ESTILO y el ROL deben salir de lo OBSERVADO, no de subscores null):
- Usa "OBSERVACIÓN DIRECTA DEL VÍDEO": gemini.eventosContados (pases progresivos, regates con/sin ventaja, recuperaciones, robos, anticipaciones, escaneos, disparos…; VITAS no cuenta duelos: no los cites aunque aparezcan en datos antiguos), gemini.dimensiones{observaciones}, o eventSummary; y ESCANEO. PROCEDENCIA: gemini.* son observaciones ESTIMADAS POR IA (no medidas); eventSummary/scanning vienen del tracking.
- primary_style: derívalo de los EVENTOS observados (muchos pases progresivos + escaneos → técnico/creativo; muchas recuperaciones + robos + anticipaciones → defensivo/físico). El balance de subscores VSI es solo respaldo y SOLO si son reales (no null). Si no hay eventos ni subscores reales → primary_style: "no determinable con este vídeo" + añádelo a not_evaluated.
- tactical_labels y natural_role: cada etiqueta/rol debe apoyarse en un evento observado concreto; sin base, no la incluyas.
- pressure_behavior y game_reading: SOLO si hay una observación que lo respalde (pérdidas bajo presión, escaneos previos a recibir, decisiones en último tercio…). Sin señal → "No observado en este vídeo" + not_evaluated. PROHIBIDO describir comportamiento bajo presión o lectura de juego sin evidencia (era el hueco de fabricación).
- IDENTIDAD (identidad.md): si physicalMetrics.identityReliable===false, no atribuyas los eventos al jugador por nombre. Un passCompletionPct 0 con 0 pases = "sin datos de pase", no debilidad.

NO incluyas markdown ni texto fuera del JSON.

${languageDirective(locale)}${catDirective ? `\n\n${catDirective}` : ""}`;
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
  { schema: dnaSchema, requireAuth: true, allowServiceToken: true, maxRequests: 100 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorResponse({ code: "no_api_key", message: "missing", status: 500 });
    }

    const input = body as z.infer<typeof dnaSchema>;
    const cacheKey = await hashInput({ ...input, promptVersion: PROMPT_VERSION });
    const cached = await getCached(cacheKey);
    if (cached) return successResponse({ ...cached, fromCache: true });

    try {
      const userMessage = `JUGADOR:
${JSON.stringify(input.playerContext, null, 2)}

CONTEXTO DEL VÍDEO (fecha + posición jugada):
${JSON.stringify(input.videoContext ?? "no_data", null, 2)}

OBSERVACIÓN DIRECTA DEL VÍDEO (eventos contados/observados — base del ESTILO y del ROL):
${JSON.stringify(input.videoObservations ?? "no_data", null, 2)}

ESCANEO (scan-rate del jugador enfocado, si hay identidad fiable):
${JSON.stringify(input.scanning ?? "no_data", null, 2)}

VSI Y SUBSCORES (ojo: técnica/mental/táctica suelen venir null/estimados en vídeo — no bases el estilo solo en esto):
${JSON.stringify(input.vsi, null, 2)}

BIOMECÁNICA (agregados de pose; NO son las observaciones de arriba):
${JSON.stringify(input.biomechanics ?? "no_data", null, 2)}

Genera el ADN Futbolístico en JSON estricto.`;

      const locale = normalizeLocale((input as { locale?: unknown }).locale);
      const category = resolveCategory({
        age: input.playerContext.chronologicalAge,
        category: (input as { category?: unknown }).category,
      });
      const dna = await callHaiku(buildSystemPrompt(locale, category), userMessage, apiKey);

      const result = {
        playerId: input.playerId,
        videoId: input.videoId,
        promptVersion: PROMPT_VERSION,
        model: MODELS.fast,
        dna,
        generatedAt: new Date().toISOString(),
      };

      await setCached(cacheKey, result, 86400 * 7);
      return successResponse(result);
    } catch (err) {
      return errorResponse({
        code: "dna_failed",
        message: err instanceof Error ? err.message : "Unknown",
        status: 500,
      });
    }
  }
);
