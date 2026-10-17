/**
 * VITAS · Player Tracking Service
 *
 * Persiste el snapshot del análisis YOLO de un jugador (escaneos, Voronoi,
 * métricas físicas; sin duelos desde el P1 bloque 6) generado en VitasLab para que sea visible en
 * PlayerIntelligencePage y RoleProfile.
 *
 * Storage: localStorage `vitas_tracking_snapshot_{playerId}` (uno por jugador,
 * el último prevalece).
 */
import type { PhysicalMetrics, ScanEvent, FieldPoint } from "@/lib/yolo/types";
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
  // Sin duelCount/duelEvents (P1 bloque 6): no hay criterio validado de duelo
  // (src/lib/tracking/duels.ts). Los snapshots antiguos que los traen se ignoran.
  tracksCount:    number;
  focusTrackId:   number | null;
  /** Hasta 500 eventos (Sprint 3 expansion: 35+ types) · evita storage bloat */
  scanEvents:     ScanEvent[];
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
};

/** Minimal session data needed for ACWR computation (SessionLoad format) */
export interface FatigueSessionSummary {
  date: string;
  load: number;
  source: "supabase" | "localStorage";
}
