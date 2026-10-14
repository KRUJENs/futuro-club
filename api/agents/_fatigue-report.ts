/**
 * VITAS · Fatigue Report Agent (Sprint 7 — Pipeline Automático)
 * POST /api/agents/fatigue-report
 *
 * 7th report agent in the pipeline. Generates a narrative fatigue report
 * including: current fatigue level, injury risk assessment, workload
 * recommendations, PHV-specific guidance, and recovery protocols.
 *
 * Model: Claude Haiku (fast, cost-effective for structured narrative)
 *
 * P1 bloque 4 (decisión del owner): si la sesión de fatiga NO tiene la maduración
 * registrada (banda ausente, o "post_phv" sin offset = valor por defecto antiguo),
 * el informe NO clasifica: sin índice, severidad, zona ACWR ni riesgo de lesión
 * (sin semáforo). Ese informe se construye de forma DETERMINISTA, sin llamar al
 * modelo: la fila de la sesión trae severidad, zona y alertas calculadas con otros
 * umbrales, y un texto libre (resumen, recomendaciones) podría repetirlas aunque
 * se le pida lo contrario (revisión del PR #315). Se muestra la carga registrada.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS } from "../_lib/models";
import { normalizeLocale, languageDirective, localeSchema } from "../../src/lib/shared/locale";
import { resolveCategory, categoryDirective } from "../../src/lib/shared/category";
import { maturationKnown } from "../../src/lib/fatigue/phvFatigueAdjuster";
import { DEFAULT_FATIGUE_CONFIG } from "../../src/lib/fatigue/types";
import { fatigueIsReliable } from "../_lib/metricsProvenance";

export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const fatigueReportSchema = z.object({
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
  // Fatigue-specific data
  fatigueReport: z.record(z.unknown()).nullable().optional(),
  fatigueHistory: z.array(z.record(z.unknown())).optional(),
  // FASE 5 · idioma del reporte (default "es") — reportes bilingües ES/EN
  locale: localeSchema.optional(),
  // C1 multi-categoría · evita que Zod recorte la categoría del sharedContext
  category: z.enum(["youth", "senior"]).optional(),
});

const PROMPT_VERSION = "v1.2.0"; // P1 bloque 4: sin maduración ⇒ sin clasificar; sin edad por defecto

/** Texto de los campos cualitativos cuando la maduración no está registrada. */
export const MATURATION_UNKNOWN_LABEL = "sin datos (maduración no registrada)";

/**
 * ¿La sesión de fatiga que se analiza tiene la maduración REGISTRADA? Sin sesión
 * (solo historial) tampoco se sabe ⇒ false.
 */
export function fatigueMaturationKnown(data: z.infer<typeof fatigueReportSchema>): boolean {
  const fr = data.fatigueReport as Record<string, unknown> | null | undefined;
  if (!fr || typeof fr !== "object") return false;
  return maturationKnown(fr.maturation_band ?? fr.maturationBand, fr.phv_offset ?? fr.phvOffset);
}

/** Qué hacer para activar el informe cuando falta la maduración. */
export const MATURATION_UNKNOWN_NEXT_STEP =
  "Registra las medidas de crecimiento del jugador (talla, peso, talla sentado, longitud de pierna, fecha de nacimiento y sexo) para activar la valoración de fatiga y carga.";

/**
 * Informe de fatiga sin maduración registrada: DETERMINISTA (no pasa por el modelo).
 * Sin índice, severidad, zona ni riesgo de lesión; solo la carga registrada (si es
 * real: total_load > 0, la columna es NOT NULL DEFAULT 0) y el ratio agudo:crónico
 * cuando hay historial suficiente, sin calificarlo.
 */
