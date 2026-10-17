/**
 * VITAS · YOLO Tracking — Core Types
 * Tipos base para el sistema de tracking real con YOLOv8n-pose
 */

import type { KalmanLite2D } from "./kalmanLite";
import type { BallDetection } from "./ballDetector";
import type { BallTrack } from "./ballTracker";
import type { TilingConfig } from "./tiling";
import type { RecallConfig } from "./recallConfig";
import type { MetricResult } from "@/lib/metrics/MetricResult";

// Re-export ball types for convenience
export type { BallDetection, BallTrack };

// ─── Coordenadas ──────────────────────────────────────────────────────────────

export interface PixelPoint  { px: number; py: number }
export interface FieldPoint  { fx: number; fy: number }   // metros (0-105, 0-68)
/** Dimensiones de un espacio de píxel (frame del modelo, vídeo nativo, overlay…). Ver coordSpace.ts. */
export interface PixelSpace  { width: number; height: number }

// ─── Keypoints COCO-17 ────────────────────────────────────────────────────────
// 0=nariz 1=ojoIzq 2=ojoDer 3=orejaIzq 4=orejaDer
// 5=hombroIzq 6=hombroDer 7=codoIzq 8=codoDer 9=muñecaIzq 10=muñecaDer
// 11=caderaIzq 12=caderaDer 13=rodillaIzq 14=rodillaDer 15=tobilloIzq 16=tobilloDer

export interface Keypoint {
  x: number;          // píxeles en espacio original del video
  y: number;
  confidence: number; // 0-1
}

// ─── Detección raw de YOLO ────────────────────────────────────────────────────

export interface Detection {
  bbox:       [number, number, number, number]; // [x, y, w, h] en píxeles
  confidence: number;
  keypoints:  Keypoint[];  // 17 keypoints COCO
}

// ─── Track (jugador seguido entre frames) ────────────────────────────────────

export interface FieldPosition {
  fx:          number;
  fy:          number;
  timestampMs: number;
}

export interface Track {
  id:              number;
  bbox:            [number, number, number, number];
  keypoints:       Keypoint[];
  age:             number;       // frames sin match (0 = activo)
  positions:       FieldPosition[];  // historial de posiciones en campo
  lastFieldPos:    FieldPoint | null;
  lastTimestampMs: number;       // timestamp del último frame procesado para este track
  // Métricas calculadas en tiempo real
  speedMs:         number;       // velocidad actual m/s
  smoothSpeedMs:   number;       // velocidad suavizada (EMA)
  accelMs2:        number;       // aceleración m/s²
  distanceM:       number;       // distancia acumulada en metros
  sprintCount:     number;
  // ── Tracking enhancements (optional) ──
  /** Kalman predictor for position smoothing and occlusion handling */
  kalman?:          KalmanLite2D;
  /** HSV color histogram of torso region for re-identification */
  histogram?:       Float32Array;
  /** Stable identity ID (Sprint 4 — Player Re-ID) */
  stableId?:        string;
  /** Jersey/dorsal number from OCR */
  dorsalNumber?:    number;
  /** Team assignment */
  team?:            "home" | "away" | "unknown";
  /** Identity confidence 0-1 */
  identityConfidence?: number;
  /**
   * Cómo se asoció el track a su detección en el ÚLTIMO frame (ByteTrack, #14):
   *  - "iou"        → match fuerte con detección de ALTA confianza (fiable)
   *  - "recovered"  → recuperado con detección de BAJA confianza (2ª etapa; débil)
   *  - "kalman"     → sin detección; sostenido por predicción (más débil)
   *  - "new"        → track recién creado este frame
   *  - "lost"       → NO se asoció ninguna detección este frame (coasting/envejeciendo)
   * Señal para el gate fail-closed de atribución (#24).
   */
  lastMatchKind?: "iou" | "recovered" | "kalman" | "new" | "lost";
  /** Nº de frames asociados por IoU de ALTA confianza (asociación fuerte/fiable). */
  iouMatchCount?: number;
  /** Nº de frames sostenidos por asociación DÉBIL (recovered baja-conf / kalman). */
  weakMatchCount?: number;
  /**
   * Nº de frames en que el track recibió keypoints REALES (`det.keypoints.length > 0`).
   * En la ruta pose normal el postprocess siempre rellena 17 keypoints → siempre > 0.
   * En la ruta detección-primero (recall), un jugador SIEMPRE lejano nunca recibe pose
   * (`keypoints: []` en todos los frames) → queda en 0. Señal para gatear la biomecánica
   * del jugador enfocado (scans y demás derivadas de keypoints): con `poseFrameCount === 0`
   * NO se pudo medir gait → se bloquea, no se emite un 0 (invariante #2, CLAUDE.md).
   */
  poseFrameCount?: number;
}

