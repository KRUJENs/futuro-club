/**
 * E2E (funciones puras) del pipeline fÃ­sico del Lab: calibraciÃ³n del Lab â†’ homografÃ­a
 * que envÃ­a useTracking â†’ paso del worker (640Â²â†’nativo + tracker) â†’ mÃ©tricas en metros.
 *
 * RegresiÃ³n del bug: useTracking enviaba la matriz CAMPOâ†’PÃXEL de computeHomography
 * como si fuera PÃXELâ†’CAMPO, y el worker proyectaba cajas del frame 640Â² aplastado con
 * una homografÃ­a en pÃ­xeles nativos â†’ posiciones fuera del campo, descartadas â†’
 * distancia/velocidad/sprints a 0 ("orientativo").
 *
 * AquÃ­ un punto de pÃ­xel CONOCIDO se sigue por la misma ruta que usa el worker
 * (`trackFrameDetections`) y debe caer DENTRO del campo en metros; un jugador que
 * recorre 5 m en 1 s debe dar â‰ˆ 5 m y â‰ˆ 18 km/h.
 */

import { describe, it, expect } from "vitest";
import {
  calibrationFromPercentPoints,
  fieldToPixelIn,
  pixelToFieldIn,
} from "@/lib/yolo/coordSpace";
import { computeHomography, buildAnchors, fieldToPixel } from "@/lib/yolo/homography";
import { CentroidTracker, trackFrameDetections } from "@/lib/yolo/tracker";
import { BallTracker } from "@/lib/yolo/ballTracker";
import { computeSessionMetrics } from "@/hooks/useTracking";
import { FIELD_ANCHOR_PRESETS, type Detection, type Keypoint, type PixelSpace } from "@/lib/yolo/types";

const FRAME: PixelSpace = { width: 640, height: 640 };      // lo que ve el modelo
const NATIVE: PixelSpace = { width: 1920, height: 1080 };   // el vÃ­deo
const CORNERS_PCT = [
  { x: 25, y: 30 },
  { x: 75, y: 30 },
  { x: 95, y: 90 },
  { x: 5, y: 90 },
];
const calib = calibrationFromPercentPoints(CORNERS_PCT, FIELD_ANCHOR_PRESETS.full_corners)!;
// Lo que useTracking manda al worker en cada FRAME (homography + sourceSpace).
const H_SENT = pixelToFieldIn(calib, NATIVE);
const H_FIELD2NATIVE = fieldToPixelIn(calib, NATIVE);

const PLAYER_H_NATIVE = 120; // px de alto del jugador en el vÃ­deo nativo
const PLAYER_W_NATIVE = 40;

/**
 * DetecciÃ³n en espacio FRAME (640Â², como la devuelve el modelo) de un jugador cuyos
 * PIES estÃ¡n en (fx, fy) metros. Se construye pasando por pÃ­xeles nativos, igual que
 * se verÃ­a en el vÃ­deo real, y aplastando a 640Â² como hace frameExtractor.
 */
function frameDetectionAt(fx: number, fy: number): Detection {
  const foot = fieldToPixel(H_FIELD2NATIVE, fx, fy); // pÃ­xel nativo de los pies
  const sx = FRAME.width / NATIVE.width;
  const sy = FRAME.height / NATIVE.height;
  const w = PLAYER_W_NATIVE * sx;
  const h = PLAYER_H_NATIVE * sy;
  const keypoints: Keypoint[] = Array.from({ length: 17 }, () => ({ x: foot.px * sx, y: foot.py * sy - h / 2, confidence: 0.9 }));
  return {
    bbox: [foot.px * sx - w / 2, foot.py * sy - h, w, h],
    confidence: 0.9,
    keypoints,
  };
}