export function maturationGatedFatigueReport(data: z.infer<typeof fatigueReportSchema>): Record<string, unknown> {
  const fr = data.fatigueReport as Record<string, unknown> | null | undefined;
  const load = fr && typeof fr.total_load === "number" && Number.isFinite(fr.total_load) && fr.total_load > 0
    ? Math.round(fr.total_load)
    : null;
  const history = Array.isArray(data.fatigueHistory) ? data.fatigueHistory : [];
  const ratio = fr && typeof fr.acwr_value === "number" && Number.isFinite(fr.acwr_value) && fatigueIsReliable(history.length)
    ? Math.round(fr.acwr_value * 100) / 100
    : null;
  return {
    estadoActual: { indice: null, severidad: MATURATION_UNKNOWN_LABEL, indicadores: [], señalesPosturales: [] },
    cargaACWR: {
      valor: ratio,
      zona: MATURATION_UNKNOWN_LABEL,
      tendencia: "sin datos",
      recomendacionProximaSesion: MATURATION_UNKNOWN_NEXT_STEP,
    },
    riesgoLesion: { nivel: MATURATION_UNKNOWN_LABEL, factores: [], zonasExpuestas: [] },
    ajustesPHV: { banda: "unknown", umbralesModificados: [], recomendaciones: [] },
    protocoloRecuperacion: { plan48h: [], indicadoresRetorno: [], ejerciciosComplementarios: [] },
    resumenEjecutivo:
      "Maduración no registrada: no se valoran la fatiga, la carga ni el riesgo de lesión, porque sus umbrales dependen de la maduración." +
      (load !== null ? ` Carga registrada en la última sesión: ${load} UA.` : ""),
    confidence_score: 0,
    data_completeness: 0,
    not_evaluated: [
      "Índice y severidad de fatiga: maduración no registrada",
      "Zona de carga (ACWR): maduración no registrada",
      "Riesgo de lesión por fatiga: maduración no registrada",
    ],
    _gated: true,
    _gate_reason: "maturation_unknown",
  };
}

function buildPrompt(data: z.infer<typeof fatigueReportSchema>): string {
  // Sin edad conocida se dice; antes se suponían 12 años.
  const age = data.playerContext?.chronologicalAge ?? null;
  const position = data.playerContext?.position ?? "MID";
  const phvOffset = (data.phv as Record<string, unknown>)?.offset ?? (data.phv as Record<string, unknown>)?.maturity_offset ?? null;
  const phvCategory = (data.phv as Record<string, unknown>)?.category ?? (data.phv as Record<string, unknown>)?.phv_category ?? "unknown";
  const fatigue = data.fatigueReport ?? {};
  const locale = normalizeLocale(data.locale);
  // C1 multi-categoría · override explícito > edad cronológica > default youth
  const category = resolveCategory({ age: data.playerContext?.chronologicalAge, category: data.category });

  return `Eres un analista de rendimiento deportivo ${category === "senior" ? "profesional" : "juvenil"} especializado en fatiga y gestión de carga.

## CONTEXTO DEL JUGADOR
- Edad cronológica: ${age !== null ? `${age} años` : "No disponible"}
- Posición: ${position}${category === "senior" ? "" : `
- Offset PHV: ${phvOffset !== null ? `${phvOffset} años (${phvCategory})` : "No disponible"}`}

## DATOS DE FATIGA DE LA SESIÓN
${JSON.stringify(fatigue, null, 2)}

## HISTORIAL DE SESIONES (últimas 4 semanas)
${data.fatigueHistory ? JSON.stringify(data.fatigueHistory.slice(-10), null, 2) : "Sin historial disponible"}

## INSTRUCCIONES
Genera un reporte de fatiga con las siguientes secciones. Usa SOLO datos concretos. Si falta un dato (índice de fatiga, ACWR, historial de carga), NO lo estimes: pon ese campo en null y decláralo en not_evaluated. NUNCA inventes una cifra de fatiga, carga o riesgo. Un hueco honesto vale más que un número inventado sobre un menor.

CONFIANZA (obligatorio): rellena confidence_score (0-100) = tu confianza real en el análisis según los datos que realmente tienes; data_completeness (0-100) = porcentaje de dimensiones evaluadas con datos reales (no inferidos); not_evaluated = lista honesta de los aspectos que NO pudiste evaluar por falta de datos. Con pocos datos, BAJA el score — no infles la confianza. Es un diferenciador de VITAS mostrar incertidumbre con honestidad.

### 1. Estado Actual de Fatiga
- Índice de fatiga (0-100) y severidad
- Principales indicadores (sprint decay, speed decay, metabolic trend)
- Señales posturales detectadas (manos en rodillas, inclinación trunk, etc.)

### 2. Análisis de Carga (ACWR)
- Valor ACWR actual y zona (óptimo/precaución/peligro/desentrenado)
- Tendencia de carga aguda vs crónica
- Recomendación de carga para la próxima sesión

### 3. Riesgo de Lesión
- Nivel de riesgo (bajo/moderado/alto/muy alto)
- Factores de riesgo identificados
- Zonas corporales más expuestas

${category === "senior" ? `### 4. Ajustes de Umbrales Individuales
- Jugador sénior: NO menciones maduración biológica/PHV — no aplica a adultos
- Umbrales personalizados aplicados (sprint, metabolic, ACWR) según el perfil y la carga del jugador
- En el campo "ajustesPHV" del JSON usa banda "senior" y recomendaciones de gestión de carga adulta` : `### 4. Ajustes PHV
- Cómo la maduración biológica afecta los umbrales de fatiga
- Umbrales personalizados aplicados (sprint, metabolic, ACWR)
- Recomendaciones específicas por banda de maduración`}

### 5. Protocolo de Recuperación
- Plan de recuperación para las próximas 48-72 horas
- Indicadores para volver a entrenar a intensidad completa
- Ejercicios complementarios recomendados

Formato: JSON con estructura:
{
  "estadoActual": { "indice": number|null, "severidad": string, "indicadores": string[], "señalesPosturales": string[] },
  "cargaACWR": { "valor": number|null, "zona": string, "tendencia": string, "recomendacionProximaSesion": string },
  "riesgoLesion": { "nivel": string, "factores": string[], "zonasExpuestas": string[] },
  "ajustesPHV": { "banda": string, "umbralesModificados": string[], "recomendaciones": string[] },
  "protocoloRecuperacion": { "plan48h": string[], "indicadoresRetorno": string[], "ejerciciosComplementarios": string[] },
  "resumenEjecutivo": string,
  "confidence_score": number,
  "data_completeness": number,
  "not_evaluated": ["string · aspectos que NO se pudieron evaluar por falta de datos; array vacío si todo cubierto"]
}

REGLA DURA DE HONESTIDAD (inv #2): "indice" es un número SOLO si los datos de la sesión traen un fatigue_index REAL; si no, "indice": null. "cargaACWR.valor" es un número SOLO si hay acwr_value real o historial de carga; si no, null. Nunca aproximes ni rellenes con un valor "típico". Cuando una métrica sea null, su cualitativo asociado (severidad / zona / nivel) = "sin datos".

${languageDirective(locale)}${category === "senior" ? "\n\n" : ""}${categoryDirective(category, locale)}`;
}

