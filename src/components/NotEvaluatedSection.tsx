/**
 * VITAS · Not Evaluated Section (B3)
 *
 * Transparencia radical: muestra explícitamente qué dimensiones
 * NO pudimos evaluar y por qué. En vez de ocultar lo que falta,
 * lo mostramos — confianza del scout como marca.
 *
 * Ninguna plataforma de la competencia hace esto.
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import { EyeOff, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Player } from "@/services/real/playerService";

interface Props {
  player: Player;
  hasAnalysis: boolean;
  hasTracking: boolean;
  latestReport: Record<string, unknown> | null | undefined;
}

interface MissingDimension {
  nameKey: string;
  reasonKey: string;
  howToFixKey: string;
}

function detectMissing(player: Player, hasAnalysis: boolean, hasTracking: boolean, report: Record<string, unknown> | null | undefined): MissingDimension[] {
  const missing: MissingDimension[] = [];

  if (!hasAnalysis) {
    missing.push({
      nameKey: "notEvaluatedSection.fullVideoAnalysisName",
      reasonKey: "notEvaluatedSection.fullVideoAnalysisReason",
      howToFixKey: "notEvaluatedSection.fullVideoAnalysisHowToFix",
    });
  }

  if (!hasTracking) {
    missing.push({
      nameKey: "notEvaluatedSection.maxSpeedDistanceName",
      reasonKey: "notEvaluatedSection.maxSpeedDistanceReason",
      howToFixKey: "notEvaluatedSection.maxSpeedDistanceHowToFix",
    });
  }

  if (player.phvOffset == null) {
    missing.push({
      nameKey: "notEvaluatedSection.maturationAgeName",
      reasonKey: "notEvaluatedSection.maturationAgeReason",
      howToFixKey: "notEvaluatedSection.maturationAgeHowToFix",
    });
  }

  // Check specific metrics from report
  const quant = report?.metricasCuantitativas as Record<string, unknown> | undefined;

  if (!quant?.heatmapPositions || !Array.isArray(quant.heatmapPositions) || quant.heatmapPositions.length === 0) {
    missing.push({
      nameKey: "notEvaluatedSection.heatmapName",
      reasonKey: "notEvaluatedSection.heatmapReason",
      howToFixKey: "notEvaluatedSection.heatmapHowToFix",
    });
  }

  if (hasAnalysis && !quant?.sprintCount) {
    missing.push({
      nameKey: "notEvaluatedSection.sprintsName",
      reasonKey: "notEvaluatedSection.sprintsReason",
      howToFixKey: "notEvaluatedSection.sprintsHowToFix",
    });
  }

  // Duelos: SIEMPRE bloqueados (P1 bloque 6, src/lib/tracking/duels.ts). Antes se miraba
  // un campo que ya no existe; ahora el motivo es el canónico, no «no se detectaron».
  if (hasAnalysis) {
    missing.push({
      nameKey: "notEvaluatedSection.duelsName",
      reasonKey: "notEvaluatedSection.duelsReason",
      howToFixKey: "notEvaluatedSection.duelsHowToFix",
    });
  }

  // metrics undefined (jugador sin evaluar) ⇒ tiro/defensa cuentan como ausentes,
  // sin derefiere undefined (evita crash en el resumen del Hub, invariante #2).
  const m = player.metrics;
  if ((!m?.shooting || m.shooting === 0) && (!m?.defending || m.defending === 0)) {
    missing.push({
      nameKey: "notEvaluatedSection.shootingDefenseName",
      reasonKey: "notEvaluatedSection.shootingDefenseReason",
      howToFixKey: "notEvaluatedSection.shootingDefenseHowToFix",
    });
  }

  return missing;
}

export default function NotEvaluatedSection({ player, hasAnalysis, hasTracking, latestReport }: Props) {
  const { t } = useTranslation();
  const missing = useMemo(
    () => detectMissing(player, hasAnalysis, hasTracking, latestReport as Record<string, unknown> | null),
    [player, hasAnalysis, hasTracking, latestReport]
  );

  // Don't show if nothing is missing
  if (missing.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
      className="glass rounded-xl p-4 border border-border/50"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center">
          <EyeOff size={13} className="text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-display font-bold text-xs text-foreground">{t("notEvaluatedSection.title")}</h3>
          <p className="text-[9px] text-muted-foreground">
            {t("notEvaluatedSection.dimensionsCount", { count: missing.length })}
          </p>
        </div>
      </div>

      {/* Missing dimensions */}
      <div className="space-y-2">
        {missing.map((m, i) => (
          <div
            key={i}
            className="flex items-start gap-2 p-2 rounded-lg bg-secondary/30"
          >
            <span className="text-muted-foreground text-[10px] mt-0.5 shrink-0">-</span>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-foreground">{t(m.nameKey)}</p>
              <p className="text-[10px] text-muted-foreground">{t(m.reasonKey)}</p>
              <p className="text-[10px] text-primary/80 mt-0.5">{t(m.howToFixKey)}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Info footer */}
      <div className="flex items-start gap-1.5 mt-3 pt-2 border-t border-border/30">
        <Info size={10} className="text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-[9px] text-muted-foreground leading-relaxed">
          {t("notEvaluatedSection.infoFooter")}
        </p>
      </div>
    </motion.div>
  );
}
