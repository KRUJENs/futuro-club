/**
 * VITAS · Burnout Report Agent (Sprint 22)
 * POST /api/agents/burnout-report
 *
 * Claude Haiku agent that generates a narrative burnout/dropout risk report
 * in the requested `locale` (any registry language; default "es" via
 * languageDirective). Input: dropout risk + engagement + overtraining +
 * motivation + attendance + questionnaires.
 *
 * Output: headline, summary, primaryConcern, positiveSignals,
 *         interventionPlan, loadAdjustment, followUpDate, escalationNeeded.
 *
 * Pattern: identical to _behavioral-report.ts / _fatigue-report.ts
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse } from "../_lib/apiResponse";
import { MODELS } from "../_lib/models";
import { resolveCategory, categoryDirective } from "../../src/lib/shared/category";
import { normalizeLocale, languageDirective, localeSchema, type ReportLocale } from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const burnoutReportSchema = z.object({
  playerId: z.string(),
  playerName: z.string().optional(),
  playerAge: z.number(),
  // Dropout risk
  riskScore: z.number(),
  riskLevel: z.enum(["low", "moderate", "high", "critical"]),
  primaryFactor: z.string(),
  factors: z.record(z.object({
    score: z.number(),
    weight: z.number(),
  }).nullable()).optional(),
  // Engagement
  engagement: z.object({
    current: z.number(),
    historical: z.number(),
    trend: z.string(),
    consecutiveDeclines: z.number(),
  }).nullable().optional(), // null = sin implicación real registrada (P1 bloque 4)
  // Overtraining. P1 bloque 4: risk/riskLevel null = sin calcular (sin índice de
  // fatiga real o maduración no registrada, ver gate_reason); recomendación null =
  // nada la calcula. Antes el esquema exigía números y el cliente rellenaba 0.
  overtraining: z.object({
    risk: z.number().nullable(),
    riskLevel: z.string().nullable(),
    currentLoadAU: z.number().nullable(),
    recommendedLoadAU: z.number().nullable(),
    adjustmentPct: z.number().nullable(),
    gate_reason: z.string().nullable().optional(),
    gate_code: z.string().nullable().optional(),
  }).optional(),
  // Motivation
  motivation: z.object({
    type: z.string(),
    dropoutRisk: z.number(),
    confidence: z.number(),
  }).optional(),
  // Attendance
  attendance: z.object({
    rate: z.number().nullable(), // null = sin sesiones registradas (no 100%)
    consecutiveAbsences: z.number(),
    recentTrend: z.string(),
  }).optional(),
  // Questionnaires
  questionnaireSummary: z.string().optional(),
  // Intervention
  interventionActions: z.array(z.object({
    audience: z.string(),
    action: z.string(),
    priority: z.string(),
  })).optional(),
  // Idioma de redacción (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
});

const PROMPT_VERSION = "v1.1.0"; // P1 bloque 4: sobreentrenamiento sin calcular ≠ 0

/**
 * Líneas del prompt sobre sobreentrenamiento. Un dato ausente se dice tal cual
 * («no calculado» + motivo), nunca como 0: el modelo no debe inferir «riesgo bajo».
 */
function overtrainingLines(ot: NonNullable<z.infer<typeof burnoutReportSchema>["overtraining"]>): string {
  const lines: string[] = [];
  lines.push(
    ot.risk !== null && ot.riskLevel !== null
      ? `- Riesgo: ${ot.risk}/100 (${ot.riskLevel})`
      : `- Riesgo: NO CALCULADO (${ot.gate_reason ?? "sin datos suficientes"}). No lo estimes ni lo describas como bajo.`,
  );
  lines.push(ot.currentLoadAU !== null ? `- Carga registrada última sesión: ${ot.currentLoadAU} UA` : "- Carga registrada: sin datos");
  if (ot.recommendedLoadAU !== null && ot.adjustmentPct !== null) {
    lines.push(`- Carga recomendada: ${ot.recommendedLoadAU} UA (ajuste ${ot.adjustmentPct}%)`);
  } else {
    lines.push("- Carga recomendada: no calculada (no propongas cifras de carga)");
  }
  return lines.join("\n");
}

