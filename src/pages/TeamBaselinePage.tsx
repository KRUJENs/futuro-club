/**
 * VITAS · Team Baseline Analysis Page
 * /equipo/baseline
 *
 * Genera y visualiza el informe táctico del equipo.
 * Modo texto: solo datos de plantilla.
 * Modo vídeo (PRO): el coach sube vídeo del equipo → Gemini analiza
 * patrones, transiciones, pressing, y enriquece los 4 reportes.
 *
 * Llama POST /api/team/baseline-analysis y muestra los reportes
 * en grid · cada uno expandible.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { normalizeLocale } from "@/lib/shared/locale";
import { motion } from "framer-motion";
import {
  ArrowLeft, Sparkles, Loader2, Users, Brain, Swords, Activity, Target,
  AlertCircle, ChevronDown, ChevronUp, Grid3x3, Video, FileText, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { getAuthHeaders } from "@/lib/apiAuth";
import { IS_DEMO } from "@/lib/demoMode";
import { buildDemoTeamBaseline } from "@/lib/demo/demoTeam";
import VideoUpload from "@/components/VideoUpload";
import { VideoService } from "@/services/real/videoService";
import { resolveSyncAnalysisInput, syncAnalysisRefusalMessage } from "@/lib/syncVideoAnalysisGate";
import { useMatchAnalysisJob } from "@/hooks/useMatchAnalysisJob";
import BaselineMatchJobPanel from "@/components/match/BaselineMatchJobPanel";
import CoverageBanner from "@/components/match/CoverageBanner";
import { isMatchVideoClientFlagOn, resolveMatchVideoAvailability } from "@/lib/match/matchVideoAvailability";
import type { MatchCoverage } from "@/lib/shared/matchJob/contract";
import { clipConsentErrorFromResponse } from "@/lib/shared/videoConsent";

type AnalysisMode = "text" | "video";

interface TeamBaselineResponse {
  teamName: string;
  teamSize: number;
  vsiPromedio: number | null;
  phvDistribution: { early: number; ontime: number; late: number; unknown: number };
  reports: Array<{ type: string; content: Record<string, unknown>; model: string }>;
  reportsGenerated: number;
  reportsFailed: number;
}

const REPORT_META: Record<string, { Icon: React.ElementType; titleKey: string; color: string }> = {
  "team-overview":     { Icon: Brain,    titleKey: "teamBaselinePage.reportTeamOverview",  color: "#0066CC" },
  "tactical-profile":  { Icon: Swords,   titleKey: "teamBaselinePage.reportTacticalProfile", color: "#B82BD9" },
  "tactical-zones":    { Icon: Grid3x3,  titleKey: "teamBaselinePage.reportTacticalZones", color: "#1A8FFF" },
  "phv-stratification": { Icon: Activity, titleKey: "teamBaselinePage.reportPhvStratification", color: "#10b981" },
  "opponent-readiness": { Icon: Target,   titleKey: "teamBaselinePage.reportOpponentReadiness", color: "#DC8B0A" },
};

export default function TeamBaselinePage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<AnalysisMode>("video");
  const [generating, setGenerating] = useState(false);
  const [data, setData] = useState<TeamBaselineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Video mode state
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [analyzingVideo, setAnalyzingVideo] = useState(false);
  const [videoAnalysis, setVideoAnalysis] = useState<Record<string, unknown> | null>(null);
  // Motivo honesto por el que el vídeo subido NO se manda al análisis rápido
  // (partido completo, codificación en curso, solo local). null = sin aviso.
  const [videoNotice, setVideoNotice] = useState<string | null>(null);
  // Partido completo (más largo que el límite síncrono) → job asíncrono team_baseline,
  // SOLO si el análisis de partido completo se ofrece (hoy «en validación»: sin red).
  const matchVideoAvailable =
    resolveMatchVideoAvailability({ clientFlag: isMatchVideoClientFlagOn(), isDemo: IS_DEMO, serverDisabled: false }) === "available";
  const [fullMatchVideo, setFullMatchVideo] = useState<{ videoId: string; durationSec: number | null } | null>(null);
  const matchJob = useMatchAnalysisJob({ purpose: "team_baseline", enabled: matchVideoAvailable });
  const matchAnalysisId = matchJob.data?.job.status === "completed" ? matchJob.jobId : null;
  const focusSide = matchJob.data?.job.focusTeam;
  const matchTeamName = focusSide ? matchJob.data?.job[focusSide]?.name : null;
  // Coverage of the match job the shown reports were built from (null = no match job used):
  // a partial video is never read as a complete session (CoverageBanner above the results).
  const [dataCoverage, setDataCoverage] = useState<{ coverage: MatchCoverage | null } | null>(null);

  async function handleVideoAnalysis(url: string, videoId: string) {
    setVideoUrl(url);
    setAnalyzingVideo(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/agents/video-observation", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          locale: normalizeLocale(i18n.language),
          videoUrl: url,
          // Consentimiento (decisión del owner, 30 sep): el servidor comprueba que el vídeo
          // es tuyo, que la URL es la suya y que tiene la declaración que marcaste al subirlo
          // en VideoUpload (guardada con el vídeo). No se vuelve a declarar aquí.
          videoId,
          // Observación de EQUIPO: sin identificar ni atribuir a un jugador, y sin
          // edad/posición inventadas (antes 13 / "MID" / "formativo" por defecto).
          analysisScope: "team",
          playerContext: { name: "Equipo propio" },
        }),
      });
      const json = await res.json();
      const consentErr = clipConsentErrorFromResponse(json, i18n.language);
      if (consentErr) throw consentErr;
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? t("teamBaselinePage.errorAnalyzingVideo"));

      const obs = json.data?.observations as Record<string, unknown>;
      setVideoAnalysis(obs);
      toast.success(t("teamBaselinePage.toastVideoAnalyzed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("teamBaselinePage.errorAnalyzingVideo"));
      setVideoAnalysis(null);
    } finally {
      setAnalyzingVideo(false);
    }
  }

  async function handleGenerate() {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      if (IS_DEMO) {
        const d = buildDemoTeamBaseline();
        setData(d as TeamBaselineResponse);
        setExpanded(d.reports[0]?.type ?? null);
        return;
      }
      const headers = await getAuthHeaders();
      const res = await fetch("/api/team/baseline-analysis", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          teamName: matchTeamName ?? "Mi equipo",
          // Partido completo: el servidor carga la observación del job (con check de propiedad).
          ...(matchAnalysisId ? { matchAnalysisId } : { videoObservation: videoAnalysis ?? undefined }),
          locale: normalizeLocale(i18n.language),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? t("teamBaselinePage.errorGeneratingAnalysis"));
      }
      setData(json.data as TeamBaselineResponse);
      setDataCoverage(matchAnalysisId ? { coverage: matchJob.data?.coverage ?? null } : null);
      toast.success(t("teamBaselinePage.toastReportsGenerated", { generated: json.data.reportsGenerated, size: json.data.teamSize }));
      setExpanded(json.data.reports[0]?.type ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teamBaselinePage.errorUnknown"));
      toast.error(err instanceof Error ? err.message : t("teamBaselinePage.errorGenerating"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="min-h-screen bg-background pb-28">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">
              {t("teamBaselinePage.headerTitle")}
            </h1>
            <p className="text-[10px] text-muted-foreground">
              {t("teamBaselinePage.headerSubtitle")}
            </p>
          </div>
          <Users size={18} className="text-primary" />
        </div>
      </div>

      <div className="px-4 py-4 max-w-3xl lg:max-w-5xl mx-auto space-y-4">
        {!data && !generating && (
          <div className="glass rounded-2xl p-6 text-center space-y-3">
            <Brain size={32} className="mx-auto text-primary/50" />
            <h2 className="text-sm font-display font-bold text-foreground">
              {t("teamBaselinePage.generateHeading")}
            </h2>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t("teamBaselinePage.generateDescription")}
            </p>

            {/* Video upload section */}
            <div className="text-left space-y-3">
              {!videoAnalysis && !analyzingVideo && !fullMatchVideo && !matchJob.jobId && (
                <VideoUpload
                  onDone={(videoId, info) => {
                    // VideoUpload expone onDone(videoId), no onUploadComplete
                    // (prop inexistente → subir vídeo no hacía nada · #3).
                    // Gate honesto (clips cortos + URL que el SERVIDOR pueda descargar;
                    // nunca un blob:) antes de llamar al agente.
                    const input = resolveSyncAnalysisInput(VideoService.getById(videoId), info.durationSec);
                    if (input.kind === "ok") {
                      setVideoNotice(null);
                      void handleVideoAnalysis(input.url, videoId);
                    } else if (input.kind === "too_long" && matchVideoAvailable) {
                      // Partido completo: job asíncrono en vez de la llamada síncrona de 120 s.
                      setVideoNotice(null);
                      setFullMatchVideo({ videoId, durationSec: input.durationSec });
                    } else {
                      const msg = syncAnalysisRefusalMessage(t, input);
                      setVideoNotice(input.kind === "too_long" ? `${msg} ${t("matchJob.validation.baselineSuffix")}` : msg);
                      toast.error(msg);
                    }
                  }}
                />
              )}
              {!videoAnalysis && (fullMatchVideo || matchJob.jobId) && (
                <BaselineMatchJobPanel
                  job={matchJob}
                  videoId={fullMatchVideo?.videoId ?? null}
                  durationSec={fullMatchVideo?.durationSec ?? null}
                  onReset={() => {
                    setFullMatchVideo(null);
                    matchJob.clear();
                  }}
                />
              )}
              {videoNotice && !videoAnalysis && !analyzingVideo && (
                <div role="status" className="flex items-start gap-2 p-3 rounded-lg bg-secondary border border-border">
                  <AlertCircle size={14} className="text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-[11px] text-foreground leading-relaxed">{videoNotice}</p>
                </div>
              )}
              {analyzingVideo && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/30">
                  <Loader2 size={14} className="animate-spin text-primary" />
                  <span className="text-xs text-foreground">{t("teamBaselinePage.geminiAnalyzingVideo")}</span>
                </div>
              )}
              {videoAnalysis && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                  <CheckCircle2 size={14} className="text-green-500" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-foreground">{t("teamBaselinePage.videoAnalyzedLabel")}</span>
                    {(videoAnalysis as Record<string, unknown>).resumenGeneral && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                        {String((videoAnalysis as Record<string, unknown>).resumenGeneral).slice(0, 200)}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={handleGenerate}
              disabled={!videoAnalysis && !matchAnalysisId && !IS_DEMO}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-display font-bold hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Sparkles size={12} /> {t("teamBaselinePage.generateButton")}
            </button>
            <p className="text-[10px] text-muted-foreground">
              {t("teamBaselinePage.generateTimingNote")}
            </p>
          </div>
        )}

        {generating && (
          <div className="glass rounded-2xl p-12 text-center space-y-3">
            <Loader2 size={28} className="animate-spin text-primary mx-auto" />
            <p className="text-xs text-muted-foreground">
              {t("teamBaselinePage.analyzingSquad")}
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/30 p-3 flex items-start gap-2">
            <AlertCircle size={14} className="text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-[11px] font-bold text-destructive">{t("teamBaselinePage.errorLabel")}</p>
              <p className="text-[10px] text-foreground">{error}</p>
            </div>
          </div>
        )}

        {data && (
          <>
            {dataCoverage && (
              <div className="space-y-2" data-testid="baseline-match-coverage">
                <p className="text-[11px] text-muted-foreground">{t("matchJob.baseline.coverageNote")}</p>
                {dataCoverage.coverage ? (
                  <CoverageBanner coverage={dataCoverage.coverage} />
                ) : (
                  <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-foreground">
                    {t("matchJob.baseline.coverageUnavailable")}
                  </p>
                )}
              </div>
            )}
            {/* Stats overview */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl p-4">
              <div className="grid grid-cols-3 gap-3">
                <Stat label={t("teamBaselinePage.statSquad")} value={`${data.teamSize}`} />
                <Stat label={t("teamBaselinePage.statVsiAvg")} value={data.vsiPromedio === null ? "—" : `${data.vsiPromedio}`} />
                <Stat label={t("teamBaselinePage.statReports")} value={`${data.reportsGenerated}/4`} />
              </div>
              <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap gap-3 text-[10px]">
                <PhvBadge label={t("teamBaselinePage.phvEarly")} count={data.phvDistribution.early} color="#1A8FFF" />
                <PhvBadge label={t("teamBaselinePage.phvOntime")} count={data.phvDistribution.ontime} color="#B82BD9" />
                <PhvBadge label={t("teamBaselinePage.phvLate")} count={data.phvDistribution.late} color="#10b981" />
                {data.phvDistribution.unknown > 0 && (
                  <PhvBadge label={t("teamBaselinePage.phvUnknown")} count={data.phvDistribution.unknown} color="#888" />
                )}
              </div>
            </motion.div>

            {/* Reports accordion */}
            <div className="space-y-2">
              {data.reports.map((r) => {
                const meta = REPORT_META[r.type] ?? { Icon: Brain, titleKey: r.type, color: "#888" };
                const Icon = meta.Icon;
                const metaTitle = REPORT_META[r.type] ? t(meta.titleKey) : r.type;
                const isOpen = expanded === r.type;
                return (
                  <div key={r.type} className="glass rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpanded(isOpen ? null : r.type)}
                      className="w-full px-4 py-3 flex items-center justify-between gap-2 hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${meta.color}20` }}
                        >
                          <Icon size={14} style={{ color: meta.color }} />
                        </div>
                        <span className="text-sm font-display font-bold text-foreground">{metaTitle}</span>
                      </div>
                      {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 pt-1 border-t border-border/40 space-y-3 text-xs">
                        <ReportContent type={r.type} content={r.content} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Regenerate */}
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full py-2.5 rounded-lg bg-secondary/30 border border-dashed border-border text-[11px] font-display text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors flex items-center justify-center gap-2"
            >
              <Sparkles size={11} /> {t("teamBaselinePage.regenerateButton")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="font-display font-bold text-xl text-foreground">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">{label}</div>
    </div>
  );
}

function PhvBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span style={{ color }}>{label}</span>
      <span className="font-bold text-foreground">{count}</span>
    </div>
  );
}

// Simple renderer per report type
function ReportContent({ type, content }: { type: string; content: Record<string, unknown> }) {
  if (type === "team-overview") {
    return <TeamOverviewRenderer content={content} />;
  }
  if (type === "tactical-profile") {
    return <TacticalRenderer content={content} />;
  }
  if (type === "tactical-zones") {
    return <ZonesRenderer content={content} />;
  }
  if (type === "phv-stratification") {
    return <PhvStratRenderer content={content} />;
  }
  if (type === "opponent-readiness") {
    return <OpponentRenderer content={content} />;
  }
  return (
    <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function TeamOverviewRenderer({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const summary = content.executive_summary as string | undefined;
  const strengths = content.team_strengths as Array<{ title?: string; evidence?: string }> | undefined;
  const weaknesses = content.team_weaknesses as Array<{ title?: string; evidence?: string; priority?: string }> | undefined;
  const next = content.next_focus as string | undefined;

  return (
    <>
      {summary && <p className="text-foreground leading-relaxed">{summary}</p>}
      {strengths && strengths.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-1">{t("teamBaselinePage.strengthsHeading")}</h5>
          <ul className="list-disc list-inside space-y-0.5 text-foreground">
            {strengths.map((s, i) => <li key={i}><span className="font-semibold">{s.title}</span> {s.evidence && <span className="text-muted-foreground">— {s.evidence}</span>}</li>)}
          </ul>
        </div>
      )}
      {weaknesses && weaknesses.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1">{t("teamBaselinePage.weaknessesHeading")}</h5>
          <ul className="list-disc list-inside space-y-0.5 text-foreground">
            {weaknesses.map((w, i) => <li key={i}><span className="font-semibold">{w.title}</span> {w.evidence && <span className="text-muted-foreground">— {w.evidence}</span>}</li>)}
          </ul>
        </div>
      )}
      {next && (
        <div className="rounded-lg bg-primary/10 border border-primary/30 p-2 text-[11px]">
          <strong className="text-primary">{t("teamBaselinePage.nextFocusLabel")}</strong> <span className="text-foreground">{next}</span>
        </div>
      )}
    </>
  );
}

function TacticalRenderer({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const formation = content.formation_suggested as string | undefined;
  const style = content.playing_style as string | undefined;
  const offensive = content.offensive_phase as string | undefined;
  const defensive = content.defensive_phase as string | undefined;
  const transition = content.transition_focus as string | undefined;

  return (
    <>
      {formation && <p><strong className="text-primary">{t("teamBaselinePage.formationLabel")}</strong> <span className="text-foreground">{formation}</span></p>}
      {style && <p><strong className="text-foreground">{t("teamBaselinePage.styleLabel")}</strong> <span className="text-muted-foreground">{style}</span></p>}
      {offensive && <p><strong className="text-green-400">{t("teamBaselinePage.attackLabel")}</strong> <span className="text-muted-foreground">{offensive}</span></p>}
      {defensive && <p><strong className="text-amber-400">{t("teamBaselinePage.defenseLabel")}</strong> <span className="text-muted-foreground">{defensive}</span></p>}
      {transition && <p><strong className="text-electric">{t("teamBaselinePage.transitionLabel")}</strong> <span className="text-muted-foreground">{transition}</span></p>}
    </>
  );
}

function PhvStratRenderer({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const summary = content.mix_summary as string | undefined;
  const early = content.early_group_plan as string | undefined;
  const ontime = content.ontime_group_plan as string | undefined;
  const late = content.late_group_plan as string | undefined;
  const risk = content.risk_warning as string | undefined;

  return (
    <>
      {summary && <p className="text-foreground leading-relaxed">{summary}</p>}
      {early  && <p>🌱 <strong>{t("teamBaselinePage.preSpurtLabel")}</strong> <span className="text-muted-foreground">{early}</span></p>}
      {ontime && <p>🚀 <strong>{t("teamBaselinePage.inSpurtLabel")}</strong> <span className="text-muted-foreground">{ontime}</span></p>}
      {late   && <p>🏆 <strong>{t("teamBaselinePage.postSpurtLabel")}</strong> <span className="text-muted-foreground">{late}</span></p>}
      {risk && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-2 text-[11px]">
          <strong className="text-amber-400">{t("teamBaselinePage.riskLabel")}</strong> <span className="text-foreground">{risk}</span>
        </div>
      )}
    </>
  );
}

interface ZoneEntry {
  id: string;
  row: "defensa" | "medio" | "ataque" | string;
  col: "izq" | "cen" | "dcha" | string;
  offensive: number;
  defensive: number;
  note?: string;
}

function ZonesRenderer({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const zones = content.zones as ZoneEntry[] | undefined;
  const summary = content.summary as string | undefined;
  const dominant = content.dominant_zone as string | undefined;
  const weakest = content.weakest_zone as string | undefined;

  if (!Array.isArray(zones) || zones.length === 0) {
    return <p className="text-muted-foreground italic">{t("teamBaselinePage.noZoneData")}</p>;
  }

  const byPos = new Map<string, ZoneEntry>();
  zones.forEach((z) => byPos.set(`${z.row}-${z.col}`, z));

  const rows: Array<"ataque" | "medio" | "defensa"> = ["ataque", "medio", "defensa"];
  const cols: Array<"izq" | "cen" | "dcha"> = ["izq", "cen", "dcha"];

  return (
    <>
      {summary && <p className="text-foreground leading-relaxed">{summary}</p>}

      <div className="rounded-xl bg-secondary/30 border border-border p-3">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold mb-2 text-center">
          {t("teamBaselinePage.viewTowardOpponentGoal")}
        </div>
        <div className="grid grid-cols-3 gap-1.5 max-w-[280px] mx-auto">
          {rows.flatMap((row) =>
            cols.map((col) => {
              const z = byPos.get(`${row}-${col}`);
              const isDominant = z && (dominant === z.id || dominant === `${z.row}-${z.col}`);
              const isWeakest  = z && (weakest  === z.id || weakest  === `${z.row}-${z.col}`);
              const offColor = z ? scoreToColor(z.offensive) : "transparent";
              return (
                <div
                  key={`${row}-${col}`}
                  className={`aspect-square rounded-md p-1 flex flex-col justify-center items-center text-center border ${
                    isDominant ? "border-primary border-2" : isWeakest ? "border-destructive border-2" : "border-border"
                  }`}
                  style={{ backgroundColor: offColor }}
                  title={z?.note}
                >
                  <div className="text-[8px] uppercase tracking-wider text-foreground/70 font-bold leading-none mb-0.5">
                    {row.slice(0, 3)}-{col}
                  </div>
                  {z && (
                    <>
                      <div className="text-[10px] font-display font-bold text-foreground leading-none">
                        {z.offensive}
                      </div>
                      <div className="text-[8px] text-muted-foreground">{z.defensive}d</div>
                    </>
                  )}
                </div>
              );
            }),
          )}
        </div>
        <div className="mt-3 text-center text-[8px] uppercase tracking-wider text-muted-foreground font-bold">
          {t("teamBaselinePage.yourGoal")}
        </div>
        <div className="mt-3 pt-2 border-t border-border/40 text-[10px] flex items-center justify-between">
          <span>{t("teamBaselinePage.zoneLegend")}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {dominant && (
          <div className="rounded-lg bg-primary/10 border border-primary/30 p-2">
            <div className="text-[9px] uppercase tracking-wider text-primary font-bold">{t("teamBaselinePage.dominantLabel")}</div>
            <div className="text-foreground font-mono">{dominant}</div>
          </div>
        )}
        {weakest && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-2">
            <div className="text-[9px] uppercase tracking-wider text-destructive font-bold">{t("teamBaselinePage.vulnerableLabel")}</div>
            <div className="text-foreground font-mono">{weakest}</div>
          </div>
        )}
      </div>
    </>
  );
}

function scoreToColor(score: number): string {
  // 0-100 → gradient red → amber → green con baja opacidad para fondo
  if (score >= 75) return "rgba(34, 197, 94, 0.18)";
  if (score >= 60) return "rgba(132, 204, 22, 0.15)";
  if (score >= 45) return "rgba(245, 158, 11, 0.14)";
  if (score >= 30) return "rgba(249, 115, 22, 0.14)";
  return "rgba(239, 68, 68, 0.14)";
}

function OpponentRenderer({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const vulns = content.vulnerabilities as string[] | undefined;
  const strs = content.exploitable_strengths as string[] | undefined;
  const drills = content.recommended_drills as string[] | undefined;

  return (
    <>
      {vulns && vulns.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1">{t("teamBaselinePage.vulnerabilitiesHeading")}</h5>
          <ul className="list-disc list-inside space-y-0.5 text-foreground">{vulns.map((v, i) => <li key={i}>{v}</li>)}</ul>
        </div>
      )}
      {strs && strs.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-1">{t("teamBaselinePage.exploitableStrengthsHeading")}</h5>
          <ul className="list-disc list-inside space-y-0.5 text-foreground">{strs.map((v, i) => <li key={i}>{v}</li>)}</ul>
        </div>
      )}
      {drills && drills.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wider text-electric font-bold mb-1">{t("teamBaselinePage.recommendedDrillsHeading")}</h5>
          <ul className="list-disc list-inside space-y-0.5 text-foreground">{drills.map((v, i) => <li key={i}>{v}</li>)}</ul>
        </div>
      )}
    </>
  );
}
