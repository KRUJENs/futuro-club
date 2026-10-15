/**
 * VITAS Advanced Metrics Service
 *
 * Implementa las fórmulas avanzadas del sistema VITAS:
 *   — VAEP / VAEP-90 (stub — requiere datos de eventos de partido)
 *   — DominantFeatures (del perfil de métricas actual)
 *   — SpeedMs, FieldCoverage, SprintCount (stubs — requieren datos GPS/tracking)
 *   — SPADL (stub — requiere stream de eventos)
 *   — BiomechanicsScore (stub — requiere datos cinemáticos)
 *
 * Las fórmulas marcadas como STUB devuelven `null` cuando no tienen
 * datos de entrada reales (tracking, GPS, eventos de partido).
 * Cuando se conecten los datos reales, solo hay que proveer el input correcto.
 */

import type { Player } from "./playerService";
import type { PlayerMetrics } from "./metricsService";
import { enrichActionWithXg } from "@/lib/xg/zoneXg";
import type { XgSummary } from "@/lib/xg/xgAccumulator";
import type { MatchEvent, EventType, EventZone } from "./matchEventsService";
import type { FieldPosition } from "@/lib/yolo/types";

// ─── Tipos de entrada/salida ──────────────────────────────────────────────────

export interface VAEPInput {
  /** Array de acciones SPADL (id, tipo, posX, posY, resultado) */
  actions: SPADLAction[];
  /** Minutos jugados en el partido/muestra */
  minutesPlayed: number;
}

export interface SPADLAction {
  actionId: string;
  type: "pass" | "dribble" | "shot" | "cross" | "tackle" | "interception" | "clearance" | "foul";
  startX: number;   // 0-105 (metros)
  startY: number;   // 0-68 (metros)
  endX: number;
  endY: number;
  result: "success" | "fail";
  /** Probabilidad de gol antes de la acción (xG chain) — requiere modelo externo */
  scoreProbBefore?: number;
  /** Probabilidad de gol después de la acción */
  scoreProbAfter?: number;
  /** Probabilidad de conceder gol antes */
  concedeProbBefore?: number;
  /** Probabilidad de conceder gol después */
  concedeProbAfter?: number;
}

export interface VAEPResult {
  /** Valor total generado en la muestra (suma de deltas) */
  vaepTotal: number | null;
  /** Valor generado por 90 minutos */
  vaep90: number | null;
  /** Acciones con mayor impacto positivo */
  topActions: Array<{ actionId: string; impact: number }>;
  /** Status del cálculo */
  status: "calculated" | "stub_no_data" | "insufficient_data";
  message: string;
}

export interface DominantFeaturesResult {
  /** Top 3 atributos más fuertes */
  dominant: Array<{ key: keyof PlayerMetrics; label: string; value: number; zScore: number; description: string }>;
  /** Top 2 áreas de mejora */
  underdeveloped: Array<{ key: keyof PlayerMetrics; label: string; value: number; gap: number; description: string }>;
  /** Perfil de juego inferido */
  playStyle: "ofensivo" | "defensivo" | "equilibrado" | "técnico" | "físico";
  /** Índice de especialización (0=generalista, 1=muy especializado) */
  specializationIndex: number;
}

export interface TrackingInput {
  /** Array de posiciones GPS (x, y) muestreadas a 25Hz o similar */
  positions: Array<{ x: number; y: number; timestampMs: number }>;
  minutesPlayed: number;
}

export interface TrackingMetricsResult {
  /** Velocidad máxima en m/s */
  maxSpeedMs: number | null;
  /** Velocidad media en m/s */
  avgSpeedMs: number | null;
  /** Distancia total cubierta en metros */
  totalDistanceM: number | null;
  /** Cobertura de campo como % del área total */
  fieldCoveragePct: number | null;
  /** Número de sprints (>6.5 m/s por más de 1s) */
  sprintCount: number | null;
  /** Distancia en sprint (metros) */
  sprintDistanceM: number | null;
  status: "calculated" | "stub_no_data";
  message: string;
}

