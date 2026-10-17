/**
 * VITAS · Match Stats Service
 *
 * Agregador puro (determinista, sin side-effects) que transforma
 * `metricasCuantitativas` del análisis de vídeo en un resumen tipo
 * "panel Wyscout" con KPIs clásicos, ratios, ratings compuestos y
 * clasificación cualitativa — todo calculado on-the-fly desde los
 * datos que YA persisten en Supabase (`player_analyses.report`).
 *
 * No inventa datos. Si falta alguna sección (fisicas/eventos), la
 * deja indefinida. Nunca devuelve NaN/Infinity.
 *
 * Benchmarks son orientativos (medias sub-élite → pro), documentados
 * con fuente en el código. No pretenden ser verdad absoluta.
 */

import type { VideoIntelligenceOutput } from "@/agents/contracts";
import { estimatedLLM, gated, type MetricResult } from "@/lib/metrics/MetricResult";

// ─── Types ────────────────────────────────────────────────────────────────────

type MetricasCuantitativas = NonNullable<VideoIntelligenceOutput["metricasCuantitativas"]>;

export type KpiRating = "elite" | "excelente" | "bueno" | "aceptable" | "bajo";
export type PhysicalRating = "elite" | "alto" | "medio" | "bajo";
export type OverallLabel = "outstanding" | "excellent" | "good" | "average" | "below";

export interface PassStats {
  completados: number;
  fallados: number;
  total: number;
  precision: number;           // 0–100
  rating: KpiRating;
}

export interface RecoveryStats {
  total: number;               // "anticipaciones + robos + otros balones recuperados"
  rating: KpiRating;
}

/** Robos (tackles): recuperación por contacto físico. Subtipo de recuperación. */
export interface TackleStats {
  total: number;
  rating: KpiRating;
}

/** Anticipaciones (intercepciones): cortar línea de pase antes del contacto. Subtipo de recuperación. */
export interface AnticipationStats {
  total: number;
  rating: KpiRating;
}

/** Pérdidas: errores no forzados que entregan la posesión. */
export interface LossStats {
  total: number;
  rating: KpiRating;            // invertido: menos pérdidas = mejor rating
}

export interface ShotStats {
  alArco: number;
  fuera: number;
  total: number;
  precision: number;           // 0–100 (alArco / total)
}

export interface PhysicalStats {
  velocidadMaxKmh: number;
  velocidadPromKmh: number;
  distanciaM: number;
  sprints: number;
  rating: PhysicalRating;
  intensidadPct: {
    caminar: number;
    trotar: number;
    correr: number;
    sprint: number;
  };
}

export interface MatchStatsSummary {
  // Totales agregados
  totalAcciones: number;
  totalOfensivas: number;      // pases completados + disparos al arco
  totalDefensivas: number;     // recuperaciones (sin duelos: P1 bloque 6)

  // KPIs principales
  pases?: PassStats;
  // Sin duelos (P1 bloque 6): el modelo de vídeo los «contaba» sin criterio validado
  // (el prompt traía el ejemplo 3/1). Hueco con su motivo: src/lib/tracking/duels.ts.
  recuperaciones?: RecoveryStats;
  robos?: TackleStats;             // subtipo de recuperación (si viene desglosado)
  anticipaciones?: AnticipationStats; // subtipo de recuperación (si viene desglosado)
  perdidas?: LossStats;            // turnovers no forzados
  disparos?: ShotStats;
  fisicas?: PhysicalStats;

  // Rating global (0–10) — compuesto ponderado
  performanceRating: number;
  performanceLabel: OverallLabel;

  // Disponibilidad de secciones
  tieneEventos: boolean;
  tieneFisicas: boolean;

  // Metadatos
  fuente: "yolo+gemini" | "gemini_only" | "yolo_only";
  confianza: number;           // 0–1

  /**
   * Eventos como `MetricResult` con provenance ESTIMADA_LLM (contrato de métricas):
   * la salida del modelo de vídeo es una estimación, no una medición. ADITIVO —
   * los campos numéricos de arriba siguen alimentando la UI existente y el rating.
   */
  eventMetrics?: {
    pasesCompletados: MetricResult<number>;
    pasesFallados:    MetricResult<number>;
    recuperaciones:   MetricResult<number>;
    robos:            MetricResult<number>;
    anticipaciones:   MetricResult<number>;
    perdidas:         MetricResult<number>;
    disparosAlArco:   MetricResult<number>;
    disparosFuera:    MetricResult<number>;
  };
}

