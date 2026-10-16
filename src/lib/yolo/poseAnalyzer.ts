/**
 * VITAS · Pose Analyzer
 *
 * Detecta eventos de escaneo (giro de cabeza) a partir de los keypoints COCO-17
 * de YOLOv8n-pose. Sin duelos (P1 bloque 6): contaba cualquier par de pistas a
 * ≤ 1,8 m —compañeros incluidos— y nunca resolvía el ganador; el concepto vive
 * bloqueado en src/lib/tracking/duels.ts.
 *
 * COCO keypoints:
 *   0=nariz  1=ojoIzq  2=ojoDer  3=orejaIzq  4=orejaDer
 *   5=hombroIzq  6=hombroDer  11=caderaIzq  12=caderaDer
 */

import type { Track, ScanEvent, Keypoint } from "./types";

const SCAN_ANGLE_THRESH   = 28;   // grados — diferencia de ángulo para detectar escaneo
const SCAN_MIN_FRAMES     = 2;    // frames mínimos para confirmar escaneo
const KP_CONF_THRESH      = 0.3;  // confianza mínima de keypoint

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface ScanState {
  direction: "left" | "right" | null;
  framesCount: number;
  startMs: number;
}

// ─── Analyzer ─────────────────────────────────────────────────────────────────

export class PoseAnalyzer {
  private scanStates  = new Map<number, ScanState>();

  /** Accumulated scan counts per track ID — Sprint 14: used by ParticipationTracker */
  private scanCounts  = new Map<number, number>();
  /** Accumulated scan events — Sprint 17: exported for BPE ScanningIntelligenceDetector */
  private accumulatedScans: ScanEvent[] = [];

  analyzeTracks(
    tracks:      Track[],
    timestampMs: number,
    fps:         number
  ): { scans: ScanEvent[] } {
    const newScans: ScanEvent[] = [];

    // ── Escaneo por jugador ───────────────────────────────────────────────────
    for (const track of tracks) {
      const scan = detectScanDirection(track.keypoints);

      let state = this.scanStates.get(track.id);
      if (!state) {
        state = { direction: null, framesCount: 0, startMs: timestampMs };
        this.scanStates.set(track.id, state);
      }

      if (scan && scan === state.direction) {
        state.framesCount++;
      } else if (scan && scan !== state.direction) {
        // Nueva dirección de escaneo
        if (state.framesCount >= SCAN_MIN_FRAMES && state.direction) {
          const scanEvent: ScanEvent = {
            trackId:     track.id,
            timestampMs: state.startMs,
            direction:   state.direction,
            durationMs:  timestampMs - state.startMs,
          };
          newScans.push(scanEvent);
          this.accumulatedScans.push(scanEvent);
          this.scanCounts.set(track.id, (this.scanCounts.get(track.id) ?? 0) + 1);
        }
        state.direction  = scan;
        state.framesCount = 1;
        state.startMs    = timestampMs;
      } else {
        // Sin escaneo — cerrar si había uno en curso
        if (state.framesCount >= SCAN_MIN_FRAMES && state.direction) {
          const scanEvent: ScanEvent = {
            trackId:     track.id,
            timestampMs: state.startMs,
            direction:   state.direction,
            durationMs:  timestampMs - state.startMs,
          };
          newScans.push(scanEvent);
          this.accumulatedScans.push(scanEvent);
          this.scanCounts.set(track.id, (this.scanCounts.get(track.id) ?? 0) + 1);
        }
        state.direction  = null;
        state.framesCount = 0;
      }
    }

    // Limpiar tracks que ya no están activos
    const activeIds = new Set(tracks.map(t => t.id));
    for (const id of this.scanStates.keys()) {
      if (!activeIds.has(id)) this.scanStates.delete(id);
    }

    return { scans: newScans };
  }

  /**
   * Get accumulated scan count for a specific track ID.
   * Sprint 14: Used by ParticipationTracker for per-player scanning metrics.
   */
  getTrackScanCount(trackId: number): number {
    return this.scanCounts.get(trackId) ?? 0;
  }

  /**
   * Get all accumulated scan counts as a Map.
   * Sprint 14: Convenience method for batch participation tracking.
   */
  getAllScanCounts(): Map<number, number> {
    return new Map(this.scanCounts);
  }

  /**
   * Get all accumulated scan events.
   * Sprint 17: Used by BPE ScanningIntelligenceDetector for
   * correlating scans with decision quality.
   */
  getAccumulatedScans(): ScanEvent[] {
    return [...this.accumulatedScans];
  }

  reset(): void {
    this.scanStates.clear();
    this.scanCounts.clear();
    this.accumulatedScans = [];
  }
}

// ─── Detectar dirección de escaneo desde keypoints ───────────────────────────

function detectScanDirection(keypoints: Keypoint[]): "left" | "right" | null {
  if (keypoints.length < 17) return null;

  const nose      = keypoints[0];
  const earLeft   = keypoints[3];
  const earRight  = keypoints[4];
  const shoulderL = keypoints[5];
  const shoulderR = keypoints[6];

  // Verificar confianza mínima
  if (nose.confidence < KP_CONF_THRESH) return null;
  if (shoulderL.confidence < KP_CONF_THRESH || shoulderR.confidence < KP_CONF_THRESH) return null;

  // Vector eje del cuerpo (hombros)
  const bodyAngle = Math.atan2(
    shoulderR.y - shoulderL.y,
    shoulderR.x - shoulderL.x
  ) * (180 / Math.PI);

  // Asymmetría de orejas: si orejaIzq más visible → mirando a la derecha
  const leftEarVisible  = earLeft.confidence  > KP_CONF_THRESH;
  const rightEarVisible = earRight.confidence > KP_CONF_THRESH;

  if (leftEarVisible && !rightEarVisible) {
    // Solo se ve oreja izquierda → cara apuntando a la derecha
    return "right";
  }
  if (rightEarVisible && !leftEarVisible) {
    // Solo se ve oreja derecha → cara apuntando a la izquierda
    return "left";
  }

  // Ambas orejas visibles → calcular asimetría por posición de nariz
  if (leftEarVisible && rightEarVisible) {
    const earMidX = (earLeft.x + earRight.x) / 2;
    const noseOffset = nose.x - earMidX;
    if (Math.abs(noseOffset) > 8) { // píxeles
      return noseOffset > 0 ? "right" : "left";
    }
  }

  return null;
}
