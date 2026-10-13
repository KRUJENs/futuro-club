/**
 * OnboardingPage — /onboarding
 * Flujo de bienvenida para nuevos usuarios: 4 pasos.
 *   1. Bienvenida
 *   2. Tipo de perfil (scout / parent / academy / club)
 *   3. Nombre de organización (opcional según perfil)
 *   4. Primer jugador (opcional)
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  UserRound, Users, Building2, Trophy,
  ChevronRight, ArrowLeft, Zap, Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { useTranslation } from "react-i18next";
import {
  UserProfileService,
  PROFILE_TYPE_LABELS,
  PROFILE_TYPE_DESCRIPTIONS,
  type ProfileType,
  type UserRole,
} from "@/services/real/userProfileService";
import { PlayerService } from "@/services/real/playerService";
import { SupabasePlayerService } from "@/services/real/supabasePlayerService";
import { OrganizationService } from "@/services/real/organizationService";
import { DemoDataService } from "@/services/real/demoDataService";
import { decimalAgeYears } from "@/lib/shared/age";

// ─── Constantes ───────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const PROFILE_ICONS: Record<ProfileType, React.ReactNode> = {
  scout:   <UserRound size={24} />,
  parent:  <Users size={24} />,
  academy: <Building2 size={24} />,
  club:    <Trophy size={24} />,
};

const PROFILE_ROLE_MAP: Record<ProfileType, UserRole> = {
  scout:   "scout",
  parent:  "viewer",
  academy: "director",
  club:    "director",
};

// Maps canonical (stored) Spanish position values to i18n key suffixes.
const POSITION_KEYS: Record<string, string> = {
  "Portero":            "goalkeeper",
  "Defensa Central":    "centerBack",
  "Lateral Derecho":    "rightBack",
  "Lateral Izquierdo":  "leftBack",
  "Pivote":             "defensiveMidfielder",
  "Mediocentro":        "centralMidfielder",
  "Mediapunta":         "attackingMidfielder",
  "Extremo Derecho":    "rightWinger",
  "Extremo Izquierdo":  "leftWinger",
  "Delantero Centro":   "striker",
};

// ─── Componente ───────────────────────────────────────────────────────────────

const OnboardingPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [profileType, setProfileType] = useState<ProfileType | null>(null);
  const [orgName, setOrgName] = useState("");
  const [playerName, setPlayerName] = useState("");
  // Sin valores por defecto (inv #2): la edad sale de la FECHA DE NACIMIENTO y la
  // posición la elige quien da de alta. Antes el jugador nacía con 14 años, extremo
  // izquierdo, pie derecho, 1,65 m y 58 kg que nadie había medido.
  const [playerBirthDate, setPlayerBirthDate] = useState("");
  const [playerPosition, setPlayerPosition] = useState("");
  const [playerGender, setPlayerGender] = useState<"M" | "F" | "">(""); // requerido si se crea jugador (invariante #5)
  const [saving, setSaving] = useState(false);

  const showOrgStep = profileType === "academy" || profileType === "club";

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const prev = () => setStep((s) => Math.max(s - 1, 1));

  const handleFinish = async (opts?: { skipPlayer?: boolean }) => {
    if (!user || !profileType) return;
    // Si se va a crear un jugador manual, exigir el sexo: determina la fórmula PHV
    // (Mirwald/Khamis-Roche). Nunca se asume "M" por defecto (invariante #5).
    const creatingPlayer = !opts?.skipPlayer && playerName.trim().length > 0;
    if (creatingPlayer && !playerGender) {
      toast.error(t("common.chooseGender"));
      return;
    }
    if (creatingPlayer && !playerPosition) {
      toast.error(t("firstRun.choosePosition"));
      return;
    }
    // Edad decimal desde la fecha de nacimiento (regla del owner 28-sep): sin fecha no
    // se crea el jugador con una edad inventada.
    const decimalAge = creatingPlayer ? decimalAgeYears(playerBirthDate) : null;
    if (creatingPlayer && decimalAge === null) {
      toast.error(t("onboarding.birthDateRequired"));
      return;
    }
    // Fuera de 8-21 años el schema del jugador lo rechaza: se dice el motivo en vez del
    // error genérico de guardado.
    if (creatingPlayer && decimalAge !== null && (Math.floor(decimalAge) < 8 || Math.floor(decimalAge) > 21)) {
      toast.error(t("firstRun.ageRange"));
      return;
    }
    setSaving(true);
    try {
      // Crear organización si aplica (academy / club)
      if (showOrgStep && orgName.trim()) {
        await OrganizationService.create(user.id, orgName.trim());
      }

      // Crear perfil de usuario
      UserProfileService.create({
        userId: user.id,
        profileType,
        role: PROFILE_ROLE_MAP[profileType],
        organizationName: orgName.trim() || undefined,
        onboardingCompleted: true,
      });

      // Crear primer jugador solo si NO se omite y se dio nombre (flag explícito,
      // no depende de setState asíncrono → "Omitir"/"demo" ya no crean jugador).
      if (creatingPlayer && decimalAge !== null) {
        const created = PlayerService.create({
          name: playerName.trim(),
          age: Math.floor(decimalAge),
          birthDate: playerBirthDate,
          position: playerPosition,
          gender: playerGender || undefined, // sexo real elegido en el paso 4; nunca "M" por defecto
          // Sin pie, talla, peso ni nivel: en el alta rápida nadie los ha medido ni elegido.
          minutesPlayed: 0,
          // Sin métricas: el alta rápida NO evalúa. El jugador nace "sin evaluar"
          // (vsi null); el coach evaluará luego en su ficha. Sembrar 60/50 aquí
          // fabricaría una evaluación que nadie hizo (invariante #2).
        });
        // Empujar a Supabase para que el jugador exista como sujeto de análisis
        // de vídeo / PHV de servidor (antes: localStorage-only → el pipeline no lo
        // encontraba). Sin bloquear el alta; si la nube falla queda en SyncQueue
        // (se reintenta), en vez de perderse en silencio como antes.
        void SupabasePlayerService.persistOrQueue(user.id, created, "create");
      }

      toast.success(t("toasts.profileConfigured"));
      navigate("/pulse", { replace: true });
    } catch (err) {
      toast.error(t("toasts.profileSaveError"));
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const slide = {
    initial: { opacity: 0, x: 32 },
    animate: { opacity: 1, x: 0, transition: { duration: 0.3 } },
    exit:    { opacity: 0, x: -32, transition: { duration: 0.2 } },
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Zap size={20} className="text-primary" />
            <span className="font-display font-black text-2xl text-foreground tracking-tight">
              VITAS<span className="text-primary">.</span>
            </span>
          </div>
          <p className="text-[10px] font-display text-muted-foreground uppercase tracking-widest">
            Football Intelligence
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-300 ${
                i + 1 === step
                  ? "w-6 h-2 bg-primary"
                  : i + 1 < step
                  ? "w-2 h-2 bg-primary/50"
                  : "w-2 h-2 bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Steps */}
        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div key="step1" {...slide} className="space-y-6 text-center">
              <div>
                <h1 className="font-display font-bold text-2xl text-foreground mb-2">
                  {t("onboarding.welcome").replace(".", "")}<span className="text-primary">.</span>
                </h1>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t("onboarding.welcomeDesc")}
                </p>
              </div>
              <div className="glass rounded-xl p-4 text-left space-y-2">
                {(["vsiAnalysis", "vaep", "phv", "comparisons"] as const).map((key) => (
                  <div key={key} className="flex items-center gap-2 text-xs font-display text-muted-foreground">
                    <Check size={12} className="text-primary shrink-0" />
                    {t(`onboarding.features.${key}`)}
                  </div>
                ))}
              </div>
              <Button className="w-full gap-2" onClick={next}>
                {t("onboarding.start")} <ChevronRight size={14} />
              </Button>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div key="step2" {...slide} className="space-y-5">
              <div>
                <h2 className="font-display font-bold text-xl text-foreground mb-1">
                  {t("onboarding.howUseVitas")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("onboarding.selectProfile")}
                </p>
              </div>
              <div className="space-y-2">
                {(["scout", "parent", "academy", "club"] as ProfileType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setProfileType(type)}
                    className={`w-full glass rounded-xl p-3 flex items-center gap-3 border transition-all text-left ${
                      profileType === type
                        ? "border-primary bg-primary/5"
                        : "border-transparent hover:border-primary/30"
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      profileType === type ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"
                    }`}>
                      {PROFILE_ICONS[type]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-display font-semibold text-foreground">
                        {PROFILE_TYPE_LABELS[type]}
                      </p>
                      <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">
                        {PROFILE_TYPE_DESCRIPTIONS[type]}
                      </p>
                    </div>
                    {profileType === type && (
                      <Check size={14} className="text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={prev} className="gap-1">
                  <ArrowLeft size={14} />
                </Button>
                <Button className="flex-1 gap-2" onClick={next} disabled={!profileType}>
                  {t("common.next")} <ChevronRight size={14} />
                </Button>
              </div>
            </motion.div>
          )}

          {step === 3 && (
            <motion.div key="step3" {...slide} className="space-y-5">
              <div>
                <h2 className="font-display font-bold text-xl text-foreground mb-1">
                  {showOrgStep ? t("onboarding.orgStep") : t("onboarding.nameStep")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {showOrgStep
                    ? t("onboarding.orgQuestion")
                    : t("onboarding.nameQuestion")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-display text-muted-foreground uppercase tracking-wide">
                  {showOrgStep ? t("onboarding.orgLabel") : t("onboarding.nameLabel")}{" "}
                  <span className="text-[9px] normal-case text-muted-foreground/60">{t("onboarding.optional")}</span>
                </Label>
                <Input
                  placeholder={
                    profileType === "academy"
                      ? t("onboarding.placeholders.academy")
                      : profileType === "club"
                      ? t("onboarding.placeholders.club")
                      : profileType === "scout"
                      ? t("onboarding.placeholders.scout")
                      : t("onboarding.placeholders.parent")
                  }
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={prev} className="gap-1">
                  <ArrowLeft size={14} />
                </Button>
                <Button className="flex-1 gap-2" onClick={next}>
                  {t("common.next")} <ChevronRight size={14} />
                </Button>
              </div>
            </motion.div>
          )}

          {step === 4 && (
            <motion.div key="step4" {...slide} className="space-y-5">
              <div>
                <h2 className="font-display font-bold text-xl text-foreground mb-1">
                  {t("onboarding.firstPlayer")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("onboarding.firstPlayerDesc")}
                </p>
              </div>

              <div className="glass rounded-xl p-4 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-display text-muted-foreground uppercase tracking-wide">
                    {t("common.name")}
                  </Label>
                  <Input
                    placeholder={t("onboarding.placeholders.playerName")}
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-display text-muted-foreground uppercase tracking-wide">
                      {t("players.form.birthDate")}
                    </Label>
                    <Input
                      type="date"
                      max={new Date().toISOString().slice(0, 10)}
                      value={playerBirthDate}
                      onChange={(e) => setPlayerBirthDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-display text-muted-foreground uppercase tracking-wide">
                      {t("common.position")}
                    </Label>
                    <select
                      value={playerPosition}
                      onChange={(e) => setPlayerPosition(e.target.value)}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm font-display text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">{t("players.form.validation.selectPosition")}</option>
                      {[
                        "Portero", "Defensa Central", "Lateral Derecho", "Lateral Izquierdo",
                        "Pivote", "Mediocentro", "Mediapunta",
                        "Extremo Derecho", "Extremo Izquierdo", "Delantero Centro",
                      ].map((p) => (
                        <option key={p} value={p}>
                          {t(`onboardingPage.positions.${POSITION_KEYS[p]}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {/* Sexo · requerido si se crea jugador (fórmula PHV · invariante #5) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-display text-muted-foreground uppercase tracking-wide">
                    {t("common.gender")}
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { value: "M", label: t("common.male") },
                      { value: "F", label: t("common.female") },
                    ] as const).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setPlayerGender(opt.value)}
                        className={`h-9 rounded-md border text-sm font-display transition-all ${
                          playerGender === opt.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-input hover:border-primary/50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Separador con opción demo */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-background px-3 text-[10px] text-muted-foreground font-display uppercase tracking-widest">
                    {t("common.or", "o")}
                  </span>
                </div>
              </div>

              <button
                onClick={() => {
                  DemoDataService.seed();
                  // Empujar a Supabase para que Rankings/Lab (leen del servidor) vean
                  // los jugadores demo, no solo el Panel (localStorage). Best-effort.
                  if (user) SupabasePlayerService.pushAll(user.id).catch(() => {});
                  handleFinish({ skipPlayer: true }); // demo → no crear jugador manual
                }}
                disabled={saving}
                className="w-full glass rounded-xl p-3 flex items-center gap-3 border border-transparent hover:border-primary/30 transition-all text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Users size={18} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-display font-semibold text-foreground">
                    {t("onboarding.loadDemo", "Cargar datos de ejemplo")}
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                    {t("onboarding.loadDemoDesc", "3 jugadores con diferentes perfiles para explorar VITAS")}
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>

              <div className="flex gap-2">
                <Button variant="outline" onClick={prev} className="gap-1">
                  <ArrowLeft size={14} />
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-muted-foreground"
                  onClick={() => handleFinish({ skipPlayer: true })}
                  disabled={saving}
                >
                  {t("common.skip")}
                </Button>
                <Button
                  className="flex-1 gap-2"
                  onClick={() => handleFinish()}
                  disabled={saving}
                >
                  {saving ? t("common.saving") : (
                    <><Check size={14} /> {t("common.finish")}</>
                  )}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
};

export default OnboardingPage;
