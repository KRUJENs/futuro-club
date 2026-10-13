import { type ComponentProps } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, History, FileDown, X, Activity, Target, Star, TrendingUp, AlertTriangle, Zap, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import PlayerHeatmap from "@/components/PlayerHeatmap";
import FatiguePanel from "@/components/FatiguePanel";
import XgPanel from "@/components/XgPanel";
import TeamDashboard from "@/components/TeamDashboard";
import DrillRecommendations from "@/components/intelligence/DrillRecommendations";
import KnowledgeSearch from "@/components/KnowledgeSearch";
import type { XgSummary } from "@/lib/xg/xgAccumulator";
import type { AnalysisReport } from "./types";

type ViewMode = "player" | "team" | "rival";

interface SavedAnalysisRow {
  id: string;
  created_at: string;
  vsi: Record<string, unknown> | null;
}

interface LabResultsPanelProps {
  open: boolean;
  report: AnalysisReport | null;
  onClose: () => void;
  // Historial
  showHistorial: boolean;
  onToggleHistorial: () => void;
  savedAnalyses: SavedAnalysisRow[];
  onLoadAnalysis: (id: string) => void;
  // Export PDF / cabecera
  playerName: string;
  playerPosition: string;
  dimLabels: Record<string, string>;
  // Sub-paneles
  fatigueReport: ComponentProps<typeof FatiguePanel>["report"];
  xgSummary: XgSummary | null;
  phvOffset: number | null;
  // Modo de vista
  analysisViewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
  teamReport: ComponentProps<typeof TeamDashboard>["teamReport"];
  homeFormation: ComponentProps<typeof TeamDashboard>["homeFormation"];
  awayFormation: ComponentProps<typeof TeamDashboard>["awayFormation"];
  rivalReport: ComponentProps<typeof TeamDashboard>["rivalReport"];
  // CTA a la ficha
  selectedPlayerId: string | null;
  selectedPlayerName?: string;
  onNavigateToPlayer: (id: string) => void;
}

/** Slide-over del informe VITAS (resultados del análisis). Presentacional; el padre
 *  inyecta los datos y las acciones (historial, cambio de modo, navegación). */