export default withHandler(
  { schema: fatigueReportSchema, requireAuth: true, allowServiceToken: true, maxRequests: 50 },
  async ({ body }) => {
    const data = body as z.infer<typeof fatigueReportSchema>;

    // Inv #2 (CLAUDE.md): ante dato ausente se BLOQUEA, nunca se estima. Sin sesiones
    // de fatiga ni historial de carga no hay nada que medir → informe bloqueado con
    // índice/ACWR/riesgo en null y motivo. Se corta ANTES del LLM y del mock, así que
    // ninguna rama (con o sin API key, éxito o error) puede fabricar cifras.
    if (!hasRealFatigueData(data)) {
      return successResponse({
        report: blockedFatigueReport(data),
        promptVersion: PROMPT_VERSION,
        model: "gated",
        source: "no_fatigue_data",
      });
    }

    // Sin maduración registrada: informe determinista, SIN modelo (P1 bloque 4).
    if (!fatigueMaturationKnown(data)) {
      return successResponse({
        report: maturationGatedFatigueReport(data),
        promptVersion: PROMPT_VERSION,
        model: "gated",
        source: "maturation_unknown",
      });
    }

    if (!ANTHROPIC_API_KEY) {
      // Fallback: generate mock report
      return successResponse({
        report: generateMockReport(data),
        promptVersion: PROMPT_VERSION,
        model: "mock",
        source: "fallback",
      });
    }

    try {
      const prompt = buildPrompt(data);

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
        console.error("[fatigue-report] Anthropic error:", response.status, errText.slice(0, 200));
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
        // Try to parse JSON from response
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
      console.error("[fatigue-report] Error:", err);
      return successResponse({
        report: generateMockReport(data),
        promptVersion: PROMPT_VERSION,
        model: "mock",
        source: "fallback_exception",
      });
    }
  },
);

/**
 * ¿Hay datos REALES de fatiga con los que evaluar? No basta con que la fila exista:
 * `fatigue_sessions` tiene columnas NOT NULL DEFAULT 0 (duration/distance/load), así que
 * un objeto "con claves" puede ser una sesión vacía (sin fatigue_index/acwr). Exigimos una
 * señal concreta: índice o ACWR no-nulos, o carga/distancia/duración > 0. Sin eso →
 * informe bloqueado (inv #2: ante dato ausente se bloquea, nunca se estima).
 */
export function hasRealFatigueData(data: z.infer<typeof fatigueReportSchema>): boolean {
  const notNull = (v: unknown) => v !== null && v !== undefined;
  const pos = (v: unknown) => typeof v === "number" && v > 0;
  const sessionHasSignal = (fr: Record<string, unknown> | null | undefined): boolean =>
    fr != null && typeof fr === "object" && (
      notNull(fr.fatigue_index) || notNull(fr.fatigueIndex) ||
      notNull(fr.acwr_value)    || notNull(fr.acwr) ||
      pos(fr.total_load) || pos(fr.total_distance_m) || pos(fr.duration_min)
    );
  const hasSession = sessionHasSignal(data.fatigueReport as Record<string, unknown> | null | undefined);
  const hasHistory = Array.isArray(data.fatigueHistory) &&
    data.fatigueHistory.some((h) => sessionHasSignal(h as Record<string, unknown>));
  return hasSession || hasHistory;
}