// ─── Benchmarks orientativos (sub-17 → pro) ───────────────────────────────────
// Fuentes: medias Opta Sports / StatsBomb para ligas formativas europeas
// Usadas SOLO para clasificación cualitativa, nunca como verdad absoluta.

const BENCHMARK = {
  // Precisión de pases (%)
  pasesPrecision: { elite: 88, excelente: 80, bueno: 70, aceptable: 60 },
  // Recuperaciones por análisis (clip típico de 10-20 min)
  recuperaciones: { elite: 8, excelente: 5, bueno: 3, aceptable: 1 },
  // Robos (tackles ganados) — más exigente que recuperaciones porque requiere duelo físico
  robos:          { elite: 4, excelente: 3, bueno: 2, aceptable: 1 },
  // Anticipaciones — valorado más alto porque evita el contacto (lectura superior)
  anticipaciones: { elite: 4, excelente: 3, bueno: 2, aceptable: 1 },
  // Pérdidas — UMBRAL INVERTIDO: menos pérdidas = mejor.
  // En un clip de 10-20 min, >5 pérdidas no forzadas = señal de mala toma de decisión
  perdidas:       { bajo: 1, aceptable: 2, bueno: 4, alto: 6 }, // nota: "alto" es MALO aquí
  // Velocidad máxima (km/h)
  velocidadMax: { elite: 32, alto: 28, medio: 24 },
} as const;

// ─── Helpers puros ────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const safePct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 100) : 0;

function passRating(precision: number): KpiRating {
  if (precision >= BENCHMARK.pasesPrecision.elite) return "elite";
  if (precision >= BENCHMARK.pasesPrecision.excelente) return "excelente";
  if (precision >= BENCHMARK.pasesPrecision.bueno) return "bueno";
  if (precision >= BENCHMARK.pasesPrecision.aceptable) return "aceptable";
  return "bajo";
}

function recoveryRating(total: number): KpiRating {
  if (total >= BENCHMARK.recuperaciones.elite) return "elite";
  if (total >= BENCHMARK.recuperaciones.excelente) return "excelente";
  if (total >= BENCHMARK.recuperaciones.bueno) return "bueno";
  if (total >= BENCHMARK.recuperaciones.aceptable) return "aceptable";
  return "bajo";
}

function tackleRating(total: number): KpiRating {
  if (total >= BENCHMARK.robos.elite) return "elite";
  if (total >= BENCHMARK.robos.excelente) return "excelente";
  if (total >= BENCHMARK.robos.bueno) return "bueno";
  if (total >= BENCHMARK.robos.aceptable) return "aceptable";
  return "bajo";
}

function anticipationRating(total: number): KpiRating {
  if (total >= BENCHMARK.anticipaciones.elite) return "elite";
  if (total >= BENCHMARK.anticipaciones.excelente) return "excelente";
  if (total >= BENCHMARK.anticipaciones.bueno) return "bueno";
  if (total >= BENCHMARK.anticipaciones.aceptable) return "aceptable";
  return "bajo";
}

/**
 * Rating invertido: 0 pérdidas = élite, 6+ = bajo.
 * Mejor rating cuanto MENOS balones regalas.
 */
function lossRating(total: number): KpiRating {
  if (total <= BENCHMARK.perdidas.bajo) return "elite";       // 0-1 pérdidas
  if (total <= BENCHMARK.perdidas.aceptable) return "excelente"; // 2 pérdidas
  if (total <= BENCHMARK.perdidas.bueno) return "bueno";      // 3-4 pérdidas
  if (total <= BENCHMARK.perdidas.alto) return "aceptable";   // 5-6 pérdidas
  return "bajo";                                              // 7+ pérdidas
}

function physicalRating(maxKmh: number): PhysicalRating {
  if (maxKmh >= BENCHMARK.velocidadMax.elite) return "elite";
  if (maxKmh >= BENCHMARK.velocidadMax.alto) return "alto";
  if (maxKmh >= BENCHMARK.velocidadMax.medio) return "medio";
  return "bajo";
}

