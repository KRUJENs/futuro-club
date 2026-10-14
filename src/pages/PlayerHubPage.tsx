/**
 * VITAS · PlayerHubPage
 *
 * Página única consolidada del jugador. Reemplaza la fragmentación entre:
 *   - /players/:id            (perfil clásico)
 *   - /players/:id/intelligence  (reporte IA)
 *   - /players/:id/role-profile  (perfil de rol)
 *
 * Estructura:
 *   - Header sticky con avatar + nombre + edad + posición + VSI + acciones
 *   - Tabs: Resumen · Stats · Movimiento · Rol · Histórico
 *   - Empty state grande cuando no hay análisis (1 botón "Subir video")
 *
 * Tabs leen el estado del search param `?tab=` para que las URLs sean
 * shareables. Las rutas /intelligence y /role-profile redirigen aquí.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Edit, Video, Activity, FlaskConical, Compass, Clock,
  Sparkles, ChevronRight, AlertCircle, Brain, Zap, Printer, Heart, Shield, TrendingUp, Target, Briefcase,
  GitCompare, ClipboardList, Play, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { PlayerService, type Player } from "@/services/real/playerService";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import { useRawPlayerById } from "@/hooks/usePlayers";
import { GuardianConsentCard } from "@/components/legal/GuardianConsentCard";
import { useScoutInsights } from "@/hooks/useScoutFeed";
import { useVideos } from "@/hooks/useVideos";
import type { VideoRecord } from "@/services/real/videoService";
import VideoPlayer from "@/components/VideoPlayer";
import InsightCard from "@/components/scout/InsightCard";
import { useRoleProfile } from "@/hooks/useRoleProfile";
import { PlayerTrackingService, type TrackingSnapshot } from "@/services/real/playerTrackingService";
import { maturationKnown } from "@/lib/fatigue/phvFatigueAdjuster";
import { IS_DEMO } from "@/lib/demoMode";

import VsiGauge from "@/components/VsiGauge";
import MatchStatsPanel from "@/components/MatchStatsPanel";
import DemoDataBanner from "@/components/DemoDataBanner";
import { AdvancedMetricsPanel } from "@/components/AdvancedMetricsPanel";
import TrackingSnapshotPanel from "@/components/TrackingSnapshotPanel";
import PlayerHeatmap from "@/components/PlayerHeatmap";
import { calculateAdvancedMetrics, TrackingService } from "@/services/real/advancedMetricsService";
import { VideoAdvancedMetricsService, labSnapshotToObservationPacket } from "@/services/real/videoAdvancedMetricsService";
import TalentoOcultoAlert from "@/components/TalentoOcultoAlert";
import ConfidenceBadge from "@/components/ConfidenceBadge";
import NotEvaluatedSection from "@/components/NotEvaluatedSection";

// Componentes del role-profile reutilizados sin envoltorio
import PositionDiscoveryBanner from "@/components/PositionDiscoveryBanner";
import PositionRollup, { type PositionRollupRow } from "@/components/PositionRollup";
import PositionComparison from "@/components/PositionComparison";
import BestMatchProByPosition from "@/components/BestMatchProByPosition";
import { getPositionRollup } from "@/services/real/positionRollupService";
import PlayerPhvSection from "@/components/player/PlayerPhvSection";
import SprintBestCard from "@/components/player/SprintBestCard";
import ShareablePlayerCard from "@/components/player/ShareablePlayerCard";
import RadarChartComponent from "@/components/RadarChart";
import { EmptyVideo, EmptyInsights, EmptyTracking } from "@/components/illustrations/EmptyIllustrations";
import IdentityCard from "@/components/role-profile/IdentityCard";
import CapabilityCards from "@/components/role-profile/CapabilityCards";
import PositionFitRanking from "@/components/role-profile/PositionFitRanking";
import ArchetypeRanking from "@/components/role-profile/ArchetypeRanking";
import StrengthsRisksPanel from "@/components/role-profile/StrengthsRisksPanel";
import ProjectionComparator from "@/components/role-profile/ProjectionComparator";

// Sprint 20: Behavioral Profiling Dashboard (lazy loaded)
import { lazy } from "react";
const BehavioralDashboard = lazy(() => import("@/components/behavioral/BehavioralDashboard"));

// Sprint 23: Wellbeing — individual player view (lazy loaded)
import { useDropoutRisk, useEngagementHistory, useAttendance } from "@/hooks/useWellbeing";
const DropoutRiskGauge = lazy(() => import("@/components/wellbeing/DropoutRiskGauge"));
const EngagementTimeline = lazy(() => import("@/components/wellbeing/EngagementTimeline"));
const AttendanceCalendar = lazy(() => import("@/components/wellbeing/AttendanceCalendar"));
const OvertrainingAlert = lazy(() => import("@/components/wellbeing/OvertrainingAlert"));

// IDP — Individual Development Plan (lazy loaded)
import { useIDPArchitectInput } from "@/hooks/useIDPArchitectInput";
const IDPDashboard = lazy(() =>
  import("@/components/idp/IDPDashboard").then((m) => ({ default: m.IDPDashboard })),
);

// Sprint 1: Decision-Making Score + Scan IQ
import { useDMScore } from "@/hooks/useDMScore";
import { ScanningVideoAnalyses } from "@/services/real/scanningVideoDetector";
const DMScoreCard = lazy(() =>
  import("@/components/dmscore/DMScoreCard").then((m) => ({ default: m.DMScoreCard })),
);
const ScanIQCard = lazy(() =>
  import("@/components/dmscore/ScanIQCard").then((m) => ({ default: m.ScanIQCard })),
);

// Sprint 2: PHV como producto
import { usePHVProduct, usePHVGate } from "@/hooks/usePHVProduct";
import { PhvGateNotice, usePhvGateText } from "@/components/phv/PhvGateNotice";
const PHVProductCard = lazy(() =>
  import("@/components/phv/PHVProductCard").then((m) => ({ default: m.PHVProductCard })),
);
const MaturityProjectionChart = lazy(() =>
  import("@/components/phv/MaturityProjectionChart").then((m) => ({ default: m.MaturityProjectionChart })),
);
const GrowthSpurtShieldAlert = lazy(() =>
  import("@/components/phv/GrowthSpurtShieldAlert").then((m) => ({ default: m.GrowthSpurtShieldAlert })),
);

// Sprint 11: Injury dashboard
import InjuryRiskCard from "@/components/injury/InjuryRiskCard";
import ACWRHistoryChart from "@/components/injury/ACWRHistoryChart";
import InjuryTimeline from "@/components/injury/InjuryTimeline";
import InjuryLogForm from "@/components/injury/InjuryLogForm";
import { useInjuryRisk } from "@/hooks/useInjuryRisk";
import { usePlan } from "@/hooks/usePlan";
import UpgradePrompt from "@/components/UpgradePrompt";
// Sprint 13: Valuation dashboard
import ValuationCard from "@/components/valuation/ValuationCard";
import TierProgressionChart from "@/components/valuation/TierProgressionChart";
import ProbabilityDisplay from "@/components/valuation/ProbabilityDisplay";
import CeilingComparison from "@/components/valuation/CeilingComparison";
import { useValuation } from "@/hooks/useValuation";

type TabKey = "resumen" | "stats" | "movimiento" | "rol" | "mental" | "salud" | "bienestar" | "plan" | "valoracion" | "historico";

const TABS: Array<{ key: TabKey; labelKey: string; icon: React.ElementType; needsAnalysis?: boolean }> = [
  { key: "resumen",     labelKey: "playerHubPage.tabResumen",     icon: Sparkles },
  { key: "stats",       labelKey: "playerHubPage.tabStats",       icon: Activity,    needsAnalysis: true },
  { key: "movimiento",  labelKey: "playerHubPage.tabMovimiento",  icon: Compass },
  { key: "rol",         labelKey: "playerHubPage.tabRol",         icon: Brain,       needsAnalysis: true },
  { key: "mental",      labelKey: "playerHubPage.tabMental",      icon: Zap,         needsAnalysis: true },
  { key: "salud",       labelKey: "playerHubPage.tabSalud",       icon: Heart },
  { key: "bienestar",   labelKey: "playerHubPage.tabBienestar",   icon: Shield },
  { key: "plan",        labelKey: "playerHubPage.tabPlan",        icon: Target },
  { key: "valoracion",  labelKey: "playerHubPage.tabValoracion",  icon: TrendingUp },
  { key: "historico",   labelKey: "playerHubPage.tabHistorico",   icon: Clock,       needsAnalysis: true },
];

export default function PlayerHubPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = (searchParams.get("tab") as TabKey) || "resumen";
  const [tab, setTab] = useState<TabKey>(tabParam);

  // Sync URL when tab changes
  useEffect(() => {
    if (tab !== tabParam) setSearchParams({ tab }, { replace: true });
  }, [tab, tabParam, setSearchParams]);

  // Player. phvRefresh fuerza re-lectura de localStorage tras guardar datos
  // parentales en PlayerPhvSection (getById no es reactivo por sí solo).
  const [phvRefresh, setPhvRefresh] = useState(0);
  // Fuente del jugador para el API (react-query, reactivo). Con la fuente síncrona
  // (localStorage) sola, un deep-link o un refresh a /players/:id ANTES de que el pull
  // de sync caliente localStorage dejaba la página en "Jugador no encontrado" sin
  // recuperarse. Al caer al jugador del API, la página se re-renderiza cuando resuelve.
  const { data: apiRawPlayer } = useRawPlayerById(id);
  const player: Player | null = useMemo(() => {
    void phvRefresh; // recomputa la lectura de localStorage tras guardar datos parentales
    if (!id) return null;
    return PlayerService.getById(id) ?? apiRawPlayer ?? null;
  }, [id, phvRefresh, apiRawPlayer]);

  // PHV canónico GATEADO (gate único, regla del owner 28-sep): null salvo que estén
  // TODAS las entradas introducidas (talla, peso, sentado, pierna, fecha de
  // nacimiento → edad decimal, sexo). El gate nombra lo que falta.
  const { product: phvProduct, gate: phvGateState } = usePHVGate(id);
  const hasValidPhv = phvProduct !== null;
  const phvGateText = usePhvGateText();

  // Analyses
  const { data: analyses } = useSavedAnalysesV2(id ?? "");
  const latestAnalysis = analyses?.[0];
  const latestReport = latestAnalysis?.report;
  const hasAnalysis = !!latestReport;

  // Histórico (docx-13b): scout insights del jugador + vídeos para enlazar.
  // Fallback intacto: si falla el fetch, ambos quedan vacíos y la pestaña degrada.
  const { data: scoutData } = useScoutInsights(id ? { playerId: id } : {});
  const scoutInsights = (id ? scoutData?.insights : []) ?? [];
  const { data: videos } = useVideos(id ?? undefined);
  const videoById = useMemo(() => new Map((videos ?? []).map((v) => [v.id, v])), [videos]);
  const [videoModal, setVideoModal] = useState<VideoRecord | null>(null);

  // Tracking snapshot del Lab
  const [snapshot, setSnapshot] = useState<TrackingSnapshot | null>(null);
  useEffect(() => {
    if (!id) return;
    setSnapshot(PlayerTrackingService.get(id));
    const onFocus = () => id && setSnapshot(PlayerTrackingService.get(id));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [id]);

  // Sprint 11: Injury risk data. GATEADO por pestaña (como useRoleProfile): solo se
  // dispara la llamada IA (injury-risk-calculator) al abrir "salud", no al montar cada
  // ficha → menos latencia y no se gasta presupuesto IA por abrir el Resumen.
  const { canUseValuation } = usePlan();
  const { injuries, riskData, saveInjuries: persistInjuries, injuriesLoading } = useInjuryRisk(tab === "salud" ? id : undefined);
  // Sprint 13: Valuation data. Gateada a la pestaña "valoracion" por la misma razón.
  const { valuationData, valuationLoading } = useValuation(tab === "valoracion" ? id : undefined);
  const [localInjuries, setLocalInjuries] = useState(injuries);
  useEffect(() => { setLocalInjuries(injuries); }, [injuries]);
  const { canUseInjuryPrediction } = usePlan();

  // ACWR history for chart (from fatigue sessions in tracking snapshot)
  const acwrChartData = useMemo(() => {
    if (!snapshot?.fatigueReport?.acwr) return [];
    const acwr = snapshot.fatigueReport.acwr;
    // Single point from current session; full history needs fatigue_sessions API
    // Sin maduración registrada no hay zona (sin semáforo, P1 bloque 4); la carga
    // ausente queda null (antes 0). Un informe antiguo con "post_phv" sin offset
    // tenía la maduración por defecto: también sin zona.
    const known = maturationKnown(snapshot.fatigueReport.thresholds?.band, snapshot.fatigueReport.thresholds?.phvOffset);
    return [{
      date: new Date().toISOString().slice(0, 10),
      acwr: acwr.value ?? null,
      load: acwr.acuteLoad ?? null,
      zone: (known ? acwr.zone ?? "unknown" : "unknown") as "optimal" | "caution" | "danger" | "undertrained" | "unknown",
    }];
  }, [snapshot]);

  // Position rollup · agregado de todos los videos por posición
  const [positionRollup, setPositionRollup] = useState<PositionRollupRow[]>([]);
  useEffect(() => {
    if (!player) return;
    let cancelled = false;
    getPositionRollup(player).then((r) => { if (!cancelled) setPositionRollup(r); });
    return () => { cancelled = true; };
  }, [player, analyses]);

  // Métricas avanzadas — feeds real Lab data (VAEP + Tracking + Biomechanics)
  const advancedMetrics = useMemo(() => {
    if (!player) return null;
    const playerArg = player as Parameters<typeof calculateAdvancedMetrics>[0];

    // Full pipeline: if snapshot has tactical events, use VideoObservationPacket bridge
    if (snapshot?.tacticalEvents?.length) {
      const packet = labSnapshotToObservationPacket(snapshot);
      return VideoAdvancedMetricsService.calculate(playerArg, packet);
    }

    // Fallback: partial data from positions only
    const trackingInput = snapshot?.focusPositions?.length
      ? TrackingService.fromYoloPositions(
          snapshot.focusPositions.map(p => ({ fx: p.fx, fy: p.fy, timestampMs: p.tMs })),
          snapshot.durationSec / 60,
        )
      : undefined;
    return calculateAdvancedMetrics(playerArg, { trackingInput });
  }, [player, snapshot]);

  // Role profile (lazy · solo si hay análisis y se mira la pestaña)
  const { data: roleData } = useRoleProfile(tab === "rol" ? id : undefined, null);

  // ── Estados principales ─────────────────────────────────────────
  if (!player) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-8 text-center">
        <AlertCircle size={40} className="text-destructive" />
        <p className="font-display font-bold text-lg text-foreground">{t("playerHubPage.playerNotFound")}</p>
        <Button variant="outline" onClick={() => navigate("/equipo")}>
          <ArrowLeft size={16} className="mr-2" />
          {t("playerHubPage.back")}
        </Button>
      </div>
    );
  }

  // Etapa de PHV para el badge del header: SOLO la evaluación gateada (la misma
  // que la sección PHV). La categoría PERSISTIDA ya no cuenta: para un menor sin
  // medidas era un valor naive/estancado (p.ej. «Pre-PHV» sin talla sentado ni
  // fecha de nacimiento). Sin gate abierto el header dice «Sin datos PHV» y el
  // title nombra qué falta. No se toca la fórmula ni %PAH.
  const phvStage: "pre" | "post" | "in" | null =
    phvProduct?.assessment.status === "pre_phv" ? "pre"
    : phvProduct?.assessment.status === "post_phv" ? "post"
    : phvProduct?.assessment.status === "circa_phv" ? "in"
    : null;
  const phvIcon = !hasValidPhv ? "⚪" : phvStage === "pre" ? "🟢" : phvStage === "post" ? "🔵" : phvStage === "in" ? "🟡" : "⚪";
  const phvLabel = !hasValidPhv ? t("playerHubPage.phvNoData") : phvStage === "pre" ? t("playerHubPage.phvPre") : phvStage === "post" ? t("playerHubPage.phvPost") : phvStage === "in" ? t("playerHubPage.phvIn") : t("playerHubPage.phvNoData");
  const phvLabelTitle = phvGateState && !phvGateState.ok ? phvGateText({ gate: phvGateState }) : undefined;

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* ── Header sticky ───────────────────────────────────────── */}
      <header className="sticky top-0 z-30 glass-strong border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate(-1)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label={t("playerHubPage.back")}
            >
              <ArrowLeft size={16} />
            </button>

            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-sm font-display font-bold text-primary shrink-0">
              {player.name.slice(0, 2).toUpperCase()}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <h1 className="font-display font-bold text-base text-foreground truncate">{player.name}</h1>
              <p className="text-[11px] text-muted-foreground truncate">
                {t("playerHubPage.ageYears", { count: player.age })} · {player.position}
                {player.secondaryPositions && player.secondaryPositions.length > 0 && (
                  <span className="text-muted-foreground/70"> / {player.secondaryPositions.join(" / ")}</span>
                )}
                {" · "}<span title={phvLabelTitle}>{phvIcon} {phvLabel}</span>
              </p>
            </div>

            {/* VSI gauge mini */}
            <div className="hidden sm:block">
              <VsiGauge value={player.vsi} size="sm" />
            </div>

            {/* Acciones */}
            {player && <ShareablePlayerCard player={player} />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(`/players/${id}/print?auto=1`, "_blank", "noopener")}
              className="gap-1.5 text-xs"
              title={t("playerHubPage.pdfTitle")}
            >
              <Printer size={12} /> <span className="hidden sm:inline">PDF</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/transfer/new?playerId=${id}`)}
              className="gap-1.5 text-xs"
              title={t("playerHubPage.listTitle")}
            >
              <Briefcase size={12} /> <span className="hidden sm:inline">{t("playerHubPage.list")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/players/${id}/edit`)}
              className="gap-1.5 text-xs"
            >
              <Edit size={12} /> <span className="hidden sm:inline">{t("playerHubPage.edit")}</span>
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-3 overflow-x-auto no-scrollbar">
            {TABS.map((tabItem) => {
              const Icon = tabItem.icon;
              const isActive = tab === tabItem.key;
              // El Histórico deja de necesitar análisis de vídeo si el jugador ya
              // tiene scout insights (el backend los genera con minutos jugados sin
              // vídeo): si no, esos insights quedarían inalcanzables tras el candado.
              const unlockedByInsights = tabItem.key === "historico" && scoutInsights.length > 0;
              const isLocked = tabItem.needsAnalysis && !hasAnalysis && !unlockedByInsights;
              return (
                <button
                  key={tabItem.key}
                  onClick={() => !isLocked && setTab(tabItem.key)}
                  disabled={isLocked}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-display font-semibold transition-all whitespace-nowrap ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isLocked
                        ? "text-muted-foreground/50 cursor-not-allowed"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                  title={isLocked ? t("playerHubPage.requiresVideoAnalysis") : undefined}
                >
                  <Icon size={12} />
                  {t(tabItem.labelKey)}
                  {isLocked && <span className="text-[8px]">🔒</span>}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* ── Contenido ───────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        <AnimatePresence mode="wait">
          {tab === "resumen" && (
            <motion.div
              key="resumen"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              {/* P1 bloque 3: menor de 14 CONOCIDO ⇒ consentimiento del tutor (estado real del
                  servidor + pedir la firma). Sin él no se analizan sus vídeos. */}
              {id && player && (
                <GuardianConsentCard playerId={id} playerName={player.name} birthDate={player.birthDate ?? null} />
              )}

              {/* Sprint 2: PHV como producto — titular arriba del resumen */}
              {id && <PHVProductSection playerId={id} />}

              {/* Radar de métricas base (migrado del perfil clásico al jubilarlo).
                  Siempre disponible: no requiere análisis de vídeo. */}
              {player && (
                <div className="glass rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Brain size={14} className="text-electric" />
                    <h2 className="font-display font-semibold text-sm text-foreground">
                      {t("players.profile.technicalProfile")}
                    </h2>
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {hasValidPhv ? t("players.profile.adjustedByPHV") : t("players.profile.noAdjustPHV")}
                    </span>
                  </div>
                  {player.metrics ? (
                    <RadarChartComponent stats={player.metrics as unknown as Record<string, number>} />
                  ) : (
                    <p className="text-xs text-muted-foreground py-6 text-center">{t("common.notEvaluated")}</p>
                  )}
                </div>
              )}

              {/* Empty state grande si no hay análisis · ilustración + CTAs */}
              {!hasAnalysis && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="glass rounded-2xl p-8 border border-primary/30 bg-gradient-to-br from-primary/5 to-electric/5 space-y-5 text-center"
                >
                  <EmptyVideo className="w-44 mx-auto" />
                  <div className="space-y-2 max-w-md mx-auto">
                    <h2 className="text-2xl font-bold tracking-tight text-foreground">
                      {t("playerHubPage.uploadFirstVideo", { name: player.name })}
                    </h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {t("playerHubPage.unlockDescription")}
                    </p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 max-w-md mx-auto">
                    <Button onClick={() => navigate(`/lab?playerId=${id}`)} className="flex-1 gap-2">
                      <FlaskConical size={14} /> {t("playerHubPage.analyzeInLab")}
                    </Button>
                    <Button variant="outline" onClick={() => navigate(`/reports?playerId=${id}`)} className="gap-2">
                      <Video size={14} /> {t("playerHubPage.uploadVideo")}
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* B1: Talento Oculto · PHV alert */}
              <TalentoOcultoAlert player={player} />

              {/* B2: Confidence badge */}
              <ConfidenceBadge
                videosCount={analyses?.length ?? 0}
                hasTracking={!!snapshot}
                player={player}
              />

              {/* VSI + métricas avanzadas siempre visibles */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="glass rounded-xl p-6 flex flex-col items-center justify-center gap-3">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-bold">{t("playerHubPage.vsiGlobal")}</p>
                  <VsiGauge value={player.vsi} size="xl" showTier />
                  {player.vsiHistory && player.vsiHistory.length > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("playerHubPage.updatesRecorded", { count: player.vsiHistory.length })}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <h3 className="font-display font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    {t("playerHubPage.baseMetrics")}
                  </h3>
                  {!player.metrics ? (
                    <p className="text-xs text-muted-foreground py-2">{t("common.notEvaluated")}</p>
                  ) : (["speed", "technique", "vision", "stamina", "shooting", "defending"] as const).map((k) => {
                    const v = player.metrics![k] ?? 0;
                    return (
                      <div key={k} className="flex items-center gap-2 text-xs">
                        <span className="w-20 text-muted-foreground capitalize">{k}</span>
                        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${v}%` }} />
                        </div>
                        <span className="w-8 text-right font-mono text-foreground">{v}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Solo mostrar Métricas Avanzadas si hay video O snapshot del Lab.
                  Sin datos las cards aparecen como STUB y confunden al coach. */}
              {advancedMetrics && (hasAnalysis || snapshot) && (
                <AdvancedMetricsPanel metrics={advancedMetrics} trackingSnapshot={snapshot} />
              )}

              {/* B3: No evaluado — transparencia radical */}
              <NotEvaluatedSection
                player={player}
                hasAnalysis={hasAnalysis}
                hasTracking={!!snapshot}
                latestReport={latestReport}
              />
            </motion.div>
          )}

          {tab === "stats" && hasAnalysis && (
            <motion.div
              key="stats"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              {latestReport?.metricasCuantitativas ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {t("playerHubPage.statsFromLastVideo", { date: new Date(latestAnalysis!.created_at).toLocaleDateString("es-ES") })}
                  </p>
                  <MatchStatsPanel
                    data={latestReport.metricasCuantitativas}
                    title={t("playerHubPage.statsTitle", { name: player.name })}
                  />
                  {latestReport.metricasCuantitativas.heatmapPositions &&
                    latestReport.metricasCuantitativas.heatmapPositions.length > 0 && (
                    <PlayerHeatmap
                      positions={latestReport.metricasCuantitativas.heatmapPositions}
                      title={t("playerHubPage.heatmapTitle", { name: player.name })}
                    />
                  )}
                </>
              ) : (
                <EmptyAnalysisState
                  playerId={id ?? ""}
                  playerName={player.name}
                  message={t("playerHubPage.oldAnalysisNoStats")}
                />
              )}
            </motion.div>
          )}

          {tab === "movimiento" && (
            <motion.div
              key="movimiento"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              {/* Entrada UNIFICADA de datos PHV (medidas + alturas parentales) —
                  antes solo estaba en el perfil clásico, alcanzable desde Rankings. */}
              {player && (
                <PlayerPhvSection
                  player={player}
                  hasPhv={hasValidPhv}
                  onSaved={() => setPhvRefresh((v) => v + 1)}
                />
              )}
              {/* Mejor sprint MEDIDO (test de puertas) — por encima del tracking
                  derivado: es la física de mayor procedencia del sistema. */}
              <SprintBestCard playerId={id ?? ""} />
              <TrackingSnapshotPanel playerId={id ?? ""} snapshot={snapshot} />
            </motion.div>
          )}

          {tab === "rol" && hasAnalysis && (
            <motion.div
              key="rol"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              {roleData ? (
                <>
                  {/* Header con tier + cita explícita al video fuente */}
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                      roleData.sample_tier === "platinum" ? "bg-purple-100 text-purple-700" :
                      roleData.sample_tier === "gold" ? "bg-yellow-100 text-yellow-700" :
                      roleData.sample_tier === "silver" ? "bg-gray-100 text-gray-700" :
                      "bg-orange-100 text-orange-700"
                    }`}>
                      {roleData.sample_tier === "platinum" ? t("playerHubPage.tierPlatinum") : roleData.sample_tier === "gold" ? t("playerHubPage.tierGold") : roleData.sample_tier === "silver" ? t("playerHubPage.tierSilver") : t("playerHubPage.tierBronze")}
                      {" · "}{Math.round(roleData.overall_confidence * 100)}%
                    </span>
                    {roleData.source_videos && roleData.source_videos.length > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {t("playerHubPage.basedOnVideos", { count: roleData.source_videos.length, date: new Date(roleData.source_videos[0].analyzed_at).toLocaleDateString("es-ES") })}
                      </span>
                    )}
                  </div>

                  {/* Acciones del perfil de rol · antes /compare y /audit no tenían
                      ningún punto de entrada en la UI (rutas huérfanas). */}
                  {id && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => navigate(`/players/${id}/role-profile/compare`)}
                      >
                        <GitCompare size={14} />
                        {t("playerHubPage.compareRole")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => navigate(`/players/${id}/role-profile/audit`)}
                      >
                        <ClipboardList size={14} />
                        {t("playerHubPage.auditRole")}
                      </Button>
                    </div>
                  )}

                  {/* Banner descubrimiento · sugiere añadir nuevas posiciones detectadas en video */}
                  {Array.isArray((roleData as { positionAlternatives?: Array<{ code: string; fit: number; alreadyDeclared: boolean; reason: string; confidence: number }> }).positionAlternatives) && (
                    <PositionDiscoveryBanner
                      player={player}
                      alternatives={(roleData as unknown as { positionAlternatives: Array<{ code: string; fit: number; alreadyDeclared: boolean; reason: string; confidence: number }> }).positionAlternatives}
                    />
                  )}

                  {/* Rollup agregado por posición · todos los videos */}
                  <PositionRollup player={player} rows={positionRollup} />

                  {/* Comparativa por posición · solo si polivalente con datos */}
                  <PositionComparison rows={positionRollup} />

                  {/* Referentes pro por posición declarada */}
                  <BestMatchProByPosition player={player} />

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <IdentityCard data={roleData} />
                    <div className="lg:col-span-2"><CapabilityCards data={roleData} filters={null} /></div>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <PositionFitRanking data={roleData} filters={null} />
                    <ArchetypeRanking data={roleData} />
                  </div>
                  <StrengthsRisksPanel data={roleData} />
                  <ProjectionComparator data={roleData} />

                  {/* Cita explícita de los videos fuente al final del informe */}
                  {roleData.source_videos && roleData.source_videos.length > 0 && (
                    <div className="glass rounded-xl p-4 border-l-4 border-primary/40 text-xs text-muted-foreground">
                      <p className="font-display font-semibold text-foreground mb-1">{t("playerHubPage.reportSource")}</p>
                      <p>
                        {t("playerHubPage.reportSourceDescription", { count: roleData.source_videos.length, name: player.name })}
                      </p>
                      <ul className="mt-2 space-y-0.5">
                        {roleData.source_videos.slice(0, 3).map((v, i) => (
                          <li key={i}>{t("playerHubPage.videoAnalyzedItem", { id: v.video_id.slice(0, 8), date: new Date(v.analyzed_at).toLocaleString("es-ES") })}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : IS_DEMO ? (
                <div className="glass rounded-xl p-6 text-center">
                  <Compass size={20} className="mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "playerHubPage.roleProfileDemoUnavailable",
                      "El perfil de rol se genera a partir del análisis de vídeo, no incluido en esta demo de ejemplo.",
                    )}
                  </p>
                </div>
              ) : (
                <div className="glass rounded-xl p-6 text-center">
                  <Sparkles size={20} className="mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">{t("playerHubPage.generatingRoleProfile")}</p>
                </div>
              )}
            </motion.div>
          )}

          {/* Sprint 20: Mental / Behavioral Profiling + Sprint 1: DM-Score */}
          {tab === "mental" && id && (
            <motion.div
              key="mental"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-4"
            >
              <DMScoreSection playerId={id} />
              <BehavioralDashboard playerId={id} />
            </motion.div>
          )}

          {/* Sprint 11: Salud / Injury Prediction */}
          {tab === "salud" && (
            <motion.div
              key="salud"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {!canUseInjuryPrediction ? (
                <div className="relative">
                  <div className="blur-sm pointer-events-none select-none space-y-4">
                    <div className="glass rounded-2xl p-8 h-48" />
                    <div className="glass rounded-2xl p-8 h-32" />
                  </div>
                  <UpgradePrompt feature={t("playerHubPage.injuryPredictionFeature")} requiredPlan="pro" variant="overlay" />
                </div>
              ) : (
                <div className="space-y-4">
                  {/* En demo la predicción de lesión es determinística de ejemplo
                      (no un modelo entrenado sobre datos reales del menor). */}
                  {IS_DEMO && <DemoDataBanner />}
                  {/* Sprint 2.5: Escudo de Estirón (PHV × lesión) */}
                  {id && <GrowthSpurtShieldSection playerId={id} />}
                  {riskData && <InjuryRiskCard data={riskData} />}
                  {!riskData && !injuriesLoading && (
                    <div className="glass rounded-xl p-6 text-center">
                      <Heart size={20} className="mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">{t("playerHubPage.analyzeSessionForRisk")}</p>
                    </div>
                  )}
                  {/* P1 bloque 4: fuera PhvRiskOverlay. Leía la maduración de un
                      informe de fatiga GUARDADO (no de la puerta del PHV) y era una
                      cuarta definición de «ventana PHV»; el Escudo de Estirón de
                      arriba ya lo muestra desde la puerta. */}
                  <div className="glass rounded-2xl p-4">
                    <ACWRHistoryChart data={acwrChartData} />
                  </div>
                  <div className="glass rounded-2xl p-4">
                    <InjuryTimeline injuries={localInjuries} />
                  </div>
                  <div className="glass rounded-2xl p-4">
                    <InjuryLogForm
                      playerId={id ?? ""}
                      injuries={localInjuries}
                      onChange={setLocalInjuries}
                      onSave={(injs) => persistInjuries(injs)}
                    />
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Sprint 23: Bienestar / Wellbeing */}
          {tab === "bienestar" && id && (
            <motion.div
              key="bienestar"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <WellbeingTab playerId={id} />
            </motion.div>
          )}

          {/* IDP: Plan de Desarrollo Individual mensual */}
          {tab === "plan" && id && (
            <motion.div
              key="plan"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <IDPTab playerId={id} />
            </motion.div>
          )}

          {/* Sprint 13: Valoracion */}
          {tab === "valoracion" && (
            <motion.div
              key="valoracion"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {!canUseValuation ? (
                <div className="relative">
                  <div className="blur-sm pointer-events-none select-none space-y-4">
                    <div className="glass rounded-2xl p-8 h-48" />
                    <div className="glass rounded-2xl p-8 h-32" />
                  </div>
                  <UpgradePrompt feature={t("playerHubPage.valuationFeature")} requiredPlan="pro" variant="overlay" />
                </div>
              ) : valuationLoading ? (
                <div className="glass rounded-xl p-6 text-center">
                  <Zap size={20} className="mx-auto text-muted-foreground mb-2 animate-pulse" />
                  <p className="text-sm text-muted-foreground">{t("playerHubPage.calculatingValuation")}</p>
                </div>
              ) : valuationData ? (
                <div className="space-y-4">
                  {/* En demo la valoración deriva de datos de ejemplo, no de mercado real. */}
                  {IS_DEMO && <DemoDataBanner />}
                  <ValuationCard data={valuationData} />
                  {/* P1 bloque 4b: sin valoración calculada no hay probabilidades ni tier. */}
                  {valuationData.overallScore !== null && valuationData.probabilities && valuationData.tier && (
                    <>
                      <div className="glass rounded-2xl p-4">
                        <ProbabilityDisplay
                          probabilities={valuationData.probabilities}
                          tierColor={valuationData.tierColor}
                        />
                      </div>
                      <div className="glass rounded-2xl p-4">
                        <TierProgressionChart data={[]} />
                      </div>
                      <div className="glass rounded-2xl p-4">
                        <CeilingComparison comparables={[]} tier={valuationData.tier} tierColor={valuationData.tierColor} />
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="glass rounded-xl p-6 text-center">
                  <Zap size={20} className="mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">{t("playerHubPage.analyzeSessionForValuation")}</p>
                </div>
              )}
            </motion.div>
          )}

          {tab === "historico" && (
            <motion.div
              key="historico"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {/* Scout insights del jugador (docx-13b). Enlace "Ver vídeo" solo si el
                  origen persistido (source_video_id) resuelve a un vídeo real; si no,
                  el card se abstiene del enlace (nunca adivina un vídeo). */}
              {scoutInsights.length > 0 && (
                <section className="mb-6 space-y-3">
                  <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-1.5">
                    <Sparkles size={14} className="text-primary" /> {t("playerHubPage.insightsTitle")}
                  </h3>
                  {scoutInsights.map((insight) => {
                    const srcId = insight.context_data?.source_video_id as string | undefined;
                    const vid = srcId ? videoById.get(srcId) : undefined;
                    return (
                      <InsightCard
                        key={insight.id}
                        insight={insight}
                        showViewPlayer={false}
                        onViewVideo={vid ? () => setVideoModal(vid) : undefined}
                      />
                    );
                  })}
                </section>
              )}

              {analyses && analyses.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-display font-bold text-foreground flex items-center gap-1.5">
                    <Video size={14} className="text-primary" /> {t("playerHubPage.analysesTitle")}
                  </h3>
                  <div className="glass rounded-xl divide-y divide-border">
                    {analyses.map((a) => {
                      const vid = a.video_id ? videoById.get(a.video_id) : undefined;
                      return (
                        <button
                          key={a.id}
                          onClick={() => {
                            if (vid) setVideoModal(vid);
                            else toast.info(t("playerHubPage.noVideoForAnalysis"));
                          }}
                          className="w-full flex items-center gap-3 p-4 hover:bg-secondary/30 transition-colors text-left"
                        >
                          <div className="w-9 h-9 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                            <Video size={14} className="text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-display font-semibold text-foreground">
                              {t("playerHubPage.analysisDate", { date: new Date(a.created_at).toLocaleDateString("es-ES") })}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              VSI {a.vsi ?? "—"}{vid ? ` · ${t("playerHubPage.withVideo")}` : ""}
                            </p>
                          </div>
                          {vid
                            ? <Play size={14} className="text-primary" />
                            : <ChevronRight size={14} className="text-muted-foreground" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : scoutInsights.length === 0 ? (
                <EmptyAnalysisState playerId={id ?? ""} playerName={player.name} />
              ) : null}

              {/* Modal de reproducción del vídeo referenciado */}
              {videoModal && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
                  onClick={() => setVideoModal(null)}
                >
                  <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end mb-2">
                      <button
                        onClick={() => setVideoModal(null)}
                        className="p-2 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors"
                        title={t("common.close")}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <VideoPlayer video={videoModal} autoplay />
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Tabs bloqueados pero el usuario hace click sin ser posible · fallback */}
          {(tab === "stats" || tab === "rol") && !hasAnalysis && (
            <motion.div
              key="locked"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <EmptyAnalysisState playerId={id ?? ""} playerName={player.name} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// ── Wellbeing Tab (Sprint 23) ────────────────────────────────────

function WellbeingTab({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const { data: risk, isLoading: riskLoading } = useDropoutRisk(playerId);
  const { data: engagement } = useEngagementHistory(playerId);
  const { data: attendance } = useAttendance(playerId);

  // `risk === null` ⇒ SIN CALCULAR (sin registros reales): se dice, no se pinta 0 · «bajo».
  if (riskLoading || risk === undefined) {
    return (
      <div className="glass rounded-xl p-6 text-center">
        <Heart size={24} className="text-muted-foreground mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">{t("playerHubPage.loadingWellbeing")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* MOCK sin banner = inválido (CLAUDE.md inv #4). El riesgo, el engagement y la
          asistencia pueden ser de ejemplo de forma INDEPENDIENTE (p.ej. jugador con
          fatiga real de vídeo pero sin cuestionario/asistencia → risk.isMock=false pero
          engagement/asistencia salen de fallback). Rotulamos si CUALQUIERA es mock,
          igual que el dashboard de Bienestar autónomo (WellbeingDashboard.tsx). */}
      {(risk?.isMock || engagement?.some((e) => e.isMock) || attendance?.isMock) && (
        <DemoDataBanner messageKey="demoData.wellbeing" />
      )}
      {risk ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <DropoutRiskGauge
            score={risk.riskScore}
            riskLevel={risk.riskLevel}
            primaryFactor={risk.primaryFactor}
            factors={risk.factors}
          />
          <OvertrainingAlert
            risk={risk.overtraining.risk}
            riskLevel={risk.overtraining.riskLevel}
            currentLoadAU={risk.overtraining.currentLoadAU}
            recommendedLoadAU={risk.overtraining.recommendedLoadAU}
            adjustmentPct={risk.overtraining.adjustmentPct}
            gateCode={risk.overtraining.gate_code ?? null}
          />
        </div>
      ) : (
        <p className="glass rounded-xl p-4 text-xs text-muted-foreground">{t("wellbeingDashboard.riskNotCalculated")}</p>
      )}

      {engagement && engagement.length > 0 && (
        <EngagementTimeline
          data={engagement.map(e => ({
            date: e.date,
            engagementScore: e.engagementScore,
            physicalEngagement: e.physicalEngagement,
            socialEngagement: e.socialEngagement,
            emotionalEngagement: e.emotionalEngagement,
          }))}
        />
      )}

      {/* Solo con asistencia REGISTRADA (o el ejemplo del demo, con banner): sin
          registros no se pinta un calendario inventado (inv #4). */}
      {attendance && (attendance.isMock || attendance.records.length > 0) && (
        <AttendanceCalendar
          records={attendance.records.map(r => ({ date: r.date, status: r.status }))}
          rate={attendance.rate ?? undefined}
        />
      )}
    </div>
  );
}

// ── DM-Score Section (Sprint 1: Decision-Making + Scan IQ) ────────

function DMScoreSection({ playerId }: { playerId: string }) {
  const { data } = useDMScore(playerId);
  if (!data) return null;

  const latestScan = ScanningVideoAnalyses.getLatestForPlayer(playerId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <DMScoreCard result={data.dmScore} />
      {data.scanIQ && (
        <ScanIQCard
          result={data.scanIQ}
          source={data.scanSource}
          stats={
            latestScan
              ? {
                  receptionsAnalyzed: latestScan.receptionsAnalyzed,
                  successWithScan: latestScan.successWithScan,
                  successWithoutScan: latestScan.successWithoutScan,
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

// ── PHV como producto (Sprint 2) ──────────────────────────────────

function PHVProductSection({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const { product: phv, gate, pah } = usePHVGate(playerId);
  if (!gate) return null;
  // Gate cerrado: se NOMBRA qué falta (regla del owner) en vez de ocultar la
  // sección en silencio. El %talla adulta es otra métrica con su propio gate y se
  // rotula como tal, nunca como PHV.
  if (!phv) {
    return (
      <div className="space-y-2">
        <PhvGateNotice variant="card" gate={gate} />
        {pah?.ok && pah.percent.value !== null && (
          <p className="text-[11px] text-muted-foreground px-1" data-testid="pah-only">
            {t("maturity.percentPAH")}: <span className="font-semibold text-foreground">{pah.percent.value}%</span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <PHVProductCard data={phv} />
      {phv.projection && <MaturityProjectionChart projection={phv.projection} />}
    </div>
  );
}

function GrowthSpurtShieldSection({ playerId }: { playerId: string }) {
  const phv = usePHVProduct(playerId);
  if (!phv) return null;
  return <GrowthSpurtShieldAlert shield={phv.shield} audience="coach" />;
}

// ── IDP Tab (Plan de Desarrollo Individual) ───────────────────────

function IDPTab({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const { architectInput, liveMetrics, playerName, loading, dataRichness } =
    useIDPArchitectInput(playerId);

  if (loading || !architectInput) {
    return (
      <div className="glass rounded-xl p-6 text-center">
        <Target size={24} className="text-muted-foreground mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">{t("playerHubPage.loadingPlayerData")}</p>
      </div>
    );
  }

  return (
    <IDPDashboard
      playerId={playerId}
      playerName={playerName}
      architectInput={architectInput}
      liveMetrics={liveMetrics}
      dataRichness={dataRichness}
    />
  );
}

// ── Empty state reusable ──────────────────────────────────────────

function EmptyAnalysisState({
  playerId, playerName, message,
}: { playerId: string; playerName: string; message?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="glass rounded-2xl p-6 border border-dashed border-border space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
          <Zap size={20} className="text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="font-display font-bold text-base text-foreground">
            {message ?? t("playerHubPage.noAnalysisYet", { name: playerName })}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t("playerHubPage.emptyAnalysisDescription")}
          </p>
        </div>
      </div>
      <Button onClick={() => navigate(`/lab?playerId=${playerId}`)} className="w-full gap-2">
        <FlaskConical size={14} /> {t("playerHubPage.analyzeInLab")}
      </Button>
    </div>
  );
}