export interface BiomechanicsInput {
  /** Ángulos articulares capturados por cámara/sensor */
  jointAngles?: Record<string, number[]>;
  /** Fuerza de impacto en cada zancada (Newton) */
  impactForces?: number[];
  /** Asimetría bilateral (%) */
  bilateralAsymmetry?: number;
}

export interface BiomechanicsResult {
  /** Puntuación de eficiencia biomecánica (0-100) */
  drillScore: number | null;
  /** Riesgo de lesión estimado (0-1) */
  injuryRisk: number | null;
  /** Asimetría detectada */
  asymmetryPct: number | null;
  status: "calculated" | "stub_no_data";
  message: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<keyof PlayerMetrics, string> = {
  speed:     "Velocidad",
  technique: "Técnica",
  vision:    "Visión",
  stamina:   "Resistencia",
  shooting:  "Disparo",
  defending: "Defensa",
};

// Media de referencia del grupo normativo VITAS (actualizar con datos reales)
const NORM_MEAN: PlayerMetrics = {
  speed: 60, technique: 58, vision: 55, stamina: 60, shooting: 52, defending: 56,
};
const NORM_SD: PlayerMetrics = {
  speed: 14, technique: 13, vision: 14, stamina: 13, shooting: 15, defending: 14,
};

// ─── VAEP — Valuing Actions by Estimating Probabilities ──────────────────────

export const VAEPService = {
  /**
   * Calcula el VAEP de cada acción si se dispone de probabilidades xG.
   *
   * Fórmula (Decroos et al., 2019):
   *   VAEP(a) = [P(gol_after) - P(gol_before)] - [P(concede_after) - P(concede_before)]
   *
   * Sin acciones → status="stub_no_data". Si las acciones traen probabilidades
   * del proveedor (scoreProb/concedeProb Before/After) se usan tal cual; si no,
   * se derivan con el modelo zone-xG propio (enrichActionWithXg) a partir de las
   * coordenadas, y el status resultante es "calculated" (xG zonal · modelo VITAS).
   */
  calculate(input: VAEPInput): VAEPResult {
    if (!input.actions.length) {
      return {
        vaepTotal: null,
        vaep90: null,
        topActions: [],
        status: "stub_no_data",
        message: "STUB: Se necesitan eventos de partido con probabilidades xG por acción. "
          + "Conectar modelo de valoración de acciones (VAEP/StatsBomb/Wyscout).",
      };
    }

    const hasProbs = input.actions.every(
      (a) => a.scoreProbBefore !== undefined && a.scoreProbAfter !== undefined
        && a.concedeProbBefore !== undefined && a.concedeProbAfter !== undefined
    );

    // Si faltan probabilidades, las derivamos del modelo zone-xG (no proveedor externo).
    // Solo necesitamos coordenadas válidas en el campo para que tenga sentido.
    const enrichedActions = hasProbs
      ? input.actions
      : input.actions.map((a) => {
          const xg = enrichActionWithXg({
            type:   a.type,
            startX: a.startX, startY: a.startY,
            endX:   a.endX,   endY:   a.endY,
            result: a.result,
          });
          return { ...a, ...xg };
        });

    // Cálculo real con probabilidades (originales o derivadas)
    let total = 0;
    const impacts: Array<{ actionId: string; impact: number }> = [];

    for (const action of enrichedActions) {
      const scoreGain   = (action.scoreProbAfter!  - action.scoreProbBefore!);
      const concedeGain = (action.concedeProbAfter! - action.concedeProbBefore!);
      const vaep = scoreGain - concedeGain;
      total += vaep;
      impacts.push({ actionId: action.actionId, impact: Math.round(vaep * 1000) / 1000 });
    }

    impacts.sort((a, b) => b.impact - a.impact);
    const vaep90 = input.minutesPlayed > 0
      ? Math.round((total / input.minutesPlayed * 90) * 1000) / 1000
      : null;

    return {
      vaepTotal: Math.round(total * 1000) / 1000,
      vaep90,
      topActions: impacts.slice(0, 5),
      status: "calculated",
      message: hasProbs
        ? `VAEP calculado sobre ${input.actions.length} acciones (probabilidades del proveedor).`
        : `VAEP calculado sobre ${input.actions.length} acciones (xG zonal · modelo VITAS).`,
    };
  },

  /**
   * Calcula VAEP real desde eventos logueados manualmente por el entrenador.
   * Usa pesos simplificados por tipo de acción y zona del campo.
   */
  calculateFromEvents(events: MatchEvent[], minutesPlayed: number): VAEPResult {
    if (!events.length) {
      return {
        vaepTotal: null,
        vaep90:    null,
        topActions: [],
        status:  "insufficient_data",
        message: "Sin eventos registrados. Usa '+ LOG' para registrar acciones de partido.",
      };
    }

    // Pesos por acción (zona-aware donde aplica)
    //
    // Justificación de pesos VAEP (inspirados en Decroos et al. 2019, adaptados a contexto juvenil):
    //
    // shot_success (0.15): El gol es la acción de mayor impacto en fútbol. 0.15 refleja
    //   que un gol vale ~15% de la victoria esperada en un partido promedio.
    // shot_fail (-0.03): Disparo fallado tiene costo bajo porque al menos indica intención
    //   ofensiva y posición de remate. Penalizar más desincentivaría el disparo en juveniles.
    // pass_success (0.005-0.03 según zona): Pases en zona ofensiva (0.03) valen 6x más que
    //   en zona defensiva (0.005) porque los pases progresivos acercan al gol. Basado en la
    //   distribución de xG por zona: zona ofensiva genera ~60% de las ocasiones.
    // pass_fail (-0.015): Pérdida de balón por pase. Moderadamente penalizado — en juveniles
    //   queremos que arriesguen pases progresivos, no solo jueguen seguro.
    // dribble_success (0.06): Alto valor porque superar a un rival crea superioridad numérica.
    //   En juveniles el 1v1 exitoso es indicador de talento y confianza.
    // dribble_fail (-0.02): Pérdida por regate. Penalización moderada — desincentivar exceso
    //   de regate pero no eliminarlo del repertorio juvenil.
    // tackle_success (0.04): Recuperación activa de balón. Valor significativo porque inicia
    //   transición ofensiva y demuestra capacidad defensiva.
    // tackle_fail (-0.015): Tackle fallado deja al equipo en desventaja momentánea.
    // press_success (0.025): Pressing efectivo que genera recuperación. Indicador de
    //   inteligencia táctica y disciplina colectiva.
    // press_fail (-0.005): Pressing fallido tiene costo mínimo — queremos fomentar pressing
    //   activo en juveniles, aunque no siempre resulte.
    // cross_success (0.08): Centro que conecta con compañero. Alto valor porque genera
    //   ocasión directa desde zona lateral.
    // cross_fail (-0.02): Centro perdido. Costo de perder posesión en zona ofensiva.
    // header_success (0.05): Juego aéreo ganado. Depende de maduración pero cuando conecta
    //   genera peligro directo.
    // header_fail (-0.01): Duelo aéreo perdido. Penalización baja porque en juveniles la
    //   estatura es función de la maduración, no del talento.
    //
    type EventKey = `${EventType}_${"success" | "fail"}`;
    type ZoneKey  = EventZone | "default";
    const W: Record<EventKey, number | Record<ZoneKey, number>> = {
      "shot_success":     0.15,
      "shot_fail":       -0.03,
      "pass_success":    { offensive: 0.03, middle: 0.01, defensive: 0.005, default: 0.01 },
      "pass_fail":       -0.015,
      "dribble_success":  0.06,
      "dribble_fail":    -0.02,
      "tackle_success":   0.04,
      "tackle_fail":     -0.015,
      "press_success":    0.025,
      "press_fail":      -0.005,
      "cross_success":    0.08,
      "cross_fail":      -0.02,
      "header_success":   0.05,
      "header_fail":     -0.01,
    };

    const resolveW = (type: EventType, result: "success" | "fail", zone?: EventZone): number => {
      const key = `${type}_${result}` as EventKey;
      const entry = W[key];
      if (typeof entry === "number") return entry;
      return zone ? (entry[zone] ?? entry["default"]) : entry["default"];
    };

    let total = 0;
    const impacts: Array<{ actionId: string; impact: number }> = [];

    for (const evt of events) {
      const impact = resolveW(evt.type, evt.result, evt.xZone);
      total += impact;
      impacts.push({ actionId: evt.id, impact: Math.round(impact * 1000) / 1000 });
    }

    impacts.sort((a, b) => b.impact - a.impact);

    const vaep90 = minutesPlayed > 0
      ? Math.round((total / minutesPlayed) * 90 * 1000) / 1000
      : null;

    return {
      vaepTotal:  Math.round(total * 1000) / 1000,
      vaep90,
      topActions: impacts.slice(0, 5),
      status:     "calculated",
      message:    `VAEP calculado desde ${events.length} evento(s) registrados manualmente.`,
    };
  },

  /**
   * Genera stubs vacíos para la UI mientras no haya datos reales.
   */
  getStub(minutesPlayed: number): VAEPResult {
    return {
      vaepTotal: null,
      vaep90: null,
      topActions: [],
      status: "stub_no_data",
      message: `STUB — ${minutesPlayed} min jugados registrados. `
        + "En espera de integración con proveedor de datos de eventos (StatsBomb / Wyscout / InStat).",
    };
  },
};

// ─── Dominant Features — desde métricas actuales ─────────────────────────────

// Descripciones contextuales por metrica y nivel de z-score
const DOMINANT_DESCRIPTIONS: Record<keyof PlayerMetrics, { high: string; veryHigh: string }> = {
  speed:     { high: "Rapidez superior al promedio, capaz de ganar carreras largas", veryHigh: "Velocidad excepcional, desborda rivales con facilidad" },
  technique: { high: "Buen control de balon y primer toque limpio", veryHigh: "Tecnica depurada, manejo de balon de alto nivel" },
  vision:    { high: "Lee bien el juego y encuentra pases entre lineas", veryHigh: "Vision de juego privilegiada, genera oportunidades constantemente" },
  stamina:   { high: "Buena capacidad fisica para mantener ritmo alto", veryHigh: "Resistencia excepcional, rinde al maximo los 90 minutos" },
  shooting:  { high: "Disparo preciso y buena definicion", veryHigh: "Finalizacion de elite, peligroso en cualquier situacion de gol" },
  defending: { high: "Solido en duelos defensivos y anticipacion", veryHigh: "Muro defensivo, domina duelos aereos y terrestres" },
};

const UNDERDEVELOPED_DESCRIPTIONS: Record<keyof PlayerMetrics, { low: string; veryLow: string }> = {
  speed:     { low: "Puede mejorar transiciones rapidas y arranques cortos", veryLow: "Prioridad: trabajo de velocidad y potencia explosiva" },
  technique: { low: "Necesita pulir control orientado y regate", veryLow: "Requiere trabajo intensivo en fundamentos tecnicos" },
  vision:    { low: "Puede mejorar lectura de juego y toma de decisiones", veryLow: "Necesita ejercicios de situacion y juego posicional" },
  stamina:   { low: "Puede mejorar capacidad aerobica y recuperacion", veryLow: "Prioridad: plan de acondicionamiento fisico progresivo" },
  shooting:  { low: "Puede mejorar definicion y seleccion de disparo", veryLow: "Requiere sesiones especificas de finalizacion" },
  defending: { low: "Puede mejorar posicionamiento defensivo y tackle", veryLow: "Necesita trabajo en principios defensivos basicos" },
};

function getDominantDescription(key: keyof PlayerMetrics, zScore: number): string {
  const descs = DOMINANT_DESCRIPTIONS[key];
  return zScore >= 1.5 ? descs.veryHigh : descs.high;
}

function getUnderdevelopedDescription(key: keyof PlayerMetrics, zScore: number): string {
  const descs = UNDERDEVELOPED_DESCRIPTIONS[key];
  return zScore <= -1.5 ? descs.veryLow : descs.low;
}

export const DominantFeaturesService = {
  /**
   * Infiere las características dominantes del jugador a partir de sus métricas.
   * Usa z-scores sobre normas del grupo para identificar outliers positivos y negativos.
   *
   * No requiere datos externos — funciona con los métricas ya disponibles.
   */
  calculate(metrics: PlayerMetrics): DominantFeaturesResult {
    const keys = Object.keys(metrics) as (keyof PlayerMetrics)[];

    // Z-scores
    const zScores = keys.map((k) => ({
      key: k,
      label: METRIC_LABELS[k],
      value: metrics[k],
      zScore: (metrics[k] - NORM_MEAN[k]) / NORM_SD[k],
    }));

    zScores.sort((a, b) => b.zScore - a.zScore);

    const dominant = zScores.slice(0, 3).map((item) => ({
      ...item,
      description: getDominantDescription(item.key, item.zScore),
    }));
    const underdeveloped = zScores.slice(-2).map((item) => ({
      ...item,
      gap: Math.round((NORM_MEAN[item.key] - item.value) * 10) / 10,
      description: getUnderdevelopedDescription(item.key, item.zScore),
    }));

    // Clasificar estilo de juego
    const offensiveAvg = (metrics.technique + metrics.vision + metrics.shooting) / 3;
    const defensiveAvg = (metrics.defending + metrics.stamina) / 2;
    const physicalAvg  = (metrics.speed + metrics.stamina) / 2;

    let playStyle: DominantFeaturesResult["playStyle"];
    if (offensiveAvg > 72 && offensiveAvg > defensiveAvg + 10) playStyle = "ofensivo";
    else if (defensiveAvg > 72 && defensiveAvg > offensiveAvg + 10) playStyle = "defensivo";
    else if (metrics.technique > 72 && metrics.vision > 68) playStyle = "técnico";
    else if (physicalAvg > 72) playStyle = "físico";
    else playStyle = "equilibrado";

    // Índice de especialización: varianza normalizada de los z-scores
    const meanZ = zScores.reduce((s, z) => s + z.zScore, 0) / zScores.length;
    const variance = zScores.reduce((s, z) => s + Math.pow(z.zScore - meanZ, 2), 0) / zScores.length;
    const specializationIndex = Math.min(1, Math.round(Math.sqrt(variance) / 2 * 100) / 100);

    return {
      dominant,
      underdeveloped,
      playStyle,
      specializationIndex,
    };
  },
};

// ─── Tracking Metrics — GPS / Positional Data ────────────────────────────────

export const TrackingService = {
  /**
   * Calcula métricas de tracking desde datos GPS.
   *
   * STUB: Sin datos GPS, devuelve null en todos los campos.
   * Para activar: proveer array positions[] con x, y, timestampMs
   * capturado desde dispositivo GPS (Catapult, STATSports, etc.) o
   * desde video tracking (Roboflow Keypoints).
   */
  calculate(input: TrackingInput | null): TrackingMetricsResult {
    if (!input || !input.positions.length) {
      return {
        maxSpeedMs: null,
        avgSpeedMs: null,
        totalDistanceM: null,
        fieldCoveragePct: null,
        sprintCount: null,
        sprintDistanceM: null,
        status: "stub_no_data",
        message: "STUB: En espera de datos de tracking GPS o video-tracking por keypoints. "
          + "Analiza un video en VITAS Lab con MediaPipe Pose para activar.",
      };
    }

    const { positions, minutesPlayed } = input;
    if (positions.length < 2) {
      return {
        maxSpeedMs: null, avgSpeedMs: null, totalDistanceM: null,
        fieldCoveragePct: null, sprintCount: null, sprintDistanceM: null,
        status: "stub_no_data",
        message: "Datos insuficientes — se necesitan al menos 2 puntos GPS.",
      };
    }

    // Calcular distancias y velocidades
    let totalDist = 0;
    let maxSpeed = 0;
    let sprintCount = 0;
    let sprintDist = 0;
    const speeds: number[] = [];
    const SPRINT_THRESHOLD_MS = 6.5;
    const SPRINT_MIN_DURATION_MS = 1000; // 1 segundo mínimo
    let currentSprintMs = 0;
    let currentSprintDist = 0;
    let inSprint = false;

    for (let i = 1; i < positions.length; i++) {
      const dt = (positions[i].timestampMs - positions[i-1].timestampMs) / 1000; // segundos
      if (dt <= 0) continue;

      const dx = positions[i].x - positions[i-1].x;
      const dy = positions[i].y - positions[i-1].y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const speed = dist / dt; // m/s

      totalDist += dist;
      speeds.push(speed);
      if (speed > maxSpeed) maxSpeed = speed;

      // Detección de sprints
      if (speed >= SPRINT_THRESHOLD_MS) {
        if (!inSprint) inSprint = true;
        currentSprintMs += dt * 1000;
        currentSprintDist += dist;
      } else if (inSprint) {
        if (currentSprintMs >= SPRINT_MIN_DURATION_MS) {
          sprintCount++;
          sprintDist += currentSprintDist;
        }
        inSprint = false;
        currentSprintMs = 0;
        currentSprintDist = 0;
      }
    }
    // Cerrar sprint activo al final
    if (inSprint && currentSprintMs >= SPRINT_MIN_DURATION_MS) {
      sprintCount++;
      sprintDist += currentSprintDist;
    }

    const avgSpeed = speeds.length
      ? speeds.reduce((a, b) => a + b, 0) / speeds.length
      : 0;

    // Campo de fútbol 11: 105m x 68m = 7140 m²
    // Dividir en cuadrícula 5x5 metros → 21x13 = 273 celdas
    const CELL = 5;
    const COLS = Math.ceil(105 / CELL);
    const ROWS = Math.ceil(68 / CELL);
    const visited = new Set<number>();
    for (const p of positions) {
      const col = Math.floor(Math.min(p.x, 104.9) / CELL);
      const row = Math.floor(Math.min(p.y, 67.9) / CELL);
      visited.add(col * ROWS + row);
    }
    const fieldCoveragePct = Math.round((visited.size / (COLS * ROWS)) * 100 * 10) / 10;

    return {
      maxSpeedMs: Math.round(maxSpeed * 100) / 100,
      avgSpeedMs: Math.round(avgSpeed * 100) / 100,
      totalDistanceM: Math.round(totalDist),
      fieldCoveragePct,
      sprintCount,
      sprintDistanceM: Math.round(sprintDist),
      status: "calculated",
      message: `Tracking calculado desde ${positions.length} muestras GPS (${minutesPlayed} min).`,
    };
  },

  /**
   * Convierte posiciones de YOLO tracking (FieldPosition[]) al formato TrackingInput.
   * Esto permite alimentar el cálculo GPS-like con datos del tracker de video.
   *
   * @param positions — Historial de posiciones del YOLO tracker (fx, fy en metros)
   * @param minutesPlayed — Duración del tracking en minutos
   */
  fromYoloPositions(positions: FieldPosition[], minutesPlayed: number): TrackingInput {
    return {
      positions: positions.map(p => ({
        x: p.fx,
        y: p.fy,
        timestampMs: p.timestampMs,
      })),
      minutesPlayed,
    };
  },
};

// ─── Biomechanics / Drill Score ───────────────────────────────────────────────

export const BiomechanicsService = {
  /**
   * Calcula la puntuación biomecánica de un ejercicio.
   *
   * STUB: Sin datos cinemáticos (cámara calibrada o sensores IMU), devuelve null.
   * Para activar: conectar Roboflow Pose Estimation (17 keypoints COCO) y
   * calcular ángulos articulares de cadera, rodilla y tobillo.
   */
  calculate(input: BiomechanicsInput | null): BiomechanicsResult {
    if (!input || (!input.jointAngles && !input.impactForces && input.bilateralAsymmetry === undefined)) {
      return {
        drillScore: null,
        injuryRisk: null,
        asymmetryPct: null,
        status: "stub_no_data",
        message: "STUB: En espera de datos cinemáticos. "
          + "Analiza un video en VITAS Lab con MediaPipe Pose para obtener "
          + "ángulos articulares y calcular DrillScore biomecánico.",
      };
    }

    const asymmetry = input.bilateralAsymmetry ?? 0;
    const injuryRisk = Math.min(1, Math.round(asymmetry / 100 * 2 * 100) / 100);

    let drillScore = 75; // baseline
    if (asymmetry < 5)  drillScore = 90;
    else if (asymmetry < 10) drillScore = 80;
    else if (asymmetry < 20) drillScore = 65;
    else drillScore = 50;

    return {
      drillScore,
      injuryRisk,
      asymmetryPct: asymmetry,
      status: "calculated",
      message: `DrillScore calculado. Asimetría bilateral: ${asymmetry.toFixed(1)}%.`,
    };
  },
};

// ─── Facade: calcular todas las métricas avanzadas de un jugador ──────────────

// Sin RAE / UBI / TruthFilter / «VSI ajustado» (P1 bloque 6, punto 22): nadie pasaba la
// fecha de nacimiento (RAE siempre null ⇒ el UBI contaba la edad relativa como 0), sus
// pesos y correcciones no tenían fuente, y leían la FASE PHV como ritmo de maduración.
// El trimestre de nacimiento vive ahora en src/lib/shared/relativeAge.ts (única
// implementación). El VSI ajustado por maduración es SOLO el del motor PHV (inv #4).
export interface AdvancedPlayerMetrics {
  /** null si el jugador no tiene métricas del entrenador (sin evaluar) */
  dominantFeatures: DominantFeaturesResult | null;
  vaep:             VAEPResult;
  tracking:         TrackingMetricsResult;
  biomechanics:     BiomechanicsResult;
}

export function calculateAdvancedMetrics(
  player: Player,
  options?: {
    trackingInput?: TrackingInput;
    vaepInput?: VAEPInput;
    biomechanicsInput?: BiomechanicsInput;
  }
): AdvancedPlayerMetrics {
  // Dominant Features (funciona con datos existentes, independiente de PHV).
  // Sin métricas del entrenador (jugador no evaluado) ⇒ null: no se infieren
  // características dominantes de la nada (invariante #2), y evita Object.keys(undefined).
  const dominantFeatures = player.metrics
    ? DominantFeaturesService.calculate(player.metrics)
    : null;

  // VAEP stub
  const vaep = options?.vaepInput
    ? VAEPService.calculate(options.vaepInput)
    : VAEPService.getStub(player.minutesPlayed);

  // Tracking stub
  const tracking = TrackingService.calculate(options?.trackingInput ?? null);

  // Biomechanics stub
  const biomechanics = BiomechanicsService.calculate(options?.biomechanicsInput ?? null);

  return {
    dominantFeatures,
    vaep,
    tracking,
    biomechanics,
  };
}
