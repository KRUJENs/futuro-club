/**
 * VITAS · Señal de sesgo madurativo de la lista de jugadores del panel Master (`/master`).
 *
 * Sale SOLO de la maduración canónica con el gate del PHV abierto, confianza suficiente
 * y timing afirmado (`phvGate` → `assessment`, sin tocar el PHV — inv #4). Su DIRECCIÓN
 * es la del propio motor (`adjustmentFor` en src/lib/phv/maturity.ts: tardío ×1,12,
 * precoz ×0,92):
 *   - "late"    ⇒ madurador tardío: su evaluación puede estar INFRAVALORADA,
 *   - "early"   ⇒ madurador precoz: su evaluación puede estar SOBREVALORADA,
 *   - "on_time" ⇒ maduración en fase: sin corrección madurativa.
 * Es una señal de dirección, no un nivel: no se pinta «alta/media/baja».
 *
 * Sin señal ⇒ `value: null` + `gate_reason` (inv #2), en dos casos:
 *   - gate del PHV CERRADO (falta una medida o hay medidas fuera de rango): el motivo es
 *     el del gate y la UI lo traduce con `PhvGateNotice` (componente único del «sin PHV»);
 *   - gate ABIERTO pero el motor no afirma el timing (Mirwald lejos del PHV, o
 *     antropometría no plausible para la edad): el motivo es la nota del motor y la UI
 *     pinta «Timing por determinar» (`maturity.timing.unknown`). La nota NO se enseña en
 *     la fila: sugiere la altura de los padres, que el gate no usa.
 * Confianza: la del APHV de Mirwald del gate (el timing sale de él).
 * Antes: «MED BIAS ALERT» por defecto, «LOW BIAS» con un percentil > 70 (corte sin
 * fuente) y «LOW» a los precoces, al revés que el motor (P1 bloque 6, revisiones #322).
 */
import { phvGate, type PhvGate } from "@/lib/phv/phvGate";
import { derived, gated, type MetricResult } from "@/lib/metrics/MetricResult";

export type MaturityBiasSignal = "late" | "early" | "on_time";

/** Clave i18n de la DIRECCIÓN del posible sesgo (la del motor); en fase ⇒ ninguna. */
export const MATURITY_BIAS_DIRECTION_KEY: Record<MaturityBiasSignal, string | null> = {
  late: "master.biasLate", // motor ×1,12 ⇒ posible infravaloración
  early: "master.biasEarly", // motor ×0,92 ⇒ posible sobrevaloración
  on_time: null,
};

export const MATURITY_BIAS_SOURCE_REF = "src/lib/metrics/maturityBiasAlert.ts · phvGate (src/lib/phv)";

/** Motivo si el motor no dejó nota (no debería ocurrir: todas sus abstenciones la llevan). */
export const MATURITY_BIAS_FALLBACK_REASON =
  "Timing de maduración no determinable con los datos registrados: no hay señal de sesgo madurativo.";

type GateInput = Parameters<typeof phvGate>[0];

export interface MaturityBiasResult {
  signal: MetricResult<MaturityBiasSignal>;
  /** El gate del PHV, para que la UI traduzca su motivo con PhvGateNotice. */
  gate: PhvGate;
}

export function maturityBiasAlert(player: GateInput, at?: string | Date): MaturityBiasResult {
  const gate = phvGate(player, at);
  if (!gate.ok) {
    return { gate, signal: gated<MaturityBiasSignal>(gate.gate_reason, { source_ref: MATURITY_BIAS_SOURCE_REF }) };
  }
  const a = gate.assessment;
  // «moderate» no se alcanza hoy por el gate (con las 4 medidas Mirwald no es estimado y la
  // confianza del motor es high o low); se acepta por si el motor cambia (revisión #322 r4).
  const firm = a.confidence === "high" || a.confidence === "moderate";
  if (firm && (a.timing === "late" || a.timing === "early" || a.timing === "on_time")) {
    return {
      gate,
      signal: derived<MaturityBiasSignal>(a.timing, {
        // El timing sale del APHV (edad − offset) ⇒ su confianza; no recoge la incertidumbre
        // de la banda de ±1 año del timing (no se renderiza hoy).
        confidence: gate.aphv.confidence,
        source_ref: MATURITY_BIAS_SOURCE_REF,
      }),
    };
  }
  const reason = a.validityNote?.trim() ? a.validityNote : MATURITY_BIAS_FALLBACK_REASON;
  return { gate, signal: gated<MaturityBiasSignal>(reason, { source_ref: MATURITY_BIAS_SOURCE_REF }) };
}
