/**
 * E2E caja negra: useTracking (hook REAL) → trackingWorker (worker REAL: preprocess,
 * postprocess YOLO, decode letterbox, tracker) → useTracking → métricas de sesión.
 *
 * Solo se falsean los bordes que no existen en jsdom: onnxruntime (una sesión cuyo
 * output es UNA persona en coords del frame 640²), el FrameExtractor (entrega frames
 * 640×640 como el real) y el transporte Worker (el worker real corre en este hilo).
 *
 * Reproduce el bug de producción: con la calibración del Lab, un jugador que recorre
 * 5 m en 1 s debe aparecer DENTRO del campo en metros, con ≈5 m y ≈18 km/h. Antes el
 * hook enviaba la matriz CAMPO→PÍXEL como píxel→campo y el worker proyectaba cajas
 * 640² con una homografía en píxeles nativos → fuera del campo → físicas a 0.
 *
 * Solo usa API pública que ya existía (hook + protocolo del worker + homography) para
 * poder demostrar ROJO sobre el código anterior y VERDE con el fix.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTracking } from "@/hooks/useTracking";
import { buildAnchors, computeHomography, fieldToPixel } from "@/lib/yolo/homography";
import { FIELD_ANCHOR_PRESETS, type PhysicalMetrics } from "@/lib/yolo/types";

// ── onnxruntime-web falso: el modelo "ve" una persona en `ort.box` (cx,cy,w,h en 640²)
// `modelScale` = inputSize del modelo / 640: el modelo real emite coords en SU espacio
// de entrada (letterbox del frame 640²); el worker lo deshace con decodeYoloBox.
// `kps` (opcional): 17×[x, y, conf] en coords 640² (null → keypoints a 0, conf 0).
const ort = vi.hoisted(() => ({
  box: [0, 0, 0, 0] as number[],
  modelScale: 1,
  kps: null as null | Array<[number, number, number]>,
}));
vi.mock("onnxruntime-web", () => {
  const CHANNELS = 56; // 4 bbox + 1 conf + 17×3 keypoints (YOLOv8/11-pose)
  const ANCHORS = 8400;
  class Tensor {
    type: string;
    data: Float32Array;
    dims: number[];
    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const session = {
    inputNames: ["images"],
    outputNames: ["output0"],
    run: async () => {
      const data = new Float32Array(CHANNELS * ANCHORS);
      const [cx, cy, w, h] = ort.box.map((v) => v * ort.modelScale);
      data[0 * ANCHORS] = cx;
      data[1 * ANCHORS] = cy;
      data[2 * ANCHORS] = w;
      data[3 * ANCHORS] = h;
      data[4 * ANCHORS] = 0.9;
      ort.kps?.forEach(([kx, ky, kc], k) => {
        data[(5 + k * 3 + 0) * ANCHORS] = kx * ort.modelScale;
        data[(5 + k * 3 + 1) * ANCHORS] = ky * ort.modelScale;
        data[(5 + k * 3 + 2) * ANCHORS] = kc;
      });
      return { output0: { data } };
    },
  };
  return { env: { wasm: {} }, Tensor, InferenceSession: { create: async () => session } };
});

// ── FrameExtractor falso: captura onFrame para entregar frames 640×640 a mano
const extractor = vi.hoisted(() => ({
  onFrame: null as null | ((imageData: ImageData, timestampMs: number) => void),
}));
vi.mock("@/lib/yolo/frameExtractor", () => ({
  FrameExtractor: class {
    start(cfg: { onFrame: (imageData: ImageData, timestampMs: number) => void }) {
      extractor.onFrame = cfg.onFrame;
    }
    stop() {}
  },
  buildBunnyCdnUrl: () => "",
}));

// ── Transporte Worker: el trackingWorker REAL corre en este hilo ──────────────────
type Msg = { type: string; [k: string]: unknown };
const workerOut: Msg[] = [];
const workerIn: Msg[] = [];

class BridgeWorker {
  static last: BridgeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  pending: Promise<void> = Promise.resolve();
  constructor() {
    BridgeWorker.last = this;
  }
  postMessage(msg: Msg) {
    workerIn.push(msg);
    if (msg.type === "INIT") ort.modelScale = ((msg.inputSize as number | undefined) ?? FRAME) / FRAME;
    this.pending = this.pending.then(async () => {
      const handler = (self as unknown as { onmessage: (e: { data: Msg }) => Promise<void> }).onmessage;
      await handler({ data: msg });
      for (const ev of workerOut.splice(0)) this.onmessage?.({ data: ev } as MessageEvent);
    });
  }
  terminate() {}
}

// ── Escena: vídeo 1920×1080, esquinas del campo calibradas en % del frame ─────────
const NATIVE_W = 1920;
const NATIVE_H = 1080;
const FRAME = 640;
const CORNERS_PCT = [
  { x: 25, y: 30 },
  { x: 75, y: 30 },
  { x: 95, y: 90 },
  { x: 5, y: 90 },
];
// Verdad de terreno CAMPO→PÍXEL NATIVO (API antigua, independiente del fix).
const H_FIELD2NATIVE = computeHomography(
  buildAnchors(
    CORNERS_PCT,
    FIELD_ANCHOR_PRESETS.full_corners as unknown as Array<{ field: { fx: number; fy: number } }>,
    NATIVE_W,
    NATIVE_H,
  ),
);
const PLAYER_W = 40;  // px nativos
const PLAYER_H = 120;

/** Pone al "modelo" a ver un jugador con los pies en (fx, fy) m, en coords 640². */
function modelSeesPlayerAt(fx: number, fy: number): { px: number; py: number } {
  const foot = fieldToPixel(H_FIELD2NATIVE, fx, fy);
  const sx = FRAME / NATIVE_W;
  const sy = FRAME / NATIVE_H;
  const w = PLAYER_W * sx;
  const h = PLAYER_H * sy;
  ort.box = [foot.px * sx, foot.py * sy - h / 2, w, h];
  return foot;
}