// ─── Rating compuesto (0–10) ──────────────────────────────────────────────────
// Pondera KPIs disponibles. Si falta una sección, redistribuye peso.
// Nunca devuelve NaN/Infinity.
function composeRating(
  pass?: PassStats,
  rec?: RecoveryStats,
  shot?: ShotStats,
  phys?: PhysicalStats,
): { rating: number; label: OverallLabel } {
  const components: Array<{ weight: number; score: number }> = [];

  if (pass && pass.total > 0) {
    // 60% → 10.0, 100% → 10.0, <60% → escala lineal
    components.push({ weight: 0.30, score: clamp01(pass.precision / 100) * 10 });
  }
  if (rec && rec.total >= 0) {
    // 8+ recuperaciones = 10
    components.push({ weight: 0.20, score: clamp01(rec.total / BENCHMARK.recuperaciones.elite) * 10 });
  }
  if (shot && shot.total > 0) {
    components.push({ weight: 0.10, score: clamp01(shot.precision / 100) * 10 });
  }
  if (phys) {
    // Velocidad 32 km/h = 10
    components.push({ weight: 0.15, score: clamp01(phys.velocidadMaxKmh / BENCHMARK.velocidadMax.elite) * 10 });
  }

  if (components.length === 0) {
    return { rating: 0, label: "below" };
  }

  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const weighted = components.reduce((a, c) => a + c.score * c.weight, 0);
  const rating = Math.round((weighted / totalWeight) * 10) / 10; // 1 decimal

  let label: OverallLabel = "below";
  if (rating >= 8.5) label = "outstanding";
  else if (rating >= 7.0) label = "excellent";
  else if (rating >= 5.5) label = "good";
  else if (rating >= 4.0) label = "average";

  return { rating, label };
}

// ─── API principal ────────────────────────────────────────────────────────────

/**
 * Transforma `metricasCuantitativas` del report en un resumen rico para
 * el `MatchStatsPanel`. Puro, sin side-effects.
 */
