/**
 * VITAS · Player Tracking Service
 *
 * Persiste el snapshot del análisis YOLO de un jugador (escaneos, duelos,
 * Voronoi, métricas físicas) generado en VitasLab para que sea visible en
 * PlayerIntelligencePage y RoleProfile.
 *
 * Storage: localStorage `vitas_tracking_snapshot_{playerId}` (uno por jugador,
 * el último prevalece).
 */
import type { PhysicalMetrics, ScanEvent, DuelEvent, FieldPoint } from "@/lib/yolo/types";
import type { CalibrationConfidence } from "@/lib/yolo/fieldRegistration";
import type { TacticalEvent } from "@/lib/tracking/eventDetectionEngine";
import type { BiomechanicsScore } from "@/lib/mediapipe/biomechanicsEngine";
import type { FatigueReport } from "@/lib/fatigue/types";
import type { TeamAnalysisReport } from "@/lib/tracking/teamAnalysisEngine";
import type { RivalScoutReport } from "@/lib/tracking/rivalAnalysisEngine";
import { getAuthHeaders } from "@/lib/apiAuth";

// ─── Ball / Possession types (Sprint 1) ──────────────────────────────────────

export interface BallPosition {
  fx: number;
  fy: number;
  timestampMs: number;
  confidence: number;
  source: "model" | "heuristic" | "predicted";
}

export interface PossessionSegment {
  team: "home" | "away" | "contested" | "none";
  startMs: number;
  endMs: number;
  durationMs: number;
}

const STORAGE_PREFIX = "vitas_tracking_snapshot_";

export interface TrackingSnapshot {
  playerId:       string;
  videoId:        string | null;
  savedAt:        string;            // ISO
  durationSec:    number;            // duración aproximada de la sesión
  sessionMetrics: PhysicalMetrics;
  /**
   * Confianza de la calibración de campo (px↔metros) de esta sesión. Sin ella
   * (o low/none), las métricas físicas — velocidad, distancia, sprints — son
   * ORIENTATIVAS, no medidas: dependen de que se hayan marcado/detectado los
   * puntos del campo. Los snapshots antiguos no la tienen (undefined) → aviso.
   */
  calibrationConfidence?: CalibrationConfidence;
  scanCount:      number;
  duelCount:      number;
  tracksCount:    number;
  focusTrackId:   number | null;
  /** Hasta 500 eventos (Sprint 3 expansion: 35+ types) · evita storage bloat */
  scanEvents:     ScanEvent[];
  duelEvents:     DuelEvent[];
  /** Posiciones del track enfocado (para heatmap), normalizadas 0-105 x 0-68 */
  focusPositions?: Array<{ fx: number; fy: number; tMs: number }>;
  /** Tactical events detected by EventDetectionEngine (Sprint 2 — VAEP input) */
  tacticalEvents?: TacticalEvent[];
  /** MediaPipe biomechanics score (Sprint 2 — real biomechanics) */
  biomechanicsScore?: BiomechanicsScore;
  /** Fatigue report (Sprint 2 — metabolic power, ACWR, posture signals, PHV-adjusted) */
  fatigueReport?: FatigueReport;
  /** Ball positions during the session (Sprint 1 — field coordinates, last 500) */
  ballPositions?: BallPosition[];
  /** Possession segments (Sprint 1 — team possession timeline) */
  possessionSegments?: PossessionSegment[];
  /** Team analysis report (Sprint 8 — team mode) */
  teamReport?: TeamAnalysisReport;
  /** Rival scout report (Sprint 8 — rival scouting mode) */
  rivalReport?: RivalScoutReport;
}