function buildPrompt(data: z.infer<typeof burnoutReportSchema>, locale: ReportLocale): string {
  const name = data.playerName ?? "Jugador";
  const age = data.playerAge;
  const eng = data.engagement;
  const ot = data.overtraining;
  const mot = data.motivation;
  const att = data.attendance;
  // C1 multi-categoría · override explícito > edad cronológica > default youth
  const category = resolveCategory({ age: age, category: (data as { category?: unknown }).category });

  return `Eres un psicólogo deportivo y especialista en ${category === "senior" ? "bienestar del deportista" : "bienestar juvenil"} en fútbol. Generas reportes de riesgo de abandono usando lenguaje profesional pero empático. Tu objetivo es ayudar al entrenador a retener al jugador con intervenciones prácticas.

## DATOS DEL JUGADOR
- Nombre: ${name}
- Edad: ${age} años

## RIESGO DE ABANDONO
- Score: ${data.riskScore}/100
- Nivel: ${data.riskLevel}
- Factor principal: ${data.primaryFactor}

## FACTORES DESGLOSADOS
${data.factors ? Object.entries(data.factors).map(([k, v]) => v ? `- ${k}: ${v.score}/100 (peso: ${(v.weight * 100).toFixed(0)}%)` : `- ${k}: sin datos`).join("\n") : "No disponibles"}

## ENGAGEMENT
${eng ? `- Actual: ${eng.current}/100 | Histórico: ${eng.historical}/100
- Tendencia: ${eng.trend}
- Declives consecutivos: ${eng.consecutiveDeclines}` : "No disponible"}

## SOBREENTRENAMIENTO
${ot ? overtrainingLines(ot) : "No disponible"}

## MOTIVACIÓN
${mot ? `- Tipo: ${mot.type}
- Riesgo de dropout inherente: ${mot.dropoutRisk}/100
- Confianza clasificación: ${(mot.confidence * 100).toFixed(0)}%` : "No disponible"}

## ASISTENCIA
${att ? `- Tasa: ${att.rate === null ? "sin datos (sin sesiones registradas)" : att.rate + "%"}
- Ausencias consecutivas: ${att.consecutiveAbsences}
- Tendencia reciente: ${att.recentTrend}` : "No disponible"}

## CUESTIONARIOS
${data.questionnaireSummary ?? "No disponibles"}

## ACCIONES DE INTERVENCIÓN PROPUESTAS
${data.interventionActions?.map(a => `- [${a.audience}] ${a.action} (${a.priority})`).join("\n") ?? "No disponibles"}

## INSTRUCCIONES
Genera un reporte de riesgo de abandono con las siguientes secciones. Sé empático, concreto y orientado a la acción. Prioriza la retención del jugador.

### Formato JSON:
{
  "headline": string (1 frase que resume la situación del jugador — alarmante si es crítico, esperanzadora si es bajo),
  "summary": string (párrafo de 3-5 oraciones describiendo la situación global),
  "primaryConcern": string (la preocupación principal y por qué importa),
  "positiveSignals": string[] (max 3, señales positivas que indican que el jugador puede recuperarse),
  "interventionPlan": string (párrafo con plan de acción priorizado para las próximas 2 semanas),
  "loadAdjustment": string (recomendación específica de ajuste de carga si aplica, sino "No aplica"),
  "followUpDate": string (cuándo revisar la situación),
  "escalationNeeded": boolean (si se necesita involucrar a dirección/psicólogo externo),
  "confidence_score": number (0-100 · tu confianza real en este análisis según los datos realmente disponibles),
  "data_completeness": number (0-100 · % de dimensiones evaluadas con datos reales, no inferidos),
  "not_evaluated": string[] (aspectos que NO se pudieron evaluar por falta de datos; array vacío si todo cubierto)
}

CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el análisis según los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.${category === "senior" ? "\n\n" : ""}${categoryDirective(category, locale)}

${languageDirective(locale)}
`;
}

