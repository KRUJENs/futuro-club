/**
 * VITAS Phase 2 — VideoUpload component
 *
 * Drag & drop + click-to-browse video upload.
 * Shows full upload pipeline progress:
 *   idle → uploading (%) → processing (encode %) → analyzing → done / error
 *
 * Consentimiento (decisión del owner, 30 sep): la subida dispara el análisis automático
 * (webhook de Bunny → cola), así que el entrenador marca la declaración versionada ANTES
 * de elegir el fichero; sin marcarla la zona de subida no acepta ficheros. La casilla
 * empieza sin marcar y se desmarca al reiniciar (una declaración por vídeo, nunca sola).
 * Si el servidor bloquea (menor de 14 conocido sin consentimiento parental verificado,
 * etc.) se muestra su motivo.
 */

import { useRef, useState, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Video, X, CheckCircle2, AlertCircle,
  Loader2, Zap, Film, RefreshCw, Camera,
} from "lucide-react";
import { useVideoUpload, type UploadPhase, type DuplicateInfo } from "@/hooks/useVideoUpload";
import RecordingGuide, { useRecordingGuideNeeded } from "@/components/RecordingGuide";
import { readVideoDurationSec } from "@/lib/localVideoUtils";
import { syncAnalysisTooLongMessage } from "@/lib/syncVideoAnalysisGate";
import {
  checkUploadSize,
  checkMatchDuration,
  durationMinutesForDisplay,
  MAX_MATCH_DURATION_MIN,
  MAX_UPLOAD_SIZE_GB,
} from "@/lib/shared/videoLimits";
import ClipAttestationField from "@/components/consent/ClipAttestationField";
import { buildClipAttestation } from "@/lib/shared/videoConsent";

/** Info que acompaña a onDone: la duración que leyó el navegador (null = no se pudo leer). */
export interface VideoUploadDoneInfo {
  durationSec: number | null;
}

interface VideoUploadProps {
  playerId?: string;
  onDone?: (videoId: string, info: VideoUploadDoneInfo) => void;
  /**
   * El fichero ya está entero en Bunny (éxito TUS), ANTES de esperar la codificación
   * — que en un partido completo puede superar el poll. Útil para encolar trabajo
   * que no necesita el vídeo codificado.
   */
  onUploaded?: (videoId: string) => void;
  className?: string;
}

const ACCEPTED = "video/mp4,video/quicktime,video/x-msvideo,video/webm,video/*";

