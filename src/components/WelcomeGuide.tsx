/**
 * WelcomeGuide — Checklist interactivo para usuarios nuevos.
 * Aparece en el Dashboard cuando el usuario tiene 0-1 jugadores.
 * Guía los primeros pasos: agregar jugador, evaluar métricas, subir video, ver rankings.
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  UserPlus, BarChart3, Video, Trophy,
  ChevronRight, X, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

// ── Tipos ───────────────────────────────────────────────────────────────────

interface GuideStep {
  id: string;
  icon: React.ReactNode;
  titleKey: string;
  titleFallback: string;
  descKey: string;
  descFallback: string;
  path: string;
  checkFn: () => boolean;
}

// ── Constantes ──────────────────────────────────────────────────────────────

const DISMISSED_KEY = "welcome_guide_dismissed";

const GUIDE_STEPS: GuideStep[] = [
  {
    id: "add-player",
    icon: <UserPlus size={16} />,
    titleKey: "guide.addPlayer",
    titleFallback: "Agrega tu primer jugador",
    descKey: "guide.addPlayerDesc",
    descFallback: "Registra nombre, edad, posición y métricas base",
    path: "/players/new",
    checkFn: () => {
      try {
        const players = JSON.parse(localStorage.getItem("players") ?? "[]");
        return players.length > 0;
      } catch { return false; }
    },
  },
  {
    id: "evaluate",
    icon: <BarChart3 size={16} />,
    titleKey: "guide.evaluate",
    titleFallback: "Evalúa sus métricas",
    descKey: "guide.evaluateDesc",
    descFallback: "Puntúa velocidad, técnica, visión y más: es la evaluación del entrenador",
    path: "/master",
    checkFn: () => {
      try {
        const players = JSON.parse(localStorage.getItem("players") ?? "[]");
        return players.some((p: { vsi?: number }) => (p.vsi ?? 0) > 0);
      } catch { return false; }
    },
  },
  {
    id: "video",
    icon: <Video size={16} />,
    titleKey: "guide.uploadVideo",
    titleFallback: "Sube un video de partido",
    descKey: "guide.uploadVideoDesc",
    descFallback: "Analiza jugadas con IA para obtener insights tácticos",
    path: "/lab",
    checkFn: () => {
      try {
        const videos = JSON.parse(localStorage.getItem("videos") ?? "[]");
        return videos.length > 0;
      } catch { return false; }
    },
  },
  {
    id: "rankings",
    icon: <Trophy size={16} />,
    titleKey: "guide.rankings",
    titleFallback: "Consulta el ranking",
    descKey: "guide.rankingsDesc",
    descFallback: "Compara jugadores por VSI, posición y grupo de edad",
    path: "/rankings",
    checkFn: () => {
      try {
        const players = JSON.parse(localStorage.getItem("players") ?? "[]");
        return players.length >= 2;
      } catch { return false; }
    },
  },
];

// ── Componente ──────────────────────────────────────────────────────────────

interface WelcomeGuideProps {
  playerCount: number;
}

export default function WelcomeGuide({ playerCount }: WelcomeGuideProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

  // Comprobar estado de cada paso
  useEffect(() => {
    const completed = new Set<string>();
    for (const step of GUIDE_STEPS) {
      if (step.checkFn()) completed.add(step.id);
    }
    setCompletedSteps(completed);
  }, [playerCount]);

  // No mostrar si fue cerrado o si ya completó todos los pasos
  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY) === "true") {
        setDismissed(true);
      }
    } catch { /* */ }
  }, []);

  const allDone = completedSteps.size === GUIDE_STEPS.length;
  if (dismissed || allDone) return null;

  const progress = Math.round((completedSteps.size / GUIDE_STEPS.length) * 100);

  const handleDismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED_KEY, "true"); } catch { /* */ }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl p-4 space-y-3 border border-primary/20"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <span className="font-display font-bold text-sm text-foreground">
            {t("guide.title", "Primeros pasos")}
          </span>
          <span className="text-[10px] font-display text-primary bg-primary/10 px-2 py-0.5 rounded-full">
            {progress}%
          </span>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label={t("welcomeGuide.closeGuide")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-primary rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>

      {/* Steps */}
      <div className="space-y-1.5">
        {GUIDE_STEPS.map((step) => {
          const done = completedSteps.has(step.id);
          return (
            <button
              key={step.id}
              onClick={() => !done && navigate(step.path)}
              disabled={done}
              className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-all ${
                done
                  ? "opacity-50"
                  : "hover:bg-primary/5 cursor-pointer"
              }`}
            >
              <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                done ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"
              }`}>
                {step.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-display font-semibold ${
                  done ? "line-through text-muted-foreground" : "text-foreground"
                }`}>
                  {t(step.titleKey, step.titleFallback)}
                </p>
                <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">
                  {t(step.descKey, step.descFallback)}
                </p>
              </div>
              {!done && <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
            </button>
          );
        })}
      </div>

      {/* CTA principal */}
      {!completedSteps.has("add-player") && (
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={() => navigate("/players/new")}
        >
          <UserPlus size={14} />
          {t("guide.cta", "Agregar primer jugador")}
        </Button>
      )}
    </motion.div>
  );
}
