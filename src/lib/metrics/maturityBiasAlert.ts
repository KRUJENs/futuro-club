/**
 * VITAS · Señal de sesgo madurativo de la lista de jugadores del panel Master (`/master`).
 *
 * Sale SOLO de la maduración canónica con el gate abierto, confianza suficiente y timing
 * afirmado (`gatedMaturity`, sin tocar el PHV — inv #4). Su DIRECCIÓN es la del propio
 * motor (`adjustmentFor` en src/lib/phv/maturity.ts: tardío ×1,12, precoz ×0,92):
 *   - "late"    ⇒ madurador tardío: su evaluación puede estar INFRAVALORADA,
 *   - "early"   ⇒ madurador precoz: su evaluación puede estar SOBREVALORADA,
 *   - "on_time" ⇒ maduración en fase: sin corrección madurativa.
 * Es una señal de dirección, no un nivel: no se pinta «alta/media/baja».
 *
 * Sin señal ⇒ `value: null` + `gate_reason` = la nota del motor (`validityNote`): gate
 * cerrado (falta una medida), Mirwald lejos del PHV, %PAH sin timing vs pares o
 * antropometría no plausible (inv #2). Antes: «MED BIAS ALERT» por defecto y «LOW BIAS»
 * con un percentil de la evaluación del entrenador > 70 (corte sin fuente; el percentil
 * no mide maduración) (P1 bloque 6, revisiones #322).
 */
import { gatedMaturity } from "@/lib/phv/phvGate";
import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "@/lib/metrics/MetricResult";

export type MaturityBiasSignal = "late" | "early" | "on_time";

export const MATURITY_BIAS_SOURCE_REF = "src/lib/metrics/maturityBiasAlert.ts · gatedMaturity (src/lib/phv)";

/** Motivo si el motor no dejó nota (no debería ocurrir: todas sus abstenciones la llevan). */
export const MATURITY_BIAS_FALLBACK_REASON =
  "Timing de maduración no determinable con los datos registrados: no hay señal de sesgo madurativo.";

type GateInput = Parameters<typeof gatedMaturity>[0];

export function maturityBiasAlert(player: GateInput, at?: string | Date): MetricResult<MaturityBiasSignal> {
  const mat = gatedMaturity(player, at);
  const firm = mat.confidence === "high" || mat.confidence === "moderate";
  if (firm && (mat.timing === "late" || mat.timing === "early" || mat.timing === "on_time")) {
    return derived<MaturityBiasSignal>(mat.timing, {
      // "moderate" = alguna medida estimada en el motor ⇒ confianza orientativa.
      ...(mat.confidence === "moderate" ? { confidence: ORIENTATIVE_CONFIDENCE } : {}),
      source_ref: MATURITY_BIAS_SOURCE_REF,
    });
  }
  const reason = mat.validityNote?.trim() ? mat.validityNote : MATURITY_BIAS_FALLBACK_REASON;
  return gated<MaturityBiasSignal>(reason, { source_ref: MATURITY_BIAS_SOURCE_REF });
}
