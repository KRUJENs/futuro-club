/**
 * VITAS · Wellbeing Hooks (Sprint 22)
 *
 * TanStack Query hooks for the Burnout & Dropout Detection module.
 * Pattern: identical to useBehavioralProfile.ts / useInjuryRisk.ts
 *
 * Queries:
 *   useDropoutRisk(playerId) — get dropout risk assessment
 *   useEngagementHistory(playerId) — get engagement snapshots
 *   useAttendance(playerId) — get attendance profile
 *
 * Mutations:
 *   useSaveQuestionnaire() — save wellbeing questionnaire
 *   useSaveAttendance() — save attendance record
 */

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/apiAuth";
import i18n from "@/i18n";
import { normalizeLocale, type ReportLocale } from "@/lib/shared/locale";

const STALE_TIME = 1000 * 60 * 5; // 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────

export interface DropoutRiskAssessment {
  playerId: string;
  /** true si el assessment es MOCK de demostración (no medido) → banner honesto. */
  isMock?: boolean;
  riskScore: number;
  riskLevel: "low" | "moderate" | "high" | "critical";
  primaryFactor: string;
  factors: Record<string, { score: number; weight: number } | null>;
  hasBehavioralData: boolean;
  intervention: {
    urgency: string;
    actions: Array<{ audience: string; action: string; priority: string }>;
    followUpDate: string;
    escalationNeeded: boolean;
  };
  engagement: {
    current: number;
    historical: number;
    trend: string;
    consecutiveDeclines: number;
  };
  overtraining: {
    risk: number;
    riskLevel: string;
    currentLoadAU: number;
    recommendedLoadAU: number;
    adjustmentPct: number;
  };
  motivation: {
    type: string;
    dropoutRisk: number;
    confidence: number;
  };
  attendance: {
    rate: number | null; // null = sin sesiones registradas (no 100%)
    consecutiveAbsences: number;
    recentTrend: string;
  };
}

export interface EngagementSnapshot {
  playerId: string;
  sessionId: string;
  date: string;
  physicalEngagement: number;
  socialEngagement: number;
  emotionalEngagement: number;
  engagementScore: number;
  trend?: string;
  /** true si es dato de ejemplo (fallback), no una valoración real. El heatmap
   *  de equipo lo excluye para no mezclar ejemplo con datos reales. */
  isMock?: boolean;
}

export interface AttendanceRecord {
  playerId: string;
  date: string;
  status: "present" | "absent" | "late" | "excused";
  source: "video" | "manual" | "auto";
}

export interface AttendanceProfile {
  playerId: string;
  rate: number;
  totalSessions: number;
  attended: number;
  absent: number;
  late: number;
  excused: number;
  consecutiveAbsences: number;
  records: AttendanceRecord[];
  /** true si es un perfil de ejemplo (fallback), no asistencia real registrada.
   *  La UI debe mostrar el DemoDataBanner cuando esto sea true. */
  isMock?: boolean;
}

interface QuestionnaireInput {
  playerId: string;
  respondent: "player" | "coach" | "parent";
  responses: Record<string, number | string>;
  score?: number;
}

interface AttendanceInput {
  playerId: string;
  date: string;
  status: "present" | "absent" | "late" | "excused";
  source?: "video" | "manual" | "auto";
  sessionId?: string;
}

interface EngagementInput {
  playerId: string;
  date: string;
  /** 0-100, valoración por eje del entrenador. */
  physical: number;
  social: number;
  emotional: number;
  /** composite 0-100 (media ponderada de los tres ejes). */
  composite: number;
  sessionId?: string;
}

// ─── API Helpers ──────────────────────────────────────────────────────────

const API_BASE = "/api/wellbeing";

