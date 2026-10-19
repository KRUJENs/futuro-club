import { useState, useMemo, useCallback } from "react";
import { motion } from "framer-motion";
import { Crown, Medal, Shield, Search, Plus, X, SlidersHorizontal, BarChart3, Users } from "lucide-react";
import PageHeader from "@/components/shared/PageHeader";
import { useRankedPlayers } from "@/hooks/useRankings";
import { RankingsPodiumSkeleton, PlayerListSkeleton } from "@/components/shared/Skeletons";
import VsiGauge from "@/components/VsiGauge";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { SortField, SortDir, RankingsFilters } from "@/services/rankingsService";
import FeatureHint from "@/components/FeatureHint";
import { RequirePermission } from "@/components/RequirePermission";
import { maturityTimingKey } from "@/lib/phv/playerMaturity";
import { phvGate, RANKING_TIMING_FILTERS, type MaturityTiming, type PhvGateInput } from "@/lib/phv/phvGate";
import { PhvGateNotice } from "@/components/phv/PhvGateNotice";
import DemoDataBanner from "@/components/DemoDataBanner";
import { PlayerService } from "@/services/real/playerService";

// ─── Constantes ───────────────────────────────────────────────────────────────
const rankIcons = [
  <Crown key="1" size={16} className="text-gold" />,
  <Medal key="2" size={16} className="text-muted-foreground" />,
  <Shield key="3" size={16} className="text-amber-700" />,
];

// Filtro «Maduración»: por TIMING vs pares, rotulado con timingLabel (la MISMA
// clave i18n y la misma ⭐ que la fila). Antes filtraba la FASE (early = pre-PHV)
// bajo el rótulo «Tardío ⭐»: listaba a casi todo pre-púber y ocultaba a tardíos.
const TIMING_FILTERS = ["all", ...RANKING_TIMING_FILTERS] as const;

const POSITION_GROUPS = [
  "Todos",
  "Portero",
  "Defensa Central",
  "Lateral Derecho",
  "Lateral Izquierdo",
  "Pivote",
  "Mediocentro",
  "Mediapunta",
  "Extremo Derecho",
  "Extremo Izquierdo",
  "Delantero Centro",
  "Segundo Delantero",
];

const AGE_GROUPS = ["all", "Sub-10", "Sub-12", "Sub-14", "Sub-16", "Sub-18", "Sub-21"];

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, x: -20 }, show: { opacity: 1, x: 0, transition: { duration: 0.4 } } };

