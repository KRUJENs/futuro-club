/**
 * VITAS · Fatigue Panel
 *
 * Displays fatigue analysis results in the VitasLab results panel:
 * - Fatigue Index gauge (0-100 with color zones)
 * - Metabolic power bar chart per window
 * - ACWR indicator with zone coloring
 * - Posture signal badges
 * - Active alerts
 * - 1st vs 2nd half comparison
 */

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  Battery,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Brain,
  TrendingDown,
  Zap,
  Shield,
  Heart,
} from "lucide-react";
import type { FatigueReport } from "@/lib/fatigue/types";
import { bandDescription, maturationKnown } from "@/lib/fatigue/phvFatigueAdjuster";

interface FatiguePanelProps {
  report: FatigueReport | null;
  compact?: boolean;
}

export default function FatiguePanel({ report, compact = false }: FatiguePanelProps) {
  const { t } = useTranslation();
  if (!report) {
    return (
      <div className="glass rounded-xl p-4 border border-border">
        <div className="flex items-center gap-2 mb-2">
          <Activity size={16} className="text-muted-foreground" />
          <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
            {t("fatiguePanel.fatigueLabel")}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("fatiguePanel.noDataPrompt")}
        </p>
      </div>
    );
  }

  const { fatigueIndex, windows, posture, acwr, thresholds, alerts } = report;
  const fi = fatigueIndex;
  // P1 bloque 4 (decisión del owner): sin maduración registrada no hay semáforo de
  // riesgo (índice, zona ACWR, alertas). Se muestra la carga y un aviso. Informes
  // guardados antes del bloque 4 marcaban "post_phv" sin offset: también desconocida.
  const maturationUnknown = !maturationKnown(thresholds.band, thresholds.phvOffset);
  const fiShown = fi.value !== null && fi.severity !== null && !maturationUnknown;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-primary" />
          <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-primary">
            {t("fatiguePanel.fatigueAnalysis")}
          </span>
        </div>
        {thresholds.adjusted && !maturationUnknown && (
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 font-display font-semibold">
            PHV ADJUSTED
          </span>
        )}
      </div>

      {/* ── Maduración no registrada: sin semáforo, la carga sí se muestra ── */}
      {maturationUnknown && (
        <div
          className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200"
          data-testid="fatigue-maturation-unknown"
        >
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="text-[10px] font-display font-semibold text-amber-800">
              {t("fatiguePanel.maturationUnknownTitle")}
            </span>
            <p className="text-[9px] text-amber-800 leading-relaxed">
              {t("fatiguePanel.maturationUnknownBody")}{" "}
              {t("fatiguePanel.countingDefinitions", {
                sprint: (thresholds.sprintThresholdMs * 3.6).toFixed(1),
                hid: (thresholds.highIntensityThresholdMs * 3.6).toFixed(1),
              })}
            </p>
          </div>
        </div>
      )}

      {/* ── Fatigue Index Gauge ── */}
      <div className="glass rounded-xl p-4 border border-border">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
            {t("fatiguePanel.fatigueIndex")}
          </span>
          {fiShown && <SeverityBadge severity={fi.severity as string} />}
        </div>

        {fiShown ? (
          <>
            {/* Gauge bar */}
            <div className="relative h-4 rounded-full overflow-hidden bg-muted mb-2">
              {/* Zone backgrounds */}
              <div className="absolute inset-0 flex">
                <div className="w-1/4 bg-green-500/20" />
                <div className="w-1/4 bg-yellow-500/20" />
                <div className="w-1/4 bg-orange-500/20" />
                <div className="w-1/4 bg-red-500/20" />
              </div>
              {/* Fill */}
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, fi.value as number)}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }}
                className={`absolute inset-y-0 left-0 rounded-full ${severityColor(fi.severity as string)}`}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className={`font-display font-bold text-2xl ${severityTextColor(fi.severity as string)}`}>
                {(fi.value as number).toFixed(0)}
                <span className="text-xs text-muted-foreground font-normal">/100</span>
              </span>
              <span className="text-[9px] text-muted-foreground">{t("fatiguePanel.sufficientData")}</span>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground italic" data-testid="fatigue-index-not-computed">
            {maturationUnknown
              ? t("fatiguePanel.fiNotComputedMaturity")
              : !fi.reliable
                ? t("fatiguePanel.fiTooShort", { count: fi.minimumMinutesRequired })
                : t("fatiguePanel.fiNoComponents")}
          </p>
        )}

        {/* Component breakdown (mini bars) */}
        {!compact && (
          <div className="grid grid-cols-5 gap-1 mt-3">
            {(
              [
                { key: "sprintDecay", label: "Sprint", icon: Zap },
                { key: "speedDecay", label: t("fatiguePanel.speed"), icon: TrendingDown },
                { key: "hidDecay", label: "HID", icon: Activity },
                { key: "metabolicDecay", label: t("fatiguePanel.metabolic"), icon: Battery },
                { key: "accelDecay", label: "Accel", icon: Activity },
              ] as const
            ).map(({ key, label }) => (
              <div key={key} className="text-center">
                <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-1">
                  <div
                    className={`h-full rounded-full ${!fiShown ? "bg-primary/40" : fi.components[key] > 50 ? "bg-red-500" : fi.components[key] > 25 ? "bg-yellow-500" : "bg-green-500"}`}
                    style={{ width: `${Math.min(100, fi.components[key])}%` }}
                  />
                </div>
                <span className="text-[8px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Window Metrics (bar chart) ── */}
      {!compact && windows.length > 0 && (
        <div className="glass rounded-xl p-4 border border-border">
          <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3 block">
            {t("fatiguePanel.loadPerWindow", { count: report.sessionDurationMin })}
          </span>
          <div className="flex items-end gap-1 h-24">
            {windows.map((w, i) => {
              const maxDist = Math.max(...windows.map(ww => ww.distanceM), 1);
              const height = (w.distanceM / maxDist) * 100;
              const maxMp = Math.max(...windows.map(ww => ww.metabolicPowerWkg), 1);
              const mpPct = w.metabolicPowerWkg / maxMp;

              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full relative" style={{ height: "100%" }}>
                    <div
                      className={`absolute bottom-0 w-full rounded-t ${mpPct > 0.8 ? "bg-red-500/60" : mpPct > 0.5 ? "bg-yellow-500/60" : "bg-primary/40"}`}
                      style={{ height: `${height}%` }}
                    />
                  </div>
                  <span className="text-[7px] text-muted-foreground tabular-nums">
                    {w.startMinute}'
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between mt-2 text-[8px] text-muted-foreground">
            <span>{t("fatiguePanel.totalDistance")}: {windows.reduce((s, w) => s + w.distanceM, 0).toFixed(0)}m</span>
            <span>{t("fatiguePanel.sprints")}: {windows.reduce((s, w) => s + w.sprintCount, 0)}</span>
            <span>HMLD: {windows.reduce((s, w) => s + w.hmldM, 0).toFixed(0)}m</span>
          </div>
        </div>
      )}

      {/* ── 1st vs 2nd Half Comparison ── */}
      {!compact && fi.decay.sprintDecayPct !== null && (
        <div className="glass rounded-xl p-4 border border-border">
          <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3 block">
            {t("fatiguePanel.firstVsSecondHalf")}
          </span>
          <div className="space-y-2">
            {[
              { label: "Sprints", value: fi.decay.sprintDecayPct, unit: "%" },
              { label: t("fatiguePanel.maxSpeed"), value: fi.decay.speedDecayPct, unit: "%" },
              { label: t("fatiguePanel.highIntensityDistance"), value: fi.decay.hidDecayPct, unit: "%" },
              { label: t("fatiguePanel.metabolicPower"), value: fi.decay.metabolicDecayPct, unit: "%" },
              { label: t("fatiguePanel.accelerations"), value: fi.decay.accelDecayPct, unit: "%" },
            ].map(({ label, value }) => (
              value !== null && (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                  <span className={`text-[11px] font-display font-bold tabular-nums ${maturationUnknown ? "text-foreground" : value < -20 ? "text-red-400" : value < -5 ? "text-yellow-400" : "text-green-400"}`}>
                    {value > 0 ? "+" : ""}{value.toFixed(1)}%
                  </span>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {/* ── ACWR ── */}
      {acwr && (
        <div className="glass rounded-xl p-4 border border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-muted-foreground" />
              <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
                {t("fatiguePanel.acwrTitle")}
              </span>
            </div>
            {acwr.zone !== null && !maturationUnknown && <ACWRBadge zone={acwr.zone} />}
          </div>
          {acwr.value === null ? (
            // Sin ratio (menos de 4 sesiones o sin carga crónica): nunca un 0 ni «óptimo».
            <p className="text-[10px] text-muted-foreground italic" data-testid="acwr-not-computed">
              {acwr.chronicLoad === null
                ? t("fatiguePanel.acwrUnreliable", { count: acwr.sessionsUsed })
                : t("fatiguePanel.acwrNoChronic")}
            </p>
          ) : acwr.zone === null || maturationUnknown ? (
            // Carga SIN semáforo: el ratio se muestra, la zona de riesgo no.
            <div className="space-y-1">
              <span className="font-display font-bold text-xl text-foreground tabular-nums">
                {acwr.value.toFixed(2)}
              </span>
              <p className="text-[9px] text-muted-foreground leading-relaxed" data-testid="acwr-no-zone">
                {t("fatiguePanel.acwrNoZone")}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className={`font-display font-bold text-xl ${acwrTextColor(acwr.zone)}`}>
                  {acwr.value.toFixed(2)}
                </span>
                <div className="flex-1">
                  {/* Mini gauge */}
                  <div className="relative h-2 rounded-full overflow-hidden bg-muted">
                    <div className="absolute left-[40%] right-[35%] h-full bg-green-500/30" />
                    <div
                      className={`absolute top-0 bottom-0 w-1 rounded-full ${acwrTextColor(acwr.zone)}`}
                      style={{
                        left: `${Math.min(100, Math.max(0, (acwr.value / 2) * 100))}%`,
                        backgroundColor: "currentColor",
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[7px] text-muted-foreground mt-0.5">
                    <span>0.0</span>
                    <span>0.8</span>
                    <span>1.3</span>
                    <span>2.0</span>
                  </div>
                </div>
              </div>
              {acwr.recommendation && (
                <p className="text-[9px] text-muted-foreground mt-2 leading-relaxed">
                  {acwr.recommendation}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Posture Signals ── */}
      {posture && posture.signals.filter(s => s.active).length > 0 && (
        <div className="glass rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={14} className="text-muted-foreground" />
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
              {t("fatiguePanel.posturalSignals")}
            </span>
          </div>
          <div className="space-y-2">
            {posture.signals.filter(s => s.active).map((signal) => (
              <div
                key={signal.type}
                className="flex items-start gap-2 p-2 rounded-lg bg-orange-500/5 border border-orange-500/20"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-orange-400 mt-1.5 shrink-0" />
                <div>
                  <span className="text-[10px] font-display font-semibold text-orange-300">
                    {signalLabel(signal.type, t)}
                  </span>
                  <p className="text-[9px] text-muted-foreground leading-relaxed">
                    {signal.description}
                  </p>
                </div>
                {!maturationUnknown && (
                  <span className="text-[9px] text-orange-400 ml-auto shrink-0 font-display tabular-nums">
                    {(signal.severity * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Alerts ── */}
      {alerts.length > 0 && !maturationUnknown && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 p-3 rounded-xl border ${alertStyle(alert.level)}`}
            >
              {alert.level === "danger" ? (
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              ) : (
                <Heart size={14} className="text-yellow-400 shrink-0 mt-0.5" />
              )}
              <div>
                <span className="text-[10px] font-display font-bold text-foreground">
                  {alert.title}
                  {alert.phvAdjusted && (
                    <span className="ml-1 text-[8px] text-purple-400 font-normal">PHV</span>
                  )}
                </span>
                <p className="text-[9px] text-muted-foreground leading-relaxed mt-0.5">
                  {alert.message}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── PHV Band Info ── */}
      {thresholds.adjusted && !maturationUnknown && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-purple-500/5 border border-purple-500/20">
          <div className="w-2 h-2 rounded-full bg-purple-400 mt-1 shrink-0" />
          <div>
            <span className="text-[10px] font-display font-semibold text-purple-300">
              {t("fatiguePanel.maturationAdjustedThresholds")}
            </span>
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              {bandDescription(thresholds.band)}.
              Sprint: {(thresholds.sprintThresholdMs * 3.6).toFixed(1)} km/h ·
              {" "}{t("fatiguePanel.acwrDanger")}: ≥{thresholds.acwrDangerThreshold} ·
              {" "}{t("fatiguePanel.metabolic")}: {thresholds.metabolicWarningWkg.toFixed(1)} W/kg
            </p>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Helper Components & Functions ──────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useTranslation();
  const styles: Record<string, string> = {
    normal: "bg-green-500/10 text-green-400",
    moderate: "bg-yellow-500/10 text-yellow-400",
    high: "bg-orange-500/10 text-orange-400",
    critical: "bg-red-500/10 text-red-400",
  };
  const labels: Record<string, string> = {
    normal: t("fatiguePanel.severityNormal"),
    moderate: t("fatiguePanel.severityModerate"),
    high: t("fatiguePanel.severityHigh"),
    critical: t("fatiguePanel.severityCritical"),
  };
  return (
    <span className={`text-[9px] px-2 py-0.5 rounded-full font-display font-semibold ${styles[severity] ?? styles.normal}`}>
      {labels[severity] ?? severity}
    </span>
  );
}

function ACWRBadge({ zone }: { zone: string }) {
  const { t } = useTranslation();
  const styles: Record<string, string> = {
    optimal: "bg-green-500/10 text-green-400",
    caution: "bg-yellow-500/10 text-yellow-400",
    danger: "bg-red-500/10 text-red-400",
    undertrained: "bg-blue-500/10 text-blue-400",
  };
  const labels: Record<string, string> = {
    optimal: t("fatiguePanel.acwrOptimal"),
    caution: t("fatiguePanel.acwrCaution"),
    danger: t("fatiguePanel.acwrDangerZone"),
    undertrained: t("fatiguePanel.acwrUndertrained"),
  };
  return (
    <span className={`text-[9px] px-2 py-0.5 rounded-full font-display font-semibold ${styles[zone] ?? styles.optimal}`}>
      {labels[zone] ?? zone}
    </span>
  );
}

function severityColor(severity: string): string {
  switch (severity) {
    case "normal": return "bg-green-500";
    case "moderate": return "bg-yellow-500";
    case "high": return "bg-orange-500";
    case "critical": return "bg-red-500";
    default: return "bg-green-500";
  }
}

function severityTextColor(severity: string): string {
  switch (severity) {
    case "normal": return "text-green-400";
    case "moderate": return "text-yellow-400";
    case "high": return "text-orange-400";
    case "critical": return "text-red-400";
    default: return "text-green-400";
  }
}

function acwrTextColor(zone: string): string {
  switch (zone) {
    case "optimal": return "text-green-400";
    case "caution": return "text-yellow-400";
    case "danger": return "text-red-400";
    case "undertrained": return "text-blue-400";
    default: return "text-green-400";
  }
}

function alertStyle(level: string): string {
  switch (level) {
    case "danger": return "bg-red-500/5 border-red-500/30";
    case "warning": return "bg-yellow-500/5 border-yellow-500/30";
    default: return "bg-blue-500/5 border-blue-500/30";
  }
}

function signalLabel(type: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    hands_on_knees: t("fatiguePanel.signalHandsOnKnees"),
    trunk_lean_increase: t("fatiguePanel.signalTrunkLeanIncrease"),
    stride_shortening: t("fatiguePanel.signalStrideShortening"),
    recovery_time_increase: t("fatiguePanel.signalRecoveryTimeIncrease"),
    arm_swing_decay: t("fatiguePanel.signalArmSwingDecay"),
    head_drop: t("fatiguePanel.signalHeadDrop"),
  };
  return labels[type] ?? type;
}
