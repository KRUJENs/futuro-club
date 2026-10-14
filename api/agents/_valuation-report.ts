/**
 * VITAS · Valuation Report Agent (Sprint 12)
 * POST /api/agents/valuation-report
 *
 * Generates a narrative valuation assessment in Spanish.
 * Includes tier analysis, comparable professionals, key factors,
 * and development recommendations.
 *
 * Model: Claude Haiku (fast, cost-effective)
 * Cost: ~$0.002/call
 * Gated: Plan >= Club (checked by orchestrator)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { valuationOutputSchema, validateLLMReport } from "./_outputSchemas";
import { normalizeLocale, languageDirective, localeSchema } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective } from "../../src/lib/shared/category";

export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const valuationReportSchema = z.object({
  playerId: z.string(),
  videoId: z.string().optional(),
  analysisId: z.string().optional(),
  biomechanics: z.record(z.unknown()).optional(),
  phv: z.record(z.unknown()).nullable().optional(),
  vsi: z.unknown().nullable().optional(),
  similarity: z.unknown().nullable().optional(),
  playerContext: z.object({
    chronologicalAge: z.number().optional(),
    position: z.string().optional(),
    secondaryPositions: z.array(z.string()).optional(),
    foot: z.string().optional(),
  }).optional(),
  videoContext: z.record(z.unknown()).optional(),
  scanning: z.unknown().nullable().optional(),
  fatigueReport: z.record(z.unknown()).nullable().optional(),
  fatigueHistory: z.array(z.record(z.unknown())).optional(),
  injuryRisk: z.record(z.unknown()).nullable().optional(),
  // Valuation-specific data
  valuationModel: z.record(z.unknown()).nullable().optional(),
  teamAnalysis: z.unknown().nullable().optional(),
  analysisMode: z.string().optional(),
  // FASE 5 · idioma del reporte (evita que Zod lo recorte del sharedContext)
  locale: localeSchema.optional(),
  // C1 multi-categoría · evita que Zod recorte la categoría del sharedContext
  category: z.enum(["youth", "senior"]).optional(),
});

const PROMPT_VERSION = "v1.2.0"; // v1.2 = sin valoración calculada no se llama al modelo; sin edad por defecto (P1 bloque 4b)

/**
 * ¿El modelo determinista calculó la valoración? Sin puntuación (P1 bloque 4b: falta
 * el PHV o el riesgo de lesión) el informe NO se pide al modelo: su texto libre
 * («tier», «techo estimado») inventaría una valoración que el modelo no hizo.
 */
export function valuationComputed(model: unknown): boolean {
  const m = model as Record<string, unknown> | null | undefined;
  return !!m && typeof m.overallScore === "number" && Number.isFinite(m.overallScore);
}

