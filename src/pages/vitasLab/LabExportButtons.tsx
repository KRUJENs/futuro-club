import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AnalyticsExporter } from "@/lib/tracking/analyticsExportPipeline";
import type { SessionExportData, ExportFormat } from "@/lib/tracking/analyticsExportPipeline";
import type { EventSummary, TacticalEvent } from "@/lib/tracking/eventDetectionEngine";
import { metricsTrustworthy } from "@/lib/yolo/fieldRegistration";
import type { useTracking } from "@/hooks/useTracking";
import type { useMediaPipePose } from "@/hooks/useMediaPipePose";

interface LabExportButtonsProps {
  tracking: ReturnType<typeof useTracking>;
  biomechanics: ReturnType<typeof useMediaPipePose>["biomechanics"];
  selectedPlayerId: string | null;
  selectedPlayerName?: string;
  selectedVideoId: string | null;
  tacticalEvents: TacticalEvent[];
  eventSummary: EventSummary | null;
}

/** Botones de export (CSV/JSON/HTML) de la sesión de tracking. Solo aparecen cuando el
 *  tracking ha completado. Presentacional; construye el SessionExportData y descarga. */
const LabExportButtons = ({
  tracking,
  biomechanics,
  selectedPlayerId,
  selectedPlayerName,
  selectedVideoId,
  tacticalEvents,
  eventSummary,
}: LabExportButtonsProps) => {
  const { t } = useTranslation();

  if (!(tracking.state.status === "complete" && tracking.state.sessionMetrics)) return null;

  return (
    <div className="flex gap-1.5">
      {(["csv", "json", "html_report"] as ExportFormat[]).map(fmt => (
        <button
          key={fmt}
          onClick={() => {
            const focusTrack = tracking.state.focusTrackId
              ? tracking.state.currentTracks.find(t => t.id === tracking.state.focusTrackId)
              : null;
            const exportData: SessionExportData = {
              metadata: {
                sessionId: `session_${Date.now()}`,
                playerId: selectedPlayerId ?? "unknown",
                playerName: selectedPlayerName ?? t("vitasLab.playerFallback"),
                videoId: selectedVideoId,
                date: new Date().toISOString().slice(0, 10),
                durationSec: tracking.state.sessionMetrics!.distanceCoveredM / Math.max(0.1, tracking.state.sessionMetrics!.avgSpeedMs),
                trackingFps: 8,
                fieldDimensions: { lengthM: 105, widthM: 68 },
                calibrationReliable: metricsTrustworthy(tracking.state.calibrationConfidence),
              },
              physicalMetrics: tracking.state.sessionMetrics!,
              biomechanics,
              tracks: tracking.state.currentTracks,
              focusTrackId: tracking.state.focusTrackId,
              events: tacticalEvents,
              // Sin resumen ⇒ null (antes un resumen de ceros: «0 pases», «0G / 0P»).
              eventSummary: eventSummary ?? null,
              scanEvents: tracking.state.scanEvents,
              focusPositions: focusTrack?.positions.map(p => ({ fx: p.fx, fy: p.fy, tMs: p.timestampMs })) ?? [],
            };
            const exporter = new AnalyticsExporter(exportData);
            exporter.download(fmt);
            toast.success(t("vitasLab.exportedAs", { format: fmt.toUpperCase() }));
          }}
          className="flex-1 py-1.5 rounded-lg border border-border text-[10px] font-display font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors uppercase"
        >
          {fmt === "html_report" ? "HTML" : fmt.toUpperCase()}
        </button>
      ))}
    </div>
  );
};

export default LabExportButtons;
