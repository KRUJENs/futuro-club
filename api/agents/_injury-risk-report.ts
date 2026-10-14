/**
 * VITAS · Injury Risk Report Agent (Sprint 10)
 * POST /api/agents/injury-risk-report
 *
 * 8th report agent in the pipeline. Generates a narrative injury risk
 * assessment with PHV-aware guidance, workload recommendations,
 * and prevention protocols in Spanish.
 *
 * Model: Claude Haiku (fast, cost-effective)
 * Cost: ~$0.002/call
 * Gated: Plan >= Pro (checked by orchestrator)
 *
 * P1 bloque 4b: sin riesgo de lesión CALCULADO por el modelo determinista
 * (composite null) el informe es determinista y NO se llama al modelo (su
 * «nivelRiesgo» y sus recomendaciones de carga serían un riesgo inventado sobre un
 * menor). Con riesgo calculado, el nivel lo fija el modelo determinista (la
 * categoría), no el LLM. Sin edad por defecto, sin «ACWR > 1.5» de adulto ni una
 * ventana PHV propia: se usan la zona y el nivel del Escudo que trae el modelo.
 */

import { z } from "zod";
import { MODELS } from "../_lib/models";
import { withHandler } from "../_lib/withHandler";
import { successResponse } from "../_lib/apiResponse";
import { normalizeLocale, languageDirective, localeSchema } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective } from "../../src/lib/shared/category";
import { injuryRiskValue, type InjuryRiskReport } from "../../src/lib/injury/injuryRiskTypes";

export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const injuryReportSchema = z.object({
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
  // Injury-specific context (from injury-risk-calculator)
  injuryRisk: z.record(z.unknown()).nullable().optional(),
  teamAnalysis: z.unknown().nullable().optional(),
  analysisMode: z.string().optional(),
  // FASE 5 · idioma del reporte (default "es")
  locale: localeSchema.optional(),
  // C1 multi-categoría · evita que Zod recorte la categoría del sharedContext
  category: z.enum(["youth", "senior"]).optional(),
});

const PROMPT_VERSION = "v1.1.0"; // P1 bloque 4b

/** Categoría del modelo determinista → valor de «nivelRiesgo» del informe. */
const NIVEL_POR_CATEGORIA: Record<string, string> = {
  low: "bajo",
  moderate: "moderado",
  high: "alto",
  critical: "critico",
};

/** El informe del calculador (v2) si viene con forma válida; si no, null. */
export function asInjuryRiskReport(v: unknown): InjuryRiskReport | null {
  const r = v as InjuryRiskReport | null | undefined;
  return r && typeof r === "object" && r.composite && typeof r.composite === "object" ? r : null;
}

function buildPrompt(data: z.infer<typeof injuryReportSchema>): string {
  // Sin edad conocida se dice; antes se suponían 12 años.
  const age = data.playerContext?.chronologicalAge ?? null;
  const position = data.playerContext?.position ?? "MID";
  const phvOffset = (data.phv as Record<string, unknown>)?.offset ?? (data.phv as Record<string, unknown>)?.maturity_offset ?? null;
  const phvCategory = (data.phv as Record<string, unknown>)?.category ?? (data.phv as Record<string, unknown>)?.phv_category ?? "unknown";
  const fatigue = data.fatigueReport ?? {};
  const injuryRisk = data.injuryRisk ?? {};
  const biomech = data.biomechanics ?? {};
  const locale = normalizeLocale(data.locale);
  // C1 multi-categoría · override explícito > edad cronológica > default youth
  const category = resolveCategory({ age: data.playerContext?.chronologicalAge, category: data.category });

  return `Eres un fisioterapeuta deportivo especializado en ${category === "senior" ? "futbol profesional" : "futbol juvenil"} y prevencion de lesiones.
Tu audiencia son entrenadores y preparadores fisicos ${category === "senior" ? "de clubes profesionales" : "de academias"}.

## CONTEXTO DEL JUGADOR
- Edad cronologica: ${age !== null ? `${age} anos` : "No disponible"}
- Posicion: ${position}${category === "senior" ? "" : `
- Offset PHV: ${phvOffset !== null ? `${phvOffset} anos (${phvCategory})` : "No disponible"}`}

## DATOS DE RIESGO DE LESION (modelo deterministico VITAS)
${JSON.stringify(injuryRisk, null, 2)}

## DATOS DE FATIGA DE LA SESION
${JSON.stringify(fatigue, null, 2)}

## DATOS BIOMECANICOS
${JSON.stringify(biomech, null, 2)}

## INSTRUCCIONES
Genera un reporte de riesgo de lesion en formato JSON con esta estructura exacta:

{
  "evaluacionGeneral": "Parrafo de 3-4 lineas evaluando el estado fisico general del jugador",
  "nivelRiesgo": "bajo | moderado | alto | critico",
  "factoresRiesgo": [
    {
      "factor": "nombre del factor (ej: ACWR elevado, ${category === "senior" ? "Historial de carga" : "Ventana PHV"}, Asimetria bilateral)",
      "severidad": "baja | media | alta",
      "descripcion": "Explicacion en 2 lineas maxima comprensible para un entrenador"
    }
  ],
  "recomendacionesCarga": [
    "Recomendacion especifica de carga 1",
    "Recomendacion especifica de carga 2",
    "Recomendacion especifica de carga 3"
  ],
  "alertaPHV": "${category === "senior" ? "Jugador senior: no aplica, devuelve null" : "Solo si el jugador esta en ventana de crecimiento. Explicar el riesgo especifico de lesion osea/apofisitis. Si no aplica: null"}",
  "protocoloPrevencion": [
    "Ejercicio o protocolo preventivo 1",
    "Ejercicio o protocolo preventivo 2",
    "Ejercicio o protocolo preventivo 3"
  ],
  "seguimiento": "Cuando reevaluar y que monitorizar (1-2 lineas)",
  "confidence_score": "number 0-100 · confianza real en este analisis segun los datos disponibles",
  "data_completeness": "number 0-100 · % de dimensiones evaluadas con datos reales, no inferidos",
  "not_evaluated": ["string · aspectos que no se pudieron evaluar por falta de datos"]
}

REGLAS:
- Lenguaje claro para entrenadores, NO jerga medica excesiva
- El nivel de riesgo ("nivelRiesgo") ya lo ha calculado el modelo determinista: usa su categoria, no la recalcules
- Si la zona de carga del modelo es "danger" o "caution", enfatizar la necesidad de reducir carga (no reclasifiques el ratio con cortes propios)
${category === "senior" ? "- Jugador senior: NO menciones PHV ni maduracion biologica; alertaPHV debe ser null" : "- Alerta PHV SOLO si el modelo trae growthShieldLevel peak o high (riesgo oseo: Osgood-Schlatter, Sever); si es null o menor, alertaPHV = null"}
- Si la asimetria bilateral >15%, recomendar trabajo correctivo especifico
- Maximo 5 factores de riesgo
- Maximo 5 recomendaciones
- CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el analisis segun los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.
- Responde SOLO con JSON valido, sin texto adicional

${languageDirective(locale)}${category === "senior" ? "\n\n" : ""}${categoryDirective(category, locale)}`;
}