async function fetchDropoutRisk(playerId: string): Promise<DropoutRiskAssessment> {
  try {
    const res = await fetch(`${API_BASE}/dropout-risk?playerId=${encodeURIComponent(playerId)}`, {
      headers: await getAuthHeaders(),
    });
    if (!res.ok) return generateMockRiskAssessment(playerId);
    const data = await res.json();
    const assessment = data.data?.assessment;
    if (!assessment) return generateMockRiskAssessment(playerId);
    // El endpoint /dropout-risk todavía devuelve una evaluación de EJEMPLO
    // (source "mock": derivada del id del jugador, no de asistencia/engagement
    // reales). Se marca isMock para que la UI muestre el DemoDataBanner — un valor
    // por hash del id es MOCK disfrazado (rules/metricas.md). Cuando el endpoint
    // compute desde datos reales devolverá source "computed" y el banner se irá.
    return { ...assessment, isMock: data.data?.source !== "computed" };
  } catch {
    return generateMockRiskAssessment(playerId);
  }
}

async function fetchEngagementHistory(playerId: string): Promise<EngagementSnapshot[]> {
  // Try real Supabase-backed service first (graceful fallback to localStorage cache)
  try {
    const { WellbeingService } = await import("@/services/real/wellbeingService");
    const snapshots = await WellbeingService.getEngagement(playerId, 12);
    if (snapshots.length > 0) {
      return snapshots.map((s) => ({
        playerId: s.playerId,
        sessionId: s.sessionId ?? "",
        date: s.date,
        physicalEngagement: s.physicalEngagement,
        socialEngagement: s.socialEngagement,
        emotionalEngagement: s.emotionalEngagement,
        engagementScore: s.engagementScore,
      }));
    }
  } catch (err) {
    console.warn("[useWellbeing] engagement service failed, using mock:", err);
  }
  return generateMockEngagementHistory(playerId);
}

async function fetchAttendance(playerId: string): Promise<AttendanceProfile> {
  // Try real Supabase-backed service first (graceful fallback to mock)
  try {
    const { WellbeingService } = await import("@/services/real/wellbeingService");
    const records = await WellbeingService.getAttendance(playerId, 60);
    if (records.length > 0) {
      const total = records.length;
      const attended = records.filter((r) => r.status === "present").length;
      const absent = records.filter((r) => r.status === "absent").length;
      const late = records.filter((r) => r.status === "late").length;
      const excused = records.filter((r) => r.status === "excused").length;
      // Compute consecutive absences from most recent (sorted desc by date already)
      let consecutiveAbsences = 0;
      for (const r of records) {
        if (r.status === "absent") consecutiveAbsences++;
        else break;
      }
      return {
        playerId,
        rate: total > 0 ? attended / total : 0,
        totalSessions: total,
        attended,
        absent,
        late,
        excused,
        consecutiveAbsences,
        records: records.map((r) => ({
          playerId: r.playerId,
          date: r.date,
          status: r.status,
          source: (r.source === "auto_detected" ? "auto" : (r.source ?? "manual")) as
            | "video"
            | "manual"
            | "auto",
        })),
      };
    }
  } catch (err) {
    console.warn("[useWellbeing] attendance service failed, using mock:", err);
  }
  return generateMockAttendance(playerId);
}

