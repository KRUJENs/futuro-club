/**
 * VITAS · SoloDrill — Sesiones individuales de entrenamiento
 * Bloque B Fase 3: Flujo completo de drill con pipeline IA
 */

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Camera, Play, Zap, ChevronRight, ChevronDown, ChevronUp,
  Users, Target, Brain, TrendingUp, Upload, X, Loader2,
  BookOpen, Clock, BarChart2, CheckCircle2, AlertTriangle,
  Star, Rocket,
} from "lucide-react";
import PageHeader from "@/components/shared/PageHeader";
import VideoUpload from "@/components/VideoUpload";
import { IS_DEMO } from "@/lib/demoMode";
import { useAllPlayers } from "@/hooks/usePlayers";
import { useAuth } from "@/context/AuthContext";
import { DRILLS_LIBRARY, type DrillDocument } from "@/data/drillsLibrary";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getAuthHeaders } from "@/lib/apiAuth";
import { ClipConsentBlockedError, clipConsentErrorFromResponse } from "@/lib/shared/videoConsent";

// ─── Types ────────────────────────────────────────────────────────────────────

type DrillCategory = DrillDocument["category"];

interface Dimension {
  score: number;
  observacion: string;
}

interface DrillReport {
  estadoActual: {
    resumenEjecutivo: string;
    nivelActual: string;
    fortalezasPrimarias: string[];
    areasDesarrollo: string[];
    dimensiones: Record<string, Dimension>;
    ajusteVSIVideoScore: number | null; // null ⇒ VSI-vídeo bloqueado (#40)
  };
  adnFutbolistico: {
    estiloJuego: string;
    arquetipoTactico: string;
    mentalidad: string;
  };
  jugadorReferencia?: {
    bestMatch?: {
      nombre: string;
      posicion: string;
      club: string;
      score: number;
    };
  };
  planDesarrollo: {
    objetivo6meses: string;
    pilaresTrabajo: Array<{ pilar: string; acciones: string[]; prioridad: string }>;
  };
  confianza: number;
}

type DrillSessionState = "idle" | "uploading" | "analyzing" | "done" | "error";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<DrillCategory, { labelKey: string; descKey: string; icon: string; color: string }> = {
  tecnica:    { labelKey: "drill.categories.tecnica", descKey: "drill.categories.tecnicaDesc", icon: "⚽", color: "from-primary/20 to-primary/5 border-primary/20" },
  tactica:    { labelKey: "drill.categories.tactica", descKey: "drill.categories.tacticaDesc", icon: "🧠", color: "from-violet-500/20 to-violet-500/5 border-violet-500/20" },
  fisico:     { labelKey: "drill.categories.fisico",  descKey: "drill.categories.fisicoDesc",  icon: "⚡", color: "from-amber-500/20 to-amber-500/5 border-amber-500/20" },
  disparo:    { labelKey: "drill.categories.disparo", descKey: "drill.categories.disparoDesc", icon: "🎯", color: "from-red-500/20 to-red-500/5 border-red-500/20" },
  pressing:   { labelKey: "drill.categories.pressing", descKey: "drill.categories.pressingDesc", icon: "🔥", color: "from-orange-500/20 to-orange-500/5 border-orange-500/20" },
  transicion: { labelKey: "drill.categories.transicion", descKey: "drill.categories.transicionDesc", icon: "🔄", color: "from-green-500/20 to-green-500/5 border-green-500/20" },
};

const DIFFICULTY_COLOR: Record<string, string> = {
  basico:      "bg-green-500/10 text-green-600 border-green-500/20",
  intermedio:  "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  avanzado:    "bg-red-500/10 text-red-500 border-red-500/20",
};

const DIM_LABELS: Record<string, string> = {
  velocidadDecision:   "Velocidad Decisión",
  tecnicaConBalon:     "Técnica con Balón",
  inteligenciaTactica: "Inteligencia Táctica",
  capacidadFisica:     "Capacidad Física",
  liderazgoPresencia:  "Liderazgo",
  eficaciaCompetitiva: "Eficacia Competitiva",
};

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { duration: 0.4 } } };

