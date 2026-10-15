/**
 * VITAS · Bias Audit Dashboard — /admin/bias
 *
 * Visualiza las vistas SQL de detección de sesgo:
 *   v_bias_by_position, v_bias_by_age, v_bias_by_visibility,
 *   v_bias_by_recency, v_bias_dashboard
 *
 * Funciona con Supabase o con datos mock cuando no está configurado.
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Shield, AlertTriangle, CheckCircle2, Info,
  BarChart3, Users, Calendar, Eye, Clock, RefreshCw, Loader2, Download,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend, LineChart, Line,
} from "recharts";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { BiasEquityReport } from "@/components/bias/BiasEquityReport";
import ErrorState from "@/components/ErrorState";

// Gate de admin (mismo criterio que AdminDashboardPage/AdminManagePlanPage):
// esta auditoría interna de sesgo del modelo IA no debe verla cualquier usuario.
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS ?? "fredparedes58@gmail.com")
  .split(",").map((s: string) => s.trim().toLowerCase());

function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/* ── Types ─────────────────────────────────────────────────────── */

interface BiasRow {
  bias_type: string;
  category: string;
  player_count: number;
  avg_vsi: number;
  stddev_vsi: number;
  deviation_from_global_avg: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
}

interface VisibilityRow {
  data_volume: string;
  player_count: number;
  avg_vsi: number;
  stddev_vsi: number;
}

interface RecencyRow {
  month: string;
  analysis_count: number;
  avg_vsi: number;
  stddev_vsi: number;
}

/* ── Mock data for when Supabase is not configured ─────────────── */

const MOCK_DASHBOARD: BiasRow[] = [
  { bias_type: "position", category: "Delantero", player_count: 8, avg_vsi: 72.3, stddev_vsi: 8.1, deviation_from_global_avg: 5.8, severity: "MEDIUM" },
  { bias_type: "position", category: "Mediocampista", player_count: 12, avg_vsi: 68.1, stddev_vsi: 9.4, deviation_from_global_avg: 1.6, severity: "LOW" },
  { bias_type: "position", category: "Defensa", player_count: 10, avg_vsi: 63.2, stddev_vsi: 7.8, deviation_from_global_avg: -3.3, severity: "LOW" },
  { bias_type: "position", category: "Portero", player_count: 4, avg_vsi: 60.5, stddev_vsi: 6.2, deviation_from_global_avg: -6.0, severity: "MEDIUM" },
  { bias_type: "age", category: "U14", player_count: 6, avg_vsi: 58.2, stddev_vsi: 10.1, deviation_from_global_avg: -8.3, severity: "MEDIUM" },
  { bias_type: "age", category: "U17", player_count: 14, avg_vsi: 69.5, stddev_vsi: 8.7, deviation_from_global_avg: 3.0, severity: "LOW" },
  { bias_type: "age", category: "U20", player_count: 10, avg_vsi: 73.1, stddev_vsi: 7.3, deviation_from_global_avg: 6.6, severity: "MEDIUM" },
  { bias_type: "age", category: "20+", player_count: 4, avg_vsi: 70.2, stddev_vsi: 5.9, deviation_from_global_avg: 3.7, severity: "LOW" },
];

const MOCK_VISIBILITY: VisibilityRow[] = [
  { data_volume: "0 videos", player_count: 5, avg_vsi: 55.0, stddev_vsi: 12.0 },
  { data_volume: "1 video", player_count: 10, avg_vsi: 62.3, stddev_vsi: 9.5 },
  { data_volume: "2-3 videos", player_count: 12, avg_vsi: 68.7, stddev_vsi: 8.1 },
  { data_volume: "4-6 videos", player_count: 5, avg_vsi: 74.2, stddev_vsi: 6.3 },
  { data_volume: "7+ videos", player_count: 2, avg_vsi: 78.5, stddev_vsi: 4.1 },
];

const MOCK_RECENCY: RecencyRow[] = [
  { month: "2026-05", analysis_count: 18, avg_vsi: 67.8, stddev_vsi: 9.2 },
  { month: "2026-04", analysis_count: 22, avg_vsi: 66.1, stddev_vsi: 8.8 },
  { month: "2026-03", analysis_count: 15, avg_vsi: 65.3, stddev_vsi: 10.1 },
  { month: "2026-02", analysis_count: 12, avg_vsi: 64.9, stddev_vsi: 9.5 },
  { month: "2026-01", analysis_count: 8, avg_vsi: 63.2, stddev_vsi: 11.0 },
];

/* ── Severity colors ───────────────────────────────────────────── */

