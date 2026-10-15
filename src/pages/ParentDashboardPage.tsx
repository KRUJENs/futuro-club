/**
 * VITAS · Parent Dashboard (Sprint B4 · día 1-2)
 * /family/:playerId
 *
 * Vista padre/madre · simplificada, sin jerga técnica. Pensada para que
 * cualquier familia entienda el progreso de su hijo en 30 segundos:
 *   - Score VSI grande + variación SOLO entre dos evaluaciones con fecha (con esas fechas)
 *   - Badges/logros desbloqueados
 *   - Última medición + cuándo toca la próxima
 *   - Botón "Compartir progreso" (genera share-link al último análisis)
 *   - Mini-resumen del último análisis con lenguaje claro
 *
 * Cero rutas técnicas · cero gauges complejos · todo en español llano.
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  ArrowLeft, Heart, Trophy, Star, TrendingUp, TrendingDown,
  Calendar, Activity, Share2, Loader2, Sparkles, Award,
} from "lucide-react";
import { toast } from "sonner";
import { PlayerService } from "@/services/real/playerService";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import { useRawPlayerById } from "@/hooks/usePlayers";
import { getAuthHeaders } from "@/lib/apiAuth";
import PeerBenchmark from "@/components/PeerBenchmark";
import DemoDataBanner from "@/components/DemoDataBanner";
import { useDropoutRisk, useEngagementHistory } from "@/hooks/useWellbeing";
import { useCurrentIDP } from "@/hooks/useIDP";
import { IDPParentView } from "@/components/idp/IDPParentView";
import { usePHVProduct } from "@/hooks/usePHVProduct";
import { phvGate } from "@/lib/phv/phvGate";
import { PhvGateNotice } from "@/components/phv/PhvGateNotice";
import { GrowthSpurtShieldAlert } from "@/components/phv/GrowthSpurtShieldAlert";
import { GuardianConsentCard } from "@/components/legal/GuardianConsentCard";
import { Shield } from "lucide-react";
import { PlayerTrackingService } from "@/services/real/playerTrackingService";
import { maturationKnown } from "@/lib/fatigue/phvFatigueAdjuster";
import { computeVsiDelta } from "@/lib/scoring/vsiDelta";
import { coachEvalTier } from "@/services/real/metricsService";
import { COACH_EVAL_TIERS } from "../../config/coachEvaluation";
import { MetricValue } from "@/components/metrics/MetricValue";

interface Badge {
  id: string;
  emoji: string;
  title: string;
  description: string;
  unlocked: boolean;
  date?: string;
}

const PHV_EMOJIS: Record<string, string> = {
  early: "🌱",
  ontime: "🚀",
  late: "🏆",
};

export default function ParentDashboardPage() {
  const { t, i18n } = useTranslation();
  const { playerId } = useParams<{ playerId: string }>();
  const navigate = useNavigate();
  const player = playerId ? PlayerService.getById(playerId) : null;
  const { data: rawPlayer } = useRawPlayerById(playerId);
  const { data: analyses = [] } = useSavedAnalysesV2(playerId ?? "");
  const [sharing, setSharing] = useState(false);

  if (!player) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center">
        <div className="space-y-3">
          <Heart size={32} className="text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">{t("parentDashboardPage.playerNotFound")}</p>
          <button onClick={() => navigate("/")} className="text-xs text-primary font-bold">← {t("parentDashboardPage.home")}</button>
        </div>
      </div>
    );
  }

  // ─── Cálculos ──────────────────────────────────────────────────
  // vsi null ⇒ jugador sin evaluar: NUNCA se muestra un "0 / de 100" fabricado a la
  // familia de un menor (invariante #2). El héroe se nombra "sin evaluar".
  const vsiCurrent: number | null =
    typeof rawPlayer?.vsi === "number" && Number.isFinite(rawPlayer.vsi) ? rawPlayer.vsi : null;
  const vsiRated = vsiCurrent !== null;
  // Variación SOLO entre dos evaluaciones reales con fecha y origen (fuente única:
  // src/lib/scoring/vsiDelta.ts). Antes se restaba vsiHistory[len-4] — un historial sin
  // fechas, con 57.5 fabricados — y se rotulaba «vs hace 1 mes»: una fecha inventada.
  const vsiDelta = computeVsiDelta({
    evaluations: rawPlayer?.vsiEvaluations,
    legacyHistory: rawPlayer?.vsiHistory,
    currentVsi: vsiCurrent,
  });
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "short", year: "numeric" }) : "";

  // Fase de estirón SOLO desde el gate único de PHV (regla del owner 28-sep).
  const phvGateResult = phvGate(rawPlayer ?? player);
  const phvPhaseKey = phvGateResult.category === "ontme" ? "ontime" : phvGateResult.category ?? "";

  const totalReports = analyses.length;
  const latestAnalysis = analyses[0];
  const latestReport = latestAnalysis?.report as { estadoActual?: { resumenEjecutivo?: string; nivelActual?: string } } | undefined;

  // Badges · client-side rules sobre datos ya disponibles
  const badges: Badge[] = [
    {
      id: "first-measurement",
      emoji: "📏",
      title: t("parentDashboardPage.badgeFirstMeasurementTitle"),
      description: t("parentDashboardPage.badgeFirstMeasurementDesc"),
      unlocked: !!rawPlayer?.height && !!rawPlayer?.weight,
    },
    {
      id: "phv-tracked",
      emoji: "🧬",
      title: t("parentDashboardPage.badgePhvTrackedTitle"),
      description: t("parentDashboardPage.badgePhvTrackedDesc"),
      // Solo con PHV REAL (gate único: todas las entradas introducidas), no por
      // tener un phvCategory persistido (naive para un menor sin medidas).
      unlocked: phvGateResult.ok,
    },
    {
      id: "first-report",
      emoji: "📋",
      title: t("parentDashboardPage.badgeFirstReportTitle"),
      description: t("parentDashboardPage.badgeFirstReportDesc"),
      unlocked: totalReports >= 1,
    },
    {
      id: "consistent",
      emoji: "🔥",
      title: t("parentDashboardPage.badgeConsistentTitle"),
      description: t("parentDashboardPage.badgeConsistentDesc"),
      unlocked: totalReports >= 5,
    },
    {
      id: "improving",
      emoji: "📈",
      title: t("parentDashboardPage.badgeImprovingTitle"),
      description: t("parentDashboardPage.badgeImprovingDesc"),
      // Solo con una subida CALCULADA entre dos evaluaciones con fecha.
      unlocked: vsiDelta.value !== null && vsiDelta.value >= 2,
    },
    {
      id: "elite",
      emoji: "👑",
      title: t("parentDashboardPage.badgeEliteTitle"),
      // Tramo Pro o superior con los cortes ÚNICOS de la evaluación del entrenador (P1
      // bloque 5b). Antes «Talento» a partir de 70, cuando 70 es el inicio del tramo Pro.
      description: t("parentDashboardPage.badgeEliteDesc", {
        min: COACH_EVAL_TIERS.find((x) => x.tier === "pro")?.min,
      }),
      unlocked: vsiCurrent !== null && ["pro", "elite"].includes(coachEvalTier(vsiCurrent)),
    },
  ];

  const unlockedCount = badges.filter((b) => b.unlocked).length;

  // ─── Compartir ─────────────────────────────────────────────────
  async function handleShare() {
    if (!latestAnalysis?.id || sharing) {
      toast.info(t("parentDashboardPage.noReportsShareInfo"));
      return;
    }
    setSharing(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/analyses/share?analysisId=${latestAnalysis.id}`, {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error?.message ?? t("parentDashboardPage.linkGenerationError"));
      }
      const fullUrl = `${window.location.origin}${data.data.url}`;
      // Sin evaluar (vsi null): no se comparte a la familia un "VSI: 0 (+0 pts)"
      // fabricado (invariante #2) — se dice "sin evaluar" y sin delta. La variación
      // solo viaja si se CALCULÓ entre dos evaluaciones con fecha, y con esas fechas.
      const d = vsiDelta.value;
      const deltaLabel = !vsiRated || d === null
        ? ""
        : t("parentDashboardPage.shareDelta", {
            arrow: d >= 0 ? "↗" : "↘",
            value: `${d > 0 ? "+" : ""}${d}`,
            from: fmtDate(vsiDelta.from_at),
            to: fmtDate(vsiDelta.to_at),
          });
      const text = t("parentDashboardPage.shareText", {
        name: player.name,
        vsi: vsiRated ? vsiCurrent : t("common.notEvaluated"),
        delta: deltaLabel,
        unlockedCount,
        totalBadges: badges.length,
        url: fullUrl,
      });

      if (navigator.share) {
        try { await navigator.share({ title: `${player.name} · VITAS`, text, url: fullUrl }); toast.success(t("parentDashboardPage.shared")); return; } catch { /* canceled */ }
      }
      await navigator.clipboard.writeText(text);
      toast.success(t("parentDashboardPage.whatsappCopied"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("parentDashboardPage.genericError"));
    } finally {
      setSharing(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background pb-28">
      {/* Header sticky simple */}
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">
              {player.name}
            </h1>
            <p className="text-[10px] text-muted-foreground">{t("parentDashboardPage.familyViewProgress")}</p>
          </div>
          <Heart size={16} className="text-pink-400" />
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-md mx-auto">
        {/* Consentimiento del tutor (RGPD, menores de 14): estado REAL del servidor. Antes un
            botón «Soy el tutor, conceder» escribía un rótulo que el gate nunca contaba. */}
        <GuardianConsentCard playerId={player.id} playerName={player.name} birthDate={player.birthDate ?? null} />

        {/* VSI hero · grande, claro */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass rounded-3xl p-6 text-center bg-gradient-to-br from-primary/15 via-electric/10 to-transparent"
        >
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1">
            {t("parentDashboardPage.currentLevel")}
          </div>
          {vsiCurrent !== null ? (
            <>
              <div className="font-display font-bold text-6xl text-foreground leading-none">
                {Math.round(vsiCurrent)}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">{t("parentDashboardPage.outOf100VsiScore")}</div>
            </>
          ) : (
            <div className="font-display font-semibold text-2xl text-muted-foreground leading-none py-2">
              {t("common.notEvaluated")}
            </div>
          )}

          {/* Variación: calculada entre dos evaluaciones con fecha (se muestran las
              fechas reales) o, si no se puede, su motivo — nunca una fecha inventada. */}
          {vsiRated && (
            vsiDelta.value !== null ? (
              <div data-testid="family-vsi-delta" className="mt-3 flex flex-col items-center gap-1">
                <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-display font-bold ${
                  vsiDelta.value > 0 ? "bg-green-400/15 text-green-400"
                  : vsiDelta.value < 0 ? "bg-red-400/15 text-red-400"
                  : "bg-secondary text-muted-foreground"
                }`}>
                  {vsiDelta.value > 0 ? <TrendingUp size={12} /> : vsiDelta.value < 0 ? <TrendingDown size={12} /> : null}
                  <MetricValue
                    result={vsiDelta}
                    format={(v, u) => `${Number(v) > 0 ? "+" : ""}${v}${u ? ` ${u}` : ""}`}
                  />
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {t("parentDashboardPage.vsiDeltaBetween", {
                    from: fmtDate(vsiDelta.from_at),
                    to: fmtDate(vsiDelta.to_at),
                  })}
                </div>
              </div>
            ) : (
              <div data-testid="family-vsi-delta-gated" className="mt-3">
                <MetricValue
                  className="text-[10px]"
                  result={{
                    ...vsiDelta,
                    gate_reason: vsiDelta.gate_code
                      ? t(`vsiDelta.gate.${vsiDelta.gate_code}`, { defaultValue: vsiDelta.gate_reason ?? "" })
                      : vsiDelta.gate_reason,
                  }}
                />
              </div>
            )
          )}

          {phvGateResult.ok ? (
            <div className="mt-3 text-[11px] text-foreground">
              {t("parentDashboardPage.phaseLabel")} <span className="font-display font-bold">{`${PHV_EMOJIS[phvPhaseKey] ?? ""} ${t(`parentDashboardPage.phv_${phvPhaseKey}`)}`}</span>
            </div>
          ) : rawPlayer ? (
            <PhvGateNotice className="mt-3 block text-[11px]" gate={phvGateResult} />
          ) : null}
        </motion.div>

        {/* Quick stats simples */}
        <div className="grid grid-cols-3 gap-2">
          <SimpleStat label={t("parentDashboardPage.statAge")} value={`${rawPlayer?.age ?? "—"}a`} Icon={Calendar} />
          <SimpleStat label={t("parentDashboardPage.statPosition")} value={rawPlayer?.position?.split(" ")[0] ?? "—"} Icon={Activity} />
          <SimpleStat label={t("parentDashboardPage.statReports")} value={String(totalReports)} Icon={Star} />
        </div>

        {/* Logros · gamification */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Award size={14} className="text-gold" />
              <span className="text-xs font-display font-bold text-foreground">{t("parentDashboardPage.achievements")}</span>
            </div>
            <span className="text-[11px] font-display font-bold text-gold">
              {unlockedCount} / {badges.length}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {badges.map((b) => (
              <div
                key={b.id}
                className={`rounded-xl p-2 text-center transition-all ${
                  b.unlocked
                    ? "bg-gold/10 border-2 border-gold/40"
                    : "bg-secondary/30 border border-border opacity-50 grayscale"
                }`}
                title={b.description}
              >
                <div className="text-2xl mb-0.5">{b.emoji}</div>
                <div className={`text-[9px] font-display font-bold leading-tight ${b.unlocked ? "text-foreground" : "text-muted-foreground"}`}>
                  {b.title}
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Escudo de Estirón · versión padre (canal B2C Plan Familia) */}
        <ParentGrowthSpurtSection playerId={playerId!} />

        {/* Plan del mes · IDP versión padre */}
        <ParentIDPSection playerId={playerId!} />

        {/* Estado Físico · para padres (lenguaje simple) */}
        <PhysicalStatusCard playerId={playerId!} />

        {/* Comparación con los propios jugadores del entrenador (percentil único, mín. 10 pares) */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }} className="glass rounded-2xl p-4">
          <PeerBenchmark playerId={playerId!} variant="full" />
        </motion.div>

        {/* Último análisis · resumen claro */}
        {latestReport?.estadoActual?.resumenEjecutivo && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="glass rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={13} className="text-primary" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
                {t("parentDashboardPage.latestAnalysisSummary")}
              </span>
            </div>
            <p className="text-sm text-foreground leading-relaxed">
              {latestReport.estadoActual.resumenEjecutivo}
            </p>
            <button
              onClick={() => navigate(`/players/${playerId}/reports`)}
              className="mt-3 text-xs text-primary font-bold hover:text-primary/80"
            >
              {t("parentDashboardPage.viewAllReports")} →
            </button>
          </motion.div>
        )}

        {/* CTA Compartir */}
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          onClick={handleShare}
          disabled={sharing}
          className="w-full glass rounded-2xl p-4 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border-2 border-primary/30 disabled:opacity-50"
        >
          <div className="w-11 h-11 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
            {sharing ? <Loader2 size={18} className="animate-spin text-primary" /> : <Share2 size={18} className="text-primary" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-display font-bold text-foreground">{t("parentDashboardPage.shareProgress")}</div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t("parentDashboardPage.shareProgressSubtitle")}
            </div>
          </div>
        </motion.button>

        {/* CTAs secundarios */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => navigate(`/players/${playerId}`)}
            className="rounded-xl bg-secondary/30 border border-border p-3 hover:bg-secondary/50 text-center transition-colors"
          >
            <Activity size={14} className="text-electric mx-auto mb-1" />
            <div className="text-[11px] font-display font-bold text-foreground">{t("parentDashboardPage.fullProfile")}</div>
          </button>
          <button
            onClick={() => navigate(`/players/${playerId}/evolution`)}
            className="rounded-xl bg-secondary/30 border border-border p-3 hover:bg-secondary/50 text-center transition-colors"
          >
            <TrendingUp size={14} className="text-green-400 mx-auto mb-1" />
            <div className="text-[11px] font-display font-bold text-foreground">{t("parentDashboardPage.evolution")}</div>
          </button>
        </div>

        {/* Wellbeing section (Sprint 23) */}
        <ParentWellbeingSection playerId={playerId ?? ""} />

        {/* Empty state si no hay análisis */}
        {totalReports === 0 && (
          <div className="glass rounded-2xl p-5 text-center space-y-2">
            <Trophy size={28} className="text-muted-foreground mx-auto" />
            <p className="text-xs font-display font-bold text-foreground">
              {t("parentDashboardPage.noAnalysisYet")}
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t("parentDashboardPage.noAnalysisYetDesc")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Wellbeing for parents (Sprint 23) ───────────────────────────
// Exportado para el guard de honestidad (G5): un test verifica que, cuando el
// bienestar es MOCK (`risk.isMock`), esta vista de cliente SIEMPRE muestra el
// DemoDataBanner. Ver src/test/components/G5ProductHonesty.test.tsx.
export function ParentWellbeingSection({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const { data: risk } = useDropoutRisk(playerId || undefined);
  const { data: engagement } = useEngagementHistory(playerId || undefined);

  if (!risk || !playerId) return null;

  // null = sin implicación real registrada: se dice, nunca una barra roja de «disfrute
  // bajo» a partir de un 0 (P1 bloque 4).
  const enjoyment = risk.engagement;
  const engagementTrend = enjoyment?.trend ?? null;
  const tips = [
    t("parentDashboardPage.tip1"),
    t("parentDashboardPage.tip2"),
    t("parentDashboardPage.tip3"),
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <Heart size={14} className="text-rose-400" />
        <span className="text-[11px] font-display font-bold text-foreground">{t("parentDashboardPage.wellbeing")}</span>
      </div>

      {/* Banner honesto (G5): si el bienestar es MOCK de demostración (aún sin
          cuestionarios/asistencia/engagement reales), el padre debe saberlo. Antes
          salía sin aviso; la vista de equipo sí lo tenía. */}
      {risk?.isMock && <DemoDataBanner messageKey="demoData.wellbeing" />}

      {/* Engagement bar */}
      {!enjoyment ? (
        <p className="text-[10px] text-muted-foreground" data-testid="enjoyment-no-data">
          {t("parentDashboardPage.enjoymentNoData")}
        </p>
      ) : (
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{t("parentDashboardPage.enjoymentLevel")}</span>
          <span className={`text-[10px] font-bold ${
            engagementTrend === "declining" ? "text-amber-400" :
            engagementTrend === "improving" ? "text-emerald-400" :
            "text-muted-foreground"
          }`}>
            {engagementTrend === "declining" ? `↓ ${t("parentDashboardPage.trendDeclining")}` :
             engagementTrend === "improving" ? `↑ ${t("parentDashboardPage.trendImproving")}` :
             `→ ${t("parentDashboardPage.trendStable")}`}
          </span>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              enjoyment.current >= 65 ? "bg-emerald-500" :
              enjoyment.current >= 40 ? "bg-amber-500" :
              "bg-red-500"
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, enjoyment.current)}%` }}
            transition={{ duration: 0.8 }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          {enjoyment.current >= 65
            ? t("parentDashboardPage.enjoymentHigh")
            : enjoyment.current >= 40
            ? t("parentDashboardPage.enjoymentMedium")
            : t("parentDashboardPage.enjoymentLow")}
        </p>
      </div>
      )}

      {/* Tips */}
      <div className="space-y-1.5">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">
          {t("parentDashboardPage.familyTips")}
        </span>
        {tips.map((tip, i) => (
          <p key={i} className="text-[10px] text-muted-foreground/80 flex items-start gap-1.5">
            <span className="text-emerald-400 shrink-0">✓</span>
            {tip}
          </p>
        ))}
      </div>
    </motion.div>
  );
}

// ── Physical Status Card · lenguaje para padres ────────────────────────────
const ACWR_PARENT_COLORS: Record<string, string> = {
  optimal:      "text-green-400",
  caution:      "text-amber-400",
  danger:       "text-red-400",
  undertrained: "text-blue-400",
};

const FATIGUE_PARENT_COLORS: Record<string, string> = {
  normal:   "text-green-400",
  moderate: "text-amber-400",
  high:     "text-orange-400",
  critical: "text-red-400",
};

function PhysicalStatusCard({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const snapshot = PlayerTrackingService.get(playerId);
  const fatigue = snapshot?.fatigueReport;

  if (!fatigue) return null;

  // P1 bloque 4: sin dato NO hay «carga equilibrada» ni «sin fatiga» por defecto, y
  // sin maduración registrada no se valora el riesgo (decisión del owner: sin
  // semáforo). Informes antiguos con "post_phv" sin offset = maduración desconocida.
  const maturityKnown = maturationKnown(fatigue.thresholds?.band, fatigue.thresholds?.phvOffset);
  const zoneRaw = maturityKnown ? fatigue.acwr?.zone ?? null : null;
  const acwrZone = zoneRaw && zoneRaw in ACWR_PARENT_COLORS ? zoneRaw : null;
  const severityRaw =
    maturityKnown && fatigue.fatigueIndex?.value != null ? fatigue.fatigueIndex?.severity ?? null : null;
  const fatigueSeverity = severityRaw && severityRaw in FATIGUE_PARENT_COLORS ? severityRaw : null;
  const notComputed = t("parentDashboardPage.physicalNotComputed");
  const acwrColor = acwrZone ? ACWR_PARENT_COLORS[acwrZone] : "text-muted-foreground";
  const acwrLabel = acwrZone ? t(`parentDashboardPage.acwr_${acwrZone}_label`) : notComputed;
  const acwrAdvice = acwrZone
    ? t(`parentDashboardPage.acwr_${acwrZone}_advice`)
    : !maturityKnown
      ? t("parentDashboardPage.physicalMaturityUnknown")
      : t("parentDashboardPage.physicalNotEnoughData");
  const fatigueColor = fatigueSeverity ? FATIGUE_PARENT_COLORS[fatigueSeverity] : "text-muted-foreground";
  const fatigueLabel = fatigueSeverity ? t(`parentDashboardPage.fatigue_${fatigueSeverity}_label`) : notComputed;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.11 }}
      className="glass rounded-2xl p-4"
    >
      <div className="flex items-center gap-2 mb-3">
        <Shield size={14} className="text-primary" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
          {t("parentDashboardPage.physicalStatus")}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-secondary/30 border border-border p-3">
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground font-bold mb-1">{t("parentDashboardPage.weeklyLoad")}</div>
          <div className={`text-sm font-display font-bold ${acwrColor}`}>
            {acwrLabel}
          </div>
        </div>
        <div className="rounded-xl bg-secondary/30 border border-border p-3">
          <div className="text-[8px] uppercase tracking-wider text-muted-foreground font-bold mb-1">{t("parentDashboardPage.fatigue")}</div>
          <div className={`text-sm font-display font-bold ${fatigueColor}`}>
            {fatigueLabel}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
        {acwrAdvice}
      </p>

      {/* Sprint 11: Injury risk summary for parents */}
      {(acwrZone === "danger" || fatigueSeverity === "critical" || fatigueSeverity === "high") && (
        <div className="mt-3 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-2">
          <p className="text-[11px] text-orange-600 dark:text-orange-400 font-medium">
            {acwrZone === "danger"
              ? t("parentDashboardPage.injuryRiskLoadHigh")
              : t("parentDashboardPage.injuryRiskFatigueHigh")}
          </p>
        </div>
      )}
    </motion.div>
  );
}

