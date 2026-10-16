import { type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import TrackingMetricsPanel from "@/components/TrackingMetricsPanel";
import PlayerHeatmap from "@/components/PlayerHeatmap";
import type { EventSummary } from "@/lib/tracking/eventDetectionEngine";
import type { useTracking } from "@/hooks/useTracking";
import type { useMediaPipePose } from "@/hooks/useMediaPipePose";

interface LabLiveTrackingPanelProps {
  tracking: ReturnType<typeof useTracking>;
  mediaPipe: ReturnType<typeof useMediaPipePose>;
  eventSummary: EventSummary | null;
  showVoronoi: boolean;
  setShowVoronoi: Dispatch<SetStateAction<boolean>>;
}

/** Panel de tracking YOLO en vivo (métricas, MediaPipe, eventos, heatmap). Presentacional;
 *  el padre lo monta solo cuando showTracking está activo. */
const LabLiveTrackingPanel = ({
  tracking,
  mediaPipe,
  eventSummary,
  showVoronoi,
  setShowVoronoi,
}: LabLiveTrackingPanelProps) => {
  const { t } = useTranslation();

  return (
    <div className="border-t border-border pt-3 space-y-3">
      <TrackingMetricsPanel
        status={tracking.state.status}
        tracks={tracking.state.currentTracks}
        focusTrackId={tracking.state.focusTrackId}
        metrics={tracking.state.sessionMetrics}
        scanCount={tracking.state.scanEvents.length}
        onFocusTrack={tracking.setFocusTrackId}
        voronoiRegions={tracking.state.voronoiRegions}
        showVoronoi={showVoronoi}
        onToggleVoronoi={() => setShowVoronoi(v => !v)}
        calibrationConfidence={tracking.state.calibrationConfidence}
      />

      {/* MediaPipe + Event Detection Status */}
      <div className="glass rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-display font-semibold uppercase tracking-widest text-muted-foreground">MediaPipe Pose</span>
          <span className={`text-[9px] font-display px-1.5 py-0.5 rounded-full ${
            mediaPipe.status === "processing" ? "bg-green-500/10 text-green-500 border border-green-500/20" :
            mediaPipe.status === "loading" ? "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20" :
            mediaPipe.status === "complete" ? "bg-primary/10 text-primary border border-primary/20" :
            "bg-muted text-muted-foreground border border-border"
          }`}>
            {mediaPipe.status === "processing" ? `${mediaPipe.fps} FPS` :
             mediaPipe.status === "loading" ? t("vitasLab.loading") :
             mediaPipe.status === "complete" ? t("vitasLab.completed") :
             mediaPipe.status === "error" ? t("vitasLab.error") : t("vitasLab.waiting")}
          </span>
        </div>
        {mediaPipe.biomechanics && (
          <div className="grid grid-cols-3 gap-1.5">
            <div className="text-center">
              <p className="text-[8px] text-muted-foreground uppercase">DrillScore</p>
              <p className="text-sm font-display font-black text-primary">{mediaPipe.biomechanics.drillScore}</p>
            </div>
            <div className="text-center">
              <p className="text-[8px] text-muted-foreground uppercase">{t("vitasLab.symmetry")}</p>
              <p className="text-sm font-display font-black text-green-500">{mediaPipe.biomechanics.bilateralSymmetry}%</p>
            </div>
            <div className="text-center">
              <p className="text-[8px] text-muted-foreground uppercase">{t("vitasLab.risk")}</p>
              <p className={`text-sm font-display font-black ${mediaPipe.biomechanics.injuryRisk > 50 ? "text-red-500" : "text-green-500"}`}>{mediaPipe.biomechanics.injuryRisk}</p>
            </div>
          </div>
        )}
        {eventSummary && eventSummary.totalEvents > 0 && (
          <div className="pt-1 border-t border-border/50">
            <p className="text-[9px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-1">{t("vitasLab.tacticalEvents")}</p>
            <div className="flex flex-wrap gap-1.5">
              {eventSummary.passesAttempted > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                  {t("vitasLab.passesLabel")} {eventSummary.passesCompleted}/{eventSummary.passesAttempted}
                </span>
              )}
              {eventSummary.recoveries > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                  {t("vitasLab.recoveriesAbbr")} {eventSummary.recoveries}
                </span>
              )}
              {eventSummary.sprintBursts > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                  Sprints {eventSummary.sprintBursts}
                </span>
              )}
              {eventSummary.shots > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                  {t("vitasLab.shotsLabel")} {eventSummary.shots}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mapa de calor — jugador individual o equipo completo */}
      {(() => {
        if (tracking.state.focusTrackId) {
          // Modo jugador individual
          const focusTrack = tracking.state.currentTracks.find(
            t => t.id === tracking.state.focusTrackId
          );
          const positions = focusTrack?.positions ?? [];
          return positions.length > 0 ? (
            <PlayerHeatmap
              positions={positions}
              title={t("vitasLab.heatmapPlayer", { id: tracking.state.focusTrackId })}
            />
          ) : null;
        }
        // Modo equipo: unir posiciones de todos los tracks
        const allPositions = tracking.state.currentTracks.flatMap(t => t.positions);
        return allPositions.length > 0 ? (
          <PlayerHeatmap
            positions={allPositions}
            title={t("vitasLab.heatmapTeam", { count: tracking.state.currentTracks.length })}
          />
        ) : null;
      })()}
    </div>
  );
};

export default LabLiveTrackingPanel;
