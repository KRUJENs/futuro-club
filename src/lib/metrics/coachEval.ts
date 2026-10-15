/**
 * VITAS · Rótulo en línea de la EVALUACIÓN DEL ENTRENADOR (VSI de ficha) — P1 bloque 5b.
 *
 * Una sola forma de escribir la evaluación en chips y listas: «Eval. entrenador 72» o,
 * sin evaluar, «Eval. entrenador: Sin evaluar». Antes cada pantalla escribía «VSI 72»
 * y un «—» para el hueco (la regla de presentación prohíbe el guion: `value === null`
 * se nombra). El VSI de ficha son 6 barras SUBJETIVAS del entrenador, no una puntuación
 * del sistema: por eso el rótulo dice de quién es.
 */
import type { TFunction } from "i18next";

export function coachEvalInline(t: TFunction, vsi: number | null | undefined, digits = 0): string {
  const label = t("coachEval.short");
  return typeof vsi === "number" && Number.isFinite(vsi)
    ? `${label} ${vsi.toFixed(digits)}`
    : `${label}: ${t("common.notEvaluated")}`;
}

/**
 * ¿Es un ANÁLISIS BASE (sin vídeo)? Guarda un `video_id` centinela «baseline-…»
 * (api/players/baseline-analysis.ts) y su VSI es la EVALUACIÓN DEL ENTRENADOR, no un VSI
 * de vídeo. Única definición (antes copiada en AnalysisDashboard y PlayerAnalysisPage).
 */
export function isCoachEvaluationAnalysis(videoId: unknown): boolean {
  return typeof videoId === "string" && videoId.startsWith("baseline-");
}

/**
 * Rótulo en línea del VSI de un análisis GUARDADO (listas de análisis): en un análisis
 * base es la evaluación del entrenador; en uno de vídeo es el VSI de vídeo (otro índice,
 * hoy bloqueado si faltan sus entradas ⇒ «sin calcular», nunca «—»).
 */
export function analysisVsiInline(t: TFunction, videoId: unknown, vsi: unknown, digits = 1): string {
  const v = typeof vsi === "number" && Number.isFinite(vsi) ? vsi : null;
  if (isCoachEvaluationAnalysis(videoId)) return coachEvalInline(t, v, digits);
  return v !== null ? `VSI ${v.toFixed(digits)}` : `VSI: ${t("common.notCalculated")}`;
}
