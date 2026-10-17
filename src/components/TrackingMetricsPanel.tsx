/**
 * VITAS · TrackingMetricsPanel
 *
 * Panel de métricas físicas en tiempo real.
 * Muestra velocidad, distancia, sprints, escaneos, zonas de intensidad y el hueco de
 * duelos (bloqueados con su motivo).
 */

import { motion } from "framer-motion";
import { Zap, Activity, Timer, Eye, Swords, Map, Hexagon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PhysicalMetrics, Track, TrackingStatus, VoronoiRegion } from "@/lib/yolo/types";
import type { CalibrationConfidence } from "@/lib/yolo/fieldRegistration";
import { metricsTrustworthy } from "@/lib/yolo/fieldRegistration";
import { isTrackIdentityReliable } from "@/lib/yolo/tracker";
import CalibrationCaveat from "@/components/CalibrationCaveat";
import { duelsGateText } from "@/lib/metrics/duelsGate";

interface Props {
  status:       TrackingStatus;
  tracks:       Track[];
  focusTrackId: number | null;
  metrics:      PhysicalMetrics | null;
  scanCount:    number;
  onFocusTrack: (id: number | null) => void;
  voronoiRegions?: VoronoiRegion[];
  showVoronoi?:    boolean;
  onToggleVoronoi?: () => void;
  /** Confianza de calibración: si no es fiable, las cifras en metros son orientativas. */
  calibrationConfidence?: CalibrationConfidence;
}