const severityColor = {
  HIGH: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30", bar: "#ef4444" },
  MEDIUM: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30", bar: "#f59e0b" },
  LOW: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30", bar: "#10b981" },
};

const severityIcon = {
  HIGH: <AlertTriangle size={14} className="text-red-400" />,
  MEDIUM: <Info size={14} className="text-amber-400" />,
  LOW: <CheckCircle2 size={14} className="text-emerald-400" />,
};

/* ── Fetch helpers ─────────────────────────────────────────────── */

async function fetchBiasDashboard(): Promise<BiasRow[]> {
  if (!SUPABASE_CONFIGURED) return MOCK_DASHBOARD;
  const { data, error } = await supabase.from("v_bias_dashboard").select("*");
  if (error) throw error;
  return (data ?? []) as BiasRow[];
}

async function fetchVisibility(): Promise<VisibilityRow[]> {
  if (!SUPABASE_CONFIGURED) return MOCK_VISIBILITY;
  const { data, error } = await supabase.from("v_bias_by_visibility").select("*");
  if (error) throw error;
  return (data ?? []) as VisibilityRow[];
}

async function fetchRecency(): Promise<RecencyRow[]> {
  if (!SUPABASE_CONFIGURED) return MOCK_RECENCY;
  const { data, error } = await supabase.from("v_bias_by_recency").select("*");
  if (error) throw error;
  return (data ?? []) as RecencyRow[];
}

/* ── Component ─────────────────────────────────────────────────── */