// ─── Métricas físicas finales ─────────────────────────────────────────────────

export interface IntensityZones {
  walk:     number;  // 0-2 m/s   → metros recorridos
  jog:      number;  // 2-4 m/s
  run:      number;  // 4-5.83 m/s
  sprint:   number;  // >5.83 m/s (>21 km/h)
}

export interface PhysicalMetrics {
  maxSpeedMs:       number;
  avgSpeedMs:       number;
  distanceCoveredM: number;
  sprintCount:      number;
  sprintDistanceM:  number;
  maxAccelMs2:      number;
  intensityZones:   IntensityZones;
  scanCount:        number;
  avgVoronoiAreaM2: number;
  /**
   * ¿La IDENTIDAD del track enfocado fue fiable (asociación mayormente IoU fuerte)?
   * Si es false, estas métricas pudieron acumularse tras un ID-switch → atribuidas al
   * jugador equivocado → NO presentarlas como medidas (gate fail-closed, #24).
   */
  identityReliable?: boolean;
  /**
   * Pista enfocada con la que se calcularon estas métricas; null = sin pista enfocada
   * (agregado de TODAS las pistas ⇒ nada atribuible a un jugador). Quien las atribuye
   * exige que coincida con la pista enfocada ACTUAL (P1 bloque 6b, identidad.md).
   */
  focusTrackId?: number | null;
  /**
   * Duelos como MetricResult: SIEMPRE bloqueado (`duelsMetric()` de
   * src/lib/tracking/duels.ts, P1 bloque 6). Sin criterio validado de qué es un duelo
   * ni de quién lo gana no se cuentan ni se muestran «0G/0P». Ya no existen
   * `duelsWon/duelsLost` (eran siempre 0: el ganador nunca se resolvía).
   */
  duels?: MetricResult<number>;
  /**
   * Velocidad máxima (m/s) como MetricResult (G1). DERIVADA y ORIENTATIVA sin
   * calibración (confidence baja). El pico real (p95 sobre ventana, no el último
   * frame) y el gate por calibración son G2. Valor idéntico al de maxSpeedMs.
   */
  maxSpeed?: MetricResult<number>;
  /**
   * Sprints como MetricResult (G1). DERIVADA y orientativa. Hoy cuenta FRAMES sobre
   * umbral, no eventos (la semántica de eventos es G2). Valor idéntico a sprintCount.
   */
  sprints?: MetricResult<number>;
  /** Velocidad media (m/s) como MetricResult (G1). DERIVADA/orientativa. Valor = avgSpeedMs. */
  avgSpeed?: MetricResult<number>;
  /** Distancia (m) como MetricResult (G1). DERIVADA/orientativa. Valor = distanceCoveredM. */
  distance?: MetricResult<number>;
  /**
   * Espacio/Voronoi de sesión (G1). BLOQUEADO: el Voronoi solo se computa EN VIVO, no
   * se traslada al resumen → avgVoronoiAreaM2 es siempre 0 ("un 0 que significa
   * no-calculado"). Gated en vez de mostrar "0 m²". El cableado real es G7.
   */
  space?: MetricResult<number>;
  /**
   * Escaneos (head-scans) como MetricResult (G1). DERIVADA; indep. de calibración pero
   * depende de identidad + confianza de keypoints (proxy de Jordet NO validado, posibles
   * flips fantasma). Valor = scanCount.
   */
  scans?: MetricResult<number>;
  /**
   * Aceleración máxima (m/s²) como MetricResult (G1). DERIVADA/orientativa; mismo defecto
   * de agregación que velocidad (último frame, no pico) → G2. Valor = maxAccelMs2.
   */
  accel?: MetricResult<number>;
}

// ─── Eventos ──────────────────────────────────────────────────────────────────

export interface ScanEvent {
  trackId:     number;
  timestampMs: number;
  direction:   "left" | "right";
  durationMs:  number;
}

// ─── Voronoi ──────────────────────────────────────────────────────────────────

export interface VoronoiRegion {
  trackId:      number;
  fieldPos:     FieldPoint;
  areaM2:       number;
  pixelPolygon: [number, number][];
}

// ─── Worker messages ──────────────────────────────────────────────────────────