// ─── Componente principal ─────────────────────────────────────────────────────
const Rankings = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<SortField>("vsi");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");
  const [timingFilter, setTimingFilter] = useState<string>("all");
  const [posFilter, setPosFilter] = useState("Todos");
  const [ageGroupFilter, setAgeGroupFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);

  // Build filters object for API
  const filters: RankingsFilters = useMemo(
    () => ({
      timing: timingFilter,
      position: posFilter,
      ageGroup: ageGroupFilter,
      level: levelFilter,
      search: search || undefined,
    }),
    [timingFilter, posFilter, ageGroupFilter, levelFilter, search]
  );

  // Rótulo ÚNICO del timing (fila y filtro): el chip «Madurador tardío ⭐» lista
  // exactamente las filas rotuladas «Madurador tardío ⭐».
  const timingLabel = (timing: MaturityTiming) =>
    `${t(maturityTimingKey(timing))}${timing === "late" ? " ⭐" : ""}`;

  const { data: response, isLoading, isError } = useRankedPlayers(sortBy, sortDir, filters);

  const players = response?.players ?? [];
  // ¿El roster local contiene jugadores de ejemplo? (localStorage, fiable aunque el
  // ranking venga del servidor). Si sí, rotulamos toda la vista como datos de ejemplo.
  // Cómputo inline: lectura barata de localStorage, recalcula en cada render.
  const hasDemoPlayers = PlayerService.getAll().some((p) => p.isDemo);
  const totalUnfiltered = response?.totalUnfiltered ?? 0;
  const ageGroupStats = response?.ageGroupStats ?? {};
  const competitiveLevels = response?.competitiveLevels ?? [];

  if (isError) toast.error(t("toasts.rankingsError"));

  const hasFilters = search !== "" || timingFilter !== "all" || posFilter !== "Todos" || ageGroupFilter !== "all" || levelFilter !== "all";
  const isFiltered = players.length !== totalUnfiltered;

  const handleSort = useCallback((field: SortField) => {
    if (sortBy === field) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(field); setSortDir("desc"); }
  }, [sortBy]);

  const clearFilters = useCallback(() => {
    setSearch("");
    setTimingFilter("all");
    setPosFilter("Todos");
    setAgeGroupFilter("all");
    setLevelFilter("all");
  }, []);

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="px-4 pt-4 pb-24 space-y-4 max-w-lg lg:max-w-5xl mx-auto">

      {/* Datos de ejemplo cargados → rotular la vista (honestidad: no vender demo como real) */}
      {hasDemoPlayers && (
        <motion.div variants={item}>
          <DemoDataBanner messageKey="rankingsPage.demoNotice" />
        </motion.div>
      )}

      {/* Header + Nuevo jugador */}
      <motion.div variants={item} className="flex items-start justify-between relative">
        <div className="relative">
          <PageHeader title={t("players.rankings.title")} subtitle={t("players.rankings.subtitle")} />
          <FeatureHint
            id="rankings-vsi"
            message={t("rankingsPage.vsiHint")}
            delay={1500}
          />
        </div>
        <RequirePermission permission="canCreatePlayers" fallback={null}>
          <Button
            size="sm"
            className="gap-1.5 shrink-0 mt-1"
            onClick={() => navigate("/players/new")}
          >
            <Plus size={14} />
            {t("common.new")}
          </Button>
        </RequirePermission>
      </motion.div>

      {/* Búsqueda */}
      <motion.div variants={item} className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("players.rankings.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 pr-9 h-9 text-sm"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </motion.div>

      {/* Sort + Filtros toggle */}
      <motion.div variants={item} className="flex items-center gap-2">
        <div className="flex gap-1 bg-muted rounded-md p-0.5 flex-1">
          {([["vsi", t("players.rankings.sortVsi")], ["age", t("players.rankings.sortAge")], ["name", t("players.rankings.sortName")], ["percentile", t("players.rankings.sortPercentile")]] as [SortField, string][]).map(
            ([field, label]) => (
              <Button
                key={field}
                variant={sortBy === field ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={() => handleSort(field)}
              >
                {label} {sortBy === field && (sortDir === "desc" ? "↓" : "↑")}
              </Button>
            )
          )}
        </div>
        <Button
          variant={showFilters ? "default" : "outline"}
          size="sm"
          className="h-7 gap-1 shrink-0"
          onClick={() => setShowFilters((v) => !v)}
        >
          <SlidersHorizontal size={12} />
          {t("common.filters")}
          {hasFilters && (
            <span className="w-4 h-4 rounded-full bg-primary-foreground text-primary text-[9px] font-bold flex items-center justify-center">
              !
            </span>
          )}
        </Button>
      </motion.div>

      {/* Panel de filtros expandible */}
      {showFilters && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="glass rounded-xl p-4 space-y-4"
        >
          {/* Filtro PHV */}
          <div>
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              {t("players.rankings.bioMaturation")}
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {TIMING_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setTimingFilter(f)}
                  className={`px-3 py-1 rounded-lg text-xs font-display font-semibold border transition-all ${
                    timingFilter === f
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-secondary text-muted-foreground border-border hover:border-primary/50"
                  }`}
                >
                  {f === "all" ? t("players.rankings.phvFilter.all") : timingLabel(f)}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro Posición */}
          <div>
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              {t("common.position")}
            </p>
            <select
              value={posFilter}
              onChange={(e) => setPosFilter(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs font-display text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {POSITION_GROUPS.map((pos) => (
                <option key={pos} value={pos}>{pos}</option>
              ))}
            </select>
          </div>

          {/* Filtro Grupo de Edad */}
          <div>
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              {t("players.rankings.ageGroup")}
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {AGE_GROUPS.map((ag) => (
                <button
                  key={ag}
                  onClick={() => setAgeGroupFilter(ag)}
                  className={`px-3 py-1 rounded-lg text-xs font-display font-semibold border transition-all ${
                    ageGroupFilter === ag
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-secondary text-muted-foreground border-border hover:border-primary/50"
                  }`}
                >
                  {ag === "all" ? t("players.rankings.phvFilter.all") : ag}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro Nivel Competitivo */}
          {competitiveLevels.length > 0 && (
            <div>
              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                {t("players.rankings.competitiveLevel")}
              </p>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs font-display text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">{t("players.rankings.phvFilter.all")}</option>
                {competitiveLevels.map((lv) => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </div>
          )}

          {/* Limpiar filtros */}
          {hasFilters && (
            <Button variant="ghost" size="sm" className="w-full text-xs gap-1" onClick={clearFilters}>
              <X size={12} />
              {t("common.clearFilters")}
            </Button>
          )}
        </motion.div>
      )}

      {/* Age group stats banner */}
      {ageGroupFilter !== "all" && ageGroupStats[ageGroupFilter] && (
        <motion.div variants={item} className="glass rounded-xl p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <BarChart3 size={14} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-display font-semibold text-foreground">{ageGroupFilter}</p>
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span><Users size={10} className="inline mr-0.5" />{ageGroupStats[ageGroupFilter].count}</span>
              {/* Sin ningún evaluado en el grupo: se dice, sin «—» (reglas de presentación). */}
              {ageGroupStats[ageGroupFilter].avgVsi == null ? (
                <span>{t("common.notEvaluated")}</span>
              ) : (
                <>
                  <span>Ø {ageGroupStats[ageGroupFilter].avgVsi}</span>
                  <span>{t("players.rankings.minVsi")}: {ageGroupStats[ageGroupFilter].minVsi}</span>
                  <span>{t("players.rankings.maxVsi")}: {ageGroupStats[ageGroupFilter].maxVsi}</span>
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Resultado de búsqueda */}
      {isFiltered && !isLoading && (
        <motion.div variants={item} className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            {t("players.rankings.ofPlayers", { filtered: players.length, total: totalUnfiltered })}
          </span>
          <button onClick={clearFilters} className="text-primary hover:underline font-display font-semibold">
            {t("common.viewAll")}
          </button>
        </motion.div>
      )}

      {/* Podium (solo en vista VSI sin filtros) */}
      {isLoading ? (
        <RankingsPodiumSkeleton />
      ) : players.length >= 3 && sortBy === "vsi" && sortDir === "desc" && !hasFilters ? (
        <motion.div variants={item} className="flex items-end justify-center gap-3 py-4">
          {[players[1], players[0], players[2]].map((player, i) => {
            const heights = ["h-24", "h-32", "h-20"];
            const order = [1, 0, 2];
            return (
              <motion.div
                key={player.id}
                whileTap={{ scale: 0.95 }}
                onClick={() => navigate(`/players/${player.id}`)}
                className="flex flex-col items-center cursor-pointer"
              >
                <VsiGauge value={player.vsi} size="sm" />
                <div className="mt-1 text-xs font-display font-semibold text-foreground text-center">
                  {player.name.split(" ")[0]}
                </div>
                <div
                  className={`${heights[i]} w-16 mt-2 rounded-t-lg flex items-start justify-center pt-2`}
                  style={order[i] === 0
                    ? { background: "linear-gradient(180deg, hsl(210 100% 50% / 0.25), hsl(290 70% 50% / 0.08), transparent)", borderTop: "2px solid hsl(210 100% 50%)" }
                    : order[i] === 1
                    ? { background: "linear-gradient(180deg, hsl(0 0% 70% / 0.15), transparent)", borderTop: "2px solid hsl(0 0% 70%)" }
                    : { background: "linear-gradient(180deg, hsl(30 80% 50% / 0.15), transparent)", borderTop: "2px solid hsl(30 80% 50%)" }
                  }
                >
                  {rankIcons[order[i]] || (
                    <span className="text-xs text-muted-foreground font-display">#{order[i] + 1}</span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      ) : null}

      {/* Lista de jugadores */}
      {isLoading ? (
        <PlayerListSkeleton count={6} />
      ) : players.length === 0 ? (
        <motion.div variants={item} className="glass rounded-xl p-8 text-center space-y-3">
          {hasFilters ? (
            <>
              <p className="font-display font-bold text-lg">{t("players.rankings.noResults")}</p>
              <p className="text-sm text-muted-foreground">
                {t("players.rankings.noResultsDesc")}
              </p>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("common.clearFiltersSm")}
              </Button>
            </>
          ) : (
            <>
              <p className="font-display font-bold text-lg">{t("players.rankings.noPlayersTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("players.rankings.noPlayersDesc")}
              </p>
              <Button size="sm" onClick={() => navigate("/players/new")} className="gap-1.5">
                <Plus size={14} />
                {t("players.rankings.addPlayer")}
              </Button>
            </>
          )}
        </motion.div>
      ) : (
        <div className="space-y-2">
          {players.map((player, i) => (
            <motion.div
              key={player.id}
              variants={item}
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate(`/players/${player.id}`)}
              className="glass-vibrant rounded-xl p-3 flex items-center gap-3 cursor-pointer transition-colors"
            >
              {/* Posición en ranking */}
              <span className="w-6 text-center font-display font-bold text-sm text-muted-foreground">
                {isFiltered ? "—" : i + 1}
              </span>

              {/* Avatar iniciales */}
              <div className="w-9 h-9 rounded-full border border-border bg-secondary flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-display font-bold text-muted-foreground">
                  {player.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                </span>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-display font-semibold text-foreground truncate">{player.name}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                  <span className="text-electric font-display">{player.positionShort}</span>
                  <span>·</span>
                  <span>{player.age}a</span>
                  <span>·</span>
                  {/* Timing de maduración desde el motor canónico (misma fuente
                      que la tarjeta PHV): la respuesta del API incluye la
                      antropometría/sexo del jugador. "por determinar" cuando no
                      es fiable (lejos del PHV / sin datos) → sin falso positivo. */}
                  {(() => {
                    // Gate único: sin todas las entradas introducidas se nombra
                    // qué falta, nunca «Timing por determinar» mudo ni una fase.
                    const phv = phvGate(player as unknown as PhvGateInput);
                    if (!phv.ok) return <PhvGateNotice gate={phv} />;
                    const mat = phv.assessment;
                    const cls =
                      mat.timing === "late" ? "text-primary font-semibold"
                      : mat.timing === "early" ? "text-gold"
                      : "text-muted-foreground";
                    return (
                      <span className={cls}>{timingLabel(mat.timing)}</span>
                    );
                  })()}
                  {/* Percentil entre pares del grupo de edad (implementación única,
                      src/lib/metrics/percentile.ts). Sin evaluar: el gauge ya lo dice.
                      Menos de 10 pares: se dice, nunca un P0/P100 de 1-2 niños. */}
                  {player.percentileInAgeGroup != null ? (
                    <span className="text-primary font-mono font-semibold">
                      P{player.percentileInAgeGroup}
                    </span>
                  ) : player.percentileInAgeGroupGate?.code === "insufficient_peers" ? (
                    <span
                      className="text-muted-foreground"
                      title={t("percentile.gate.insufficient_peers", {
                        count: player.percentileInAgeGroupGate.peers,
                        min: player.percentileInAgeGroupGate.min,
                      })}
                    >
                      {t("percentile.gate.insufficient_short", {
                        count: player.percentileInAgeGroupGate.peers,
                        min: player.percentileInAgeGroupGate.min,
                      })}
                    </span>
                  ) : player.percentileInAgeGroupGate?.code === "pending_review" ||
                    player.percentileInAgeGroupGate?.code === "reviews_unavailable" ? (
                    // Revisión VSI de la 070 (D3): el motivo, nunca un hueco mudo.
                    <span className="text-muted-foreground">
                      {t(`percentile.gate.${player.percentileInAgeGroupGate.code}`)}
                    </span>
                  ) : null}
                  {/* Tendencia */}
                  {player.trending === "up" && <span className="text-primary">↑</span>}
                  {player.trending === "down" && <span className="text-destructive">↓</span>}
                </div>
              </div>

              <VsiGauge value={player.vsi} size="sm" />
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
};

export default Rankings;
