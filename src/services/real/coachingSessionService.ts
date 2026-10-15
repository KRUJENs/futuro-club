/**
 * VITAS · Coaching Session Service (Supabase + localStorage hybrid)
 *
 * Persists training sessions, per-player metrics and parent reports from
 * the Coach Dashboard. Used by:
 *   - /coach (CoachDashboardPage — panel OCULTO hasta P2: P1 bloque 5c; sin llamadores en la UI)
 *   - useCoachingSession hook
 *
 * Tables (migration 044):
 *   - training_sessions
 *   - player_session_metrics
 *   - parent_reports
 */

import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";

const STORAGE_KEY_SESSIONS = "vitas_coaching_sessions";
const STORAGE_KEY_METRICS = "vitas_coaching_metrics";
const STORAGE_KEY_REPORTS = "vitas_coaching_parent_reports";

// ── Types ────────────────────────────────────────────────────────────
export type SegmentType =
  | "warmup"
  | "technical"
  | "tactical"
  | "physical"
  | "game"
  | "cooldown";

export interface TrainingSegment {
  index: number;
  type: SegmentType;
  startMs: number;
  endMs: number;
  drillCategory?: string;
  drillSubcategory?: string;
  matchedDrillId?: string;
  intensityAvg?: number;
}

export interface SessionBalance {
  technicalPct: number;
  tacticalPct: number;
  physicalPct: number;
  gamePct: number;
  idealForAge?: { technical: number; tactical: number; physical: number; game: number };
  score: number; // 0-100
}

export interface SessionLoad {
  totalAU: number;
  recommendedAU: number;
  adjustmentPct: number;
  level: "low" | "optimal" | "high" | "critical";
}

export interface TrainingSession {
  id: string;
  teamId: string;
  coachId?: string;
  date: string;
  durationMin: number;
  segments: TrainingSegment[];
  drills?: Array<{ category: string; subcategory?: string; durationMs: number }>;
  balance?: SessionBalance;
  load?: SessionLoad;
  videoId?: string;
}

export interface PlayerSessionMetric {
  id: string;
  sessionId: string;
  playerId: string;
  drillIndex: number;
  touches: number;
  distanceM: number;
  avgSpeedMs: number;
  avgIntensity: number;
  idlePct: number;
  participationScore: number;
  distanceToCentroidM: number;
}

export interface ParentReport {
  id: string;
  playerId: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  summary: string;
  metrics: Record<string, number>;
  phvContext?: string;
}

