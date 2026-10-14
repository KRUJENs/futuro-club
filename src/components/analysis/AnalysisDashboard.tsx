/**
 * VITAS · Analysis Dashboard
 *
 * Renderiza los 6 reportes Claude generados por un análisis V2 con tabs:
 *   - player-report (Sonnet)
 *   - lab-biomechanics (Sonnet)
 *   - dna-profile, best-match, projection, development-plan (Haiku)
 *
 * Lee directamente de /api/analyses/reports?analysisId=… y muestra el JSON
 * crudo de cada reporte (sin pasar por el mapping legacy lossy).
 *
 * Estado de carga: muestra spinner mientras `status` es processing/queued.
 */

import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  Loader2, AlertCircle, BarChart3, Activity, Dna, Target, TrendingUp, ClipboardList,
  Brain, Gauge, HeartPulse, BatteryLow, FlaskConical, Lock,
} from "lucide-react";
import { getAuthHeaders } from "@/lib/apiAuth";
import { IS_DEMO } from "@/lib/demoMode";
import { PlayerService } from "@/services/real/playerService";
import { buildDemoAnalysisRows } from "@/lib/demo/demoReports";
import { asItemArray, itemTitle } from "@/lib/reports/reportItems";
import DrillRecommendations from "@/components/intelligence/DrillRecommendations";
import PeerBenchmark from "@/components/PeerBenchmark";
// FASE 3c: renderers dedicados por report_type (antes todo caía al genérico → JSON crudo)
import ValuationReportView from "@/components/analysis/reports/ValuationReportView";
import InjuryReportView from "@/components/analysis/reports/InjuryReportView";
import FatigueReportView from "@/components/analysis/reports/FatigueReportView";
import ReportConfidenceChip from "@/components/analysis/reports/ReportConfidenceChip";
import PlayerReportView from "@/components/analysis/reports/PlayerReportView";
import ProjectionReportView from "@/components/analysis/reports/ProjectionReportView";
import DevelopmentPlanReportView from "@/components/analysis/reports/DevelopmentPlanReportView";
import DnaProfileReportView from "@/components/analysis/reports/DnaProfileReportView";

interface ReportData {
  report_type: string;
  content: Record<string, unknown>;
  model: string;
  prompt_version: string;
  generated_at: string;
}

interface AnalysisData {
  id: string;
  status: string;
  vsi: {
    vsi?: number;
    tier?: string;
    tierLabel?: string;
    /** Procedencia honesta (pipeline): fracción de sub-scores con procedencia real. */
    measuredFraction?: number;
    partiallyEstimated?: boolean;
    /** G4: compuesto BLOQUEADO (vsi:null) porque <4/5 dimensiones tienen procedencia real. */
    blocked?: boolean;
    gate_reason?: string | null;
    trend?: {
      slope: number | null;
      momentum: "up" | "flat" | "down" | null;
      confidence: "high" | "medium" | "low";
      delta: number | null;
      samples: number;
    } | null;
    history?: number[];
  } | null;
  phv: Record<string, unknown> | null;
  similarity: Record<string, unknown> | null;
  biomechanics: Record<string, unknown> | null;
  completed_at: string | null;
  player_id: string;
  video_id: string;
}

const REPORT_META: Record<
  string,
  { Icon: React.ElementType; title: string; color: string }
> = {
  "player-report":    { Icon: BarChart3,    title: "Player Report",    color: "#0066CC" },
  "lab-biomechanics": { Icon: Activity,     title: "LAB Biomecánica",  color: "#B82BD9" },
  "dna-profile":      { Icon: Dna,          title: "ADN Futbolístico", color: "#10b981" },
  "best-match":       { Icon: Target,       title: "Best-Match",       color: "#DC8B0A" },
  projection:         { Icon: TrendingUp,   title: "Proyección 3a",    color: "#1A8FFF" },
  "development-plan": { Icon: ClipboardList, title: "Plan Desarrollo", color: "#22e88c" },
  "valuation-report":   { Icon: Gauge,       title: "Valoración",       color: "#14B8A6" },
  "injury-risk-report": { Icon: HeartPulse,  title: "Riesgo de Lesión", color: "#EF4444" },
  "fatigue-report":     { Icon: BatteryLow,  title: "Fatiga y Carga",   color: "#F59E0B" },
};

/** FASE 3c: report_type → renderer dedicado. Los que no estén aquí caen al
 *  ReportRenderer genérico (fallback). Cada renderer consume su schema completo. */
