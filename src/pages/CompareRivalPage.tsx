/**
 * VITAS · Compare-to-Rival Page (Sprint B3 · día 3-5)
 * /equipo/rival
 *
 * El coach describe al rival, recibe un plan de partido + drills
 * generados por Claude basado en nuestra plantilla vs su descripción.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { normalizeLocale } from "@/lib/shared/locale";
import { motion } from "framer-motion";
import {
  ArrowLeft, Swords, Sparkles, Loader2, AlertCircle, Plus, X,
  Target, Shield, Zap, Calendar, ListChecks, AlertTriangle,
  Video, FileText, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { getAuthHeaders } from "@/lib/apiAuth";
import { IS_DEMO } from "@/lib/demoMode";
import { buildDemoRivalPlan } from "@/lib/demo/demoTeam";
import VideoUpload from "@/components/VideoUpload";
import { VideoService } from "@/services/real/videoService";
import { resolveSyncAnalysisInput, syncAnalysisRefusalMessage } from "@/lib/syncVideoAnalysisGate";
import { clipConsentErrorFromResponse } from "@/lib/shared/videoConsent";

type AnalysisMode = "text" | "video";

interface KeyPlayer {
  name: string;
  position: string;
  threat: string;
}

interface RivalVideoAnalysis {
  resumenGeneral: string;
  patronesJuego: string[];
  dimensiones: Record<string, { observaciones: string[]; score_estimado: number }>;
  eventosContados: Record<string, number>;
}

interface PlanResponse {
  plan: {
    tldr?: string;
    tactical_approach?: {
      formation_recommended?: string;
      high_press?: boolean;
      compactness?: string;
      tempo?: string;
      key_principle?: string;
    };
    key_matchups?: Array<{ ours: string; theirs: string; approach: string }>;
    exploit_their_weaknesses?: Array<{ weakness: string; how_to_exploit: string }>;
    guard_our_vulnerabilities?: Array<{ our_vulnerability: string; mitigation: string }>;
    match_phases?: { first_15min?: string; mid_match?: string; last_15min?: string };
    training_week?: { monday?: string; wednesday?: string; friday?: string };
    recommended_drills?: Array<{ drill: string; purpose: string; duration_min: number }>;
    wildcards?: Array<{ scenario: string; response: string }>;
  };
  rivalName: string;
  ourTeamSize: number;
}

export default function CompareRivalPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<AnalysisMode>("video");
  const [rivalName, setRivalName] = useState("");
  const [rivalFormation, setRivalFormation] = useState("");
  const [rivalNotes, setRivalNotes] = useState("");
  const [strengths, setStrengths] = useState<string[]>([""]);
  const [weaknesses, setWeaknesses] = useState<string[]>([""]);
  const [keyPlayers, setKeyPlayers] = useState<KeyPlayer[]>([]);
  const [matchContext, setMatchContext] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Video mode state
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [analyzingVideo, setAnalyzingVideo] = useState(false);
  const [videoAnalysis, setVideoAnalysis] = useState<RivalVideoAnalysis | null>(null);
  // Motivo honesto por el que el vídeo subido NO va al análisis rápido. null = sin aviso.
  const [videoNotice, setVideoNotice] = useState<string | null>(null);

  async function handleVideoAnalysis(url: string, videoId: string) {
    setVideoUrl(url);
    setAnalyzingVideo(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/agents/video-observation", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          locale: normalizeLocale(i18n.language),
          videoUrl: url,
          // Consentimiento (decisión del owner, 30 sep): el servidor exige que el vídeo sea
          // tuyo, que la URL sea la suya y la declaración que marcaste al subirlo.
          videoId,
          // Observación de EQUIPO (el rival): sin identificar a jugadores y sin
          // edad/posición inventadas (antes 13 / "MID" / "formativo" por defecto).
          analysisScope: "team",
          playerContext: { name: rivalName || t("compareRivalPage.rivalTeamDefault") },
        }),
      });
      const json = await res.json();
      const consentErr = clipConsentErrorFromResponse(json, i18n.language);
      if (consentErr) throw consentErr;
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? t("compareRivalPage.errorAnalyzingVideo"));

      const obs = json.data?.observations as RivalVideoAnalysis;
      setVideoAnalysis(obs);

      // Auto-fill form from Gemini observations
      if (obs.patronesJuego?.length) {
        setStrengths(obs.patronesJuego.slice(0, 3));
      }
      if (obs.resumenGeneral) {
        setRivalNotes((prev) => prev ? `${prev}\n\n[Gemini] ${obs.resumenGeneral}` : obs.resumenGeneral);
      }
      toast.success(t("compareRivalPage.videoAnalyzedToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("compareRivalPage.errorAnalyzingVideo"));
      setVideoAnalysis(null);
    } finally {
      setAnalyzingVideo(false);
    }
  }

  async function handleGenerate() {
    if (!rivalName.trim()) {
      toast.error(t("compareRivalPage.rivalNameRequiredToast"));
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      if (IS_DEMO) {
        setResult(buildDemoRivalPlan(rivalName.trim()) as PlanResponse);
        return;
      }
      const headers = await getAuthHeaders();
      const res = await fetch("/api/team/compare-rival", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          locale: normalizeLocale(i18n.language),
          rivalName: rivalName.trim(),
          rivalFormation: rivalFormation.trim() || undefined,
          rivalNotes: rivalNotes.trim() || undefined,
          rivalStrengths: strengths.map((s) => s.trim()).filter(Boolean),
          rivalWeaknesses: weaknesses.map((s) => s.trim()).filter(Boolean),
          rivalKeyPlayers: keyPlayers.filter((k) => k.name.trim()),
          matchContext: matchContext.trim() || undefined,
          // Video analysis enrichment
          rivalVideoAnalysis: videoAnalysis ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? t("compareRivalPage.errorGeneratingPlan"));
      }
      setResult(json.data as PlanResponse);
      toast.success(t("compareRivalPage.planGeneratedToast"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("compareRivalPage.errorGeneric");
      setError(msg);
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  if (result) {
    return <PlanView data={result} onBack={() => setResult(null)} onNavBack={() => navigate(-1)} />;
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
              {t("compareRivalPage.headerTitle")}
            </h1>
            <p className="text-[10px] text-muted-foreground">
              {t("compareRivalPage.headerSubtitle")}
            </p>
          </div>
          <Swords size={18} className="text-electric" />
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-2xl lg:max-w-5xl mx-auto">
        {/* Video upload section */}
        {(
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="space-y-3">
            {!videoAnalysis ? (
              <div className="glass rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Video size={14} className="text-primary" />
                  <span className="text-xs font-display font-bold text-foreground">{t("compareRivalPage.rivalVideoLabel")}</span>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("compareRivalPage.rivalVideoHint")}
                </p>
                {analyzingVideo ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin text-primary" />
                    <span className="font-display">{t("compareRivalPage.analyzingVideoStatus")}</span>
                  </div>
                ) : (
                  <VideoUpload
                    onDone={(videoId, info) => {
                      // Prop correcto onDone(videoId); onUploadComplete no
                      // existía → subir vídeo del rival no hacía nada (#4).
                      // Gate honesto (clips cortos + URL descargable por el servidor;
                      // nunca un blob:) antes de llamar al agente.
                      const input = resolveSyncAnalysisInput(VideoService.getById(videoId), info.durationSec);
                      if (input.kind === "ok") {
                        setVideoNotice(null);
                        void handleVideoAnalysis(input.url, videoId);
                      } else {
                        const msg = syncAnalysisRefusalMessage(t, input);
                        setVideoNotice(msg);
                        toast.error(msg);
                      }
                    }}
                  />
                )}
                {videoNotice && !analyzingVideo && (
                  <div role="status" className="flex items-start gap-2 p-3 rounded-lg bg-secondary border border-border">
                    <AlertCircle size={14} className="text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-[11px] text-foreground leading-relaxed">{videoNotice}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="glass rounded-2xl p-4 border border-green-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={14} className="text-green-500" />
                  <span className="text-xs font-display font-bold text-green-500">{t("compareRivalPage.videoAnalyzedLabel")}</span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {videoAnalysis.resumenGeneral?.slice(0, 200)}...
                </p>
                <button
                  onClick={() => { setVideoAnalysis(null); setVideoUrl(null); }}
                  className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t("compareRivalPage.changeVideo")}
                </button>
              </div>
            )}
          </motion.div>
        )}

        {/* Form */}
        <div className="glass rounded-2xl p-4 space-y-3">
          <Field
            label={t("compareRivalPage.rivalNameLabel")}
            value={rivalName}
            onChange={setRivalName}
            placeholder={t("compareRivalPage.rivalNamePlaceholder")}
            required
          />
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={t("compareRivalPage.formationLabel")}
              value={rivalFormation}
              onChange={setRivalFormation}
              placeholder={t("compareRivalPage.formationPlaceholder")}
            />
            <Field
              label={t("compareRivalPage.contextLabel")}
              value={matchContext}
              onChange={setMatchContext}
              placeholder={t("compareRivalPage.contextPlaceholder")}
            />
          </div>
          <div>
            <label className="block text-[10px] font-display text-muted-foreground uppercase tracking-wider mb-1">
              {t("compareRivalPage.coachNotesLabel")}
            </label>
            <textarea
              value={rivalNotes}
              onChange={(e) => setRivalNotes(e.target.value)}
              rows={3}
              placeholder={t("compareRivalPage.coachNotesPlaceholder")}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:border-primary focus:outline-none resize-none"
            />
          </div>

          {/* Strengths */}
          <ListEditor
            label={t("compareRivalPage.strengthsLabel")}
            color="text-green-400"
            items={strengths}
            onChange={setStrengths}
            placeholder={t("compareRivalPage.strengthsPlaceholder")}
          />

          {/* Weaknesses */}
          <ListEditor
            label={t("compareRivalPage.weaknessesLabel")}
            color="text-amber-400"
            items={weaknesses}
            onChange={setWeaknesses}
            placeholder={t("compareRivalPage.weaknessesPlaceholder")}
          />

          {/* Key players */}
          <KeyPlayersEditor players={keyPlayers} onChange={setKeyPlayers} />

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-2 flex items-center gap-2 text-[11px] text-destructive">
              <AlertCircle size={12} /> {error}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={generating || !rivalName.trim() || (mode === "video" && analyzingVideo)}
            className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-display font-bold text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {generating ? (
              <><Loader2 size={14} className="animate-spin" /> {t("compareRivalPage.claudeAnalyzing")}</>
            ) : (
              <><Sparkles size={14} /> {t("compareRivalPage.generatePlanFor", { rival: rivalName || t("compareRivalPage.rivalFallback") })}{videoAnalysis ? t("compareRivalPage.withVideoSuffix") : ""}</>
            )}
          </button>
          <p className="text-[10px] text-muted-foreground text-center">
            {videoAnalysis
              ? t("compareRivalPage.footerWithVideo")
              : t("compareRivalPage.footerNoVideo")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, required,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div>
      <label className="block text-[10px] font-display text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:border-primary focus:outline-none"
      />
    </div>
  );
}

