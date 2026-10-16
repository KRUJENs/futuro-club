/**
 * VITAS · Analytics Export Pipeline (Tracking 10/10)
 *
 * Exports tracking + event + biomechanics data to industry-standard formats
 * for external tools, scouting platforms, and data analysis.
 *
 * Supported formats:
 *   - JSON: Full VITAS data model (import/export)
 *   - CSV: Tabular tracking data for Excel/Sheets/Python
 *   - SPADL: Soccer Player Action Description Language (for xG/VAEP models)
 *   - STS: FIFA EPTS Standard Tracking System format
 *   - Metrica: Metrica Sports compatible format
 *   - PDF summary: Human-readable session report (HTML → print)
 *
 * Usage:
 *   const exporter = new AnalyticsExporter(sessionData);
 *   const csv = exporter.toCSV();
 *   const blob = exporter.download("csv", "session_2026-05-19");
 */

import type { Track, PhysicalMetrics, ScanEvent } from "@/lib/yolo/types";
import type { BiomechanicsScore } from "@/lib/mediapipe/biomechanicsEngine";
import type { TacticalEvent, EventSummary } from "./eventDetectionEngine";
import { PUBLIC_HOST } from "@/lib/publicUrl";
import { duelsMetric, DUELS_GATE_REASON } from "./duels";

/* ── Types ─────────────────────────────────────────────────────── */

export type ExportFormat = "json" | "csv" | "spadl" | "sts" | "metrica" | "html_report";

export interface SessionExportData {
  /** Session metadata */
  metadata: {
    sessionId: string;
    playerId: string;
    playerName: string;
    videoId: string | null;
    date: string;
    durationSec: number;
    trackingFps: number;
    fieldDimensions: { lengthM: number; widthM: number };
    /**
     * ¿La calibración px→m era fiable? Si es false, TODAS las coordenadas y métricas
     * en metros de este export son ORIENTATIVAS (píxeles disfrazados), no medidas.
     * Se registra para que el consumidor downstream (EPTS/SPADL) no las tome como
     * datos calibrados. Ver #22.
     */
    calibrationReliable: boolean;
  };
  /** Physical metrics summary */
  physicalMetrics: PhysicalMetrics;
  /** Biomechanics score */
  biomechanics: BiomechanicsScore | null;
  /** All tracks with positions */
  tracks: Track[];
  /** Focus player track ID */
  focusTrackId: number | null;
  /** Tactical events */
  events: TacticalEvent[];
  /** Event summary — null si no hay (antes un resumen de CEROS que se leía como «0 pases») */
  eventSummary: EventSummary | null;
  /** Scan events */
  scanEvents: ScanEvent[];
  /** Focus player positions for heatmap */
  focusPositions: Array<{ fx: number; fy: number; tMs: number }>;
}

export interface ExportOptions {
  /** Include raw track positions (can be large) */
  includeRawTracks?: boolean;
  /** Include keypoint data per frame */
  includeKeypoints?: boolean;
  /** Include biomechanics joint details */
  includeJointDetails?: boolean;
  /** Decimate positions (keep every Nth point, default: 1 = all) */
  positionDecimation?: number;
  /** Custom filename */
  filename?: string;
}

/* ── Analytics Exporter ───────────────────────────────────────── */

export class AnalyticsExporter {
  private data: SessionExportData;

  constructor(data: SessionExportData) {
    this.data = data;
  }

  /** Export to specified format as string */
  export(format: ExportFormat, options: ExportOptions = {}): string {
    switch (format) {
      case "json":    return this.toJSON(options);
      case "csv":     return this.toCSV(options);
      case "spadl":   return this.toSPADL();
      case "sts":     return this.toSTS(options);
      case "metrica": return this.toMetrica(options);
      case "html_report": return this.toHTMLReport();
      default:        return this.toJSON(options);
    }
  }

