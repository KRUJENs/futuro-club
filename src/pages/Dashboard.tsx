import React from "react";
import { motion } from "framer-motion";
import { Activity, Users, Zap, TrendingUp, Camera, LayoutDashboard, GitCompareArrows, Settings, Plus, Trophy, Swords, Grid3x3, Sparkles, BarChart3, FileText } from "lucide-react";
import PageHeader from "@/components/shared/PageHeader";
import PulseInboxHero from "@/components/pulse/PulseInboxHero";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { DemoDataService } from "@/services/real/demoDataService";
import { SupabasePlayerService } from "@/services/real/supabasePlayerService";
import { useAuth } from "@/context/AuthContext";
import { useDashboardStats, useTrendingPlayers, useLiveMatches } from "@/hooks/useDashboard";
import { DashboardStatsSkeleton, MatchesSkeleton, PlayerListSkeleton } from "@/components/shared/Skeletons";
import LiveMatchCard from "@/components/LiveMatchCard";
import PlayerCard from "@/components/PlayerCard";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useTranslation } from "react-i18next";
import WelcomeGuide from "@/components/WelcomeGuide";
import UsageMeter from "@/components/UsageMeter";

/* ── Floating background orbs ─────────────────────── */
function DashboardOrbs() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
      <div
        className="absolute w-[400px] h-[400px] rounded-full animate-float-slow"
        style={{ background: "radial-gradient(circle, hsl(210 100% 50% / 0.06) 0%, transparent 70%)", top: "-5%", right: "-10%" }}
      />
      <div
        className="absolute w-[300px] h-[300px] rounded-full animate-float-medium"
        style={{ background: "radial-gradient(circle, hsl(290 70% 55% / 0.05) 0%, transparent 70%)", bottom: "20%", left: "-8%" }}
      />
      <div
        className="absolute w-[250px] h-[250px] rounded-full animate-float-slow"
        style={{ background: "radial-gradient(circle, hsl(180 70% 40% / 0.04) 0%, transparent 70%)", top: "40%", right: "5%", animationDelay: "3s" }}
      />
    </div>
  );
}

const statIcons = [Users, Zap, Activity, TrendingUp];
const statLabelKeys = ["dashboard.stats.activePlayers", "dashboard.stats.drillsCompleted", "dashboard.stats.avgVsi", "dashboard.stats.hiddenTalents"];
const statSubLabelKeys = ["dashboard.stats.activePlayersDesc", "dashboard.stats.drillsCompletedDesc", "dashboard.stats.avgVsiDesc", "dashboard.stats.hiddenTalentsDesc"];

