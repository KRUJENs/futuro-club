/**
 * Cableado del gate fail-closed de atribución (#24) en computeSessionMetrics.
 * Verifica que el flag identityReliable de las métricas de sesión refleja la
 * fiabilidad de la identidad de los track(s) enfocados: sin identidad fiable, las
 * métricas por-jugador NO deben presentarse como medidas (VitasLab las omite del LLM).
 */

import { describe, it, expect } from "vitest";
import { computeSessionMetrics } from "@/hooks/useTracking";
import type { Track, FieldPosition, ScanEvent } from "@/lib/yolo/types";

function mkTrack(id: number, iou: number, weak: number): Track {
  return {
    id,
    bbox: [0, 0, 20, 40],
    keypoints: [],
    age: 0,
    positions: [],
    lastFieldPos: null,
    lastTimestampMs: 0,
    speedMs: 3,
    smoothSpeedMs: 3,
    accelMs2: 0,
    distanceM: 10,
    sprintCount: 1,
    iouMatchCount: iou,
    weakMatchCount: weak,
  };
}

describe("computeSessionMetrics — gate identityReliable (#24)", () => {
  it("identityReliable=true cuando el track enfocado tiene identidad fiable (IoU fuerte)", () => {
    const m = computeSessionMetrics([mkTrack(1, 8, 1)], 1, []);
    expect(m.identityReliable).toBe(true);
  });

  it("identityReliable=false cuando el track enfocado es sostenido por asociación débil", () => {
    const m = computeSessionMetrics([mkTrack(1, 3, 5)], 1, []);
    expect(m.identityReliable).toBe(false);
  });

  it("identityReliable=false si el track no tiene suficientes matches (aún sin probar)", () => {
    const m = computeSessionMetrics([mkTrack(1, 2, 0)], 1, []);
    expect(m.identityReliable).toBe(false);
  });

  it("sin track enfocado (agregado): fiable solo si TODOS los tracks lo son (fail-closed)", () => {
    const allReliable = computeSessionMetrics([mkTrack(1, 8, 1), mkTrack(2, 6, 2)], null, []);
    expect(allReliable.identityReliable).toBe(true);
    const oneWeak = computeSessionMetrics([mkTrack(1, 8, 1), mkTrack(2, 3, 5)], null, []);
    expect(oneWeak.identityReliable).toBe(false);
  });

  it("sin tracks → EMPTY_METRICS con identityReliable=false (nunca fail-open)", () => {
    const m = computeSessionMetrics([], 1, []);
    expect(m.identityReliable).toBe(false);
  });
});

describe("computeSessionMetrics — Voronoi de sesión (G7)", () => {
  it("space = DERIVADA orientativa con la media de las muestras del jugador enfocado", () => {
    const samples = new Map<number, number[]>([[1, [50, 70, 60]]]); // media = 60
    const m = computeSessionMetrics([mkTrack(1, 8, 1)], 1, [], samples);
    expect(m.space.value).toBeCloseTo(60, 5);
    expect(m.space.provenance).toBe("DERIVADA");
    expect(m.space.calibrated).toBe(false); // depende de homografía → orientativo, nunca MEDIDA
    expect(m.avgVoronoiAreaM2).toBeCloseTo(60, 5);
  });

  it("space = gated (value null, no 0) cuando el jugador enfocado no tiene muestras", () => {
    const m = computeSessionMetrics([mkTrack(1, 8, 1)], 1, [], new Map());
    expect(m.space.value).toBeNull();
    expect(m.space.gate_reason).toBeTruthy();
    expect(m.avgVoronoiAreaM2).toBe(0);
  });

  it("solo promedia las muestras del jugador enfocado, no las de otros tracks", () => {
    const samples = new Map<number, number[]>([[1, [40]], [2, [999]]]);
    const m = computeSessionMetrics([mkTrack(1, 8, 1)], 1, [], samples);
    expect(m.space.value).toBeCloseTo(40, 5);
  });
});

/** Track con un perfil de velocidad dado (m/s por paso a 8 fps): construye las
 *  posiciones de campo cuya distancia por paso produce esas velocidades. */
function trackWithSpeedProfile(id: number, speedsMs: number[]): Track {
  const dt = 0.125; // 8 fps
  let fx = 0;
  const positions: FieldPosition[] = [{ fx: 0, fy: 0, timestampMs: 0 }];
  speedsMs.forEach((v, i) => {
    fx += v * dt;
    positions.push({ fx, fy: 0, timestampMs: (i + 1) * 125 });
  });
  return { ...mkTrack(id, 8, 1), positions };
}

