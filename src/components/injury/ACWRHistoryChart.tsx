/**
 * ACWRHistoryChart — ACWR trend over 28 days with danger zone bands
 *
 * Shows:
 * - ACWR line over time
 * - Color-coded zone bands: green (optimal), yellow (caution), red (danger)
 * - Optional injury markers from InjuryTimeline data
 *
 * Data source: fatigue_sessions via PlayerTrackingService.getFatigueHistory()
 *
 * P1 block 4: the colour of each point is the ZONE that comes with the data
 * (classified once, in acwrService, with the player's maturation thresholds). The
 * chart no longer re-classifies the ratio with fixed adult cut-offs (1.5/1.3/0.8),
 * which ignored maturation and raised a "danger" warning on its own. A point
 * without zone (maturation not recorded, or not enough history) is grey.
 *
 * Sprint 11: Injury Dashboard & Alerts
 */

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { motion } from "framer-motion";
import { Activity, AlertTriangle } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

interface ACWRDataPoint {
  date: string;
  acwr: number | null;
  load: number | null;
  zone: "optimal" | "caution" | "danger" | "undertrained" | "unknown";
}

interface InjuryMarker {
  date: string;
  type: string;
  severity: "mild" | "moderate" | "severe";
}

interface ACWRHistoryChartProps {
  data: ACWRDataPoint[];
  injuryMarkers?: InjuryMarker[];
  height?: number;
  compact?: boolean;
}

// ── Zone config ─────────────────────────────────────────────────────────────

const ZONE_COLORS = {
  optimal: "#22c55e",
  caution: "#eab308",
  danger: "#ef4444",
  undertrained: "#8b5cf6",
  unknown: "#94a3b8",
};

// Sin cifras de corte: dependen de la maduración de cada jugador (acwrService).
const ZONE_LABELS: Record<string, string> = {
  optimal: "Optimo",
  caution: "Precaucion",
  danger: "Peligro",
  undertrained: "Baja carga",
  unknown: "Sin zona",
};

type Zone = keyof typeof ZONE_COLORS;
const zoneOf = (z: unknown): Zone =>
  z === "optimal" || z === "caution" || z === "danger" || z === "undertrained" ? z : "unknown";

// ── Custom tooltip ──────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; payload?: ACWRDataPoint }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const acwr = payload[0]?.value;
  const zone = zoneOf(payload[0]?.payload?.zone);

  return (
    <div className="glass rounded-lg px-3 py-2 border border-border/50 shadow-md">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 mt-1">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: ZONE_COLORS[zone] }}
        />
        <span className="text-sm font-display font-bold text-foreground">
          {acwr?.toFixed(2) ?? "N/A"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {ZONE_LABELS[zone]}
        </span>
      </div>
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ACWRHistoryChart({
  data,
  injuryMarkers = [],
  height = 220,
  compact = false,
}: ACWRHistoryChartProps) {
  const chartData = useMemo(() => {
    return data.map((d) => ({
      ...d,
      dateLabel: d.date.slice(5), // MM-DD
    }));
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Activity size={24} className="text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">
          Sin datos de ACWR. Analiza al menos 4 sesiones.
        </p>
      </div>
    );
  }

  const latestPoint = data.filter((d) => d.acwr != null).slice(-1)[0];
  const latestACWR = latestPoint?.acwr;
  const latestZone = zoneOf(latestPoint?.zone);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-primary" />
            <h4 className="font-display font-bold text-sm text-foreground">
              ACWR · Ultimos 28 dias
            </h4>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: ZONE_COLORS[latestZone] }}
            />
            <span className="text-xs font-display font-bold" style={{ color: ZONE_COLORS[latestZone] }}>
              {latestACWR?.toFixed(2) ?? "N/A"}
            </span>
          </div>
        </div>
      )}

      {/* Zone legend */}
      {!compact && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(ZONE_LABELS).map(([zone, label]) => (
            <div key={zone} className="flex items-center gap-1">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: ZONE_COLORS[zone as keyof typeof ZONE_COLORS] }}
              />
              <span className="text-[9px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />

          {/* Referencia neutra: carga aguda = crónica (no es un umbral de riesgo). */}
          <ReferenceLine y={1.0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.4} />

          {/* Injury markers */}
          {injuryMarkers.map((marker, i) => (
            <ReferenceLine
              key={`inj-${i}`}
              x={marker.date.slice(5)}
              stroke={marker.severity === "severe" ? "#ef4444" : marker.severity === "moderate" ? "#f97316" : "#eab308"}
              strokeWidth={2}
              strokeDasharray="2 2"
              label={{
                value: `🩹 ${marker.type}`,
                position: "top",
                fontSize: 9,
                fill: "#ef4444",
              }}
            />
          ))}

          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 2.5]}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            ticks={[0, 0.5, 1.0, 1.5, 2.0]}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* ACWR area (subtle fill) */}
          <Area
            type="monotone"
            dataKey="acwr"
            stroke="transparent"
            fill="hsl(var(--primary))"
            fillOpacity={0.08}
            connectNulls
          />

          {/* ACWR line */}
          <Line
            type="monotone"
            dataKey="acwr"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={(props: { cx: number; cy: number; payload: ACWRDataPoint }) => {
              const { cx, cy, payload } = props;
              const color = ZONE_COLORS[zoneOf(payload.zone)];
              return (
                <circle
                  key={`dot-${cx}-${cy}`}
                  cx={cx}
                  cy={cy}
                  r={3}
                  fill={color}
                  stroke="white"
                  strokeWidth={1.5}
                />
              );
            }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Danger warning */}
      {latestZone === "danger" && (
        <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
          <AlertTriangle size={14} className="text-red-500 shrink-0" />
          <p className="text-[11px] text-red-600 dark:text-red-400">
            ACWR en zona de peligro. Reducir carga de entrenamiento inmediatamente.
          </p>
        </div>
      )}
    </motion.div>
  );
}

export type { ACWRDataPoint, InjuryMarker };
