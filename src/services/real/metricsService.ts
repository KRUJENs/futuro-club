/**
 * VITAS Metrics Service — DETERMINISTA
 * Cálculos matemáticos puros: VSI de ficha y tendencias. (Los percentiles entre pares
 * viven en src/lib/metrics/percentile.ts, implementación única.)
 * No usa IA. Algoritmos fijos y reproducibles.
 */

export interface PlayerMetrics {
  speed: number;
  technique: number;
  vision: number;
  stamina: number;
  shooting: number;
  defending: number;
}

/**
 * VSI de FICHA — pesos + fórmula (fuente ÚNICA · invariante #7). Antes esta fórmula
 * estaba triplicada idéntica en metricsService, api/players/_crud.ts y
 * api/rankings/_list.ts; ahora esas dos importan calculateFichaVsi de aquí.
 * Entradas = SLIDERS subjetivos del coach (no medida). Índice DISTINTO del VSI de VÍDEO
 * (api/agents/_vsi-calculator.ts), a propósito.
 *
 * Justificación de pesos: technique 0.22 (predictor más fuerte de éxito profesional,
 * Huijgen et al. 2009, no depende de maduración); vision 0.20 (inteligencia de juego,
 * Jordet 2005 / Savelsbergh 2006); speed 0.18 (dependiente de PHV → no sobrevalorar
 * ventajas madurativas temporales); stamina 0.15 (altamente entrenable); shooting 0.13
 * (pico tardío 27-28); defending 0.12 (capacidades defensivas maduran aún más tarde).
 */
export const FICHA_VSI_WEIGHTS: Record<keyof PlayerMetrics, number> = {
  speed: 0.18,
  technique: 0.22,
  vision: 0.2,
  stamina: 0.15,
  shooting: 0.13,
  defending: 0.12,
};

/**
 * Suma ponderada de las 6 dimensiones → VSI de ficha (0-100, un decimal). Acepta
 * métricas parciales (dimensión ausente cuenta 0), igual que las 3 rutas previas.
 */
export function calculateFichaVsi(
  metrics: Partial<Record<keyof PlayerMetrics, number>>,
): number {
  const raw = (Object.keys(FICHA_VSI_WEIGHTS) as (keyof PlayerMetrics)[]).reduce(
    (acc, key) => acc + (metrics[key] ?? 0) * FICHA_VSI_WEIGHTS[key],
    0,
  );
  return Math.round(raw * 10) / 10;
}

export const MetricsService = {
  /** VSI de FICHA (evaluación del entrenador) — delega en calculateFichaVsi (arriba). */
  calculateVSI(metrics: PlayerMetrics): number {
    return calculateFichaVsi(metrics);
  },

  /**
   * Calcula la tendencia comparando VSI actual con histórico
   */
  calculateTrend(currentVSI: number, previousVSI: number): "up" | "down" | "stable" {
    const delta = currentVSI - previousVSI;
    if (delta > 2) return "up";
    if (delta < -2) return "down";
    return "stable";
  },

  // (Sin calculatePercentile: el percentil entre pares tiene una implementación única,
  //  src/lib/metrics/percentile.ts, con mínimo de pares; esta devolvía 50 con el grupo
  //  vacío. P1 bloque 5, invariante #7.)

  /**
   * Clasifica el VSI en etiqueta semántica
   */
  classifyVSI(vsi: number): "elite" | "high" | "medium" | "developing" {
    if (vsi >= 80) return "elite";
    if (vsi >= 65) return "high";
    if (vsi >= 50) return "medium";
    return "developing";
  },

  /**
   * Normaliza una métrica de 0-100 a 0-1
   */
  normalize(value: number): number {
    return Math.min(1, Math.max(0, value / 100));
  },

  /**
   * Calcula el promedio ponderado de métricas
   */
  weightedAverage(values: number[], weights: number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    const sum = values.reduce((acc, val, i) => acc + val * (weights[i] / total), 0);
    return Math.round(sum * 10) / 10;
  },
};
