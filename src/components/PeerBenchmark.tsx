/**
 * VITAS · Comparación con pares (percentil entre los propios jugadores)
 *
 * Muestra cómo se compara el jugador con los jugadores del MISMO dueño de su posición
 * y edad ±1 (api/benchmark/peer.ts). El percentil sale de la implementación única
 * (src/lib/metrics/percentile.ts): sin evaluar o con menos de 10 pares evaluados se
 * muestra el MOTIVO, nunca un «P0» (P1 bloque 5). Lo ven las familias
 * (ParentDashboardPage) y el panel de análisis.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Loader2, Users, Info } from "lucide-react";
import { getAuthHeaders } from "@/lib/apiAuth";
import type { MetricResult } from "@/lib/metrics/MetricResult";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import type { PercentileGateInfo, PeerDistributionValue } from "@/lib/metrics/percentile";

interface PeerMetric {
  player: number | null;
  percentile: MetricResult<number>;
  gate: PercentileGateInfo | null;
  distribution: PeerDistributionValue | null;
}

interface BenchmarkResponse {
  stratum: { position: string; ageMin: number; ageMax: number; phvCategory: string | null };
  minPeers: number;
  vsi: PeerMetric;
  byMetric: Record<string, PeerMetric>;
}

interface Props {
  playerId: string;
  variant?: "compact" | "full";
}

const METRIC_KEYS = ["speed", "technique", "vision", "stamina", "shooting", "defending"] as const;

export default function PeerBenchmark({ playerId, variant = "full" }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/benchmark/peer?playerId=${playerId}`, { headers });
        const json = await res.json();
        if (!mounted) return;
        if (!res.ok || !json.success) {
          setError(json?.error?.message ?? "Error");
        } else {
          setData(json.data as BenchmarkResponse);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Error");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [playerId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 justify-center">
        <Loader2 size={12} className="animate-spin text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">{t("peerBenchmark.comparing")}</span>
      </div>
    );
  }

  if (error || !data?.vsi) {
    return null; // silencioso · es info adicional
  }

  const gateText = (gate: PercentileGateInfo) =>
    t(`percentile.gate.${gate.code}`, { count: gate.peers, min: gate.min });

  // Sin percentil del VSI (sin evaluar o pocos pares): se dice por qué y no se pinta nada más.
  if (data.vsi.percentile.value === null) {
    return (
      <div className="rounded-lg bg-secondary/30 border border-border p-3 flex items-start gap-2">
        <Info size={12} className="text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-[11px] font-display font-bold text-foreground">
            {t("peerBenchmark.title")}
          </p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {data.vsi.gate ? gateText(data.vsi.gate) : data.vsi.percentile.gate_reason}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users size={11} className="text-primary" />
          <span className="text-[10px] uppercase tracking-wider text-primary font-bold">
            {t("peerBenchmark.title")}
          </span>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground">
        {t("peerBenchmark.stratum")}: <span className="text-foreground">{data.stratum.position}</span> ·
        {" "}{t("peerBenchmark.age")} <span className="text-foreground">{data.stratum.ageMin}-{data.stratum.ageMax}</span>
        {data.stratum.phvCategory && <> · PHV <span className="text-foreground">{data.stratum.phvCategory}</span></>}
      </div>

      {/* Evaluación del entrenador frente a sus pares */}
      <div className="rounded-xl bg-primary/10 border border-primary/30 p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-display font-bold text-foreground">{t("peerBenchmark.vsiVsPeers")}</span>
          {/* Procedencia rotulada por el componente único (DERIVADA ⇒ «Calculado»). */}
          <span className="flex items-center gap-1.5">
            <span className="font-display font-bold text-2xl text-primary">P{data.vsi.percentile.value}</span>
            <ProvenanceBadge provenance={data.vsi.percentile.provenance} />
          </span>
        </div>
        {data.vsi.distribution && data.vsi.player !== null && (
          <>
            <BenchmarkBar player={data.vsi.player} dist={data.vsi.distribution} max={100} />
            <div className="text-[9px] text-muted-foreground mt-1.5 flex justify-between">
              <span>P25: <span className="text-foreground">{data.vsi.distribution.p25}</span></span>
              <span>{t("peerBenchmark.mean")}: <span className="text-foreground">{data.vsi.distribution.mean}</span></span>
              <span>P75: <span className="text-foreground">{data.vsi.distribution.p75}</span></span>
              <span>P90: <span className="text-foreground">{data.vsi.distribution.p90}</span></span>
            </div>
          </>
        )}
      </div>

      {/* Por métrica · solo en la variante completa; sin percentil ⇒ su motivo. La
          procedencia (DERIVADA ⇒ «Calculado») se rotula una vez arriba para toda la
          sección: todas las filas salen del mismo cálculo (percentile.ts). */}
      {variant === "full" && (
        <div className="space-y-1.5">
          {METRIC_KEYS.map((key) => {
            const m = data.byMetric?.[key];
            if (!m) return null;
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground font-display font-bold uppercase tracking-wider">
                  {t(`peerBenchmark.metric.${key}`)}
                </span>
                {m.percentile.value !== null && m.distribution && m.player !== null ? (
                  <>
                    <div className="flex-1 min-w-0">
                      <BenchmarkBar player={m.player} dist={m.distribution} max={100} small />
                    </div>
                    <span className={`shrink-0 text-[10px] font-display font-bold ${
                      m.percentile.value >= 75 ? "text-green-600"
                      : m.percentile.value >= 50 ? "text-electric"
                      : m.percentile.value >= 25 ? "text-amber-600"
                      : "text-muted-foreground"
                    }`}>
                      P{m.percentile.value}
                    </span>
                  </>
                ) : (
                  <span className="flex-1 min-w-0 text-[10px] text-muted-foreground">
                    {m.gate ? gateText(m.gate) : m.percentile.gate_reason}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── BenchmarkBar ─────────────────────────────────────────────────

function BenchmarkBar({
  player,
  dist,
  max,
  small,
}: {
  player: number;
  dist: PeerDistributionValue;
  max: number;
  small?: boolean;
}) {
  const { t } = useTranslation();
  const pct = (v: number) => Math.max(0, Math.min(100, (v / max) * 100));
  return (
    <div className={`relative ${small ? "h-2" : "h-3"} rounded-full bg-secondary/40 overflow-hidden`}>
      {/* P25-P75 band */}
      <div
        className="absolute top-0 bottom-0 bg-primary/25"
        style={{ left: `${pct(dist.p25)}%`, width: `${pct(dist.p75) - pct(dist.p25)}%` }}
      />
      {/* P50 line */}
      <div
        className="absolute top-0 bottom-0 w-px bg-primary/60"
        style={{ left: `${pct(dist.p50)}%` }}
      />
      {/* Player dot */}
      <motion.div
        initial={{ left: "0%" }}
        animate={{ left: `calc(${pct(player)}% - ${small ? 4 : 6}px)` }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className={`absolute top-1/2 -translate-y-1/2 ${small ? "w-2 h-2" : "w-3 h-3"} rounded-full bg-primary ring-2 ring-background`}
        title={t("peerBenchmark.playerValue", { value: player })}
      />
    </div>
  );
}