// ─── Component ────────────────────────────────────────────────────────────────

const SoloDrill = () => {
  const { t, i18n } = useTranslation();
  const navigate  = useNavigate();
  const { user }  = useAuth();
  const { data: players = [] } = useAllPlayers();

  // Panel + session state
  const [showPanel,         setShowPanel]         = useState(false);
  const [selectedPlayerId,  setSelectedPlayerId]  = useState<string | null>(null);
  const [selectedCategory,  setSelectedCategory]  = useState<DrillCategory | null>(null);
  const [sessionState,      setSessionState]      = useState<DrillSessionState>("idle");
  const [sessionVideoId,    setSessionVideoId]    = useState<string | null>(null);
  const [sessionReport,     setSessionReport]     = useState<DrillReport | null>(null);
  const [showPlayerDrop,    setShowPlayerDrop]    = useState(false);

  // Drill library expansion
  const [expandedCategory, setExpandedCategory] = useState<DrillCategory | null>(null);

  // Filtered drills
  const filteredDrills = useMemo(() => {
    if (!expandedCategory) return [];
    return DRILLS_LIBRARY.filter((d) => d.category === expandedCategory).slice(0, 6);
  }, [expandedCategory]);

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);

  // ── Open panel with optional pre-selected player ──────────────────────────
  const openPanel = (playerId?: string) => {
    if (playerId) setSelectedPlayerId(playerId);
    setSessionState("idle");
    setSessionVideoId(null);
    setSessionReport(null);
    setShowPanel(true);
  };

  // ── Called when VideoUpload finishes ─────────────────────────────────────
  const handleVideoDone = async (videoId: string) => {
    setSessionVideoId(videoId);
    if (!selectedPlayerId) {
      toast.info(t("drill.selectPlayerFirst"));
      return;
    }
    await runAnalysis(videoId, selectedPlayerId);
  };

  // ── Run pipeline ──────────────────────────────────────────────────────────
  const runAnalysis = async (videoId: string, playerId: string) => {
    setSessionState("analyzing");
    const toastId = toast.loading(t("toasts.drillAnalyzing"), {
      description: t("toasts.drillAnalyzingDesc"),
    });

    try {
      const headers = await getAuthHeaders();

      const res = await fetch("/api/pipeline/start", {
        method: "POST",
        headers,
        body: JSON.stringify({
          videoId,
          playerId,
          analysisMode: selectedCategory ?? "all",
          // Idioma de los motivos de bloqueo que devuelve el servidor (se muestran tal cual).
          locale: i18n.language,
        }),
      });

      const data = await res.json() as {
        success?: boolean;
        report?: DrillReport;
        error?: string;
        phase2Pending?: boolean;
      };

      if (data.phase2Pending) {
        toast.dismiss(toastId);
        toast.warning(t("toasts.bunnyStreamWarning"));
        setSessionState("idle");
        return;
      }

      // Consentimiento (decisión del owner, 30 sep): pipeline/start exige la declaración que
      // se marcó al subir el vídeo en VideoUpload (guardada con él) y, para un menor de 14
      // conocido, consentimiento parental verificado. Su motivo se muestra tal cual.
      const consentErr = clipConsentErrorFromResponse(data, i18n.language);
      if (consentErr) throw consentErr;
      if (!res.ok || !data.success || !data.report) {
        throw new Error(data.error ?? t("soloDrill.pipelineError"));
      }

      setSessionReport(data.report);
      setSessionState("done");

      // Increment drills completed counter for Director Dashboard
      const prev = Number(localStorage.getItem("vitas_drills_completed_count") ?? "0");
      localStorage.setItem("vitas_drills_completed_count", String(prev + 1));

      toast.dismiss(toastId);
      toast.success(t("toasts.drillAnalyzed"), {
        description: `${t("common.confidence")}: ${Math.round((data.report.confianza ?? 0) * 100)}%`,
      });
    } catch (err) {
      setSessionState("error");
      toast.dismiss(toastId);
      toast.error(err instanceof ClipConsentBlockedError ? t("clipConsent.blockedTitle") : t("drill.analysisError"), {
        description: err instanceof Error ? err.message : t("errors.unknownError"),
      });
    }
  };

  // ── Reset session ─────────────────────────────────────────────────────────
  const resetSession = () => {
    setSessionState("idle");
    setSessionVideoId(null);
    setSessionReport(null);
  };

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="px-4 pt-4 pb-24 space-y-6 max-w-lg lg:max-w-5xl mx-auto">

      {/* Header */}
      <motion.div variants={item}>
        <PageHeader title={t("drill.title")} subtitle={t("drill.subtitle")} />
      </motion.div>

      {/* Record CTA */}
      <motion.div
        variants={item}
        whileTap={{ scale: 0.97 }}
        onClick={() => openPanel()}
        className="relative overflow-hidden rounded-2xl border border-primary/30 p-6 cursor-pointer group"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent" />
        <div className="relative flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-primary/20 flex items-center justify-center">
            <Camera size={24} className="text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="font-display font-bold text-lg text-foreground">{t("drill.recordNew")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("drill.recordDesc")}
            </p>
          </div>
          <Play size={20} className="text-primary group-hover:scale-110 transition-transform" />
        </div>
      </motion.div>

      {/* Categorías de drill */}
      <motion.div variants={item}>
        <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3">
          {t("drill.trainingCategories")}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {(Object.entries(CATEGORY_CONFIG) as [DrillCategory, typeof CATEGORY_CONFIG[DrillCategory]][]).map(([id, cat]) => (
            <motion.div key={id} whileTap={{ scale: 0.96 }}>
              <div
                onClick={() => setExpandedCategory(expandedCategory === id ? null : id)}
                className={`rounded-xl border bg-gradient-to-br p-4 cursor-pointer transition-opacity hover:opacity-80 ${cat.color}`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-2xl">{cat.icon}</div>
                  {expandedCategory === id
                    ? <ChevronUp size={14} className="text-muted-foreground" />
                    : <ChevronDown size={14} className="text-muted-foreground" />}
                </div>
                <h3 className="font-display font-semibold text-sm text-foreground mt-2">{t(cat.labelKey)}</h3>
                <p className="text-[10px] text-muted-foreground">{t(cat.descKey)}</p>
              </div>

              {/* Expanded drills list */}
              <AnimatePresence>
                {expandedCategory === id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 space-y-2 col-span-2">
                      {filteredDrills.map((drill) => (
                        <div key={drill.id} className="glass rounded-xl p-3 border border-border">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-display font-semibold text-foreground">{drill.name}</p>
                                <span className={`text-[9px] font-display px-1.5 py-0.5 rounded border ${DIFFICULTY_COLOR[drill.difficulty]}`}>
                                  {drill.difficulty}
                                </span>
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                                {drill.description}
                              </p>
                              <div className="flex items-center gap-3 mt-1.5">
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <Clock size={9} /> {drill.durationMin}min
                                </span>
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <Users size={9} /> {drill.playerCount}
                                </span>
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <BarChart2 size={9} /> {drill.sets}x {drill.repsOrDuration}
                                </span>
                              </div>
                            </div>
                            <button
                              onClick={() => { setSelectedCategory(id); openPanel(); }}
                              className="shrink-0 p-2 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                            >
                              <Play size={12} />
                            </button>
                          </div>
                          {/* Métricas mejoradas */}
                          <div className="flex flex-wrap gap-1 mt-2">
                            {drill.metricsImproved.map((m) => (
                              <span key={m} className="text-[9px] font-display px-1.5 py-0.5 rounded bg-primary/5 text-primary border border-primary/10">
                                +{m}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                      <button
                        onClick={() => { setSelectedCategory(id); openPanel(); }}
                        className="w-full py-2 text-xs font-display font-semibold text-primary flex items-center justify-center gap-1 hover:opacity-80 transition-opacity"
                      >
                        <Rocket size={11} /> {t("drill.recordDrillOf", { category: t(cat.labelKey) })}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Acciones rápidas */}
      <motion.div variants={item}>
        <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3">
          {t("drill.quickActions")}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: t("drill.actions.viewRankings"),        icon: TrendingUp, onClick: () => navigate("/rankings"),  color: "text-primary" },
            { label: t("drill.actions.comparePlayers"),  icon: Target,     onClick: () => navigate("/compare"),   color: "text-violet-400" },
            { label: t("drill.actions.intelligenceReport"), icon: Brain,      onClick: () => players[0] ? navigate(`/players/${players[0].id}/intelligence`) : navigate("/rankings"), color: "text-amber-400" },
            { label: "VITAS.LAB",           icon: Upload,     onClick: () => navigate("/lab"),        color: "text-green-400" },
          ].map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                onClick={action.onClick}
                className="glass rounded-xl p-3 flex items-center gap-3 hover:border-primary/30 border border-transparent transition-all text-left"
              >
                <Icon size={16} className={action.color} />
                <span className="text-xs font-display font-medium text-foreground">{action.label}</span>
              </button>
            );
          })}
        </div>
      </motion.div>

      {/* Mis Jugadores */}
      <motion.div variants={item}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-primary" />
            <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider">
              {t("drill.myPlayers")}
            </h2>
          </div>
          <button
            onClick={() => navigate("/rankings")}
            className="text-[10px] text-primary font-display font-semibold flex items-center gap-1"
          >
            {t("common.viewAll")} <ChevronRight size={10} />
          </button>
        </div>

        {players.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center space-y-2">
            <Users size={24} className="text-muted-foreground mx-auto" />
            <p className="text-sm font-display font-semibold text-foreground">{t("drill.noPlayers")}</p>
            <p className="text-xs text-muted-foreground">{t("drill.noPlayersDesc")}</p>
            <button
              onClick={() => navigate("/players/new")}
              className="text-xs text-primary font-display font-semibold hover:underline"
            >
              {t("drill.addFirstPlayer")}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {players.slice(0, 5).map((player) => (
              <motion.div key={player.id} whileTap={{ scale: 0.98 }} className="glass rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
                  <span className="text-xs font-display font-bold text-muted-foreground">
                    {player.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-display font-medium text-foreground truncate">{player.name}</p>
                  <p className="text-[10px] text-muted-foreground">{player.position} · VSI {player.vsi ?? "—"}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => openPanel(player.id)}
                    className="p-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    title={t("soloDrill.newDrillTitle")}
                  >
                    <Camera size={12} />
                  </button>
                  <button
                    onClick={() => navigate(`/players/${player.id}/intelligence`)}
                    className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                    title="Intelligence"
                  >
                    <Brain size={12} />
                  </button>
                  <button
                    onClick={() => navigate(`/players/${player.id}/role-profile`)}
                    className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                    title={t("soloDrill.roleProfileTitle")}
                  >
                    <Target size={12} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* ── Drill Session Panel (slide-in from bottom) ────────────────────────── */}
      <AnimatePresence>
        {showPanel && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
              onClick={() => { if (sessionState !== "analyzing") setShowPanel(false); }}
            />
            <motion.div
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 35 }}
              className="fixed bottom-0 left-0 right-0 max-h-[90vh] bg-card border-t border-border z-50 rounded-t-2xl flex flex-col"
            >
              {/* Handle + Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <BookOpen size={16} className="text-primary" />
                  <span className="font-display font-bold text-foreground">{t("drill.newSession")}</span>
                  {sessionState === "done" && (
                    <span className="text-[10px] font-display px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20">
                      ✓ {t("drill.completed")}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => { if (sessionState !== "analyzing") setShowPanel(false); }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  disabled={sessionState === "analyzing"}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-5">

                {/* ── Step 1: Jugador ───────────────────────────────────────── */}
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                    {t("drill.stepPlayer")}
                  </p>
                  <div className="relative">
                    <button
                      onClick={() => setShowPlayerDrop((v) => !v)}
                      disabled={sessionState === "analyzing"}
                      className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border border-border bg-secondary/50 hover:bg-secondary transition-colors text-left disabled:opacity-50"
                    >
                      <span className={`text-sm font-display font-semibold ${selectedPlayer ? "text-foreground" : "text-muted-foreground"}`}>
                        {selectedPlayer ? selectedPlayer.name : t("common.select")}
                      </span>
                      <ChevronDown size={14} className="text-muted-foreground" />
                    </button>
                    {showPlayerDrop && (
                      <div className="absolute top-full left-0 right-0 mt-1 glass rounded-xl border border-border z-20 max-h-40 overflow-y-auto">
                        {players.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => { setSelectedPlayerId(p.id); setShowPlayerDrop(false); }}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-primary/5 flex items-center justify-between transition-colors ${selectedPlayerId === p.id ? "text-primary font-semibold" : "text-foreground"}`}
                          >
                            <span>{p.name}</span>
                            <span className="text-[10px] text-muted-foreground">{p.position} · VSI {p.vsi ?? "—"}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Step 2: Categoría ─────────────────────────────────────── */}
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                    {t("drill.stepDrillType")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(Object.entries(CATEGORY_CONFIG) as [DrillCategory, typeof CATEGORY_CONFIG[DrillCategory]][]).map(([id, cat]) => (
                      <button
                        key={id}
                        onClick={() => setSelectedCategory(selectedCategory === id ? null : id)}
                        disabled={sessionState === "analyzing"}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-display font-semibold transition-all disabled:opacity-50 ${
                          selectedCategory === id
                            ? "bg-primary/10 border-primary text-primary"
                            : "border-border text-muted-foreground hover:border-primary/30"
                        }`}
                      >
                        <span>{cat.icon}</span>
                        {t(cat.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Step 3: Video ─────────────────────────────────────────── */}
                {sessionState === "idle" && (
                  <div>
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                      {t("drill.stepVideo")}
                    </p>
                    {!selectedPlayerId ? (
                      <div className="glass rounded-xl p-4 text-center border border-dashed border-border">
                        <p className="text-xs text-muted-foreground">{t("drill.selectPlayerFirst")}</p>
                      </div>
                    ) : IS_DEMO ? (
                      <div className="glass rounded-xl p-4 text-center border border-dashed border-border">
                        <p className="text-xs text-muted-foreground">{t("drill.videoNotInDemo")}</p>
                      </div>
                    ) : (
                      <VideoUpload
                        onDone={handleVideoDone}
                      />
                    )}
                  </div>
                )}

                {/* ── Analyzing state ───────────────────────────────────────── */}
                {sessionState === "analyzing" && (
                  <div className="glass rounded-xl p-6 flex flex-col items-center gap-3 border border-primary/20">
                    <Loader2 size={28} className="text-primary animate-spin" />
                    <p className="font-display font-bold text-foreground text-sm">{t("drill.analyzingIA")}</p>
                    <p className="text-xs text-muted-foreground text-center">
                      {t("drill.analyzingDesc")}
                    </p>
                  </div>
                )}

                {/* ── Error state ───────────────────────────────────────────── */}
                {sessionState === "error" && (
                  <div className="glass rounded-xl p-4 border border-destructive/20">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle size={14} className="text-destructive" />
                      <p className="text-sm font-display font-semibold text-foreground">{t("drill.analysisError")}</p>
                    </div>
                    <button onClick={resetSession} className="text-xs text-primary font-display font-semibold hover:underline">
                      {t("drill.tryAgain")}
                    </button>
                  </div>
                )}

                {/* ── Results ───────────────────────────────────────────────── */}
                {sessionState === "done" && sessionReport && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={16} className="text-green-500" />
                      <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
                        {t("drill.results")}
                      </p>
                      <span className="ml-auto text-[10px] font-display px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        {Math.round(sessionReport.confianza * 100)}% {t("common.confidence")}
                      </span>
                    </div>

                    {/* Resumen */}
                    <div className="glass rounded-xl p-4">
                      <p className="text-xs font-display font-semibold text-muted-foreground mb-1">{t("drill.summary")}</p>
                      <p className="text-sm text-foreground leading-relaxed">{sessionReport.estadoActual.resumenEjecutivo}</p>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-[10px] font-display px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                          {sessionReport.estadoActual.nivelActual.replace("_", " ").toUpperCase()}
                        </span>
                        {sessionReport.estadoActual.ajusteVSIVideoScore != null && (
                          <span className={`text-[10px] font-display px-2 py-0.5 rounded-full ${sessionReport.estadoActual.ajusteVSIVideoScore >= 0 ? "bg-green-500/10 text-green-600 border border-green-500/20" : "bg-red-500/10 text-red-500 border border-red-500/20"}`}>
                            VSI {sessionReport.estadoActual.ajusteVSIVideoScore >= 0 ? "+" : ""}{sessionReport.estadoActual.ajusteVSIVideoScore}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Dimensiones — solo si son REALES (score por dimensión es constante
                        fabricada si el pipeline no las mide; no pintar barras falsas, inv #2) */}
                    {((sessionReport.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true) && (
                    <div className="space-y-2">
                      {Object.entries(sessionReport.estadoActual.dimensiones).map(([key, dim]) => (
                        <div key={key} className="glass rounded-lg px-4 py-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-display font-semibold text-foreground">
                              {DIM_LABELS[key] ?? key}
                            </span>
                            <span className="text-xs font-display font-bold text-primary">{dim.score.toFixed(1)}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${(dim.score / 10) * 100}%` }}
                              transition={{ duration: 0.8 }}
                              className={`h-full rounded-full ${dim.score >= 8 ? "bg-green-500" : dim.score >= 6 ? "bg-primary" : "bg-yellow-500"}`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    )}

                    {/* ADN */}
                    <div className="glass rounded-xl p-4">
                      <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                        {t("drill.footballDNA")}
                      </p>
                      <span className="text-[10px] font-display px-2 py-1 rounded-lg bg-primary/10 text-primary border border-primary/20">
                        {sessionReport.adnFutbolistico.arquetipoTactico}
                      </span>
                      <p className="text-xs text-muted-foreground mt-2">{sessionReport.adnFutbolistico.estiloJuego}</p>
                    </div>

                    {/* Jugador referencia */}
                    {sessionReport.jugadorReferencia?.bestMatch && (
                      <div className="glass rounded-xl p-4 border border-primary/20">
                        <div className="flex items-center gap-2 mb-2">
                          <Star size={12} className="text-yellow-500" />
                          <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
                            {t("drill.reference")}
                          </p>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-display font-bold text-sm text-foreground">{sessionReport.jugadorReferencia.bestMatch.nombre}</p>
                            <p className="text-[10px] text-muted-foreground">{sessionReport.jugadorReferencia.bestMatch.posicion} · {sessionReport.jugadorReferencia.bestMatch.club}</p>
                          </div>
                          <span className="text-xl font-display font-black text-primary">
                            {sessionReport.jugadorReferencia.bestMatch.score.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Plan */}
                    <div className="glass rounded-xl p-4">
                      <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                        {t("drill.next6months")}
                      </p>
                      <p className="text-xs text-foreground">{sessionReport.planDesarrollo.objetivo6meses}</p>
                      {sessionReport.planDesarrollo.pilaresTrabajo?.slice(0, 2).map((p, i) => (
                        <div key={i} className="mt-2">
                          <p className="text-[10px] font-display font-semibold text-foreground">{p.pilar}</p>
                          <ul className="mt-1 space-y-0.5">
                            {p.acciones.slice(0, 2).map((a, j) => (
                              <li key={j} className="text-[10px] text-muted-foreground flex items-start gap-1">
                                <span className="text-primary">›</span> {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pb-4">
                      <button
                        onClick={resetSession}
                        className="flex-1 py-3 rounded-xl border border-border text-xs font-display font-semibold text-foreground hover:bg-secondary transition-colors"
                      >
                        {t("drill.newDrill")}
                      </button>
                      {selectedPlayerId && (
                        <button
                          onClick={() => { setShowPanel(false); navigate(`/players/${selectedPlayerId}/intelligence`); }}
                          className="flex-1 py-3 rounded-xl bg-primary text-primary-foreground text-xs font-display font-semibold hover:bg-primary/90 transition-colors"
                        >
                          {t("drill.viewIntelligence")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default SoloDrill;
