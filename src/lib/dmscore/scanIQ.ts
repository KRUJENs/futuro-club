/**
 * VITAS · Scan IQ — BLOQUEADO (P1 bloque 6b, punto 9).
 *
 * Antes era un «Scan IQ 0-100 calibrado por edad»: el percentil dentro de unas bandas por
 * edad (benchmarks.ts) que el propio fichero llamaba «interpolaciones razonables», sin
 * fuente; una cita de investigación («escaneaban 2× más a los 12-14 años») sin referencia
 * verificada; 14 años por defecto si faltaba la edad (useDMScore); y la entrada (scans por
 * recepción) salía de un detector que NO detecta recepciones (las repartía cada ~4 s) ni
 * identifica al jugador (pose de cualquier persona del plano), con tasas de éxito
 * constantes (0,65 / 0,45) rotuladas «Vídeo real».
 *
 * Se desbloquea con: detector de recepciones del balón + identidad del jugador (dorsal,
 * .claude/rules/identidad.md) + una base por edad con fuente, validados contra clips
 * anotados a mano. Hasta entonces: value null + motivo (inv #2).
 */
import { gated, type MetricResult } from "../metrics/MetricResult";

export const SCAN_IQ_SOURCE_REF = "src/lib/dmscore/scanIQ.ts";

export const SCAN_IQ_GATE_REASON =
  "Scan IQ no disponible: no hay una base validada para puntuar el escaneo por edad y el análisis " +
  "de vídeo no detecta las recepciones del balón ni identifica al jugador.";

/** El Scan IQ de un jugador: hoy siempre bloqueado con su motivo. */
export function scanIQMetric(): MetricResult<number> {
  return gated<number>(SCAN_IQ_GATE_REASON, { source_ref: SCAN_IQ_SOURCE_REF });
}

// El ejemplo FIJO del demo (MOCK) vive aparte: scanIQExample.ts (concepto scan_iq_ejemplo).
