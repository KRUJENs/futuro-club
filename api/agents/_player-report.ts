/**
 * VITAS · Player Report (REFACTOR de _scout-insight · LLM Sonnet)
 * POST /api/agents/player-report
 *
 * Reporte ancla comercial. Resumen ejecutivo del jugador para padres y coaches.
 *
 * Combina:
 *   - VSI Score + tier
 *   - PHV (edad biológica vs cronológica)
 *   - Métricas biomecánicas más relevantes
 *   - Top fortalezas y áreas de mejora
 *
 * Cost: ~€0,045 (Sonnet con prompt caching)
 *
 * Reemplaza _scout-insight.ts (que era el embrión de este reporte).
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

// Schema flexible · acepta lo que el orchestrator manda (incluye partial/null)
const playerReportSchema = z.object({
  playerId: z.string(),
  videoId: z.string().optional(),
  analysisId: z.string().optional(),
  vsi: z.record(z.unknown()).nullable().optional(),
  phv: z.record(z.unknown()).nullable().optional(),
  biomechanics: z.record(z.unknown()).nullable().optional(),
  similarity: z.record(z.unknown()).nullable().optional(),
  scanning: z.record(z.unknown()).nullable().optional(),
  videoObservations: z.record(z.unknown()).nullable().optional(),
  videoContext: z.record(z.unknown()).nullable().optional(),
  vsiHistory: z.array(z.record(z.unknown())).nullable().optional(),
  playerContext: z.object({
    chronologicalAge: z.number().optional(),
    position: z.string().optional(),
    name: z.string().optional(),
  }).passthrough(),
}).passthrough();

const PROMPT_VERSION = "player-report-v2.4.0"; // v2.4.0 = sin duelos (P1 bloque 6: sin criterio validado; ejemplo «ganó 7 de 10 duelos» fuera); v2.3.0 = advertencia de identidad no verificada por dorsal (Gemini unico_jugador/confianza media); v2.2.1 = procedencia (gemini=IA), gate de identidad en eventSummary, trampa passCompletionPct 0 (revisión #177)

function buildSystemPrompt(locale: ReportLocale, category: PlayerCategory): string {
  return `Eres el motor del Player Report de VITAS Football Intelligence.

Tu misión: producir el reporte ancla del producto. Es el primer reporte que ven ${category === "senior" ? "el cuerpo técnico y la dirección deportiva" : "padres y coaches"}. Debe ser comprensible, motivador, honesto y accionable.

DESTINATARIO PRIMARIO: ${category === "senior" ? "cuerpo técnico. Secundario: dirección deportiva" : "padre/madre del jugador. Secundario: coach"}.

ESTILO:
- Lenguaje claro, ${category === "senior" ? "con terminología de rendimiento (adaptado a cuerpo técnico)" : "sin jerga excesiva (adaptado a familia)"}
- Cita siempre el VSI Score y el tier explícitamente
- ${category === "senior" ? "NO menciones PHV ni maduración biológica: valora estado de forma y rendimiento actual" : `Si hay PHV, explícalo en una frase ("tu hijo está pre-estirón / en estirón / post-estirón")`}
- 2-3 fortalezas concretas con dato
- 2-3 áreas de mejora claras (sin endulzar)
- Una recomendación concreta para próximas 4 semanas
- Tono: profesional pero cercano, NUNCA alarmista
- TODO informe DEBE referenciar el video fuente: incluye la fecha del análisis y la posición jugada en ese video. Sin video no hay informe.

POLIVALENCIA · si videoContext.playedPosition existe:
- El executive_summary debe mencionar explícitamente la posición jugada: "Análisis del video del DD/MM jugando de [posición]"
- Las fortalezas y áreas de mejora se evalúan EN EL CONTEXTO de esa posición específica
- Si player.secondaryPositions[] existe, el next_4_weeks_focus puede sugerir afianzar polivalencia

ESTRUCTURA OBLIGATORIA (JSON):
{
  "title": "string · ej. 'Análisis VITAS · [Nombre Jugador]'",
  "vsi_score": number|null (null si VSI bloqueado — ver GATE DEL DESGLOSE),
  "tier": "elite|pro|talent|develop",
  "tier_label": "string",
  "executive_summary": "string max 280 chars · resumen 1 párrafo para padres",
  "phv_summary": "string max 200 chars · explicación PHV simple",
  "strengths": [
    { "title": "string", "evidence": "string max 120 chars con número o métrica" }
  ],
  "areas_to_improve": [
    { "title": "string", "evidence": "string max 120 chars", "priority": "high|medium|low" }
  ],
  "comparable_pro": "string max 80 chars · solo si similarity disponible",
  "next_4_weeks_focus": "string max 220 chars · qué priorizar",
  "honesty_note": "string max 180 chars · matiz realista sobre la edad y desarrollo",
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

EVIDENCIA DEL VÍDEO (obligatorio · esto es lo que hace el informe ÚTIL en vez de genérico):
- PROCEDENCIA (obligatorio distinguir): gemini.* son observaciones ESTIMADAS POR IA (un modelo de visión mirando el clip) → cítalas como "observado por IA", NO como "medido". eventSummary/physicalMetrics vienen del tracking → son medidas SOLO con los gates de abajo.
- IDENTIDAD (identidad.md): eventSummary y sus eventos son de la pista del jugador enfocado. Solo se envían si la identidad es fiable; aun así, si physicalMetrics.identityReliable === false, NO atribuyas esos eventos al jugador por nombre (pudieron acumularse tras un cambio de identidad de la pista).
- IDENTIDAD EN EL VÍDEO (Gemini): si gemini.identificacion (o biomechanics.identity) indica que el jugador NO se verificó por dorsal y equipación (estado "unico_jugador", o confianza distinta de "alta"), escribe esa advertencia en honesty_note ("Identidad no verificada por dorsal: [motivo]") y añádela a not_evaluated. Nunca digas que se le identificó por la cara o por rasgos físicos.
- passCompletionPct 0 con passesAttempted 0 significa "no se detectaron pases" (posible fallo de cobertura), NO "falla todos los pases" → no lo cites como debilidad; escribe "sin datos de pase en este vídeo".
- La sección "OBSERVACIÓN DIRECTA DEL VÍDEO" trae lo contado/observado en ESTE vídeo:
  · gemini.eventosContados (pases completados/fallados/progresivos, regates con/sin ventaja, recuperaciones, robos, anticipaciones, pérdidas, escaneos, disparos al arco/fuera, centros…), gemini.dimensiones (score_estimado + observaciones por dimensión), gemini.momentosDestacados (timestamp+descripción), gemini.resumenGeneral;
  · o bien eventSummary (passCompletionPct, passesAttempted/Completed, recoveries, sprintBursts, shots, xgContributions, vaepApprox) y physicalMetrics.
- CADA fortaleza y CADA área de mejora DEBE citar un dato observado CONCRETO de esa sección (p. ej. "12/18 pases progresivos", "3 recuperaciones en presión alta", "escaneos: 24"). Prohibido rellenar con rasgos genéricos de la posición.
- DUELOS: VITAS no cuenta duelos (no hay un criterio validado de qué es un duelo ni de quién lo gana). NUNCA cites duelos ganados/perdidos ni un % de duelos, aunque aparezcan en datos antiguos; si hacen falta, añade "duelos" a not_evaluated.
- Si "OBSERVACIÓN DIRECTA DEL VÍDEO" es "no_data" o el dato concreto no está, escribe literalmente "No observado en este vídeo" — NUNCA un rasgo plausible inventado.
- physicalMetrics: usa maxSpeedMs/distanceCoveredM/sprintCount SOLO si están presentes (vienen gated: si calibrationReliable o identityReliable es false esos números NO están y NO se midieron con fiabilidad → no los infieras). scanCount solo si identityReliable.
- HISTORIAL VSI: si tiene ≥2 puntos, cita la tendencia REAL (subió/bajó de X a Y); si está vacío, di "primer análisis — sin tendencia". No inventes evolución.

SCORING RUBRIC (desglose obligatorio):
- Técnica (35%): pases, control, regate, tiro — basado en video features observados
- Físico (20%): velocidad, resistencia — basado en tracking data
- ${category === "senior" ? "Proyección (25%): proyección de rendimiento y estado de forma, tendencia de evolución" : "Proyección + PHV (25%): margen de mejora por edad madurativa (PHV Mirwald), tendencia de evolución"}
- Fit contextual (20%): encaje con posición, estilo de juego, necesidades del equipo

GATE DEL DESGLOSE (honestidad · obligatorio): si VSI llega bloqueado (vsi.blocked=true) o vsi_score es null, NO fabriques el número: pon vsi_score=null, explica el gate en el executive_summary ("VSI no calculable en este vídeo: [gate_reason]") y lístalo en not_evaluated. Para cada componente del desglose, usa un sub-score SOLO si hay dato observado que lo sustente; si no, márcalo "No disponible" — NUNCA copies los números del ejemplo. El desglose refleja SOLO las dimensiones con datos reales.
Cuando SÍ haya VSI y sub-scores reales, inclúyelo como suma ponderada con desglose visible: "Técnica: 72 | Físico: 65 | Proyección${category === "senior" ? "" : "+PHV"}: 85 | Fit: 70 → VSI: 74" (ejemplo de FORMATO, no de valores).

NO incluyas markdown ni texto fuera del JSON.

${languageDirective(locale)}${category === "senior" ? "\n\n" : ""}${categoryDirective(category, locale)}`;
}

async function callSonnet(systemPrompt: string, userMessage: string, apiKey: string) {
  const res = await fetchMessages({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      ...modelParams(MODELS.reasoning, 2500),
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(responseText(data) || "{}");
}

export default withHandler(
  { schema: playerReportSchema, requireAuth: true, allowServiceToken: true, maxRequests: 50 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorResponse({ code: "no_api_key", message: "missing", status: 500 });
    }

    const input = body as z.infer<typeof playerReportSchema>;
    const locale = normalizeLocale(input.locale);
    const category = resolveCategory({
      age: input.playerContext.chronologicalAge,
      category: (input as { category?: unknown }).category,
    });
    const cacheKey = await hashInput({ ...input, promptVersion: PROMPT_VERSION });
    const cached = await getCached(cacheKey);
    if (cached) return successResponse({ ...cached, fromCache: true });

    try {
      const userMessage = `DATOS DEL JUGADOR:
${JSON.stringify(input.playerContext, null, 2)}

CONTEXTO DEL VÍDEO (fecha del análisis + posición jugada en este vídeo):
${JSON.stringify(input.videoContext ?? "no_data", null, 2)}

OBSERVACIÓN DIRECTA DEL VÍDEO (lo que se contó/midió en ESTE vídeo — evidencia para citar):
${JSON.stringify(input.videoObservations ?? "no_data", null, 2)}

VSI:
${JSON.stringify(input.vsi, null, 2)}

HISTORIAL VSI (análisis anteriores · para tendencia; vacío = primer análisis):
${JSON.stringify(input.vsiHistory ?? [], null, 2)}

PHV (maduración biológica):
${JSON.stringify(input.phv ?? "no_data", null, 2)}

BIOMECÁNICA (agregados de pose; NO confundir con las observaciones de arriba):
${JSON.stringify(input.biomechanics ?? "no_data", null, 2)}

COMPARABLES PRO (top-1 si existe):
${JSON.stringify((input.similarity?.matches as unknown[] | undefined)?.[0] ?? "no_data", null, 2)}

Genera el Player Report en JSON estricto.`;

      const report = await callSonnet(buildSystemPrompt(locale, category), userMessage, apiKey);

      const result = {
        playerId: input.playerId,
        videoId: input.videoId,
        promptVersion: PROMPT_VERSION,
        model: MODELS.reasoning,
        report,
        generatedAt: new Date().toISOString(),
      };

      await setCached(cacheKey, result, 86400 * 7);
      return successResponse(result);
    } catch (err) {
      return errorResponse({
        code: "player_report_failed",
        message: err instanceof Error ? err.message : "Unknown",
        status: 500,
      });
    }
  }
);
