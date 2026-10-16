/**
 * VITAS · Scanning Video Detector — BLOQUEADO para vídeo real (P1 bloque 6b, punto 9).
 *
 * Antes había dos modos y ninguno medía nada atribuible a un jugador:
 *   - «REAL» (MediaPipe en el navegador): detectaba giros de cabeza de CUALQUIER persona
 *     del plano (sin identidad del jugador), INVENTABA las recepciones (una cada ~4 s,
 *     entre 8 y 35), fijaba las tasas de éxito (0,65 / 0,45) y la orientación (0,65), y
 *     lo guardaba rotulado «Vídeo real».
 *   - «MOCK»: valores derivados del id del jugador y del vídeo (hash), también para
 *     vídeos reales cuando MediaPipe fallaba.
 *
 * Ahora:
 *   - vídeo real ⇒ `ScanningGatedError` con el motivo canónico de Scan IQ (no se analiza
 *     ni se guarda nada);
 *   - SOLO en el demo y SOLO con un partido demo ⇒ el ejemplo FIJO de
 *     `SCAN_IQ_DEMO_EXAMPLE` (el mismo para todos, procedencia MOCK, exige banner).
 * Los análisis guardados antes en `localStorage` (`vitas_scanning_video_analyses`) no se
 * leen fuera del demo (limpieza → bloque 7).
 */
import { IS_DEMO } from "@/lib/demoMode";
import { SCAN_IQ_GATE_REASON } from "@/lib/dmscore/scanIQ";
import { SCAN_IQ_DEMO_EXAMPLE } from "@/lib/dmscore/scanIQExample";

const STORAGE_KEY = "vitas_scanning_video_analyses";

/** Partidos demo del diálogo de escaneo: los únicos que generan el ejemplo. */
export const SCANNING_DEMO_VIDEO_PREFIX = "demo_scan_";

export function isDemoScanningVideo(videoId: string): boolean {
  return videoId.startsWith(SCANNING_DEMO_VIDEO_PREFIX);
}

/** Error de abstención: el análisis de escaneo no se hace (con su motivo). */
export class ScanningGatedError extends Error {
  readonly gate_reason: string;
  constructor(gate_reason: string) {
    super(gate_reason);
    this.name = "ScanningGatedError";
    this.gate_reason = gate_reason;
  }
}

export interface ScanningAnalysisResult {
  id: string;
  playerId: string;
  playerName: string;
  videoId: string;
  videoTitle: string;
  /** Scan IQ del EJEMPLO (0-100). Nunca medido. */
  scanIQ: number;
  receptionsAnalyzed: number;
  avgScansPreReception: number;
  scansUnderPressure: number;
  successWithScan: number; // 0-1
  successWithoutScan: number; // 0-1
  forwardOrientedPct: number;
  createdAt: string;
  /** Siempre "mock" (ejemplo del demo). "real" solo aparece en análisis antiguos guardados. */
  source?: "real" | "mock";
}

export interface ScanningDetectionProgress {
  stage: "loading" | "finished";
  pct: number;
  message: string;
}

export type ScanningDetectionListener = (p: ScanningDetectionProgress) => void;

function readAll(): ScanningAnalysisResult[] {
  // Fuera del demo no se lee nada guardado: los análisis antiguos (incluidos los
  // «real» de MediaPipe con recepciones inventadas) no se pintan (bloque 7).
  if (!IS_DEMO) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScanningAnalysisResult[];
    // En el demo solo cuenta el ejemplo fijo (procedencia MOCK).
    return Array.isArray(parsed) ? parsed.filter((a) => a?.source === "mock") : [];
  } catch {
    return [];
  }
}

function writeAll(items: ScanningAnalysisResult[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error("[scanningVideoDetector] write failed", err);
  }
}

function genId(): string {
  return `scan_analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** El ejemplo FIJO del demo para un jugador (mismos valores para todos; MOCK). */
function demoExample(
  options: { playerId: string; playerName: string; videoId: string; videoTitle: string },
): ScanningAnalysisResult {
  return {
    id: genId(),
    playerId: options.playerId,
    playerName: options.playerName,
    videoId: options.videoId,
    videoTitle: options.videoTitle,
    ...SCAN_IQ_DEMO_EXAMPLE,
    source: "mock",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Análisis de escaneo de un vídeo. Vídeo real (o fuera del demo) ⇒ `ScanningGatedError`.
 * Partido demo en el demo ⇒ el ejemplo fijo (MOCK), guardado para la página.
 */
export async function runScanningDetection(
  options: { playerId: string; playerName: string; videoId: string; videoTitle: string },
  onProgress?: ScanningDetectionListener,
): Promise<ScanningAnalysisResult> {
  if (!IS_DEMO || !isDemoScanningVideo(options.videoId)) {
    throw new ScanningGatedError(SCAN_IQ_GATE_REASON);
  }
  onProgress?.({ stage: "loading", pct: 50, message: "" });
  const result = demoExample(options);
  writeAll([result, ...readAll()].slice(0, 50));
  onProgress?.({ stage: "finished", pct: 100, message: "" });
  return result;
}

export const ScanningVideoAnalyses = {
  getAll: readAll,
  getByPlayer(playerId: string): ScanningAnalysisResult[] {
    return readAll().filter((a) => a.playerId === playerId);
  },
  getLatestForPlayer(playerId: string): ScanningAnalysisResult | null {
    const list = this.getByPlayer(playerId);
    return list.length > 0 ? list[0] : null;
  },
  delete(id: string): void {
    writeAll(readAll().filter((a) => a.id !== id));
  },

  /**
   * Ejemplo del DEMO para ver la página sin analizar un partido: el ejemplo FIJO (MOCK),
   * el mismo para todos los jugadores (nada derivado del id). Fuera del demo ⇒ null.
   * No duplica si el jugador ya tiene uno.
   */
  seedDemo(playerId: string, playerName: string): ScanningAnalysisResult | null {
    if (!IS_DEMO) return null;
    const existing = this.getLatestForPlayer(playerId);
    if (existing) return existing;
    const result = demoExample({
      playerId,
      playerName,
      videoId: `${SCANNING_DEMO_VIDEO_PREFIX}example`,
      videoTitle: "Partido de demo",
    });
    writeAll([result, ...readAll()]);
    return result;
  },
};
