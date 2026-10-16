/**
 * VITAS · Scan IQ — EJEMPLO FIJO del modo demo (P1 bloque 6b).
 *
 * Valores de EJEMPLO, el MISMO para todos los jugadores (nada derivado del id) y con
 * procedencia MOCK, que exige banner visible. Nunca fuera del demo: el Scan IQ real está
 * bloqueado (scanIQ.ts). Concepto propio en el registro: `scan_iq_ejemplo`.
 */
import { mock, type MetricResult } from "../metrics/MetricResult";

export const SCAN_IQ_EXAMPLE_SOURCE_REF = "src/lib/dmscore/scanIQExample.ts · ejemplo demo";

export const SCAN_IQ_DEMO_EXAMPLE = {
  scanIQ: 72,
  receptionsAnalyzed: 24,
  avgScansPreReception: 2.3,
  scansUnderPressure: 1.6,
  successWithScan: 0.71,
  successWithoutScan: 0.46,
  forwardOrientedPct: 0.62,
} as const;

export function scanIQDemoExample(): MetricResult<number> {
  return mock<number>(SCAN_IQ_DEMO_EXAMPLE.scanIQ, { source_ref: SCAN_IQ_EXAMPLE_SOURCE_REF });
}
