/**
 * VITAS · Player Evolution Page
 * /players/:id/evolution
 *
 * Compara TODOS los reportes de inteligencia de un jugador
 * a lo largo del tiempo con graficos y deltas textuales.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Brain, TrendingUp, Loader2, ChevronDown, ChevronUp,
  Star, AlertTriangle, Target, Zap, Activity,
  ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from "recharts";

import { PlayerService } from "@/services/real/playerService";
import { VideoService } from "@/services/real/videoService";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import { SnapshotHistoryChart } from "@/components/evolution/SnapshotHistoryChart";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import RadarChartComponent from "@/components/RadarChart";
import type { VideoIntelligenceOutput } from "@/agents/contracts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_LABELS: Record<string, string> = {
  elite: "Elite", alto: "Alto", medio_alto: "Medio-Alto",
  medio: "Medio", desarrollo: "En Desarrollo",
};
const LEVEL_COLORS: Record<string, string> = {
  elite: "#FFD700", alto: "#22C55E", medio_alto: "#3B82F6",
  medio: "#F59E0B", desarrollo: "#8B5CF6",
};

const DIM_KEYS = [
  "velocidadDecision", "tecnicaConBalon", "inteligenciaTactica",
  "capacidadFisica", "liderazgoPresencia", "eficaciaCompetitiva",
] as const;

const DIM_LABELS: Record<string, string> = {
  velocidadDecision: "Velocidad Decision",
  tecnicaConBalon: "Tecnica con Balon",
  inteligenciaTactica: "Inteligencia Tactica",
  capacidadFisica: "Capacidad Fisica",
  liderazgoPresencia: "Liderazgo",
  eficaciaCompetitiva: "Eficacia Competitiva",
};

const DIM_SHORT: Record<string, string> = {
  velocidadDecision: "V.Dec",
  tecnicaConBalon: "Tec",
  inteligenciaTactica: "Tac",
  capacidadFisica: "Fis",
  liderazgoPresencia: "Lid",
  eficaciaCompetitiva: "Efic",
};

type AnalysisRow = { id: string; created_at: string; report: unknown; video_id?: string };

function getScores(report: VideoIntelligenceOutput | null | undefined) {
  const dims = report?.estadoActual?.dimensiones;
  if (!dims) return null;
  const scores: Record<string, number> = {};
  for (const key of DIM_KEYS) {
    scores[key] = (dims as Record<string, { score: number }>)[key]?.score ?? 0;
  }
  return scores;
}

function getAvg(scores: Record<string, number> | null) {
  if (!scores) return 0;
  const vals = Object.values(scores);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// #dimensiones fabricadas: el pipeline de vídeo NO puntúa por dimensión — los
// `score` de estadoActual.dimensiones son constantes fabricadas (rotuladas
// "Estimado por IA"). Solo son reales si el informe lo declara con
// estadoActual.dimensionesMedidas === true (hoy siempre false). Acceso cast-safe
// y null-safe, sin tocar el tipo del informe.
function hasRealDimensions(report: VideoIntelligenceOutput | null | undefined): boolean {
  return ((report?.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true);
}

// ─── Evolution Line Chart ────────────────────────────────────────────────────

interface ChartPoint {
  date: string;
  dateLabel: string;
  promedio: number;
  confianza: number | null;
  videoTitle: string;
  [dim: string]: string | number;
}

function EvolutionLineChart({ data }: { data: ChartPoint[] }) {
  const { t } = useTranslation();
  if (data.length < 2) return null;

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="glass rounded-lg p-2.5 border border-border text-[10px] space-y-1">
        <p className="font-bold text-foreground">{d.dateLabel}</p>
        <p className="text-muted-foreground">{d.videoTitle}</p>
        <p className="text-primary font-bold">{t("playerEvolutionPage.average")}: {d.promedio.toFixed(1)}</p>
        {d.confianza != null && (
          <p className="text-muted-foreground">{t("playerEvolutionPage.confidence")}: {Math.round(d.confianza * 100)}%</p>
        )}
      </div>
    );
  };

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity size={14} className="text-primary" />
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {t("playerEvolutionPage.generalEvolution")}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
          <defs>
            <linearGradient id="gradAvg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(230, 70%, 58%)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="hsl(230, 70%, 58%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(225, 18%, 18%)" />
          <XAxis dataKey="dateLabel" tick={{ fontSize: 9, fill: "hsl(220, 12%, 55%)" }} />
          <YAxis domain={[0, 10]} tick={{ fontSize: 9, fill: "hsl(220, 12%, 55%)" }} />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="promedio"
            stroke="hsl(230, 70%, 58%)"
            fill="url(#gradAvg)"
            strokeWidth={2}
            dot={{ r: 4, fill: "hsl(230, 70%, 58%)" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Dimension Mini Chart ────────────────────────────────────────────────────

function DimensionMiniChart({ dimKey, data }: { dimKey: string; data: ChartPoint[] }) {
  if (data.length < 2) return null;
  const first = data[0][dimKey] as number;
  const last = data[data.length - 1][dimKey] as number;
  const delta = last - first;
  const color = delta > 0.3 ? "#22C55E" : delta < -0.3 ? "#EF4444" : "#94A3B8";

  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-display font-bold text-foreground">{DIM_LABELS[dimKey]}</span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">{first.toFixed(1)}</span>
          <span className="text-[9px] text-muted-foreground">→</span>
          <span className="text-[10px] font-bold" style={{ color }}>{last.toFixed(1)}</span>
          <span className="text-[9px] font-bold" style={{ color }}>
            ({delta >= 0 ? "+" : ""}{delta.toFixed(1)})
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={60}>
        <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={`grad-${dimKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey={dimKey}
            stroke={color}
            fill={`url(#grad-${dimKey})`}
            strokeWidth={1.5}
            dot={{ r: 2, fill: color }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Textual Evolution Accordion ─────────────────────────────────────────────

function TextualEvolutionSection({ title, icon: Icon, children }: {
  title: string; icon: React.ElementType; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 p-3 text-left"
      >
        <Icon size={12} className="text-primary" />
        <span className="text-[11px] font-display font-bold text-foreground flex-1">{title}</span>
        {open ? <ChevronUp size={12} className="text-muted-foreground" /> : <ChevronDown size={12} className="text-muted-foreground" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TimelineBadges({ items }: { items: { label: string; date: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-[9px] text-muted-foreground">→</span>}
          <div className="text-center">
            <Badge
              className="text-[8px] font-bold"
              style={{ backgroundColor: `${item.color}20`, color: item.color, borderColor: item.color }}
            >
              {item.label}
            </Badge>
            <p className="text-[7px] text-muted-foreground mt-0.5">{item.date}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Recurring Patterns ──────────────────────────────────────────────────────

function RecurringPatterns({ analyses }: { analyses: AnalysisRow[] }) {
  const { t } = useTranslation();
  const total = analyses.length;
  if (total < 2) return null;

  const fortalezaCount: Record<string, number> = {};
  const areaCount: Record<string, number> = {};

  for (const a of analyses) {
    const r = a.report as VideoIntelligenceOutput;
    for (const f of r.estadoActual?.fortalezasPrimarias ?? []) {
      fortalezaCount[f] = (fortalezaCount[f] ?? 0) + 1;
    }
    for (const area of r.estadoActual?.areasDesarrollo ?? []) {
      areaCount[area] = (areaCount[area] ?? 0) + 1;
    }
  }

  const recurring = Object.entries(fortalezaCount)
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1]);

  const persistent = Object.entries(areaCount)
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1]);

  if (recurring.length === 0 && persistent.length === 0) return null;

  return (
    <>
      {recurring.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Star size={14} className="text-green-400" />
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              {t("playerEvolutionPage.recurringStrengths")}
            </span>
          </div>
          <div className="space-y-2">
            {recurring.map(([name, count]) => {
              const pct = Math.round((count / total) * 100);
              return (
                <div key={name}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] text-foreground">{name}</span>
                    <span className="text-[9px] text-green-400 font-bold">{count}/{total} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full rounded-full bg-green-500/60" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {persistent.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={14} className="text-amber-400" />
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              {t("playerEvolutionPage.persistentDevelopmentAreas")}
            </span>
          </div>
          <div className="space-y-2">
            {persistent.map(([name, count]) => {
              const pct = Math.round((count / total) * 100);
              return (
                <div key={name}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] text-foreground">{name}</span>
                    <span className="text-[9px] text-amber-400 font-bold">{count}/{total} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full rounded-full bg-amber-500/60" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PlayerEvolutionPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const player = id ? PlayerService.getById(id) : null;
  const { data: analyses, isLoading, isError, refetch } = useSavedAnalysesV2(id ?? "");

  if (!player) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <Brain size={32} className="text-destructive" />
        <p className="text-sm text-muted-foreground">{t("playerEvolutionPage.playerNotFound")}</p>
      </div>
    );
  }

  // Sort chronologically (oldest first for charts).
  // Filtra filas sin reporte generado (analysis completed_partial con 0 reportes)
  // para no petar al leer report.estadoActual sobre null (pantalla en blanco).
  const sorted = [...(analyses ?? [])].filter(
    (a) => (a as AnalysisRow).report != null,
  ).reverse() as AnalysisRow[];
  const total = sorted.length;

  // #dimensiones fabricadas: ¿algún informe trae dimensiones REALES medidas? Si
  // ninguno lo declara (el caso de hoy), se ocultan todos los charts derivados de
  // dimensión (resumen de medias, promedio longitudinal, radar comparativo y
  // mini-charts por dimensión) para no pintar puntuaciones fabricadas ni un 0 falso.
  // Solo los informes con dimensiones REALES entran en los charts/medias de dimensión:
  // filtrado POR INFORME (no un .some page-wide) para que NUNCA se mezcle un score real
  // con la constante fabricada de otro informe en la misma línea/radar/media. Hoy, con
  // ningún informe real, la lista queda vacía → charts ocultos.
  const realDimReports = sorted.filter(
    (a) => hasRealDimensions(a.report as VideoIntelligenceOutput),
  );
  const anyRealDimensions = realDimReports.length >= 2;

  // Build chart data (oldest → newest) — SOLO informes con dimensiones reales
  const chartData: ChartPoint[] = realDimReports.map((a) => {
    const r = a.report as VideoIntelligenceOutput;
    const scores = getScores(r);
    const date = new Date(a.created_at);
    const point: ChartPoint = {
      date: a.created_at,
      dateLabel: date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      promedio: getAvg(scores),
      confianza: r.confianza ?? null,
      videoTitle: r.videoId ? VideoService.getById(r.videoId)?.title ?? "Video" : "Sin video",
    };
    if (scores) {
      for (const [k, v] of Object.entries(scores)) {
        point[k] = v;
      }
    }
    return point;
  });

  // Radar data: first vs last — SOLO entre informes con dimensiones reales (no mezclar
  // con la constante fabricada). Con <2 reales, anyRealDimensions es false y no se pinta.
  const firstReport = realDimReports[0]?.report as VideoIntelligenceOutput | undefined;
  const lastReport = realDimReports[realDimReports.length - 1]?.report as VideoIntelligenceOutput | undefined;
  const firstScores = firstReport ? getScores(firstReport) : null;
  const lastScores = lastReport ? getScores(lastReport) : null;

  // Overall trend
  const firstAvg = getAvg(firstScores);
  const lastAvg = getAvg(lastScores);
  const trendDelta = lastAvg - firstAvg;

  // Textual evolution data
  const nivelTimeline = sorted.flatMap((a) => {
    const r = a.report as VideoIntelligenceOutput;
    const nivel = r.estadoActual?.nivelActual;
    if (!nivel) return []; // sin nivel del agente no se inventa «Medio» (inv #2)
    return [{
      label: LEVEL_LABELS[nivel] ?? nivel,
      date: new Date(a.created_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      color: LEVEL_COLORS[nivel] ?? "#3B82F6",
    }];
  });

  const clonTimeline = sorted
    .filter((a) => (a.report as VideoIntelligenceOutput).jugadorReferencia?.bestMatch)
    .map((a) => {
      const r = a.report as VideoIntelligenceOutput;
      const clon = r.jugadorReferencia!.bestMatch!;
      return {
        label: `${clon.nombre} (${clon.score}%)`,
        date: new Date(a.created_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
        color: "#3B82F6",
      };
    });

  const arquetipoTimeline = sorted
    .filter((a) => (a.report as VideoIntelligenceOutput).adnFutbolistico?.arquetipoTactico)
    .map((a) => {
      const r = a.report as VideoIntelligenceOutput;
      return {
        label: r.adnFutbolistico!.arquetipoTactico!,
        date: new Date(a.created_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
        color: "#8B5CF6",
      };
    });

  // Proyección de carrera / competitiva (BLOQUEADAS, P1 bloque 7, D2): solo se mira si
  // algún informe antiguo la traía, para decir por qué no se muestra.
  const hadProjection = sorted.some((a) => {
    const r = a.report as VideoIntelligenceOutput;
    return !!(r.proyeccionCarrera || r.proyeccionCompetitiva);
  });

  // Deduplicate consecutive identical labels for cleaner timelines
  function dedup(items: { label: string; date: string; color: string }[]) {
    return items.filter((item, i) => i === 0 || item.label !== items[i - 1].label);
  }

  // Radar stats mapped to short labels for the RadarChart component
  const radarLast = lastScores
    ? Object.fromEntries(DIM_KEYS.map((k) => [DIM_SHORT[k], lastScores[k] ?? 0]))
    : null;
  const radarFirst = firstScores
    ? Object.fromEntries(DIM_KEYS.map((k) => [DIM_SHORT[k], firstScores[k] ?? 0]))
    : null;

  return (
    <div className="min-h-screen bg-background pb-28">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">{player.name}</h1>
            <p className="text-[10px] text-muted-foreground">{t("playerEvolutionPage.evolution")}</p>
          </div>
          <TrendingUp size={18} className="text-primary" />
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-lg lg:max-w-5xl mx-auto">

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}

        {/* Error state — distinto del vacío: la carga de reportes falló (#24) */}
        {!isLoading && isError && (
          <ErrorState onRetry={() => refetch()} />
        )}

        {/* Curva longitudinal desde snapshots (Sprint 5.4) — independiente de reportes */}
        {id && <SnapshotHistoryChart playerId={id} />}

        {/* Not enough data · empty state mejorado */}
        {!isLoading && !isError && total < 2 && (
          <EmptyState
            Icon={TrendingUp}
            title={total === 0 ? t("playerEvolutionPage.emptyNoReportsTitle") : t("playerEvolutionPage.emptyOneReportTitle")}
            description={
              total === 0
                ? t("playerEvolutionPage.emptyNoReportsDescription")
                : t("playerEvolutionPage.emptyOneReportDescription")
            }
            primary={{
              label: total === 0 ? t("playerEvolutionPage.generateFirstReport") : t("playerEvolutionPage.generateAnotherReport"),
              Icon: Zap,
              onClick: () => navigate(`/players/${id}/reports`),
            }}
            secondary={{
              label: "Match-day Live",
              onClick: () => navigate("/live"),
            }}
            hint={t("playerEvolutionPage.emptyHint")}
          />
        )}

        {total >= 2 && (
          <>
            {/* Summary · #dimensiones fabricadas: sus medias (firstAvg/lastAvg/
                trendDelta) derivan de los `score` por dimensión fabricados →
                gateado hasta que haya dimensiones reales medidas */}
            {anyRealDimensions && (
            <div className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">{t("playerEvolutionPage.evolutionSummary")}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("playerEvolutionPage.reportsCount", { count: total })} · {new Date(sorted[0].created_at).toLocaleDateString("es-ES", { month: "short", year: "numeric" })}
                    {" → "}
                    {new Date(sorted[total - 1].created_at).toLocaleDateString("es-ES", { month: "short", year: "numeric" })}
                  </p>
                </div>
                <Badge className={`text-xs font-bold ${trendDelta >= 0 ? "bg-green-500/20 text-green-400 border-green-500" : "bg-red-500/20 text-red-400 border-red-500"}`}>
                  {trendDelta >= 0 ? <ArrowUpRight size={12} className="mr-1" /> : <ArrowDownRight size={12} className="mr-1" />}
                  {trendDelta >= 0 ? "+" : ""}{trendDelta.toFixed(1)} {trendDelta >= 0 ? t("playerEvolutionPage.progress") : t("playerEvolutionPage.regression")}
                </Badge>
              </div>
              <div className="flex items-center gap-4 text-center">
                <div className="flex-1 rounded-xl bg-secondary/50 p-2">
                  <p className="text-lg font-display font-bold text-foreground">{firstAvg.toFixed(1)}</p>
                  <p className="text-[8px] text-muted-foreground uppercase">{t("playerEvolutionPage.firstReport")}</p>
                </div>
                <div className="flex items-center">
                  {trendDelta >= 0
                    ? <ArrowUpRight size={20} className="text-green-400" />
                    : trendDelta < -0.1
                    ? <ArrowDownRight size={20} className="text-red-400" />
                    : <Minus size={20} className="text-muted-foreground" />
                  }
                </div>
                <div className="flex-1 rounded-xl bg-primary/10 border border-primary/30 p-2">
                  <p className="text-lg font-display font-bold text-foreground">{lastAvg.toFixed(1)}</p>
                  <p className="text-[8px] text-primary uppercase">{t("playerEvolutionPage.lastReport")}</p>
                </div>
              </div>
            </div>
            )}

            {/* Main chart · #dimensiones fabricadas: `promedio` = media de los
                `score` por dimensión fabricados → gateado */}
            {anyRealDimensions && <EvolutionLineChart data={chartData} />}

            {/* Radar overlay: first vs last · #dimensiones fabricadas: radarLast/
                radarFirst derivan de los `score` por dimensión → gateado */}
            {anyRealDimensions && radarLast && radarFirst && (
              <div className="glass rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Target size={14} className="text-primary" />
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    {t("playerEvolutionPage.comparativeRadar")}
                  </span>
                </div>
                <RadarChartComponent
                  stats={radarLast}
                  compareStats={radarFirst}
                  currentLabel={t("playerEvolutionPage.last")}
                  compareLabel={t("playerEvolutionPage.first")}
                />
              </div>
            )}

            {/* Per-dimension mini charts · #dimensiones fabricadas: cada
                DimensionMiniChart lee el `score` fabricado por dimensión → todo
                el bloque se oculta hasta que haya dimensiones reales medidas */}
            {anyRealDimensions && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Activity size={14} className="text-primary" />
                <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {t("playerEvolutionPage.evolutionByDimension")}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {DIM_KEYS.map((key) => (
                  <DimensionMiniChart key={key} dimKey={key} data={chartData} />
                ))}
              </div>
            </div>
            )}

            {/* Textual evolution */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Brain size={14} className="text-primary" />
                <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {t("playerEvolutionPage.evolutionBySection")}
                </span>
              </div>

              <TextualEvolutionSection title={t("playerEvolutionPage.currentLevel")} icon={TrendingUp}>
                <TimelineBadges items={dedup(nivelTimeline)} />
              </TextualEvolutionSection>

              {dedup(arquetipoTimeline).length >= 1 && (
                <TextualEvolutionSection title={t("playerEvolutionPage.footballDna")} icon={Brain}>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{t("playerEvolutionPage.tacticalArchetype")}</p>
                  <TimelineBadges items={dedup(arquetipoTimeline)} />
                </TextualEvolutionSection>
              )}

              {dedup(clonTimeline).length >= 1 && (
                <TextualEvolutionSection title={t("playerEvolutionPage.referencePlayer")} icon={Star}>
                  <TimelineBadges items={dedup(clonTimeline)} />
                </TextualEvolutionSection>
              )}

              {/* Proyección de carrera / competitiva de informes antiguos: BLOQUEADAS (P1
                  bloque 7, D2). Si alguno la traía, se dice por qué no se muestra. */}
              {hadProjection && (
                <TextualEvolutionSection title={t("playerEvolutionPage.careerProjection")} icon={TrendingUp}>
                  <p className="text-[11px] text-muted-foreground">{t("careerProjection.blocked")}</p>
                </TextualEvolutionSection>
              )}
            </div>

            {/* Recurring patterns */}
            <RecurringPatterns analyses={sorted} />

            {/* Footer */}
            <div className="glass rounded-xl p-3 flex items-center justify-between">
              <button
                onClick={() => navigate(`/players/${id}/reports`)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("playerEvolutionPage.viewAllReports")}
              </button>
              <button
                onClick={() => navigate(`/players/${id}/intelligence`)}
                className="flex items-center gap-1 text-[10px] font-bold text-primary"
              >
                <Zap size={10} /> {t("playerEvolutionPage.newAnalysis")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
