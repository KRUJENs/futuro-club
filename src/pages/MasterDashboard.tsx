import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import PageHeader from "@/components/shared/PageHeader";
import { useAuth } from "@/context/AuthContext";
import {
  LayoutDashboard,
  Activity,
  Users,
  FileText,
  Settings,
  ExternalLink,
  TrendingUp,
  Shield,
  UserRound,
  Video,
  Loader2,
  Clock,
} from "lucide-react";
import { PlayerService } from "@/services/real/playerService";
import { computeDashboardStats } from "@/services/real/adapters";
import { percentilesAmong } from "@/lib/metrics/percentile";
import { coachEvalTier, type CoachEvalTier } from "@/services/real/metricsService";
import { COACH_EVAL_TIERS } from "../../config/coachEvaluation";
import { gatedMaturity } from "@/lib/phv/phvGate";
import { useTranslation } from "react-i18next";

const sidebarItems = [
  { path: "/master", icon: LayoutDashboard, labelKey: "masterDashboard.navMasterPanel" },
  { path: "/lab", icon: Activity, labelKey: "masterDashboard.navActiveAnalysis" },
  { path: "/rankings", icon: Users, labelKey: "masterDashboard.navPlayerBase" },
  { path: "/scout", icon: FileText, labelKey: "masterDashboard.navScoutReports" },
  { path: "/settings", icon: Settings, labelKey: "masterDashboard.navSettings" },
];

const biasColors: Record<string, { bg: string; text: string; label: string }> = {
  low: { bg: "bg-primary/20", text: "text-primary", label: "LOW BIAS ALERT" },
  med: { bg: "bg-gold/20", text: "text-gold", label: "MED BIAS ALERT" },
  high: { bg: "bg-destructive/20", text: "text-destructive", label: "HIGH BIAS ALERT" },
};

// Tramos de la evaluación del entrenador: cortes ÚNICOS (config/coachEvaluation.ts vía
// coachEvalTier, P1 bloque 5b). Antes 80/65/50 aquí y 85/70/50 en el indicador.
const TIER_CLASS: Record<CoachEvalTier, string> = {
  elite: "text-primary",
  pro: "text-gold",
  talent: "text-foreground",
  develop: "text-muted-foreground",
};

/** «≥85», «70–84», «<50»: rango de cada tramo desde los cortes únicos. */
function tierRange(i: number): string {
  const { min } = COACH_EVAL_TIERS[i];
  if (i === 0) return `≥${min}`;
  const upper = COACH_EVAL_TIERS[i - 1].min - 1;
  return min === 0 ? `<${upper + 1}` : `${min}–${upper}`;
}

