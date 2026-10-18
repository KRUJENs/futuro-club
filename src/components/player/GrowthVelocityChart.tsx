/**
 * VITAS · Growth Velocity Chart + APHV onset prediction
 *
 * Visualiza la trayectoria de altura del jugador y calcula:
 *   - Velocidad de crecimiento (cm/año) entre mediciones consecutivas
 *   - APHV (Age at Peak Height Velocity) estimado · si offset disponible
 *   - Ventana neuromotora (-1y a +2y de APHV) con banda highlighted
 *
 * Reusa la tabla `player_anthropometrics` (histórico) sincronizada con
 * el player record. Si solo hay 1 medición, muestra solo el punto + APHV
 * estimado por Mirwald sin curva.
 */

import { useEffect, useState, useMemo } from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  ResponsiveContainer, ComposedChart, Line, Area, ReferenceLine, ReferenceArea,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { TrendingUp, AlertCircle, Loader2, Sparkles } from "lucide-react";
import { trustAnthroForPlayer } from "@/lib/shared/sexGatedAnthro";
import { getAuthHeaders } from "@/lib/apiAuth";
import { PhvGateNotice, usePhvGateText } from "@/components/phv/PhvGateNotice";

interface AnthroRow {
  id: string;
  height_cm: number;
  weight_kg: number;
  sitting_height_cm?: number | null;
  leg_length_cm?: number | null;
  chronological_age: number;
  age_source?: string | null;
  maturity_offset: number | null;
  phv_category: "early" | "ontime" | "late" | null;
  phv_gate_reason?: string | null;
  measured_at: string;
}

interface ChartPoint {
  age: number;            // chronologicalAge en años (ej. 13.4)
  height: number | null;  // cm
  velocity: number | null;// cm/año
  isProjection?: boolean; // marcador de extrapolación
  measuredAt: string;
}

interface Props {
  playerId: string;
  /** Sexo registrado del jugador (vista honesta): la fila solo cuenta si cuadra con él (P1 bloque 7). */
  sex?: { gender?: unknown; sexConfirmedAt?: unknown };
}