export function computeMatchStats(
  metricas: MetricasCuantitativas | undefined | null,
): MatchStatsSummary | null {
  if (!metricas) return null;

  const { fisicas: fis, eventos: ev, fuente, confianza } = metricas;

  // ── Pases ─────
  const pases: PassStats | undefined = ev
    ? (() => {
        const total = ev.pasesCompletados + ev.pasesFallados;
        const precision = total > 0 ? ev.precisionPases : 0;
        return {
          completados: ev.pasesCompletados,
          fallados: ev.pasesFallados,
          total,
          precision,
          rating: passRating(precision),
        };
      })()
    : undefined;

  // ── Recuperaciones (agregado) ─────
  const recuperaciones: RecoveryStats | undefined = ev
    ? {
        total: ev.recuperaciones,
        rating: recoveryRating(ev.recuperaciones),
      }
    : undefined;

  // ── Robos (tackles) — solo si el reporte los desglosa ─────
  const robos: TackleStats | undefined =
    ev && typeof ev.robos === "number"
      ? { total: ev.robos, rating: tackleRating(ev.robos) }
      : undefined;

  // ── Anticipaciones (intercepciones) — solo si el reporte las desglosa ─────
  const anticipaciones: AnticipationStats | undefined =
    ev && typeof ev.anticipaciones === "number"
      ? { total: ev.anticipaciones, rating: anticipationRating(ev.anticipaciones) }
      : undefined;

  // ── Pérdidas — solo si el reporte las trae (retro-compat) ─────
  const perdidas: LossStats | undefined =
    ev && typeof ev.perdidas === "number"
      ? { total: ev.perdidas, rating: lossRating(ev.perdidas) }
      : undefined;

  // ── Disparos ─────
  const disparos: ShotStats | undefined = ev
    ? (() => {
        const total = ev.disparosAlArco + ev.disparosFuera;
        return {
          alArco: ev.disparosAlArco,
          fuera: ev.disparosFuera,
          total,
          precision: safePct(ev.disparosAlArco, total),
        };
      })()
    : undefined;

  // ── Físicas ─────
  const fisicasOut: PhysicalStats | undefined = fis
    ? (() => {
        const z = fis.zonasIntensidad;
        const totalZ = z.caminar + z.trotar + z.correr + z.sprint || 1;
        return {
          velocidadMaxKmh: Math.round(fis.velocidadMaxKmh * 10) / 10,
          velocidadPromKmh: Math.round(fis.velocidadPromKmh * 10) / 10,
          distanciaM: Math.round(fis.distanciaM),
          sprints: fis.sprints,
          rating: physicalRating(fis.velocidadMaxKmh),
          intensidadPct: {
            caminar: Math.round((z.caminar / totalZ) * 100),
            trotar: Math.round((z.trotar / totalZ) * 100),
            correr: Math.round((z.correr / totalZ) * 100),
            sprint: Math.round((z.sprint / totalZ) * 100),
          },
        };
      })()
    : undefined;

  // ── Totales agregados ─────
  const totalOfensivas =
    (pases?.completados ?? 0) + (disparos?.alArco ?? 0);
  const totalDefensivas = recuperaciones?.total ?? 0;
  const totalAcciones =
    (pases?.total ?? 0) +
    (recuperaciones?.total ?? 0) + (disparos?.total ?? 0);

  // ── Rating compuesto ─────
  const { rating: performanceRating, label: performanceLabel } =
    composeRating(pases, recuperaciones, disparos, fisicasOut);

  // ── Eventos como MetricResult (provenance declarada) ─────
  // El modelo de vídeo ESTIMA los eventos: nunca son una medición. Cada valor
  // lleva ESTIMADA_LLM + la confianza del propio análisis + la fuente. Los campos
  // opcionales que el modelo no reportó salen gateados (null + motivo), no en 0.
  const evMeta = { confidence: confianza, source_ref: fuente } as const;
  const evOpt = (v: number | undefined): MetricResult<number> =>
    typeof v === "number"
      ? estimatedLLM(v, evMeta)
      : gated("No reportado por el modelo de vídeo", { provenance: "ESTIMADA_LLM", source_ref: fuente });
  const eventMetrics: MatchStatsSummary["eventMetrics"] = ev
    ? {
        pasesCompletados: estimatedLLM(ev.pasesCompletados, evMeta),
        pasesFallados:    estimatedLLM(ev.pasesFallados, evMeta),
        recuperaciones:   estimatedLLM(ev.recuperaciones, evMeta),
        robos:            evOpt(ev.robos),
        anticipaciones:   evOpt(ev.anticipaciones),
        perdidas:         evOpt(ev.perdidas),
        disparosAlArco:   estimatedLLM(ev.disparosAlArco, evMeta),
        disparosFuera:    estimatedLLM(ev.disparosFuera, evMeta),
      }
    : undefined;

  return {
    totalAcciones,
    totalOfensivas,
    totalDefensivas,
    pases,
    recuperaciones,
    robos,
    anticipaciones,
    perdidas,
    disparos,
    fisicas: fisicasOut,
    performanceRating,
    performanceLabel,
    tieneEventos: Boolean(ev),
    tieneFisicas: Boolean(fis),
    fuente,
    confianza,
    eventMetrics,
  };
}

// ─── Helpers UI (string labels) ───────────────────────────────────────────────

export const RATING_LABEL_ES: Record<OverallLabel, string> = {
  outstanding: "Excepcional",
  excellent: "Excelente",
  good: "Bueno",
  average: "Promedio",
  below: "Por debajo",
};

export const RATING_COLOR: Record<OverallLabel, string> = {
  outstanding: "#10b981", // emerald-500
  excellent: "#22c55e",   // green-500
  good: "#eab308",        // yellow-500
  average: "#f97316",     // orange-500
  below: "#ef4444",       // red-500
};

export const KPI_RATING_LABEL_ES: Record<KpiRating, string> = {
  elite: "Élite",
  excelente: "Excelente",
  bueno: "Bueno",
  aceptable: "Aceptable",
  bajo: "Bajo",
};

export const PHYSICAL_RATING_LABEL_ES: Record<PhysicalRating, string> = {
  elite: "Élite",
  alto: "Alto",
  medio: "Medio",
  bajo: "Bajo",
};