export default function VideoUpload({ playerId, onDone, onUploaded, className = "" }: VideoUploadProps) {
  const { t } = useTranslation();
  const { state, upload, cancel: cancelUpload, reset: resetUpload } = useVideoUpload(playerId);
  // Declaración del entrenador para ESTE vídeo: empieza sin marcar y se desmarca al reiniciar.
  const [attested, setAttested] = useState(false);
  const attestationId = `clip-attestation-${useId()}`;
  const reset = useCallback(() => {
    setAttested(false);
    resetUpload();
  }, [resetUpload]);
  const cancel = useCallback(() => {
    setAttested(false);
    cancelUpload();
  }, [cancelUpload]);

  const phaseLabel: Record<UploadPhase, string> = {
    idle: "",
    hashing: t("videoUpload.phaseHashing"),
    init: t("videoUpload.phaseInit"),
    uploading: t("videoUpload.phaseUploading"),
    processing: t("videoUpload.phaseProcessing"),
    analyzing: t("videoUpload.phaseAnalyzing"),
    done: t("videoUpload.phaseDone"),
    error: t("videoUpload.phaseError"),
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Leyendo metadatos (duración) del fichero antes de subir.
  const [preparing, setPreparing] = useState(false);
  const [title, setTitle] = useState("");
  const guideNeeded = useRecordingGuideNeeded();
  const [showGuide, setShowGuide] = useState(false);

  /**
   * Callback para duplicados: muestra confirm nativo.
   * "OK" → reusar video existente (ahorra Bunny + IA)
   * "Cancel" → subir de nuevo (si el usuario quiere re-analizar)
   */
  const handleDuplicate = useCallback(async (dup: DuplicateInfo): Promise<"reuse" | "upload"> => {
    const fecha = dup.dateUploaded
      ? new Date(dup.dateUploaded).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })
      : t("videoUpload.dupDateUnknown");
    const tituloPrev = dup.title || t("videoUpload.dupNoTitle");
    const tieneAnalisis = dup.hasAnalysis ? t("videoUpload.dupHasAnalysis") : "";
    const msg =
      t("videoUpload.dupIntro") + `\n\n` +
      `📹 "${tituloPrev}"\n` +
      `📅 ${fecha}` +
      tieneAnalisis +
      `\n\n` + t("videoUpload.dupQuestion") + `\n\n` +
      t("videoUpload.dupAcceptLine") + `\n` +
      t("videoUpload.dupCancelLine");
    const wantsReuse = typeof window !== "undefined" && window.confirm(msg);
    return wantsReuse ? "reuse" : "upload";
  }, [t]);

  const handleFile = useCallback(
    async (file: File) => {
      // Sin la declaración no se sube nada (el servidor también la exige: 400).
      const attestation = buildClipAttestation(attested);
      if (!attestation) return;
      // Límites compartidos (src/lib/shared/videoLimits · inv #7): un partido completo
      // cabe; lo que exceda el tamaño o la duración máxima se rechaza antes de subir.
      if (!checkUploadSize(file.size).ok) {
        alert(t("videoUpload.fileTooLarge", { max: MAX_UPLOAD_SIZE_GB }));
        return;
      }
      // Duración REAL de los metadatos del navegador. Si no se puede leer → null:
      // no se bloquea por duración y no se inventa un valor (invariante #2).
      setPreparing(true);
      let durationSec: number | null = null;
      try {
        durationSec = await readVideoDurationSec(file);
      } finally {
        setPreparing(false);
      }
      const durationGate = checkMatchDuration(durationSec);
      if (!durationGate.allowed) {
        alert(t("videoUpload.durationTooLong", {
          duration: durationMinutesForDisplay(durationGate.durationSec),
          max: MAX_MATCH_DURATION_MIN,
        }));
        return;
      }
      const videoId = await upload(file, {
        title: title || file.name,
        onDuplicate: handleDuplicate,
        durationSec,
        attestation,
        ...(onUploaded ? { onUploaded: (info: { videoId: string }) => onUploaded(info.videoId) } : {}),
      });
      // upload() devuelve el videoId real resuelto; antes leíamos
      // state.videoId de la closure (stale) y el callback no disparaba (#26).
      if (videoId && onDone) onDone(videoId, { durationSec });
    },
    [upload, title, onDone, onUploaded, handleDuplicate, t, attested]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const isActive = state.phase !== "idle" && state.phase !== "error" && state.phase !== "done";

  // Auto-show recording guide on first upload attempt
  const handleUploadClick = () => {
    if (guideNeeded && !showGuide) {
      setShowGuide(true);
      return;
    }
    inputRef.current?.click();
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Recording Guide Modal */}
      <RecordingGuide open={showGuide} onClose={() => setShowGuide(false)} />

      {/* Tips button */}
      {state.phase === "idle" && (
        <button
          onClick={() => setShowGuide(true)}
          className="flex items-center gap-1.5 text-[11px] text-primary/70 hover:text-primary transition-colors"
        >
          <Camera size={12} />
          {t("videoUpload.recordingTips")}
        </button>
      )}

      {/* Title input (optional) */}
      {state.phase === "idle" && (
        <input
          type="text"
          placeholder={t("videoUpload.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm font-display text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
        />
      )}

      {/* Declaración del entrenador (obligatoria antes de elegir el fichero) */}
      {state.phase === "idle" && (
        <ClipAttestationField id={attestationId} checked={attested} onChange={setAttested} purpose="upload" />
      )}

      {/* Drop zone */}
      <AnimatePresence mode="wait">
        {state.phase === "idle" && (
          <motion.div
            key="dropzone"
            data-testid="video-upload-dropzone"
            aria-disabled={!attested}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onDragOver={(e) => { e.preventDefault(); if (attested) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => { if (attested) inputRef.current?.click(); }}
            className={`relative border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center gap-3 transition-all ${
              !attested
                ? "border-border opacity-50 cursor-not-allowed"
                : dragging
                  ? "border-primary bg-primary/10 cursor-pointer"
                  : "border-border hover:border-primary/40 hover:bg-secondary/50 cursor-pointer"
            }`}
          >
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Upload size={24} className="text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-display font-semibold text-foreground">
                {preparing
                  ? t("videoUpload.phaseInit")
                  : dragging ? t("videoUpload.dropHere") : t("videoUpload.dragOrClick")}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("videoUpload.formatsHint", { max: MAX_UPLOAD_SIZE_GB, minutes: MAX_MATCH_DURATION_MIN })}
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              className="hidden"
              disabled={!attested}
              data-testid="video-upload-input"
              onChange={onInputChange}
            />
          </motion.div>
        )}

        {/* Progress */}
        {isActive && (
          <motion.div
            key="progress"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Loader2 size={16} className="text-primary animate-spin" />
                <span className="text-sm font-display font-semibold text-foreground">
                  {phaseLabel[state.phase]}
                </span>
              </div>
              <button
                onClick={cancel}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Hashing progress */}
            {state.phase === "hashing" && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground font-display">
                  <span>{t("videoUpload.checkingDuplicates")}</span>
                  <span>{state.progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-muted-foreground/60"
                    animate={{ width: `${state.progress}%` }}
                    transition={{ type: "spring", stiffness: 50 }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("videoUpload.hashingHint")}
                </p>
              </div>
            )}

            {/* Upload progress bar */}
            {(state.phase === "uploading" || state.phase === "init") && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground font-display">
                  <span>{t("videoUpload.uploadingFile")}</span>
                  <span>{state.progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-primary"
                    animate={{ width: `${state.progress}%` }}
                    transition={{ type: "spring", stiffness: 50 }}
                  />
                </div>
                {state.uploadSpeed > 0 && (
                  <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                    <span>
                      {state.uploadSpeed > 1024 * 1024
                        ? `${(state.uploadSpeed / (1024 * 1024)).toFixed(1)} MB/s`
                        : `${(state.uploadSpeed / 1024).toFixed(0)} KB/s`}
                    </span>
                    <span>
                      {state.etaSeconds > 60
                        ? t("videoUpload.etaMinutes", { min: Math.ceil(state.etaSeconds / 60) })
                        : t("videoUpload.etaSeconds", { sec: state.etaSeconds })}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Encode progress bar */}
            {state.phase === "processing" && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground font-display">
                  <div className="flex items-center gap-1">
                    <Film size={10} />
                    <span>{t("videoUpload.encodingVideo")}</span>
                  </div>
                  <span>{state.encodeProgress}%</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-electric"
                    animate={{ width: `${state.encodeProgress}%` }}
                    transition={{ type: "spring", stiffness: 30 }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("videoUpload.encodingHint")}
                </p>
              </div>
            )}

            {/* Analysis phase */}
            {state.phase === "analyzing" && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <Zap size={16} className="text-primary animate-pulse" />
                <div>
                  <p className="text-xs font-display font-semibold text-foreground">
                    {t("videoUpload.tacticalAnalysisTitle")}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {t("videoUpload.tacticalAnalysisDesc")}
                  </p>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Done */}
        {state.phase === "done" && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass rounded-xl p-5 space-y-3"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 size={20} className="text-primary" />
              <div>
                <p className="text-sm font-display font-semibold text-foreground">
                  {t("videoUpload.uploaded")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("videoUpload.idLabel")} {state.videoId}
                </p>
              </div>
            </div>
            {state.encodeStatus === "processing" && (
              <div className="p-3 rounded-lg bg-secondary space-y-1">
                <p className="text-xs font-display font-semibold text-foreground">
                  {t("videoUpload.encodingPendingTitle")}
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t("videoUpload.encodingPendingHint")}
                </p>
              </div>
            )}
            {typeof state.syncGateDurationSec === "number" && (
              <div className="p-3 rounded-lg bg-secondary">
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {syncAnalysisTooLongMessage(t, state.syncGateDurationSec)}
                </p>
              </div>
            )}
            {state.analysisQueued && (
              <div className="p-3 rounded-lg bg-secondary space-y-1">
                <p className="text-xs font-display font-semibold text-foreground">
                  {t("videoUpload.analysisQueuedTitle")}
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t("videoUpload.analysisQueuedHint")}
                </p>
              </div>
            )}
            <button
              onClick={reset}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-display transition-colors"
            >
              <RefreshCw size={12} />
              {t("videoUpload.uploadAnother")}
            </button>
          </motion.div>
        )}

        {/* Error */}
        {state.phase === "error" && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="glass rounded-xl p-5 space-y-3"
          >
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-display font-semibold text-foreground">
                  {state.phase2Pending
                    ? t("videoUpload.phase2ModuleTitle")
                    : state.consentBlocked
                      ? t("clipConsent.blockedTitle")
                      : t("videoUpload.uploadErrorTitle")}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {state.phase2Pending
                    ? t("videoUpload.phase2ConfigHint")
                    : state.error}
                </p>
              </div>
              {state.phase2Pending && (
                <span className="ml-auto text-[9px] font-display font-bold uppercase tracking-wider px-2 py-1 rounded bg-primary/10 text-primary shrink-0">
                  {t("videoUpload.phase2Badge")}
                </span>
              )}
            </div>
            <button
              onClick={reset}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-display transition-colors"
            >
              <RefreshCw size={12} />
              {t("videoUpload.retry")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase 2 badge when idle */}
      {state.phase === "idle" && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-display">
          <Video size={10} />
          <span>{t("videoUpload.poweredBy")}</span>
        </div>
      )}
    </div>
  );
}