function buildPrompt(data: z.infer<typeof valuationReportSchema>): string {
  // Sin edad conocida se dice; antes se suponían 12 años.
  const age = data.playerContext?.chronologicalAge ?? null;
  const position = data.playerContext?.position ?? "MID";
  const phvOffset = (data.phv as Record<string, unknown>)?.offset ?? (data.phv as Record<string, unknown>)?.maturity_offset ?? null;
  const valuation = data.valuationModel ?? {};
  const injuryRisk = data.injuryRisk ?? {};
  const vsi = data.vsi;
  const locale = normalizeLocale((data as { locale?: unknown }).locale);
  // C1 multi-categoría: override explícito > edad cronológica > default "youth"
  const category = resolveCategory({ age: data.playerContext?.chronologicalAge, category: data.category });
  const catDirective = categoryDirective(category, locale);

  // P4 (docx #14): los comparables salen SOLO del módulo de similitud (una sola
  // implementación, inv #7). Si P3 se abstuvo (sin eventos observados) o marcó baja
  // confianza, el reporte NO inventa comparables — replica la abstención de best-match.
  const similarity = data.similarity as Record<string, unknown> | null | undefined;
  const simAbstained = !similarity || similarity.abstained === true;
  const simTop5 = Array.isArray(similarity?.top5) ? (similarity!.top5 as unknown[]) : [];
  const simBest = (similarity?.bestMatch as unknown) ?? null;
  const simGate = (similarity?.gate_reason as string | undefined) ?? null;
  const simLowConf =
    similarity?.lowConfidence === true || similarity?.provenance === "derived_from_observed_events";
  const hasComparables = !simAbstained && (simTop5.length > 0 || !!simBest);
  const comparablesBlock = hasComparables
    ? `## COMPARABLES (única fuente permitida — módulo de similitud)
${JSON.stringify({ top5: simTop5, bestMatch: simBest }, null, 2)}
Usa EXCLUSIVAMENTE estos comparables provistos, con su score. NO inventes ni añadas ningún otro nombre de jugador; si alguno no aplica, exclúyelo.${simLowConf ? `
IMPORTANTE: estos comparables son DERIVADOS de eventos observados del vídeo (no medición validada de técnica/mental/táctica). Decláralo en cada "razon" y BAJA confidence_score.` : ""}`
    : `## COMPARABLES
El módulo de similitud NO aporta comparables validados para este jugador${simGate ? ` (motivo: ${simGate})` : ""}.
Por tanto "comparablesProfesionales" DEBE ser un array vacío []. Añade a "not_evaluated": "Comparables profesionales: sin comparable validado".`;

  return `Eres un director deportivo de ${category === "senior" ? "futbol profesional" : "academia de futbol juvenil"} con 20 anos de experiencia en deteccion de talento.
Tu audiencia son ${category === "senior" ? "cuerpo tecnico, scouts y direccion deportiva de clubes" : "directores tecnicos, scouts y directivos de academias"}.

## CONTEXTO DEL JUGADOR
- Edad cronologica: ${age !== null ? `${age} anos` : "No disponible"}
- Posicion principal: ${position}${category === "senior" ? "" : `
- Offset PHV: ${phvOffset !== null ? `${phvOffset} anos` : "No disponible"}`}
- VSI actual: ${JSON.stringify(vsi)}

## MODELO DE VALORACION (deterministico VITAS)
${JSON.stringify(valuation, null, 2)}

## RIESGO DE LESION
${JSON.stringify(injuryRisk, null, 2)}

${comparablesBlock}

## INSTRUCCIONES
Genera un reporte de valoracion predictiva en formato JSON con esta estructura exacta:

{
  "evaluacionGeneral": "Parrafo de 4-5 lineas evaluando el potencial del jugador de forma honesta y equilibrada",
  "tierAnalisis": "Explicacion de por que el jugador esta en este tier (2-3 lineas)",
  "comparablesProfesionales": [
    {
      "nombre": "Nombre del profesional comparable",
      "equipo": "Equipo actual o historico",
      "razon": "Por que se compara (1 linea)"
    }
  ],
  "factoresClave": [
    {
      "factor": "Nombre del factor",
      "impacto": "positivo | negativo | neutro",
      "explicacion": "1-2 lineas"
    }
  ],
  "proyeccion": {
    "cortoPlaz": "Expectativa a 1 ano (1-2 lineas)",
    "medioPlaz": "Expectativa a 3 anos (1-2 lineas)",
    "techoEstimado": "Nivel maximo estimado (1 linea)"
  },
  "recomendacionesDesarrollo": [
    "Recomendacion 1 para maximizar potencial",
    "Recomendacion 2",
    "Recomendacion 3"
  ],
  "riesgosValoracion": [
    "Riesgo 1 que podria limitar la valoracion",
    "Riesgo 2"
  ],
  "confidence_score": "number 0-100 · confianza real en este analisis segun los datos disponibles",
  "data_completeness": "number 0-100 · % de dimensiones evaluadas con datos reales, no inferidos",
  "not_evaluated": ["string · aspectos que no se pudieron evaluar por falta de datos"]
}

REGLAS:
- Se honesto y realista. No inflar expectativas. ${category === "senior" ? "Evalua el nivel real de rendimiento actual, sin inflar el techo del jugador" : "La mayoria de juveniles NO llegan a profesional"}
- Si el VSI es <60, ser cauteloso con las proyecciones
- ${category === "senior" ? "Considera la fase de carrera (edad vs pico de rendimiento de la posicion) al proyectar la valoracion" : "Si el jugador esta en ventana PHV, mencionar que la valoracion puede cambiar post-crecimiento"}
- comparablesProfesionales: usa SOLO los nombres del bloque COMPARABLES de arriba (máximo los que ahí aparezcan). Si ese bloque indica array vacío, comparablesProfesionales = [].
- PROHIBIDO inventar nombres de jugadores: los comparables salen ÚNICAMENTE del bloque COMPARABLES, nunca de tu conocimiento propio.
- PROHIBIDO emitir cifras en euros, valores de mercado o cantidades de traspaso en cualquier campo, bajo ninguna circunstancia.
- Si hay riesgo de lesion alto, reflejarlo como riesgo de valoracion
- CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el analisis segun los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad
- Responde SOLO con JSON valido, sin texto adicional

${languageDirective(locale)}${catDirective ? `\n\n${catDirective}` : ""}`;
}

