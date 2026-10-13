import { motion, AnimatePresence } from "framer-motion";
import { Video, X, Rocket } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import VideoUpload from "@/components/VideoUpload";
import VideoCard from "@/components/VideoCard";
import VideoPlayer from "@/components/VideoPlayer";
import type { VideoRecord } from "@/services/real/videoService";

interface LabUploadPanelProps {
  open: boolean;
  onClose: () => void;
  videos: VideoRecord[];
  /** Solo se usa para resolver el nombre por id en las tarjetas; tipo mínimo. */
  players: Array<{ id: string; name: string }>;
  selectedVideoId: string | null;
  onSelectVideo: (id: string) => void;
  onStartAnalysis: () => void;
  /** Declaración del entrenador (obligatoria antes de analizar, también un vídeo antiguo). */
  consentControl?: React.ReactNode;
  /** false ⇒ "Analizar este vídeo" deshabilitado. */
  consentReady?: boolean;
}

/** Slide-over de subida/selección de vídeo del laboratorio. */
const LabUploadPanel = ({
  open,
  onClose,
  videos,
  players,
  selectedVideoId,
  onSelectVideo,
  onStartAnalysis,
  consentControl,
  consentReady,
}: LabUploadPanelProps) => {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="fixed top-0 right-0 h-full w-full max-w-md bg-card border-l border-border z-50 flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Video size={16} className="text-primary" />
                <span className="font-display font-bold text-foreground">{t("vitasLab.videosVitasLab")}</span>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              <div>
                <p className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("vitasLab.uploadNewVideo")}</p>
                <VideoUpload onDone={(id) => { onSelectVideo(id); toast.success(t("vitasLab.videoReadyForAnalysis")); }} />
              </div>
              {videos.length > 0 && (
                <div>
                  <p className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    {t("vitasLab.savedVideos", { count: videos.length })}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {videos.map((video) => (
                      <div key={video.id}
                        onClick={() => { onSelectVideo(video.id); onClose(); toast.info(t("vitasLab.videoSelected", { title: video.title })); }}
                        className={`cursor-pointer rounded-xl border-2 transition-all ${selectedVideoId === video.id ? "border-primary" : "border-transparent"}`}
                      >
                        <VideoCard video={video} playerName={video.playerId ? players?.find(p => p.id === video.playerId)?.name : undefined} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selectedVideoId && (() => {
                const vid = videos.find((v) => v.id === selectedVideoId);
                if (!vid) return null;
                return (
                  <div>
                    <p className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("vitasLab.selectedPreview")}</p>
                    <VideoPlayer video={vid} />
                    {consentControl && <div className="mt-3">{consentControl}</div>}
                    <button
                      onClick={() => { onClose(); onStartAnalysis(); }}
                      disabled={consentReady === false}
                      className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-display font-bold text-sm uppercase tracking-wider hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Rocket size={14} />
                      {t("vitasLab.analyzeThisVideo")}
                    </button>
                  </div>
                );
              })()}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default LabUploadPanel;