function ListEditor({
  label, color, items, onChange, placeholder,
}: { label: string; color: string; items: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <label className={`block text-[10px] font-display ${color} uppercase tracking-wider mb-1`}>
        {label}
      </label>
      <div className="space-y-1.5">
        {items.map((s, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              type="text"
              value={s}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
              placeholder={placeholder}
              className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border text-xs focus:border-primary focus:outline-none"
            />
            {items.length > 1 && (
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        {items.length < 5 && (
          <button
            onClick={() => onChange([...items, ""])}
            className="text-[10px] text-primary hover:text-primary/80 flex items-center gap-1"
          >
            <Plus size={10} /> {t("compareRivalPage.add")}
          </button>
        )}
      </div>
    </div>
  );
}

function KeyPlayersEditor({
  players, onChange,
}: { players: KeyPlayer[]; onChange: (v: KeyPlayer[]) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-[10px] font-display text-electric uppercase tracking-wider mb-1">
        {t("compareRivalPage.keyPlayersLabel")}
      </label>
      <div className="space-y-1.5">
        {players.map((p, i) => (
          <div key={i} className="rounded-lg border border-border p-2 space-y-1.5 bg-secondary/20">
            <div className="grid grid-cols-2 gap-1.5">
              <input
                value={p.name}
                onChange={(e) => {
                  const next = [...players]; next[i] = { ...p, name: e.target.value }; onChange(next);
                }}
                placeholder={t("compareRivalPage.playerNamePlaceholder")}
                className="px-2 py-1 rounded bg-background border border-border text-[11px]"
              />
              <input
                value={p.position}
                onChange={(e) => {
                  const next = [...players]; next[i] = { ...p, position: e.target.value }; onChange(next);
                }}
                placeholder={t("compareRivalPage.playerPositionPlaceholder")}
                className="px-2 py-1 rounded bg-background border border-border text-[11px]"
              />
            </div>
            <input
              value={p.threat}
              onChange={(e) => {
                const next = [...players]; next[i] = { ...p, threat: e.target.value }; onChange(next);
              }}
              placeholder={t("compareRivalPage.playerThreatPlaceholder")}
              className="w-full px-2 py-1 rounded bg-background border border-border text-[11px]"
            />
            <button
              onClick={() => onChange(players.filter((_, j) => j !== i))}
              className="text-[10px] text-destructive hover:text-destructive/80 flex items-center gap-1"
            >
              <X size={10} /> {t("compareRivalPage.remove")}
            </button>
          </div>
        ))}
        {players.length < 5 && (
          <button
            onClick={() => onChange([...players, { name: "", position: "", threat: "" }])}
            className="text-[10px] text-primary hover:text-primary/80 flex items-center gap-1"
          >
            <Plus size={10} /> {t("compareRivalPage.addKeyPlayer")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Plan View ────────────────────────────────────────────────────

function PlanView({ data, onBack, onNavBack }: { data: PlanResponse; onBack: () => void; onNavBack: () => void }) {
  const { t } = useTranslation();
  const p = data.plan;
  const ta = p.tactical_approach;

  return (
    <div className="min-h-screen bg-background pb-28">
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={onNavBack} className="p-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">
              {t("compareRivalPage.planVsTitle", { rival: data.rivalName })}
            </h1>
            <p className="text-[10px] text-muted-foreground">
              {t("compareRivalPage.planGeneratedSubtitle", { count: data.ourTeamSize })}
            </p>
          </div>
          <button onClick={onBack} className="text-[11px] text-primary hover:text-primary/80 font-bold">
            {t("compareRivalPage.edit")}
          </button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-2xl lg:max-w-5xl mx-auto">
        {/* TLDR */}
        {p.tldr && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-4 bg-gradient-to-br from-electric/15 to-transparent border border-electric/30"
          >
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles size={11} className="text-electric" />
              <span className="text-[10px] uppercase tracking-wider text-electric font-bold">TL;DR</span>
            </div>
            <p className="text-sm text-foreground leading-relaxed font-display">{p.tldr}</p>
          </motion.div>
        )}

        {/* Tactical approach */}
        {ta && (
          <Section Icon={Zap} title={t("compareRivalPage.tacticalApproachTitle")} color="#B82BD9">
            <div className="grid grid-cols-2 gap-2">
              {ta.formation_recommended && <Stat label={t("compareRivalPage.statFormation")} value={ta.formation_recommended} />}
              {ta.compactness            && <Stat label={t("compareRivalPage.statCompactness")} value={ta.compactness} />}
              {ta.tempo                  && <Stat label={t("compareRivalPage.statTempo")} value={ta.tempo} />}
              {ta.high_press !== undefined && <Stat label={t("compareRivalPage.statHighPress")} value={ta.high_press ? t("compareRivalPage.yes") : t("compareRivalPage.no")} />}
            </div>
            {ta.key_principle && (
              <p className="text-xs text-foreground leading-relaxed pt-2 border-t border-border/40">
                <strong className="text-electric">{t("compareRivalPage.principleLabel")}</strong> {ta.key_principle}
              </p>
            )}
          </Section>
        )}

        {/* Key matchups */}
        {p.key_matchups && p.key_matchups.length > 0 && (
          <Section Icon={Target} title={t("compareRivalPage.keyMatchupsTitle")} color="#F59E0B">
            <ul className="space-y-2">
              {p.key_matchups.map((m, i) => (
                <li key={i} className="text-xs">
                  <div className="flex items-center gap-1.5 font-display font-bold text-foreground">
                    <span>{m.ours}</span>
                    <Swords size={11} className="text-amber-400" />
                    <span>{m.theirs}</span>
                  </div>
                  <p className="text-muted-foreground mt-0.5">{m.approach}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Exploit their weaknesses */}
        {p.exploit_their_weaknesses && p.exploit_their_weaknesses.length > 0 && (
          <Section Icon={Target} title={t("compareRivalPage.exploitWeaknessesTitle")} color="#22e88c">
            <ul className="space-y-1.5">
              {p.exploit_their_weaknesses.map((w, i) => (
                <li key={i} className="text-xs">
                  <div className="font-display font-bold text-foreground">⚡ {w.weakness}</div>
                  <p className="text-muted-foreground mt-0.5">{w.how_to_exploit}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Guard our vulnerabilities */}
        {p.guard_our_vulnerabilities && p.guard_our_vulnerabilities.length > 0 && (
          <Section Icon={Shield} title={t("compareRivalPage.guardVulnerabilitiesTitle")} color="#EF4444">
            <ul className="space-y-1.5">
              {p.guard_our_vulnerabilities.map((v, i) => (
                <li key={i} className="text-xs">
                  <div className="font-display font-bold text-foreground">🛡 {v.our_vulnerability}</div>
                  <p className="text-muted-foreground mt-0.5">{v.mitigation}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Match phases */}
        {p.match_phases && (
          <Section Icon={Calendar} title={t("compareRivalPage.matchPhasesTitle")} color="#1A8FFF">
            {p.match_phases.first_15min && <Phase label={t("compareRivalPage.phaseFirst15")} text={p.match_phases.first_15min} />}
            {p.match_phases.mid_match   && <Phase label={t("compareRivalPage.phaseMid")}    text={p.match_phases.mid_match} />}
            {p.match_phases.last_15min  && <Phase label={t("compareRivalPage.phaseLast15")}   text={p.match_phases.last_15min} />}
          </Section>
        )}

        {/* Training week */}
        {p.training_week && (
          <Section Icon={ListChecks} title={t("compareRivalPage.trainingWeekTitle")} color="#0066CC">
            {p.training_week.monday    && <Phase label={t("compareRivalPage.dayMon")} text={p.training_week.monday} />}
            {p.training_week.wednesday && <Phase label={t("compareRivalPage.dayWed")} text={p.training_week.wednesday} />}
            {p.training_week.friday    && <Phase label={t("compareRivalPage.dayFri")} text={p.training_week.friday} />}
          </Section>
        )}

        {/* Drills */}
        {p.recommended_drills && p.recommended_drills.length > 0 && (
          <Section Icon={Sparkles} title={t("compareRivalPage.recommendedDrillsTitle")} color="#B82BD9">
            <div className="space-y-2">
              {p.recommended_drills.map((d, i) => (
                <div key={i} className="rounded-lg bg-secondary/30 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-bold text-foreground">{d.drill}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{d.duration_min} min</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{d.purpose}</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Wildcards */}
        {p.wildcards && p.wildcards.length > 0 && (
          <Section Icon={AlertTriangle} title={t("compareRivalPage.wildcardsTitle")} color="#F59E0B">
            <ul className="space-y-1.5">
              {p.wildcards.map((w, i) => (
                <li key={i} className="text-xs">
                  <div className="font-display font-bold text-amber-400">⚠ {w.scenario}</div>
                  <p className="text-muted-foreground mt-0.5">{w.response}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  Icon, title, color, children,
}: {
  Icon: React.ElementType;
  title: string; color: string; children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
          <Icon size={13} style={{ color }} />
        </div>
        <h2 className="font-display font-bold text-sm text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/30 px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-muted-foreground font-bold">{label}</div>
      <div className="text-xs font-display font-bold text-foreground capitalize">{value}</div>
    </div>
  );
}

function Phase({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-[10px] uppercase tracking-wider font-bold text-electric shrink-0 w-12 mt-0.5">
        {label}
      </span>
      <p className="text-xs text-foreground flex-1 leading-relaxed">{text}</p>
    </div>
  );
}