export type WorkerCommand =
  | { type: "INIT";  modelUrl: string; inputSize?: number; tiling?: TilingConfig | null; recall?: RecallConfig | null }
  | { type: "FRAME"; imageData: ImageData; frameIndex: number; timestampMs: number;
      /** Homografía PÍXEL→CAMPO (fila mayor) expresada en `sourceSpace`. */
      homography: number[];
      /**
       * Espacio NATIVO del vídeo (videoWidth×videoHeight). El worker lleva las
       * detecciones del frame (imageData, 640² aplastado) a este espacio antes del
       * tracker. Ausente ⇒ se asume el propio frame (sin reescalado).
       */
      sourceSpace?: PixelSpace }
  | { type: "RESET" }

export type WorkerEvent =
  | { type: "READY" }
  | { type: "PROGRESS"; percent: number; message: string }
  | { type: "RESULT"; frameIndex: number; timestampMs: number;
      /** Espacio de píxel de `tracks` y `personBboxes` (vídeo nativo). */
      trackSpace?: PixelSpace;
      /** Espacio del frame que vio el modelo (imageData). */
      frameSpace?: PixelSpace;
      tracks: Track[]; personBboxes?: Array<{ bbox: [number, number, number, number]; confidence: number }>;
      /**
       * Cobertura de biomecánica del frame (ruta detección-primero): fracción de
       * detecciones con píxeles suficientes para pose. DERIVADA/orientativa. Solo
       * presente cuando el recall está activo. Ver `poseEligibility.ts`.
       */
      poseCoverage?: MetricResult<number> }
  | { type: "ERROR"; message: string }

// ─── Calibración del campo ────────────────────────────────────────────────────

export interface CalibrationAnchor {
  pixel: PixelPoint;
  field: FieldPoint;
}

// Presets de posiciones reales del campo (FIFA standard 105×68m)
export const FIELD_ANCHOR_PRESETS = {
  "full_corners": [
    { field: { fx: 0,    fy: 0  } },  // P1 → esquina sup-izq
    { field: { fx: 105,  fy: 0  } },  // P2 → esquina sup-der
    { field: { fx: 105,  fy: 68 } },  // P3 → esquina inf-der
    { field: { fx: 0,    fy: 68 } },  // P4 → esquina inf-izq
  ],
  "penalty_near": [
    { field: { fx: 0,   fy: 13.84 } },  // P1 → poste izq área
    { field: { fx: 16.5, fy: 13.84 } }, // P2 → borde der área
    { field: { fx: 16.5, fy: 54.16 } }, // P3 → borde der área inf
    { field: { fx: 0,   fy: 54.16 } },  // P4 → poste izq área inf
  ],
  "center_line": [
    { field: { fx: 52.5, fy: 0  } },  // P1 → centro línea sup
    { field: { fx: 105,  fy: 0  } },  // P2 → esquina sup-der
    { field: { fx: 105,  fy: 68 } },  // P3 → esquina inf-der
    { field: { fx: 52.5, fy: 68 } },  // P4 → centro línea inf
  ],
} as const;

export type FieldAnchorPreset = keyof typeof FIELD_ANCHOR_PRESETS;

// ─── Estado del tracking ──────────────────────────────────────────────────────

export type TrackingStatus =
  | "idle"
  | "loading-model"
  | "ready"
  | "tracking"
  | "paused"
  | "complete"
  | "error";

export interface TrackingSession {
  id:              string;
  userId:          string;
  playerId:        string;
  videoId:         string;
  targetTrackId:   number;
  durationMs:      number;
  metrics:         PhysicalMetrics;
  scanEvents:      ScanEvent[];
  calibrationPreset: FieldAnchorPreset;
  createdAt:       string;
  /** Ball track data from Sprint 1 — Ball Tracking */
  ballTrack?:      BallTrack;
}

// ─── Ball Worker messages (Sprint 1) ─────────────────────────────────────────

export type BallWorkerCommand =
  | { type: "INIT"; config?: Record<string, unknown> }
  | { type: "BALL_FRAME"; outputData?: Float32Array; numClasses?: number; imgW: number; imgH: number; modelSize?: number; personBboxes?: Array<{ bbox: [number, number, number, number]; confidence: number }>; homography: number[]; timestampMs: number; frameIndex: number }
  | { type: "RESET" }

export type BallWorkerEvent =
  | { type: "BALL_READY" }
  | { type: "BALL_RESULT"; frameIndex: number; timestampMs: number; ballTrack: BallTrack; detection: BallDetection | null }
  | { type: "BALL_ERROR"; message: string }
