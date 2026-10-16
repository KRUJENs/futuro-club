/**
 * VITAS · TrackingSnapshotPanel
 *
 * Versión read-only de TrackingMetricsPanel que renderiza un snapshot
 * persistido por PlayerTrackingService (generado en VitasLab).
 *
 * Diferencia con TrackingMetricsPanel:
 *  - No depende de tracking en vivo · solo lee snapshot
 *  - Incluye CTA "Re-analizar en Lab" si quieres datos frescos
 *  - Si no hay snapshot, muestra empty state con CTA al Lab
 */
import { motion } from "framer-motion";
import {
  Zap, Activity, Eye, Swords, Map as MapIcon, Hexagon, FlaskConical, Calendar, ArrowRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TrackingSnapshot } from "@/services/real/playerTrackingService";
import { metricsTrustworthy } from "@/lib/yolo/fieldRegistration";
import { EmptyTracking } from "@/components/illustrations/EmptyIllustrations";
import { duelsGateText } from "@/lib/metrics/duelsGate";

interface Props {
  playerId: string;
  snapshot: TrackingSnapshot | null;
  /** Si true, no muestra el botón "Re-analizar" (modo embebido) */
  compact?: boolean;
}

export default function TrackingSnapshotPanel({ playerId, snapshot, compact = false }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!snapshot) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="glass rounded-xl p-6 space-y-4 border border-dashed border-border text-center"
      >
        <EmptyTracking className="w-32 mx-auto" />
        <div className="space-y-1.5 max-w-sm mx-auto">
          <h3 className="font-bold text-base text-foreground">
            {t("trackingSnapshotPanel.emptyTitle")}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("trackingSnapshotPanel.emptyDescription")}
          </p>
        </div>
        <button
          onClick={() => navigate(`/lab?playerId=${playerId}`)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 transition-colors"
        >
          <FlaskConical size={12} /> {t("trackingSnapshotPanel.analyzeInLab")} <ArrowRight size={12} />
        </button>
      </motion.div>
    );
  }

  // ── Snapshot loaded ─────────────────────────────────────────────────────
  const m = snapshot.sessionMetrics;
  const maxKmh = (m.maxSpeedMs * 3.6).toFixed(1);
  const avgKmh = (m.avgSpeedMs * 3.6).toFixed(1);
  const date = new Date(snapshot.savedAt).toLocaleString("es-ES", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const intensityTotal = Math.max(1,
    m.intensityZones.walk + m.intensityZones.jog + m.intensityZones.run + m.intensityZones.sprint
  );
  const pct = (v: number) => Math.round((v / intensityTotal) * 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold text-sm text-foreground uppercase tracking-wider">
          {t("trackingSnapshotPanel.snapshotTitle")}
        </h3>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Calendar size={10} /> {date}
        </span>
      </div>

      {/* Aviso honesto: sin calibración verificada, las métricas físicas (en
          metros) son orientativas — dependen de marcar/detectar los puntos del
          campo (velocidad, distancia, sprints). */}
      {!metricsTrustworthy(snapshot.calibrationConfidence ?? "none") && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
          <FlaskConical size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[10px] leading-relaxed text-foreground/70">
            {t("trackingSnapshotPanel.calibrationCaveat")}
          </p>
        </div>
      )}

      {/* Top-line stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={<Zap size={12} className="text-yellow-400" />} label={t("trackingSnapshotPanel.labelMaxSpeed")} value={maxKmh} unit="km/h" />
        <StatCard icon={<Activity size={12} className="text-emerald-400" />} label={t("trackingSnapshotPanel.labelAvgSpeed")} value={avgKmh} unit="km/h" />
        <StatCard icon={<MapIcon size={12} className="text-blue-400" />} label={t("trackingSnapshotPanel.labelDistance")} value={m.distanceCoveredM.toFixed(0)} unit="m" />
        <StatCard icon={<Activity size={12} className="text-purple-400" />} label={t("trackingSnapshotPanel.labelSprints")} value={`${m.sprintCount}`} unit={`${m.sprintDistanceM.toFixed(0)}m`} />
      </div>

      {/* Eventos clave */}
      <div className="grid grid-cols-3 gap-2">
        {/* Escaneos del jugador ENFOCADO; null ⇒ motivo (sin pista enfocada o no medibles),
            nunca un 0 ni los de todas las pistas (P1 bloque 6b). */}
        <StatCard icon={<Eye size={12} className="text-cyan-400" />} label={t("trackingSnapshotPanel.labelScans")} value={snapshot.scanCount != null ? `${snapshot.scanCount}` : t("trackingSnapshotPanel.scansNotAttributable")} unit={snapshot.scanCount != null ? t("trackingSnapshotPanel.unitHeadTurns") : ""} />
        {/* Duelos SIEMPRE bloqueados (P1 bloque 6): antes «0/0 ganados» (el ganador nunca
            se resolvía). Hueco con su motivo, también para snapshots guardados antes. */}
        <StatCard icon={<Swords size={12} className="text-orange-400" />} label={t("trackingSnapshotPanel.labelDuels")} value={duelsGateText(t).value} unit={duelsGateText(t).hint} />
        {/* Voronoi gateado: avgVoronoiAreaM2 puede ser 0 por "sin muestras" (o snapshot
            pre-G7) → NO pintar ese 0 como área real (inv #2). Fuente honesta = space. */}
        <StatCard icon={<Hexagon size={12} className="text-fuchsia-400" />} label="VORONOI" value={m.space?.value != null ? (m.space.value as number).toFixed(0) : t("trackingSnapshotPanel.spaceNoData")} unit={m.space?.value != null ? t("trackingSnapshotPanel.unitControl") : ""} />
      </div>

      {/* Distribución de intensidad */}
      <div className="glass rounded-xl p-3 space-y-2">
        <p className="text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
          {t("trackingSnapshotPanel.intensityDistribution")}
        </p>
        <div className="flex h-2 rounded-full overflow-hidden bg-secondary">
          <div className="bg-blue-400" style={{ width: `${pct(m.intensityZones.walk)}%` }} />
          <div className="bg-emerald-400" style={{ width: `${pct(m.intensityZones.jog)}%` }} />
          <div className="bg-yellow-400" style={{ width: `${pct(m.intensityZones.run)}%` }} />
          <div className="bg-red-400" style={{ width: `${pct(m.intensityZones.sprint)}%` }} />
        </div>
        <div className="grid grid-cols-4 gap-1 text-[9px] text-muted-foreground">
          <Legend dot="bg-blue-400"   label={t("trackingSnapshotPanel.zoneWalk")} pct={pct(m.intensityZones.walk)} />
          <Legend dot="bg-emerald-400" label={t("trackingSnapshotPanel.zoneJog")}  pct={pct(m.intensityZones.jog)} />
          <Legend dot="bg-yellow-400" label={t("trackingSnapshotPanel.zoneRun")}  pct={pct(m.intensityZones.run)} />
          <Legend dot="bg-red-400"    label="Sprint"  pct={pct(m.intensityZones.sprint)} />
        </div>
      </div>

      {/* Footer · re-analizar */}
      {!compact && (
        <button
          onClick={() => navigate(`/lab?playerId=${playerId}`)}
          className="w-full py-2 rounded-lg bg-secondary/50 border border-border text-[11px] font-display font-bold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
        >
          <FlaskConical size={11} /> {t("trackingSnapshotPanel.reAnalyze")}
        </button>
      )}
    </motion.div>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────────

function StatCard({ icon, label, value, unit }: {
  icon: React.ReactNode; label: string; value: string; unit?: string;
}) {
  return (
    <div className="glass rounded-xl p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-[9px] font-display uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-display font-bold text-foreground">{value}</span>
        {unit && <span className="text-[9px] text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

function Legend({ dot, label, pct }: { dot: string; label: string; pct: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span>{label}</span>
      <span className="ml-auto text-foreground/70">{pct}%</span>
    </div>
  );
}