async function saveQuestionnaireApi(input: QuestionnaireInput): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/save-questionnaire`, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Failed to save questionnaire");
  const data = await res.json();
  return data.data ?? data;
}

async function saveAttendanceApi(input: AttendanceInput): Promise<{ status?: string; source?: string }> {
  const res = await fetch(`${API_BASE}/attendance`, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Failed to save attendance");
  const data = await res.json();
  const payload = data.data ?? data;
  // Contrato del endpoint: sin Supabase en el servidor responde source "client_only"
  // y NO persiste. Entonces el cliente debe guardar el registro en su caché local
  // (y en Supabase-cliente si la hay) para no perderlo silenciosamente — así el
  // calendario, que lee de WellbeingService, sí lo refleja.
  if (payload?.source === "client_only") {
    try {
      const { WellbeingService } = await import("@/services/real/wellbeingService");
      await WellbeingService.saveAttendance({
        id: "",
        playerId: input.playerId,
        date: input.date,
        status: input.status,
        source: input.source === "manual" ? "manual" : "auto_detected",
      });
    } catch {
      // best-effort: si tampoco hay localStorage, el error se refleja arriba.
    }
  }
  return payload;
}

/**
 * Persiste una valoración de engagement (entrada MANUAL del entrenador).
 *
 * A diferencia del resto de flujos de bienestar, engagement NO tiene endpoint
 * de servidor: se escribe directo con `WellbeingService.saveEngagement`, que usa
 * el cliente Supabase autenticado. La propiedad del jugador la garantiza la RLS
 * de la migración 073 (`engagement_snapshots_*_owner`: SOLO el dueño por
 * players.user_id, vía public.caller_manages_player, sin rama por tenant). La
 * 050 comparaba players.tenant_id con auth.uid() y no dejaba escribir a nadie:
 * hasta aplicar la 073 el upsert falla (42501) y el dato queda en la caché
 * local, igual que sin Supabase. NO existe pipeline de tracking que atribuya
 * engagement a un jugador con nombre (identidad por dorsal sin construir →
 * pistas anónimas), así que la
 * valoración del entrenador es hoy la única fuente honesta por jugador.
 */
async function saveEngagementService(input: EngagementInput): Promise<{ id: string }> {
  const { WellbeingService } = await import("@/services/real/wellbeingService");
  const saved = await WellbeingService.saveEngagement({
    id: "",
    playerId: input.playerId,
    sessionId: input.sessionId,
    date: input.date,
    physicalEngagement: input.physical,
    socialEngagement: input.social,
    emotionalEngagement: input.emotional,
    engagementScore: input.composite,
  });
  return { id: saved.id };
}

// ─── AI Burnout Report (agente burnout-report) ──────────────────────────────

export interface BurnoutReportInput {
  playerId: string;
  playerName?: string;
  playerAge: number;
  riskScore: number;
  riskLevel: "low" | "moderate" | "high" | "critical";
  primaryFactor: string;
  factors?: Record<string, { score: number; weight: number } | null>;
  engagement?: DropoutRiskAssessment["engagement"];
  overtraining?: DropoutRiskAssessment["overtraining"];
  motivation?: DropoutRiskAssessment["motivation"];
  attendance?: DropoutRiskAssessment["attendance"];
  questionnaireSummary?: string;
  interventionActions?: Array<{ audience: string; action: string; priority: string }>;
  /** Idioma de redacción del reporte (uno de los soportados en el registro de
   *  locale). Si se omite, `burnoutReportApi` lo rellena con el idioma actual
   *  de la UI (i18n) para que el agente redacte en el idioma del usuario. */
  locale?: ReportLocale;
}

export interface AiReportResult {
  report: Record<string, unknown>;
  source?: string;
  model?: string;
}

async function burnoutReportApi(input: BurnoutReportInput): Promise<AiReportResult> {
  // El agente redacta en `locale` (languageDirective). Si el caller no lo fijó,
  // se toma el idioma actual de la UI — el POST SIEMPRE lleva locale.
  const requestBody: BurnoutReportInput = {
    ...input,
    locale: input.locale ?? normalizeLocale(i18n.language),
  };
  const res = await fetch(`${API_BASE}/burnout-report`, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Burnout report failed: ${errText}`);
  }
  const json = await res.json();
  const payload = json.data ?? json;
  return {
    report: (payload.report ?? {}) as Record<string, unknown>,
    source: payload.source,
    model: payload.model,
  };
}

/**
 * Build the burnout-report agent input from a dropout risk assessment.
 * Todos los campos que el agente necesita ya vienen en el assessment.
 */