const Dashboard = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { isDirector } = useUserProfile();
  const { user } = useAuth();

  async function handleLoadDemo() {
    const created = DemoDataService.reseed();
    if (created > 0) {
      // Los datos demo se siembran en localStorage (Panel), pero Rankings y el
      // selector del Lab leen del servidor → hay que empujarlos a Supabase para que
      // los VEAN (si no, "cargar demo" llena el Panel pero deja Rankings/Lab vacíos).
      if (user) {
        await SupabasePlayerService.pushAll(user.id).catch(() => {});
      }
      queryClient.invalidateQueries({ queryKey: ["trending-players"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["ranked-players"] }); // Rankings
      queryClient.invalidateQueries({ queryKey: ["players-all"] });     // selector del Lab / Scout
      toast.success(t("dashboardPage.demoLoaded", { count: created }));
    } else {
      toast.info(t("dashboardPage.demoAlreadyHasPlayers"));
    }
  }
  const { data: stats, isLoading: statsLoading, isError: statsError } = useDashboardStats();
  const { data: players, isLoading: playersLoading, isError: playersError } = useTrendingPlayers();
  const { data: matches, isLoading: matchesLoading, isError: matchesError } = useLiveMatches();

  // Show errors via useEffect to avoid calling toast during render
  const hasStatsError = statsError;
  const hasPlayersError = playersError;
  const hasMatchesError = matchesError;

  React.useEffect(() => {
    if (hasStatsError) toast.error(t("toasts.statsError"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStatsError]);
  React.useEffect(() => {
    if (hasPlayersError) toast.error(t("toasts.trendingError"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPlayersError]);
  React.useEffect(() => {
    if (hasMatchesError) toast.error(t("toasts.matchesError"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMatchesError]);

  const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
  const item = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { duration: 0.4 } } };

  const statValues = stats
    ? [
        String(stats.activePlayers),
        String(stats.drillsCompleted),
        // Sin jugadores evaluados avgVsi es null: se dice «Sin evaluar», nunca el literal
        // "null", un 0 fabricado ni un «—» (invariante #2 y reglas de presentación).
        stats.avgVsi === null ? t("common.notEvaluated") : String(stats.avgVsi),
        String(stats.hiddenTalents),
      ]
    : [];

  return (
    <>
    <DashboardOrbs />
    <motion.div variants={container} initial="hidden" animate="show" className="relative z-10 px-4 pt-4 pb-24 space-y-6 max-w-lg lg:max-w-5xl mx-auto">
      {/* Gradient accent bar */}
      <div className="gradient-bar rounded-full mx-auto" style={{ width: "60%", opacity: 0.6 }} />

      {/* Header */}
      <motion.div variants={item}>
        <PageHeader
          title="VITAS."
          subtitle={t("dashboard.subtitle")}
          gradient
          rightContent={
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full pulse-live" style={{ background: "linear-gradient(135deg, #0059B3, #A855F7)" }} />
              <span className="text-[10px] font-display uppercase tracking-widest" style={{
                background: "linear-gradient(135deg, #0059B3, #A855F7)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}>{t("dashboard.live")}</span>
            </div>
          }
        />
      </motion.div>

      {/* Inbox de hoy: qué hay nuevo desde tu última visita, o el ritual de subir
          el último partido. Primera respuesta de la app, sin scroll. */}
      <motion.div variants={item}>
        <PulseInboxHero />
      </motion.div>

      {/* Hoy puedes… · quick action tiles */}
      <motion.div variants={item} className="space-y-2">
        <div className="flex items-center gap-1.5 px-1">
          <Sparkles size={11} className="text-primary" />
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
            {t("dashboardPage.todayYouCan")}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            { Icon: Activity, label: "Match-day Live",             sub: t("dashboardPage.tileTagMatchSub"),   color: "#22e88c", to: "/live" },
            { Icon: Swords,   label: t("dashboardPage.tilePlanVsRival"),  sub: t("dashboardPage.tilePlanVsRivalSub"), color: "#F59E0B", to: "/equipo/rival" },
            { Icon: Grid3x3,  label: t("dashboardPage.tileTeamAnalysis"), sub: t("dashboardPage.tileTeamAnalysisSub"), color: "#1A8FFF", to: "/equipo/baseline" },
            { Icon: Zap,      label: "VITAS.LAB",                   sub: t("dashboardPage.tileUploadVideoSub"), color: "#B82BD9", to: "/lab" },
            { Icon: BarChart3,label: t("dashboardPage.tileMyPlayers"),    sub: t("dashboardPage.tileMyPlayersSub"), color: "#10b981", to: "/rankings" },
            { Icon: FileText, label: t("dashboardPage.tileGenerateReport"), sub: t("dashboardPage.tileGenerateReportSub"), color: "#0066CC", to: "/rankings" },
          ].map((tile) => {
            const Icon = tile.Icon;
            return (
              <button
                key={tile.label}
                onClick={() => navigate(tile.to)}
                className="glass-vibrant rounded-xl p-3 flex items-center gap-2 active:scale-[0.97] transition-all text-left"
                style={{ borderColor: `${tile.color}30` }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: `linear-gradient(135deg, ${tile.color}25, ${tile.color}10)`,
                    boxShadow: `0 2px 8px ${tile.color}15`,
                  }}
                >
                  <Icon size={16} style={{ color: tile.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-display font-bold text-foreground truncate leading-tight">
                    {tile.label}
                  </div>
                  <div className="text-[9px] text-muted-foreground truncate">
                    {tile.sub}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </motion.div>

      {/* Stats */}
      <motion.div variants={item}>
        {statsLoading ? (
          <DashboardStatsSkeleton />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {statLabelKeys.map((labelKey, i) => {
              const Icon = statIcons[i];
              const gradients = [
                "linear-gradient(135deg, hsl(210 100% 50% / 0.08), hsl(290 70% 50% / 0.04))",
                "linear-gradient(135deg, hsl(290 70% 50% / 0.08), hsl(330 80% 50% / 0.04))",
                "linear-gradient(135deg, hsl(180 70% 40% / 0.08), hsl(210 100% 50% / 0.04))",
                "linear-gradient(135deg, hsl(38 92% 50% / 0.08), hsl(330 80% 50% / 0.04))",
              ];
              const iconColors = ["#0059B3", "#A855F7", "#158585", "#D4940A"];
              return (
                <div key={labelKey} className="glass-vibrant rounded-xl p-3" style={{ background: gradients[i] }}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={14} style={{ color: iconColors[i] }} />
                    <span className="text-[10px] text-muted-foreground font-display uppercase tracking-wider">{t(labelKey)}</span>
                  </div>
                  <div className="font-display font-bold text-xl stat-vibrant">{statValues[i]}</div>
                  <div className="text-[10px] text-muted-foreground font-medium">{t(statSubLabelKeys[i])}</div>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* Welcome Guide — visible solo para usuarios nuevos */}
      {stats && stats.activePlayers <= 1 && (
        <motion.div variants={item}>
          <WelcomeGuide playerCount={stats.activePlayers} />
        </motion.div>
      )}

      {/* AI Usage */}
      <motion.div variants={item}>
        <UsageMeter compact />
      </motion.div>

      {/* Quick Access */}
      <motion.div variants={item} className="grid grid-cols-2 gap-3">
        {[
          { path: "/master", icon: LayoutDashboard, label: t("dashboard.quickAccess.masterDashboard"), sub: t("dashboard.quickAccess.masterSub"), hex: "#0059B3" },
          { path: "/lab", icon: Camera, label: t("dashboard.quickAccess.vitasLab"), sub: t("dashboard.quickAccess.vitasLabSub"), hex: "#A855F7" },
          { path: "/compare", icon: GitCompareArrows, label: t("dashboard.quickAccess.comparisonTool"), sub: t("dashboard.quickAccess.comparisonToolSub"), hex: "#E6197A" },
          ...(isDirector ? [{ path: "/director", icon: Trophy, label: "Director", sub: t("dashboard.quickAccess.directorSub"), hex: "#D4940A" }] : [{ path: "/settings", icon: Settings, label: t("dashboard.quickAccess.config"), sub: t("dashboard.quickAccess.configSub"), hex: "#D4940A" }]),
        ].map(({ path, icon: Icon, label, sub, hex }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className="glass-vibrant rounded-xl p-4 flex flex-col items-center gap-2 transition-all active:scale-[0.97]"
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{
              background: `linear-gradient(135deg, ${hex}20, ${hex}08)`,
              boxShadow: `0 2px 10px ${hex}12`,
            }}>
              <Icon size={20} style={{ color: hex }} />
            </div>
            <span className="font-display font-bold text-xs text-foreground">{label}</span>
            <span className="text-[9px] text-muted-foreground">{sub}</span>
          </button>
        ))}
      </motion.div>

      {/* Matches */}
      <motion.div variants={item}>
        <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3">{t("dashboard.matches")}</h2>
        {matchesLoading ? (
          <MatchesSkeleton />
        ) : matches?.length ? (
          <div className="flex gap-3 overflow-x-auto no-scrollbar snap-x snap-mandatory pb-1">
            {matches.map((match) => <LiveMatchCard key={match.id} match={match} />)}
          </div>
        ) : (
          <div className="glass rounded-xl p-6 text-center">
            <p className="text-sm text-muted-foreground">{t("dashboard.noMatches")}</p>
          </div>
        )}
      </motion.div>

      {/* Trending Players */}
      <motion.div variants={item}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider">{t("dashboard.trendingPlayers")}</h2>
          <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 text-primary" onClick={() => navigate("/players/new")}>
            <Plus size={11} /> {t("common.new")}
          </Button>
        </div>
        {playersLoading ? (
          <PlayerListSkeleton count={4} />
        ) : players?.length ? (
          <div className="space-y-2">
            {players.map((player) => <PlayerCard key={player.id} player={player} />)}
          </div>
        ) : (stats?.activePlayers ?? 0) > 0 ? (
          // Hay jugadores pero ninguno con tendencia "up" (p.ej. recién cargados, sin
          // histórico VSI → delta 0 → "estable"). NO decir "Sin jugadores registrados"
          // (sería FALSO ya con jugadores) ni ofrecer "Cargar demo" (ya hay datos).
          // Se apunta a Rankings, donde estos jugadores SÍ aparecen.
          <div className="glass rounded-xl p-8 text-center space-y-3">
            <TrendingUp size={32} className="text-muted-foreground mx-auto" />
            <p className="font-display font-bold text-base text-foreground">{t("dashboard.noTrending.title")}</p>
            <p className="text-xs text-muted-foreground">{t("dashboard.noTrending.description")}</p>
            <Button size="sm" className="gap-1.5" onClick={() => navigate("/rankings")}>
              <BarChart3 size={14} /> {t("dashboard.noTrending.cta")}
            </Button>
          </div>
        ) : (
          <div className="glass rounded-xl p-8 text-center space-y-3">
            <Users size={32} className="text-muted-foreground mx-auto" />
            <p className="font-display font-bold text-base text-foreground">{t("dashboard.noPlayers.title")}</p>
            <p className="text-xs text-muted-foreground">{t("dashboard.noPlayers.description")}</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
              <Button size="sm" className="gap-1.5" onClick={() => navigate("/players/new")}>
                <Plus size={14} /> {t("dashboard.noPlayers.cta")}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleLoadDemo}>
                <Sparkles size={14} /> {t("dashboardPage.loadDemoData")}
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
    </>
  );
};

export default Dashboard;