export default withHandler(
  { schema: burnoutReportSchema, requireAuth: true, maxRequests: 50, allowServiceToken: true, requiredPlan: "pro,club" },
  async ({ body }) => {
    const data = body as z.infer<typeof burnoutReportSchema>;

    if (!ANTHROPIC_API_KEY) {
      return successResponse({
        report: generateMockReport(data),
        promptVersion: PROMPT_VERSION,
        model: "mock",
        source: "fallback",
      });
    }

    try {
      const locale = normalizeLocale(data.locale);
      const prompt = buildPrompt(data, locale);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELS.fast,
          max_tokens: 2000,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.error("[burnout-report] Anthropic error:", response.status, errText.slice(0, 200));
        return successResponse({
          report: generateMockReport(data),
          promptVersion: PROMPT_VERSION,
          model: "mock",
          source: "fallback_api_error",
        });
      }

      const result = await response.json() as {
        content: Array<{ type: string; text: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };

      const text = result.content?.[0]?.text ?? "";
      let report: Record<string, unknown>;

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        report = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: text };
      } catch {
        report = { raw: text };
      }

      return successResponse({
        report,
        promptVersion: PROMPT_VERSION,
        model: MODELS.fast,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      });
    } catch (err) {
      console.error("[burnout-report] Error:", err);
      return successResponse({
        report: generateMockReport(data),
        promptVersion: PROMPT_VERSION,
        model: "mock",
        source: "fallback_exception",
      });
    }
  },
);

function generateMockReport(data: z.infer<typeof burnoutReportSchema>): Record<string, unknown> {
  const name = data.playerName ?? "Jugador";
  const isCritical = data.riskLevel === "critical" || data.riskLevel === "high";

  return {
    headline: isCritical
      ? `${name}: Riesgo significativo de abandono — intervención prioritaria necesaria`
      : `${name}: Bienestar dentro de parámetros normales con áreas de atención`,
    summary: `${name} (${data.playerAge} años) presenta un riesgo de abandono de ${data.riskScore}/100 (nivel: ${data.riskLevel}). El factor principal es "${data.primaryFactor}". ${isCritical ? "Se recomienda intervención inmediata con el jugador y su familia." : "La situación es manejable con seguimiento regular."} Los indicadores de engagement ${data.engagement ? (data.engagement.trend === "declining" ? "muestran una tendencia descendente que requiere atención" : "se mantienen estables") : "no están disponibles para análisis completo"}.`,
    primaryConcern: `El factor "${data.primaryFactor}" es la principal señal de alerta. ${data.riskScore > 50 ? "Si no se aborda en las próximas 2 semanas, el riesgo de abandono podría aumentar significativamente." : "Aunque no es urgente, conviene monitorizarlo en las próximas sesiones."}`,
    positiveSignals: [
      "El jugador sigue asistiendo a los entrenamientos, lo que indica un vínculo con el equipo",
      "La edad del jugador permite intervenciones efectivas si se actúa a tiempo",
      "El entorno del club dispone de recursos para un seguimiento personalizado",
    ],
    interventionPlan: `Plan de acción para las próximas 2 semanas: 1) Conversación individual con el jugador para entender su perspectiva. 2) Contacto con la familia para alinear expectativas. 3) Ajuste de la carga de entrenamiento según las recomendaciones del detector de sobreentrenamiento. 4) Revisión del rol del jugador en los ejercicios para maximizar su participación y disfrute.`,
    loadAdjustment:
      data.overtraining &&
      data.overtraining.currentLoadAU !== null &&
      data.overtraining.recommendedLoadAU !== null &&
      data.overtraining.adjustmentPct !== null
        ? `Reducir la carga de ${data.overtraining.currentLoadAU} AU a ${data.overtraining.recommendedLoadAU} AU (ajuste del ${data.overtraining.adjustmentPct}%). Incluir una sesión de recuperación activa esta semana.`
        : "No aplica — no hay un ajuste de carga calculado",
    followUpDate: data.riskLevel === "critical" ? "En 3 días" : data.riskLevel === "high" ? "En 1 semana" : "En 2 semanas",
    escalationNeeded: data.riskLevel === "critical",
  };
}