export const PlayerTrackingService = {
  /** Guarda snapshot · sobreescribe si ya existía. Recorta arrays grandes.
   *  Persiste en localStorage (inmediato) + Supabase (async, best-effort). */
  save(snapshot: TrackingSnapshot): void {
    if (!snapshot.playerId) return;
    const trimmed: TrackingSnapshot = {
      ...snapshot,
      scanEvents: snapshot.scanEvents.slice(-200),
      duelEvents: snapshot.duelEvents.slice(-200),
      focusPositions: snapshot.focusPositions?.slice(-500),
      tacticalEvents: snapshot.tacticalEvents?.slice(-500),
      ballPositions: snapshot.ballPositions?.slice(-500),
      possessionSegments: snapshot.possessionSegments?.slice(-100),
    };
    // 1. localStorage (inmediato, nunca falla la app)
    try {
      localStorage.setItem(STORAGE_PREFIX + snapshot.playerId, JSON.stringify(trimmed));
    } catch (e) {
      console.warn("[playerTrackingService] localStorage save failed", e);
    }
    // 2. Supabase (async, best-effort — no bloquea UI)
    this._persistToSupabase(trimmed).catch((e) =>
      console.warn("[playerTrackingService] Supabase save failed (non-blocking)", e),
    );
    // 3. Persist fatigue session separately (async, best-effort)
    if (trimmed.fatigueReport) {
      this._persistFatigueSession(trimmed).catch((e) =>
        console.warn("[playerTrackingService] Fatigue session save failed (non-blocking)", e),
      );
    }
  },

  /** Fire-and-forget persistence to Supabase via /api/tracking/save */
  async _persistToSupabase(snapshot: TrackingSnapshot): Promise<void> {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/tracking/save", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: snapshot.playerId,
          videoId: snapshot.videoId,
          targetTrackId: snapshot.focusTrackId,
          durationMs: Math.round(snapshot.durationSec * 1000),
          metrics: snapshot.sessionMetrics,
          scanEvents: snapshot.scanEvents,
          duelEvents: snapshot.duelEvents,
          calibrationPreset: "full_corners",
        }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "unknown");
        console.warn("[playerTrackingService] Supabase returned", res.status, err);
      }
    } catch {
      // Network error — ignore, localStorage has the data
    }
  },

  /** Fire-and-forget persistence of fatigue session to Supabase via /api/tracking/fatigue-session */
  async _persistFatigueSession(snapshot: TrackingSnapshot): Promise<void> {
    const report = snapshot.fatigueReport;
    if (!report) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/tracking/fatigue-session", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: snapshot.playerId,
          videoId: snapshot.videoId,
          sessionDate: new Date().toISOString().slice(0, 10),
          durationMin: report.sessionDurationMin,
          totalDistanceM: report.windows.reduce((s, w) => s + w.distanceM, 0),
          // Carga de la SESIÓN (Σ potencia metabólica), la que usa el ACWR; null si no
          // se pudo calcular (antes: la carga aguda del ACWR, o 0). P1 bloque 4.
          totalLoad: report.totalMetabolicLoad ?? null,
          fatigueIndex: report.fatigueIndex.value,
          fatigueSeverity: report.fatigueIndex.severity,
          acwrValue: report.acwr?.value ?? null,
          acwrZone: report.acwr?.zone ?? null,
          windowMetrics: report.windows,
          postureSignals: report.posture,
          decayMetrics: report.fatigueIndex.decay,
          alerts: report.alerts,
          phvOffset: report.thresholds.phvOffset,
          // "unknown" no cabe en el CHECK de fatigue_sessions.maturation_band (043): null.
          maturationBand: report.thresholds.band === "unknown" ? null : report.thresholds.band,
        }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "unknown");
        console.warn("[playerTrackingService] Fatigue session returned", res.status, err);
      }
    } catch {
      // Network error — ignore, localStorage snapshot has the fatigue report
    }
  },

  /** Fetch fatigue session history for ACWR computation (last 28 days). */
  async getFatigueHistory(playerId: string, days = 28): Promise<FatigueSessionSummary[]> {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `/api/tracking/fatigue-history?playerId=${encodeURIComponent(playerId)}&days=${days}`,
        { headers },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        return json.data as FatigueSessionSummary[];
      }
    } catch {
      // Fallback: try to build from localStorage
    }
    // Fallback: extract from localStorage snapshot (only 1 session)
    const snap = this.get(playerId);
    if (!snap?.fatigueReport) return [];
    const r = snap.fatigueReport;
    // Solo con la carga real de la sesión (informes anteriores al bloque 4 no la
    // guardaban): sin ella no hay sesión que contar, nunca un 0.
    if (typeof r.totalMetabolicLoad !== "number") return [];
    return [{
      date: r.analyzedAt.slice(0, 10),
      load: r.totalMetabolicLoad,
      source: "localStorage" as const,
    }];
  },

  /** Lee el último snapshot guardado · null si no existe o está corrupto. */
  get(playerId: string): TrackingSnapshot | null {
    if (!playerId) return null;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + playerId);
      if (!raw) return null;
      return JSON.parse(raw) as TrackingSnapshot;
    } catch {
      return null;
    }
  },

  /** Borra el snapshot del jugador. */
  remove(playerId: string): void {
    if (!playerId) return;
    localStorage.removeItem(STORAGE_PREFIX + playerId);
  },

  /** Lista todos los snapshots guardados (localStorage). */
  list(): TrackingSnapshot[] {
    const result: TrackingSnapshot[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { result.push(JSON.parse(raw) as TrackingSnapshot); } catch { /* skip */ }
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  },

  /** Historial de sesiones desde Supabase (últimas N). Fallback a localStorage si falla. */
  async getHistory(playerId: string, limit = 10): Promise<TrackingSessionSummary[]> {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `/api/tracking/history?playerId=${encodeURIComponent(playerId)}&limit=${limit}`,
        { headers },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        return json.data as TrackingSessionSummary[];
      }
    } catch {
      // Fallback: build summary from localStorage
    }
    const snap = this.get(playerId);
    if (!snap) return [];
    return [{
      id: `local-${playerId}`,
      date: snap.savedAt,
      durationSec: snap.durationSec,
      maxSpeedMs: snap.sessionMetrics.maxSpeedMs,
      avgSpeedMs: snap.sessionMetrics.avgSpeedMs,
      sprintCount: snap.sessionMetrics.sprintCount,
      scanCount: snap.scanCount,
      duelCount: snap.duelCount,
      eventCount: snap.tacticalEvents?.length ?? 0,
      source: "localStorage" as const,
    }];
  },

  /**
   * Multi-session aggregation: rolling averages, trends, percentiles.
   * Sprint 9: foundation for injury + valuation models.
   */
  async getSessionAggregation(
    playerId: string,
    days = 28,
  ): Promise<SessionAggregation> {
    const history = await this.getHistory(playerId, 50);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();

    const recent = history.filter((s) => s.date >= cutoffStr);
    if (recent.length === 0) {
      return {
        sessionCount: 0,
        periodDays: days,
        avgSpeedMs: 0,
        maxSpeedMs: 0,
        avgSprintCount: 0,
        avgDurationSec: 0,
        totalDistanceEstM: 0,
        avgScanCount: 0,
        avgDuelCount: 0,
        avgEventCount: 0,
        speedTrend: 0,
        sprintTrend: 0,
        consistencyScore: 0,
        coldStart: true,
      };
    }

    const n = recent.length;
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    const avg = (arr: number[]) => (arr.length > 0 ? sum(arr) / arr.length : 0);

    const speeds = recent.map((s) => s.avgSpeedMs);
    const sprints = recent.map((s) => s.sprintCount);
    const durations = recent.map((s) => s.durationSec);

    // Simple linear trend: (last half avg - first half avg) / first half avg
    const half = Math.floor(n / 2);
    const speedTrend = half > 0
      ? (avg(speeds.slice(half)) - avg(speeds.slice(0, half))) / (avg(speeds.slice(0, half)) || 1)
      : 0;
    const sprintTrend = half > 0
      ? (avg(sprints.slice(half)) - avg(sprints.slice(0, half))) / (avg(sprints.slice(0, half)) || 1)
      : 0;

    // Consistency: coefficient of variation (lower = more consistent)
    const speedMean = avg(speeds);
    const speedStdDev = Math.sqrt(avg(speeds.map((s) => (s - speedMean) ** 2)));
    const cv = speedMean > 0 ? speedStdDev / speedMean : 1;
    const consistencyScore = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));

    return {
      sessionCount: n,
      periodDays: days,
      avgSpeedMs: Math.round(avg(speeds) * 100) / 100,
      maxSpeedMs: Math.max(...recent.map((s) => s.maxSpeedMs)),
      avgSprintCount: Math.round(avg(sprints) * 10) / 10,
      avgDurationSec: Math.round(avg(durations)),
      totalDistanceEstM: Math.round(sum(recent.map((s) => s.avgSpeedMs * s.durationSec))),
      avgScanCount: Math.round(avg(recent.map((s) => s.scanCount)) * 10) / 10,
      avgDuelCount: Math.round(avg(recent.map((s) => s.duelCount)) * 10) / 10,
      avgEventCount: Math.round(avg(recent.map((s) => s.eventCount)) * 10) / 10,
      speedTrend: Math.round(speedTrend * 100) / 100,
      sprintTrend: Math.round(sprintTrend * 100) / 100,
      consistencyScore,
      coldStart: n < 4,
    };
  },
};

export interface SessionAggregation {
  sessionCount: number;
  periodDays: number;
  avgSpeedMs: number;
  maxSpeedMs: number;
  avgSprintCount: number;
  avgDurationSec: number;
  totalDistanceEstM: number;
  avgScanCount: number;
  avgDuelCount: number;
  avgEventCount: number;
  /** Trend: positive = improving, negative = declining (-1 to +1 range) */
  speedTrend: number;
  sprintTrend: number;
  /** 0-100: how consistent performance is across sessions */
  consistencyScore: number;
  /** true if <4 sessions — aggregation unreliable */
  coldStart: boolean;
}

export interface TrackingSessionSummary {
  id: string;
  date: string;
  durationSec: number;
  maxSpeedMs: number;
  avgSpeedMs: number;
  sprintCount: number;
  scanCount: number;
  duelCount: number;
  eventCount: number;
  source: "supabase" | "localStorage";
}

/** Minimal session data needed for ACWR computation (SessionLoad format) */
export interface FatigueSessionSummary {
  date: string;
  load: number;
  source: "supabase" | "localStorage";
}