describe("computeSessionMetrics — velocidad máx = pico de sesión, no último frame (G2)", () => {
  it("captura la ráfaga del medio aunque el clip acabe lento (bug de agregación G1)", () => {
    // Lento, RÁFAGA a 8 m/s en el medio, lento al final.
    const speeds = [...Array(30).fill(0.5), ...Array(10).fill(8), ...Array(30).fill(0.5)];
    const m = computeSessionMetrics([trackWithSpeedProfile(1, speeds)], 1, []);
    expect(m.maxSpeedMs).toBeGreaterThan(5);   // captura el pico (~8), no el final (~0.5)
    expect(m.maxSpeedMs).toBeLessThanOrEqual(8.1);
  });

  it("p95 rechaza un único spike de jitter (no domina el máximo)", () => {
    const speeds = [...Array(50).fill(3), 40]; // 50 muestras a 3 + 1 spike irreal
    const m = computeSessionMetrics([trackWithSpeedProfile(1, speeds)], 1, []);
    expect(m.maxSpeedMs).toBeLessThan(5);      // ~3, el spike (clampeado + outlier) no manda
  });

  it("sin posiciones (posible en tests) → velocidad 0, no lanza", () => {
    const m = computeSessionMetrics([mkTrack(1, 8, 1)], 1, []);
    expect(m.maxSpeedMs).toBe(0);
  });
});

describe("computeSessionMetrics — sprints = EVENTOS, no frames (G2)", () => {
  it("un sprint continuo de 2 s a 8 m/s cuenta como 1 (no ~16 frames)", () => {
    const speeds = Array(16).fill(8); // 16 pasos × 0.125 s = 2 s continuos
    const m = computeSessionMetrics([trackWithSpeedProfile(1, speeds)], 1, []);
    expect(m.sprintCount).toBe(1);
  });

  it("un pico breve (< duración mínima) NO cuenta como sprint", () => {
    const speeds = Array(4).fill(8); // 0.5 s < 1 s → 0
    const m = computeSessionMetrics([trackWithSpeedProfile(1, speeds)], 1, []);
    expect(m.sprintCount).toBe(0);
  });

  it("dos sprints separados por trote cuentan como 2", () => {
    const speeds = [...Array(16).fill(8), ...Array(16).fill(0.5), ...Array(16).fill(8)];
    const m = computeSessionMetrics([trackWithSpeedProfile(1, speeds)], 1, []);
    expect(m.sprintCount).toBe(2);
  });
});

/** ScanEvent mínimo para un trackId dado. */
function mkScan(trackId: number, timestampMs: number): ScanEvent {
  return { trackId, timestampMs, direction: "left", durationMs: 120 };
}

describe("computeSessionMetrics — scans BLOQUEADO si el enfocado nunca fue medible (invariante #2)", () => {
  it("jugador SIEMPRE lejano (poseFrameCount=0): scans gated, NO derived(0)", () => {
    // Ruta recall: el enfocado es solo-posición → su biomecánica nunca se midió.
    // focusScans vacío no significa "0 escaneos medidos", significa "no medible".
    const track: Track = { ...mkTrack(1, 8, 1), poseFrameCount: 0 };
    const m = computeSessionMetrics([track], 1, []);
    expect(m.scans?.value).toBeNull();
    expect(m.scans?.provenance).not.toBe("MEDIDA"); // nunca presentado como medida
    expect(m.scans?.gate_reason).toBeTruthy();       // gate_reason no vacío (contrato)
    expect(m.scans?.gate_reason).toContain("no medible");
  });

  it("jugador con frames de pose (poseFrameCount>0) pero 0 escaneos: scans derived(0) honesto", () => {
    // Aquí SÍ se pudo mirar la biomecánica y no se detectó ningún escaneo → 0 real.
    const track: Track = { ...mkTrack(1, 8, 1), poseFrameCount: 5 };
    const m = computeSessionMetrics([track], 1, []);
    expect(m.scans?.value).toBe(0);
    expect(m.scans?.provenance).toBe("DERIVADA");
    expect(m.scans?.gate_reason).toBeNull();
  });

  it("jugador con frames de pose y escaneos detectados: scans derived con el conteo", () => {
    const track: Track = { ...mkTrack(1, 8, 1), poseFrameCount: 10 };
    const scans = [mkScan(1, 100), mkScan(1, 400), mkScan(1, 900)];
    const m = computeSessionMetrics([track], 1, scans);
    expect(m.scans?.value).toBe(3);
    expect(m.scans?.provenance).toBe("DERIVADA");
  });

  it("agregado (sin enfoque): si algún track tuvo pose, scans NO se bloquea", () => {
    const far: Track = { ...mkTrack(1, 8, 1), poseFrameCount: 0 };
    const near: Track = { ...mkTrack(2, 8, 1), poseFrameCount: 4 };
    const m = computeSessionMetrics([far, near], null, [mkScan(2, 100)]);
    expect(m.scans?.value).toBe(1);
  });
});

describe("computeSessionMetrics — duelos SIEMPRE bloqueados (P1 bloque 6)", () => {
  it("sin duelsWon/duelsLost y duels = null + motivo canónico (con y sin sesión)", async () => {
    const { DUELS_GATE_REASON } = await import("@/lib/tracking/duels");
    for (const m of [computeSessionMetrics([mkTrack(1, 8, 1)], 1, []), computeSessionMetrics([], 1, [])]) {
      expect(m).not.toHaveProperty("duelsWon");
      expect(m).not.toHaveProperty("duelsLost");
      expect(m.duels?.value).toBeNull();
      expect(m.duels?.gate_reason).toBe(DUELS_GATE_REASON);
    }
  });
});
