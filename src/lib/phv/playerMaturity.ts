/**
 * VITAS · Adaptador de maduración por jugador (fuente ÚNICA para la UI)
 *
 * Puente entre el modelo Player y el motor científico `resolveMaturity`:
 *   - Usa la edad cronológica DECIMAL (desde birthDate si existe, ver age.ts).
 *   - Pasa las alturas parentales para habilitar %PAH (Khamis-Roche).
 *   - Expone helpers de PRESENTACIÓN (tono, claves i18n de estado/timing/
 *     confianza) para que TODAS las pantallas muestren lo mismo, sin recalcular
 *     ni contradecirse.
 *
 * Regla de oro: ninguna pantalla debe volver a leer `biologicalAge` (inválido)
 * ni derivar la maduración por su cuenta. Todo pasa por aquí.
 */

import { resolveMaturity, type MaturityAssessment, type MaturityTiming, type PhvStatus } from "./maturity";
import { resolveChronologicalAge } from "@/lib/shared/age";

/** Campos de Player que necesita el cálculo (subconjunto laxo). */
export interface PlayerMaturityInput {
  age?: number | null;
  birthDate?: string | null;
  height?: number | null;
  weight?: number | null;
  sittingHeight?: number | null;
  legLength?: number | null;
  gender?: "M" | "F" | null;
  motherHeightCm?: number | null;
  fatherHeightCm?: number | null;
}

/** Resuelve la maduración de un jugador (edad decimal exacta cuando hay birthDate). */
export function playerMaturity(
  player: PlayerMaturityInput,
  at?: string | Date,
): MaturityAssessment {
  return resolveMaturity({
    // Sexo honesto: si no es "M"/"F" explícito, se pasa undefined → el motor lo
    // trata como dato insuficiente y no afirma timing sobre un sexo asumido.
    sex: player.gender === "M" || player.gender === "F" ? player.gender : undefined,
    ageYears: resolveChronologicalAge(player, at),
    heightCm: player.height ?? undefined,
    weightKg: player.weight ?? undefined,
    sittingHeightCm: player.sittingHeight ?? undefined,
    legLengthCm: player.legLength ?? undefined,
    motherHeightCm: player.motherHeightCm ?? undefined,
    fatherHeightCm: player.fatherHeightCm ?? undefined,
  });
}

/* ── Presentación (tono + claves i18n) ─────────────────────────────────── */

export type MaturityTone = "boost" | "discount" | "neutral";

/** Tono visual: solo destaca (boost/discount) con un timing firme. */
export function maturityTone(a: MaturityAssessment): MaturityTone {
  if (a.timing === "late") return "boost"; // madurador tardío = talento (posible) infravalorado
  if (a.timing === "early") return "discount";
  return "neutral";
}

/** Clave i18n del ESTADO (pre/circa/post-PHV) o "unknown". */
export function maturityStatusKey(status: PhvStatus | "unknown"): string {
  return `maturity.status.${status}`;
}

/** Clave i18n del TIMING vs pares. */
export function maturityTimingKey(timing: MaturityTiming): string {
  return `maturity.timing.${timing}`;
}

/** Clave i18n de la confianza. */
export function maturityConfidenceKey(confidence: MaturityAssessment["confidence"]): string {
  return `maturity.confidence.${confidence}`;
}

/**
 * Etiqueta de banda biológica por %PAH (bio-banding real, Cumming) cuando hay
 * datos parentales; si no, null (no inventar banda desde el offset inválido).
 * El viejo bioBandFor(edad+offset) se retiró (P2 bloque 9); el agrupamiento de una
 * plantilla por banda vive en squadBioBanding.ts.
 */
export function maturityBandKey(a: MaturityAssessment): string | null {
  if (a.method !== "khamis_roche_pah" || a.status === "unknown") return null;
  return maturityStatusKey(a.status);
}