// ── Cache helpers ────────────────────────────────────────────────────
function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, items: T[], cap = 200): void {
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(0, cap)));
  } catch (err) {
    console.error(`[coachingSessionService] write fail (${key})`, err);
  }
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Service ───────────────────────────────────────────────────────────
export const CoachingSessionService = {
  // ─── Sessions ──────────────────────────────────────────────────────
  async listSessions(teamId: string, limit = 30): Promise<TrainingSession[]> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("training_sessions")
          .select("*")
          .eq("team_id", teamId)
          .order("date", { ascending: false })
          .limit(limit);
        if (error) throw error;
        if (data) {
          return (data as Array<Record<string, unknown>>).map((r) => ({
            id: String(r.id),
            teamId: String(r.team_id),
            coachId: r.coach_id ? String(r.coach_id) : undefined,
            date: String(r.date),
            durationMin: Number(r.duration_min ?? 0),
            segments: (r.segments as TrainingSegment[]) ?? [],
            drills: (r.drills as TrainingSession["drills"]) ?? [],
            balance: (r.balance as SessionBalance) ?? undefined,
            load: (r.load as SessionLoad) ?? undefined,
            videoId: r.video_id ? String(r.video_id) : undefined,
          }));
        }
      } catch (err) {
        console.warn("[coachingSessionService] list failed:", err);
      }
    }
    return read<TrainingSession>(STORAGE_KEY_SESSIONS)
      .filter((s) => s.teamId === teamId)
      .slice(0, limit);
  },

  async getSession(sessionId: string): Promise<TrainingSession | null> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("training_sessions")
          .select("*")
          .eq("id", sessionId)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          const r = data as Record<string, unknown>;
          return {
            id: String(r.id),
            teamId: String(r.team_id),
            coachId: r.coach_id ? String(r.coach_id) : undefined,
            date: String(r.date),
            durationMin: Number(r.duration_min ?? 0),
            segments: (r.segments as TrainingSegment[]) ?? [],
            drills: (r.drills as TrainingSession["drills"]) ?? [],
            balance: (r.balance as SessionBalance) ?? undefined,
            load: (r.load as SessionLoad) ?? undefined,
            videoId: r.video_id ? String(r.video_id) : undefined,
          };
        }
      } catch (err) {
        console.warn("[coachingSessionService] get failed:", err);
      }
    }
    return read<TrainingSession>(STORAGE_KEY_SESSIONS).find((s) => s.id === sessionId) ?? null;
  },

  async saveSession(session: TrainingSession): Promise<TrainingSession> {
    const final = { ...session, id: session.id || genId("sess") };
    const all = read<TrainingSession>(STORAGE_KEY_SESSIONS).filter((s) => s.id !== final.id);
    all.unshift(final);
    write(STORAGE_KEY_SESSIONS, all);

    if (SUPABASE_CONFIGURED) {
      try {
        await supabase.from("training_sessions").upsert(
          {
            id: final.id.length === 36 ? final.id : undefined,
            team_id: final.teamId,
            coach_id: final.coachId,
            date: final.date,
            duration_min: final.durationMin,
            segments: final.segments,
            drills: final.drills,
            balance: final.balance,
            load: final.load,
            video_id: final.videoId,
          },
          { onConflict: "id" },
        );
      } catch (err) {
        console.warn("[coachingSessionService] save failed:", err);
      }
    }
    return final;
  },

  // ─── Player metrics per session ────────────────────────────────────
  async getMetricsForSession(sessionId: string): Promise<PlayerSessionMetric[]> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("player_session_metrics")
          .select("*")
          .eq("session_id", sessionId);
        if (error) throw error;
        if (data) {
          return (data as Array<Record<string, unknown>>).map((r) => ({
            id: String(r.id),
            sessionId: String(r.session_id),
            playerId: String(r.player_id),
            drillIndex: Number(r.drill_index ?? 0),
            touches: Number(r.touches ?? 0),
            distanceM: Number(r.distance_m ?? 0),
            avgSpeedMs: Number(r.avg_speed_ms ?? 0),
            avgIntensity: Number(r.avg_intensity ?? 0),
            idlePct: Number(r.idle_pct ?? 0),
            participationScore: Number(r.participation_score ?? 0),
            distanceToCentroidM: Number(r.distance_to_centroid_m ?? 0),
          }));
        }
      } catch (err) {
        console.warn("[coachingSessionService] metrics read failed:", err);
      }
    }
    return read<PlayerSessionMetric>(STORAGE_KEY_METRICS).filter((m) => m.sessionId === sessionId);
  },

  async saveMetric(metric: PlayerSessionMetric): Promise<PlayerSessionMetric> {
    const final = { ...metric, id: metric.id || genId("met") };
    const all = read<PlayerSessionMetric>(STORAGE_KEY_METRICS).filter((m) => m.id !== final.id);
    all.unshift(final);
    write(STORAGE_KEY_METRICS, all);

    if (SUPABASE_CONFIGURED) {
      try {
        await supabase.from("player_session_metrics").upsert(
          {
            id: final.id.length === 36 ? final.id : undefined,
            session_id: final.sessionId,
            player_id: final.playerId,
            drill_index: final.drillIndex,
            touches: final.touches,
            distance_m: final.distanceM,
            avg_speed_ms: final.avgSpeedMs,
            avg_intensity: final.avgIntensity,
            idle_pct: final.idlePct,
            participation_score: final.participationScore,
            distance_to_centroid_m: final.distanceToCentroidM,
          },
          { onConflict: "id" },
        );
      } catch (err) {
        console.warn("[coachingSessionService] metric save failed:", err);
      }
    }
    return final;
  },

  // ─── Parent reports ────────────────────────────────────────────────
  async getParentReports(playerId: string, limit = 10): Promise<ParentReport[]> {
    if (SUPABASE_CONFIGURED) {
      try {
        const { data, error } = await supabase
          .from("parent_reports")
          .select("*")
          .eq("player_id", playerId)
          .order("generated_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        if (data) {
          return (data as Array<Record<string, unknown>>).map((r) => ({
            id: String(r.id),
            playerId: String(r.player_id),
            generatedAt: String(r.generated_at),
            periodStart: String(r.period_start),
            periodEnd: String(r.period_end),
            summary: String(r.summary ?? ""),
            metrics: (r.metrics as Record<string, number>) ?? {},
            phvContext: r.phv_context ? String(r.phv_context) : undefined,
          }));
        }
      } catch (err) {
        console.warn("[coachingSessionService] parent reports read failed:", err);
      }
    }
    return read<ParentReport>(STORAGE_KEY_REPORTS)
      .filter((r) => r.playerId === playerId)
      .slice(0, limit);
  },

  async saveParentReport(report: ParentReport): Promise<ParentReport> {
    const final = { ...report, id: report.id || genId("prep") };
    const all = read<ParentReport>(STORAGE_KEY_REPORTS).filter((r) => r.id !== final.id);
    all.unshift(final);
    write(STORAGE_KEY_REPORTS, all);

    if (SUPABASE_CONFIGURED) {
      try {
        await supabase.from("parent_reports").upsert(
          {
            id: final.id.length === 36 ? final.id : undefined,
            player_id: final.playerId,
            generated_at: final.generatedAt,
            period_start: final.periodStart,
            period_end: final.periodEnd,
            summary: final.summary,
            metrics: final.metrics,
            phv_context: final.phvContext,
          },
          { onConflict: "id" },
        );
      } catch (err) {
        console.warn("[coachingSessionService] parent report save failed:", err);
      }
    }
    return final;
  },
};
