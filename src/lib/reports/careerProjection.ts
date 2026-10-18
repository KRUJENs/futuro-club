/**
 * VITAS · Proyección de carrera — BLOQUEADA siempre (P1 bloque 7, decisión del dueño D2).
 *
 * El análisis base pedía al modelo «escenario optimista / realista» con un nivel futuro
 * («Top semipro», «Amateur alto», «Primera División» en informes antiguos de vídeo),
 * factores y riesgos. No hay ningún modelo validado que prediga el nivel futuro de un
 * menor: era texto del modelo presentado como pronóstico. Mismo criterio que las
 * proyecciones del perfil de rol (5c): no se genera y lo guardado no se pinta; en su
 * lugar, el motivo. Edge-safe: sin alias `@/`.
 */
import { gated, type MetricResult } from "../metrics/MetricResult";

export const CAREER_PROJECTION_GATE_REASON =
  "Proyección de carrera no disponible: no hay un modelo validado que prediga el nivel futuro de un jugador en formación.";

export function careerProjectionMetric(): MetricResult<string> {
  return gated<string>(CAREER_PROJECTION_GATE_REASON, { source_ref: "src/lib/reports/careerProjection.ts" });
}