export default function BiasAuditDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const [activeTab, setActiveTab] = useState<"overview" | "position" | "age" | "visibility" | "recency">("overview");

  const { data: dashboard, isLoading: loadingDash, isError: errorDash, refetch: refetchDash } = useQuery({
    queryKey: ["bias-dashboard"],
    queryFn: fetchBiasDashboard,
    staleTime: 60_000,
  });

  const { data: visibility, isLoading: loadingVis } = useQuery({
    queryKey: ["bias-visibility"],
    queryFn: fetchVisibility,
    staleTime: 60_000,
  });

  const { data: recency, isLoading: loadingRec } = useQuery({
    queryKey: ["bias-recency"],
    queryFn: fetchRecency,
    staleTime: 60_000,
  });

  const isLoading = loadingDash || loadingVis || loadingRec;

  // Separate position and age data
  const positionData = useMemo(() => dashboard?.filter(r => r.bias_type === "position") ?? [], [dashboard]);
  const ageData = useMemo(() => dashboard?.filter(r => r.bias_type === "age") ?? [], [dashboard]);

  // Summary counts
  const highCount = dashboard?.filter(r => r.severity === "HIGH").length ?? 0;
  const mediumCount = dashboard?.filter(r => r.severity === "MEDIUM").length ?? 0;
  const lowCount = dashboard?.filter(r => r.severity === "LOW").length ?? 0;

  // Visibility correlation (is more data = higher score?)
  const visCorrelation = useMemo(() => {
    if (!visibility || visibility.length < 2) return null;
    const sorted = [...visibility].sort((a, b) => a.avg_vsi - b.avg_vsi);
    const diff = sorted[sorted.length - 1].avg_vsi - sorted[0].avg_vsi;
    if (diff > 15) return { level: "HIGH" as const, msg: t("biasAudit.correlationMsgHigh", { diff: diff.toFixed(1) }) };
    if (diff > 8) return { level: "MEDIUM" as const, msg: t("biasAudit.correlationMsgMedium", { diff: diff.toFixed(1) }) };
    return { level: "LOW" as const, msg: t("biasAudit.correlationMsgLow", { diff: diff.toFixed(1) }) };
  }, [visibility, t]);

  const tabs = [
    { id: "overview" as const, label: t("biasAudit.tabOverview"), icon: <BarChart3 size={14} /> },
    { id: "position" as const, label: t("biasAudit.tabPosition"), icon: <Users size={14} /> },
    { id: "age" as const, label: t("biasAudit.tabAge"), icon: <Calendar size={14} /> },
    { id: "visibility" as const, label: t("biasAudit.tabVisibility"), icon: <Eye size={14} /> },
    { id: "recency" as const, label: t("biasAudit.tabRecency"), icon: <Clock size={14} /> },
  ];

  // Gate: solo admin. Un no-admin que teclee /admin/bias no debe ver la
  // auditoría interna de sesgo del modelo (igual que /admin y /admin/plans).
  if (!isAdmin(user?.email)) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass rounded-xl p-6 max-w-md text-center">
          <Shield size={28} className="text-destructive mx-auto mb-2" />
          <h2 className="font-display font-bold text-lg text-foreground mb-1">{t("biasAudit.accessRestricted")}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t("biasAudit.accessRestrictedDesc")}</p>
          <button
            onClick={() => navigate("/")}
            className="text-xs font-display font-semibold text-primary hover:underline"
          >
            {t("biasAudit.backToHome")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-background pb-24 print:hidden"
    >
      {/* Header */}
      <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-xl hover:bg-muted/50 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <Shield size={18} className="text-primary" />
          <h1 className="font-display font-bold text-sm uppercase tracking-wider flex-1">
            {t("biasAudit.title")}
          </h1>
          <button
            onClick={() => window.print()}
            disabled={isLoading || !dashboard}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 text-xs font-display font-semibold"
            title={t("biasAudit.exportPdfTitle")}
            aria-label={t("biasAudit.exportPdfAria")}
          >
            <Download size={14} />
            <span className="hidden sm:inline">{t("biasAudit.exportPdf")}</span>
          </button>
          <button
            onClick={() => refetchDash()}
            className="p-2 rounded-xl hover:bg-muted/50 transition-colors"
            aria-label={t("biasAudit.refresh")}
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Tabs */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-display font-semibold whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Mock data banner */}
        {!SUPABASE_CONFIGURED && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
            <Info size={14} />
            <span>{t("biasAudit.mockBanner")}</span>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        ) : errorDash ? (
          /* Error de carga — distinto del vacío "sin sesgos detectados" (#20) */
          <div className="py-8">
            <ErrorState onRetry={() => refetchDash()} />
          </div>
        ) : (
          <>
            {/* ── OVERVIEW TAB ──────────────────────────────────── */}
            {activeTab === "overview" && (
              <div className="space-y-6">
                {/* Severity summary cards */}
                <div className="grid grid-cols-3 gap-3">
                  <div className={`glass rounded-xl p-4 border ${severityColor.HIGH.border}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle size={16} className="text-red-400" />
                      <span className="text-xs font-display font-bold text-red-400 uppercase">{t("biasAudit.severityHigh")}</span>
                    </div>
                    <p className="text-2xl font-display font-bold text-foreground">{highCount}</p>
                    <p className="text-[10px] text-muted-foreground">{t("biasAudit.severityHighDesc")}</p>
                  </div>
                  <div className={`glass rounded-xl p-4 border ${severityColor.MEDIUM.border}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Info size={16} className="text-amber-400" />
                      <span className="text-xs font-display font-bold text-amber-400 uppercase">{t("biasAudit.severityMedium")}</span>
                    </div>
                    <p className="text-2xl font-display font-bold text-foreground">{mediumCount}</p>
                    <p className="text-[10px] text-muted-foreground">{t("biasAudit.severityMediumDesc")}</p>
                  </div>
                  <div className={`glass rounded-xl p-4 border ${severityColor.LOW.border}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle2 size={16} className="text-emerald-400" />
                      <span className="text-xs font-display font-bold text-emerald-400 uppercase">{t("biasAudit.severityLow")}</span>
                    </div>
                    <p className="text-2xl font-display font-bold text-foreground">{lowCount}</p>
                    <p className="text-[10px] text-muted-foreground">{t("biasAudit.severityLowDesc")}</p>
                  </div>
                </div>

                {/* All bias rows */}
                <div className="glass rounded-xl overflow-hidden">
                  <div className="p-4 border-b border-border/40">
                    <h2 className="text-sm font-display font-bold text-foreground">{t("biasAudit.allCategories")}</h2>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t("biasAudit.allCategoriesDesc")}</p>
                  </div>
                  <div className="divide-y divide-border/20">
                    {dashboard?.map((row, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <div className={`p-1.5 rounded-lg ${severityColor[row.severity].bg}`}>
                          {severityIcon[row.severity]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-display font-semibold text-foreground">{row.category}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                              {row.bias_type === "position" ? t("biasAudit.badgePosition") : t("biasAudit.badgeAge")}
                            </span>
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {t("biasAudit.categoryStats", { count: row.player_count, avgVsi: row.avg_vsi, stddev: row.stddev_vsi })}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className={`text-sm font-display font-bold ${
                            row.deviation_from_global_avg > 0 ? "text-emerald-400" : "text-red-400"
                          }`}>
                            {row.deviation_from_global_avg > 0 ? "+" : ""}{row.deviation_from_global_avg}
                          </span>
                          <p className={`text-[9px] font-display font-bold uppercase ${severityColor[row.severity].text}`}>
                            {row.severity}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Explanation */}
                <div className="glass rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-display font-bold text-foreground">{t("biasAudit.howToInterpret")}</h3>
                  <ul className="text-[10px] text-muted-foreground space-y-1 leading-relaxed">
                    <li><span className="text-red-400 font-bold">HIGH {t("biasAudit.interpretHighRange")}</span> {t("biasAudit.interpretHighDesc")}</li>
                    <li><span className="text-amber-400 font-bold">MEDIUM {t("biasAudit.interpretMediumRange")}</span> {t("biasAudit.interpretMediumDesc")}</li>
                    <li><span className="text-emerald-400 font-bold">LOW {t("biasAudit.interpretLowRange")}</span> {t("biasAudit.interpretLowDesc")}</li>
                  </ul>
                </div>
              </div>
            )}

            {/* ── POSITION TAB ──────────────────────────────────── */}
            {activeTab === "position" && (
              <div className="space-y-6">
                <div className="glass rounded-xl p-4">
                  <h2 className="text-sm font-display font-bold text-foreground mb-1">{t("biasAudit.positionChartTitle")}</h2>
                  <p className="text-[10px] text-muted-foreground mb-4">{t("biasAudit.positionChartDesc")}</p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={positionData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="category" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                        <Tooltip
                          contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }}
                          labelStyle={{ color: "#e2e8f0", fontWeight: 700 }}
                        />
                        <Bar dataKey="avg_vsi" name={t("biasAudit.seriesAvgVsi")} radius={[6, 6, 0, 0]}>
                          {positionData.map((row, i) => (
                            <Cell key={i} fill={severityColor[row.severity].bar} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                {positionData.map((row, i) => (
                  <div key={i} className={`glass rounded-xl p-4 border ${severityColor[row.severity].border}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {severityIcon[row.severity]}
                        <span className="text-sm font-display font-bold text-foreground">{row.category}</span>
                      </div>
                      <span className={`text-xs font-display font-bold ${severityColor[row.severity].text}`}>{row.severity}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-3">
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statPlayers")}</p><p className="text-sm font-bold text-foreground">{row.player_count}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statAvgVsi")}</p><p className="text-sm font-bold text-foreground">{row.avg_vsi}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statStddev")}</p><p className="text-sm font-bold text-foreground">{row.stddev_vsi}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statVsGlobal")}</p><p className={`text-sm font-bold ${row.deviation_from_global_avg > 0 ? "text-emerald-400" : "text-red-400"}`}>{row.deviation_from_global_avg > 0 ? "+" : ""}{row.deviation_from_global_avg}</p></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── AGE TAB ──────────────────────────────────────── */}
            {activeTab === "age" && (
              <div className="space-y-6">
                <div className="glass rounded-xl p-4">
                  <h2 className="text-sm font-display font-bold text-foreground mb-1">{t("biasAudit.ageChartTitle")}</h2>
                  <p className="text-[10px] text-muted-foreground mb-4">{t("biasAudit.ageChartDesc")}</p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={ageData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="category" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                        <Tooltip
                          contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }}
                          labelStyle={{ color: "#e2e8f0", fontWeight: 700 }}
                        />
                        <Bar dataKey="avg_vsi" name={t("biasAudit.seriesAvgVsi")} radius={[6, 6, 0, 0]}>
                          {ageData.map((row, i) => (
                            <Cell key={i} fill={severityColor[row.severity].bar} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                {ageData.map((row, i) => (
                  <div key={i} className={`glass rounded-xl p-4 border ${severityColor[row.severity].border}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {severityIcon[row.severity]}
                        <span className="text-sm font-display font-bold text-foreground">{row.category}</span>
                      </div>
                      <span className={`text-xs font-display font-bold ${severityColor[row.severity].text}`}>{row.severity}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-3">
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statPlayers")}</p><p className="text-sm font-bold text-foreground">{row.player_count}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statAvgVsi")}</p><p className="text-sm font-bold text-foreground">{row.avg_vsi}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statStddev")}</p><p className="text-sm font-bold text-foreground">{row.stddev_vsi}</p></div>
                      <div><p className="text-[9px] text-muted-foreground">{t("biasAudit.statVsGlobal")}</p><p className={`text-sm font-bold ${row.deviation_from_global_avg > 0 ? "text-emerald-400" : "text-red-400"}`}>{row.deviation_from_global_avg > 0 ? "+" : ""}{row.deviation_from_global_avg}</p></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── VISIBILITY TAB ────────────────────────────────── */}
            {activeTab === "visibility" && (
              <div className="space-y-6">
                <div className="glass rounded-xl p-4">
                  <h2 className="text-sm font-display font-bold text-foreground mb-1">{t("biasAudit.visibilityChartTitle")}</h2>
                  <p className="text-[10px] text-muted-foreground mb-4">{t("biasAudit.visibilityChartDesc")}</p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={visibility} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="data_volume" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                        <Tooltip
                          contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }}
                          labelStyle={{ color: "#e2e8f0", fontWeight: 700 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="avg_vsi" name={t("biasAudit.seriesAvgVsi")} fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="player_count" name={t("biasAudit.seriesPlayers")} fill="#334155" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {visCorrelation && (
                  <div className={`glass rounded-xl p-4 border ${severityColor[visCorrelation.level].border}`}>
                    <div className="flex items-center gap-2 mb-1">
                      {severityIcon[visCorrelation.level]}
                      <span className={`text-xs font-display font-bold ${severityColor[visCorrelation.level].text}`}>
                        {t("biasAudit.correlationLabel", { level: visCorrelation.level })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{visCorrelation.msg}</p>
                  </div>
                )}

                <div className="glass rounded-xl p-4">
                  <h3 className="text-xs font-display font-bold text-foreground mb-2">{t("biasAudit.visibilityDetailTitle")}</h3>
                  <div className="divide-y divide-border/20">
                    {visibility?.map((row, i) => (
                      <div key={i} className="flex items-center justify-between py-2">
                        <span className="text-xs font-display text-foreground">{row.data_volume}</span>
                        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                          <span>{t("biasAudit.playersCount", { count: row.player_count })}</span>
                          {/* v_bias_by_visibility = players.vsi: la evaluación del entrenador. */}
                          <span className="font-bold text-foreground">{t("coachEval.short")} {row.avg_vsi}</span>
                          <span>σ {row.stddev_vsi}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── RECENCY TAB ──────────────────────────────────── */}
            {activeTab === "recency" && (
              <div className="space-y-6">
                <div className="glass rounded-xl p-4">
                  <h2 className="text-sm font-display font-bold text-foreground mb-1">{t("biasAudit.recencyChartTitle")}</h2>
                  <p className="text-[10px] text-muted-foreground mb-4">{t("biasAudit.recencyChartDesc")}</p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={[...(recency ?? [])].reverse()} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis
                          dataKey="month"
                          tick={{ fontSize: 10, fill: "#94a3b8" }}
                          tickFormatter={(v: string) => {
                            const d = new Date(v);
                            return d.toLocaleDateString("es-ES", { month: "short", year: "2-digit" });
                          }}
                        />
                        <YAxis domain={[40, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                        <Tooltip
                          contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }}
                          labelFormatter={(v: string) => {
                            const d = new Date(v);
                            return d.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        {/* v_bias_by_recency = AVG(player_analyses.report->>'vsi'): el VSI de los
                            análisis de vídeo (IA), NO la evaluación del entrenador (037_bias_audit.sql). */}
                        <Line type="monotone" dataKey="avg_vsi" name={t("biasAudit.seriesAvgVideoVsi")} stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} />
                        <Line type="monotone" dataKey="analysis_count" name={t("biasAudit.seriesAnalyses")} stroke="#334155" strokeWidth={1} strokeDasharray="4 4" dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="glass rounded-xl p-4">
                  <h3 className="text-xs font-display font-bold text-foreground mb-2">{t("biasAudit.recencyDetailTitle")}</h3>
                  <div className="divide-y divide-border/20">
                    {recency?.map((row, i) => {
                      const d = new Date(row.month);
                      const label = d.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
                      return (
                        <div key={i} className="flex items-center justify-between py-2">
                          <span className="text-xs font-display text-foreground capitalize">{label}</span>
                          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                            <span>{t("biasAudit.analysesCount", { count: row.analysis_count })}</span>
                            <span className="font-bold text-foreground">VSI {row.avg_vsi}</span>
                            <span>σ {row.stddev_vsi}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="glass rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-display font-bold text-foreground">{t("biasAudit.promptDriftTitle")}</h3>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {t("biasAudit.promptDriftDesc")}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>

    {/* Informe de equidad imprimible (Sprint 3.2) — solo visible en @media print */}
    <div className="hidden print:block">
      <BiasEquityReport
        dashboard={dashboard ?? []}
        visibility={visibility ?? []}
        recency={recency ?? []}
        orgName={profile?.organizationName}
        generatedBy={user?.email ?? undefined}
        generatedAt={new Date().toISOString()}
      />
    </div>
    </>
  );
}