const LabResultsPanel = ({
  open,
  report,
  onClose,
  showHistorial,
  onToggleHistorial,
  savedAnalyses,
  onLoadAnalysis,
  playerName,
  playerPosition,
  dimLabels,
  fatigueReport,
  xgSummary,
  phvOffset,
  analysisViewMode,
  onChangeViewMode,
  teamReport,
  homeFormation,
  awayFormation,
  rivalReport,
  selectedPlayerId,
  selectedPlayerName,
  onNavigateToPlayer,
}: LabResultsPanelProps) => {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {open && report && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="fixed top-0 right-0 h-full w-full max-w-lg bg-card border-l border-border z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-primary" />
                <span className="font-display font-bold text-foreground text-sm">VITAS Report</span>
                {report.confianza != null && (
                  <span className="text-[10px] font-display px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20">
                    {Math.round(report.confianza * 100)}%
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {/* Historial */}
                <button
                  onClick={onToggleHistorial}
                  className="flex items-center gap-1 text-[10px] font-display px-2 py-1 rounded-lg bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <History size={12} />
                  {t("lab.historial").toUpperCase()}{savedAnalyses.length > 0 ? ` (${savedAnalyses.length})` : ""}
                </button>
                {/* Exportar informe real — dos versiones: ejecutivo (dirección) y técnico (cuerpo técnico) */}
                {(["executive", "technical"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      const tempId = `temp-${Date.now()}-${m}`;
                      sessionStorage.setItem(`vitas-analysis-report-${tempId}`, JSON.stringify({
                        report,
                        playerName: playerName || t("vitasLab.playerFallback"),
                        playerPosition: playerPosition || t("vitasLab.noPosition"),
                      }));
                      window.open(`/analysis-report/${tempId}?mode=${m}`, "_blank");
                    }}
                    className="flex items-center gap-1 text-[10px] font-display px-2 py-1 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
                  >
                    <FileDown size={12} />
                    {m === "executive" ? t("analysisReportPrint.typeExecutive") : t("analysisReportPrint.typeTechnical")}
                  </button>
                ))}
                <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors ml-1">
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Dropdown Historial */}
            {showHistorial && savedAnalyses.length > 0 && (
              <div className="border-b border-border bg-muted/30 px-5 py-3 max-h-48 overflow-y-auto">
                <p className="text-[9px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">{t("vitasLab.savedAnalyses")}</p>
                <div className="space-y-1.5">
                  {savedAnalyses.map((sa) => (
                    <button
                      key={sa.id}
                      onClick={() => onLoadAnalysis(sa.id)}
                      className="w-full text-left glass rounded-lg px-3 py-2 hover:bg-primary/5 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-display font-semibold text-foreground">
                          VSI {((sa.vsi as Record<string, unknown>)?.vsi as string | number | undefined) ?? "—"}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {new Date(sa.created_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                        {t("vitasLab.analysisCompletedLoad")}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">

              {/* Resumen ejecutivo — solo lo que el agente produjo: sin texto ni nivel
                  inventados («Análisis completado…», «TALENT»; P1 bloque 2, inv #2). */}
              {(report.estadoActual.resumenEjecutivo || report.estadoActual.nivelActual || report.estadoActual.ajusteVSIVideoScore != null) && (
              <div className="glass rounded-xl p-4">
                <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-1">{t("vitasLab.executiveSummary")}</p>
                {report.estadoActual.resumenEjecutivo && (
                  <p className="text-sm text-foreground leading-relaxed">{report.estadoActual.resumenEjecutivo}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {report.estadoActual.nivelActual && (
                    <span className="text-[10px] font-display px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {report.estadoActual.nivelActual.replace("_", " ").toUpperCase()}
                    </span>
                  )}
                  {report.estadoActual.ajusteVSIVideoScore != null && (
                    <span className={`text-[10px] font-display px-2 py-0.5 rounded-full ${report.estadoActual.ajusteVSIVideoScore >= 0 ? "bg-green-500/10 text-green-600 border border-green-500/20" : "bg-red-500/10 text-red-500 border border-red-500/20"}`}>
                      VSI {report.estadoActual.ajusteVSIVideoScore >= 0 ? "+" : ""}{report.estadoActual.ajusteVSIVideoScore} pts
                    </span>
                  )}
                </div>
              </div>
              )}

              {/* Dimensiones — el score por dimensión es una CONSTANTE FABRICADA (el
                  pipeline de vídeo no puntúa por dimensión). Se oculta toda la sección
                  salvo que el informe declare dimensionesMedidas === true (hoy: nunca).
                  No pintamos barras/scores fabricados; inv #1/#2 metricas.md. */}
              {((report.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true) && (
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3">{t("vitasLab.analysisDimensions")}</p>
                  <div className="space-y-2">
                    {Object.entries(report.estadoActual.dimensiones).map(([key, dim]) => (
                      <div key={key} className="glass rounded-lg px-4 py-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-display font-semibold text-foreground">{dimLabels[key] ?? key}</span>
                          <span className="text-xs font-display font-bold text-primary">{dim.score.toFixed(1)}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(dim.score / 10) * 100}%` }}
                            transition={{ duration: 0.8, delay: 0.1 }}
                            className={`h-full rounded-full ${dim.score >= 8 ? "bg-green-500" : dim.score >= 6 ? "bg-primary" : "bg-yellow-500"}`}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{dim.observacion}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Métricas Cuantitativas (YOLO tracking) */}
              {report.metricasCuantitativas?.fisicas && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Activity size={14} className="text-green-500" />
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.physicalMetrics")}</p>
                    <span className="text-[9px] font-display px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20">
                      YOLO Tracking
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="glass rounded-lg p-3 text-center">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.maxSpeed")}</p>
                      <p className="text-lg font-display font-black text-yellow-500">{report.metricasCuantitativas.fisicas.velocidadMaxKmh}</p>
                      <p className="text-[9px] text-muted-foreground">km/h</p>
                    </div>
                    <div className="glass rounded-lg p-3 text-center">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.distance")}</p>
                      <p className="text-lg font-display font-black text-blue-500">{report.metricasCuantitativas.fisicas.distanciaM}</p>
                      <p className="text-[9px] text-muted-foreground">{t("vitasLab.meters")}</p>
                    </div>
                    <div className="glass rounded-lg p-3 text-center">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">Sprints</p>
                      <p className="text-lg font-display font-black text-orange-500">{report.metricasCuantitativas.fisicas.sprints}</p>
                      <p className="text-[9px] text-muted-foreground">&gt;21 km/h</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div className="glass rounded-lg p-3 text-center">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.avgSpeed")}</p>
                      <p className="text-base font-display font-bold text-foreground">{report.metricasCuantitativas.fisicas.velocidadPromKmh} <span className="text-[9px] text-muted-foreground">km/h</span></p>
                    </div>
                    <div className="glass rounded-lg p-3">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground mb-1">{t("vitasLab.intensity")}</p>
                      <div className="flex h-2 rounded-full overflow-hidden gap-px">
                        {(() => {
                          const z = report.metricasCuantitativas!.fisicas!.zonasIntensidad;
                          const total = z.caminar + z.trotar + z.correr + z.sprint || 1;
                          return <>
                            <div className="bg-slate-400" style={{ width: `${(z.caminar / total) * 100}%` }} />
                            <div className="bg-blue-400"  style={{ width: `${(z.trotar  / total) * 100}%` }} />
                            <div className="bg-orange-400" style={{ width: `${(z.correr / total) * 100}%` }} />
                            <div className="bg-red-400"   style={{ width: `${(z.sprint / total) * 100}%` }} />
                          </>;
                        })()}
                      </div>
                      <div className="flex justify-between mt-1">
                        {[{l:t("vitasLab.zoneWalk"),c:"bg-slate-400"},{l:t("vitasLab.zoneJog"),c:"bg-blue-400"},{l:t("vitasLab.zoneRun"),c:"bg-orange-400"},{l:t("vitasLab.zoneSprint"),c:"bg-red-400"}].map(z => (
                          <div key={z.l} className="flex items-center gap-0.5">
                            <div className={`w-1 h-1 rounded-full ${z.c}`} />
                            <span className="text-[7px] text-muted-foreground">{z.l}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Heatmap del jugador (si hay posiciones) */}
              {report.metricasCuantitativas?.heatmapPositions &&
               report.metricasCuantitativas.heatmapPositions.length > 0 && (
                <PlayerHeatmap
                  positions={report.metricasCuantitativas.heatmapPositions}
                  title={t("vitasLab.heatmapSession")}
                />
              )}

              {/* ── Fatigue Analysis Panel ── */}
              <FatiguePanel report={fatigueReport} />

              {/* ── xG Panel (Sprint 6) ── */}
              <XgPanel
                summary={xgSummary}
                phvActive={!!phvOffset}
                phvOffset={phvOffset}
              />

              {/* ── Analysis View Mode Toggle (Sprint 8) ── */}
              <div className="glass rounded-xl p-3">
                <p className="text-[9px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                  {t("vitasLab.analysisMode")}
                </p>
                <div className="flex gap-1">
                  {([
                    { id: "player" as const, label: t("vitasLab.viewModePlayer"), icon: "👤" },
                    { id: "team" as const, label: t("vitasLab.viewModeTeam"), icon: "👥" },
                    { id: "rival" as const, label: t("vitasLab.viewModeRivalScout"), icon: "🔍" },
                  ]).map(m => (
                    <button
                      key={m.id}
                      onClick={() => onChangeViewMode(m.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-display font-semibold transition-colors ${
                        analysisViewMode === m.id
                          ? "bg-primary/10 text-primary border border-primary/30"
                          : "bg-secondary/50 text-muted-foreground border border-border hover:text-foreground"
                      }`}
                    >
                      <span>{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Team Dashboard (Sprint 8) ── */}
              {analysisViewMode !== "player" && (
                <TeamDashboard
                  teamReport={teamReport}
                  homeFormation={homeFormation}
                  awayFormation={awayFormation}
                  rivalReport={rivalReport}
                  mode={analysisViewMode === "rival" ? "rival" : "team"}
                />
              )}

              {/* Métricas de Eventos (Gemini observation) */}
              {report.metricasCuantitativas?.eventos && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Target size={14} className="text-blue-500" />
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.matchEvents")}</p>
                    <span className="text-[9px] font-display px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">
                      {report.metricasCuantitativas.fuente === "yolo+gemini" ? t("vitasLab.trackingPlusIa") : t("vitasLab.iaObservation")}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {/* Pases */}
                    <div className="glass rounded-lg p-3">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.passes")}</p>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className="text-lg font-display font-black text-green-500">
                          {report.metricasCuantitativas.eventos.pasesCompletados}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          / {report.metricasCuantitativas.eventos.pasesCompletados + report.metricasCuantitativas.eventos.pasesFallados}
                        </span>
                      </div>
                      <div className="h-1 bg-muted rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${report.metricasCuantitativas.eventos.precisionPases}%` }} />
                      </div>
                      <p className="text-[8px] text-muted-foreground mt-0.5">{report.metricasCuantitativas.eventos.precisionPases}% {t("vitasLab.accuracy")}</p>
                    </div>
                    {/* Duelos */}
                    <div className="glass rounded-lg p-3">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.duels")}</p>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className="text-lg font-display font-black text-orange-500">
                          {report.metricasCuantitativas.eventos.duelosGanados}{t("vitasLab.wonAbbr")}
                        </span>
                        <span className="text-[9px] text-red-400">
                          / {report.metricasCuantitativas.eventos.duelosPerdidos}{t("vitasLab.lostAbbr")}
                        </span>
                      </div>
                    </div>
                    {/* Recuperaciones */}
                    <div className="glass rounded-lg p-3">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.recoveries")}</p>
                      <span className="text-lg font-display font-black text-blue-500">
                        {report.metricasCuantitativas.eventos.recuperaciones}
                      </span>
                    </div>
                    {/* Disparos */}
                    <div className="glass rounded-lg p-3">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.shots")}</p>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className="text-lg font-display font-black text-purple-500">
                          {report.metricasCuantitativas.eventos.disparosAlArco}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("vitasLab.onTarget")} / {report.metricasCuantitativas.eventos.disparosFuera} {t("vitasLab.offTarget")}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* VAEP: disponible en future sprint con datos biomecánicos del pipeline GPU */}

              {/* ADN Futbolístico — solo lo que dio el agente (antes «DNA Análisis»,
                  «Determinado y competitivo»… como si fueran del análisis). */}
              {(report.adnFutbolistico.arquetipoTactico || report.adnFutbolistico.estiloJuego || report.adnFutbolistico.mentalidad) && (
              <div className="glass rounded-xl p-4">
                <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-2">{t("vitasLab.footballDna")}</p>
                {report.adnFutbolistico.arquetipoTactico && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    <span className="text-[10px] font-display px-2 py-1 rounded-lg bg-primary/10 text-primary border border-primary/20">
                      {report.adnFutbolistico.arquetipoTactico}
                    </span>
                  </div>
                )}
                {report.adnFutbolistico.estiloJuego && (
                  <p className="text-xs text-muted-foreground">{report.adnFutbolistico.estiloJuego}</p>
                )}
                {report.adnFutbolistico.mentalidad && (
                  <p className="text-xs text-foreground mt-1 italic">"{report.adnFutbolistico.mentalidad}"</p>
                )}
              </div>
              )}

              {/* Best Match */}
              {report.jugadorReferencia?.bestMatch && (
                <div className="glass rounded-xl p-4 border border-primary/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Star size={14} className="text-yellow-500" />
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.referencePlayer")}</p>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-display font-bold text-foreground">{report.jugadorReferencia.bestMatch.nombre}</p>
                      <p className="text-xs text-muted-foreground">
                        {[report.jugadorReferencia.bestMatch.posicion, report.jugadorReferencia.bestMatch.club].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="text-2xl font-display font-black text-primary">{report.jugadorReferencia.bestMatch.score.toFixed(0)}%</span>
                  </div>
                  {report.jugadorReferencia.bestMatch.narrativa && (
                    <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{report.jugadorReferencia.bestMatch.narrativa}</p>
                  )}
                </div>
              )}

              {/* Proyección — solo si hay datos reales (null ⇒ no se fabrica "Semi-pro") */}
              {report.proyeccionCarrera && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp size={14} className="text-primary" />
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.careerProjection")}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="glass rounded-xl p-3 border border-green-500/20">
                      <p className="text-[9px] font-display uppercase tracking-wider text-green-600 mb-1">{t("vitasLab.optimistic")}</p>
                      <p className="text-xs font-display font-bold text-foreground">{report.proyeccionCarrera.escenarioOptimista.nivelProyecto}</p>
                      <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{report.proyeccionCarrera.escenarioOptimista.descripcion}</p>
                    </div>
                    <div className="glass rounded-xl p-3 border border-border">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground mb-1">{t("vitasLab.realistic")}</p>
                      <p className="text-xs font-display font-bold text-foreground">{report.proyeccionCarrera.escenarioRealista.nivelProyecto}</p>
                      <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{report.proyeccionCarrera.escenarioRealista.descripcion}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Plan de Desarrollo — sin objetivos genéricos de relleno («Consolidar
                  fundamentos técnicos»…): solo lo que redactó el agente. */}
              {(report.planDesarrollo.objetivo6meses || report.planDesarrollo.objetivo18meses || report.planDesarrollo.pilaresTrabajo?.length > 0) && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Target size={14} className="text-primary" />
                  <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.developmentPlan")}</p>
                </div>
                <div className="space-y-2 mb-3">
                  {report.planDesarrollo.objetivo6meses && (
                    <div className="glass rounded-lg px-3 py-2">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.goal6Months")}</p>
                      <p className="text-xs text-foreground mt-0.5">{report.planDesarrollo.objetivo6meses}</p>
                    </div>
                  )}
                  {report.planDesarrollo.objetivo18meses && (
                    <div className="glass rounded-lg px-3 py-2">
                      <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">{t("vitasLab.goal18Months")}</p>
                      <p className="text-xs text-foreground mt-0.5">{report.planDesarrollo.objetivo18meses}</p>
                    </div>
                  )}
                </div>
                {report.planDesarrollo.pilaresTrabajo?.slice(0, 3).map((pilar, i) => (
                  <div key={i} className="glass rounded-lg px-3 py-2 mb-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[9px] font-display px-1.5 py-0.5 rounded ${pilar.prioridad === "alta" ? "bg-red-500/10 text-red-500" : pilar.prioridad === "media" ? "bg-yellow-500/10 text-yellow-600" : "bg-green-500/10 text-green-600"}`}>
                        {pilar.prioridad.toUpperCase()}
                      </span>
                      <p className="text-xs font-display font-semibold text-foreground">{pilar.pilar}</p>
                    </div>
                    <ul className="space-y-0.5">
                      {pilar.acciones.slice(0, 3).map((a, j) => (
                        <li key={j} className="text-[10px] text-muted-foreground flex items-start gap-1">
                          <span className="text-primary mt-0.5">›</span> {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              )}

              {/* Ejercicios Recomendados (RAG con feedback) */}
              {report.estadoActual.areasDesarrollo?.length > 0 && (
                <DrillRecommendations areasDesarrollo={report.estadoActual.areasDesarrollo} />
              )}

              {/* Búsqueda manual de ejercicios */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} className="text-electric" />
                  <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.searchDrills")}</p>
                </div>
                <KnowledgeSearch
                  compact
                  className="mb-2"
                  onSelectResult={(r) => toast.info(`Drill: ${r.content.slice(0, 80)}...`)}
                />
              </div>

              {/* Riesgos — guarda proyeccionCarrera null (bloque separado del de proyección) */}
              {report.proyeccionCarrera && report.proyeccionCarrera.riesgos?.length > 0 && (
                <div className="glass rounded-xl p-4 border border-yellow-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle size={14} className="text-yellow-500" />
                    <p className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">{t("vitasLab.identifiedRisks")}</p>
                  </div>
                  <ul className="space-y-1">
                    {report.proyeccionCarrera.riesgos.map((r, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                        <span className="text-yellow-500 mt-0.5">›</span> {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* CTA: el análisis no muere en el Lab — continúa en la ficha */}
              {selectedPlayerId && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3, duration: 0.4 }}
                >
                  <Button
                    onClick={() => onNavigateToPlayer(selectedPlayerId)}
                    className="w-full gap-2 font-display font-bold"
                  >
                    <TrendingUp size={15} />
                    {t("vitasLab.viewInProfile", {
                      name: selectedPlayerName ?? (playerName || t("vitasLab.playerFallback")),
                    })}
                    <ArrowRight size={15} />
                  </Button>
                </motion.div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default LabResultsPanel;
