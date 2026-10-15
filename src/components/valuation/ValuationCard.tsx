/**
 * ValuationCard — puntuación compuesta de valoración del jugador (modelo determinista).
 *
 * Data source: valuation-model deterministic output (api/agents/_valuation-model.ts).
 *
 * P1 bloque 4b: si el modelo no calculó la valoración, la tarjeta lo dice con su motivo y
 * NO pinta tramo ni puntuación.
 * P1 bloque 5d: sin PROBABILIDADES (llegar a 1.ª división / liga top-5 / «mejora a 1-3
 * años»: tasas y fórmulas sin fuente, retiradas en el modelo), sin la «confianza» calculada
 * con pesos inventados, sin el aviso «tendencia positiva» (miraba el NIVEL de un factor,
 * no una tendencia) y sin el modo compacto (sin llamadores). La puntuación se presenta como
 * orientativa: pesos y tramos «pendiente de validar» (config/valuation.ts).
 */

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Trophy, BarChart3, Info } from "lucide-react";
import TierBadge from "./TierBadge";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import type { Provenance } from "@/lib/metrics/MetricResult";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ValuationData {
  playerId: string;
  /** null ⇒ no calculada (ver gate_reason): sin tramo. */
  overallScore: number | null;
  /** Procedencia de la puntuación (DERIVADA en el modelo real, MOCK en el demo; null sin
   *  puntuación). Obligatoria: ninguna puntuación se pinta sin su etiqueta. */
  provenance: Provenance | null;
  tier: string | null;
  tierColor: string | null;
  tierDescription: string | null;
  factors: Array<{
    factor: string;
    weight: number;
    /** null ⇒ el factor se abstiene o no aplica (ver gate_reason). */
    score: number | null;
    label: string;
    /** false ⇒ no aplica a este jugador (p. ej. techo por maduración en adultos). */
    applicable?: boolean;
    gate_reason?: string | null;
  }>;
  /** Motivo cuando overallScore es null. */
  gate_reason?: string | null;
  /** null ⇒ sin el nº real de análisis no se afirma ni se niega. */
  coldStartWarning: boolean | null;
  analysisCount: number | null;
}

interface ValuationCardProps {
  data: ValuationData;
}

/** Valoración sin calcular: motivo + qué factor falta; nunca tramo ni puntuación. */
function ValuationNotComputed({ data }: { data: ValuationData }) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-5 space-y-4 border border-border/50"
      data-testid="valuation-not-computed"
    >
      <div className="flex items-center gap-2">
        <Trophy size={18} className="text-primary" />
        <h3 className="font-display font-bold text-base text-foreground">{t("valuationCard.title")}</h3>
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
        <Info size={14} className="text-amber-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-[11px] font-semibold text-amber-800">{t("valuationCard.notComputedTitle")}</p>
          {data.gate_reason && <p className="text-[10px] text-amber-800 leading-relaxed">{data.gate_reason}</p>}
        </div>
      </div>
      <ul className="space-y-1">
        {data.factors
          .filter((f) => f.score === null)
          .map((f) => (
            <li key={f.factor} className="text-[10px] text-muted-foreground">
              <span className="font-semibold text-foreground">{f.label}:</span> {f.gate_reason ?? t("valuationCard.noData")}
            </li>
          ))}
      </ul>
    </motion.div>
  );
}

export default function ValuationCard({ data }: ValuationCardProps) {
  const { t } = useTranslation();
  if (data.overallScore === null || data.tier === null) {
    return <ValuationNotComputed data={data} />;
  }
  const color = data.tierColor ?? "hsl(var(--primary))";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-5 space-y-5 border border-border/50"
      data-testid="valuation-computed"
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={18} className="text-primary" />
            <h3 className="font-display font-bold text-base text-foreground">{t("valuationCard.title")}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {data.analysisCount !== null
              ? t("valuationCard.orientativeWithCount", { count: data.analysisCount })
              : t("valuationCard.orientative")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <TierBadge tier={data.tier} tierColor={color} score={data.overallScore} />
          {data.provenance && <ProvenanceBadge provenance={data.provenance} />}
        </div>
      </div>

      {/* Tier description */}
      {data.tierDescription && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{data.tierDescription}</p>
      )}

      {/* Cold-start warning */}
      {data.coldStartWarning === true && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
          <Info size={14} className="text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("valuationCard.coldStart")}</p>
        </div>
      )}

      {/* Factor breakdown */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-primary" />
          <h4 className="text-xs font-display font-semibold text-muted-foreground uppercase tracking-wider">
            {t("valuationCard.factors")}
          </h4>
        </div>
        <div className="space-y-1.5">
          {data.factors.map((factor) =>
            factor.score === null ? (
              <p key={factor.factor} className="text-[10px] text-muted-foreground">
                <span className="font-semibold text-foreground">{factor.label}:</span> {factor.gate_reason ?? t("valuationCard.noData")}
              </p>
            ) : (
              <div key={factor.factor} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-28 truncate shrink-0">{factor.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${factor.score}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>
                <span className="text-[10px] font-display font-bold text-foreground tabular-nums w-6 text-right">
                  {factor.score}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </motion.div>
  );
}