export default function TrackingMetricsPanel({
  status, tracks, focusTrackId, metrics, scanCount, onFocusTrack,
  voronoiRegions = [], showVoronoi = false, onToggleVoronoi,
  calibrationConfidence,
}: Props) {
  const { t } = useTranslation();
  const focusTrack = tracks.find(t => t.id === focusTrackId);
  const speedMs    = focusTrack?.smoothSpeedMs ?? 0;
  const speedKmh   = (speedMs * 3.6).toFixed(1);
  const distM      = focusTrack?.distanceM ?? 0;
  const sprints    = focusTrack?.sprintCount ?? 0;
  const isTracking = status === "tracking";

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex flex-col gap-3 w-full"
    >
      {/* Estado */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          status === "tracking" ? "bg-green-400 animate-pulse" :
          status === "complete" ? "bg-primary" :
          status === "error"    ? "bg-red-400" :
          "bg-muted-foreground"
        }`} />
        <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
          {status === "tracking"      ? t("trackingMetricsPanel.statusTracking") :
           status === "loading-model" ? t("trackingMetricsPanel.statusLoadingModel")  :
           status === "ready"         ? t("trackingMetricsPanel.statusReady")           :
           status === "complete"      ? t("trackingMetricsPanel.statusComplete") :
           status === "error"         ? t("trackingMetricsPanel.statusError")           : t("trackingMetricsPanel.statusInactive")}
        </span>
      </div>

      {/* Fiabilidad de sesión — SIN scroll (contrato identidad.md): calibración,
          asociación de pistas e identidad de dorsal, declaradas honestamente. */}
      {(isTracking || metrics) && tracks.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 space-y-1">
          <p className="text-[9px] font-display font-bold uppercase tracking-widest text-muted-foreground">
            {t("trackingMetricsPanel.reliabilityTitle")}
          </p>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{t("trackingMetricsPanel.reliabilityCalibration")}</span>
            <span className={`font-bold ${metricsTrustworthy(calibrationConfidence ?? "none") ? "text-green-500" : "text-amber-500"}`}>
              {metricsTrustworthy(calibrationConfidence ?? "none")
                ? t("trackingMetricsPanel.reliabilityCalibrated")
                : t("trackingMetricsPanel.reliabilityUncalibrated")}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{t("trackingMetricsPanel.reliabilityAssociation")}</span>
            <span className="font-bold text-foreground tabular-nums">
              {tracks.filter(isTrackIdentityReliable).length}/{tracks.length}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{t("trackingMetricsPanel.reliabilityAnonymous")}</span>
            <span className="font-bold text-amber-500 tabular-nums">
              {tracks.filter(tr => tr.dorsalNumber == null).length}/{tracks.length}
            </span>
          </div>
        </div>
      )}

      {/* Selector de jugador a seguir */}
      {tracks.length > 0 && (
        <div>
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            {t("trackingMetricsPanel.focusedPlayer")}
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {tracks.map(t => (
              <button
                key={t.id}
                onClick={() => onFocusTrack(focusTrackId === t.id ? null : t.id)}
                className={`px-2 py-1 rounded-lg text-[10px] font-display font-bold transition-colors ${
                  focusTrackId === t.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                #{t.id}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Aviso honesto: sin calibración fiable, las cifras en metros son orientativas */}
      {(isTracking || metrics) && <CalibrationCaveat calibrationConfidence={calibrationConfidence} />}

      {/* Métricas en vivo */}
      <div className="grid grid-cols-2 gap-2">
        {/* Velocidad */}
        <MetricCard
          icon={<Zap size={12} className="text-yellow-400" />}
          label={t("trackingMetricsPanel.metricSpeed")}
          value={isTracking ? `${speedKmh}` : metrics ? (metrics.maxSpeedMs * 3.6).toFixed(1) : "--"}
          unit="km/h"
          sub={isTracking ? `${speedMs.toFixed(1)} m/s` : metrics ? t("trackingMetricsPanel.speedMax", { value: (metrics.maxSpeedMs * 3.6).toFixed(1) }) : ""}
          highlight={speedMs > 5.83}
        />

        {/* Distancia */}
        <MetricCard
          icon={<Activity size={12} className="text-blue-400" />}
          label={t("trackingMetricsPanel.metricDistance")}
          value={isTracking ? distM.toFixed(0) : metrics ? metrics.distanceCoveredM.toFixed(0) : "--"}
          unit="m"
          sub={isTracking ? `${(distM / 1000).toFixed(2)} km` : ""}
        />

        {/* Sprints */}
        <MetricCard
          icon={<Timer size={12} className="text-orange-400" />}
          label={t("trackingMetricsPanel.metricSprints")}
          value={isTracking ? String(sprints) : metrics ? String(metrics.sprintCount) : "--"}
          unit=""
          sub={isTracking ? ">21 km/h" : metrics ? t("trackingMetricsPanel.sprintDistance", { value: metrics.sprintDistanceM.toFixed(0) }) : ""}
        />

        {/* Escaneos */}
        <MetricCard
          icon={<Eye size={12} className="text-green-400" />}
          label={t("trackingMetricsPanel.metricScans")}
          value={String(scanCount)}
          unit=""
          sub={t("trackingMetricsPanel.scansSub")}
        />

        {/* Duelos — SIEMPRE bloqueados (P1 bloque 6): hueco visible con su motivo.
            Antes, grabando, pintaba el total de pares a < 1,8 m de TODAS las pistas
            (compañeros incluidos), no los del jugador. */}
        <MetricCard
          icon={<Swords size={12} className="text-red-400" />}
          label={t("trackingMetricsPanel.metricDuels")}
          value={duelsGateText(t).value}
          unit=""
          sub={duelsGateText(t).hint}
        />

        {/* Espacio — Voronoi de sesión bloqueado (solo en vivo); no mostramos "0 m²". */}
        <MetricCard
          icon={<Map size={12} className="text-purple-400" />}
          label={t("trackingMetricsPanel.metricSpace")}
          value={
            metrics?.space && metrics.space.value === null
              ? t("trackingMetricsPanel.spaceUnresolved")
              : metrics
                ? metrics.avgVoronoiAreaM2.toFixed(0)
                : "--"
          }
          unit={metrics?.space && metrics.space.value === null ? "" : "m²"}
          sub={t("trackingMetricsPanel.spaceSub")}
        />
      </div>

      {/* Zonas de intensidad (solo en modo completo) */}
      {metrics && (
        <div>
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground mb-2 block">
            {t("trackingMetricsPanel.intensityZones")}
          </span>
          <IntensityBar
            walk={metrics.intensityZones.walk}
            jog={metrics.intensityZones.jog}
            run={metrics.intensityZones.run}
            sprint={metrics.intensityZones.sprint}
          />
          <div className="flex justify-between mt-1">
            {[
              { label: t("trackingMetricsPanel.zoneWalk"), color: "bg-slate-400" },
              { label: t("trackingMetricsPanel.zoneJog"),   color: "bg-blue-400"  },
              { label: t("trackingMetricsPanel.zoneRun"), color: "bg-orange-400" },
              { label: t("trackingMetricsPanel.zoneSprint"),  color: "bg-red-400"   },
            ].map(z => (
              <div key={z.label} className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${z.color}`} />
                <span className="text-[8px] text-muted-foreground">{z.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Voronoi — Toggle + Control Territorial */}
      {isTracking && onToggleVoronoi && (
        <div className="space-y-2">
          <button
            onClick={onToggleVoronoi}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-[10px] font-display font-bold uppercase tracking-wider transition-colors ${
              showVoronoi
                ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
                : "bg-secondary/50 text-muted-foreground hover:bg-secondary border border-border"
            }`}
          >
            <Hexagon size={12} />
            VORONOI {showVoronoi ? "ON" : "OFF"}
          </button>

          {showVoronoi && voronoiRegions.length >= 2 && (() => {
            const totalArea = voronoiRegions.reduce((s, r) => s + r.areaM2, 0);
            const focusArea = focusTrackId != null
              ? voronoiRegions.find(r => r.trackId === focusTrackId)?.areaM2 ?? 0
              : 0;
            const focusPct = totalArea > 0 ? Math.round((focusArea / totalArea) * 100) : 0;
            const avgArea  = totalArea / voronoiRegions.length;

            return (
              <div className="glass rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-1 mb-1">
                  <Hexagon size={10} className="text-indigo-400" />
                  <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                    {t("trackingMetricsPanel.territorialControl")}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t("trackingMetricsPanel.playersDetected")}</span>
                  <span className="font-display font-bold text-foreground">{voronoiRegions.length}</span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t("trackingMetricsPanel.averageArea")}</span>
                  <span className="font-display font-bold text-foreground">{avgArea.toFixed(0)} m²</span>
                </div>
                {focusTrackId != null && focusArea > 0 && (
                  <>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground">{t("trackingMetricsPanel.areaOfPlayer", { id: focusTrackId })}</span>
                      <span className="font-display font-bold text-indigo-400">{focusArea.toFixed(0)} m²</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground">{t("trackingMetricsPanel.percentOfField")}</span>
                      <span className="font-display font-bold text-indigo-400">{focusPct}%</span>
                    </div>
                    {/* Barra de proporción */}
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                        style={{ width: `${focusPct}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </motion.div>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function MetricCard({
  icon, label, value, unit, sub, highlight = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`glass rounded-xl p-3 ${highlight ? "border border-yellow-400/40" : ""}`}>
      <div className="flex items-center gap-1 mb-1">
        {icon}
        <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`font-display font-bold text-lg ${highlight ? "text-yellow-400" : "text-foreground"}`}>
          {value}
        </span>
        {unit && <span className="text-[9px] text-muted-foreground">{unit}</span>}
      </div>
      {sub && <p className="text-[9px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function IntensityBar({
  walk, jog, run, sprint,
}: { walk: number; jog: number; run: number; sprint: number }) {
  const total = walk + jog + run + sprint || 1;
  return (
    <div className="flex h-3 rounded-full overflow-hidden gap-px">
      <div className="bg-slate-400"    style={{ width: `${(walk   / total) * 100}%` }} />
      <div className="bg-blue-400"     style={{ width: `${(jog    / total) * 100}%` }} />
      <div className="bg-orange-400"   style={{ width: `${(run    / total) * 100}%` }} />
      <div className="bg-red-400"      style={{ width: `${(sprint / total) * 100}%` }} />
    </div>
  );
}
