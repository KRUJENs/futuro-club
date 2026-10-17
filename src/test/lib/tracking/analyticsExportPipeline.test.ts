/**
 * #22: el export debe REGISTRAR si la calibración era fiable en TODOS los formatos
 * (no solo en algunos). Si no, coordenadas/velocidades en metros son estimaciones en
 * píxeles, y el consumidor (Excel/pandas, EPTS/SPADL, informe HTML/PDF) las tomaría
 * como medidas → fallo silencioso.
 */

import { describe, it, expect } from "vitest";
import { AnalyticsExporter, type SessionExportData } from "@/lib/tracking/analyticsExportPipeline";

function makeData(calibrationReliable: boolean): SessionExportData {
  return {
    metadata: {
      sessionId: "s1",
      playerId: "p1",
      playerName: "Test",
      videoId: null,
      date: "2026-08-10",
      durationSec: 60,
      trackingFps: 8,
      fieldDimensions: { lengthM: 105, widthM: 68 },
      calibrationReliable,
    },
    physicalMetrics: { maxSpeedMs: 8, distanceCoveredM: 5000, sprintCount: 3 } as unknown as SessionExportData["physicalMetrics"],
    biomechanics: null,
    tracks: [],
    focusTrackId: 1,
    events: [],
    eventSummary: {} as unknown as SessionExportData["eventSummary"],
    scanEvents: [],
    focusPositions: [
      { fx: 10, fy: 20, tMs: 0 },
      { fx: 12, fy: 22, tMs: 125 },
    ],
  };
}

describe("AnalyticsExporter — provenance de calibración en TODOS los formatos (#22)", () => {
  it("calibración NO fiable → aviso/flag en STS, SPADL, JSON, Metrica, CSV y HTML", () => {
    const exp = new AnalyticsExporter(makeData(false));
    expect(exp.toSTS()).toContain("calibration NOT reliable");
    expect(JSON.parse(exp.toSPADL()).metadata.calibration_reliable).toBe(false);
    expect(JSON.parse(exp.toJSON()).metadata.calibrationReliable).toBe(false);
    expect(JSON.parse(exp.toMetrica()).calibration_reliable).toBe(false);
    // CSV: columna presente en la cabecera + valor por fila.
    const csv = exp.toCSV();
    expect(csv.split("\n")[0]).toContain("calibration_reliable");
    expect(csv).toContain(",false");
    // HTML/PDF: banner de aviso visible.
    expect(exp.toHTMLReport()).toContain("Calibración no fiable");
  });

  it("calibración fiable → sin aviso y flags en true", () => {
    const exp = new AnalyticsExporter(makeData(true));
    expect(exp.toSTS()).not.toContain("calibration NOT reliable");
    expect(JSON.parse(exp.toSPADL()).metadata.calibration_reliable).toBe(true);
    expect(JSON.parse(exp.toMetrica()).calibration_reliable).toBe(true);
    expect(exp.toCSV().split("\n")[0]).toContain("calibration_reliable");
    expect(exp.toCSV()).toContain(",true");
    expect(exp.toHTMLReport()).not.toContain("Calibración no fiable");
  });
});

describe("AnalyticsExporter — duelos bloqueados (P1 bloque 6)", () => {
  it("JSON: duels = null + motivo canónico; ninguna clave duelsWon/duelEvents", async () => {
    const { DUELS_GATE_REASON } = await import("@/lib/tracking/duels");
    const json = JSON.parse(new AnalyticsExporter(makeData(true)).toJSON());
    expect(json.duels.value).toBeNull();
    expect(json.duels.gate_reason).toBe(DUELS_GATE_REASON);
    expect(JSON.stringify(json)).not.toMatch(/duelsWon|duelsLost|duelEvents|duelCount/);
  });

  it("HTML: la tarjeta de duelos pinta el motivo, nunca «0G» / «0P»", async () => {
    const { DUELS_GATE_REASON } = await import("@/lib/tracking/duels");
    const html = new AnalyticsExporter(makeData(true)).toHTMLReport();
    expect(html).toContain(DUELS_GATE_REASON);
    expect(html).not.toMatch(/\b0G\b|\b0P\b/);
  });
});