/**
 * Fallback honesto: cuando la IA no está disponible o falla, NO inventamos un
 * nivel de riesgo. Devolvemos un reporte BLOQUEADO (nivelRiesgo "desconocido",
 * sin factores) marcado `fallback:true` + `fallbackReason`. Igual que la regla de
 * fallback del proyecto: la app no se rompe, pero tampoco fabrica una evaluación
 * de riesgo sobre un menor (invariante #2: ante dato ausente se bloquea).
 */
function fallbackReport(reason: string, seguimiento: string) {
  return successResponse({
    report: {
      evaluacionGeneral: "Reporte no disponible — no se pudo generar el análisis de riesgo",
      nivelRiesgo: "desconocido",
      factoresRiesgo: [],
      recomendacionesCarga: [],
      alertaPHV: null,
      protocoloPrevencion: [],
      seguimiento,
    },
    promptVersion: PROMPT_VERSION,
    fallback: true,
    fallbackReason: reason,
  });
}

export default withHandler(
  { schema: injuryReportSchema, requireAuth: true, allowServiceToken: true, requiredPlan: "pro,club", maxRequests: 50 },
  async ({ body }) => {
    const data = body as z.infer<typeof injuryReportSchema>;

    // Sin riesgo calculado por el modelo determinista: informe bloqueado, sin modelo.
    const model = asInjuryRiskReport(data.injuryRisk);
    const riskValue = injuryRiskValue(model);
    if (riskValue === null || !model?.category) {
      const reason = model?.composite?.gate_reason ?? "Riesgo de lesión no calculado: faltan datos del modelo.";
      const missing = (model?.factors ?? [])
        .filter((x) => x.applicable && x.result?.value === null && x.result?.gate_reason)
        .map((x) => x.result.gate_reason as string);
      return successResponse({
        report: {
          evaluacionGeneral: `Riesgo de lesión no calculado. ${reason}`,
          nivelRiesgo: "desconocido", // mismo valor que el fallback: la vista lo pinta neutro y traducido
          factoresRiesgo: [],
          recomendacionesCarga: [],
          alertaPHV: null,
          protocoloPrevencion: [],
          seguimiento: "Registrar carga de entrenamiento y completar las medidas del jugador para activar el cálculo.",
          not_evaluated: [reason, ...missing],
        },
        promptVersion: PROMPT_VERSION,
        model: "gated",
        source: "injury_risk_not_computed",
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return fallbackReport(
        "no_api_key",
        "Configurar ANTHROPIC_API_KEY para generar reportes",
      );
    }

    const prompt = buildPrompt(data);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELS.fast,
          max_tokens: 1500,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[injury-risk-report] Anthropic ${res.status}:`, errText);
        return fallbackReport(
          "fallback_api_error",
          "El servicio de IA no respondió. Reintenta más tarde.",
        );
      }

      const json = await res.json();
      const text = (json.content?.[0] as { text?: string })?.text ?? "";

      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return fallbackReport(
          "fallback_parse_error",
          "La respuesta de IA no tuvo formato válido. Reintenta.",
        );
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      // El nivel es el del modelo determinista, aunque el LLM diga otro.
      const report = { ...parsed, nivelRiesgo: NIVEL_POR_CATEGORIA[model.category] ?? model.category };

      return successResponse({
        report,
        promptVersion: PROMPT_VERSION,
        model: MODELS.fast,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      });
    } catch (err) {
      console.error("[injury-risk-report] Error:", err);
      return fallbackReport(
        "fallback_exception",
        "Error al generar el reporte de riesgo. Reintenta.",
      );
    }
  },
);