export default function GrowthVelocityChart({ playerId, sex }: Props) {
  const sexGender = sex?.gender;
  const sexConfirmed = sex?.sexConfirmedAt;
  const { t } = useTranslation();
  const [history, setHistory] = useState<AnthroRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Bearer: el endpoint exige auth (requireAuth); sin la cabecera respondía 401
    // y la curva/APHV nunca se pintaban.
    getAuthHeaders()
      .then((headers) =>
        fetch(`/api/players/anthropometrics?playerId=${playerId}&history=true`, {
          headers,
          credentials: "include",
        }),
      )
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data?.data?.history)) {
          // Asc by age para plotting natural
          const sorted = [...data.data.history].sort(
            (a: AnthroRow, b: AnthroRow) => a.chronological_age - b.chronological_age,
          );
          setHistory(sorted);
        }
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [playerId]);

  // Compute chart points + APHV prediction
  const { points, aphv, currentOffset, latestCategory, latestTrust } = useMemo(() => {
    if (history.length === 0) {
      return { points: [], aphv: null, currentOffset: null, latestCategory: null, latestTrust: null };
    }

    const pts: ChartPoint[] = history.map((m, i) => {
      let velocity: number | null = null;
      if (i > 0) {
        const prev = history[i - 1];
        const dAge = m.chronological_age - prev.chronological_age; // años
        if (dAge > 0.05) {
          velocity = (m.height_cm - prev.height_cm) / dAge;
        }
      }
      return {
        age: Number(m.chronological_age.toFixed(2)),
        height: m.height_cm,
        velocity,
        measuredAt: m.measured_at,
      };
    });

    // APHV = chronological_age - maturity_offset (último registro) — SOLO si la fila
    // es fiable (gate único: 4 medidas + edad decimal por fecha de nacimiento, 069).
    // Una fila antigua (edad entera) o incompleta NO produce APHV ni categoría.
    const latest = history[history.length - 1];
    const trust = trustAnthroForPlayer(latest, { gender: sexGender, sexConfirmedAt: sexConfirmed });
    if (!trust.trusted || trust.offset === null || trust.chronologicalAge === null) {
      return { points: pts, aphv: null, currentOffset: null, latestCategory: null, latestTrust: trust };
    }
    const aphvEstimate = trust.chronologicalAge - trust.offset;

    return {
      points: pts,
      aphv: Number(aphvEstimate.toFixed(2)),
      currentOffset: trust.offset,
      latestCategory: trust.category,
      latestTrust: trust,
    };
  }, [history, sexGender, sexConfirmed]);
  const gateText = usePhvGateText()({ code: latestTrust?.code ?? "no_row", missing: latestTrust?.missing, bare: true });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 gap-2">
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">{t("growthVelocityChart.loadingHistory")}</span>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-secondary/30 border border-border p-3">
        <AlertCircle size={14} className="text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-[11px] font-display font-bold text-foreground">{t("growthVelocityChart.noLongitudinalData")}</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t("growthVelocityChart.noLongitudinalDataHint")}
          </p>
        </div>
      </div>
    );
  }

  const hasOnePoint = history.length === 1;

  return (
    <div className="space-y-3">
      {/* Header con APHV + estado */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label={t("growthVelocityChart.aphvEst")} value={aphv !== null ? `${aphv.toFixed(1)}a` : gateText} icon={<Sparkles size={11} />} gated={aphv === null} />
        <Stat label={t("growthVelocityChart.currentOffset")} value={currentOffset !== null ? `${currentOffset > 0 ? "+" : ""}${currentOffset.toFixed(1)}a` : gateText} gated={currentOffset === null} />
        <Stat label={t("growthVelocityChart.measurements")} value={String(history.length)} />
      </div>

      {hasOnePoint ? (
        aphv !== null ? (
          <div className="rounded-lg bg-secondary/30 border border-border p-3 text-[11px] text-muted-foreground">
            {t("growthVelocityChart.onePointMessage", { aphv: aphv.toFixed(1) })}
          </div>
        ) : (
          <PhvGateNotice variant="card" code={latestTrust?.code ?? "no_row"} missing={latestTrust?.missing} />
        )
      ) : (
        <div className="rounded-xl bg-secondary/30 border border-border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2 px-2">
            <TrendingUp size={11} className="inline mr-1" />
            {t("growthVelocityChart.chartTitle")}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
              <XAxis
                dataKey="age"
                type="number"
                domain={["dataMin - 0.5", "dataMax + 0.5"]}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => `${v}a`}
              />
              <YAxis
                yAxisId="height"
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                label={{ value: "cm", angle: -90, position: "insideLeft", fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                yAxisId="velocity"
                orientation="right"
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                label={{ value: t("growthVelocityChart.cmPerYear"), angle: 90, position: "insideRight", fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 10,
                }}
                formatter={(value: number, name: string) =>
                  name === t("growthVelocityChart.height")
                    ? [`${value} cm`, t("growthVelocityChart.height")]
                    : [`${value?.toFixed(1)} ${t("growthVelocityChart.cmPerYear")}`, t("growthVelocityChart.velocity")]
                }
                labelFormatter={(v) => `${v}a chronologicalAge`}
              />

              {/* Ventana neuromotora · APHV ± 1y antes / +2y despues */}
              {aphv !== null && (
                <ReferenceArea
                  yAxisId="height"
                  x1={aphv - 1}
                  x2={aphv + 2}
                  fill="hsl(var(--primary))"
                  fillOpacity={0.08}
                  stroke="hsl(var(--primary))"
                  strokeOpacity={0.3}
                  strokeDasharray="3 3"
                />
              )}

              {/* Línea APHV */}
              {aphv !== null && (
                <ReferenceLine
                  yAxisId="height"
                  x={aphv}
                  stroke="hsl(var(--primary))"
                  strokeDasharray="4 4"
                  label={{ value: "PHV", fontSize: 9, fill: "hsl(var(--primary))", position: "top" }}
                />
              )}

              <Line
                yAxisId="height"
                type="monotone"
                dataKey="height"
                stroke="hsl(var(--electric))"
                strokeWidth={2}
                name={t("growthVelocityChart.height")}
                dot={{ r: 3, fill: "hsl(var(--electric))" }}
                activeDot={{ r: 5 }}
              />
              <Area
                yAxisId="velocity"
                type="monotone"
                dataKey="velocity"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.2}
                name={t("growthVelocityChart.velocity")}
                dot={{ r: 2, fill: "hsl(var(--primary))" }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Hint educativo — la categoría solo con fila fiable (gate único). */}
      {latestCategory ? (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          <Trans
            i18nKey="growthVelocityChart.hint"
            values={{
              category:
                latestCategory === "early" ? t("growthVelocityChart.categoryEarly") :
                latestCategory === "late"  ? t("growthVelocityChart.categoryLate") :
                                             t("growthVelocityChart.categoryOntime"),
            }}
            components={{ strong: <strong />, strongCat: <strong className="text-foreground" /> }}
          />
        </p>
      ) : (
        !hasOnePoint && <PhvGateNotice variant="card" code={latestTrust?.code ?? "no_row"} missing={latestTrust?.missing} />
      )}
    </div>
  );
}

function Stat({ label, value, icon, gated }: { label: string; value: string; icon?: React.ReactNode; gated?: boolean }) {
  return (
    <div className="rounded-lg bg-secondary/30 border border-border px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-muted-foreground font-bold flex items-center gap-1">
        {icon}{label}
      </div>
      {gated ? (
        <div className="text-[10px] italic text-muted-foreground leading-snug">{value}</div>
      ) : (
        <div className="text-sm font-display font-bold text-foreground">{value}</div>
      )}
    </div>
  );
}
