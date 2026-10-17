/**
 * AdvancedMetricsPanel — Muestra VAEP / SPADL / Tracking / Biomechanics
 * calculadas desde el análisis de video de un jugador.
 *
 * Props:
 *   metrics — AdvancedPlayerMetrics (de advancedMetricsService)
 *   qualityScore — 0-1 (opcional) de videoAdvancedMetricsService.assessPacketQuality
 *   trackingSnapshot — Si existe, OVERRIDES los stubs de tracking/biomechanics
 *     con datos reales del Lab (YOLOv8n-pose). Cuando hay snapshot, deja de
 *     mostrarse "STUB - en espera de Roboflow" y aparecen métricas reales.
 */
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  TrendingUp, Activity, MapPin, Zap, AlertCircle, CheckCircle2,
} from "lucide-react";
import type { AdvancedPlayerMetrics } from "@/services/real/advancedMetricsService";
import type { TrackingSnapshot } from "@/services/real/playerTrackingService";
import type { BiomechanicsScore } from "@/lib/mediapipe/biomechanicsEngine";
import CalibrationCaveat from "@/components/CalibrationCaveat";

interface Props {
  metrics: AdvancedPlayerMetrics;
  qualityScore?: number;
  qualityIssues?: string[];
  /** Snapshot del Lab · si presente, reemplaza stubs de tracking/biomechanics */
  trackingSnapshot?: TrackingSnapshot | null;
  /** MediaPipe biomechanics · si presente, reemplaza el DrillScore heurístico con datos reales */
  mediaPipeBiomechanics?: BiomechanicsScore | null;
}

