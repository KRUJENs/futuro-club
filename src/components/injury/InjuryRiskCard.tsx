/**
 * InjuryRiskCard — tarjeta de riesgo de lesión (Sprint 10 · rehecha en el P1 bloque 4b)
 *
 * Pinta el informe de `api/agents/_injury-risk-calculator.ts` (v2):
 * - el riesgo compuesto SOLO si el modelo lo calculó; si no, el motivo (nunca un
 *   número por defecto ni un «bajo» de relleno);
 * - cada factor con su dato o su motivo («sin dato» / «no aplica»);
 * - la procedencia («Calculado», pesos pendientes de validar) y la confianza;
 * - nunca «Apto para actividad completa»: si hay una lesión registrada, se dice
 *   cuándo fue y que el alta la decide el médico o el fisioterapeuta.
 * Textos en los 7 idiomas (antes, todo en español escrito a mano).
 */

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Shield, AlertTriangle, TrendingUp, Activity, Bone, Dumbbell, Flame, Info, ChevronRight, Stethoscope } from "lucide-react";
import InjuryRiskGauge from "./InjuryRiskGauge";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import { injuryRiskValue, type InjuryRiskReport, type InjuryRiskFactorKey } from "@/lib/injury/injuryRiskTypes";

/** Compatibilidad: el tipo del informe se llamaba InjuryRiskData. */
export type InjuryRiskData = InjuryRiskReport;

interface InjuryRiskCardProps {
  data: InjuryRiskReport;
  /** Compact mode for embedding in other cards */
  compact?: boolean;
  /** Click handler to navigate to full injury dashboard */
  onViewDetails?: () => void;
}

const FACTOR_ICONS: Record<InjuryRiskFactorKey, React.ElementType> = {
  acwr: Activity,
  phvWindow: Bone,
  asymmetry: Dumbbell,
  biomechanics: Dumbbell,
  injuryHistory: AlertTriangle,
  fatigue: Flame,
};

