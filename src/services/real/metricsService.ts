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

const COACH_METRIC_KEYS = Object.keys(FICHA_VSI_WEIGHTS) as (keyof PlayerMetrics)[];

/**
 * Las 6 barras de la evaluación del entrenador del blob `data.metrics`, o null si falta
 * alguna (no evaluado del todo). Una barra ausente NO vale 0. Fuente única de «tiene
 * evaluación completa» (P1 bloque 5a).
 */
export function completeCoachMetrics(raw: unknown): PlayerMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out = {} as PlayerMetrics;
  for (const k of COACH_METRIC_KEYS) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * VSI de ficha de un jugador desde su blob `data` — regla ÚNICA de «evaluado» (P1 bloque
 * 5a, invariante #7): el valor guardado (lo que enseña la ficha) o, si no lo hay,
 * calculateFichaVsi de las 6 barras COMPLETAS; si no, null («sin evaluar»). Antes
 * Rankings calculaba con barras parciales (una barra ausente valía 0: `metrics: {}` ⇒ 0).
 */
export function fichaVsiFromBlob(d: { vsi?: unknown; metrics?: unknown } | null | undefined): number | null {
  if (!d) return null;
  if (typeof d.vsi === "number" && Number.isFinite(d.vsi)) return d.vsi;
  const m = completeCoachMetrics(d.metrics);
  return m ? calculateFichaVsi(m) : null;
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
