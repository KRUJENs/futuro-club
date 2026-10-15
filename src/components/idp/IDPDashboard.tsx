/**
 * VITAS · IDPDashboard
 *
 * Componente principal del módulo IDP para coaches. Integra:
 *   - header con foco del mes + status del plan
 *   - tabs: Objetivos / Cronograma / Drills / Progreso / Checkin
 *   - acciones primarias: generar plan / aprobar / checkin / regenerar
 *   - feature gate Pro+ se maneja en la página parent
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  Sparkles, ClipboardCheck, Calendar, TrendingUp,
  ListChecks, Loader2, Check, AlertCircle, RefreshCw, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

import {
  useCurrentIDP,
  useGenerateIDP,
  useApproveIDP,
  useUpdateIDPGoal,
  useUpdateIDPMilestone,
  useIDPCheckin,
  useIDPProgressSummary,
} from "@/hooks/useIDP";
import { useIDPDailyChecks } from "@/hooks/useIDPDailyChecks";
import { IDPGoalCard } from "./IDPGoalCard";
import { IDPTimeline } from "./IDPTimeline";
import { IDPDrillRecommendations } from "./IDPDrillRecommendations";
import { IDPProgressChart } from "./IDPProgressChart";
import { IDPCheckinForm } from "./IDPCheckinForm";
import { IDPDataRichnessBanner } from "./IDPDataRichnessBanner";
import { IDPVideoUploadDialog } from "./IDPVideoUploadDialog";
import type { IDPArchitectInput, IDPGoal } from "@/lib/idp/idpTypes";
import { idpDimensionsWithData } from "@/lib/idp/idpGoalGenerator";
import type { IDPDataRichness } from "@/hooks/useIDPArchitectInput";

interface Props {
  playerId: string;
  playerName?: string;
  /** Inputs to feed the architect when generating a new plan */
  architectInput: IDPArchitectInput;
  /** Coach user_id, for approval/checkin metadata */
  coachId?: string;
  tenantId?: string;
  /** Live metrics dict (vsi_technical, mental_composite, etc.) to compute progress */
  liveMetrics?: Record<string, number>;
  /** Data richness meta — drives the "enrich your dataset" banner */
  dataRichness?: IDPDataRichness;
}