export function buildBurnoutInput(
  risk: DropoutRiskAssessment,
  playerName: string,
  playerAge: number,
): BurnoutReportInput {
  return {
    playerId: risk.playerId,
    playerName,
    playerAge,
    riskScore: risk.riskScore,
    riskLevel: risk.riskLevel,
    primaryFactor: risk.primaryFactor,
    factors: risk.factors,
    engagement: risk.engagement,
    overtraining: risk.overtraining,
    motivation: risk.motivation,
    attendance: risk.attendance,
    interventionActions: risk.intervention?.actions,
    locale: normalizeLocale(i18n.language),
  };
}

// ─── Hooks ────────────────────────────────────────────────────────────────

/**
 * Get dropout risk assessment for a player.
 */
export function useDropoutRisk(playerId: string | undefined) {
  return useQuery({
    queryKey: ["dropout-risk", playerId],
    queryFn: () => fetchDropoutRisk(playerId!),
    enabled: !!playerId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * Team-level dropout risk: one query per player (batched via useQueries).
 * Comparte queryKey ["dropout-risk", id] con useDropoutRisk, así el detalle de
 * jugador reutiliza la caché del overview. Sustituye al roster mock del panel.
 */
export function useTeamDropoutRisk(playerIds: string[]) {
  return useQueries({
    queries: playerIds.map((id) => ({
      queryKey: ["dropout-risk", id],
      queryFn: () => fetchDropoutRisk(id),
      enabled: !!id,
      staleTime: STALE_TIME,
      retry: 2,
    })),
  });
}

/**
 * Team-level engagement history: one query per player (batched).
 * Comparte queryKey ["engagement-history", id] con useEngagementHistory.
 */
export function useTeamEngagement(playerIds: string[]) {
  return useQueries({
    queries: playerIds.map((id) => ({
      queryKey: ["engagement-history", id],
      queryFn: () => fetchEngagementHistory(id),
      enabled: !!id,
      staleTime: STALE_TIME,
      retry: 2,
    })),
  });
}

/**
 * Get engagement history for a player (last 12 sessions).
 */
export function useEngagementHistory(playerId: string | undefined) {
  return useQuery({
    queryKey: ["engagement-history", playerId],
    queryFn: () => fetchEngagementHistory(playerId!),
    enabled: !!playerId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * Get attendance profile for a player.
 */
export function useAttendance(playerId: string | undefined) {
  return useQuery({
    queryKey: ["attendance", playerId],
    queryFn: () => fetchAttendance(playerId!),
    enabled: !!playerId,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/**
 * Save a wellbeing questionnaire.
 * Invalidates dropout-risk on success (new data might change risk).
 */
export function useSaveQuestionnaire() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveQuestionnaireApi,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["dropout-risk", variables.playerId],
      });
    },
  });
}

/**
 * Save an attendance record.
 * Invalidates attendance and dropout-risk on success.
 */
export function useSaveAttendance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveAttendanceApi,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["attendance", variables.playerId],
      });
      queryClient.invalidateQueries({
        queryKey: ["dropout-risk", variables.playerId],
      });
    },
  });
}

/**
 * Save a manual engagement rating (coach input).
 * Invalidates engagement-history (heatmap + timeline) and dropout-risk.
 */
export function useSaveEngagement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveEngagementService,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["engagement-history", variables.playerId],
      });
      queryClient.invalidateQueries({
        queryKey: ["dropout-risk", variables.playerId],
      });
    },
  });
}

/**
 * Generate an AI burnout/dropout report for a player (mutation).
 * Llama al agente burnout-report vía /api/wellbeing/burnout-report.
 * El agente cae a mock marcado si falta API key o falla → la UI nunca rompe.
 */
export function useBurnoutReport() {
  return useMutation({ mutationFn: burnoutReportApi });
}

// ─── Mock Data ────────────────────────────────────────────────────────────

