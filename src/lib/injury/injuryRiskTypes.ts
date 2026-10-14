/**
 * VITAS · Contrato del informe de RIESGO DE LESIÓN (P1 bloque 4b)
 *
 * Lo emite `api/agents/_injury-risk-calculator.ts` (promptVersion
 * v2.0.0-deterministic) y lo pintan InjuryRiskCard, el informe LLM de lesión, la
 * valoración, el IDP y el snapshot de seguimiento. Sustituye a `overallRisk`
 * (número siempre presente) por un MetricResult: sin datos suficientes el
 * compuesto es null con su motivo, nunca un riesgo por defecto. Ya no existe
 * `returnToPlayReady` («Apto para actividad completa»): el alta de un menor la
 * decide el médico o el fisioterapeuta, no este modelo.
 *
 * Imports relativos (no `@/`): este módulo lo usa también el servidor Edge.
 */
import type { MetricResult } from "../metrics/MetricResult";
import type { InjuryRiskFactorKey } from "../../../config/injuryRisk";
import type { ShieldLevel } from "../phv/growthSpurtShield";

export type { InjuryRiskFactorKey };

export type InjuryRiskCategory = "low" | "moderate" | "high" | "critical";

export interface InjuryRiskFactorView {
  factor: InjuryRiskFactorKey;
  weight: number;
  /** false ⇒ no aplica a este jugador (p. ej. ventana PHV de un adulto). */
  applicable: boolean;
  /** Puntuación 0-100 del factor, o null con gate_reason. */
  result: MetricResult<number>;
  /** Detalle legible del dato de entrada (sin cifras inventadas). */
  description: string;
}

export interface InjuryRiskReport {
  playerId: string;
  /** Riesgo compuesto 0-100: DERIVADA con confianza reducida, o null + motivo. */
  composite: MetricResult<number>;
  /** null cuando el compuesto es null (sin semáforo). */
  category: InjuryRiskCategory | null;
  /** Fracción del peso aplicable con dato (0-1). */
  coverage: number;
  factors: InjuryRiskFactorView[];
  recommendations: string[];
  /** Nivel del Escudo de Estirón (misma definición de ventana PHV), o null. */
  growthShieldLevel: ShieldLevel | null;
  /** Días desde la última lesión REGISTRADA; null si no hay ninguna. */
  daysSinceLastInjury: number | null;
  injuryHistoryCount: number;
  /** Menos de 4 sesiones de carga registradas. */
  coldStartWarning: boolean;
  /** Solo en el entorno demo: datos de ejemplo (exige banner). */
  isMock?: boolean;
}

/** ¿Hay un riesgo compuesto presentable? (valor real y procedencia no CONSTANTE). */
export function injuryRiskValue(r: InjuryRiskReport | null | undefined): number | null {
  const c = r?.composite;
  return c && c.value !== null && c.provenance !== "CONSTANTE" ? c.value : null;
}
