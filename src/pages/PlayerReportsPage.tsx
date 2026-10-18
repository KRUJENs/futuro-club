/**
 * VITAS · Player Reports Page
 * /players/:id/reports
 *
 * Historial completo de todos los reportes de inteligencia
 * guardados para un jugador, ordenados cronológicamente.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, Brain, Star, TrendingUp, ChevronRight,
  Loader2, FileText, Calendar, Video, Zap, Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";
import { getAuthHeaders } from "@/lib/apiAuth";

import { PlayerService } from "@/services/real/playerService";
import { VideoService } from "@/services/real/videoService";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import ErrorState from "@/components/ErrorState";
import type { VideoIntelligenceOutput } from "@/agents/contracts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const LEVEL_LABELS: Record<string, string> = {
  elite: "Elite", alto: "Alto", medio_alto: "Medio-Alto",
  medio: "Medio", desarrollo: "En Desarrollo",
};
const LEVEL_COLORS: Record<string, string> = {
  elite: "#FFD700", alto: "#22C55E", medio_alto: "#3B82F6",
  medio: "#F59E0B", desarrollo: "#8B5CF6",
};

function MiniScoreRing({ score, label }: { score: number; label: string }) {
  const r = 14, circ = 2 * Math.PI * r, dash = (score / 10) * circ;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(var(--secondary))" strokeWidth="3" />
        <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" transform="rotate(-90 18 18)" />
        <text x="18" y="21" textAnchor="middle" fontSize="9" fontWeight="bold" fill="currentColor" className="text-foreground">
          {score.toFixed(1)}
        </text>
      </svg>
      <span className="text-[7px] text-muted-foreground leading-tight text-center max-w-[36px]">{label}</span>
    </div>
  );
}

const DIM_LABELS: Record<string, string> = {
  velocidadDecision: "V.Dec",
  tecnicaConBalon: "Téc",
  inteligenciaTactica: "Tác",
  capacidadFisica: "Fís",
  liderazgoPresencia: "Lid",
  eficaciaCompetitiva: "Efic",
};

// ─── Report Card ─────────────────────────────────────────────────────────────

function ReportCard({
  analysis,
  index,
  total,
  onView,
  onEvolution,
}: {
  analysis: { id: string; created_at: string; report: unknown; video_id?: string };
  index: number;
  total: number;
  onView: () => void;
  onEvolution: () => void;
}) {
  const { t } = useTranslation();
  const report = analysis.report as VideoIntelligenceOutput | null;
  if (!report) return null;

  const estado = report.estadoActual;
  const dims = estado?.dimensiones;
  // #dimensiones fabricadas: el score por dimensión es una CONSTANTE rotulada
  // "Estimado por IA" (el pipeline de vídeo NO puntúa por dimensión). No se pinta
  // hasta que estadoActual.dimensionesMedidas === true (inv #1/#2: cero números
  // fabricados). Acceso cast-safe y null-safe sin tocar el tipo del informe.
  const dimensionesMedidas =
    ((report.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true);
  const clon = report.jugadorReferencia?.bestMatch;
  const confianza = report.confianza ?? null; // null ⇒ sin confianza medible → no pintar "0%" (inv #2)
  const nivel = estado?.nivelActual ?? null; // null ⇒ el agente no dio nivel: no se pinta «Medio» (inv #2)

  const date = new Date(analysis.created_at);
  const dateStr = date.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
  const timeStr = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

  const videoTitle = report.videoId
    ? VideoService.getById(report.videoId)?.title ?? t("playerReportsPage.video")
    : t("playerReportsPage.noVideo");

  const isLatest = index === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      className="glass rounded-2xl p-4 space-y-3"
    >
      {/* Header: date + video + level */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Calendar size={12} className="text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">{dateStr}, {timeStr}</span>
            {isLatest && (
              <Badge className="text-[8px] bg-primary/20 text-primary border-primary/30">
                {t("playerReportsPage.latest")}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Video size={11} className="text-primary/60" />
            <span className="text-[10px] text-foreground font-medium truncate max-w-[200px]">{videoTitle}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {nivel && (
            <Badge
              className="text-[9px] font-bold"
              style={{
                backgroundColor: `${LEVEL_COLORS[nivel]}20`,
                color: LEVEL_COLORS[nivel],
                borderColor: LEVEL_COLORS[nivel],
              }}
            >
              {LEVEL_LABELS[nivel]}
            </Badge>
          )}
          {confianza != null && (
            <span className="text-[9px] text-muted-foreground">
              {Math.round(confianza * 100)}%
            </span>
          )}
        </div>
      </div>

      {/* Executive summary */}
      {estado?.resumenEjecutivo && (
        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
          {estado.resumenEjecutivo}
        </p>
      )}

      {/* 6 dimension mini scores — #dimensiones fabricadas: solo se pintan los
          anillos cuando el informe declara dimensionesMedidas === true. Sin el flag
          los score son constantes ⇒ ocultar (no anillos), nunca un 0 fabricado. */}
      {dims && dimensionesMedidas && (
        <div className="flex items-center justify-between px-1">
          {Object.entries(DIM_LABELS).map(([key, label]) => {
            const score = (dims as Record<string, { score: number }>)[key]?.score ?? 0;
            return <MiniScoreRing key={key} score={score} label={label} />;
          })}
        </div>
      )}

      {/* Clone + actions */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1.5">
          {clon && (
            <>
              <Star size={10} className="text-gold" />
              <span className="text-[10px] text-muted-foreground">
                {t("playerReportsPage.clone")} <span className="text-foreground font-medium">{clon.nombre}</span>
                {" "}({clon.score}%)
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEvolution}
            className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
          >
            <TrendingUp size={10} />
            {t("playerReportsPage.evolution")}
          </button>
          <button
            onClick={onView}
            className="flex items-center gap-1 text-[10px] font-bold text-primary hover:text-primary/80 transition-colors"
          >
            {t("playerReportsPage.viewFull")}
            <ChevronRight size={10} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PlayerReportsPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const player = id ? PlayerService.getById(id) : null;
  const { data: analyses, isLoading, isError, refetch } = useSavedAnalysesV2(id ?? "");
  const [generating, setGenerating] = useState(false);

  async function handleGenerateBaseline() {
    if (!id || generating) return;
    setGenerating(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/players/baseline-analysis", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: id, locale: normalizeLocale(i18n.language) }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error?.message ?? t("playerReportsPage.baselineError"));
      }
      toast.success(t("playerReportsPage.reportsGenerated", { count: data.data.reportsGenerated, total: data.data.reportsTotal ?? data.data.reportsGenerated, vsi: data.data.vsi }));
      await queryClient.invalidateQueries({ queryKey: ["analyses-v2", id] });
      navigate(`/player/${id}/analysis/${data.data.analysisId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("playerReportsPage.generateError"));
    } finally {
      setGenerating(false);
    }
  }

  if (!player) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <Brain size={32} className="text-destructive" />
        <p className="text-sm text-muted-foreground">{t("playerReportsPage.playerNotFound")}</p>
      </div>
    );
  }

  // Solo filas con reporte generado: evita contar/renderizar/calcular tendencia
  // sobre report null (getAvg(null) reventaba toda la página → pantalla en blanco)
  // y corrige el contador que mostraba más reportes que tarjetas visibles.
  const rows = (analyses ?? []).filter(
    (a) => (a as { report: unknown }).report != null,
  ) as { id: string; created_at: string; report: unknown; video_id?: string }[];

  // Summary stats
  const total = rows.length;
  const firstDate = total > 0
    ? new Date(rows[rows.length - 1].created_at).toLocaleDateString("es-ES", { month: "short", year: "numeric" })
    : "";
  const lastDate = total > 0
    ? new Date(rows[0].created_at).toLocaleDateString("es-ES", { month: "short", year: "numeric" })
    : "";

  // Trend calculation — #dimensiones fabricadas: la media por dimensión solo tiene
  // sentido sobre score REALES. Se gatea POR-INFORME: sin dimensionesMedidas === true
  // los score son constantes ⇒ getAvg abstiene (null) y NO entran en el delta.
  // trendDelta es null cuando falta la media real de cualquiera de los dos informes
  // ⇒ no se pinta un "+0.0" fabricado (inv #2).
  let trendDelta: number | null = null;
  if (total >= 2) {
    const getAvg = (report: VideoIntelligenceOutput | null | undefined): number | null => {
      const medidas =
        ((report?.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true);
      const dims = report?.estadoActual?.dimensiones;
      if (!medidas || !dims) return null; // score fabricado o ausente → no promediar
      const scores = Object.values(dims).map((d: { score: number }) => d?.score ?? 0);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };
    const latest = rows[0].report as VideoIntelligenceOutput;
    const oldest = rows[rows.length - 1].report as VideoIntelligenceOutput;
    const avgLatest = getAvg(latest);
    const avgOldest = getAvg(oldest);
    if (avgLatest != null && avgOldest != null) {
      trendDelta = avgLatest - avgOldest;
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
              {player.name}
            </h1>
            <p className="text-[10px] text-muted-foreground">{t("playerReportsPage.reportHistory")}</p>
          </div>
          <FileText size={18} className="text-primary" />
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-lg lg:max-w-5xl mx-auto">
        {/* Summary bar */}
        {total > 0 && (
          <div className="glass rounded-xl p-3 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-center">
                <p className="text-lg font-display font-bold text-foreground">{total}</p>
                <p className="text-[8px] text-muted-foreground uppercase tracking-wider">{t("playerReportsPage.reports")}</p>
              </div>
              {total >= 2 && (
                <div className="text-[10px] text-muted-foreground">
                  {firstDate} → {lastDate}
                </div>
              )}
            </div>
            {/* Delta de tendencia solo si hay media real de ambos informes
                (#dimensiones fabricadas): trendDelta === null ⇒ ocultar, no "+0.0". */}
            {total >= 2 && trendDelta != null && (
              <div className={`flex items-center gap-1 text-xs font-bold ${trendDelta >= 0 ? "text-green-400" : "text-red-400"}`}>
                <TrendingUp size={12} className={trendDelta < 0 ? "rotate-180" : ""} />
                {trendDelta >= 0 ? "+" : ""}{trendDelta.toFixed(1)}
              </div>
            )}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}

        {/* Error state — distinto del vacío: la carga falló (#24) */}
        {!isLoading && isError && (
          <ErrorState onRetry={() => refetch()} />
        )}

        {/* Empty state */}
        {!isLoading && !isError && total === 0 && (
          <div className="glass rounded-2xl p-6 text-center space-y-4">
            <Brain size={32} className="mx-auto text-primary/50" />
            <div className="space-y-1">
              <h3 className="text-sm font-display font-bold text-foreground">{t("playerReportsPage.noReportsYet")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("playerReportsPage.noReportsDesc")}
              </p>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => navigate(`/lab?playerId=${id}`)}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-display font-bold hover:bg-primary/90 transition-colors"
              >
                <Video size={12} /> {t("playerReportsPage.uploadVideoLab")}
              </button>
              <button
                onClick={() => navigate("/live")}
                className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-secondary/30 text-foreground border border-border text-xs font-display hover:border-foreground/30 transition-colors"
              >
                <Zap size={12} /> {t("playerReportsPage.matchdayLive")}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed pt-1">
              {t("playerReportsPage.videoBasedNote")}
            </p>
          </div>
        )}

        {/* New report button (when reports already exist) */}
        {!isLoading && total > 0 && (
          <button
            onClick={() => navigate(`/lab?playerId=${id}`)}
            className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-secondary/30 text-foreground border border-dashed border-border text-[11px] font-display hover:border-primary/50 transition-colors"
          >
            <Video size={12} /> {t("playerReportsPage.newReport")}
          </button>
        )}

        {/* Report cards */}
        {rows.map((a, idx) => (
          <ReportCard
            key={a.id ?? idx}
            analysis={a as { id: string; created_at: string; report: unknown; video_id?: string }}
            index={idx}
            total={total}
            onView={() => navigate(`/player/${id}/analysis/${a.id}`)}
            onEvolution={() => navigate(`/players/${id}/evolution`)}
          />
        ))}

        {/* Evolution button */}
        {total >= 2 && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            onClick={() => navigate(`/players/${id}/evolution`)}
            className="w-full glass rounded-xl p-4 flex items-center justify-center gap-2 border border-primary/30 hover:border-primary/50 transition-colors"
          >
            <TrendingUp size={16} className="text-primary" />
            <span className="text-sm font-display font-bold text-primary">{t("playerReportsPage.viewFullEvolution")}</span>
          </motion.button>
        )}
      </div>
    </div>
  );
}