  /** Download as file */
  download(format: ExportFormat, options: ExportOptions = {}): void {
    const content = this.export(format, options);
    const ext = format === "html_report" ? "html" : format === "json" ? "json" : format === "csv" ? "csv" : "json";
    const mime = ext === "html" ? "text/html" : ext === "csv" ? "text/csv" : "application/json";
    const filename = options.filename ?? `vitas_${this.data.metadata.sessionId}_${this.data.metadata.date}`;

    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ── Format implementations ─────────────────────────────────── */

  /** Full JSON export with all VITAS data */
  toJSON(options: ExportOptions = {}): string {
    const output: Record<string, unknown> = {
      format: "vitas_v2",
      exportedAt: new Date().toISOString(),
      metadata: this.data.metadata,
      physicalMetrics: this.data.physicalMetrics,
      biomechanics: options.includeJointDetails
        ? this.data.biomechanics
        : this.data.biomechanics
          ? { ...this.data.biomechanics, jointDetail: undefined }
          : null,
      eventSummary: this.data.eventSummary,
      events: this.data.events,
      scanEvents: this.data.scanEvents,
      // Duelos: hueco con su motivo (P1 bloque 6), nunca «0G / 0P».
      duels: duelsMetric(),
    };

    if (options.includeRawTracks) {
      const decimation = options.positionDecimation ?? 1;
      output.tracks = this.data.tracks.map(t => ({
        id: t.id,
        bbox: t.bbox,
        smoothSpeedMs: t.smoothSpeedMs,
        positions: decimation > 1
          ? t.positions.filter((_, i) => i % decimation === 0)
          : t.positions,
        ...(options.includeKeypoints ? { keypoints: t.keypoints } : {}),
      }));
    }

    if (this.data.focusPositions.length > 0) {
      output.focusPositions = this.data.focusPositions;
    }

    return JSON.stringify(output, null, 2);
  }

  /** CSV export: one row per focus position + event data */
  toCSV(options: ExportOptions = {}): string {
    const rows: string[][] = [];
    const decimation = options.positionDecimation ?? 1;

    // Tracking positions CSV. `calibration_reliable` avisa si las columnas en metros
    // (position_x_m/y_m, speed_ms/kmh) son medidas fiables o estimaciones en píxeles.
    const calibReliable = String(this.data.metadata.calibrationReliable);
    rows.push([
      "timestamp_ms", "position_x_m", "position_y_m",
      "speed_ms", "speed_kmh",
      "event_type", "event_outcome", "event_confidence",
      "calibration_reliable",
    ]);

    // Build event lookup by timestamp
    const eventsByTime = new Map<number, TacticalEvent>();
    for (const e of this.data.events) {
      eventsByTime.set(Math.round(e.timestampMs / 125) * 125, e); // Snap to ~8fps
    }

    // Focus player positions
    const positions = this.data.focusPositions;
    for (let i = 0; i < positions.length; i++) {
      if (i % decimation !== 0) continue;
      const p = positions[i];
      const snappedTime = Math.round(p.tMs / 125) * 125;
      const event = eventsByTime.get(snappedTime);

      // Estimate speed from consecutive positions
      let speedMs = 0;
      if (i > 0) {
        const prev = positions[i - 1];
        const dt = (p.tMs - prev.tMs) / 1000;
        if (dt > 0) {
          speedMs = Math.sqrt((p.fx - prev.fx) ** 2 + (p.fy - prev.fy) ** 2) / dt;
        }
      }

      rows.push([
        String(p.tMs),
        p.fx.toFixed(2),
        p.fy.toFixed(2),
        speedMs.toFixed(2),
        (speedMs * 3.6).toFixed(2),
        event?.type ?? "",
        event?.outcome ?? "",
        event ? event.confidence.toFixed(2) : "",
        calibReliable,
      ]);
    }

    return rows.map(r => r.join(",")).join("\n");
  }

  /** SPADL format: Soccer Player Action Description Language */
  toSPADL(): string {
    const spadlEvents = this.data.events.map(e => ({
      game_id: this.data.metadata.sessionId,
      period_id: 1,
      time_seconds: round2(e.timestampMs / 1000),
      team_id: 0,
      player_id: e.actorTrackId,
      start_x: round2(e.startPosition.fx),
      start_y: round2(e.startPosition.fy),
      end_x: round2(e.endPosition?.fx ?? e.startPosition.fx),
      end_y: round2(e.endPosition?.fy ?? e.startPosition.fy),
      type_name: mapToSPADLType(e.type),
      result_name: mapToSPADLResult(e.outcome),
      bodypart_name: "foot",
    }));

    return JSON.stringify({
      format: "spadl_v2",
      actions: spadlEvents,
      metadata: {
        pitch_length: this.data.metadata.fieldDimensions.lengthM,
        pitch_width: this.data.metadata.fieldDimensions.widthM,
        calibration_reliable: this.data.metadata.calibrationReliable,
      },
    }, null, 2);
  }

  /** FIFA EPTS Standard Tracking System format */
  toSTS(options: ExportOptions = {}): string {
    const decimation = options.positionDecimation ?? 1;

    // STS uses semicolon-delimited format with frame-based structure
    const lines: string[] = [];
    lines.push("# VITAS EPTS Export");
    lines.push(`# Session: ${this.data.metadata.sessionId}`);
    lines.push(`# Date: ${this.data.metadata.date}`);
    lines.push(`# FPS: ${this.data.metadata.trackingFps}`);
    lines.push(`# Field: ${this.data.metadata.fieldDimensions.lengthM}x${this.data.metadata.fieldDimensions.widthM}`);
    if (!this.data.metadata.calibrationReliable) {
      lines.push("# WARNING: calibration NOT reliable — coordinates/speeds are pixel-relative estimates, NOT calibrated meters");
    }
    lines.push("# Format: FrameID;Timestamp;PlayerID;X;Y;Speed;Acceleration");
    lines.push("");

    let frameId = 0;
    for (let i = 0; i < this.data.focusPositions.length; i++) {
      if (i % decimation !== 0) continue;
      const p = this.data.focusPositions[i];
      frameId++;

      let speed = 0;
      let accel = 0;
      if (i > 0) {
        const prev = this.data.focusPositions[i - 1];
        const dt = (p.tMs - prev.tMs) / 1000;
        if (dt > 0) {
          const newSpeed = Math.sqrt((p.fx - prev.fx) ** 2 + (p.fy - prev.fy) ** 2) / dt;
          accel = (newSpeed - speed) / dt;
          speed = newSpeed;
        }
      }

      lines.push([
        frameId,
        p.tMs,
        this.data.focusTrackId ?? 0,
        p.fx.toFixed(2),
        p.fy.toFixed(2),
        speed.toFixed(2),
        accel.toFixed(2),
      ].join(";"));
    }

    return lines.join("\n");
  }

  /** Metrica Sports compatible JSON */
  toMetrica(options: ExportOptions = {}): string {
    const decimation = options.positionDecimation ?? 1;

    const frames = this.data.focusPositions
      .filter((_, i) => i % decimation === 0)
      .map((p, i) => ({
        frame: i,
        timestamp: p.tMs / 1000,
        ball_x: null,
        ball_y: null,
        home_players: [{
          player_id: this.data.focusTrackId ?? 0,
          x: p.fx / this.data.metadata.fieldDimensions.lengthM,
          y: p.fy / this.data.metadata.fieldDimensions.widthM,
        }],
        away_players: [],
      }));

    return JSON.stringify({
      format: "metrica_epts",
      pitch_dimensions: [
        this.data.metadata.fieldDimensions.lengthM,
        this.data.metadata.fieldDimensions.widthM,
      ],
      frame_rate: this.data.metadata.trackingFps,
      // Si false, las coordenadas normalizadas provienen de una homografía no fiable.
      calibration_reliable: this.data.metadata.calibrationReliable,
      tracking_data: frames,
      events: this.data.events.map(e => ({
        event_id: e.id,
        type: e.type,
        timestamp: e.timestampMs / 1000,
        player_id: e.actorTrackId,
        start_x: e.startPosition.fx / this.data.metadata.fieldDimensions.lengthM,
        start_y: e.startPosition.fy / this.data.metadata.fieldDimensions.widthM,
        end_x: e.endPosition
          ? e.endPosition.fx / this.data.metadata.fieldDimensions.lengthM
          : null,
        end_y: e.endPosition
          ? e.endPosition.fy / this.data.metadata.fieldDimensions.widthM
          : null,
        result: e.outcome,
      })),
    }, null, 2);
  }

  /** HTML report for printing / PDF generation */
  toHTMLReport(): string {
    const m = this.data.physicalMetrics;
    const b = this.data.biomechanics;
    const s = this.data.eventSummary;
    const meta = this.data.metadata;

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>VITAS Report · ${meta.playerName} · ${meta.date}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 2rem; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 1.5rem; color: #00e5ff; margin-bottom: 0.5rem; }
  h2 { font-size: 1.1rem; color: #00e5ff; margin: 1.5rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #333; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
  .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1rem; }
  .card .label { font-size: 0.7rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.5rem; font-weight: 800; color: #00e5ff; margin-top: 0.25rem; }
  .card .unit { font-size: 0.75rem; color: #666; }
  .bar-container { height: 6px; background: #333; border-radius: 3px; margin-top: 0.5rem; overflow: hidden; }
  .bar { height: 100%; border-radius: 3px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #333; color: #666; font-size: 0.75rem; text-align: center; }
  @media print { body { background: white; color: #111; } .card { border-color: #ddd; background: #f9f9f9; } h1, h2, .card .value { color: #0066cc; } }
</style>
</head>
<body>
  <h1>VITAS Football Intelligence</h1>
  <p class="meta">${meta.playerName} · ${meta.date} · ${Math.round(meta.durationSec / 60)} min · ${meta.trackingFps} FPS</p>
${meta.calibrationReliable ? "" : `
  <div style="background:#3a2a00;border:1px solid #a67c00;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem;color:#ffcc66;font-size:0.85rem;">
    ⚠️ Calibración no fiable — las métricas en metros/km·h (velocidad, distancia) son <strong>orientativas</strong> (estimaciones en píxeles), NO medidas calibradas.
  </div>`}

  <h2>Métricas Físicas</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Velocidad Máx</div>
      <div class="value">${(m.maxSpeedMs * 3.6).toFixed(1)} <span class="unit">km/h</span></div>
    </div>
    <div class="card">
      <div class="label">Distancia Total</div>
      <div class="value">${Math.round(m.distanceCoveredM)} <span class="unit">m</span></div>
    </div>
    <div class="card">
      <div class="label">Sprints</div>
      <div class="value">${m.sprintCount}</div>
    </div>
  </div>

  ${b ? `
  <h2>Biomecánica (MediaPipe)</h2>
  <div class="grid">
    <div class="card">
      <div class="label">DrillScore</div>
      <div class="value">${b.drillScore} <span class="unit">/100</span></div>
    </div>
    <div class="card">
      <div class="label">Simetría</div>
      <div class="value">${b.bilateralSymmetry}%</div>
    </div>
    <div class="card">
      <div class="label">Riesgo Lesión</div>
      <div class="value">${b.injuryRisk} <span class="unit">/100</span></div>
    </div>
  </div>
  ${b.recommendations.length > 0 ? `
  <div class="card" style="margin-top: 0.75rem">
    <div class="label">Recomendaciones</div>
    <ul style="margin-top: 0.5rem; padding-left: 1.2rem; font-size: 0.85rem; line-height: 1.6;">
      ${b.recommendations.map(r => `<li>${r}</li>`).join("")}
    </ul>
  </div>` : ""}` : ""}

  <h2>Eventos Tácticos</h2>
  ${s ? `<div class="grid">
    <div class="card">
      <div class="label">Pases</div>
      <div class="value">${s.passesCompleted}/${s.passesAttempted}</div>
      <div class="bar-container"><div class="bar" style="width:${s.passCompletionPct}%;background:#22c55e"></div></div>
    </div>
    <div class="card">
      <div class="label">Duelos</div>
      <div class="value" style="font-size: 0.85rem">No disponible</div>
      <div class="unit">${DUELS_GATE_REASON}</div>
    </div>
    <div class="card">
      <div class="label">Disparos</div>
      <div class="value">${s.shots}</div>
    </div>
  </div>
  <div class="grid-2" style="margin-top: 0.75rem">
    <div class="card">
      <div class="label">Recuperaciones</div>
      <div class="value">${s.recoveries}</div>
    </div>
    <div class="card">
      <div class="label">Sprints Tácticos</div>
      <div class="value">${s.sprintBursts}</div>
    </div>
  </div>` : `<div class="card"><div class="unit">Sin resumen de eventos tácticos en esta sesión.</div></div>`}

  <div class="footer">
    Generado por VITAS Football Intelligence · ${new Date().toISOString().slice(0, 10)} · ${PUBLIC_HOST}
  </div>
</body>
</html>`;
  }
}

/* ── SPADL Mapping Helpers ─────────────────────────────────────── */

function mapToSPADLType(type: string): string {
  const map: Record<string, string> = {
    // Base 12 types (sin duelos: P1 bloque 6)
    pass: "pass",
    through_ball: "pass",
    cross: "cross",
    shot: "shot",
    recovery: "interception",
    tackle: "tackle",
    interception: "interception",
    carry: "dribble",
    sprint_burst: "dribble",
    press_trigger: "tackle",
    set_piece: "freekick_short",
    offside_line_break: "dribble",
    // Sprint 3: 19 ball-aware types
    reception: "receival",
    dribble: "dribble",
    clearance: "clearance",
    goal_kick: "goalkick",
    corner_kick: "corner_crossed",
    throw_in: "throw_in",
    foul: "foul",
    offside: "offside",
    goalkeeper_save: "keeper_save",
    blocked_shot: "shot_block",
    key_pass: "pass",
    progressive_pass: "pass",
    switch_play: "pass",
    ball_recovery: "interception",
    turnover: "bad_touch",
    dispossessed: "bad_touch",
    second_assist: "pass",
    chance_created: "pass",
    progressive_carry: "dribble",
  };
  return map[type] ?? "other";
}

function mapToSPADLResult(outcome: string): string {
  const map: Record<string, string> = {
    success: "success",
    fail: "fail",
    neutral: "success",
    unknown: "success",
  };
  return map[outcome] ?? "success";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