export function AdvancedMetricsPanel({ metrics, qualityScore, qualityIssues, trackingSnapshot, mediaPipeBiomechanics }: Props) {
  const { t } = useTranslation();
  const { vaep } = metrics;

  // ── Override tracking con snapshot del Lab si existe ─────────────────
  const trackingFromSnapshot = trackingSnapshot ? buildTrackingFromSnapshot(trackingSnapshot) : null;
  const tracking = trackingFromSnapshot ?? metrics.tracking;

  // ── Override biomechanics: MediaPipe real > service stub (con su motivo).
  // Sin el «DrillScore desde Lab» heurístico (P1 bloque 6): mezclaba 40/30/30 sin fuente
  // intensidad, escaneos de TODAS las pistas y un ratio de duelos que valía 50 fijo
  // cuando no había duelos (nunca los había: el ganador no se resolvía).
  const biomechanicsFromMediaPipe = mediaPipeBiomechanics ? buildBiomechanicsFromMediaPipe(mediaPipeBiomechanics) : null;
  const biomechanics = biomechanicsFromMediaPipe ?? metrics.biomechanics;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold text-sm text-foreground uppercase tracking-wider">
          {t("advancedMetricsPanel.title")}
        </h3>
        {qualityScore !== undefined && (
          <QualityBadge score={qualityScore} />
        )}
      </div>

      {/* VAEP */}
      <MetricCard
        icon={TrendingUp}
        label="VAEP"
        description={t("advancedMetricsPanel.vaepDescription")}
        status={vaep.status}
        value={vaep.vaep90 !== null ? vaep.vaep90.toFixed(2) : null}
        unit={t("advancedMetricsPanel.vaepUnit")}
        detail={vaep.status === "calculated"
          ? t("advancedMetricsPanel.vaepHighImpactActions", { count: vaep.topActions.length })
          : vaep.message}
        topActions={vaep.status === "calculated" ? vaep.topActions : undefined}
      />

      {/* Tracking (desde video) */}
      <MetricCard
        icon={MapPin}
        label={t("advancedMetricsPanel.fieldCoverageLabel")}
        description={t("advancedMetricsPanel.fieldCoverageDescription")}
        status={tracking.status}
        value={tracking.fieldCoveragePct !== null ? `${tracking.fieldCoveragePct}%` : null}
        detail={tracking.status === "calculated"
          ? t("advancedMetricsPanel.fieldCoverageDetail", { sprints: tracking.sprintCount ?? 0, distance: tracking.totalDistanceM ?? 0 })
          : tracking.message}
        extra={tracking.status === "calculated" && tracking.maxSpeedMs !== null ? (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Zap size={10} className="text-primary" />
            <span>{t("advancedMetricsPanel.maxSpeed", { speed: tracking.maxSpeedMs.toFixed(1) })}</span>
          </div>
        ) : null}
      />
      {tracking.status === "calculated" && (
        <CalibrationCaveat calibrationConfidence={trackingSnapshot?.calibrationConfidence} />
      )}

      {/* Biomechanics */}
      <MetricCard
        icon={Activity}
        label="DrillScore"
        description={t("advancedMetricsPanel.drillScoreDescription")}
        status={biomechanics.status}
        value={biomechanics.drillScore !== null ? `${biomechanics.drillScore}` : null}
        unit="/100"
        detail={biomechanics.status === "calculated"
          ? biomechanics.asymmetryPct !== null
            ? t("advancedMetricsPanel.bilateralAsymmetry", { pct: biomechanics.asymmetryPct.toFixed(1) })
            : t("advancedMetricsPanel.drillScoreCalculated")
          : biomechanics.message}
      />

      {/* Issues de calidad */}
      {qualityIssues && qualityIssues.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertCircle size={13} className="text-amber-500 shrink-0" />
            <p className="text-[11px] font-display font-semibold text-amber-500 uppercase tracking-wider">
              {t("advancedMetricsPanel.analysisLimitations")}
            </p>
          </div>
          <ul className="space-y-0.5 ml-5">
            {qualityIssues.map((issue, i) => (
              <li key={i} className="text-[10px] text-muted-foreground list-disc">
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}

// ─── Subcomponentes ──────────────────────────────────────────────────────────

function MetricCard({
  icon: Icon, label, description, status, value, unit, detail, topActions, extra,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  status: "calculated" | "stub_no_data" | "insufficient_data";
  value: string | null;
  unit?: string;
  detail: string;
  topActions?: Array<{ actionId: string; impact: number }>;
  extra?: React.ReactNode;
}) {
  const hasValue = status === "calculated" && value !== null;

  return (
    <div className="glass rounded-xl p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-display font-semibold text-sm text-foreground">{label}</p>
            {hasValue && (
              <p className="font-display font-bold text-lg text-primary">
                {value}
                {unit && <span className="text-[10px] text-muted-foreground ml-1">{unit}</span>}
              </p>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="pl-12 space-y-1.5">
        <p className="text-[10px] text-muted-foreground">{detail}</p>
        {extra}
        {topActions && topActions.length > 0 && (
          <div className="space-y-0.5 pt-1">
            {topActions.slice(0, 3).map((a, i) => (
              <div key={a.actionId} className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">
                  {i + 1}. {formatActionId(a.actionId)}
                </span>
                <span className={`font-display font-semibold ${a.impact > 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {a.impact > 0 ? "+" : ""}{a.impact.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QualityBadge({ score }: { score: number }) {
  const { t } = useTranslation();
  const status =
    score >= 0.8 ? { label: t("advancedMetricsPanel.qualityExcellent"), color: "text-emerald-500", icon: CheckCircle2 } :
    score >= 0.5 ? { label: t("advancedMetricsPanel.qualityAcceptable"), color: "text-amber-500", icon: AlertCircle } :
    { label: t("advancedMetricsPanel.qualityLimited"), color: "text-red-500", icon: AlertCircle };

  const Icon = status.icon;
  return (
    <div className={`flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wider ${status.color}`}>
      <Icon size={11} />
      <span>{t("advancedMetricsPanel.quality", { label: status.label })}</span>
      <span className="text-muted-foreground">({Math.round(score * 100)}%)</span>
    </div>
  );
}

// ── Adaptadores de TrackingSnapshot → forma esperada por las cards ────────

function buildTrackingFromSnapshot(s: TrackingSnapshot): {
  maxSpeedMs: number | null;
  avgSpeedMs: number | null;
  totalDistanceM: number | null;
  fieldCoveragePct: number | null;
  sprintCount: number | null;
  sprintDistanceM: number | null;
  status: "calculated" | "stub_no_data";
  message: string;
} {
  const m = s.sessionMetrics;
  // Cobertura: (área voronoi promedio / área de campo total 105×68=7140) * 100
  const fieldCoverage = m.avgVoronoiAreaM2 > 0
    ? Math.min(100, Math.round((m.avgVoronoiAreaM2 / 7140) * 100 * 10))
    : null;
  return {
    maxSpeedMs:       m.maxSpeedMs > 0 ? m.maxSpeedMs : null,
    avgSpeedMs:       m.avgSpeedMs > 0 ? m.avgSpeedMs : null,
    totalDistanceM:   m.distanceCoveredM > 0 ? m.distanceCoveredM : null,
    fieldCoveragePct: fieldCoverage,
    sprintCount:      m.sprintCount,
    sprintDistanceM:  m.sprintDistanceM > 0 ? m.sprintDistanceM : null,
    status:           "calculated",
    message:          `Calculado desde ${s.tracksCount} tracks · ${s.scanCount} escaneos detectados (VITAS Lab)`,
  };
}

function buildBiomechanicsFromMediaPipe(bio: BiomechanicsScore): {
  drillScore: number | null;
  injuryRisk: number | null;
  asymmetryPct: number | null;
  status: "calculated" | "stub_no_data";
  message: string;
} {
  return {
    drillScore:   bio.drillScore,
    injuryRisk:   bio.injuryRisk,
    asymmetryPct: bio.asymmetryPct,
    status:       "calculated",
    message:      `MediaPipe Pose · ${bio.framesAnalyzed} frames · Eficiencia ${bio.runningEfficiency}% · Simetría ${bio.bilateralSymmetry}%`,
  };
}

function formatActionId(id: string): string {
  // v_10000_pass → "10s pase"
  const parts = id.split("_");
  if (parts.length < 3) return id;
  const ms = parseInt(parts[1] ?? "0", 10);
  const type = parts[2] ?? "";
  const sec = Math.round(ms / 1000);
  const labels: Record<string, string> = {
    pass: "pase", dribble: "regate", shot: "tiro", cross: "centro",
    tackle: "entrada", interception: "intercepción", clearance: "despeje", foul: "falta",
  };
  return `${sec}s · ${labels[type] ?? type}`;
}
