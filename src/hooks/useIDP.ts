/**
 * VITAS · IDP Hooks (Individual Development Plan)
 *
 * TanStack Query hooks that wrap IDPService (offline-first) and the
 * /api/idp/* endpoints (Claude agent + Supabase persistence).
 *
 * Queries:
 *   useCurrentIDP(playerId, monthStart?)   — fully hydrated active plan
 *   useIDPHistory(playerId, limit?)        — past plans (newest first)
 *   useTeamActiveIDPs(playerIds)           — team view for /director
 *   useIDPProgressSummary(planId, metrics?)— computed progress object
 *
 * Mutations:
 *   useGenerateIDP()                       — POST /api/idp/generate-plan
 *   useApproveIDP()                        — POST /api/idp/approve-plan
 *   useUpdateIDPGoal()                     — POST /api/idp/update-goal
 *   useUpdateIDPMilestone()                — POST /api/idp/update-milestone
 *   useIDPCheckin()                        — POST /api/idp/checkin
 *   useDeleteIDP()                         — local-only delete (rare)
 *
 * All mutations invalidate the relevant queries on success so the UI
 * refreshes without manual refetch.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import i18n from "@/i18n";
import { normalizeLocale, type ReportLocale } from "@/lib/shared/locale";
import { getAuthHeaders } from "@/lib/apiAuth";
import { IDPService } from "@/services/real/idpService";
import {
  computeSummary,
  type IDPProgressSummary,
} from "@/lib/idp";
import type {
  DevelopmentPlan,
  IDPCheckin,
  IDPGoal,
  IDPMilestone,
  IDPArchitectInput,
} from "@/lib/idp/idpTypes";

const STALE_PLAN = 1000 * 60 * 5; // 5 min — plans evolve through the month
const STALE_HISTORY = 1000 * 60 * 60; // 1 h — historical plans don't change

const apiBase = "/api/idp";

// ── Query keys ──────────────────────────────────────────────────────
export const idpKeys = {
  all: ["idp"] as const,
  current: (playerId: string, monthStart?: string) =>
    [...idpKeys.all, "current", playerId, monthStart ?? "thisMonth"] as const,
  history: (playerId: string, limit: number) =>
    [...idpKeys.all, "history", playerId, limit] as const,
  team: (playerIds: string[]) =>
    [...idpKeys.all, "team", playerIds.slice().sort().join(",")] as const,
  summary: (planId: string) => [...idpKeys.all, "summary", planId] as const,
};

// ── Query: current plan ─────────────────────────────────────────────
export function useCurrentIDP(playerId: string, monthStart?: string) {
  return useQuery<DevelopmentPlan | null>({
    queryKey: idpKeys.current(playerId, monthStart),
    queryFn: () => IDPService.getCurrentPlan(playerId, monthStart),
    enabled: Boolean(playerId),
    staleTime: STALE_PLAN,
  });
}

// ── Query: plan history ─────────────────────────────────────────────
export function useIDPHistory(playerId: string, limit = 12) {
  return useQuery<DevelopmentPlan[]>({
    queryKey: idpKeys.history(playerId, limit),
    queryFn: () => IDPService.getPlanHistory(playerId, limit),
    enabled: Boolean(playerId),
    staleTime: STALE_HISTORY,
  });
}

// ── Query: team active ──────────────────────────────────────────────
export function useTeamActiveIDPs(playerIds: string[]) {
  return useQuery<DevelopmentPlan[]>({
    queryKey: idpKeys.team(playerIds),
    queryFn: () => IDPService.getTeamActive(playerIds),
    enabled: playerIds.length > 0,
    staleTime: STALE_PLAN,
  });
}

// ── Query: progress summary (computed from plan + live metrics) ─────
export function useIDPProgressSummary(
  plan: DevelopmentPlan | null | undefined,
  metrics: Record<string, number> = {},
): IDPProgressSummary | null {
  if (!plan) return null;
  return computeSummary(plan, metrics, new Date());
}

// ── Mutation: generate plan ─────────────────────────────────────────
interface GenerateInput {
  architectInput: IDPArchitectInput;
  monthStart?: string;
  coachId?: string;
  tenantId?: string;
  /**
   * Output language of the plan. Optional: defaults to `architectInput.locale`
   * (set by useIDPArchitectInput) and then to the current UI language.
   */
  locale?: ReportLocale;
}