function SeverityBadge({ score }: { score: number }) {
  const { t } = useTranslation();
  const severity = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  const colors =
    severity === "high"
      ? "bg-red-500/15 text-red-600 dark:text-red-400"
      : severity === "medium"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${colors}`}>
      {t(`injuryRiskCard.severity.${severity}`)}
    </span>
  );
}

export default function InjuryRiskCard({ data, compact = false, onViewDetails }: InjuryRiskCardProps) {
  const { t } = useTranslation();
  const value = injuryRiskValue(data);
  const category = value !== null ? data.category : null;
  const confidencePct = value !== null ? Math.round(data.composite.confidence * 100) : null;

  const notComputed = (
    <div
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
      data-testid="injury-risk-not-computed"
    >
      <Info size={14} className="text-amber-600 shrink-0 mt-0.5" />
      <div>
        <p className="text-[11px] font-semibold text-amber-800">{t("injuryRiskCard.notComputedTitle")}</p>
        <p className="text-[10px] text-amber-800 leading-relaxed">{data.composite.gate_reason}</p>
      </div>
    </div>
  );

  // ── Compact mode ─────────────────────────────────────────────
  if (compact) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-xl p-4 space-y-3 border border-border/50 cursor-pointer hover:border-primary/30 transition-colors"
        onClick={onViewDetails}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary" />
            <span className="text-sm font-display font-bold text-foreground">{t("injuryRiskCard.title")}</span>
          </div>
          {value !== null && category && (
            <InjuryRiskGauge value={value} category={category} size={44} showLabel={false} compact />
          )}
        </div>
        {value === null ? notComputed : null}
        {onViewDetails && (
          <button className="flex items-center gap-1 text-[10px] text-primary font-medium">
            {t("injuryRiskCard.viewDetails")} <ChevronRight size={10} />
          </button>
        )}
      </motion.div>
    );
  }

  // ── Full mode ────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-5 space-y-5 border border-border/50"
      data-testid="injury-risk-card"
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield size={18} className="text-primary" />
            <h3 className="font-display font-bold text-base text-foreground">{t("injuryRiskCard.title")}</h3>
            {value !== null && <ProvenanceBadge provenance={data.composite.provenance} />}
          </div>
          <p className="text-xs text-muted-foreground">{t("injuryRiskCard.subtitle")}</p>
        </div>
        {value !== null && category && <InjuryRiskGauge value={value} category={category} size={100} />}
      </div>

      {value === null && notComputed}

      {/* Cold-start warning */}
      {value !== null && data.coldStartWarning && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
          <Info size={14} className="text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("injuryRiskCard.coldStart")}</p>
        </div>
      )}

      {/* Factors: cada uno con su dato, «sin dato» o «no aplica» */}
      <div className="space-y-2">
        <h4 className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider">
          {t("injuryRiskCard.factors")}
        </h4>
        <div className="space-y-1.5">
          {data.factors.map((f) => {
            const Icon = FACTOR_ICONS[f.factor] ?? TrendingUp;
            const score = f.result.value;
            return (
              <div key={f.factor} className="flex items-center gap-2 rounded-lg bg-card/50 px-3 py-2" data-testid={`injury-factor-${f.factor}`}>
                <Icon size={13} className="text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {t(`injuryRiskCard.factor.${f.factor}`)}
                    </span>
                    {!f.applicable ? (
                      <span className="text-[9px] text-muted-foreground">{t("injuryRiskCard.notApplicable")}</span>
                    ) : score !== null ? (
                      <SeverityBadge score={score} />
                    ) : (
                      <span className="text-[9px] text-muted-foreground italic">{t("injuryRiskCard.noData")}</span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {score !== null ? f.description : f.result.gate_reason}
                  </p>
                </div>
                {score !== null && f.applicable && (
                  <div className="w-12 h-1.5 rounded-full bg-secondary overflow-hidden shrink-0">
                    <motion.div
                      className="h-full rounded-full bg-primary/60"
                      initial={{ width: 0 }}
                      animate={{ width: `${score}%` }}
                      transition={{ duration: 0.8, ease: "easeOut" }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recommendations: solo existen con un riesgo calculado */}
      {data.recommendations.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider">
            {t("injuryRiskCard.recommendations")}
          </h4>
          <ul className="space-y-1.5">
            {data.recommendations.map((rec, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-foreground">
                <span className="shrink-0 mt-0.5 w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[9px] font-bold">
                  {i + 1}
                </span>
                {rec}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Ventana de crecimiento (misma definición que el Escudo de Estirón) */}
      {(data.growthShieldLevel === "peak" || data.growthShieldLevel === "high") && (
        <div className="flex items-start gap-2 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-2">
          <Bone size={14} className="text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[11px] font-medium text-orange-600 dark:text-orange-400">{t("injuryRiskCard.growthWindowTitle")}</p>
            <p className="text-[10px] text-orange-500/80">{t("injuryRiskCard.growthWindowBody")}</p>
          </div>
        </div>
      )}

      {/* Lesión registrada: nunca «apto»; el alta es clínica */}
      {data.daysSinceLastInjury !== null && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-card/50 px-3 py-2" data-testid="injury-return-note">
          <Stethoscope size={14} className="text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-foreground">
            {t("injuryRiskCard.lastInjury", { count: data.daysSinceLastInjury })} {t("injuryRiskCard.clearanceIsClinical")}
          </p>
        </div>
      )}

      {/* Footer: confianza solo con un riesgo calculado */}
      <div className="flex items-center justify-between pt-2 border-t border-border/30">
        {confidencePct !== null ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">{t("injuryRiskCard.confidence")}</span>
            <div className="w-16 h-1 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full bg-primary/60" style={{ width: `${confidencePct}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground tabular-nums">{confidencePct}%</span>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">{t("injuryRiskCard.weightsPending")}</span>
        )}
        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="flex items-center gap-1 text-[10px] text-primary font-display font-medium hover:underline"
          >
            {t("injuryRiskCard.fullDashboard")} <ChevronRight size={10} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