export default withHandler(
  // FASE 3: valoración = feature Club (usa Sonnet, la más cara). requiredPlan
  // gatea las llamadas directas de usuario; el orchestrator (service token)
  // aplica el gate por su cuenta antes de invocarlo (no paga Sonnet para <Club).
  { schema: valuationReportSchema, requireAuth: true, allowServiceToken: true, requiredPlan: "club", maxRequests: 50 },
  async ({ body }) => {
    const data = body as z.infer<typeof valuationReportSchema>;

    // Fallback determinista: la app NUNCA rompe por fallo del LLM (regla CLAUDE.md).
    // `source` permite al consumidor distinguir el fallback de un reporte real.
    const fallbackReport = (source: string, detail: string) =>
      successResponse({
        report: {
          evaluacionGeneral: `Reporte no disponible — ${detail}`,
          tierAnalisis: "N/A",
          comparablesProfesionales: [],
          factoresClave: [],
          proyeccion: { cortoPlaz: "N/A", medioPlaz: "N/A", techoEstimado: "N/A" },
          recomendacionesDesarrollo: [],
          riesgosValoracion: [],
        },
        promptVersion: PROMPT_VERSION,
        fallback: true,
        source,
      });

    // Sin valoración calculada (falta PHV o riesgo de lesión): informe bloqueado,
    // determinista, sin llamar al modelo (P1 bloque 4b).
    if (!valuationComputed(data.valuationModel)) {
      const reason =
        ((data.valuationModel as Record<string, unknown> | null | undefined)?.gate_reason as string | undefined) ??
        "Valoración no calculada: faltan datos del modelo.";
      return successResponse({
        report: {
          evaluacionGeneral: `Valoración no disponible. ${reason}`,
          tierAnalisis: "No calculado",
          comparablesProfesionales: [],
          factoresClave: [],
          proyeccion: { cortoPlaz: "No calculado", medioPlaz: "No calculado", techoEstimado: "No calculado" },
          recomendacionesDesarrollo: [],
          riesgosValoracion: [],
          not_evaluated: [reason],
        },
        promptVersion: PROMPT_VERSION,
        model: "gated",
        source: "valuation_not_computed",
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return fallbackReport("fallback_no_key", "API key no configurada");
    }

    const prompt = buildPrompt(data);

    try {
      const res = await fetchMessages({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          ...modelParams(MODELS.reasoning, 2000),
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[valuation-report] Anthropic ${res.status}:`, errText);
        return fallbackReport("fallback_llm_error", `error del modelo (${res.status})`);
      }

      const json = await res.json();
      const text = responseText(json);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return fallbackReport("fallback_parse_error", "respuesta del modelo sin JSON");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // FASE 2: validar estructura (ver _outputSchemas.ts)
      const validation = validateLLMReport(valuationOutputSchema, parsed);
      if (!validation.ok) {
        console.error("[valuation-report] Schema inválido:", validation.issues);
        return fallbackReport("fallback_schema_error", "respuesta del modelo con estructura inválida");
      }
      const report = validation.report;

      return successResponse({
        report,
        promptVersion: PROMPT_VERSION,
        model: MODELS.reasoning,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      });
    } catch (err) {
      console.error("[valuation-report] Error:", err);
      return fallbackReport(
        "fallback_exception",
        err instanceof Error ? err.message : "error desconocido",
      );
    }
  },
);
