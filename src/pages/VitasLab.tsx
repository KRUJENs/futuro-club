import { useState, useRef, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  Camera,
  UserRound,
  ArrowLeft,
  X,
  AlertTriangle,
  Activity,
} from "lucide-react";
import { PlayerTrackingService } from "@/services/real/playerTrackingService";
import { useTracking } from "@/hooks/useTracking";
import { useMediaPipePose } from "@/hooks/useMediaPipePose";
import { EventDetectionEngine } from "@/lib/tracking/eventDetectionEngine";
import type { TacticalEvent, EventSummary } from "@/lib/tracking/eventDetectionEngine";
import { metricsTrustworthy } from "@/lib/yolo/fieldRegistration";
import { detectFieldLines } from "@/lib/tracking/fieldLineDetector";
import type { FieldDetectionResult } from "@/lib/tracking/fieldLineDetector";
import { toast } from "sonner";
import { IS_DEMO } from "@/lib/demoMode";
import { useTranslation } from "react-i18next";
import { useVideos } from "@/hooks/useVideos";
import { getBestVideoUrl } from "@/services/real/videoService";
import { useAllPlayers } from "@/hooks/usePlayers";
import { useAuth } from "@/context/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { SubscriptionService } from "@/services/real/subscriptionService";
import { isLocalSrc } from "@/lib/localVideoUtils";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { usePlayerAnalysisV2 } from "@/hooks/usePlayerAnalysisV2";
import { useFatigue } from "@/hooks/useFatigue";
import { useOneClickAnalysis } from "@/hooks/useOneClickAnalysis";
import VitasLabOneClick from "@/components/VitasLabOneClick";
import ClipAttestationField from "@/components/consent/ClipAttestationField";
import { buildClipAttestation, ClipConsentBlockedError } from "@/lib/shared/videoConsent";
import PrecisionToggle, { type PrecisionPhase } from "@/components/vision/PrecisionToggle";
import { getTilingConfig } from "@/lib/yolo/tiling";
import { containTransform, fromDisplay, toDisplay, PERCENT_SPACE, type PixelSpace } from "@/lib/yolo/coordSpace";
import { useVideoSpace } from "@/hooks/useVideoSpace";
import { XgAccumulator } from "@/lib/xg/xgAccumulator";
import type { XgSummary } from "@/lib/xg/xgAccumulator";
import { useTeamAnalysis } from "@/hooks/useTeamAnalysis";
import UpgradePrompt from "@/components/UpgradePrompt";
import type { CalibrationPoint } from "./vitasLab/types";
import { mapV2ToReport } from "./vitasLab/reportMapping";
import { formatTime, container, item } from "./vitasLab/labUi";
import LabStatusBar from "./vitasLab/LabStatusBar";
import LabUploadPanel from "./vitasLab/LabUploadPanel";
import LabResultsPanel from "./vitasLab/LabResultsPanel";
import LabLiveTrackingPanel from "./vitasLab/LabLiveTrackingPanel";
import LabExportButtons from "./vitasLab/LabExportButtons";
import LabAnalysisConfig from "./vitasLab/LabAnalysisConfig";
import LabPitchView from "./vitasLab/LabPitchView";

const steps = [
  { id: 1, labelKey: "vitasLab.stepUpload", done: true },
  { id: 2, labelKey: "vitasLab.stepMapping", active: true },
  { id: 3, labelKey: "vitasLab.stepProcess", done: false },
];

