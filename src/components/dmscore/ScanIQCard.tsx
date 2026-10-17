/**
 * VITAS · ScanIQCard — Scan IQ (P1 bloque 6b).
 *
 * Pinta un `MetricResult`: hoy siempre BLOQUEADO fuera del demo (src/lib/dmscore/scanIQ.ts)
 * ⇒ el motivo traducido, nunca una cifra. En el demo, el ejemplo FIJO con su procedencia
 * MOCK (ProvenanceBadge, el componente único que rotula la procedencia). Antes: «calibrado
 * por edad», «Vídeo real», percentil, edad-equivalente y una cita sin referencia.
 */
import { motion } from "framer-motion";
import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import type { MetricResult } from "@/lib/metrics/MetricResult";

interface Props {
  metric: MetricResult<number>;
}

export function ScanIQCard({ metric }: Props) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-gradient-to-br from-pink-500/5 via-transparent to-fuchsia-500/5 p-4"
      data-testid="scan-iq-card"
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="p-1.5 rounded-md bg-gradient-to-br from-pink-500 to-fuchsia-600">
          <Eye className="size-3.5 text-white" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground leading-tight">Scan IQ</h3>
          <p className="text-[10px] text-muted-foreground">{t("scanningIntelligencePage.headerSubtitle")}</p>
        </div>
      </div>
      {metric.value === null ? (
        <p className="text-xs text-muted-foreground" data-testid="scan-iq-gated">{t("scanIqGate.reason")}</p>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-foreground">{metric.value}</span>
          <span className="text-[10px] text-muted-foreground">/100</span>
          <ProvenanceBadge provenance={metric.provenance} />
        </div>
      )}
    </motion.div>
  );
}
