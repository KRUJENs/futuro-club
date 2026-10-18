/**
 * VITAS · First-run Wizard (Sprint Onboarding · día 1)
 *
 * Detecta primera vez del usuario (cero jugadores + flag NO seteado),
 * lo guía en 3 pasos para crear el primer jugador, y al terminar le
 * ofrece 3 next-actions claras para activar valor inmediato.
 *
 * Activación:
 *   - Auto-aparece tras OnboardingTour cierra · delay 800ms
 *   - Solo si:
 *       * No hay flag 'vitas_first_run_done_v1'
 *       * Player count === 0
 *       * Tour ya completado (vitas_onboarding_seen_v1 set)
 *
 * Flow:
 *   Step 1: Nombre + Edad
 *   Step 2: Posición + Pie dominante
 *   Step 3: Medidas (opcional · skip OK)
 *   Done:   3 CTAs próximos pasos
 *
 * Persistencia: marca `vitas_first_run_done_v1` al terminar O saltar
 * (single-shot · no vuelve a aparecer).
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, ChevronLeft, ChevronRight, User, MapPin, Ruler, Trophy,
  Sparkles, FileText, Heart, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useAllPlayers, useCreatePlayer } from "@/hooks/usePlayers";
import { sexConfirmationFor } from "@/lib/shared/registeredSex";

const DONE_KEY = "vitas_first_run_done_v1";
const TOUR_KEY = "vitas_onboarding_seen_v1";

const POSITIONS = [
  { value: "Portero", labelKey: "firstRun.posGoalkeeper", emoji: "🥅" },
  { value: "Defensa Central", labelKey: "firstRun.posCenterBack", emoji: "🛡️" },
  { value: "Lateral Derecho", labelKey: "firstRun.posRightBack", emoji: "↗️" },
  { value: "Lateral Izquierdo", labelKey: "firstRun.posLeftBack", emoji: "↖️" },
  { value: "Mediocentro", labelKey: "firstRun.posMidfielder", emoji: "⚙️" },
  { value: "Extremo", labelKey: "firstRun.posWinger", emoji: "⚡" },
  { value: "Delantero", labelKey: "firstRun.posForward", emoji: "🎯" },
];

const FOOT_OPTIONS: Array<{ value: "right" | "left" | "both"; labelKey: string; emoji: string }> = [
  { value: "right", labelKey: "firstRun.footRight",     emoji: "🦵" },
  { value: "left",  labelKey: "firstRun.footLeft",      emoji: "🦵" },
  { value: "both",  labelKey: "firstRun.footBoth",      emoji: "✨" },
];

interface FormState {
  name: string;
  age: string;
  gender: "M" | "F" | "";   // requerido: determina la fórmula PHV (invariante #5)
  position: string;
  foot: "right" | "left" | "both" | "";
  height: string;
  weight: string;
}

const EMPTY_FORM: FormState = {
  name: "", age: "", gender: "", position: "", foot: "", height: "", weight: "",
};

/** Medida escrita por quien da de alta; vacío o no numérico ⇒ undefined (sin dato). */
function typedMeasure(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function FirstRunWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: players, isLoading } = useAllPlayers();
  const createPlayer = useCreatePlayer();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createdPlayerId, setCreatedPlayerId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Auto-open · cero jugadores + tour visto + nunca completado el wizard
  useEffect(() => {
    if (isLoading) return;
    try {
      const done = localStorage.getItem(DONE_KEY);
      const tourSeen = localStorage.getItem(TOUR_KEY);
      if (done) return;                                // ya completado/saltado
      if (!players || players.length > 0) return;      // ya tiene jugadores
      if (!tourSeen) return;                            // espera al tour primero
      const t = setTimeout(() => setOpen(true), 800);   // delay tras tour
      return () => clearTimeout(t);
    } catch { /* ignore */ }
  }, [players, isLoading]);

  function dismiss() {
    try { localStorage.setItem(DONE_KEY, new Date().toISOString()); } catch { /* ignore */ }
    setOpen(false);
  }

  async function handleCreate(skipMeasurements: boolean) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const age = Number(form.age);
      // Saltar las medidas = sin talla ni peso (P1 bloque 2, inv #2). Antes se rellenaban
      // con medias europeas por edad y luego entraban en Mirwald como una medición.
      const heightCm = skipMeasurements ? undefined : typedMeasure(form.height);
      const weightKg = skipMeasurements ? undefined : typedMeasure(form.weight);

      const player = await createPlayer.mutateAsync({
        name: form.name.trim(),
        age,
        position: form.position,
        foot: form.foot || undefined, // el paso 2 lo exige; nunca «right» por defecto
        height: heightCm,
        weight: weightKg,
        gender: form.gender || undefined, // sexo real elegido en el paso 1; nunca "M" por defecto
        sexConfirmedAt: sexConfirmationFor(form.gender || null), // elegido ⇒ confirmado (P1 bloque 7)
        // Sin nivel competitivo: este asistente no lo pregunta (antes «Regional» fijo).
        minutesPlayed: 0,
        // Sin métricas: este wizard NO evalúa. El jugador nace "sin evaluar"
        // (vsi null); el coach evaluará luego con las 6 barras de la ficha.
        // Sembrar 50/50 fabricaría una evaluación inexistente (invariante #2).
      });

      setCreatedPlayerId(player.id);
      setStep(4);
      toast.success(t("firstRun.playerAddedToast", { name: player.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("firstRun.createError"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleNextStep() {
    if (step === 1) {
      if (!form.name.trim() || !form.age) {
        toast.error(t("firstRun.needNameAge"));
        return;
      }
      const age = Number(form.age);
      if (age < 8 || age > 21) { toast.error(t("firstRun.ageRange")); return; }
      if (!form.gender) { toast.error(t("common.chooseGender")); return; }
      setStep(2);
    } else if (step === 2) {
      if (!form.position) { toast.error(t("firstRun.choosePosition")); return; }
      if (!form.foot)     { toast.error(t("firstRun.chooseFoot")); return; }
      setStep(3);
    } else if (step === 3) {
      void handleCreate(false);
    }
  }

  function handleSkipMeasurements() {
    void handleCreate(true);
  }

  function handleGoToBaseline() {
    if (!createdPlayerId) return;
    dismiss();
    navigate(`/players/${createdPlayerId}/reports`);
  }

  function handleGoToProfile() {
    if (!createdPlayerId) return;
    dismiss();
    navigate(`/players/${createdPlayerId}`);
  }

  function handleGoToFamily() {
    if (!createdPlayerId) return;
    dismiss();
    navigate(`/family/${createdPlayerId}`);
  }

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[55] bg-background/85 backdrop-blur-md flex items-center justify-center p-4 print:hidden"
      >
        <motion.div
          initial={{ y: 16, scale: 0.96 }}
          animate={{ y: 0, scale: 1 }}
          className="glass rounded-3xl p-5 max-w-md w-full space-y-5 border-2 border-primary/40 relative"
        >
          {/* Close · solo permite cerrar antes del step done */}
          {step !== 4 && (
            <button
              onClick={dismiss}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              aria-label={t("firstRun.skipSetup")}
              title={t("firstRun.setupLater")}
            >
              <X size={14} />
            </button>
          )}

          {/* Progress dots */}
          {step !== 4 && (
            <div className="flex items-center justify-center gap-1.5">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === step ? "w-6 bg-primary" : i < step ? "w-1.5 bg-primary/50" : "w-1.5 bg-secondary"
                  }`}
                />
              ))}
            </div>
          )}

          <AnimatePresence mode="wait">
            {/* ─── STEP 1 · Nombre + Edad ─────────────────────────── */}
            {step === 1 && (
              <motion.div key="s1" initial={{ x: 12, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -12, opacity: 0 }} transition={{ duration: 0.18 }} className="space-y-4">
                <div className="text-center space-y-1">
                  <div className="w-14 h-14 rounded-2xl bg-primary/20 border border-primary/40 flex items-center justify-center mx-auto">
                    <User size={26} className="text-primary" />
                  </div>
                  <h2 className="font-display font-bold text-lg text-foreground">{t("firstRun.step1Title")}</h2>
                  <p className="text-xs text-muted-foreground">{t("firstRun.step1Subtitle")}</p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                      {t("firstRun.playerNameLabel")}
                    </label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder={t("firstRun.playerNamePlaceholder")}
                      autoFocus
                      maxLength={60}
                      className="w-full px-4 py-2.5 rounded-lg bg-background border border-border text-base text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                      {t("firstRun.ageLabel")}
                    </label>
                    <input
                      type="number"
                      value={form.age}
                      onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))}
                      placeholder="9"
                      min={8} max={21}
                      className="w-full px-4 py-2.5 rounded-lg bg-background border border-border text-base text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  {/* Sexo · requerido (determina la fórmula PHV · invariante #5) */}
                  <div>
                    <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                      {t("common.gender")}
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {([
                        { value: "M", label: t("common.male") },
                        { value: "F", label: t("common.female") },
                      ] as const).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, gender: opt.value }))}
                          className={`px-2 py-2.5 rounded-lg text-xs font-display border transition-all ${
                            form.gender === opt.value
                              ? "border-primary bg-primary/15 text-foreground font-bold"
                              : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ─── STEP 2 · Posición + Pie ──────────────────────── */}
            {step === 2 && (
              <motion.div key="s2" initial={{ x: 12, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -12, opacity: 0 }} transition={{ duration: 0.18 }} className="space-y-4">
                <div className="text-center space-y-1">
                  <div className="w-14 h-14 rounded-2xl bg-electric/20 border border-electric/40 flex items-center justify-center mx-auto">
                    <MapPin size={26} className="text-electric" />
                  </div>
                  <h2 className="font-display font-bold text-lg text-foreground">{t("firstRun.step2Title")}</h2>
                  <p className="text-xs text-muted-foreground">{t("firstRun.step2Subtitle")}</p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                      {t("firstRun.positionLabel")}
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {POSITIONS.map((p) => (
                        <button
                          key={p.value}
                          onClick={() => setForm((f) => ({ ...f, position: p.value }))}
                          className={`px-2 py-2 rounded-lg text-xs font-display border transition-all ${
                            form.position === p.value
                              ? "border-electric bg-electric/15 text-foreground font-bold"
                              : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {p.emoji} {t(p.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                      {t("firstRun.dominantFootLabel")}
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {FOOT_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setForm((f) => ({ ...f, foot: opt.value }))}
                          className={`px-2 py-2.5 rounded-lg text-xs font-display border transition-all ${
                            form.foot === opt.value
                              ? "border-primary bg-primary/15 text-foreground font-bold"
                              : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {opt.emoji} {t(opt.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ─── STEP 3 · Medidas opcional ────────────────────── */}
            {step === 3 && (
              <motion.div key="s3" initial={{ x: 12, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -12, opacity: 0 }} transition={{ duration: 0.18 }} className="space-y-4">
                <div className="text-center space-y-1">
                  <div className="w-14 h-14 rounded-2xl bg-gold/20 border border-gold/40 flex items-center justify-center mx-auto">
                    <Ruler size={26} className="text-gold" />
                  </div>
                  <h2 className="font-display font-bold text-lg text-foreground">{t("firstRun.step3Title")}</h2>
                  <p className="text-xs text-muted-foreground">{t("firstRun.step3Subtitle")}</p>
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                        {t("firstRun.heightLabel")}
                      </label>
                      <input
                        type="number"
                        value={form.height}
                        onChange={(e) => setForm((f) => ({ ...f, height: e.target.value }))}
                        placeholder={t("firstRun.heightPlaceholder")}
                        min={100} max={220}
                        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-display text-muted-foreground uppercase tracking-wider mb-1.5">
                        {t("firstRun.weightLabel")}
                      </label>
                      <input
                        type="number"
                        value={form.weight}
                        onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
                        placeholder={t("firstRun.weightPlaceholder")}
                        min={20} max={120}
                        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="rounded-lg bg-electric/10 border border-electric/30 p-2.5 text-[11px] text-foreground leading-relaxed">
                    {t("firstRun.phvTipStart")} <strong>PHV</strong> {t("firstRun.phvTipEnd")}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ─── STEP 4 · DONE · Next actions ───────────────── */}
            {step === 4 && (
              <motion.div key="s4" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-4 text-center">
                <motion.div
                  animate={{ rotate: [0, -10, 10, -10, 0] }}
                  transition={{ duration: 0.6 }}
                  className="text-5xl"
                >
                  🏆
                </motion.div>
                <div className="space-y-1">
                  <h2 className="font-display font-bold text-lg text-foreground">
                    {t("firstRun.playerAddedTitle", { name: form.name })}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {t("firstRun.whatNext")}
                  </p>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={handleGoToBaseline}
                    className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border-2 border-primary/40"
                  >
                    <div className="w-9 h-9 rounded-lg bg-primary/20 border border-primary/40 flex items-center justify-center shrink-0">
                      <FileText size={16} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-display font-bold text-foreground flex items-center gap-1.5">
                        {t("firstRun.generateReport")}
                        <Sparkles size={11} className="text-primary" />
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {t("firstRun.generateReportDesc")}
                      </div>
                    </div>
                    <span className="text-primary text-lg">→</span>
                  </button>

                  <button
                    onClick={handleGoToProfile}
                    className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border border-electric/40"
                  >
                    <div className="w-9 h-9 rounded-lg bg-electric/20 border border-electric/40 flex items-center justify-center shrink-0">
                      <Trophy size={16} className="text-electric" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-display font-bold text-foreground">{t("firstRun.viewProfile")}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t("firstRun.viewProfileDesc")}
                      </div>
                    </div>
                    <span className="text-electric">→</span>
                  </button>

                  <button
                    onClick={handleGoToFamily}
                    className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border border-pink-400/40"
                  >
                    <div className="w-9 h-9 rounded-lg bg-pink-400/20 border border-pink-400/40 flex items-center justify-center shrink-0">
                      <Heart size={16} className="text-pink-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-display font-bold text-foreground">{t("firstRun.familyView")}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t("firstRun.familyViewDesc")}
                      </div>
                    </div>
                    <span className="text-pink-400">→</span>
                  </button>
                </div>

                <button
                  onClick={dismiss}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("firstRun.laterClose")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Navigation footer · steps 1-3 ────────────────── */}
          {step !== 4 && (
            <div className="flex items-center justify-between gap-2 pt-2">
              {step > 1 ? (
                <button
                  onClick={() => setStep((s) => Math.max(1, (s - 1) as 1 | 2 | 3))}
                  disabled={submitting}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                >
                  <ChevronLeft size={12} /> {t("firstRun.back")}
                </button>
              ) : <div />}

              {step === 3 ? (
                <div className="flex gap-2">
                  <button
                    onClick={handleSkipMeasurements}
                    disabled={submitting}
                    className="px-3 py-2 text-xs font-display font-bold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {t("firstRun.skip")}
                  </button>
                  <button
                    onClick={handleNextStep}
                    disabled={submitting}
                    className="flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-display font-bold hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {submitting ? <Loader2 size={12} className="animate-spin" /> : <Trophy size={12} />}
                    {t("firstRun.createPlayer")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleNextStep}
                  className="flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-display font-bold hover:bg-primary/90 transition-colors"
                >
                  {t("firstRun.next")} <ChevronRight size={12} />
                </button>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
