/**
 * VITAS · SnapshotHistoryChart (Sprint 5.4)
 *
 * Curva longitudinal real desde player_metric_snapshots: VSI + riesgo de lesión
 * a lo largo del tiempo. Se puebla con cada análisis (progression tracker). Estado
 * vacío mientras no haya histórico.
 *
 * P1 bloque 4b: ya NO pinta el «PHV offset» de los snapshots. El tracker dejó de
 * escribirlo (su historia vive en player_anthropometrics, tras la puerta del PHV):
 * un offset en un snapshot solo puede ser antiguo y sin pasar por la puerta.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { TrendingUp, LineChart as LineIcon } from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, Legend,
} from "recharts";
import { useMetricSnapshots } from "@/hooks/useMetricSnapshots";
import { TermTooltip } from "@/components/shared/TermTooltip";

interface Props {
  playerId: string;
  height?: number;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

export function SnapshotHistoryChart({ playerId, height = 240 }: Props) {
  const { t } = useTranslation();
  const { data: snapshots = [], isLoading } = useMetricSnapshots(playerId);

  const data = useMemo(
    () =>
      snapshots.map((s) => ({
        date: fmtDate(s.snapshotDate),
        VSI: s.vsi != null ? Math.round(s.vsi) : null,
        risk: s.injuryRisk != null ? Math.round(s.injuryRisk) : null,
      })),
    [snapshots],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-4 space-y-3 border border-white/10"
    >
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0">
          <LineIcon size={16} className="text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-display font-semibold text-sm text-foreground">{t("snapshotHistoryChart.title")}</h2>
          <p className="text-[10px] text-muted-foreground">
            <TermTooltip termKey="vsi" /> · {t("snapshotHistoryChart.riskLabel")} · <TermTooltip termKey="phv" /> {t("snapshotHistoryChart.offsetSuffix")}
          </p>
        </div>
        {snapshots.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{t("snapshotHistoryChart.records", { count: snapshots.length })}</span>
        )}
      </div>

      {isLoading ? (
        <div className="h-40 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : data.length < 2 ? (
        <div className="h-40 flex flex-col items-center justify-center text-center gap-2 px-6">
          <TrendingUp className="size-6 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            {data.length === 0
              ? t("snapshotHistoryChart.emptyNoData")
              : t("snapshotHistoryChart.emptyNeedMore")}
          </p>
        </div>
      ) : (
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -12 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} stroke="rgba(255,255,255,0.1)" />
              <YAxis yAxisId="pct" domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 9 }} stroke="rgba(255,255,255,0.1)" width={30} />
              <Tooltip
                contentStyle={{ background: "rgba(15,23,42,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Area yAxisId="pct" type="monotone" dataKey="risk" name={t("snapshotHistoryChart.seriesRisk")} stroke="#f43f5e" fill="rgba(244,63,94,0.12)" strokeWidth={1.5} connectNulls />
              <Line yAxisId="pct" type="monotone" dataKey="VSI" stroke="#22d3ee" strokeWidth={2.5} dot={{ r: 2 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}
