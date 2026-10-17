/**
 * VITAS · Decision-Making Score — BLOQUEADO (P1 bloque 6b, punto 9).
 *
 * Antes era un compuesto 0-100 con pesos 35/35/15/15 sin fuente sobre cuatro señales que
 * hoy no están medidas: Scan IQ (bloqueado, ver scanIQ.ts), velocidad de decisión y temple
 * del perfil conductual (generador de ejemplo / heurísticas sin validar) y la lectura
 * táctica del vídeo (el pipeline no la mide). Con dos de ellas ya emitía «élite para su
 * edad» y una confianza.
 *
 * Se desbloquea cuando sus componentes estén medidos y validados y los pesos tengan
 * fuente. Hasta entonces: value null + motivo (inv #2).
 */
import { gated, type MetricResult } from "../metrics/MetricResult";

export const DM_SCORE_SOURCE_REF = "src/lib/dmscore/dmScore.ts";

export const DM_SCORE_GATE_REASON =
  "Decision-Making Score no disponible: sus pesos no tienen fuente y sus componentes no están " +
  "medidos (Scan IQ bloqueado; velocidad de decisión y temple sin validar; lectura táctica no " +
  "medida por el vídeo).";

export function dmScoreMetric(): MetricResult<number> {
  return gated<number>(DM_SCORE_GATE_REASON, { source_ref: DM_SCORE_SOURCE_REF });
}