const fakeVideo = {
  readyState: 4,
  src: "blob:test",
  error: null,
  videoWidth: NATIVE_W,
  videoHeight: NATIVE_H,
  currentTime: 0,
  crossOrigin: null,
  play: () => Promise.resolve(),
  pause: () => {},
  load: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as HTMLVideoElement;

const frame640 = {
  width: FRAME,
  height: FRAME,
  data: new Uint8ClampedArray(FRAME * FRAME * 4),
} as unknown as ImageData;

let originalPostMessage: typeof window.postMessage;

beforeAll(async () => {
  vi.stubGlobal("Worker", BridgeWorker);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    })),
  );
  originalPostMessage = window.postMessage;
  // `send()` del worker hace self.postMessage(evento) → lo capturamos.
  (window as unknown as { postMessage: (m: Msg) => void }).postMessage = (m: Msg) => {
    workerOut.push(m);
  };
  await import("@/workers/trackingWorker"); // registra self.onmessage (worker real)
});

afterAll(() => {
  window.postMessage = originalPostMessage;
  vi.unstubAllGlobals();
});

describe("useTracking + trackingWorker — pipeline físico en metros (E2E)", () => {
  it("un jugador que recorre 5 m en 1 s queda dentro del campo: ≈5 m y ≈18 km/h", async () => {
    const { result } = renderHook(() =>
      useTracking({
        videoId: "v1",
        playerId: "p1",
        calibrationPoints: CORNERS_PCT,
        anchorPreset: "full_corners",
        localVideoSrc: "blob:test",
        enableBallTracking: false,
        enableReId: false,
      }),
    );

    await act(async () => {
      await result.current.startTracking(fakeVideo);
    });
    expect(extractor.onFrame).toBeTypeOf("function");

    const T0 = 1000; // ms de vídeo
    const FPS = 8;
    let lastFoot = { px: 0, py: 0 };
    for (let k = 0; k <= FPS; k++) {
      lastFoot = modelSeesPlayerAt(50 + (5 * k) / FPS, 34);
      await act(async () => {
        extractor.onFrame!(frame640, T0 + (k * 1000) / FPS);
        await BridgeWorker.last!.pending;
      });
    }

    const tracks = result.current.state.currentTracks;
    expect(tracks).toHaveLength(1);
    const t = tracks[0];

    // 1) Metros DENTRO del campo, en el punto esperado (antes: fuera → descartado).
    expect(t.lastFieldPos).not.toBeNull();
    expect(t.lastFieldPos!.fx).toBeCloseTo(55, 2);
    expect(t.lastFieldPos!.fy).toBeCloseTo(34, 2);

    // 2) Plausibilidad física: 5 m en 1 s ≈ 18 km/h.
    expect(t.distanceM).toBeCloseTo(5, 2);
    expect(t.speedMs * 3.6).toBeCloseTo(18, 1);

    // 3) Las cajas que llegan a la UI están en píxeles NATIVOS (no en el 640²).
    const [bx, by, bw, bh] = t.bbox;
    expect(bx + bw / 2).toBeCloseTo(lastFoot.px, 1);
    expect(by + bh).toBeCloseTo(lastFoot.py, 1);
    expect(bh).toBeCloseTo(PLAYER_H, 1);

    // 4) Sesión: mismos metros y SIGUE orientativa (DERIVADA, calibrated:false):
    //    el fix no relaja ningún gate de calibración.
    let metrics: PhysicalMetrics | null = null;
    act(() => {
      metrics = result.current.stopTracking();
    });
    const m = metrics as unknown as PhysicalMetrics;
    expect(m.distance?.value).toBeCloseTo(5, 2);
    expect((m.maxSpeed?.value ?? 0) * 3.6).toBeCloseTo(18, 1);
    expect(m.distance?.provenance).toBe("DERIVADA");
    expect(m.distance?.calibrated).toBe(false);
    expect(m.maxSpeed?.calibrated).toBe(false);

    // Contrato del mensaje FRAME: homografía + espacio nativo explícito.
    const frameMsg = workerIn.filter((msg) => msg.type === "FRAME").pop()!;
    expect(frameMsg.sourceSpace).toEqual({ width: NATIVE_W, height: NATIVE_H });
  });
});

