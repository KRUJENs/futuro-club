/**
 * VITAS · IDPParentView
 *
 * Vista simplificada del IDP para el padre. Lenguaje no-técnico, métricas
 * con barras de progreso simples, sin terminología deportiva avanzada.
 * Usada en /family/:playerId.
 */

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Target, TrendingUp, Calendar } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { DevelopmentPlan, IDPDimension } from "@/lib/idp/idpTypes";
import { computeGoalProgress, daysRemainingInMonth } from "@/lib/idp";
import { isLegacyIdpPlan } from "@/lib/idp/legacyPlan";

interface Props {
  plan: DevelopmentPlan;
  playerName?: string;
}

const FRIENDLY_LABELS: Record<IDPDimension, { label: string; emoji: string }> = {
  technical:  { label: "Habilidad con el balón",       emoji: "⚽" },
  tactical:   { label: "Lectura del juego",            emoji: "🧭" },
  physical:   { label: "Condición física",             emoji: "💪" },
  mental:     { label: "Mentalidad y decisiones",      emoji: "🧠" },
  maturation: { label: "Cuidado del crecimiento",      emoji: "🌱" },
};

export function IDPParentView({ plan, playerName }: Props) {
  const { t } = useTranslation();
  const goals = plan.goals ?? [];
  const days = daysRemainingInMonth(plan.monthEnd);
  const monthLabel = new Date(plan.monthStart).toLocaleDateString("es", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="space-y-5">
      {/* Plan generado antes del 5d (P1 bloque 7): puede traer metas o bases de relleno. */}
      {isLegacyIdpPlan(plan) && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900">
          {t("idpLegacy.notice")}
        </p>
      )}
      {/* Header amigable */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"
      >
        <div className="flex items-center gap-2 mb-2">
          <Target className="size-4 text-emerald-400" />
          <h3 className="text-sm font-medium text-emerald-200">
            {t("idpParentView.planOf", { name: playerName ?? t("idpParentView.yourChild") })} · {monthLabel}
          </h3>
        </div>
        {plan.overallFocus && (
          <p className="text-sm text-slate-200 leading-relaxed">{plan.overallFocus}</p>
        )}
        <div className="flex items-center gap-3 mt-3 text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <Calendar className="size-3" />
            {days > 0 ? t("idpParentView.daysRemaining", { count: days }) : t("idpParentView.monthEnded")}
          </span>
          <span>·</span>
          <span>{t("idpParentView.goalsThisMonth", { count: goals.length })}</span>
        </div>
      </motion.div>

      {/* Goals simplificados */}
      <div className="space-y-3">
        <h4 className="text-xs uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <TrendingUp className="size-3" />
          {t("idpParentView.whatWeAreWorkingOn")}
        </h4>

        {goals.map((g, i) => {
          const meta = FRIENDLY_LABELS[g.dimension];
          const progress = computeGoalProgress(g, g.currentValue ?? g.baselineMetric.value);
          const completed = progress >= 100 || g.status === "achieved";
          return (
            <motion.div
              key={g.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              className="rounded-lg border border-white/10 bg-white/[0.02] p-3"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">{meta.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    {meta.label}
                  </div>
                  <div className="text-sm text-white font-medium leading-tight">{g.title}</div>
                </div>
                {completed && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
                    {t("idpParentView.achieved")}
                  </span>
                )}
              </div>
              <div className="space-y-1">
                <Progress value={progress} className="h-1.5" />
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>{t("idpParentView.start")}</span>
                  <span className="font-medium text-slate-300">{t("idpParentView.percentOfGoal", { percent: progress })}</span>
                  <span>{t("idpParentView.target")}</span>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Mensaje motivacional */}
      {goals.length > 0 && (
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-cyan-200/90">
          💡 {t("idpParentView.motivationalIntro", { name: playerName ?? t("idpParentView.yourChild") })}
          {goals[0]?.dimension && FRIENDLY_LABELS[goals[0].dimension]
            ? ` "${FRIENDLY_LABELS[goals[0].dimension].label.toLowerCase()}"`
            : ` ${t("idpParentView.thesePoints")}`}.
        </div>
      )}
    </div>
  );
}