/**
 * Informe de fatiga BLOQUEADO (inv #2). Sin sesiones registradas no se puede evaluar
 * índice/ACWR/riesgo: se devuelven en null con motivo, NUNCA cifras fabricadas. La
 * vista (FatigueReportView) ya degrada null → sin cifra y muestra el resumen honesto.
 */
export function blockedFatigueReport(data: z.infer<typeof fatigueReportSchema>): Record<string, unknown> {
  const phv = data.phv as Record<string, unknown> | null | undefined;
  const banda = phv?.category ?? phv?.phv_category ?? "unknown";
  return {
    estadoActual: { indice: null, severidad: "sin datos", indicadores: [], señalesPosturales: [] },
    cargaACWR: {
      valor: null,
      zona: "sin datos",
      tendencia: "sin datos",
      recomendacionProximaSesion: "Registra sesiones de entrenamiento (carga/RPE) o analiza un vídeo con tracking para activar el análisis de carga.",
    },
    riesgoLesion: { nivel: "sin datos", factores: [], zonasExpuestas: [] },
    ajustesPHV: { banda, umbralesModificados: [], recomendaciones: [] },
    protocoloRecuperacion: { plan48h: [], indicadoresRetorno: [], ejerciciosComplementarios: [] },
    resumenEjecutivo: "Sin datos de sesión de fatiga registrados. No es posible evaluar el estado de fatiga, la carga (ACWR) ni el riesgo de lesión sin sesiones de entrenamiento o tracking de vídeo. Registra sesiones para activar este informe.",
    confidence_score: 0,
    data_completeness: 0,
    not_evaluated: [
      "Índice de fatiga: sin datos de sesión",
      "ACWR (carga aguda:crónica): sin historial de carga",
      "Riesgo de lesión por fatiga: sin datos",
    ],
    _gated: true,
    _gate_reason: "no_fatigue_data",
  };
}

// Fallback cuando el LLM no está disponible pero SÍ hay datos reales (el guard
// hasRealFatigueData ya cortó el caso sin datos). No se fabrican cifras: el índice
// sale del dato real si existe, si no null; el ACWR exige historial → null (no se
// estima), y no se inventan decays concretos.
export function generateMockReport(data: z.infer<typeof fatigueReportSchema>): Record<string, unknown> {
  const fatigue = data.fatigueReport as Record<string, unknown> | null;
  // La fila real de fatigue_sessions usa snake_case (fatigue_index); aceptamos ambos.
  const rawIdx = fatigue?.fatigue_index ?? fatigue?.fatigueIndex;
  const idx = typeof rawIdx === "number" ? rawIdx : null;
  // Mismos cortes que el índice de fatiga (DEFAULT_FATIGUE_CONFIG): una sola
  // definición (inv #7); antes este fallback usaba los suyos (66/33).
  const cut = DEFAULT_FATIGUE_CONFIG.severityThresholds;
  const severidad =
    idx === null ? "sin datos" : idx >= cut.critical ? "crítico" : idx >= cut.high ? "alto" : idx >= cut.moderate ? "moderado" : "bajo";
  return {
    estadoActual: {
      indice: idx,
      severidad,
      indicadores: [],
      señalesPosturales: [],
    },
    cargaACWR: {
      valor: null,
      zona: "sin datos",
      tendencia: "sin datos",
      recomendacionProximaSesion: "El ACWR exige historial de carga; registra sesiones para calcularlo.",
    },
    riesgoLesion: { nivel: "sin datos", factores: [], zonasExpuestas: [] },
    ajustesPHV: {
      banda: (data.phv as Record<string, unknown>)?.category ?? "unknown",
      umbralesModificados: [],
      recomendaciones: [],
    },
    protocoloRecuperacion: {
      plan48h: ["Hidratación adecuada", "Sueño de calidad", "Movilidad activa"],
      indicadoresRetorno: ["Ausencia de dolor muscular residual"],
      ejerciciosComplementarios: ["Core stability", "Movilidad de cadera", "Propiocepción"],
    },
    resumenEjecutivo: idx === null
      ? "Análisis de fatiga no disponible temporalmente (servicio de IA caído). No se muestran cifras estimadas."
      : `Índice de fatiga registrado: ${idx}/100 (${severidad}). El ACWR y el riesgo de lesión requieren historial de carga, no disponible en esta sesión.`,
    _fallback: true,
  };
}