// ── PoseAnalyzer: umbrales en px evaluados en el FRAME, no en el nativo ───────────
// El escaneo exige |nariz − punto medio de las orejas| > 8 px. Ese umbral siempre se
// evaluó sobre el frame 640² del modelo. Si el analizador recibiera cajas NATIVAS, el
// mismo gesto daría distinto nº de escaneos según la resolución de la cámara (a 4K el
// umbral sería ~6× más laxo). Mismo clip (en coords del frame) a 720p y a 4K → mismo
// `scans`.

/** Pose en coords 640² con la nariz desplazada `noseOffsetPx` respecto al medio de las orejas. */
function headPose(noseOffsetPx: number): Array<[number, number, number]> {
  const kps: Array<[number, number, number]> = Array.from({ length: 17 }, () => [320, 300, 0]);
  kps[0] = [320 + noseOffsetPx, 275, 0.9]; // nariz
  kps[3] = [314, 275, 0.9];                // oreja izq
  kps[4] = [326, 275, 0.9];                // oreja der
  kps[5] = [312, 285, 0.9];                // hombro izq
  kps[6] = [328, 285, 0.9];                // hombro der
  return kps;
}

/**
 * Corre por el pipeline REAL (hook → worker → hook) un clip de 9 frames: 3 con la
 * cabeza girada a un lado (+offset), 3 al otro (−offset) y 3 de frente → 2 escaneos
 * si el offset supera el umbral del analizador, 0 si no.
 */
async function scansForClip(nativeW: number, nativeH: number, noseOffsetFramePx: number) {
  const video = { ...fakeVideo, videoWidth: nativeW, videoHeight: nativeH } as unknown as HTMLVideoElement;
  const { result, unmount } = renderHook(() =>
    useTracking({
      videoId: "v-scan",
      playerId: "p1",
      calibrationPoints: CORNERS_PCT,
      anchorPreset: "full_corners",
      localVideoSrc: "blob:test",
      enableBallTracking: false,
      enableReId: false,
    }),
  );
  await act(async () => {
    await result.current.startTracking(video);
    // El tracker del worker es de módulo: se reinicia para no arrastrar pistas previas.
    BridgeWorker.last!.postMessage({ type: "RESET" });
    await BridgeWorker.last!.pending;
  });

  ort.box = [320, 300, 20, 60];
  const offsets = [1, 1, 1, -1, -1, -1, 0, 0, 0].map((s) => s * noseOffsetFramePx);
  for (let k = 0; k < offsets.length; k++) {
    ort.kps = headPose(offsets[k]);
    await act(async () => {
      extractor.onFrame!(frame640, 1000 + k * 125);
      await BridgeWorker.last!.pending;
    });
  }

  const scanEvents = result.current.state.scanEvents.length;
  // Escaneos solo atribuibles a una pista ENFOCADA (P1 bloque 6b): se enfoca la única pista.
  const onlyTrack = result.current.state.currentTracks[0]?.id ?? null;
  expect(onlyTrack).not.toBeNull();
  let metrics: PhysicalMetrics | null = null;
  act(() => {
    result.current.setFocusTrackId(onlyTrack);
    metrics = result.current.stopTracking();
  });
  ort.kps = null;
  unmount();
  return { scanEvents, scans: (metrics as unknown as PhysicalMetrics).scans };
}

describe("useTracking — PoseAnalyzer independiente de la resolución del vídeo", () => {
  it("un giro de cabeza por debajo del umbral (5 px en el frame) no cuenta como escaneo ni a 720p ni a 4K", async () => {
    const hd = await scansForClip(1280, 720, 5);
    const uhd = await scansForClip(3840, 2160, 5);
    // Antes del fix: 5 px de frame = 10 px nativos a 720p y 30 px a 4K (> 8) → 2 escaneos.
    expect(hd.scanEvents).toBe(0);
    expect(uhd.scanEvents).toBe(0);
    expect(hd.scans?.value).toBe(0);
    expect(uhd.scans?.value).toBe(0);
  });

  it("un giro claro (12 px en el frame) da los mismos 2 escaneos a 720p y a 4K", async () => {
    const hd = await scansForClip(1280, 720, 12);
    const uhd = await scansForClip(3840, 2160, 12);
    expect(hd.scanEvents).toBe(2);
    expect(uhd.scanEvents).toBe(2);
    // Sigue siendo DERIVADA orientativa (no se relaja ningún gate).
    expect(uhd.scans?.provenance).toBe("DERIVADA");
    expect(uhd.scans?.calibrated).toBe(false);
  });
});