describe("pipeline fÃ­sico del Lab â€” punto conocido â†’ metros dentro del campo", () => {
  it("un jugador en el centro del campo sale en (52.5, 34) m por la ruta del worker", () => {
    const tracker = new CentroidTracker();
    const { tracks, detections } = trackFrameDetections(
      tracker, [frameDetectionAt(52.5, 34)], FRAME, NATIVE, H_SENT, 0,
    );
    expect(tracks).toHaveLength(1);
    const pos = tracks[0].lastFieldPos!;
    expect(pos.fx).toBeCloseTo(52.5, 6);
    expect(pos.fy).toBeCloseTo(34, 6);
    // â€¦y la caja que sale del worker estÃ¡ en pÃ­xeles NATIVOS (no en 640Â²).
    const foot = fieldToPixel(H_FIELD2NATIVE, 52.5, 34);
    const [bx, by, bw, bh] = detections[0].bbox;
    expect(bx + bw / 2).toBeCloseTo(foot.px, 6);
    expect(by + bh).toBeCloseTo(foot.py, 6);
    expect(bh).toBeCloseTo(PLAYER_H_NATIVE, 6);
    expect(tracks[0].bbox).toEqual(detections[0].bbox);
  });

  it("puntos repartidos por todo el campo caen dentro del campo (no se descartan)", () => {
    for (const [fx, fy] of [[5, 5], [100, 5], [100, 63], [5, 63], [30, 50], [80, 20]]) {
      const tracker = new CentroidTracker();
      const { tracks } = trackFrameDetections(tracker, [frameDetectionAt(fx, fy)], FRAME, NATIVE, H_SENT, 0);
      const pos = tracks[0].lastFieldPos!;
      expect(pos.fx).toBeCloseTo(fx, 6);
      expect(pos.fy).toBeCloseTo(fy, 6);
    }
  });

  it("5 m en 1 s â†’ â‰ˆ 5 m recorridos y â‰ˆ 18 km/h; asociaciÃ³n IoU estable (Kalman/umbrales en metros)", () => {
    const tracker = new CentroidTracker();
    const FPS = 8;
    const T0 = 1000; // ms de vídeo (el tracker trata t=0 como "sin timestamp previo")
    let tracks = trackFrameDetections(tracker, [frameDetectionAt(50, 34)], FRAME, NATIVE, H_SENT, T0).tracks;
    const id = tracks[0].id;
    for (let k = 1; k <= FPS; k++) {
      tracks = trackFrameDetections(
        tracker, [frameDetectionAt(50 + (5 * k) / FPS, 34)], FRAME, NATIVE, H_SENT, T0 + (k * 1000) / FPS,
      ).tracks;
    }
    expect(tracks).toHaveLength(1);
    const t = tracks[0];
    expect(t.id).toBe(id);                  // sin ID-switch
    expect(t.lastMatchKind).toBe("iou");
    expect(t.distanceM).toBeCloseTo(5, 6);
    expect(t.speedMs * 3.6).toBeCloseTo(18, 6);
    expect(t.lastFieldPos!.fx).toBeCloseTo(55, 6);

    // AgregaciÃ³n de sesiÃ³n: mismos metros, y SIGUE etiquetada como orientativa
    // (DERIVADA, calibrated:false) â€” el fix no relaja ningÃºn gate de calibraciÃ³n.
    const m = computeSessionMetrics(tracks, id, []);
    expect(m.distance?.value).toBeCloseTo(5, 6);
    expect((m.maxSpeed?.value ?? 0) * 3.6).toBeCloseTo(18, 6);
    expect((m.avgSpeed?.value ?? 0) * 3.6).toBeCloseTo(18, 6);
    expect(m.distance?.provenance).toBe("DERIVADA");
    expect(m.distance?.calibrated).toBe(false);
    expect(m.maxSpeed?.calibrated).toBe(false);
  });

  it("un sprint de 7 m/s durante 1.5 s cuenta como 1 evento de sprint (â‰ˆ 25 km/h)", () => {
    const tracker = new CentroidTracker();
    const FPS = 8;
    const T0 = 1000;
    let tracks = trackFrameDetections(tracker, [frameDetectionAt(30, 40)], FRAME, NATIVE, H_SENT, T0).tracks;
    const frames = 12; // 1.5 s
    for (let k = 1; k <= frames; k++) {
      tracks = trackFrameDetections(
        tracker, [frameDetectionAt(30 + (7 * k) / FPS, 40)], FRAME, NATIVE, H_SENT, T0 + (k * 1000) / FPS,
      ).tracks;
    }
    const m = computeSessionMetrics(tracks, tracks[0].id, []);
    expect(m.sprints?.value).toBe(1);
    expect((m.maxSpeed?.value ?? 0) * 3.6).toBeCloseTo(25.2, 6);
  });

  it("balÃ³n: detectado en espacio FRAME + homografÃ­a materializada en FRAME â†’ mismos metros", () => {
    const foot = fieldToPixel(H_FIELD2NATIVE, 70, 30);
    const cx = foot.px * (FRAME.width / NATIVE.width);
    const cy = foot.py * (FRAME.height / NATIVE.height);
    const ball = new BallTracker();
    const bt = ball.update(
      { bbox: [cx - 3, cy - 3, 6, 6], confidence: 0.8, center: { x: cx, y: cy }, source: "model" },
      pixelToFieldIn(calib, FRAME),
      1000,
    );
    expect(bt.fieldPos!.fx).toBeCloseTo(70, 6);
    expect(bt.fieldPos!.fy).toBeCloseTo(30, 6);
  });
});

describe("guardas de regresiÃ³n del bug original", () => {
  it("la matriz de computeHomography (CAMPOâ†’PÃXEL) NO sirve como pÃ­xelâ†’campo: deja al jugador fuera del campo", () => {
    // ComposiciÃ³n antigua de useTracking: computeHomography con 1280Ã—720 por defecto,
    // enviada tal cual al worker, y cajas del frame 640Â² sin reescalar.
    const oldH = computeHomography(
      buildAnchors(CORNERS_PCT, FIELD_ANCHOR_PRESETS.full_corners as unknown as Array<{ field: { fx: number; fy: number } }>, 1280, 720),
    );
    const tracker = new CentroidTracker();
    tracker.update([frameDetectionAt(52.5, 34)], oldH, 0);
    const tracks = tracker.update([frameDetectionAt(53, 34)], oldH, 125);
    // Con la matriz equivocada el segundo frame no pasa el sanity-check de campo â†’
    // no se acumula distancia (el "0 orientativo" que veÃ­a el usuario).
    expect(tracks[0].distanceM).toBe(0);
    expect(tracks[0].positions).toHaveLength(1);
  });

  it("sin reescalar 640Â²â†’nativo, la MISMA homografÃ­a correcta da metros equivocados", () => {
    const det = frameDetectionAt(52.5, 34);
    const tracker = new CentroidTracker();
    // Error de espacio: cajas del frame con la homografÃ­a nativa.
    const tr = tracker.update([det], H_SENT, 0)[0];
    const wrong = tr.lastFieldPos!;
    expect(Math.hypot(wrong.fx - 52.5, wrong.fy - 34)).toBeGreaterThan(10);
  });
});