interface GenerateResult {
  /** Ausente con status «exists» (ya hay plan del mes) y en el demo (`data: null`). */
  plan?: DevelopmentPlan;
  source: string;
  model: string;
  status?: string;
}

export function useGenerateIDP() {
  const qc = useQueryClient();
  return useMutation<GenerateResult, Error, GenerateInput>({
    mutationFn: async (input) => {
      // Always ship the output language (top-level + inside architectInput, both
      // accepted by the API) so the agent never silently defaults to "es".
      const locale: ReportLocale =
        input.locale ?? input.architectInput.locale ?? normalizeLocale(i18n.language);
      const payloadBody: GenerateInput = {
        ...input,
        locale,
        architectInput: { ...input.architectInput, locale },
      };
      const res = await fetch(`${apiBase}/generate-plan`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify(payloadBody),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`generate-plan ${res.status}: ${text.slice(0, 200)}`) as Error & { code?: string };
        // El código del servidor (p. ej. idp_no_dimension_data) para que la UI diga el motivo.
        try {
          err.code = (JSON.parse(text) as { errorDetail?: { code?: string } }).errorDetail?.code;
        } catch { /* cuerpo no JSON */ }
        throw err;
      }
      const payload = (await res.json()) as { data: GenerateResult };
      // Cache to localStorage immediately
      if (payload.data?.plan) {
        await IDPService.savePlan(payload.data.plan);
      }
      return payload.data;
    },
    onSuccess: (result) => {
      // Con status «exists» el servidor no devuelve `plan` (antes: TypeError aquí).
      const plan = result?.plan;
      if (plan) {
        qc.invalidateQueries({ queryKey: idpKeys.current(plan.playerId, plan.monthStart) });
      }
      qc.invalidateQueries({ queryKey: idpKeys.all });
    },
  });
}

// ── Mutation: approve plan ──────────────────────────────────────────
interface ApproveInput {
  planId: string;
  coachId?: string;
  /** Player id for cache invalidation */
  playerId: string;
}

export function useApproveIDP() {
  const qc = useQueryClient();
  return useMutation<{ planId: string; status: string }, Error, ApproveInput>({
    mutationFn: async ({ planId, coachId, playerId: _playerId }) => {
      const res = await fetch(`${apiBase}/approve-plan`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ planId, coachId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`approve-plan ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as {
        data: { planId: string; status: string };
      };

      // Local cache: transition status
      await IDPService.transitionStatus(planId, "active", coachId);
      return payload.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: idpKeys.current(vars.playerId) });
      qc.invalidateQueries({ queryKey: idpKeys.all });
    },
  });
}

// ── Mutation: update goal ───────────────────────────────────────────
interface UpdateGoalInput extends Partial<Omit<IDPGoal, "id" | "planId">> {
  goalId: string;
  /** For cache invalidation */
  planId: string;
  playerId: string;
}

export function useUpdateIDPGoal() {
  const qc = useQueryClient();
  return useMutation<IDPGoal, Error, UpdateGoalInput>({
    mutationFn: async (input) => {
      const { goalId, planId: _planId, playerId: _playerId, ...changes } = input;

      // Optimistic local update
      const localGoal: IDPGoal = {
        id: goalId,
        planId: input.planId,
        dimension: changes.dimension ?? "technical",
        title: changes.title ?? "",
        description: changes.description,
        rationale: changes.rationale,
        baselineMetric: changes.baselineMetric ?? { metric: "vsi_overall", value: 0 },
        targetMetric: changes.targetMetric ?? { metric: "vsi_overall", value: 0 },
        currentValue: changes.currentValue,
        drillsAssigned: changes.drillsAssigned ?? [],
        weight: changes.weight ?? 3,
        status: changes.status ?? "pending",
        aiProposed: changes.aiProposed ?? false,
        coachEdited: true,
        createdAt: changes.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await IDPService.updateGoal(localGoal);

      // Server sync
      const res = await fetch(`${apiBase}/update-goal`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ goalId, ...changes }),
      });
      if (!res.ok) {
        // Server failed but local update stuck — caller may retry later
        const text = await res.text().catch(() => "");
        throw new Error(`update-goal ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as { data: { goal: IDPGoal } };
      return payload.data.goal ?? localGoal;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: idpKeys.current(vars.playerId) });
    },
  });
}

