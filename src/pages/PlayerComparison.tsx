import { useState, useMemo, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Download, Share2, TrendingUp, Zap, Target, Brain, Users, Star, FileText,
} from "lucide-react";
import { useAllPlayers } from "@/hooks/usePlayers";
import { useQuery } from "@tanstack/react-query";
import { PlayerService } from "@/services/real/playerService";
import { findSimilarPlayers, scoreToBadge, type SimilarityResult } from "@/services/real/similarityService";
import { calculateAdvancedMetrics, VAEPService } from "@/services/real/advancedMetricsService";
import { useMatchEvents } from "@/hooks/useMatchEvents";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import RadarChartComponent from "@/components/RadarChart";
import VsiGauge from "@/components/VsiGauge";

import VitasCard from "@/components/VitasCard";
import { PlayerListSkeleton } from "@/components/shared/Skeletons";
import DemoDataBanner from "@/components/DemoDataBanner";
import { phvGate } from "@/lib/phv/phvGate";
import { usePhvGateText } from "@/components/phv/PhvGateNotice";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ResponsiveContainer,
  RadarChart as ReRadar,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Legend,
} from "recharts";

const labelMap: Record<string, string> = {
  speed: "PACE",
  technique: "TÉC",
  vision: "VIS",
  stamina: "PHY",
  shooting: "DRI",
  defending: "DEF",
};

// ─── Animaciones ──────────────────────────────────────────────────────────────
const container = { hidden: {}, show: { transition: { staggerChildren: 0.07 } } };
const item = { hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0, transition: { duration: 0.45 } } };

// ─── Vacío · usa EmptyState global ───────────────────────────────────────────
import EmptyStateComponent from "@/components/EmptyState";
import { Plus, BarChart3 } from "lucide-react";