const VitasLab = () => {
  const { t } = useTranslation();
  const navigate  = useNavigate();
  const { user }  = useAuth();
  const { canRunAnalysis, analysesUsed, limits, isClub, plan } = usePlan();
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showHistorial, setShowHistorial]       = useState(false);

  const [selectedMode, setSelectedMode]         = useState("all");
  const [isPlaying, setIsPlaying]               = useState(false);
  const [currentTime, setCurrentTime]           = useState(0);
  const totalTime = 5400;
  const [showUploadPanel, setShowUploadPanel]   = useState(false);
  const [showResultsPanel, setShowResultsPanel] = useState(false);
  const [selectedVideoId, setSelectedVideoId]   = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [playedPosition, setPlayedPosition] = useState<string>("");
  // Declaración del entrenador (decisión del owner, 30 sep): obligatoria antes de CADA
  // análisis del vídeo seleccionado, también si se subió antes del gate. Sin marcar al
  // empezar y se desmarca al cambiar de vídeo: nunca se declara sola.
  const [attested, setAttested] = useState(false);
  useEffect(() => {
    setAttested(false);
  }, [selectedVideoId]);
  const v2 = usePlayerAnalysisV2();
  const analysisReport = v2.isCompleted ? mapV2ToReport(v2.result) : null;
  const { data: players = [] } = useAllPlayers();

  // ── Fatigue Detection ──
  // phvOffset real del jugador seleccionado (antes quedaba fijo en null y la
  // corrección por madurez nunca se aplicaba — ni aquí ni en el panel xG).
  const fatigue = useFatigue({
    playerId: selectedPlayerId ?? "",
    phvOffset: players.find((p) => p.id === selectedPlayerId)?.phvOffset ?? null,
  });

  // ── One-Click Analysis Orchestrator ──
  const oneClick = useOneClickAnalysis({
    onCalibrationComplete: (result) => {
      // Map auto-calibration corners to calibration points
      if (result.corners.length >= 4) {
        setPoints(result.corners.slice(0, 4).map((c, i) => ({
          id: i + 1,
          x: c.x,
          y: c.y,
          label: `P${i + 1}`,
        })));
        toast.success(
          result.autoDetected
            ? t("vitasLab.autoCalibSuccessPct", { pct: Math.round(result.confidence * 100) })
            : t("vitasLab.calibHeuristicApplied"),
          { duration: 3000 },
        );
      }
    },
    onStartTracking: (videoEl) => {
      setShowTracking(true);
      // Registrar si esta pasada corre con precisión (tiling). Es la MISMA config
      // que leerá el worker en su INIT (getTilingConfig), así que refleja la pasada real.
      setPassUsedPrecision(getTilingConfig() !== null);
      mediaPipe.reset();
      eventEngineRef.current.reset();
      xgAccumulatorRef.current.reset();
      setEventSummary(null);
      setTacticalEvents([]);
      setXgSummary(null);
      videoEl.crossOrigin = "anonymous";
      trackingVideoRef.current = videoEl;
      tracking.startTracking(videoEl).then(() => {
        oneClick.advanceStep("tracking");
      }).catch((err) => {
        oneClick.markError(t("vitasLab.trackingStartError") + " " + err.message);
      });
    },
    onError: (error) => {
      toast.error(t("vitasLab.oneClickError"), { description: error });
    },
    onComplete: () => {
      toast.success(t("vitasLab.oneClickComplete"));
    },
  });

  // Historial: análisis completados previos del jugador (tabla analyses)
  const { data: savedAnalyses = [] } = useQuery<Array<{ id: string; created_at: string; vsi: Record<string, unknown> | null }>>({
    queryKey: ["saved-analyses-v2", selectedPlayerId],
    queryFn: async () => {
      if (!selectedPlayerId || !SUPABASE_CONFIGURED) return [];
      const { data } = await supabase
        .from("analyses")
        .select("id, created_at, vsi")
        .eq("player_id", selectedPlayerId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
    enabled: !!selectedPlayerId && SUPABASE_CONFIGURED,
  });
  const [showPlayerDropdown, setShowPlayerDropdown] = useState(false);
  // (Dorsal / color de equipación retirados: nunca se enviaban a ningún análisis y la
  //  identificación por dorsal aún no existe — identidad.md. Nada de campos inertes.)
  const [showTracking, setShowTracking]         = useState(false);
  const [showVoronoi, setShowVoronoi]           = useState(false);
  // ¿La pasada de tracking activa/última usó "Análisis de precisión" (tiling)?
  // Se fija al arrancar la pasada leyendo la config real que usará el worker; sirve
  // para ofrecer "Re-analizar con precisión" cuando la pasada terminó sin tiling.
  const [passUsedPrecision, setPassUsedPrecision] = useState(false);
  // Configuración por modo de análisis
  const [analysisFocus, setAnalysisFocus]       = useState<string[]>([]);
  const [homeFormation, setHomeFormation]       = useState<string>("4-3-3");
  const [awayFormation, setAwayFormation]       = useState<string>("4-4-2");
  const [playerName, setPlayerName]             = useState<string>("");
  const [playerPosition, setPlayerPosition]     = useState<string>("");

  // ── Preselección por URL (?playerId=…) ──
  // 12 vistas ya enlazan a /lab?playerId=X (ficha, FAB, IDP, informes…); hasta
  // ahora el Lab ignoraba el parámetro. Replica los 3 setters del selector manual
  // (id + nombre + posición, que alimentan el PDF) y solo actúa si el usuario no
  // ha elegido ya un jugador. En móvil es la ÚNICA vía de selección (el selector
  // visual es desktop-only).
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (selectedPlayerId !== null) return;
    const urlPlayerId = searchParams.get("playerId");
    if (!urlPlayerId) return;
    const p = players.find((pl) => pl.id === urlPlayerId);
    if (!p) return;
    setSelectedPlayerId(p.id);
    if (p.name) setPlayerName(p.name);
    if (p.position) setPlayerPosition(p.position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, searchParams]);

  const trackingVideoRef = useRef<HTMLVideoElement | null>(null);
  const labVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [actionLog, setActionLog] = useState<Array<{ time: number; text: string; type: "positive" | "negative" | "neutral" }>>([]);

  // ── MediaPipe Pose (biomechanics real) ──
  const mediaPipe = useMediaPipePose({
    targetFps: 8,
    modelComplexity: 1,
    offlineMode: false,
    onFrame: (poses, frameIndex) => {
      // Feed pose data to fatigue posture detector
      if (poses.length > 0 && poses[0]) {
        const timestampMs = (labVideoRef.current?.currentTime ?? 0) * 1000;
        fatigue.addPoseFrame(poses[0], timestampMs);
      }
      if (poses.length > 0 && frameIndex % 30 === 0) {
        setActionLog(prev => [...prev.slice(-10), {
          time: Math.floor((labVideoRef.current?.currentTime ?? 0)),
          text: `MediaPipe: ${poses.length} poses · ${poses[0]?.jointAngles?.trunkLean?.toFixed(1) ?? "?"}° trunk`,
          type: "neutral" as const,
        }]);
      }
    },
    onComplete: (bio) => {
      toast.success(t("vitasLab.biomechanicsComplete"), {
        description: `DrillScore: ${bio.drillScore}/100 · ${t("vitasLab.symmetry")}: ${bio.bilateralSymmetry}% · ${bio.framesAnalyzed} frames`,
        duration: 6000,
      });
    },
  });

  // ── Event Detection Engine ──
  const eventEngineRef = useRef(new EventDetectionEngine({ trackingFps: 8 }));
  const [eventSummary, setEventSummary] = useState<EventSummary | null>(null);
  const [tacticalEvents, setTacticalEvents] = useState<TacticalEvent[]>([]);

  // ── xG Accumulator (Sprint 6) ──
  const xgAccumulatorRef = useRef(new XgAccumulator());
  const [xgSummary, setXgSummary] = useState<XgSummary | null>(null);

  // ── Analysis View Mode (Sprint 8): Jugador / Equipo / Rival Scout ──
  const [analysisViewMode, setAnalysisViewMode] = useState<"player" | "team" | "rival">("player");

  // ── Team Analysis (Sprint 8) ──
  const teamAnalysis = useTeamAnalysis({
    enabled: analysisViewMode === "team" || analysisViewMode === "rival",
    rivalTeam: "away",
  });

  // ── Auto-calibration via field line detection ──
  const [autoCalibResult, setAutoCalibResult] = useState<FieldDetectionResult | null>(null);
  const [autoCalibRunning, setAutoCalibRunning] = useState(false);

  const runAutoCalibration = useCallback(async () => {
    const video = labVideoRef.current;
    if (!video || video.readyState < 2) return;
    setAutoCalibRunning(true);
    try {
      // Capture a frame from the video
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const result = await detectFieldLines(imageData);
      setAutoCalibResult(result);

      if (result.autoCalibrationReady && result.corners.length >= 4) {
        // Map detected corners to % coordinates for the calibration overlay
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const newPoints = result.corners.slice(0, 4).map((corner, i) => ({
          id: i + 1,
          x: (corner[0] / vw) * 100,
          y: (corner[1] / vh) * 100,
          label: `P${i + 1}`,
        }));
        setPoints(newPoints);
        toast.success(t("vitasLab.autoCalibSuccess"), {
          description: t("vitasLab.autoCalibSuccessDesc", { lines: result.lines.length, pct: Math.round(result.confidence * 100) }),
          duration: 5000,
        });
      } else {
        toast.info(t("vitasLab.autoCalibPartial"), {
          description: t("vitasLab.autoCalibPartialDesc", { pct: Math.round(result.confidence * 100) }),
          duration: 4000,
        });
      }
    } catch (err) {
      toast.error(t("vitasLab.fieldLineDetectError"));
      console.error("[FieldLineDetector]", err);
    } finally {
      setAutoCalibRunning(false);
    }
  }, [t]);

  // points DEBE declararse ANTES de useTracking (que lo usa en calibrationPoints)
  const [points, setPoints] = useState<CalibrationPoint[]>([
    { id: 1, x: 28, y: 62, label: "P1" },
    { id: 2, x: 72, y: 62, label: "P2" },
    { id: 3, x: 80, y: 92, label: "P3" },
    { id: 4, x: 20, y: 92, label: "P4" },
  ]);

  // Videos DEBEN declararse ANTES de useTracking para poder pasar localVideoSrc
  // (players se declara arriba, junto al resto de datos del jugador seleccionado)
  const { data: videos = [] } = useVideos();

  // Detectar video local para pasarlo al tracking
  const trackingVideo = videos.find(v => v.id === selectedVideoId);
  const localVideoSrc = trackingVideo?.localPath && !trackingVideo.localPath.startsWith("http")
    ? trackingVideo.localPath
    : trackingVideo?.streamUrl && !trackingVideo.streamUrl.startsWith("http")
      ? trackingVideo.streamUrl
      : undefined;

  // Extract CDN hostname from the video's streamUrl when available
  const trackingCdnHostname = (() => {
    const envHost = import.meta.env.VITE_BUNNY_CDN_HOSTNAME;
    if (envHost) return envHost;
    if (trackingVideo?.streamUrl) {
      try { return new URL(trackingVideo.streamUrl).hostname; } catch { /* fallback */ }
    }
    return undefined;
  })();

  const tracking = useTracking({
    videoId:           selectedVideoId ?? "",
    playerId:          selectedPlayerId ?? "",
    calibrationPoints: points.map(p => ({ x: p.x, y: p.y })),
    anchorPreset:      "full_corners",
    cdnHostname:       trackingCdnHostname,
    localVideoSrc,
  });

  // ── Auto-start MediaPipe cuando tracking empieza ──
  useEffect(() => {
    if (tracking.state.status === "tracking" && mediaPipe.status === "idle" && labVideoRef.current) {
      mediaPipe.start(labVideoRef.current).catch(err => {
        console.warn("[MediaPipe] Auto-start failed:", err.message);
      });
    }
    if (tracking.state.status === "complete" && mediaPipe.status === "processing") {
      mediaPipe.stop();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking.state.status]);

  // ── Feed YOLO tracks into Event Detection Engine each frame ──
  useEffect(() => {
    if (tracking.state.status !== "tracking") return;
    const tracks = tracking.state.currentTracks;
    if (tracks.length === 0) return;

    const videoEl = labVideoRef.current;
    const timestampMs = videoEl ? videoEl.currentTime * 1000 : Date.now();
    const frameIndex = Math.round(timestampMs / 125);

    // Los motores táctico/equipo son ESPACIALES (posiciones en metros). Solo son
    // fiables con una calibración fiable; si no, no se les alimenta → no producen
    // eventos/posesión falsos (anti-fallo-silencioso). Ver #21.
    const calibReliable = metricsTrustworthy(tracking.state.calibrationConfidence);

    eventEngineRef.current.processFrame(
      tracks,
      timestampMs,
      frameIndex,
      tracking.state.focusTrackId,
      tracking.state.ballTrack ?? null,
      calibReliable,
    );

    // Sprint 8: Feed team analysis engine
    if (analysisViewMode !== "player" && tracking.state.identities.size > 0) {
      teamAnalysis.processFrame(
        tracks,
        tracking.state.identities,
        tracking.state.ballTrack ?? null,
        tracking.state.possession as "home" | "away" | "contested" | "none",
        timestampMs,
        calibReliable,
      );
    }

    // Update summary periodically (every 30 frames ≈ 3.75s)
    if (frameIndex % 30 === 0) {
      setEventSummary(eventEngineRef.current.summarize(tracking.state.focusTrackId ?? undefined));
      const events = eventEngineRef.current.getEvents();
      setTacticalEvents(events);

      // Feed shot events into xG accumulator (Sprint 6)
      const shotEvents = events.filter(e => e.type === "shot");
      if (shotEvents.length > xgAccumulatorRef.current.shotCount) {
        // New shots detected — add them
        const newShots = shotEvents.slice(xgAccumulatorRef.current.shotCount);
        for (const shot of newShots) {
          xgAccumulatorRef.current.addShotSimple(
            shot.timestampMs,
            shot.startPosition,
            Number(shot.metadata.xgApprox) || 0.05,
            shot.outcome === "success",
            shot.actorTrackId,
            { distanceM: Number(shot.metadata.distanceToGoalM) || 20 },
          );
        }
        setXgSummary(xgAccumulatorRef.current.summarize());
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking.state.currentTracks]);

  // Auto-guardar snapshot cuando tracking termina · disponible en perfil + role
  useEffect(() => {
    if (tracking.state.status !== "complete" || !selectedPlayerId) return;
    if (!tracking.state.sessionMetrics) return;
    const focusTrack = tracking.state.focusTrackId
      ? tracking.state.currentTracks.find(t => t.id === tracking.state.focusTrackId)
      : null;
    // Final event summary
    const finalEventSummary = eventEngineRef.current.summarize(tracking.state.focusTrackId ?? undefined);
    setEventSummary(finalEventSummary);
    setTacticalEvents(eventEngineRef.current.getEvents());

    // Collect tactical events for the focused player (VAEP input)
    const focusEvents = tracking.state.focusTrackId
      ? eventEngineRef.current.getPlayerEvents(tracking.state.focusTrackId)
      : eventEngineRef.current.getEvents();

    PlayerTrackingService.save({
      playerId:       selectedPlayerId,
      videoId:        selectedVideoId ?? null,
      savedAt:        new Date().toISOString(),
      durationSec:    tracking.state.sessionMetrics.distanceCoveredM > 0
                        ? tracking.state.sessionMetrics.distanceCoveredM / Math.max(0.1, tracking.state.sessionMetrics.avgSpeedMs)
                        : 0,
      sessionMetrics: tracking.state.sessionMetrics,
      calibrationConfidence: tracking.state.calibrationConfidence,
      scanCount:      tracking.state.scanEvents.length,
      duelCount:      tracking.state.duelEvents.length,
      tracksCount:    tracking.state.currentTracks.length,
      focusTrackId:   tracking.state.focusTrackId,
      scanEvents:     tracking.state.scanEvents,
      duelEvents:     tracking.state.duelEvents,
      focusPositions: focusTrack?.positions.map(p => ({ fx: p.fx, fy: p.fy, tMs: p.timestampMs })),
      tacticalEvents:     focusEvents,
      biomechanicsScore:  mediaPipe.biomechanics ?? undefined,
    });

    // ── Generate fatigue report from tracking positions ──
    if (focusTrack && focusTrack.positions.length > 0) {
      const durationSec = tracking.state.sessionMetrics.distanceCoveredM > 0
        ? tracking.state.sessionMetrics.distanceCoveredM / Math.max(0.1, tracking.state.sessionMetrics.avgSpeedMs)
        : 0;
      fatigue.addPositions(
        focusTrack.positions.map(p => ({ x: p.fx, y: p.fy, timestampMs: p.timestampMs })),
      );
      if (durationSec > 0) {
        fatigue.generateReport(durationSec);
      }
    }

    // Sprint 8: Generate team analysis report when tracking completes
    if (analysisViewMode !== "player") {
      teamAnalysis.generateReports();
    }

    const bioMsg = mediaPipe.biomechanics
      ? ` · DrillScore ${mediaPipe.biomechanics.drillScore}`
      : "";
    const evtMsg = finalEventSummary
      ? ` · ${finalEventSummary.totalEvents} ${t("vitasLab.events")}`
      : "";
    toast.success(`📊 ${t("vitasLab.snapshotSaved")}${bioMsg}${evtMsg}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking.state.status, selectedPlayerId, selectedVideoId]);

  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);

  // Vídeo mostrado (object-contain → centrado con bandas), como ESTADO: sus dimensiones
  // llegan asíncronas (loadedmetadata) y el letterbox del overlay depende de ellas.
  // drawOverlay y el hit-test de los puntos usan ESTE mismo valor → siempre coinciden,
  // y el overlay se redibuja cuando el vídeo conoce su tamaño. Sin vídeo, null: la
  // imagen del campo llena el contenedor (comportamiento previo).
  const shownVideoSpace = useVideoSpace(() => labVideoRef.current ?? trackingVideoRef.current);

  const drawOverlay = useCallback(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    canvas.width  = rect.width;
    canvas.height = rect.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const displaySpace: PixelSpace = { width: canvas.width, height: canvas.height };
    const shownVideo = shownVideoSpace;

    // ── Draw YOLO tracks (bounding boxes + keypoints) ──
    // Cajas/keypoints en píxeles NATIVOS del vídeo (trackSpace) → pantalla.
    const tracks = tracking.state.currentTracks;
    if (tracks.length > 0 && shownVideo) {
      const tr = containTransform(tracking.state.trackSpace ?? shownVideo, shownVideo, displaySpace);

      for (const track of tracks) {
        const isFocused = track.id === tracking.state.focusTrackId;
        const color = isFocused ? "hsl(45, 100%, 60%)" : "hsl(120, 80%, 55%)";

        // Bounding box
        const [bx, by, bw, bh] = track.bbox;
        const topLeft = toDisplay(tr, bx, by);
        const boxW = bw * tr.sx;
        const boxH = bh * tr.sy;
        ctx.strokeStyle = color;
        ctx.lineWidth   = isFocused ? 3 : 2;
        ctx.setLineDash([]);
        ctx.strokeRect(topLeft.x, topLeft.y, boxW, boxH);

        // Track ID label
        ctx.fillStyle = color;
        ctx.font      = "bold 12px Rajdhani";
        ctx.fillText(`#${track.id}`, topLeft.x + 2, topLeft.y - 4);

        // Speed label
        if (track.smoothSpeedMs > 0.5) {
          const speedKmh = (track.smoothSpeedMs * 3.6).toFixed(1);
          ctx.font = "10px Rajdhani";
          ctx.fillText(`${speedKmh} km/h`, topLeft.x + 2, topLeft.y + boxH + 12);
        }

        // Keypoints skeleton (COCO-17 pairs)
        if (track.keypoints && track.keypoints.length === 17) {
          const kps = track.keypoints;
          const kpd = kps.map((kp) => toDisplay(tr, kp.x, kp.y));
          const pairs = [[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
          ctx.strokeStyle = isFocused ? "hsla(45, 100%, 60%, 0.6)" : "hsla(120, 80%, 55%, 0.5)";
          ctx.lineWidth   = 1.5;
          for (const [a, b] of pairs) {
            if (kps[a].confidence > 0.3 && kps[b].confidence > 0.3) {
              ctx.beginPath();
              ctx.moveTo(kpd[a].x, kpd[a].y);
              ctx.lineTo(kpd[b].x, kpd[b].y);
              ctx.stroke();
            }
          }
          // Keypoint dots
          kps.forEach((kp, k) => {
            if (kp.confidence > 0.3) {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(kpd[k].x, kpd[k].y, 2.5, 0, Math.PI * 2);
              ctx.fill();
            }
          });
        }
      }
    }

    // ── Draw calibration grid ──
    if (points.length < 2) return;
    // Puntos en % del frame del vídeo (PERCENT_SPACE) → pantalla, mismo letterbox.
    const calibTr = containTransform(PERCENT_SPACE, shownVideo, displaySpace);

    ctx.strokeStyle = "hsl(180, 100%, 60%)";
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    const orderedPts = [...points].sort((a, b) => a.id - b.id);
    orderedPts.forEach((pt, i) => {
      const { x: px, y: py } = toDisplay(calibTr, pt.x, pt.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = "hsla(180, 100%, 60%, 0.06)";
    ctx.fill();

    points.forEach((pt) => {
      const { x: px, y: py } = toDisplay(calibTr, pt.x, pt.y);
      ctx.shadowColor = "hsl(0, 80%, 55%)";
      ctx.shadowBlur  = 10;
      ctx.fillStyle   = "hsl(0, 80%, 55%)";
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle  = "hsl(180, 100%, 70%)";
      ctx.font       = "11px Rajdhani";
      const coordLabel = `${pt.label}: ${Math.round((pt.x / 100) * 1050)}, ${Math.round((pt.y / 100) * 680)}`;
      ctx.fillText(coordLabel, px - 30, py - 12);
    });
  }, [points, tracking.state.currentTracks, tracking.state.focusTrackId, tracking.state.trackSpace, shownVideoSpace]);

  useEffect(() => {
    drawOverlay();
    window.addEventListener("resize", drawOverlay);
    return () => window.removeEventListener("resize", drawOverlay);
  }, [drawOverlay]);

  // Redraw overlay continuously during tracking (requestAnimationFrame loop)
  useEffect(() => {
    if (tracking.state.status !== "tracking") return;
    let raf: number;
    const loop = () => { drawOverlay(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tracking.state.status, drawOverlay]);

  /** Ratón → % del frame del vídeo (el espacio de los puntos), con el mismo letterbox (y el mismo `shownVideoSpace`) que el overlay. */
  const mouseToCalibPct = (e: React.MouseEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const tr = containTransform(
      PERCENT_SPACE,
      shownVideoSpace,
      { width: rect.width, height: rect.height },
    );
    return fromDisplay(tr, e.clientX - rect.left, e.clientY - rect.top);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: mx, y: my } = mouseToCalibPct(e, canvas);
    const closest = points.find((pt) => {
      const dx = pt.x - mx;
      const dy = pt.y - my;
      return Math.sqrt(dx * dx + dy * dy) < 4;
    });
    if (closest) setDraggingPoint(closest.id);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingPoint === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pct = mouseToCalibPct(e, canvas);
    const mx = Math.max(0, Math.min(100, pct.x));
    const my = Math.max(0, Math.min(100, pct.y));
    setPoints((prev) =>
      prev.map((pt) => (pt.id === draggingPoint ? { ...pt, x: mx, y: my } : pt))
    );
  };

  const handleCanvasMouseUp = () => setDraggingPoint(null);

  const handleStartAnalysis = async () => {
    // DEMO: no hay pipeline de vídeo real. Los informes de ejemplo ya están
    // cargados en cada jugador → avisamos en vez de intentar analizar (que fallaría).
    if (IS_DEMO) {
      toast.info(t("toasts.demoReportsLoaded"), {
        description: "En la demo cada jugador ya trae su análisis de ejemplo. El análisis de vídeo real se activa con una cuenta.",
        duration: 5000,
      });
      return;
    }
    if (!canRunAnalysis) {
      setShowUpgradePrompt(true);
      return;
    }
    if (!selectedVideoId) {
      toast.info(t("lab.selectVideoFirst"), { description: t("lab.selectVideoDesc"), duration: 4000 });
      return;
    }
    if (!selectedPlayerId) {
      toast.info(t("lab.selectPlayerFirst"), { description: t("lab.selectPlayerDesc"), duration: 4000 });
      return;
    }
    const attestation = buildClipAttestation(attested);
    if (!attestation) {
      toast.error(t("clipConsent.blockedTitle"), { description: t("clipConsent.analysisNeedsAttestation"), duration: 5000 });
      return;
    }

    const video = videos.find((v) => v.id === selectedVideoId);
    if (!video) { toast.error(t("vitasLab.videoNotFound")); return; }

    // Extraer bunnyVideoId desde embedUrl: https://iframe.mediadelivery.net/embed/{libId}/{guid}
    const bunnyVideoId = video.embedUrl?.split("/").pop() ?? selectedVideoId;

    setActionLog([]);
    v2.reset();
    const toastId = toast.loading(t("vitasLab.startingGpuAnalysis"));

    try {
      const selectedPlayer = players?.find((p) => p.id === selectedPlayerId);
      const finalPlayedPosition = playedPosition || selectedPlayer?.position || undefined;

      // ── Prefer client-side data path when MediaPipe/tracking data exists ──
      const hasClientData = mediaPipe.biomechanics || tracking.state.sessionMetrics || eventSummary;
      if (hasClientData) {
        // Build physical metrics from YOLO tracking. DOS gates fail-closed:
        //  - CALIBRACIÓN: las cifras en metros (velocidad/distancia/sprints/duelos)
        //    sin calibración fiable serían píxeles disfrazados.
        //  - IDENTIDAD (#24): sin identidad fiable del track enfocado, las métricas
        //    por-jugador pudieron acumularse tras un ID-switch → atribuidas al jugador
        //    equivocado. Solo se envían al LLM si AMBOS gates pasan.
        const physicalMetrics: Record<string, unknown> = {};
        // identidad.md: los eventos POR-JUGADOR (physicalMetrics Y eventSummary) solo se
        // atribuyen al jugador si su pista tiene identidad fiable; sin ella pudieron
        // acumularse tras un cambio de ID → se abstienen (no se envían al informe).
        const identityReliable = tracking.state.sessionMetrics?.identityReliable ?? false;
        if (tracking.state.sessionMetrics) {
          const sm = tracking.state.sessionMetrics;
          const calibReliable = metricsTrustworthy(tracking.state.calibrationConfidence);
          physicalMetrics.calibrationReliable = calibReliable;
          physicalMetrics.calibrationConfidence = tracking.state.calibrationConfidence;
          physicalMetrics.identityReliable = identityReliable;
          if (calibReliable && identityReliable) {
            physicalMetrics.maxSpeedMs = sm.maxSpeedMs;
            physicalMetrics.avgSpeedMs = sm.avgSpeedMs;
            physicalMetrics.distanceCoveredM = sm.distanceCoveredM;
            physicalMetrics.sprintCount = sm.sprintCount;
            // Duelos: distancia en metros (≤1.8 m) + por-jugador → calibración + identidad.
            physicalMetrics.duelCount = tracking.state.duelEvents.length;
          }
          // Escaneo (ángulo de cabeza): indep. de calibración pero SÍ de identidad
          // (es del jugador enfocado) → gatea solo por identidad.
          if (identityReliable) physicalMetrics.scanCount = tracking.state.scanEvents.length;
          // Conteo bruto de tracks: ni calibración ni identidad → siempre.
          physicalMetrics.tracksDetected = tracking.state.currentTracks.length;
        }

        await v2.analyzeWithClientData({
          videoId: selectedVideoId,
          playerId: selectedPlayerId,
          playedPosition: finalPlayedPosition,
          biomechanics: mediaPipe.biomechanics ? {
            drillScore: mediaPipe.biomechanics.drillScore,
            bilateralSymmetry: mediaPipe.biomechanics.bilateralSymmetry,
            // Campos reales de BiomechanicsScore (antes leía injuryRiskFlags /
            // avgJointAngles, que no existen → se enviaba undefined y se perdían).
            injuryRisk: mediaPipe.biomechanics.injuryRisk,
            jointDetail: mediaPipe.biomechanics.jointDetail,
            framesAnalyzed: mediaPipe.biomechanics.framesAnalyzed,
            source: "client_mediapipe",
          } : null,
          physicalMetrics: Object.keys(physicalMetrics).length > 0 ? physicalMetrics : null,
          // Gated por identidad (identidad.md): sin identidad fiable de la pista, los
          // eventos por-jugador NO se atribuyen al menor por nombre → se omiten.
          eventSummary: (eventSummary && identityReliable) ? {
            totalEvents: eventSummary.totalEvents,
            passCompletionPct: eventSummary.passCompletionPct,
            passesAttempted: eventSummary.passesAttempted,
            passesCompleted: eventSummary.passesCompleted,
            duelsWon: eventSummary.duelsWon,
            duelsLost: eventSummary.duelsLost,
            recoveries: eventSummary.recoveries,
            sprintBursts: eventSummary.sprintBursts,
            shots: eventSummary.shots,
            xgContributions: eventSummary.xgContributions,
            vaepApprox: eventSummary.vaepApprox,
            source: "client_event_engine",
          } : null,
          attestation,
        });
      } else {
        // Fallback: standard pipeline via Bunny → Modal → Claude
        await v2.analyzeExistingVideo({
          videoId: selectedVideoId,
          bunnyVideoId,
          playerId: selectedPlayerId,
          playedPosition: finalPlayedPosition,
          attestation,
        });
      }

      SubscriptionService.incrementAnalysisCount();
      toast.dismiss(toastId);
      toast.success(t("lab.analysisComplete"), {
        description: hasClientData
          ? t("vitasLab.clientPipelineDone")
          : t("vitasLab.gpuPipelineDone"),
        duration: 5000,
      });
      setShowResultsPanel(true);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof ClipConsentBlockedError ? t("clipConsent.blockedTitle") : t("lab.analysisError"), {
        description: err instanceof Error ? err.message : t("vitasLab.unknownError"),
      });
    }
  };

  // Presets de perspectiva comunes para calibración rápida
  const CALIBRATION_PRESETS: Record<string, { label: string; points: CalibrationPoint[] }> = {
    lateral: {
      label: t("vitasLab.viewLateral"),
      points: [
        { id: 1, x: 15, y: 55, label: "P1" },
        { id: 2, x: 85, y: 55, label: "P2" },
        { id: 3, x: 92, y: 90, label: "P3" },
        { id: 4, x: 8, y: 90, label: "P4" },
      ],
    },
    aerial: {
      label: t("vitasLab.viewAerial"),
      points: [
        { id: 1, x: 10, y: 10, label: "P1" },
        { id: 2, x: 90, y: 10, label: "P2" },
        { id: 3, x: 90, y: 90, label: "P3" },
        { id: 4, x: 10, y: 90, label: "P4" },
      ],
    },
    tribuna: {
      label: t("vitasLab.viewStand"),
      points: [
        { id: 1, x: 20, y: 45, label: "P1" },
        { id: 2, x: 80, y: 45, label: "P2" },
        { id: 3, x: 88, y: 85, label: "P3" },
        { id: 4, x: 12, y: 85, label: "P4" },
      ],
    },
  };

  const [showCalibPresets, setShowCalibPresets] = useState(false);

  const handleAutoDetect = () => {
    // If video is loaded, try auto field line detection first
    if (labVideoRef.current && labVideoRef.current.readyState >= 2) {
      runAutoCalibration();
    } else {
      setShowCalibPresets(v => !v);
    }
  };

  const resetPoints = () => {
    setPoints([
      { id: 1, x: 28, y: 62, label: "P1" },
      { id: 2, x: 72, y: 62, label: "P2" },
      { id: 3, x: 80, y: 92, label: "P3" },
      { id: 4, x: 20, y: 92, label: "P4" },
    ]);
  };

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);
  const selectedVideo  = videos.find((v) => v.id === selectedVideoId);
  const labVideoUrl    = selectedVideo ? getBestVideoUrl(selectedVideo) : null;

  // Sync play/pause with real video element
  useEffect(() => {
    const vid = labVideoRef.current;
    if (!vid) {
      // Fallback: timer-based when no video element
      if (!isPlaying) return;
      const interval = setInterval(() => {
        setCurrentTime((t) => (t >= (videoDuration || totalTime) ? 0 : t + 1));
      }, 1000);
      return () => clearInterval(interval);
    }
    if (isPlaying) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  }, [isPlaying, videoDuration]);

  // Update currentTime from video timeupdate events
  useEffect(() => {
    const vid = labVideoRef.current;
    if (!vid) return;
    const onTimeUpdate = () => setCurrentTime(Math.floor(vid.currentTime));
    const onLoadedMeta = () => {
      setVideoDuration(Math.floor(vid.duration));
      setCurrentTime(0);
    };
    const onEnded = () => setIsPlaying(false);
    vid.addEventListener("timeupdate", onTimeUpdate);
    vid.addEventListener("loadedmetadata", onLoadedMeta);
    vid.addEventListener("ended", onEnded);
    return () => {
      vid.removeEventListener("timeupdate", onTimeUpdate);
      vid.removeEventListener("loadedmetadata", onLoadedMeta);
      vid.removeEventListener("ended", onEnded);
    };
  }, [labVideoUrl]);

  const effectiveDuration = videoDuration || totalTime;
  const progressPercent = (currentTime / effectiveDuration) * 100;

  // ── Análisis de precisión (tiling) — control visible en el flujo 1-click ──
  const trackingRunning =
    tracking.state.status === "tracking" || tracking.state.status === "loading-model";
  const precisionPhase: PrecisionPhase = trackingRunning
    ? "running"
    : tracking.state.status === "complete" || v2.isCompleted
      ? "complete"
      : "before";

  /** Lanza (o relanza) la pasada 1-click completa sobre el vídeo cargado. Reutilizado
   *  por el botón ANALIZAR, por "Re-analizar con precisión" y por el reinicio en caliente. */
  const launchAnalysisPass = () => {
    if (!selectedVideoId || !selectedPlayerId || !labVideoRef.current) {
      toast.error(t("vitasLab.selectPlayerAndVideoFirst"));
      return;
    }
    if (!canRunAnalysis) {
      setShowUpgradePrompt(true);
      return;
    }
    // La pasada local (tracking en el navegador) también es un análisis del clip: sin la
    // declaración no arranca. El servidor no puede impedir el proceso local; sí lo exige
    // (con el menor de 14) al recibir los resultados en generate-reports.
    if (!attested) {
      toast.error(t("clipConsent.blockedTitle"), { description: t("clipConsent.analysisNeedsAttestation"), duration: 5000 });
      return;
    }
    setActionLog([]);
    oneClick.reset();
    oneClick.startOneClick(labVideoRef.current);
  };

  const labAttestation = (
    <ClipAttestationField id="vitas-lab-attestation" checked={attested} onChange={setAttested} purpose="analysis" />
  );

  /** Cambio del toggle de precisión. La persistencia ya la hace PrecisionToggle
   *  (setTilingConfig). Si hay una pasada EN CURSO, se reinicia: el worker se re-INIT
   *  con la nueva config (el tiling no se puede aplicar a mitad de pasada). */
  const handlePrecisionToggle = () => {
    if (!trackingRunning || !labVideoRef.current) return;
    tracking.stopTracking();
    if (mediaPipe.status === "processing") mediaPipe.stop();
    oneClick.reset();
    // Reiniciar tras un tick para que el worker anterior se termine limpiamente.
    setTimeout(() => {
      if (labVideoRef.current) launchAnalysisPass();
    }, 300);
  };

  // Dimension labels
  const dimLabels: Record<string, string> = {
    velocidadDecision:   t("lab.dimensions.velocidadDecision"),
    tecnicaConBalon:     t("lab.dimensions.tecnicaConBalon"),
    inteligenciaTactica: t("lab.dimensions.inteligenciaTactica"),
    capacidadFisica:     t("lab.dimensions.capacidadFisica"),
    liderazgoPresencia:  t("lab.dimensions.liderazgoPresencia"),
    eficaciaCompetitiva: t("lab.dimensions.eficaciaCompetitiva"),
  };

  return (
    <>
    <motion.div variants={container} initial="hidden" animate="show" className="min-h-screen flex flex-col">

      {/* Top Nav */}
      <motion.div variants={item} className="glass-strong px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Camera size={16} className="text-primary" />
            </div>
            <span className="font-display font-bold text-foreground text-lg">
              VITAS<span className="text-muted-foreground">.LAB</span>
            </span>
          </div>
          <nav className="hidden md:flex items-center gap-6 ml-6">
            {[
              { label: t("vitasLab.navPanel"),    action: () => navigate("/")         },
              { label: t("vitasLab.navNewAnalysis"), action: () => setShowUploadPanel(true) },
              { label: t("vitasLab.navArchive"),      action: () => navigate("/reports")  },
              { label: t("vitasLab.navModels"),       action: () => toast.info(t("lab.modelsComingSoon"), { description: t("lab.modelsComingSoonDesc") }) },
            ].map(({ label, action }, i) => (
              <button key={label} onClick={action} className={`text-xs font-display font-semibold tracking-wider transition-colors ${i === 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <span className="text-[10px] font-display text-primary uppercase tracking-wider">
              {t("vitasLab.systemStatus")}: <span className="text-primary">{v2.isProcessing ? t("vitasLab.statusAnalyzing") : t("vitasLab.statusActive")}</span>
            </span>
            <br />
            <span className="text-[10px] font-display text-muted-foreground tracking-wider">
              {selectedVideo ? `${t("vitasLab.videoLabel")}: ${selectedVideo.title.slice(0, 20)}` : t("vitasLab.noVideoSelected")}
            </span>
          </div>
          <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center">
            <UserRound size={14} className="text-muted-foreground" />
          </div>
        </div>
      </motion.div>

      {/* ── Degradation Banners: warn when features are unavailable ── */}
      {!SUPABASE_CONFIGURED && (
        <div className="px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/30 flex items-center gap-2">
          <AlertTriangle size={14} className="text-yellow-500 shrink-0" />
          <span className="text-[11px] font-display text-yellow-500">
            {t("vitasLab.supabaseNotConfigured")}
          </span>
        </div>
      )}
      {SUPABASE_CONFIGURED && !import.meta.env.VITE_BUNNY_CDN_HOSTNAME && videos.length === 0 && (
        <div className="px-4 py-1.5 bg-blue-500/10 border-b border-blue-500/30 flex items-center gap-2">
          <Activity size={14} className="text-blue-400 shrink-0" />
          <span className="text-[11px] font-display text-blue-400">
            {t("vitasLab.bunnyCdnNotConfigured")}
          </span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex">

        {/* Left Stepper */}
        <motion.div variants={item} className="hidden md:flex flex-col items-center py-8 px-4 gap-2 border-r border-border">
          {steps.map((step, i) => (
            <div key={step.id} className="flex flex-col items-center">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-display font-bold border-2 ${step.done ? "border-primary bg-primary/10 text-primary" : step.active ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                {step.done ? <CheckCircle2 size={18} /> : step.id}
              </div>
              <span className={`text-[9px] font-display font-semibold uppercase tracking-widest mt-1 ${step.done || step.active ? "text-primary" : "text-muted-foreground"}`}>
                {t(step.labelKey)}
              </span>
              {i < steps.length - 1 && (
                <div className={`w-0.5 h-10 my-1 ${step.done ? "bg-primary" : "bg-border"}`} />
              )}
            </div>
          ))}
        </motion.div>

        {/* Center - Pitch + Video */}
        <LabPitchView
          containerRef={containerRef}
          labVideoRef={labVideoRef}
          canvasRef={canvasRef}
          trackingVideoRef={trackingVideoRef}
          tracking={tracking}
          v2={v2}
          labVideoUrl={labVideoUrl}
          selectedVideo={selectedVideo}
          draggingPoint={draggingPoint}
          showVoronoi={showVoronoi}
          showTracking={showTracking}
          showCalibPresets={showCalibPresets}
          CALIBRATION_PRESETS={CALIBRATION_PRESETS}
          actionLog={actionLog}
          points={points}
          videoDuration={videoDuration}
          isPlaying={isPlaying}
          effectiveDuration={effectiveDuration}
          progressPercent={progressPercent}
          currentTime={currentTime}
          resetPoints={resetPoints}
          handleAutoDetect={handleAutoDetect}
          handleCanvasMouseDown={handleCanvasMouseDown}
          handleCanvasMouseMove={handleCanvasMouseMove}
          handleCanvasMouseUp={handleCanvasMouseUp}
          setPoints={setPoints}
          setShowCalibPresets={setShowCalibPresets}
          setShowUploadPanel={setShowUploadPanel}
          setShowResultsPanel={setShowResultsPanel}
          setIsPlaying={setIsPlaying}
          setCurrentTime={setCurrentTime}
        />

        {/* Right Sidebar — 1-Click Mode */}
        <motion.div variants={item} className="hidden lg:flex flex-col w-72 border-l border-border p-5 overflow-y-auto max-h-screen">
          <VitasLabOneClick
            players={players.map(p => ({ id: p.id, name: p.name, position: p.position, vsi: p.vsi, age: p.age }))}
            videos={videos.map(v => ({ id: v.id, title: v.title }))}
            selectedPlayerId={selectedPlayerId}
            selectedVideoId={selectedVideoId}
            oneClickState={oneClick.state}
            isTracking={tracking.state.status === "tracking" || tracking.state.status === "loading-model"}
            isIAProcessing={v2.isProcessing}
            isIAComplete={v2.isCompleted}
            onSelectPlayer={(id) => {
              setSelectedPlayerId(id);
              const p = players.find(pl => pl.id === id);
              if (p?.name) setPlayerName(p.name);
              if (p?.position) setPlayerPosition(p.position);
            }}
            onSelectVideo={(id) => setSelectedVideoId(id)}
            onStartAnalysis={launchAnalysisPass}
            consentControl={labAttestation}
            consentReady={attested}
            precisionControl={
              <PrecisionToggle
                phase={precisionPhase}
                activePrecision={passUsedPrecision}
                onToggle={handlePrecisionToggle}
                onReanalyze={launchAnalysisPass}
              />
            }
            onStopTracking={() => {
              tracking.stopTracking();
              if (mediaPipe.status === "processing") mediaPipe.stop();
              setEventSummary(eventEngineRef.current.summarize(tracking.state.focusTrackId ?? undefined));
              setTacticalEvents(eventEngineRef.current.getEvents());
              oneClick.advanceStep("analyzing_biomechanics");
              // Auto-trigger IA analysis after tracking stops
              setTimeout(() => {
                oneClick.advanceStep("running_ia_pipeline");
                handleStartAnalysis();
              }, 500);
            }}
            onOpenUploadPanel={() => setShowUploadPanel(true)}
            onViewResults={() => setShowResultsPanel(true)}
          >
            {/* ── Advanced Settings (collapsed by default) ── */}

          {/* Auto-detected player identity · Config de análisis */}
          <LabAnalysisConfig
            selectedMode={selectedMode}
            setSelectedMode={setSelectedMode}
            playerName={playerName}
            setPlayerName={setPlayerName}
            playerPosition={playerPosition}
            setPlayerPosition={setPlayerPosition}
            homeFormation={homeFormation}
            setHomeFormation={setHomeFormation}
            awayFormation={awayFormation}
            setAwayFormation={setAwayFormation}
            playedPosition={playedPosition}
            setPlayedPosition={setPlayedPosition}
            analysisFocus={analysisFocus}
            setAnalysisFocus={setAnalysisFocus}
            isClub={isClub}
            setShowUpgradePrompt={setShowUpgradePrompt}
            selectedPlayerId={selectedPlayerId}
            players={players}
          />

          {/* Tracking YOLO en vivo */}
          {showTracking && (
            <LabLiveTrackingPanel
              tracking={tracking}
              mediaPipe={mediaPipe}
              eventSummary={eventSummary}
              showVoronoi={showVoronoi}
              setShowVoronoi={setShowVoronoi}
            />
          )}

          {/* Export Data — available after tracking completes (in advanced section) */}
          <LabExportButtons
            tracking={tracking}
            biomechanics={mediaPipe.biomechanics}
            selectedPlayerId={selectedPlayerId}
            selectedPlayerName={selectedPlayer?.name}
            selectedVideoId={selectedVideoId}
            tacticalEvents={tacticalEvents}
            eventSummary={eventSummary}
          />

          </VitasLabOneClick>
        </motion.div>
      </div>

      {/* ── Upload Panel ─────────────────────────────────────────────────────── */}
      <LabUploadPanel
        open={showUploadPanel}
        onClose={() => setShowUploadPanel(false)}
        videos={videos}
        players={players}
        selectedVideoId={selectedVideoId}
        onSelectVideo={setSelectedVideoId}
        onStartAnalysis={handleStartAnalysis}
        consentControl={labAttestation}
        consentReady={attested}
      />

      {/* ── Results Panel ─────────────────────────────────────────────────────── */}
      <LabResultsPanel
        open={showResultsPanel && v2.isCompleted}
        report={analysisReport}
        onClose={() => setShowResultsPanel(false)}
        showHistorial={showHistorial}
        onToggleHistorial={() => setShowHistorial(!showHistorial)}
        savedAnalyses={savedAnalyses}
        onLoadAnalysis={(id) => { v2.loadAnalysis(id).then(() => setShowHistorial(false)); }}
        playerName={playerName}
        playerPosition={playerPosition}
        dimLabels={dimLabels}
        fatigueReport={fatigue.report}
        xgSummary={xgSummary}
        phvOffset={selectedPlayer?.phvOffset ?? null}
        analysisViewMode={analysisViewMode}
        onChangeViewMode={(mode) => {
          setAnalysisViewMode(mode);
          if (mode !== "player" && tracking.state.status === "complete") {
            teamAnalysis.generateReports();
          }
        }}
        teamReport={teamAnalysis.teamReport}
        homeFormation={teamAnalysis.homeFormation}
        awayFormation={teamAnalysis.awayFormation}
        rivalReport={teamAnalysis.rivalReport}
        selectedPlayerId={selectedPlayerId}
        selectedPlayerName={selectedPlayer?.name}
        onNavigateToPlayer={(id) => navigate(`/players/${id}?tab=stats`)}
      />

      {/* Bottom Status Bar */}
      <LabStatusBar
        isProcessing={v2.isProcessing}
        pipelineStep={v2.state.step}
        mediaPipeStatus={mediaPipe.status}
        mediaPipeFps={mediaPipe.fps}
        mediaPipeFramesProcessed={mediaPipe.framesProcessed}
        totalEvents={eventSummary?.totalEvents}
      />
    </motion.div>

    {/* ── Upgrade Prompt Modal ── */}
    <UpgradePrompt
      feature={!canRunAnalysis ? t("vitasLab.featureIaAnalysis") : t("vitasLab.featureFullTeamMode")}
      requiredPlan={!canRunAnalysis ? (plan === "free" ? "pro" : "club") : "club"}
      currentUsage={!canRunAnalysis ? t("vitasLab.analysesUsed", { used: analysesUsed, total: limits.analyses >= 9999 ? "∞" : limits.analyses }) : undefined}
      variant="modal"
      open={showUpgradePrompt}
      onClose={() => setShowUpgradePrompt(false)}
    />
    </>
  );
};

export default VitasLab;
