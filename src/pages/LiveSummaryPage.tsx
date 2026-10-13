/**
 * VITAS · Live Match Summary Page (Sprint B2 · día 4)
 * /live/:matchId/summary
 *
 * Llamado tras pitido final (auto-redirect desde LiveMatchPage al
 * pasar status='finished'). Invoca POST /api/live/aggregate que
 * genera 3 reportes Claude y los cachea en analysis_result.
 *
 * Visual: stats por jugador + 3 secciones (resumen, players, tactical).
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft, Loader2, AlertCircle, Trophy, Star, TrendingUp, TrendingDown,
  Sparkles, Brain, Users, ClipboardList, Video,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getAuthHeaders } from "@/lib/apiAuth";
import { IS_DEMO } from "@/lib/demoMode";
import { buildDemoLiveAggregate } from "@/lib/demo/demoLive";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";

interface PlayerStat {
  playerId: string | null;
  playerName: string;
  goles: number;
  asistencias: number;
  pases_clave: number;
  recuperaciones: number;
  perdidas: number;
  duelos_ganados: number;
  duelos_perdidos: number;
  tarjetas: number;
  totalEvents: number;
  netImpact: number;
}

interface AnalysisResult {
  generated_at: string;
  stats_by_player: PlayerStat[];
  total_events: number;
  reports: Array<{ type: string; content: Record<string, unknown>; model: string }>;
  /** El vídeo del partido se omitió por consentimiento (api/live/aggregate). */
  video_consent_gate?: { code: string; gate_reason: string };
}

interface AggregateResponse {
  cached: boolean;
  match: {
    id: string;
    status: string;
    score_home: number;
    score_away: number;
    duration_seconds: number;
    team_name: string;
    opponent_name: string | null;
  };
  analysis: AnalysisResult;
}