// ── Mutation: update milestone ──────────────────────────────────────
interface UpdateMilestoneInput {
  milestoneId: string;
  status: IDPMilestone["status"];
  evidence?: IDPMilestone["evidence"];
  /** For cache invalidation */
  planId: string;
  playerId: string;
}

export function useUpdateIDPMilestone() {
  const qc = useQueryClient();
  return useMutation<IDPMilestone, Error, UpdateMilestoneInput>({
    mutationFn: async (input) => {
      const { milestoneId, status, evidence, planId, playerId: _p } = input;

      const localUpdate: IDPMilestone = {
        id: milestoneId,
        planId,
        goalId: "", // service preserves goalId from existing record
        dueDate: "",
        weekNumber: 1,
        title: "",
        status,
        evidence: evidence ?? {},
        completedAt: status === "completed" ? new Date().toISOString() : undefined,
        createdAt: new Date().toISOString(),
      };
      await IDPService.updateMilestone(localUpdate);

      const res = await fetch(`${apiBase}/update-milestone`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ milestoneId, status, evidence }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`update-milestone ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as { data: { milestone: IDPMilestone } };
      return payload.data.milestone ?? localUpdate;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: idpKeys.current(vars.playerId) });
    },
  });
}

// ── Mutation: checkin ───────────────────────────────────────────────
interface CheckinInput {
  planId: string;
  goalId?: string;
  reviewerId?: string;
  progressScore?: number;
  qualitativeNotes?: string;
  questionnaireAnswers?: Record<string, unknown>;
  adjustmentsProposed?: IDPCheckin["adjustmentsProposed"];
  closeMonth?: boolean;
  /** For cache invalidation */
  playerId: string;
}

export function useIDPCheckin() {
  const qc = useQueryClient();
  return useMutation<IDPCheckin, Error, CheckinInput>({
    mutationFn: async (input) => {
      const { playerId: _p, ...payload } = input;

      // Local first
      const local: IDPCheckin = {
        id: crypto.randomUUID(),
        planId: payload.planId,
        goalId: payload.goalId,
        reviewerId: payload.reviewerId,
        reviewedAt: new Date().toISOString(),
        progressScore: payload.progressScore,
        qualitativeNotes: payload.qualitativeNotes,
        questionnaireAnswers: payload.questionnaireAnswers ?? {},
        adjustmentsProposed: payload.adjustmentsProposed ?? {},
        createdAt: new Date().toISOString(),
      };
      await IDPService.saveCheckin(local);

      const res = await fetch(`${apiBase}/checkin`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`checkin ${res.status}: ${text.slice(0, 200)}`);
      }
      const result = (await res.json()) as {
        data: { checkin: IDPCheckin; monthClosed: boolean };
      };
      // If month closed, transition status locally too
      if (result.data.monthClosed) {
        await IDPService.transitionStatus(payload.planId, "completed");
      }
      return result.data.checkin ?? local;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: idpKeys.current(vars.playerId) });
      qc.invalidateQueries({ queryKey: idpKeys.history(vars.playerId, 12) });
    },
  });
}

// ── Mutation: delete plan (rare, e.g. admin tooling) ───────────────
interface DeleteInput {
  planId: string;
  playerId: string;
}
export function useDeleteIDP() {
  const qc = useQueryClient();
  return useMutation<void, Error, DeleteInput>({
    mutationFn: async ({ planId }) => {
      await IDPService.deletePlan(planId);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: idpKeys.current(vars.playerId) });
      qc.invalidateQueries({ queryKey: idpKeys.all });
    },
  });
}
