/**
 * VITAS · OvertrainingAlert (Sprint 23)
 *
 * Card alert: overtraining risk + registered load (+ suggested reduction if any).
 *
 * P1 bloque 4 (decisión del owner): es la alerta de sobrecarga que ve el usuario.
 * Sin índice de fatiga real o con la maduración NO registrada no hay riesgo ni
 * nivel: sin semáforo, con el motivo, y la carga registrada se muestra igualmente.
 * Antes pintaba «0/100» en verde sin datos y una «carga recomendada» que era la
 * misma carga actual. Textos en los 7 idiomas.
 */
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, TrendingDown, Activity, ArrowDown, Info } from "lucide-react";

interface Props {
  /** 0-100; null = sin calcular (ver gateCode). */
  risk: number | null;
  riskLevel: string | null;
  /** Carga registrada de la última sesión (UA); null si no hay. */
  currentLoadAU: number | null;
  /** Solo si algo la calcula de verdad; null = no se muestra. */
  recommendedLoadAU: number | null;
  /** negativo = reducir; null = sin ajuste calculado. */
  adjustmentPct: number | null;
  /** Por qué no hay riesgo: "maturation_unknown" | "no_data". */
  gateCode?: string | null;
  recommendations?: string[];
}

const LEVEL_CONFIG: Record<string, { color: string; bg: string; icon: string }> = {
  low:      { color: "text-emerald-400", bg: "bg-emerald-500/10", icon: "text-emerald-400" },
  moderate: { color: "text-amber-400",   bg: "bg-amber-500/10",   icon: "text-amber-400" },
  high:     { color: "text-orange-400",  bg: "bg-orange-500/10",  icon: "text-orange-400" },
  critical: { color: "text-red-400",     bg: "bg-red-500/10",     icon: "text-red-400" },
};

export default function OvertrainingAlert({
  risk, riskLevel, currentLoadAU, recommendedLoadAU, adjustmentPct, gateCode, recommendations,
}: Props) {
  const { t } = useTranslation();
  const config = riskLevel ? LEVEL_CONFIG[riskLevel] : undefined;
  const riskShown = risk !== null && config !== undefined;
  const needsReduction =
    riskShown && adjustmentPct !== null && adjustmentPct < -5 && currentLoadAU !== null && recommendedLoadAU !== null;

  return (
    <div className="glass rounded-xl p-4 space-y-3" data-testid="overtraining-alert">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
          {t("overtrainingAlert.title")}
        </span>
        {riskShown && (
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${config.bg}`}>
            <AlertTriangle size={10} className={config.icon} />
            <span className={`text-[10px] font-bold ${config.color}`}>{risk}/100</span>
          </div>
        )}
      </div>

      {!riskShown && (
        <p
          className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed"
          data-testid="overtraining-not-computed"
        >
          <Info size={12} className="shrink-0 mt-0.5" />
          {gateCode === "maturation_unknown"
            ? t("overtrainingAlert.maturationUnknown")
            : t("overtrainingAlert.noData")}
        </p>
      )}

      {/* Carga registrada (se muestra aunque no haya semáforo) */}
      <div className={`grid gap-3 ${recommendedLoadAU !== null && riskShown ? "grid-cols-2" : "grid-cols-1"}`}>
        <div className="bg-white/5 rounded-lg p-3 text-center">
          <Activity size={14} className="text-muted-foreground mx-auto mb-1" />
          <div className="text-[8px] uppercase text-muted-foreground font-bold">{t("overtrainingAlert.lastSessionLoad")}</div>
          {currentLoadAU !== null ? (
            <>
              <div className={`text-lg font-black font-mono ${needsReduction ? "text-orange-400" : "text-foreground"}`}>
                {currentLoadAU}
              </div>
              <div className="text-[8px] text-muted-foreground">{t("overtrainingAlert.units")}</div>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground italic mt-1">{t("overtrainingAlert.noLoad")}</div>
          )}
        </div>
        {recommendedLoadAU !== null && riskShown && (
          <div className="bg-white/5 rounded-lg p-3 text-center">
            <TrendingDown size={14} className="text-muted-foreground mx-auto mb-1" />
            <div className="text-[8px] uppercase text-muted-foreground font-bold">{t("overtrainingAlert.recommended")}</div>
            <div className="text-lg font-black font-mono text-emerald-400">{recommendedLoadAU}</div>
            <div className="text-[8px] text-muted-foreground">{t("overtrainingAlert.units")}</div>
          </div>
        )}
      </div>

      {/* Adjustment */}
      {needsReduction && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-2 rounded-lg p-2.5 ${config.bg}`}
        >
          <ArrowDown size={14} className={config.color} />
          <div>
            <p className={`text-xs font-bold ${config.color}`}>
              {t("overtrainingAlert.reduceBy", { pct: Math.abs(adjustmentPct as number) })}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {t("overtrainingAlert.fromTo", { from: currentLoadAU, to: recommendedLoadAU })}
            </p>
          </div>
        </motion.div>
      )}

      {/* Recommendations */}
      {riskShown && recommendations && recommendations.length > 0 && (
        <div className="space-y-1">
          {recommendations.map((rec, i) => (
            <p key={i} className="text-[10px] text-muted-foreground flex items-start gap-1.5">
              <span className="text-muted-foreground/50 shrink-0">•</span>
              {rec}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