function generateMockRiskAssessment(playerId: string): DropoutRiskAssessment {
  const seed = playerId.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const r = (min: number, max: number) => min + (seed % (max - min + 1));

  const riskScore = r(15, 55);
  const riskLevel: DropoutRiskAssessment["riskLevel"] =
    riskScore >= 75 ? "critical" :
    riskScore >= 50 ? "high" :
    riskScore >= 25 ? "moderate" :
    "low";

  return {
    playerId,
    isMock: true,
    riskScore,
    riskLevel,
    primaryFactor: "engagementDecline",
    factors: {
      engagementDecline: { score: r(20, 60), weight: 0.25 },
      motivationType: { score: r(15, 50), weight: 0.20 },
      overtrainingRisk: { score: r(10, 40), weight: 0.15 },
      vsiStagnation: { score: r(10, 35), weight: 0.12 },
      attendanceDecline: { score: r(5, 30), weight: 0.10 },
      injuryRecurrence: { score: r(0, 25), weight: 0.08 },
      growthSpurtStress: { score: r(0, 20), weight: 0.05 },
      lowResilience: null,
    },
    hasBehavioralData: false,
    intervention: {
      urgency: riskLevel === "critical" ? "immediate" : riskLevel === "high" ? "this_week" : "this_month",
      actions: [
        { audience: "coach", action: "Hablar individualmente con el jugador", priority: "this_week" },
        { audience: "parent", action: "Consultar cambios en el entorno", priority: "this_week" },
        { audience: "club", action: "Revisar carga de entrenamiento", priority: "this_month" },
      ],
      followUpDate: new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0],
      escalationNeeded: riskLevel === "critical",
    },
    engagement: {
      current: r(45, 75),
      historical: 68,
      trend: "stable",
      consecutiveDeclines: r(0, 2),
    },
    overtraining: {
      risk: r(15, 45),
      riskLevel: "moderate",
      currentLoadAU: 350,
      recommendedLoadAU: 340,
      adjustmentPct: -5,
    },
    motivation: {
      type: "mixed",
      dropoutRisk: 45,
      confidence: 0.65,
    },
    attendance: {
      rate: r(70, 95),
      consecutiveAbsences: 0,
      recentTrend: "stable",
    },
  };
}

function generateMockEngagementHistory(playerId: string): EngagementSnapshot[] {
  const snapshots: EngagementSnapshot[] = [];
  const now = new Date();

  for (let i = 11; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i * 3); // every ~3 days

    const base = 55 + Math.sin(i * 0.5) * 15;
    snapshots.push({
      playerId,
      sessionId: `session-${i}`,
      date: date.toISOString().split("T")[0],
      physicalEngagement: Math.round(base + Math.random() * 20),
      socialEngagement: Math.round(base + Math.random() * 15 - 5),
      emotionalEngagement: Math.round(base + Math.random() * 18 - 3),
      engagementScore: Math.round(base + Math.random() * 10),
      trend: i < 3 ? "declining" : "stable",
      isMock: true,
    });
  }

  return snapshots;
}

function generateMockAttendance(playerId: string): AttendanceProfile {
  const records: AttendanceRecord[] = [];
  const now = new Date();

  for (let i = 29; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);

    // Skip weekends
    if (date.getDay() === 0 || date.getDay() === 6) continue;

    // ~85% attendance
    const rand = Math.random();
    const status: AttendanceRecord["status"] =
      rand < 0.75 ? "present" :
      rand < 0.85 ? "late" :
      rand < 0.92 ? "excused" :
      "absent";

    records.push({
      playerId,
      date: date.toISOString().split("T")[0],
      status,
      source: "manual",
    });
  }

  const attended = records.filter(r => r.status === "present" || r.status === "late").length;
  const absent = records.filter(r => r.status === "absent").length;
  const late = records.filter(r => r.status === "late").length;
  const excused = records.filter(r => r.status === "excused").length;

  return {
    playerId,
    rate: records.length > 0 ? Math.round((attended / records.length) * 100) : 100,
    totalSessions: records.length,
    attended,
    absent,
    late,
    excused,
    consecutiveAbsences: 0,
    records,
    isMock: true,
  };
}