export function IDPDashboard({
  playerId,
  playerName,
  architectInput,
  coachId,
  tenantId,
  liveMetrics = {},
  dataRichness,
}: Props) {
  const { t } = useTranslation();
  const { data: plan, isLoading } = useCurrentIDP(playerId);
  const summary = useIDPProgressSummary(plan, liveMetrics);

  // Daily checks: fires checkin reminder + plan-expired notifications.
  // The service internally dedupes (max 1 per plan).
  useIDPDailyChecks({ plan, playerName });

  const generate = useGenerateIDP();
  const approve = useApproveIDP();
  const updateGoal = useUpdateIDPGoal();
  const updateMilestone = useUpdateIDPMilestone();
  const checkin = useIDPCheckin();

  const [tab, setTab] = useState<"goals" | "timeline" | "drills" | "progress" | "checkin">("goals");
  const [highlightGoalId, setHighlightGoalId] = useState<string | undefined>();
  const [videoModalOpen, setVideoModalOpen] = useState(false);

  const monthLabel = useMemo(() => {
    const d = plan?.monthStart ? new Date(plan.monthStart) : new Date();
    return d.toLocaleDateString("es", { month: "long", year: "numeric" });
  }, [plan?.monthStart]);

  const noDimensionData = !architectInput || idpDimensionsWithData(architectInput).length === 0;

  async function handleGenerate() {
    try {
      await generate.mutateAsync({ architectInput, coachId, tenantId });
      toast.success(t("idpDashboard.toastPlanGenerated"));
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      toast.error(t("idpDashboard.toastPlanGenerateError"), {
        description: code === "idp_no_dimension_data"
          ? t("idpDashboard.noDimensionData")
          : err instanceof Error ? err.message : t("idpDashboard.errorUnknown"),
      });
    }
  }

  async function handleApprove() {
    if (!plan) return;
    try {
      await approve.mutateAsync({ planId: plan.id, coachId, playerId });
      toast.success(t("idpDashboard.toastPlanApproved"));
    } catch (err) {
      toast.error(t("idpDashboard.toastApproveError"), {
        description: err instanceof Error ? err.message : t("idpDashboard.errorUnknown"),
      });
    }
  }

  async function handleMarkGoal(goal: IDPGoal, status: IDPGoal["status"]) {
    if (!plan) return;
    try {
      await updateGoal.mutateAsync({
        goalId: goal.id,
        planId: plan.id,
        playerId,
        status,
      });
      toast.success(t("idpDashboard.toastGoalMarked", { status }));
    } catch (err) {
      toast.error(t("idpDashboard.toastUpdateError"), {
        description: err instanceof Error ? err.message : t("idpDashboard.error"),
      });
    }
  }

  // ── Empty state ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="size-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="space-y-4">
        {dataRichness && (
          <IDPDataRichnessBanner
            playerId={playerId}
            data={dataRichness}
            onUploadVideo={() => setVideoModalOpen(true)}
          />
        )}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center"
      >
        <Sparkles className="size-8 text-cyan-400 mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-white mb-2">
          {t("idpDashboard.emptyTitle", { month: monthLabel })}
        </h3>
        <p className="text-sm text-slate-400 max-w-md mx-auto mb-5">
          {t("idpDashboard.emptyDescription")}
        </p>
        {/* Sin ninguna dimensión con dato no se ofrece generar (P1 5d, revisión del #320):
            antes salía un plan vacío con un «foco del mes» inventado. */}
        {noDimensionData && (
          <p className="text-xs text-amber-500 max-w-md mx-auto mb-4" data-testid="idp-no-dimension-data">
            {t("idpDashboard.noDimensionData")}
          </p>
        )}
        <Button onClick={handleGenerate} disabled={generate.isPending || noDimensionData} size="lg">
          {generate.isPending ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              {t("idpDashboard.generating")}
            </>
          ) : (
            <>
              <Sparkles className="size-4 mr-2" />
              {t("idpDashboard.generateMonthPlan")}
            </>
          )}
        </Button>
      </motion.div>
      </div>
    );
  }

  // ── Plan exists ──
  const isDraft = plan.status === "draft";
  const isActive = plan.status === "active";
  const isCompleted = plan.status === "completed";

  return (
    <div className="space-y-5">
      {/* Data richness banner — visible cuando faltan fuentes (video/PHV/BPE/salud) */}
      {dataRichness && (
        <IDPDataRichnessBanner playerId={playerId} data={dataRichness} />
      )}

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-white/10 bg-gradient-to-br from-cyan-500/5 via-transparent to-purple-500/5 p-4"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Badge
                variant="outline"
                className={
                  isActive
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    : isDraft
                      ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                      : "bg-slate-500/10 text-slate-300 border-slate-500/30"
                }
              >
                {isActive && <Check className="size-3 mr-1 inline" />}
                {isDraft && <AlertCircle className="size-3 mr-1 inline" />}
                {isActive ? t("idpDashboard.statusActive") : isDraft ? t("idpDashboard.statusDraft") : t("idpDashboard.statusCompleted")}
              </Badge>
              <span className="text-xs text-slate-500 capitalize">{monthLabel}</span>
              {summary && (
                <span className="text-xs text-slate-500">
                  {t("idpDashboard.daysRemaining", { count: summary.daysRemaining })}
                </span>
              )}
              {/* Checkin window badge (≤7 días al fin de mes, plan activo, sin checkin todavía) */}
              {summary &&
                isActive &&
                summary.daysRemaining <= 7 &&
                summary.daysRemaining >= 0 &&
                !(plan.checkins ?? []).some((c) => !c.goalId) && (
                  <button
                    onClick={() => setTab("checkin")}
                    className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors animate-pulse"
                  >
                    {t("idpDashboard.doCheckinBadge")}
                  </button>
                )}
            </div>
            <h2 className="text-base font-semibold text-white leading-tight">
              {plan.overallFocus ?? t("idpDashboard.defaultFocus")}
            </h2>
            {plan.agentSummary && (
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed line-clamp-2">
                {plan.agentSummary}
              </p>
            )}
          </div>

          <div className="flex gap-2 shrink-0">
            {isDraft && (
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={approve.isPending}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {approve.isPending ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Check className="size-3.5 mr-1" />}
                {t("idpDashboard.approvePlan")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setVideoModalOpen(true)}
              className="border-cyan-500/30 hover:bg-cyan-500/10"
            >
              <Video className="size-3.5 mr-1" />
              {t("idpDashboard.uploadVideo")}
            </Button>
            {!isCompleted && (
              <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generate.isPending}>
                <RefreshCw className={`size-3.5 mr-1 ${generate.isPending ? "animate-spin" : ""}`} />
                {t("idpDashboard.regenerate")}
              </Button>
            )}
          </div>
        </div>

        {/* Mini stats */}
        {summary && (
          <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-white/5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{t("idpDashboard.overallProgress")}</div>
              <div className="text-xl font-bold text-white tabular-nums">{summary.overallProgress === null ? "—" : `${summary.overallProgress}%`}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{t("idpDashboard.achieved")}</div>
              <div className="text-xl font-bold text-emerald-400 tabular-nums">
                {summary.goalsAchieved}<span className="text-sm text-slate-500">/{summary.goalsTotal}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{t("idpDashboard.atRisk")}</div>
              <div className="text-xl font-bold text-rose-400 tabular-nums">
                {summary.atRiskGoals.length}
              </div>
            </div>
          </div>
        )}
      </motion.div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="w-full">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="goals" className="text-xs">
            <ListChecks className="size-3.5 mr-1" />
            {t("idpDashboard.tabGoals")}
          </TabsTrigger>
          <TabsTrigger value="timeline" className="text-xs">
            <Calendar className="size-3.5 mr-1" />
            {t("idpDashboard.tabTimeline")}
          </TabsTrigger>
          <TabsTrigger value="drills" className="text-xs">
            <ClipboardCheck className="size-3.5 mr-1" />
            {t("idpDashboard.tabDrills")}
          </TabsTrigger>
          <TabsTrigger value="progress" className="text-xs">
            <TrendingUp className="size-3.5 mr-1" />
            {t("idpDashboard.tabProgress")}
          </TabsTrigger>
          <TabsTrigger value="checkin" className="text-xs" disabled={!isActive}>
            <Check className="size-3.5 mr-1" />
            {t("idpDashboard.tabCheckin")}
          </TabsTrigger>
        </TabsList>

        {/* Objetivos */}
        <TabsContent value="goals" className="space-y-3 mt-4">
          {(plan.goals ?? []).map((g) => (
            <IDPGoalCard
              key={g.id}
              goal={g}
              liveMetric={liveMetrics[g.baselineMetric.metric]}
              editable
              onMarkAchieved={(goal) => handleMarkGoal(goal, "achieved")}
              onMarkMissed={(goal) => handleMarkGoal(goal, "missed")}
            />
          ))}
        </TabsContent>

        {/* Cronograma */}
        <TabsContent value="timeline" className="mt-4">
          <div className="flex flex-wrap gap-1 mb-3">
            <button
              onClick={() => setHighlightGoalId(undefined)}
              className={`text-xs px-2.5 py-1 rounded-md border ${
                !highlightGoalId
                  ? "bg-cyan-500/15 border-cyan-400/40 text-cyan-200"
                  : "bg-white/5 border-white/10 text-slate-400"
              }`}
            >
              {t("idpDashboard.filterAll")}
            </button>
            {(plan.goals ?? []).map((g) => (
              <button
                key={g.id}
                onClick={() => setHighlightGoalId(g.id)}
                className={`text-xs px-2.5 py-1 rounded-md border ${
                  highlightGoalId === g.id
                    ? "bg-cyan-500/15 border-cyan-400/40 text-cyan-200"
                    : "bg-white/5 border-white/10 text-slate-400"
                }`}
              >
                {g.title.slice(0, 30)}
              </button>
            ))}
          </div>
          <IDPTimeline
            milestones={plan.milestones ?? []}
            highlightGoalId={highlightGoalId}
            onSelect={(m) => {
              const next = m.status === "completed" ? "pending" : "completed";
              updateMilestone.mutate({
                milestoneId: m.id,
                status: next,
                planId: plan.id,
                playerId,
              });
            }}
          />
        </TabsContent>

        {/* Drills */}
        <TabsContent value="drills" className="mt-4">
          <IDPDrillRecommendations goals={plan.goals ?? []} />
        </TabsContent>

        {/* Progreso */}
        <TabsContent value="progress" className="mt-4">
          {summary && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <h3 className="text-sm font-medium text-white mb-3">{t("idpDashboard.progressByDimension")}</h3>
              <IDPProgressChart summary={summary} />
            </div>
          )}
        </TabsContent>

        {/* Checkin */}
        <TabsContent value="checkin" className="mt-4">
          <IDPCheckinForm
            plan={plan}
            reviewerId={coachId}
            submitting={checkin.isPending}
            onSubmit={(payload) => {
              checkin
                .mutateAsync({ ...payload, playerId })
                .then(() => toast.success(t("idpDashboard.toastCheckinSaved")))
                .catch((err) =>
                  toast.error(t("idpDashboard.toastSaveError"), {
                    description: err instanceof Error ? err.message : t("idpDashboard.error"),
                  }),
                );
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Inline video upload modal — triggered from the data richness banner */}
      <IDPVideoUploadDialog
        open={videoModalOpen}
        onClose={() => setVideoModalOpen(false)}
        playerId={playerId}
        playerName={playerName}
        onAnalysisComplete={() => {
          // Banner refreshes automatically via TanStack Query invalidation.
          // Optionally we could auto-regenerate the plan here:
          //   handleGenerate();
          // but leaving the choice to the coach is safer.
        }}
      />
    </div>
  );
}
