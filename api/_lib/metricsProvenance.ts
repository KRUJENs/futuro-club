/**
 * VITAS · Procedencia y fiabilidad de métricas deterministas (anti-fallo-silencioso).
 *
 * Lógica PURA (sin dependencias) para que el informe NO presente como "medido" lo
 * que en realidad es una estimación/placeholder. La usa _pipeline-orchestrator.ts.
 *
 * Hallazgo (red-team): 3/5 sub-scores del VSI son constantes hardcodeadas
 * (technique/mental/tactical) pero el VSI resultante se mostraba como cifra dura en
 * rankings/informe/email. Y la fatiga (ACWR) se calculaba con 1 sola sesión, sin
 * los ~28 días de histórico que necesita → riesgo de lesión "sólido" con datos
 * insuficientes. Estas funciones exponen esa verdad para que la UI/email la muestren.
 *
 * G4 (VSI honesto): buildVsiSubscores/gateVsiComposite migran el VSI de VÍDEO al
 * contrato MetricResult — las 3 dimensiones que el pipeline no mide son CONSTANTE
 * (value:null) y el compuesto se BLOQUEA si no hay ≥4/5 dimensiones con procedencia
 * real. vsiMeasuredFraction resume la cobertura para el badge "N/5 medidos" de la UI.
 */

import {
  type MetricResult,
  type Provenance,
  constant,
  derived,
  gated,
} from "../../src/lib/metrics/MetricResult";
import { MIN_SESSIONS_RELIABLE } from "../../src/lib/fatigue/acwrService";

export type VsiSubscoreKey = "technique" | "physical" | "mental" | "tactical" | "projection";

// ── G4 · VSI de vídeo como MetricResult (contrato de procedencia) ────────────

/** Motivo de bloqueo compartido para las 3 dimensiones no medidas por el pipeline. */
const PENDING_SUBSCORE =
  "El pipeline de visión aún no mide esta dimensión (pendiente · G4). No se estima.";

/**
 * Construye los 5 sub-scores del VSI de vídeo como MetricResult independientes
 * (criterio G4-1). technique/mental/tactical son CONSTANTE (value:null) porque el
 * pipeline NO las mide — dejan de emitirse como 65/60/55. physical y projection son
 * DERIVADA solo si hay señal real; si falta, quedan BLOQUEADAS (nunca un default).
 */
export function buildVsiSubscores(input: {
  /** Físico derivado de biomecánica (zancada/asimetría); null si no hay señal. */
  physicalValue: number | null;
  /** Proyección = VSI antropométrico ajustado (PHV); null si no hay antropometría. */
  projectionValue: number | null;
}): Record<VsiSubscoreKey, MetricResult> {
  return {
    technique: constant(PENDING_SUBSCORE),
    mental: constant(PENDING_SUBSCORE),
    tactical: constant(PENDING_SUBSCORE),
    physical:
      input.physicalValue != null
        ? derived(input.physicalValue, {
            confidence: 0.6,
            source_ref: "biomechanics:stride_frequency+asymmetry",
          })
        : gated(
            "Sin señales biomecánicas (frecuencia de zancada / asimetría) para derivar el físico.",
          ),
    projection:
      input.projectionValue != null
        ? derived(input.projectionValue, {
            confidence: 0.6,
            source_ref: "phv:adjusted_vsi",
          })
        : gated("Sin antropometría PHV (VSI ajustado) para derivar la proyección."),
  };
}

const REAL_PROVENANCE: Provenance[] = ["MEDIDA", "DERIVADA"];

/** ¿El sub-score es presentable como cifra real (value no null y procedencia MEDIDA/DERIVADA)? */
function isRealSubscore(r: MetricResult): boolean {
  return r.value !== null && REAL_PROVENANCE.includes(r.provenance);
}

/** Fracción de sub-scores con procedencia real (0..1), derivada de los MetricResult. */
export function vsiMeasuredFraction(subs: Record<VsiSubscoreKey, MetricResult>): number {
  const keys = Object.keys(subs) as VsiSubscoreKey[];
  return keys.filter((k) => isRealSubscore(subs[k])).length / keys.length;
}

/**
 * Compone el VSI de vídeo SOLO si ≥4/5 dimensiones tienen procedencia real
 * (criterio G4-2). Si no, devuelve un MetricResult BLOQUEADO (value:null) cuyo
 * gate_reason indica cuántas y cuáles faltan. Cuando compone, promedia SOLO las
 * dimensiones reales con pesos renormalizados (no rellena las ausentes) y refleja la
 * cobertura en confidence. Nunca compone un número con dimensiones no medidas.
 */
export function gateVsiComposite(
  subs: Record<VsiSubscoreKey, MetricResult>,
  weights: Record<VsiSubscoreKey, number>,
): MetricResult {
  const keys = Object.keys(weights) as VsiSubscoreKey[];
  const presentable = keys.filter((k) => isRealSubscore(subs[k]));
  const missing = keys.filter((k) => !isRealSubscore(subs[k]));

  if (presentable.length < 4) {
    return gated(
      `VSI de vídeo no disponible: solo ${presentable.length}/${keys.length} dimensiones ` +
        `con procedencia real (faltan: ${missing.join(", ")}). ` +
        `No se compone un score con dimensiones no medidas.`,
      { provenance: "DERIVADA" },
    );
  }

  const wsum = presentable.reduce((acc, k) => acc + weights[k], 0);
  const raw =
    presentable.reduce((acc, k) => acc + (subs[k].value as number) * weights[k], 0) / wsum;
  const value = Math.max(0, Math.min(100, raw)); // clamp [0,100] (paridad con computeVsi)
  return derived(Number(value.toFixed(1)), {
    confidence: presentable.length / keys.length,
    source_ref: "vsi-video-v1",
  });
}

/**
 * ACWR (acute:chronic workload ratio) necesita ~4 semanas de carga para ser fiable.
 * Con menos sesiones, el índice de fatiga/ACWR NO debe alimentar riesgo de lesión ni
 * valoración como si fuera un dato sólido.
 */
// Una sola definición (inv #7): la misma que usa acwrService para el ratio.
export const MIN_FATIGUE_SESSIONS = MIN_SESSIONS_RELIABLE;

export function fatigueIsReliable(sessionCount: number): boolean {
  return sessionCount >= MIN_FATIGUE_SESSIONS;
}