export default function LiveSummaryPage() {
  const { t } = useTranslation();
  const { matchId } = useParams<{ matchId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!matchId) return;
    let mounted = true;
    (async () => {
      try {
        if (IS_DEMO) {
          if (mounted) { setData(buildDemoLiveAggregate() as AggregateResponse); setLoading(false); }
          return;
        }
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/live/aggregate?matchId=${matchId}&locale=${normalizeLocale(i18n.language)}`, {
          method: "POST",
          headers,
        });
        const json = await res.json();
        if (!mounted) return;
        if (!res.ok || !json.success) {
          throw new Error(json?.error?.message ?? t("liveSummaryPage.errorGenerating"));
        }
        setData(json.data as AggregateResponse);
        if (!json.data.cached) {
          toast.success(t("liveSummaryPage.reportsToast", { reports: json.data.analysis.reports.length, events: json.data.analysis.total_events }));
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : t("liveSummaryPage.error"));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [matchId, t]);

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    return `${m}min`;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-sm font-display font-bold text-foreground">{t("liveSummaryPage.generatingAnalysis")}</p>
        <p className="text-[11px] text-muted-foreground">{t("liveSummaryPage.claudeProcessing")}</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle size={28} className="text-destructive" />
        <h1 className="text-base font-display font-bold text-foreground">{t("liveSummaryPage.couldNotGenerate")}</h1>
        <p className="text-xs text-muted-foreground max-w-sm">{error ?? t("liveSummaryPage.unknownError")}</p>
        <button onClick={() => navigate("/live")} className="text-xs font-bold text-primary mt-3">
          {t("liveSummaryPage.backToMatches")}
        </button>
      </div>
    );
  }

  const { match, analysis } = data;
  const teamSummary = analysis.reports.find((r) => r.type === "team-summary")?.content ?? {};
  const playerInsights = analysis.reports.find((r) => r.type === "per-player")?.content as
    | { players?: Array<{ player_name: string; rating: number; summary: string; highlight: string }> } | undefined;
  const tactical = analysis.reports.find((r) => r.type === "tactical-take")?.content ?? {};

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/live")} className="p-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">
              {match.team_name} {match.opponent_name && `vs ${match.opponent_name}`}
            </h1>
            <p className="text-[10px] text-muted-foreground">{t("liveSummaryPage.matchSummaryAi")}</p>
          </div>
          <Trophy size={18} className="text-gold" />
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-3xl lg:max-w-5xl mx-auto">
        {/* Score banner */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass rounded-2xl p-5 text-center bg-gradient-to-br from-primary/15 via-electric/10 to-transparent"
        >
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1">
            {t("liveSummaryPage.result")}
          </div>
          <div className="font-display font-bold text-5xl text-foreground leading-none">
            {match.score_home}<span className="text-muted-foreground mx-2">−</span>{match.score_away}
          </div>
          <div className="text-[11px] mt-2 text-muted-foreground flex items-center justify-center gap-2">
            <span>{t("liveSummaryPage.matchMetaLine", { duration: fmt(match.duration_seconds), events: analysis.total_events, reports: analysis.reports.length })}</span>
            {(analysis as Record<string, unknown>).has_video && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/20 text-primary text-[9px] font-bold">
                <Video size={9} /> {t("liveSummaryPage.withVideo")}
              </span>
            )}
          </div>
          {teamSummary.result_phrase ? (
            <div className="text-sm font-display font-bold text-foreground mt-2">{teamSummary.result_phrase as string}</div>
          ) : null}
        </motion.div>

        {/* Consentimiento (decisión del owner, 30 sep): el vídeo del partido no se mandó a
            analizar (sin declaración guardada con él, o menor sin consentimiento parental).
            El informe se basa solo en los eventos registrados; se dice por qué. */}
        {(() => {
          const gate = analysis.video_consent_gate;
          if (!gate || typeof gate.gate_reason !== "string") return null;
          return (
            <div role="status" data-testid="live-video-consent-gate" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
              <p className="text-xs font-display font-bold text-foreground">{t("clipConsent.liveVideoOmittedTitle")}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{gate.gate_reason}</p>
            </div>
          );
        })()}

        {/* MVP */}
        {teamSummary.mvp ? (
          <div className="glass rounded-2xl p-4 border-2 border-gold/40 bg-gold/5">
            <div className="flex items-center gap-2 mb-2">
              <Star size={14} className="text-gold" />
              <span className="text-[10px] uppercase tracking-widest text-gold font-bold">{t("liveSummaryPage.matchMvp")}</span>
            </div>
            <div className="font-display font-bold text-base text-foreground">
              {(teamSummary.mvp as { player_name?: string }).player_name}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {(teamSummary.mvp as { reason?: string }).reason}
            </p>
          </div>
        ) : null}

        {/* Team summary */}
        <Section title={t("liveSummaryPage.teamSummaryTitle")} Icon={Brain} color="#0066CC">
          {teamSummary.key_moments && Array.isArray(teamSummary.key_moments) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">{t("liveSummaryPage.keyMoments")}</h5>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-foreground">
                {(teamSummary.key_moments as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {teamSummary.team_strengths && Array.isArray(teamSummary.team_strengths) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-1">✓ {t("liveSummaryPage.strengths")}</h5>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-foreground">
                {(teamSummary.team_strengths as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {teamSummary.team_weaknesses && Array.isArray(teamSummary.team_weaknesses) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1">⚠ {t("liveSummaryPage.weaknesses")}</h5>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-foreground">
                {(teamSummary.team_weaknesses as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {teamSummary.next_focus ? (
            <div className="rounded-lg bg-primary/10 border border-primary/30 p-2 text-xs">
              <strong className="text-primary">{t("liveSummaryPage.nextFocus")}</strong>{" "}
              <span className="text-foreground">{teamSummary.next_focus as string}</span>
            </div>
          ) : null}
        </Section>

        {/* Stats por jugador */}
        <Section title={t("liveSummaryPage.statsPerPlayer")} Icon={Users} color="#B82BD9">
          <div className="space-y-2">
            {analysis.stats_by_player.filter((s) => s.totalEvents > 0).map((s) => {
              const insight = playerInsights?.players?.find((p) => p.player_name === s.playerName);
              return (
                <div key={s.playerId ?? "team"} className="rounded-lg bg-secondary/30 border border-border p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="font-display font-bold text-sm text-foreground truncate">{s.playerName}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {insight && (
                        <span className="text-[10px] text-muted-foreground">
                          {t("liveSummaryPage.rating")} <span className="font-display font-bold text-foreground text-base">{insight.rating}</span>/10
                        </span>
                      )}
                      <span className={`text-[11px] font-display font-bold ${s.netImpact > 0 ? "text-green-400" : s.netImpact < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {s.netImpact > 0 ? <TrendingUp size={10} className="inline" /> : <TrendingDown size={10} className="inline" />}
                        {s.netImpact > 0 ? "+" : ""}{s.netImpact.toFixed(1)}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-[10px] text-muted-foreground mb-1.5">
                    <Stat label={t("liveSummaryPage.statGoal")}     value={s.goles} highlight={s.goles > 0} />
                    <Stat label={t("liveSummaryPage.statAssist")}   value={s.asistencias} highlight={s.asistencias > 0} />
                    <Stat label={t("liveSummaryPage.statKeyPass")}   value={s.pases_clave} highlight={s.pases_clave > 0} />
                    <Stat label={t("liveSummaryPage.statRecovery")}   value={s.recuperaciones} />
                    <Stat label={t("liveSummaryPage.statLoss")}    value={s.perdidas} />
                    <Stat label={t("liveSummaryPage.statDuelWon")}  value={s.duelos_ganados} />
                    <Stat label={t("liveSummaryPage.statDuelLost")}  value={s.duelos_perdidos} />
                    <Stat label={t("liveSummaryPage.statCard")}    value={s.tarjetas} />
                  </div>
                  {insight?.summary && (
                    <p className="text-[11px] text-foreground/90 leading-relaxed mt-1.5 pt-1.5 border-t border-border/40">
                      {insight.summary}
                    </p>
                  )}
                  {insight?.highlight && (
                    <p className="text-[10px] text-primary mt-0.5">
                      <Star size={9} className="inline mr-0.5" /> {insight.highlight}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* Tactical take */}
        <Section title={t("liveSummaryPage.tacticalRead")} Icon={ClipboardList} color="#22e88c">
          {tactical.what_worked && Array.isArray(tactical.what_worked) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-1">{t("liveSummaryPage.whatWorked")}</h5>
              <ul className="list-disc list-inside text-xs text-foreground space-y-0.5">
                {(tactical.what_worked as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {tactical.what_didnt && Array.isArray(tactical.what_didnt) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1">{t("liveSummaryPage.whatFailed")}</h5>
              <ul className="list-disc list-inside text-xs text-foreground space-y-0.5">
                {(tactical.what_didnt as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {tactical.next_match_adjustment ? (
            <div className="rounded-lg bg-electric/10 border border-electric/30 p-2 text-xs">
              <strong className="text-electric">{t("liveSummaryPage.nextMatchAdjustment")}</strong>{" "}
              <span className="text-foreground">{tactical.next_match_adjustment as string}</span>
            </div>
          ) : null}
          {tactical.recommended_drills && Array.isArray(tactical.recommended_drills) && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wider text-primary font-bold mb-1">
                <Sparkles size={10} className="inline mr-0.5" />{t("liveSummaryPage.recommendedDrills")}
              </h5>
              <ul className="list-disc list-inside text-xs text-foreground space-y-0.5">
                {(tactical.recommended_drills as string[]).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, Icon, color, children }: {
  title: string; Icon: React.ElementType; color: string; children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
          <Icon size={14} style={{ color }} />
        </div>
        <h2 className="font-display font-bold text-sm text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`text-center rounded p-1 ${highlight ? "bg-primary/10" : ""}`}>
      <div className={`text-[8px] uppercase tracking-wider ${highlight ? "text-primary" : "text-muted-foreground"} font-bold`}>{label}</div>
      <div className={`font-display font-bold text-sm ${highlight ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}
