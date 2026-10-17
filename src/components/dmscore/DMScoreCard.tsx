/**
 * VITAS · DMScoreCard — Decision-Making Score (P1 bloque 6b).
 *
 * Pinta un `MetricResult`: hoy siempre BLOQUEADO (src/lib/dmscore/dmScore.ts) ⇒ el motivo
 * traducido, nunca una cifra. Antes: un compuesto 35/35/15/15 sin fuente con «élite para
 * su edad» y una confianza, sobre componentes que hoy no se miden.
 */
import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import type { MetricResult } from "@/lib/metrics/MetricResult";

interface Props {
  metric: MetricResult<number>;
}

export function DMScoreCard({ metric }: Props) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-dashed border-border bg-secondary/20 p-4" data-testid="dm-score-card">
      <div className="flex items-center gap-2 mb-2">
        <Brain className="size-4 text-cyan-500" />
        <h3 className="text-sm font-semibold text-foreground">Decision-Making Score</h3>
      </div>
      {metric.value === null ? (
        <p className="text-xs text-muted-foreground" data-testid="dm-score-gated">{t("dmScoreGate.reason")}</p>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-foreground">{metric.value}</span>
          <ProvenanceBadge provenance={metric.provenance} />
        </div>
      )}
    </div>
  );
}