function EmptyState({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const { t } = useTranslation();
  return (
    <div className="px-4 pt-8 max-w-md mx-auto">
      <EmptyStateComponent
        Icon={Users}
        size="lg"
        title={t("compare.needMinPlayers")}
        description={t("compare.needMinDesc")}
        primary={{
          label: t("playerComparison.addPlayer"),
          Icon: Plus,
          onClick: () => navigate("/players/new"),
        }}
        secondary={{
          label: t("playerComparison.goToRankings"),
          Icon: BarChart3,
          onClick: () => navigate("/rankings"),
        }}
        hint={t("playerComparison.needMinHint")}
      />
    </div>
  );
}

// ─── Mini Clone Card ──────────────────────────────────────────────────────────
function CloneCard({ similarity, playerName }: { similarity: SimilarityResult | undefined; playerName: string }) {
  const { t } = useTranslation();
  if (!similarity?.bestMatch) {
    return (
      <div className="glass rounded-xl p-3 text-center">
        <Star size={14} className="mx-auto mb-1 text-muted-foreground" />
        <p className="text-[10px] text-muted-foreground">{t("compare.calculatingClone")}</p>
      </div>
    );
  }
  const { player, score } = similarity.bestMatch;
  const { color, label } = scoreToBadge(score);

  return (
    <div className="glass rounded-xl p-3 border border-primary/10">
      <div className="flex items-center gap-1.5 mb-2">
        <Star size={10} className="text-gold" />
        <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
          {t("compare.cloneOf", { name: playerName.split(" ")[0] })}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-foreground">{player.short_name}</p>
          <p className="text-[9px] text-muted-foreground">{player.position} · {player.club}</p>
        </div>
        <div className="text-right">
          <div className="text-lg font-black" style={{ color }}>{score.toFixed(0)}%</div>
          <span className="text-[8px] font-bold" style={{ color }}>{label}</span>
        </div>
      </div>
      {/* Top 3 métricas del pro */}
      <div className="mt-2 grid grid-cols-3 gap-1">
        {[
          { k: "pace", l: t("playerComparison.pace"), v: player.pace },
          { k: "shooting", l: t("playerComparison.shooting"), v: player.shooting },
          { k: "dribbling", l: t("playerComparison.technique"), v: player.dribbling },
        ].map(m => (
          <div key={m.k} className="text-center">
            <div className="text-[9px] font-bold text-foreground">{m.v}</div>
            <div className="text-[8px] text-muted-foreground">{m.l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
const PlayerComparison = () => {
  const { t } = useTranslation();
  const phvGateText = usePhvGateText();
  const navigate = useNavigate();
  const [playerAIndex, setPlayerAIndex] = useState(0);
  const [playerBIndex, setPlayerBIndex] = useState(1);
  const [cardPlayer, setCardPlayer] = useState<"A" | "B" | null>(null);

  const { data: allPlayers, isLoading } = useAllPlayers();
  // Comparar exige jugadores EVALUADOS: sin stats/VSI reales no se compara ni se
  // fabrica una "probabilidad de élite" a partir de null (invariante #2). Los no
  // evaluados se excluyen del comparador → si quedan <2, cae al EmptyState.
  const players = (allPlayers ?? []).filter((p) => p.stats != null && p.vsi != null);
  // Honestidad: el comparador deriva una "probabilidad de élite" de datos de
  // ejemplo en el demo → banner visible (invariante MOCK), como en Rankings.
  // Se lee de los jugadores CRUDOS: el adaptador de UI no conserva `isDemo`.
  const isDemoData = PlayerService.getAll().some((p) => p.isDemo);

  const safeAIdx = Math.min(playerAIndex, Math.max(0, players.length - 1));
  const safeBIdx = Math.min(playerBIndex, Math.max(0, players.length - 1));

  // Similarity para ambos jugadores
  const rawA = PlayerService.getById(players[safeAIdx]?.id ?? "");
  const rawB = PlayerService.getById(players[safeBIdx]?.id ?? "");

  const { data: simA } = useQuery({
    queryKey: ["similarity-compare", rawA?.id],
    queryFn:  () => rawA ? findSimilarPlayers(rawA.metrics, rawA.position, { youthAge: rawA.age }) : null,
    enabled:  !!rawA,
    staleTime: 1000 * 60 * 10,
  });

  const { data: simB } = useQuery({
    queryKey: ["similarity-compare", rawB?.id],
    queryFn:  () => rawB ? findSimilarPlayers(rawB.metrics, rawB.position, { youthAge: rawB.age }) : null,
    enabled:  !!rawB,
    staleTime: 1000 * 60 * 10,
  });

  // VAEP real desde eventos logueados
  const { data: eventsA = [] } = useMatchEvents(rawA?.id);
  const { data: eventsB = [] } = useMatchEvents(rawB?.id);

  // Métricas avanzadas reales
  const advA = useMemo(() => rawA ? calculateAdvancedMetrics(rawA) : null, [rawA]);
  const advB = useMemo(() => rawB ? calculateAdvancedMetrics(rawB) : null, [rawB]);

  const vaepA = useMemo(
    () => VAEPService.calculateFromEvents(eventsA, rawA?.minutesPlayed ?? 0),
    [eventsA, rawA]
  );
  const vaepB = useMemo(
    () => VAEPService.calculateFromEvents(eventsB, rawB?.minutesPlayed ?? 0),
    [eventsB, rawB]
  );

  // Informe de IA guardado de cada jugador → para exportar el informe REAL del
  // ganador (no un pantallazo). En demo hay informe de ejemplo por jugador; en
  // prod queda vacío si el jugador no tiene análisis generado (avisamos al exportar).
  const { data: analysesA } = useSavedAnalysesV2(rawA?.id ?? "");
  const { data: analysesB } = useSavedAnalysesV2(rawB?.id ?? "");

  if (isLoading) {
    return (
      <div className="min-h-screen pb-24">
        
        <div className="max-w-5xl mx-auto px-4 pt-8">
          <PlayerListSkeleton count={3} />
        </div>
      </div>
    );
  }

  if (players.length < 2) {
    return (
      <div className="min-h-screen pb-24">
        
        <EmptyState navigate={navigate} />
      </div>
    );
  }

  const safeAIndex = safeAIdx;
  const safeBIndex = safeBIdx;

  const playerA = players[safeAIndex];
  const playerB = players[safeBIndex];

  // Radar superpuesto
  const radarData = Object.entries(playerA.stats).map(([key, value]) => ({
    stat: labelMap[key] || key,
    playerA: value,
    playerB: (playerB.stats as Record<string, number>)[key] ?? 0,
    fullMark: 100,
  }));

  // Maduración SOLO desde el gate único (regla del owner 28-sep) y por TIMING vs
  // pares del motor canónico — nunca desde el phvCategory persistido. Antes el
  // enum POR ESTADO se traducía a timing ("early" = pre-PHV ⇒ «TARDÍO»), así que a
  // cualquier pre-púber sin medidas se le llamaba madurador tardío. Sin gate
  // abierto la etiqueta nombra qué falta; con timing no firme, «sin determinar».
  const gateA = phvGate(rawA ?? {});
  const gateB = phvGate(rawB ?? {});
  const phvTag = (g: typeof gateA) =>
    !g.ok ? phvGateText({ gate: g })
    : g.assessment.timing === "late" ? t("compare.phvLate")
    : g.assessment.timing === "early" ? t("compare.phvEarly")
    : g.assessment.timing === "on_time" ? t("compare.phvNormal")
    : t("maturity.timing.unknown");

  const phvTagA = phvTag(gateA);
  const phvTagB = phvTag(gateB);

  // Métricas de comparación: SOLO cifras reales (P1 bloque 5b). Antes, sin dato, se
  // fabricaban desde las barras del entrenador: VAEP = f(técnica, visión), «sprints
  // >25 km/h» = velocidad × 0,26 + 1 y UBI = VSI × 0,85. Sin dato ⇒ null + su motivo.
  const metrics: Array<{
    id: string;
    name: string;
    description: string;
    icon: ReactNode;
    getValueA: () => number | null;
    getValueB: () => number | null;
    noData: string;
    format?: (v: number) => string;
  }> = [
    {
      id: "vaep",
      name: t("compare.vaepPer90"),
      description: eventsA.length > 0 || eventsB.length > 0
        ? t("compare.vaepRealDesc")
        : t("compare.vaepRegisterDesc"),
      icon: <TrendingUp size={18} className="text-primary" />,
      getValueA: () => vaepA.vaep90,
      getValueB: () => vaepB.vaep90,
      noData: t("compare.vaepRegisterDesc"),
      format: (v: number) => v.toFixed(3),
    },
    {
      id: "sprints",
      name: t("compare.sprintCount"),
      description: t("compare.sprintDesc"),
      icon: <Zap size={18} className="text-gold" />,
      // No hay ninguna fuente real de sprints >25 km/h por jugador en esta pantalla.
      getValueA: () => null,
      getValueB: () => null,
      noData: t("compare.sprintNoData"),
      format: (v: number) => v.toFixed(1),
    },
    {
      id: "ubi",
      name: t("compare.ubiIndex"),
      description: t("compare.ubiDesc"),
      icon: <Target size={18} className="text-electric" />,
      // Sin bonus PHV fijo (+5 / −3 por el phvCategory persistido): era un ajuste
      // de maduración paralelo al motor canónico (inv #7) y se aplicaba sin
      // medidas. La corrección por maduración vive SOLO en el factor gateado.
      getValueA: () => (advA?.ubi ? Math.round(advA.ubi.ubi * 100) : null),
      getValueB: () => (advB?.ubi ? Math.round(advB.ubi.ubi * 100) : null),
      noData: t("compare.ubiNoData"),
    },
  ];

  const getMetricLabel = (val: number, isWinner: boolean, metricId: string) => {
    if (metricId === "ubi") {
      if (val > 80) return t("compare.realTalent");
      if (val > 65) return t("compare.medBias");
      return t("compare.highBias");
    }
    return isWinner ? t("compare.superior") : t("compare.below");
  };

  // «Ganador» = el de evaluación del entrenador más alta, y SOLO si ambos están
  // evaluados (P1 bloque 5b). Antes: «el modelo proyecta un X% de llegar a élite en 36
  // meses» con X = VSI × 0,95, y «mayor techo de desarrollo» por tener más VSI.
  const bothEvaluated = typeof playerA.vsi === "number" && typeof playerB.vsi === "number";
  // Empate: no hay «evaluación más alta» (antes `>=` daba la victoria a A).
  const sameEvaluation = bothEvaluated && playerA.vsi === playerB.vsi;
  const aiWinner = playerA.vsi >= playerB.vsi ? playerA : playerB;
  const winnerGate = aiWinner === playerA ? gateA : gateB;

  // Informe REAL del ganador (el más reciente). Si no tiene análisis generado, la
  // exportación avisa y lleva a generarlo — nunca un informe fabricado (invariante #2).
  // useSavedAnalysesV2 devuelve filas envoltorio { id, …, report }; el informe real
  // (AnalysisReport | null) está en .report. Si es null, el guard de abajo avisa.
  const winnerReport = (playerA.vsi >= playerB.vsi ? analysesA : analysesB)?.[0]?.report ?? null;
  const openWinnerReport = (mode: "executive" | "technical") => {
    if (!winnerReport) {
      toast.error(t("playerComparison.winnerNoReport"));
      navigate(`/player/${aiWinner.id}/intelligence`);
      return;
    }
    try {
      sessionStorage.setItem(
        `vitas-analysis-report-${aiWinner.id}`,
        JSON.stringify({
          report: winnerReport,
          playerName: aiWinner.name ?? "",
          playerPosition: aiWinner.position ?? "",
        }),
      );
    } catch {
      // sessionStorage lleno/bloqueado: la pestaña caerá a "no encontrado"
    }
    const url = `/analysis-report/${aiWinner.id}?mode=${mode}`;
    const win = window.open(url, "_blank");
    if (!win) window.location.href = url;
  };

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="min-h-screen pb-24">
      

      {/* Header */}
      <motion.div variants={item} className="px-4 pt-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2 transition-colors"
            >
              <ArrowLeft size={14} /> {t("common.back")}
            </button>
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-primary">
              {t("playerComparison.predictiveAnalysis")}
            </span>
            <h1 className="font-display font-bold text-3xl text-foreground italic">
              Scout Comparison Tool
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => openWinnerReport("executive")}
              title={t("playerComparison.exportWinnerHint")}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm font-display font-medium text-foreground hover:bg-secondary transition-colors"
            >
              <FileText size={16} />
              {t("analysisReportPrint.typeExecutive")}
            </button>
            <button
              onClick={() => openWinnerReport("technical")}
              title={t("playerComparison.exportWinnerHint")}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm font-display font-medium text-foreground hover:bg-secondary transition-colors"
            >
              <Download size={16} />
              {t("analysisReportPrint.typeTechnical")}
            </button>
            <button
              onClick={() => {
                const url = `${window.location.origin}/compare`;
                if (navigator.share) {
                  navigator.share({ title: "VITAS Comparison", url }).catch(() => null);
                } else {
                  navigator.clipboard.writeText(url);
                  toast.success(t("playerComparison.linkCopied"));
                }
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-display font-semibold hover:bg-primary/90 transition-colors"
            >
              <Share2 size={16} />
              {t("playerComparison.share")}
            </button>
          </div>
        </div>
      </motion.div>

      <div className="max-w-5xl mx-auto px-4 pt-6 space-y-6">
        {isDemoData && <DemoDataBanner messageKey="rankingsPage.demoNotice" />}
        {/* Selectores + Radar superpuesto */}
        <motion.div variants={item} className="glass rounded-2xl p-6">
          <div className="grid grid-cols-[1fr_2fr_1fr] gap-4 items-center">
            {/* Jugador A */}
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-24 h-24 rounded-xl bg-secondary border border-border flex items-center justify-center">
                <span className="text-3xl font-display font-bold text-muted-foreground">
                  {playerA.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </span>
              </div>
              <VsiGauge value={playerA.vsi} size="sm" />
              <div>
                <h3 className="font-display font-bold text-lg text-foreground">{playerA.name}</h3>
                <p className="text-xs text-primary font-display font-semibold">
                  {playerA.positionShort} · {playerA.age}a · {playerA.academy}
                </p>
              </div>
              <div className="flex gap-2 flex-wrap justify-center">
                <span className="px-2 py-0.5 rounded text-[10px] font-display font-semibold uppercase tracking-wider border border-border text-foreground bg-secondary">
                  {phvTagA}
                </span>
              </div>
              <select
                value={safeAIndex}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (val === safeBIndex) return;
                  setPlayerAIndex(val);
                }}
                className="mt-2 bg-secondary border border-border rounded-lg px-3 py-1.5 text-xs font-display text-foreground w-full"
              >
                {players.map((p, i) => (
                  <option key={p.id} value={i} disabled={i === safeBIndex}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Radar superpuesto */}
            <div>
              <ResponsiveContainer width="100%" height={320}>
                <ReRadar data={radarData}>
                  <PolarGrid stroke="hsl(225, 18%, 22%)" />
                  <PolarAngleAxis
                    dataKey="stat"
                    tick={{ fill: "hsl(220, 12%, 55%)", fontSize: 12, fontFamily: "Rajdhani", fontWeight: 600 }}
                  />
                  <Radar
                    name={playerA.name.split(" ")[0]}
                    dataKey="playerA"
                    stroke="hsl(230, 70%, 58%)"
                    fill="hsl(230, 70%, 58%)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                  <Radar
                    name={playerB.name.split(" ")[0]}
                    dataKey="playerB"
                    stroke="hsl(270, 60%, 55%)"
                    fill="hsl(270, 60%, 55%)"
                    fillOpacity={0.12}
                    strokeWidth={2}
                  />
                  <Legend wrapperStyle={{ fontFamily: "Rajdhani", fontSize: 12, color: "hsl(220, 12%, 55%)" }} />
                </ReRadar>
              </ResponsiveContainer>
            </div>

            {/* Jugador B */}
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-24 h-24 rounded-xl bg-secondary border border-border flex items-center justify-center">
                <span className="text-3xl font-display font-bold text-muted-foreground">
                  {playerB.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </span>
              </div>
              <VsiGauge value={playerB.vsi} size="sm" />
              <div>
                <h3 className="font-display font-bold text-lg text-foreground">{playerB.name}</h3>
                <p className="text-xs text-primary font-display font-semibold">
                  {playerB.positionShort} · {playerB.age}a · {playerB.academy}
                </p>
              </div>
              <div className="flex gap-2 flex-wrap justify-center">
                <span className="px-2 py-0.5 rounded text-[10px] font-display font-semibold uppercase tracking-wider border border-border text-foreground bg-secondary">
                  {phvTagB}
                </span>
              </div>
              <select
                value={safeBIndex}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (val === safeAIndex) return;
                  setPlayerBIndex(val);
                }}
                className="mt-2 bg-secondary border border-border rounded-lg px-3 py-1.5 text-xs font-display text-foreground w-full"
              >
                {players.map((p, i) => (
                  <option key={p.id} value={i} disabled={i === safeAIndex}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </motion.div>

        {/* Tabla de métricas */}
        <motion.div variants={item} className="glass rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 px-6 py-3 border-b border-border">
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground">
              {t("playerComparison.metric")}
            </span>
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground text-center">
              {playerA.name.split(" ")[0]}
            </span>
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground text-center">
              Δ
            </span>
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground text-center">
              {playerB.name.split(" ")[0]}
            </span>
          </div>

          {metrics.map((metric) => {
            const valA = metric.getValueA();
            const valB = metric.getValueB();
            const fmt = metric.format || ((v: number) => String(v));
            // Sin dato en algún lado no hay comparación: se dice por qué (nunca un 0).
            if (valA === null || valB === null) {
              return (
                <div
                  key={metric.id}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 px-6 py-5 border-b border-border last:border-b-0 items-center"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center">
                      {metric.icon}
                    </div>
                    <div>
                      <h4 className="font-display font-bold text-sm text-foreground">{metric.name}</h4>
                      <p className="text-[10px] text-muted-foreground">{metric.description}</p>
                    </div>
                  </div>
                  <div className="text-center text-sm font-display font-bold text-foreground">
                    {valA !== null ? fmt(valA) : <span className="text-[10px] font-normal text-muted-foreground">{metric.noData}</span>}
                  </div>
                  <div />
                  <div className="text-center text-sm font-display font-bold text-foreground">
                    {valB !== null ? fmt(valB) : <span className="text-[10px] font-normal text-muted-foreground">{metric.noData}</span>}
                  </div>
                </div>
              );
            }
            const diff = +(valA - valB).toFixed(2);
            const aWins = valA >= valB;

            return (
              <div
                key={metric.id}
                className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 px-6 py-5 border-b border-border last:border-b-0 items-center"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center">
                    {metric.icon}
                  </div>
                  <div>
                    <h4 className="font-display font-bold text-sm text-foreground">{metric.name}</h4>
                    <p className="text-[10px] text-muted-foreground">{metric.description}</p>
                  </div>
                </div>

                {/* Valor A */}
                <div className="text-center">
                  <div className={`inline-block px-3 py-2 rounded-lg border ${aWins ? "border-primary/30 bg-primary/5" : "border-border bg-secondary"}`}>
                    <span className={`font-display font-bold text-2xl ${aWins ? "text-primary" : "text-foreground"}`}>
                      {fmt(valA)}
                    </span>
                  </div>
                  <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground mt-1">
                    {getMetricLabel(valA, aWins, metric.id)}
                  </p>
                </div>

                {/* Diferencial */}
                <div className="text-center">
                  <span className="text-sm font-display font-semibold text-primary">
                    {diff > 0 ? `+${Math.abs(diff)}` : diff < 0 ? `-${Math.abs(diff)}` : "0"}
                  </span>
                  <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden mx-4">
                    <motion.div
                      className="h-full rounded-full bg-electric"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, Math.abs(diff) * 20 + 30)}%` }}
                      transition={{ duration: 0.8, ease: "easeOut" }}
                    />
                  </div>
                </div>

                {/* Valor B */}
                <div className="text-center">
                  <div className={`inline-block px-3 py-2 rounded-lg border ${!aWins ? "border-electric/30 bg-electric/5" : "border-border bg-secondary"}`}>
                    <span className={`font-display font-bold text-2xl ${!aWins ? "text-electric" : "text-foreground"}`}>
                      {fmt(valB)}
                    </span>
                  </div>
                  <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground mt-1">
                    {getMetricLabel(valB, !aWins, metric.id)}
                  </p>
                </div>
              </div>
            );
          })}
        </motion.div>

        {/* Insight IA */}
        <motion.div variants={item} className="grid grid-cols-[3fr_2fr] gap-4">
          <div className="glass rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Brain size={18} className="text-primary" />
              </div>
              <h3 className="font-display font-bold text-lg text-foreground">{t("playerComparison.comparativeAnalysis")}</h3>
            </div>
            {sameEvaluation ? (
              <p className="text-sm text-muted-foreground leading-relaxed">{t("playerComparison.sameCoachEval", { a: playerA.name, b: playerB.name })}</p>
            ) : bothEvaluated ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("playerComparison.coachEvalComparison", { a: playerA.name, b: playerB.name, winner: aiWinner.name })}{" "}
              {t("playerComparison.winnerMaturation")}{" "}
              <span className="font-bold text-foreground">
                {!winnerGate.ok
                  ? phvGateText({ gate: winnerGate })
                  : winnerGate.assessment.timing === "late"
                  ? t("playerComparison.maturationLate")
                  : winnerGate.assessment.timing === "early"
                  ? t("playerComparison.maturationEarly")
                  : winnerGate.assessment.timing === "on_time"
                  ? t("playerComparison.maturationNormal")
                  : t("maturity.timing.unknown")}
              </span>
            </p>
            ) : (
              <p className="text-sm text-muted-foreground leading-relaxed">{t("playerComparison.noComparableEval")}</p>
            )}
          </div>

          {bothEvaluated && !sameEvaluation && (
          <div className="glass rounded-2xl p-6 flex flex-col items-center justify-center text-center">
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              {t("playerComparison.higherCoachEval")}
            </span>
            <h2 className="font-display font-bold text-4xl text-electric leading-tight mb-1">
              {aiWinner.name.split(" ")[0].toUpperCase()}
            </h2>
            <h2 className="font-display font-bold text-2xl text-electric leading-tight mb-3">
              {(aiWinner.name.split(" ")[1] ?? "").toUpperCase()}
            </h2>
            <p className="text-[10px] text-muted-foreground mb-4">{t("coachEval.hint")}</p>
            <button
              onClick={() => navigate(`/players/${aiWinner.id}`)}
              className="w-full px-4 py-2.5 rounded-lg border border-border text-sm font-display font-bold text-foreground hover:bg-secondary transition-colors uppercase tracking-wider"
            >
              {t("playerComparison.viewFullProfile")}
            </button>
          </div>
          )}
        </motion.div>

        {/* ── CLONES LADO A LADO ── */}
        <motion.div variants={item}>
          <div className="flex items-center gap-2 mb-3">
            <Star size={14} className="text-gold" />
            <h3 className="font-display font-bold text-lg text-foreground">{t("playerComparison.referencePlayers")}</h3>
            <span className="text-[10px] text-muted-foreground">{t("playerComparison.cosineSimilarity")}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <CloneCard similarity={simA ?? undefined} playerName={playerA.name} />
              <button
                onClick={() => navigate(`/players/${playerA.id}/intelligence`)}
                className="w-full text-[10px] font-display text-primary flex items-center justify-center gap-1 py-1.5"
              >
                <Zap size={10} /> {t("playerComparison.viewFullReport")}
              </button>
            </div>
            <div className="space-y-2">
              <CloneCard similarity={simB ?? undefined} playerName={playerB.name} />
              <button
                onClick={() => navigate(`/players/${playerB.id}/intelligence`)}
                className="w-full text-[10px] font-display text-primary flex items-center justify-center gap-1 py-1.5"
              >
                <Zap size={10} /> {t("playerComparison.viewFullReport")}
              </button>
            </div>
          </div>
        </motion.div>

        {/* ── VITAS CARDS ── */}
        <motion.div variants={item}>
          <div className="flex items-center gap-2 mb-3">
            <FileText size={14} className="text-primary" />
            <h3 className="font-display font-bold text-lg text-foreground">{t("playerComparison.exportVitasCard")}</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setCardPlayer("A")}
              className="glass rounded-xl p-3 flex items-center gap-3 hover:border-primary/40 transition-colors border border-border"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                {playerA.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
              </div>
              <div className="text-left">
                <p className="text-xs font-bold text-foreground truncate">{playerA.name.split(" ")[0]}</p>
                <p className="text-[9px] text-muted-foreground">{t("playerComparison.generateCard")}</p>
              </div>
            </button>
            <button
              onClick={() => setCardPlayer("B")}
              className="glass rounded-xl p-3 flex items-center gap-3 hover:border-primary/40 transition-colors border border-border"
            >
              <div className="w-8 h-8 rounded-lg bg-electric/10 flex items-center justify-center text-xs font-bold text-electric">
                {playerB.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
              </div>
              <div className="text-left">
                <p className="text-xs font-bold text-foreground truncate">{playerB.name.split(" ")[0]}</p>
                <p className="text-[9px] text-muted-foreground">{t("playerComparison.generateCard")}</p>
              </div>
            </button>
          </div>
        </motion.div>

        {/* Footer */}
        <motion.div variants={item} className="flex items-center justify-between text-[10px] text-muted-foreground font-display px-2 pb-4">
          <span>VITAS ENGINE: <span className="text-primary">{t("playerComparison.engineActive")}</span></span>
          <span>© 2026 VITAS · Football Intelligence</span>
        </motion.div>
      </div>

      {/* Modal VITAS Card */}
      <Dialog open={!!cardPlayer} onOpenChange={() => setCardPlayer(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display text-sm">
              VITAS Card — {cardPlayer === "A" ? playerA?.name : playerB?.name}
            </DialogTitle>
          </DialogHeader>
          {cardPlayer && rawA && rawB && (
            <VitasCard
              player={cardPlayer === "A" ? rawA : rawB}
              bestMatch={(cardPlayer === "A" ? simA : simB)?.bestMatch ?? null}
              onClose={() => setCardPlayer(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default PlayerComparison;
