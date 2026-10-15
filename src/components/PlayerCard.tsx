import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { Player } from "@/lib/mockData";
import { coachEvalTier, type CoachEvalTier } from "@/services/real/metricsService";

// Color por el tramo ÚNICO de la evaluación del entrenador (P1 bloque 5b; antes 85/70 aquí).
const TIER_GRADIENT: Record<CoachEvalTier, string> = {
  elite: "from-primary to-primary/70",
  pro: "from-electric to-electric/70",
  talent: "from-gold to-gold/70",
  develop: "from-gold to-gold/70",
};

const PlayerCard = ({ player }: { player: Player }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const hasVsi = typeof player.vsi === "number";
  const vsiColor = hasVsi ? TIER_GRADIENT[coachEvalTier(player.vsi)] : "from-muted to-muted/70";

  return (
    <motion.div
      whileHover={{ scale: 1.03, y: -4 }}
      whileTap={{ scale: 0.97 }}
      onClick={() => navigate(`/players/${player.id}`)}
      className="relative w-[180px] h-[240px] rounded-2xl overflow-hidden cursor-pointer group flex-shrink-0"
    >
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-card/40 via-card/80 to-card z-0" />

      {/* Player image */}
      <img
        src={player.image}
        alt={player.name}
        className="absolute inset-0 w-full h-full object-cover object-top opacity-60 group-hover:opacity-80 transition-opacity duration-300 grayscale"
      />

      {/* Dark overlay from bottom */}
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-transparent z-10" />

      {/* Evaluación del entrenador (VSI de ficha); sin evaluar no se pinta número ni «—». */}
      {hasVsi && (
        <div className="absolute top-3 right-3 z-20" title={t("coachEval.label")}>
          <div
            className={`w-10 h-10 rounded-xl bg-gradient-to-br ${vsiColor} flex items-center justify-center shadow-lg`}
          >
            <span className="font-display font-black text-sm text-background">{player.vsi}</span>
          </div>
        </div>
      )}

      {/* Player info at bottom */}
      <div className="absolute bottom-0 left-0 right-0 p-4 z-20">
        <h3 className="font-display font-bold text-base text-foreground leading-tight">
          {player.name}
        </h3>
        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
          <span className="text-electric font-display font-semibold">
            {player.positionShort}
          </span>
          <span className="opacity-40">·</span>
          <span>{player.age}y</span>
          <span className="opacity-40">·</span>
          <span className="truncate">{player.academy}</span>
        </div>
      </div>

      {/* Hover border glow — gradient */}
      <div className="absolute inset-0 rounded-2xl border border-border/30 transition-all z-30 pointer-events-none"
        style={{ }}
      />
      <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity z-30 pointer-events-none"
        style={{ boxShadow: "inset 0 0 0 1.5px hsl(290 70% 50% / 0.4), 0 4px 20px hsl(210 100% 50% / 0.15)" }}
      />
    </motion.div>
  );
};

export default PlayerCard;