const MasterDashboard = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");

  // ─── Datos reales ───────────────────────────────────────────────────────────
  const players = useMemo(() => {
    return PlayerService.getAll();
  }, []);

  const stats = useMemo(() => computeDashboardStats(players), [players]);

  // Player reports reales con bias calculado — TODOS los jugadores
  const playerReports = useMemo(() => {
    // Percentil con la implementación única (src/lib/metrics/percentile.ts): entre los
    // propios jugadores, sin demo para uno real y con mínimo de 10 pares; si no, null.
    const percentiles = percentilesAmong(
      players.map((p) => ({ id: p.id, value: p.vsi, isDemo: p.isDemo === true })),
    );
    return players
      .filter((p) =>
        searchQuery
          ? p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.position.toLowerCase().includes(searchQuery.toLowerCase())
          : true
      )
      .map((p) => {
        const pct = percentiles.get(p.id)?.result.value ?? null;
        // Sesgo desde el motor canónico, con gating: solo marcamos "high" (talento
        // infravalorado) a un madurador TARDÍO con confianza suficiente, no a
        // cualquier pre-púber (evita falso positivo).
        const mat = gatedMaturity(p);
        const matFirm = mat.confidence === "high" || mat.confidence === "moderate";
        // pct es null sin evaluar o con menos de 10 pares: en ese caso no se marca
        // sesgo por percentil, queda "med" salvo señal de maduración.
        const biasAlert: "low" | "med" | "high" =
          matFirm && mat.timing === "late" ? "high"
          : matFirm && mat.timing === "early" ? "low"
          : pct != null && pct > 70 ? "low" : "med";
        const academy =
          (user?.user_metadata?.organization as string | undefined) ||
          (user?.user_metadata?.academyName as string | undefined) ||
          "";
        return { id: p.id, name: p.name, position: p.position, academy, vsi: p.vsi, biasAlert };
      });
  }, [players, searchQuery, user]);

  // VSI tier distribution
  const vsiTiers = useMemo(() => {
    // Los jugadores SIN evaluar (vsi null) NO entran en ningún tramo: un hueco no
    // es "developing" (null < 50 daría true) — invariante #2. Se cuentan aparte,
    // así elite+high+medium+developing+unrated reconcilia con el total de plantilla.
    const ratedVsis = players.map((p) => p.vsi).filter((v): v is number => v != null);
    const counts: Record<CoachEvalTier, number> = { elite: 0, pro: 0, talent: 0, develop: 0 };
    for (const v of ratedVsis) counts[coachEvalTier(v)] += 1;
    const unrated = players.length - ratedVsis.length;
    return { counts, unrated };
  }, [players]);

  // Position distribution
  const positionDist = useMemo(() => {
    const map: Record<string, number> = {};
    players.forEach((p) => {
      const pos = p.position;
      map[pos] = (map[pos] ?? 0) + 1;
    });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [players]);

  // Últimas actualizaciones — reemplaza mockLiveFeed
  const recentActivity = useMemo(() => {
    return [...players]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5)
      .map(p => ({
        name: p.name,
        action: p.vsiHistory && p.vsiHistory.length > 1 ? t("master.vsiUpdated") : t("master.playerRegistered"),
        vsi: p.vsi,
        time: new Date(p.updatedAt).toLocaleDateString("es-ES"),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players]);

  const container = {
    hidden: {},
    show: { transition: { staggerChildren: 0.05 } },
  };
  const item = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
  };

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden md:flex flex-col w-56 border-r border-border bg-card p-5 justify-between">
        <div>
          <div className="mb-8">
            <PageHeader title="VITAS" subtitle={t("masterDashboard.sportsIntelligence")} />
          </div>
          <nav className="space-y-1">
            {sidebarItems.map((navItem) => {
              const Icon = navItem.icon;
              const isActive = location.pathname === navItem.path;
              return (
                <button
                  key={navItem.path}
                  onClick={() => navigate(navItem.path)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-display font-medium transition-all ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon size={16} />
                  {t(navItem.labelKey)}
                </button>
              );
            })}
          </nav>
        </div>
        {/* User */}
        <div className="flex items-center gap-3 pt-4 border-t border-border">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-display font-bold text-xs">
            {user?.user_metadata?.full_name ? user.user_metadata.full_name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2) : (user?.email?.[0] ?? "U").toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-display font-semibold text-foreground">{user?.email?.split("@")[0] ?? t("masterDashboard.user")}</p>
            <p className="text-[10px] text-muted-foreground">{t("masterDashboard.vitasIntelligence")}</p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <motion.main
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 overflow-y-auto pb-24 md:pb-8"
      >
        <div className="flex flex-col lg:flex-row gap-6 p-4 md:p-6">
          {/* Left Column - Main Content */}
          <div className="flex-1 space-y-6 min-w-0">
            {/* Top Stats — DATOS REALES */}
            <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass rounded-xl p-4 border border-border">
                <div className="flex items-center justify-between mb-3">
                  <Users size={16} className="text-muted-foreground" />
                  <span className="text-[10px] font-display text-primary font-semibold">
                    VITAS Academy
                  </span>
                </div>
                <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {t("master.activePlayers")}
                </p>
                <p className="font-display font-bold text-3xl text-foreground">{stats.activePlayers}</p>
              </div>
              <div className="glass rounded-xl p-4 border border-border">
                <div className="flex items-center justify-between mb-3">
                  <Shield size={16} className="text-muted-foreground" />
                  <span className="text-[10px] font-display text-primary font-semibold">
                    {t("masterDashboard.latePhvLowVsi")}
                  </span>
                </div>
                <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {t("master.hiddenTalents")}
                </p>
                <p className="font-display font-bold text-3xl text-foreground">{stats.hiddenTalents}</p>
              </div>
              <div className="glass rounded-xl p-4 border border-border">
                <div className="flex items-center justify-between mb-3">
                  <TrendingUp size={16} className="text-muted-foreground" />
                  <span className="text-[10px] font-display text-primary font-semibold">
                    {t("masterDashboard.vitasIndex")}
                  </span>
                </div>
                <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {t("master.avgVsi")}
                </p>
                <p className="font-display font-bold text-3xl text-foreground">{stats.avgVsi ?? "—"}</p>
              </div>
            </motion.div>

            {/* VSI Distribution + Position Distribution */}
            <motion.div variants={item} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* VSI Tier Breakdown */}
              <div className="glass rounded-xl p-4 border border-border">
                <h3 className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                  {t("master.vsiDistribution")}
                </h3>
                <div className="space-y-2">
                  {COACH_EVAL_TIERS.map(({ tier }, i) => (
                    <div key={tier} className="flex items-center justify-between">
                      <span className={`text-xs font-display ${TIER_CLASS[tier]}`}>
                        {t(`coachEval.tier.${tier}`)} ({tierRange(i)})
                      </span>
                      <span className={`font-display font-bold text-sm ${TIER_CLASS[tier]}`}>{vsiTiers.counts[tier]}</span>
                    </div>
                  ))}
                  {vsiTiers.unrated > 0 && (
                    <div className="flex items-center justify-between border-t border-border/40 pt-2 mt-1">
                      <span className="text-xs font-display text-muted-foreground/70">{t("common.notEvaluated")}</span>
                      <span className="font-display font-bold text-sm text-muted-foreground/70">{vsiTiers.unrated}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Position Distribution */}
              <div className="glass rounded-xl p-4 border border-border">
                <h3 className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                  {t("master.positionDistribution")}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {positionDist.map(([pos, count]) => (
                    <span
                      key={pos}
                      className="px-2 py-0.5 rounded-full bg-secondary border border-border text-[10px] font-display font-semibold text-foreground"
                    >
                      {pos} <span className="text-primary">{count}</span>
                    </span>
                  ))}
                  {positionDist.length === 0 && (
                    <span className="text-[10px] text-muted-foreground font-display">{t("master.noData")}</span>
                  )}
                </div>
              </div>
            </motion.div>

            {/* Active Analysis — placeholder (link to lab) */}
            <motion.div variants={item}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <h2 className="font-display font-bold text-xl text-foreground">
                    {t("master.activeAnalysis")}
                  </h2>
                </div>
                <button
                  onClick={() => navigate("/lab")}
                  className="px-3 py-1.5 rounded-lg border border-primary text-primary text-xs font-display font-semibold hover:bg-primary/10 transition-colors"
                >
                  {t("master.viewAllPipelines")}
                </button>
              </div>
              <div
                className="glass rounded-xl p-4 border border-border cursor-pointer hover:border-primary/30 transition-colors"
                onClick={() => navigate("/lab")}
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center">
                    <Video size={16} className="text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-sm text-foreground">
                      {t("master.videoAnalysisLab")}
                    </h3>
                    <p className="text-[10px] text-muted-foreground">
                      {t("master.videoLabDesc")}
                    </p>
                  </div>
                  <div className="ml-auto">
                    <Loader2 size={16} className="text-muted-foreground" />
                  </div>
                </div>
              </div>
            </motion.div>

            {/* Player Reports — TODOS los jugadores, scrollable */}
            <motion.div variants={item}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display font-bold text-xl text-foreground">
                  {t("master.squadReports")}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({playerReports.length})
                  </span>
                </h2>
              </div>

              {/* Search input */}
              <div className="mb-3">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("master.searchPlayerOrPosition")}
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm font-display text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
                />
              </div>

              {/* Scrollable player list */}
              <div className="max-h-[480px] overflow-y-auto pr-1 space-y-2">
                {playerReports.length === 0 ? (
                  <div className="glass rounded-xl p-6 border border-border text-center">
                    <p className="text-sm text-muted-foreground font-display">
                      {t("master.noPlayersFound")}
                    </p>
                  </div>
                ) : (
                  playerReports.map((report) => {
                    const bias = biasColors[report.biasAlert];
                    return (
                      <div
                        key={report.id}
                        className="glass rounded-xl p-4 border border-border cursor-pointer hover:border-primary/30 transition-colors"
                        onClick={() => navigate(`/players/${report.id}`)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                              <UserRound size={16} className="text-muted-foreground" />
                            </div>
                            <div>
                              <h4 className="font-display font-bold text-sm text-foreground">
                                {report.name}
                              </h4>
                              <p className="text-[10px] text-muted-foreground">
                                {report.position}{report.academy ? ` · ${report.academy}` : ""}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            {report.vsi != null ? (
                              <p className="font-display font-bold text-xl text-foreground">{report.vsi.toFixed(1)}</p>
                            ) : (
                              <p className="font-display font-semibold text-xs text-muted-foreground">{t("common.notEvaluated")}</p>
                            )}
                            <p className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
                              {t("coachEval.label")}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-display font-bold uppercase tracking-wider ${bias.bg} ${bias.text}`}
                          >
                            {bias.label}
                          </span>
                          <ExternalLink size={12} className="text-muted-foreground" />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>

          {/* Right Sidebar */}
          <div className="w-full lg:w-72 space-y-6 flex-shrink-0">
            {/* Global Talent Distribution */}
            <motion.div variants={item} className="glass rounded-xl p-5 border border-border">
              <h3 className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                {t("master.globalTalentDist")}
              </h3>
              <div className="flex justify-center mb-4">
                <div className="relative w-32 h-32">
                  {/* Simulated globe */}
                  <svg viewBox="0 0 128 128" className="w-full h-full">
                     <circle
                       cx="64"
                       cy="64"
                       r="58"
                       fill="none"
                       stroke="hsl(230, 70%, 58%)"
                       strokeWidth="1.5"
                       opacity="0.3"
                     />
                     <circle
                       cx="64"
                       cy="64"
                       r="58"
                       fill="none"
                       stroke="hsl(230, 70%, 58%)"
                       strokeWidth="1.5"
                       strokeDasharray="365"
                       strokeDashoffset="10"
                       opacity="0.6"
                     />
                    {/* Dots representing talent clusters */}
                     {[
                       [40, 35, 0.82], [50, 42, 0.65], [55, 38, 0.91], [62, 45, 0.74], [70, 50, 0.58],
                       [45, 55, 0.87], [58, 52, 0.70], [65, 58, 0.95], [72, 42, 0.61], [48, 48, 0.78],
                       [55, 65, 0.53], [68, 62, 0.88], [42, 60, 0.66], [75, 55, 0.73], [38, 45, 0.84],
                     ].map(([x, y, op], i) => (
                       <circle
                         key={i}
                         cx={x}
                         cy={y}
                         r="2.5"
                         fill="hsl(230, 70%, 58%)"
                         opacity={op}
                      />
                    ))}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                      {t("master.systemReliability")}
                    </span>
                    <span className="font-display font-bold text-lg text-foreground">99.8%</span>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="glass rounded-lg p-2 text-center">
                  <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
                    EU Cluster
                  </span>
                  <p className="font-display font-bold text-sm text-foreground">42.1%</p>
                </div>
                <div className="glass rounded-lg p-2 text-center">
                  <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
                    LATAM Cluster
                  </span>
                  <p className="font-display font-bold text-sm text-foreground">38.9%</p>
                </div>
              </div>
            </motion.div>

            {/* Últimas Actualizaciones — reemplaza mockLiveFeed */}
            <motion.div variants={item} className="glass rounded-xl p-5 border border-border">
              <h3 className="text-[10px] font-display font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                {t("master.lastUpdates")}
              </h3>
              <div className="space-y-4">
                {recentActivity.length === 0 ? (
                  <p className="text-xs text-muted-foreground font-display">{t("master.noRecentActivity")}</p>
                ) : (
                  recentActivity.map((event, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 bg-primary" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground font-display font-medium leading-tight truncate">
                          {event.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {event.action} · VSI {event.vsi != null ? event.vsi.toFixed(1) : "—"}
                        </p>
                        <p className="text-[9px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Clock size={9} />
                          {event.time}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>

            {/* Expert Desk CTA */}
            <motion.div variants={item} className="glass rounded-xl p-5 border border-border">
              <h3 className="font-display font-bold text-sm text-foreground mb-2">
                {t("master.expertDesk")}
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                {t("master.expertDeskDesc")}
              </p>
              <a
                href="mailto:Contact@krujens.eu?subject=VITAS%20Expert%20Desk"
                className="block w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-display font-bold text-sm text-center hover:bg-primary/90 transition-colors"
              >
                {t("master.contactExpert")}
              </a>
            </motion.div>
          </div>
        </div>
      </motion.main>
    </div>
  );
};

export default MasterDashboard;