const REPORT_RENDERERS: Record<string, React.ComponentType<{ report: Record<string, unknown> }>> = {
  "valuation-report":   ValuationReportView,
  "injury-risk-report": InjuryReportView,
  "fatigue-report":     FatigueReportView,
  "player-report":      PlayerReportView,
  projection:           ProjectionReportView,
  "development-plan":   DevelopmentPlanReportView,
  "dna-profile":        DnaProfileReportView,
  "best-match":         BestMatchReportView,
};

interface Props {
  analysisId: string;
  /** Si se pasa, fetchea desde /api/analyses/share (público) en lugar del endpoint con auth */
  shareToken?: string;
  /** Callback cuando el análisis termina de cargar · útil para el wrapper que necesita datos para Share text */
  onLoaded?: (analysis: AnalysisData, reports: ReportData[]) => void;
}

export function AnalysisDashboard({ analysisId, shareToken, onLoaded }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [reports, setReports] = useState<ReportData[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Extract areas_to_improve from player-report for RAG drill recommendations.
  // MUST be before any early returns to keep hooks order consistent.
  const areasDesarrollo = useMemo(() => {
    const pr = reports.find((r) => r.report_type === "player-report")?.content as
      | { areas_to_improve?: unknown } | undefined;
    // asItemArray/itemTitle: el LLM puede emitir areas_to_improve como string o con
    // elementos null → `.map`/`.title` crudos tumbaban el dashboard entero.
    return asItemArray(pr?.areas_to_improve)
      .map(itemTitle)
      .filter((s) => s.trim().length > 0);
  }, [reports]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        // Demo (datos mockeados): no hay backend. El endpoint /api/analyses/reports
        // lo intercepta demoApiGuard con data:null → `data.data.analysis` reventaba.
        // Construimos el informe de ejemplo en cliente desde el jugador sembrado.
        if (IS_DEMO && analysisId.startsWith("demo-analysis-")) {
          const pid = analysisId.slice("demo-analysis-".length).replace(/-prev$/, "");
          const player = PlayerService.getById(pid);
          if (player) {
            const rows = buildDemoAnalysisRows(player);
            const row = rows.find((r) => r.id === analysisId) ?? rows[0];
            const demoAnalysis = { id: row.id, status: "completed", vsi: row.vsi } as AnalysisData;
            const demoReports = (row.reports ?? []).map((r) => ({
              report_type: r.report_type,
              content: r.content as Record<string, unknown>,
              model: "demo",
              prompt_version: "demo",
              generated_at: row.created_at,
            })) as ReportData[];
            if (!mounted) return;
            setAnalysis(demoAnalysis);
            setReports(demoReports);
            if (demoReports.length > 0) setActiveTab(demoReports[0].report_type);
            setLoading(false);
            if (onLoaded) onLoaded(demoAnalysis, demoReports);
            return;
          }
        }
        const url = shareToken
          ? `/api/analyses/share?analysisId=${analysisId}&t=${encodeURIComponent(shareToken)}`
          : `/api/analyses/reports?analysisId=${analysisId}`;
        // El JWT de Supabase vive en localStorage, no en cookie → hay que mandar el
        // header Authorization (getAuthHeaders). `credentials:"include"` no bastaba:
        // verifyAuth lee SOLO el Bearer header → devolvía 401 y "Ver Completo" fallaba.
        const res = await fetch(url, shareToken ? {} : { headers: await getAuthHeaders() });
        const data = await res.json();
        if (!mounted) return;
        if (!res.ok || !data.success) {
          // errorResponse emite { error: string, errorDetail: { message } }: leer
          // errorDetail.message (o el string `error`) surfacea la causa real (401/405)
          // en vez de tragarla con el mensaje genérico.
          setError(data?.errorDetail?.message ?? (typeof data?.error === "string" ? data.error : null) ?? t("analysisDashboard.errorLoadingReports"));
          setLoading(false);
          return;
        }
        setAnalysis(data.data.analysis);
        setReports(data.data.reports ?? []);
        if (data.data.reports?.length > 0) setActiveTab(data.data.reports[0].report_type);
        setLoading(false);
        if (onLoaded) onLoaded(data.data.analysis as AnalysisData, (data.data.reports ?? []) as ReportData[]);
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : t("analysisDashboard.errorGeneric"));
          setLoading(false);
        }
      }
    }
    load();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId, shareToken]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">{t("analysisDashboard.loadingReports")}</p>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <AlertCircle size={28} className="text-destructive" />
        <p className="text-sm text-foreground">{error ?? t("analysisDashboard.analysisNotFound")}</p>
      </div>
    );
  }

  const isProcessing =
    analysis.status === "processing" ||
    analysis.status === "queued" ||
    analysis.status === "processing_reports";

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <Loader2 size={28} className="animate-spin text-primary" />
        <h2 className="font-display font-bold text-base text-foreground">{t("analysisDashboard.generatingReports")}</h2>
        <p className="text-[11px] text-muted-foreground">
          {t("analysisDashboard.statusLabel")} <code className="px-1.5 py-0.5 rounded bg-secondary font-mono">{analysis.status}</code>
        </p>
        <p className="text-[10px] text-muted-foreground">{t("analysisDashboard.estimatedTime")}</p>
      </div>
    );
  }

  const vsi = analysis.vsi?.vsi ?? null;
  // Análisis base (sin vídeo): su VSI es la EVALUACIÓN DEL ENTRENADOR (6 barras), no un
  // VSI de vídeo; se rotula como tal y su tramo es el único traducido (P1 bloque 5b). El
  // análisis base guarda un video_id centinela «baseline-…» (api/players/baseline-analysis.ts).
  const isCoachEvaluation = typeof analysis.video_id === "string" && analysis.video_id.startsWith("baseline-");
  const tierKey = analysis.vsi?.tier;
  const tier = isCoachEvaluation && tierKey && (["elite", "pro", "talent", "develop"] as string[]).includes(tierKey)
    ? t(`coachEval.tier.${tierKey}`)
    : analysis.vsi?.tierLabel ?? null;
  const activeReport = reports.find((r) => r.report_type === activeTab);
  const ActiveIcon = activeReport ? REPORT_META[activeReport.report_type]?.Icon ?? Brain : Brain;

  return (
    <div className="space-y-4">
      {/* Header VSI · score + tier + peer percentile */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-2xl p-5 text-center bg-gradient-to-br from-primary/15 via-electric/10 to-transparent border border-primary/20"
      >
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1">
          {isCoachEvaluation ? t("coachEval.label") : "VSI"}
        </div>
        {vsi !== null ? (
          <div className="font-display font-bold text-5xl text-foreground leading-none">{vsi}</div>
        ) : (
          // Sin número: se nombra el hueco (nunca «—»); si está bloqueado, el motivo va debajo.
          <div className="font-display font-semibold text-sm text-muted-foreground">{t("common.notEvaluated")}</div>
        )}
        {isCoachEvaluation && vsi !== null && (
          <div className="text-[10px] mt-1 text-muted-foreground">{t("coachEval.hint")}</div>
        )}
        {tier && (
          <div className="text-[11px] mt-1.5 text-muted-foreground">
            {t("analysisDashboard.tierLabel")} <span className="text-foreground font-semibold">{tier}</span>
          </div>
        )}
        {vsi !== null && analysis.vsi?.partiallyEstimated && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold text-amber-500">
            <FlaskConical size={11} />
            {t("analysisDashboard.partiallyEstimated", {
              measured: Math.round((analysis.vsi?.measuredFraction ?? 0) * 5),
            })}
          </div>
        )}
        {vsi === null && analysis.vsi?.blocked && (
          <div
            title={analysis.vsi?.gate_reason ?? undefined}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/30 bg-muted/40 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground"
          >
            <Lock size={11} />
            {t("analysisDashboard.vsiBlocked", {
              measured: Math.round((analysis.vsi?.measuredFraction ?? 0) * 5),
            })}
          </div>
        )}
        {/* Sin el percentil guardado `vsi.peer` (P1 bloque 5): se calculaba contra
            jugadores de todas las cuentas y con los no evaluados como 0. La comparación
            con pares es <PeerBenchmark> (más abajo), con la implementación única. */}
        {analysis.vsi?.trend?.momentum && analysis.vsi.trend.samples >= 2 && (
          <div className="mt-3 pt-3 border-t border-border/40 flex items-center justify-center gap-3 flex-wrap text-[10px]">
            {analysis.vsi?.trend?.momentum && analysis.vsi.trend.samples >= 2 && (
              <TrendBadge trend={analysis.vsi.trend} />
            )}
          </div>
        )}
      </motion.div>

      {/* Tabs · ocultas al imprimir */}
      <div className="flex gap-1.5 flex-wrap print:hidden">
        {reports.map((r) => {
          const meta = REPORT_META[r.report_type] ?? { Icon: Brain, title: r.report_type, color: "#888" };
          const Icon = meta.Icon;
          const reportTitle = REPORT_META[r.report_type]
            ? t(`analysisDashboard.reportTitle.${r.report_type}`)
            : r.report_type;
          const isActive = activeTab === r.report_type;
          return (
            <button
              key={r.report_type}
              onClick={() => setActiveTab(r.report_type)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-display font-bold border transition-all ${
                isActive
                  ? "border-primary text-primary-foreground"
                  : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:border-foreground/30"
              }`}
              style={isActive ? { backgroundColor: meta.color, borderColor: meta.color } : undefined}
            >
              <Icon size={11} />
              {reportTitle}
            </button>
          );
        })}
      </div>

      {/* Contenido del reporte activo · solo en pantalla */}
      {activeReport && (
        <motion.div
          key={activeReport.report_type}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="glass rounded-2xl p-5 print:hidden"
        >
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
            <div className="flex items-center gap-2">
              <ActiveIcon size={16} className="text-primary" />
              <h3 className="font-display font-bold text-base text-foreground">
                {REPORT_META[activeReport.report_type]
                  ? t(`analysisDashboard.reportTitle.${activeReport.report_type}`)
                  : activeReport.report_type}
              </h3>
            </div>
            <span className="text-[9px] text-muted-foreground font-mono">
              {activeReport.model} · {activeReport.prompt_version}
            </span>
          </div>

          {/* Evolution sparkline embebido solo en player-report */}
          {activeReport.report_type === "player-report" &&
            Array.isArray(analysis.vsi?.history) &&
            (analysis.vsi?.history?.length ?? 0) >= 2 && (
              <VsiSparkline history={analysis.vsi!.history!} currentVsi={vsi ?? undefined} />
            )}

          <ReportContent reportType={activeReport.report_type} report={activeReport.content} />
        </motion.div>
      )}

      {/* Print mode · TODOS los reportes apilados, solo visible al imprimir */}
      <div className="hidden print:block space-y-4">
        {reports.map((r) => {
          const meta = REPORT_META[r.report_type];
          const Icon = meta?.Icon ?? Brain;
          return (
            <div key={r.report_type} className="break-inside-avoid border border-border rounded-2xl p-4 page-break-inside-avoid">
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
                <div className="flex items-center gap-2">
                  <Icon size={14} className="text-primary" />
                  <h3 className="font-display font-bold text-sm">
                    {meta ? t(`analysisDashboard.reportTitle.${r.report_type}`) : r.report_type}
                  </h3>
                </div>
                <span className="text-[9px] text-muted-foreground font-mono">
                  {r.model} · {r.prompt_version}
                </span>
              </div>
              <ReportContent reportType={r.report_type} report={r.content} />
            </div>
          );
        })}
      </div>

      {/* Comparación con los propios jugadores (percentil único) · oculta en print */}
      <div className="glass rounded-2xl p-4 print:hidden">
        <PeerBenchmark playerId={analysis.player_id} variant="compact" />
      </div>

      {/* Drill Recommendations · auto-derivadas de areas_to_improve */}
      {areasDesarrollo.length > 0 && (
        <DrillRecommendations areasDesarrollo={areasDesarrollo} />
      )}

      {/* Datos técnicos crudos · ocultos al imprimir */}
      <details className="text-xs text-muted-foreground print:hidden">
        <summary className="cursor-pointer hover:text-foreground transition-colors flex items-center gap-1.5">
          <Activity size={11} /> {t("analysisDashboard.technicalData")}
        </summary>
        <div className="mt-2 rounded-xl bg-secondary/30 p-3 space-y-2 font-mono text-[10px]">
          <div>
            <div className="text-foreground font-bold mb-1">{t("analysisDashboard.biomechanics")}</div>
            <pre className="whitespace-pre-wrap break-all text-muted-foreground">
              {JSON.stringify(analysis.biomechanics, null, 2)}
            </pre>
          </div>
          <div>
            <div className="text-foreground font-bold mb-1">PHV</div>
            <pre className="whitespace-pre-wrap break-all text-muted-foreground">
              {JSON.stringify(analysis.phv, null, 2)}
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}

// ─── ReportContent · dispatcher por report_type (FASE 3c) ────────────────────

/**
 * Enruta cada reporte a su renderer dedicado (valuation/injury/fatigue) o al
 * ReportRenderer genérico si no hay uno. Los dedicados consumen el schema
 * completo (antes todo caía al genérico y se perdían los campos ricos).
 * Muestra el aviso ámbar de fallback antes del renderer dedicado.
 */
function ReportContent({ reportType, report }: { reportType: string; report: Record<string, unknown> }) {
  const { t } = useTranslation();

  // Separar el flag de fallback del contenido real
  let content = report;
  let notice: React.ReactNode = null;
  if (report && (report as { _fallback?: boolean })._fallback) {
    const { _fallback, _source, ...rest } = report as Record<string, unknown> & { _fallback?: boolean; _source?: string };
    void _fallback; void _source;
    content = rest;
    notice = (
      <p className="text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-3">
        ⚠ {t("analysisDashboard.fallbackNotice")}
      </p>
    );
  }

  const Dedicated = REPORT_RENDERERS[reportType];
  const body = Dedicated ? <Dedicated report={content} /> : <ReportRenderer report={content} />;

  // FASE 4: la confianza que el agente ya emite se pinta arriba, uniforme para
  // renderer dedicado y genérico (solo aparece si el reporte la trae).
  return (
    <div>
      {notice}
      <ReportConfidenceChip report={content} />
      {body}
    </div>
  );
}

// ─── ReportRenderer ──────────────────────────────────────────────────────────

/**
 * Renderiza el JSON de un reporte intentando varios shapes:
 *   {title, summary, sections}, {strengths, concerns, recommendations},
 *   {blocks}, {metrics_table}. Fallback: pretty-print JSON.
 */
function ReportRenderer({ report }: { report: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (!report || Object.keys(report).length === 0) {
    return <p className="text-xs text-muted-foreground italic">{t("analysisDashboard.noContent")}</p>;
  }

  // El agente respondió con fallback/mock → avisar SIEMPRE antes del contenido
  // (los números de un fallback son de ejemplo, no del análisis real)
  const fallbackNotice = report._fallback ? (
    <p className="text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-3">
      ⚠ {t("analysisDashboard.fallbackNotice")}
    </p>
  ) : null;
  if (fallbackNotice) {
    const { _fallback, _source, ...rest } = report as Record<string, unknown> & { _fallback?: boolean; _source?: string };
    void _fallback; void _source;
    return (
      <div>
        {fallbackNotice}
        <ReportRenderer report={rest} />
      </div>
    );
  }

  // Best-match shape (narrator primary_match OR top3+primary OR legacy single-match)
  const top3 = report.top3 as Array<BestMatchItem> | undefined;
  const isBestMatch = !!top3 || !!report.primary_match || (typeof report.nombre === "string" && typeof report.score === "number");
  if (isBestMatch) {
    return <BestMatchSection report={report} />;
  }

  const title = report.title as string | undefined;
  const summary = (report.summary as string | undefined) ?? (report.executive_summary as string | undefined);
  // asItemArray: el LLM puede emitir estos campos como string o con elementos null;
  // sin coerción, `.length > 0` deja pasar un string y `.map` lanza (crash de render).
  const strengths = asItemArray<{ title?: string; description?: string } | string>(report.strengths);
  const concerns = asItemArray<{ title?: string; description?: string } | string>(
    report.concerns ?? report.areas_to_improve,
  );
  const recommendations = asItemArray<{ title?: string; description?: string } | string>(report.recommendations);
  const nextFocus = (report.next_focus as string | undefined) ?? (report.proximo_foco as string | undefined);
  const blocks = report.blocks as Record<string, unknown>[] | undefined;
  const metricsTable = asItemArray<Record<string, unknown>>(report.metrics_table);
  const pillars = report.pillars as Array<{ pilar?: string; acciones?: string[]; prioridad?: string }> | undefined;

  return (
    <div className="space-y-4">
      {title && <h4 className="font-display font-bold text-sm text-foreground">{title}</h4>}
      {summary && <p className="text-xs text-foreground leading-relaxed">{summary}</p>}

      {metricsTable && metricsTable.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="p-2 border-b border-border font-bold">{t("analysisDashboard.tableMetric")}</th>
                <th className="p-2 border-b border-border font-bold">{t("analysisDashboard.tableValue")}</th>
                <th className="p-2 border-b border-border font-bold">{t("analysisDashboard.tableInterpretation")}</th>
              </tr>
            </thead>
            <tbody>
              {metricsTable.map((m, i) => (
                <tr key={i} className="hover:bg-secondary/30">
                  <td className="p-2 border-b border-border/40 font-semibold text-foreground">
                    {m.metric as string}
                  </td>
                  <td className="p-2 border-b border-border/40 font-mono text-primary">
                    {m.value as string}
                  </td>
                  <td className="p-2 border-b border-border/40 text-muted-foreground">
                    {m.interpretation as string}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {strengths.length > 0 && (
        <Section heading={t("analysisDashboard.strengths")} color="text-green-400">
          {strengths.map((s, i) => {
            const desc = s && typeof s === "object" ? (s as { description?: string }).description : undefined;
            return <li key={i}>{itemTitle(s) || "—"}{desc ? <span className="text-muted-foreground"> · {desc}</span> : null}</li>;
          })}
        </Section>
      )}

      {concerns.length > 0 && (
        <Section heading={t("analysisDashboard.areasToImprove")} color="text-amber-400">
          {concerns.map((s, i) => {
            const desc = s && typeof s === "object" ? (s as { description?: string }).description : undefined;
            return <li key={i}>{itemTitle(s) || "—"}{desc ? <span className="text-muted-foreground"> · {desc}</span> : null}</li>;
          })}
        </Section>
      )}

      {recommendations.length > 0 && (
        <Section heading={t("analysisDashboard.recommendations")} color="text-electric">
          {recommendations.map((s, i) => {
            const desc = s && typeof s === "object" ? (s as { description?: string }).description : undefined;
            return <li key={i}>{itemTitle(s) || "—"}{desc ? <span className="text-muted-foreground"> · {desc}</span> : null}</li>;
          })}
        </Section>
      )}

      {pillars && pillars.length > 0 && (
        <Section heading={t("analysisDashboard.workPillars")} color="text-primary">
          {pillars.map((p, i) => (
            <li key={i}>
              <span className="font-semibold text-foreground">{p.pilar}</span>
              {p.prioridad && (
                <span className="ml-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                  ({p.prioridad})
                </span>
              )}
              {Array.isArray(p.acciones) && p.acciones.length > 0 && (
                <ul className="ml-4 mt-1 list-[circle] list-inside text-muted-foreground">
                  {p.acciones.map((a, j) => <li key={j}>{a}</li>)}
                </ul>
              )}
            </li>
          ))}
        </Section>
      )}

      {nextFocus && (
        <div className="rounded-xl bg-primary/10 border border-primary/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-primary font-bold mb-1">
            {t("analysisDashboard.nextFocus")}
          </div>
          <p className="text-xs text-foreground">{nextFocus}</p>
        </div>
      )}

      {blocks && blocks.length > 0 && (
        <div className="space-y-2">
          {blocks.map((b, i) => (
            <div key={i} className="rounded-xl bg-secondary/30 border-l-2 border-electric p-3">
              <div className="text-[10px] uppercase tracking-wider text-electric font-bold">
                {t("analysisDashboard.block", { number: (b.block_number as number) ?? i + 1 })}
                {b.weeks && <span className="ml-2 text-muted-foreground">· {b.weeks as string}</span>}
              </div>
              <p className="text-xs text-foreground mt-1">{b.theme as string}</p>
              {Array.isArray(b.objectives) && (
                <ul className="text-[11px] text-muted-foreground mt-1.5 list-disc list-inside">
                  {(b.objectives as string[]).map((o, j) => <li key={j}>{o}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Fallback */}
      {!title && !summary && !blocks && !strengths && !concerns && !recommendations && !pillars && !metricsTable && (
        <pre className="bg-secondary/30 rounded-xl p-3 text-[10px] overflow-x-auto whitespace-pre-wrap text-muted-foreground font-mono">
          {JSON.stringify(report, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─── VsiSparkline · evolution chart embebido en player-report ───────────────

function VsiSparkline({ history, currentVsi }: { history: number[]; currentVsi?: number }) {
  const { t } = useTranslation();
  // Render simple SVG path · sin recharts para mantener bundle ligero
  if (history.length < 2) return null;

  const w = 100;   // viewBox units
  const h = 24;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = Math.max(1, max - min);

  const points = history.map((v, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y.toFixed(1)}`;
  });
  const linePath = `M${points.join(" L")}`;
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;

  const first = history[0];
  const last = history[history.length - 1];
  const delta = last - first;
  const deltaSign = delta > 0 ? "+" : "";
  const deltaColor = delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="mb-4 rounded-lg bg-secondary/30 border border-border p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
          {t("analysisDashboard.vsiEvolution", { count: history.length })}
        </div>
        <div className={`text-[11px] font-display font-bold ${deltaColor}`}>
          {deltaSign}{delta.toFixed(1)} {t("analysisDashboard.pts")}
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h + 2}`} preserveAspectRatio="none" className="w-full h-12 overflow-visible">
        <path d={areaPath} fill="hsl(var(--primary))" fillOpacity={0.15} />
        <path d={linePath} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {history.map((v, i) => {
          const x = (i / (history.length - 1)) * w;
          const y = h - ((v - min) / range) * h;
          const isLast = i === history.length - 1;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={isLast ? 2 : 1.2}
              fill={isLast ? "hsl(var(--primary))" : "hsl(var(--electric))"}
              stroke={isLast ? "hsl(var(--background))" : "none"}
              strokeWidth={isLast ? 1 : 0}
            />
          );
        })}
      </svg>
      <div className="flex items-center justify-between mt-1 text-[9px] text-muted-foreground">
        <span>{t("analysisDashboard.vsiInitial")} <span className="text-foreground font-bold">{first.toFixed(1)}</span></span>
        <span>{t("analysisDashboard.vsiCurrent")} <span className="text-primary font-bold">{(currentVsi ?? last).toFixed(1)}</span></span>
      </div>
    </div>
  );
}

// ─── TrendBadge · momentum del VSI con confianza ────────────────────────────

function TrendBadge({ trend }: {
  trend: { slope: number | null; momentum: "up" | "flat" | "down" | null; confidence: "high" | "medium" | "low"; delta: number | null; samples: number };
}) {
  const { t } = useTranslation();
  const arrow = trend.momentum === "up" ? "↗" : trend.momentum === "down" ? "↘" : "→";
  const color = trend.momentum === "up" ? "text-green-400" : trend.momentum === "down" ? "text-red-400" : "text-muted-foreground";
  const slope = trend.slope ?? 0;
  const slopeStr = slope > 0 ? `+${slope.toFixed(1)}` : slope.toFixed(1);
  const confDot = trend.confidence === "high" ? "●●●" : trend.confidence === "medium" ? "●●○" : "●○○";

  return (
    <div className="flex items-center gap-1.5">
      <span className={`font-display font-bold text-base ${color}`}>{arrow}</span>
      <span className="text-muted-foreground">
        <span className={`${color} font-bold`}>{slopeStr}</span>
        <span> {t("analysisDashboard.perAnalysis")}</span>
        <span className="text-foreground/60 ml-1.5" title={t("analysisDashboard.confidenceTitle", { confidence: trend.confidence, count: trend.samples })}>{confDot}</span>
      </span>
    </div>
  );
}

function Section({
  heading,
  color,
  children,
}: {
  heading: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h5 className={`font-display font-bold text-xs ${color} mb-1.5`}>{heading}</h5>
      <ul className="list-disc list-inside space-y-1 text-xs text-foreground">{children}</ul>
    </section>
  );
}

// ─── BestMatchSection ───────────────────────────────────────────────────────

interface BestMatchItem {
  lens?: "tecnico" | "fisico" | "lider" | string;
  nombre?: string;
  posicion?: string;
  club?: string;
  score?: number;
  narrativa?: string;
  timeline_at_age?: string;
}

const LENS_META: Record<string, { label: string; color: string; emoji: string }> = {
  tecnico: { label: "Técnico",  color: "#1A8FFF", emoji: "🎯" },
  fisico:  { label: "Físico",   color: "#22e88c", emoji: "⚡" },
  lider:   { label: "Liderazgo", color: "#FFD700", emoji: "👑" },
};

/**
 * Renderer dedicado de best-match. El content llega ENVUELTO
 * ({ok,success,data:{…,narrative}}) porque el agente narrador usa la clave
 * `narrative` (no `report`), así que el orquestador persiste el envelope HTTP sin
 * desenvolver — igual que pasaba con dna-profile (#180) y projection. Sin este
 * renderer, `report.primary_match` era undefined → caía al volcado JSON crudo y el
 * chip de procedencia (docx #14 P4) no se pintaba. Se desenvuelve como los demás.
 */
function BestMatchReportView({ report }: { report: Record<string, unknown> }) {
  const data = report?.data as Record<string, unknown> | undefined;
  const narrative =
    data?.narrative && typeof data.narrative === "object" && !Array.isArray(data.narrative)
      ? (data.narrative as Record<string, unknown>)
      : report?.narrative && typeof report.narrative === "object" && !Array.isArray(report.narrative)
        ? (report.narrative as Record<string, unknown>)
        : report;
  return (
    <div className="space-y-3">
      <ReportConfidenceChip report={narrative} />
      <BestMatchSection report={narrative} />
    </div>
  );
}

function BestMatchSection({ report }: { report: Record<string, unknown> }) {
  const { t } = useTranslation();
  const top3 = report.top3 as BestMatchItem[] | undefined;
  const primary = report.primary as BestMatchItem | undefined;

  // Shape del agente narrador (_best-match-narrator): primary_match + other_matches
  // + caveat. Antes caía al renderer genérico y se perdía todo salvo el título.
  const pm = report.primary_match as { player?: string; club?: string; similarity_pct?: number; narrative?: string } | undefined;
  if (pm) {
    const others = (report.other_matches as Array<{ player?: string; similarity_pct?: number; shared_trait?: string }> | undefined) ?? [];
    const headline = report.headline as string | undefined;
    const caveat = report.caveat as string | undefined;
    const pct = Math.round(pm.similarity_pct ?? 0);
    const pctColor = pct >= 80 ? "text-green-400" : pct >= 60 ? "text-electric" : "text-amber-400";
    // docx #14 P4: el comparable puede venir DERIVADO de eventos observados (P3) →
    // se avisa con un chip; no se vende como similitud de una BD validada.
    const derived = report.provenance === "derived_from_observed_events" || report.lowConfidence === true;
    return (
      <div className="space-y-3">
        {derived && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 text-[10px] font-bold uppercase tracking-wider">
            {t("bestMatchReport.derivedCaveat")}
          </span>
        )}
        {headline && <p className="text-sm font-display font-semibold text-foreground">{headline}</p>}
        <div className="rounded-xl p-3 bg-primary/10 border border-primary/30">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-display font-bold text-sm text-foreground truncate">{pm.player ?? "—"}</div>
              {pm.club && <div className="text-[10px] text-muted-foreground">{pm.club}</div>}
            </div>
            <span className={`font-mono font-bold text-sm shrink-0 ${pctColor}`}>{pct}%</span>
          </div>
          {pm.narrative && <p className="text-xs text-foreground leading-relaxed mt-2">{pm.narrative}</p>}
        </div>
        {others.length > 0 && (
          <div className="grid gap-1.5">
            {others.map((o, i) => (
              <div key={i} className="rounded-lg px-3 py-2 bg-secondary/30 border border-border flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-foreground truncate">{o.player ?? "—"}</span>
                {o.shared_trait && <span className="text-muted-foreground truncate flex-1">{o.shared_trait}</span>}
                <span className="font-mono text-muted-foreground shrink-0">{Math.round(o.similarity_pct ?? 0)}%</span>
              </div>
            ))}
          </div>
        )}
        {caveat && (
          <p className="text-[11px] text-amber-500/90 leading-relaxed border-l-2 border-amber-500/40 pl-2">{caveat}</p>
        )}
      </div>
    );
  }

  // Legacy fallback: single match shape
  if (!top3 || top3.length === 0) {
    const single = (primary ?? report) as BestMatchItem;
    return (
      <div className="space-y-3">
        <BestMatchCard match={single} highlighted />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {primary && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2">
            {t("analysisDashboard.primaryMatch")}
          </div>
          <BestMatchCard match={primary} highlighted />
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2">
          {t("analysisDashboard.top3ByDimension")}
        </div>
        <div className="grid gap-2">
          {top3.map((m, i) => (
            <BestMatchCard key={i} match={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BestMatchCard({ match, highlighted }: { match: BestMatchItem; highlighted?: boolean }) {
  const { t } = useTranslation();
  const lensMeta = match.lens ? LENS_META[match.lens] : null;
  const lensLabel = match.lens && LENS_META[match.lens]
    ? t(`analysisDashboard.lensLabel.${match.lens}`)
    : lensMeta?.label ?? "";
  const score = match.score ?? 0;
  const scoreColor =
    score >= 80 ? "text-green-400" :
    score >= 60 ? "text-electric"   : "text-amber-400";

  return (
    <div
      className={`rounded-xl p-3 ${
        highlighted
          ? "bg-primary/10 border border-primary/30"
          : "bg-secondary/30 border border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {lensMeta && (
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0"
              style={{ backgroundColor: `${lensMeta.color}20` }}
              title={lensLabel}
            >
              {lensMeta.emoji}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-display font-bold text-sm text-foreground truncate">
              {match.nombre ?? "—"}
            </div>
            <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-1.5">
              {match.posicion && <span>{match.posicion}</span>}
              {match.club && <span>· {match.club}</span>}
              {lensMeta && (
                <span className="font-bold" style={{ color: lensMeta.color }}>
                  · {lensLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className={`font-display font-bold text-base ${scoreColor} shrink-0`}>
          {score}
          <span className="text-[10px] text-muted-foreground font-normal">/100</span>
        </div>
      </div>

      {match.narrativa && (
        <p className="text-[11px] text-foreground/90 leading-relaxed mt-2">
          {match.narrativa}
        </p>
      )}

      {match.timeline_at_age && (
        <div className="mt-2 pt-2 border-t border-border/40 flex items-start gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold shrink-0">
            {t("analysisDashboard.atTheirAge")}
          </span>
          <p className="text-[10px] text-muted-foreground italic leading-relaxed">
            {match.timeline_at_age}
          </p>
        </div>
      )}
    </div>
  );
}