// ── ParentGrowthSpurtSection (Escudo de Estirón, versión padre) ────

function ParentGrowthSpurtSection({ playerId }: { playerId: string }) {
  const phv = usePHVProduct(playerId);
  // Solo mostramos al padre cuando el escudo está activo (evita ruido).
  if (!phv || !phv.shield.active) return null;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.11 }}>
      <GrowthSpurtShieldAlert shield={phv.shield} audience="parent" />
    </motion.div>
  );
}

// ── ParentIDPSection ──────────────────────────────────────────────
// Plan de Desarrollo Individual mensual, en vista light para padres.
// Sin terminología técnica, solo emojis + barras de progreso.

function ParentIDPSection({ playerId }: { playerId: string }) {
  const { data: plan } = useCurrentIDP(playerId);
  const player = PlayerService.getById(playerId);

  // Solo renderiza si hay un plan activo. Si no, ocultamos la sección
  // (los padres no generan planes — eso lo hace el coach).
  if (!plan || (plan.status !== "active" && plan.status !== "completed")) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.14 }}
      className="glass rounded-2xl p-4"
    >
      <IDPParentView plan={plan} playerName={player?.name} />
    </motion.div>
  );
}

function SimpleStat({
  label, value, Icon,
}: { label: string; value: string; Icon: React.ElementType }) {
  return (
    <div className="rounded-xl bg-secondary/30 border border-border p-3 text-center">
      <Icon size={11} className="text-muted-foreground mx-auto mb-1" />
      <div className="text-[8px] uppercase tracking-wider text-muted-foreground font-bold">{label}</div>
      <div className="text-sm font-display font-bold text-foreground">{value}</div>
    </div>
  );
}
