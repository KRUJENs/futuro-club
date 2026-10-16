/**
 * VITAS · Texto ÚNICO de la tarjeta «Duelos» bloqueada (P1 bloque 6, punto 3).
 *
 * Toda superficie que antes pintaba duelos (panel de tracking, ficha del Lab, panel de
 * estadísticas, informe impreso, exportes) pinta ESTO: un hueco visible con su motivo,
 * nunca «0G/0P», «0 %» ni una cifra. La métrica y su motivo canónico viven en
 * src/lib/tracking/duels.ts (`duelsMetric`); aquí solo está su traducción.
 */
import type { TFunction } from "i18next";

export interface DuelsGateText {
  /** Valor corto para el hueco de la cifra («No disponible»). */
  value: string;
  /** Motivo breve para tarjetas pequeñas. */
  hint: string;
  /** Motivo completo. */
  reason: string;
}

export function duelsGateText(t: TFunction): DuelsGateText {
  return {
    value: t("duelsGate.value"),
    hint: t("duelsGate.hint"),
    reason: t("duelsGate.reason"),
  };
}
