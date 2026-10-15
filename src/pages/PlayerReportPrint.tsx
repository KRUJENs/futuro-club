/**
 * VITAS — Player Report Print Layout
 * Ruta: /report/:id
 * Optimizado para impresión / exportación PDF.
 * Incluye RadarChart (Recharts), VSI gauge SVG, PHV, VAEP.
 */
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useRawPlayerById } from "@/hooks/usePlayers";
import { adaptPlayerForUI } from "@/services/real/adapters";
import { phvGate } from "@/lib/phv/phvGate";
import { PhvGateNotice } from "@/components/phv/PhvGateNotice";
import { MetricsService, completeCoachMetrics, fichaVsiFromBlob } from "@/services/real/metricsService";
import { useEffect, useRef } from "react";
import { DominantFeaturesService } from "@/services/real/advancedMetricsService";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { computeVsiDelta, realVsiEvaluations } from "@/lib/scoring/vsiDelta";
import { MetricValue } from "@/components/metrics/MetricValue";

// ─── VSI Gauge SVG ────────────────────────────────────────────────────────────

function VsiGauge({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const angle = (clamped / 100) * 180 - 180; // -180 a 0
  const r = 54;
  const cx = 70;
  const cy = 70;

  // arco de fondo
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  // aguja
  const rad = (angle * Math.PI) / 180;
  const nx = cx + r * 0.7 * Math.cos(rad);
  const ny = cy + r * 0.7 * Math.sin(rad);

  const tierColor =
    clamped >= 85 ? "#10b981" :
    clamped >= 70 ? "#7c3aed" :
    clamped >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <svg width="140" height="80" viewBox="0 0 140 80">
      {/* Track */}
      <path d={arcPath} fill="none" stroke="#e5e7eb" strokeWidth="10" strokeLinecap="round" />
      {/* Fill */}
      <path
        d={arcPath}
        fill="none"
        stroke={tierColor}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * 170} 170`}
        strokeDashoffset="0"
      />
      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#1f2937" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="4" fill="#1f2937" />
      {/* Value */}
      <text x={cx} y={cy - 12} textAnchor="middle" fontSize="18" fontWeight="bold" fill={tierColor}>
        {clamped}
      </text>
    </svg>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function PlayerReportPrint() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { data: rawPlayer, isLoading } = useRawPlayerById(id);
  const rootRef = useRef<HTMLDivElement>(null);
  const isImageMode = searchParams.get("format") === "image";

  useEffect(() => {
    if (isLoading || !rawPlayer) return;

    if (isImageMode) {
      // html2canvas captura y descarga PNG
      import("html2canvas").then(({ default: html2canvas }) => {
        setTimeout(() => {
          if (!rootRef.current) return;
          html2canvas(rootRef.current, { scale: 2, useCORS: true }).then((canvas) => {
            const link = document.createElement("a");
            link.download = `vitas-report-${rawPlayer.name.replace(/\s/g, "-")}.png`;
            link.href = canvas.toDataURL("image/png");
            link.click();
          });
        }, 600);
      });
    } else {
      setTimeout(() => window.print(), 500);
    }
  }, [isLoading, rawPlayer, isImageMode]);

  if (isLoading) return <div className="p-8 text-center">{t("playerReportPrint.loading")}</div>;
  if (!rawPlayer) return <div className="p-8 text-center">{t("playerReportPrint.playerNotFound")}</div>;
  // Jugador sin evaluar: sin VSI de ficha guardado (regla única fichaVsiFromBlob) o sin
  // las 6 barras completas no hay VSI ni radar que imprimir. Se nombra el hueco en vez
  // de fabricar un informe con ceros (invariante #2). Antes bastaba con que existiera
  // `metrics` y se recalculaba: `metrics: {}` imprimía «VSI 0» (revisión del PR #317).
  const coachMetrics = completeCoachMetrics(rawPlayer.metrics);
  const vsi = fichaVsiFromBlob(rawPlayer);
  if (!coachMetrics || vsi === null) {
    return <div className="p-8 text-center text-muted-foreground">{t("common.notEvaluated")}</div>;
  }

  const player = adaptPlayerForUI(rawPlayer);
  const vsiTier = MetricsService.classifyVSI(vsi);
  const dominantFeatures = DominantFeaturesService.calculate(coachMetrics);

  // Evolución y variación del VSI SOLO desde evaluaciones del entrenador con fecha y
  // origen: la misma fuente única (src/lib/scoring/vsiDelta.ts) que el panel de familia
  // y el ScoutFeed. Antes se graficaba `vsiHistory` —legacy SIN fechas, con el 57.5
  // fabricado antes de #146— y se rotulaba «En ascenso» restando sus dos últimas
  // posiciones: con [57.5, 67.4] el informe impreso decía «Subiendo» mientras el panel
  // de familia bloqueaba la misma variación (invariante #7).
  const datedEvaluations = realVsiEvaluations(rawPlayer.vsiEvaluations);
  const vsiDelta = computeVsiDelta({
    evaluations: rawPlayer.vsiEvaluations,
    legacyHistory: rawPlayer.vsiHistory,
    currentVsi: vsi,
  });
  const vsiDeltaShown = {
    ...vsiDelta,
    gate_reason: vsiDelta.gate_code
      ? t(`vsiDelta.gate.${vsiDelta.gate_code}`, { defaultValue: vsiDelta.gate_reason ?? "" })
      : vsiDelta.gate_reason,
  };
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "short", year: "numeric" }) : "";

  const metricLabels: Record<string, string> = {
    speed: t("playerReportPrint.metricSpeed"),
    technique: t("playerReportPrint.metricTechnique"),
    vision: t("playerReportPrint.metricVision"),
    stamina: t("playerReportPrint.metricStamina"),
    shooting: t("playerReportPrint.metricShooting"),
    defending: t("playerReportPrint.metricDefending"),
  };

  const radarData = Object.entries(coachMetrics).map(([key, value]) => ({
    subject: metricLabels[key] ?? key,
    value,
    fullMark: 100,
  }));

  const reportId = `VIT-${rawPlayer.id?.slice(0, 6).toUpperCase() ?? "000000"}`;

  // Maduración SOLO desde el gate único (regla del owner 28-sep). Antes: el
  // phvCategory PERSISTIDO, y "early" (= pre-PHV, un ESTADO) se imprimía como
  // «madurador TARDÍO» (un TIMING vs pares) — a todo pre-púber se le llamaba tardío.
  const phv = phvGate(rawPlayer);
  const phvTimingLabel = !phv.ok ? null
    : phv.assessment.timing === "late" ? t("playerReportPrint.maturationLate")
    : phv.assessment.timing === "early" ? t("playerReportPrint.maturationEarly")
    : phv.assessment.timing === "on_time" ? t("playerReportPrint.maturationNormal")
    : t("maturity.timing.unknown");

  // VAEP data if available (safe runtime check)
  const vaepPer90 = rawPlayer && typeof rawPlayer === "object" && "vaepPer90" in rawPlayer
    ? (rawPlayer as Record<string, unknown>).vaepPer90 as number | undefined
    : undefined;
  const hasVaep = vaepPer90 != null;

  return (
    <div
      ref={rootRef}
      className="bg-white text-gray-900 min-h-screen p-8 max-w-2xl mx-auto font-sans"
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-8 pb-6 border-b-2 border-gray-200">
        <div>
          <div className="text-xs font-bold tracking-widest text-purple-600 uppercase mb-1">
            VITAS Football Intelligence
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{rawPlayer.name}</h1>
          <div className="text-sm text-gray-500 mt-1">
            {rawPlayer.position} · {t("playerReportPrint.yearsOld", { count: rawPlayer.age })}{rawPlayer.competitiveLevel ? ` · ${rawPlayer.competitiveLevel}` : ""}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {t("playerReportPrint.report")} {reportId} · {t("playerReportPrint.generated")}: {new Date().toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })}
          </div>
        </div>
        <div className="text-center">
          <VsiGauge value={vsi} />
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider -mt-2">VSI Score</div>
          <div className="text-xs text-gray-400 capitalize">{vsiTier}</div>
        </div>
      </div>

      {/* Radar + Métricas en fila */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        {/* RadarChart */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("playerReportPrint.technicalProfile")}</h2>
          <div style={{ width: "100%", height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData}>
                <PolarGrid stroke="#e5e7eb" />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={{ fontSize: 9, fill: "#6b7280" }}
                />
                <Radar
                  name={rawPlayer.name}
                  dataKey="value"
                  stroke="#7c3aed"
                  fill="#7c3aed"
                  fillOpacity={0.25}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Barras de métricas */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("playerReportPrint.values")}</h2>
          <div className="space-y-2.5 mt-2">
            {Object.entries(coachMetrics).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-20 shrink-0">{metricLabels[key] ?? key}</span>
                <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-purple-500" style={{ width: `${value}%` }} />
                </div>
                <span className="text-[10px] font-bold text-gray-700 w-5 text-right">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* VSI Evolution — solo evaluaciones con fecha; la variación, calculada o su motivo */}
      <div className="mb-8" data-testid="report-vsi-evolution">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("playerReportPrint.vsiEvolution")}</h2>
        {datedEvaluations.length >= 2 && (
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={datedEvaluations.map((e) => ({
                  eval: fmtDate(e.at),
                  vsi: Math.round(e.value * 10) / 10,
                }))}
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="eval" tick={{ fontSize: 9, fill: "#9ca3af" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#9ca3af" }} width={30} />
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 8 }}
                  formatter={(value: number) => [`${value}`, "VSI"]}
                />
                <Line
                  type="monotone"
                  dataKey="vsi"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#7c3aed" }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="flex justify-between gap-3 text-[10px] text-gray-400 mt-1">
          <span data-testid="report-vsi-delta">
            {t("playerReportPrint.vsiChange")}:{" "}
            <MetricValue
              className="font-semibold text-gray-600"
              result={vsiDeltaShown}
              format={(v, u) => `${Number(v) > 0 ? "+" : ""}${v}${u ? ` ${u}` : ""}`}
            />
            {vsiDelta.value !== null && (
              <>
                {" "}
                {t("playerReportPrint.vsiDeltaBetween", {
                  from: fmtDate(vsiDelta.from_at),
                  to: fmtDate(vsiDelta.to_at),
                })}
              </>
            )}
          </span>
          {datedEvaluations.length >= 2 && (
            <span>{t("playerReportPrint.datedEvaluationsCount", { count: datedEvaluations.length })}</span>
          )}
        </div>
      </div>

      {/* PHV — gate único: sin todas las entradas introducidas se imprime qué falta */}
      <div className="mb-6 p-4 bg-purple-50 rounded-lg border border-purple-100">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
          {t("playerReportPrint.biologicalMaturation")}
        </h2>
        {phv.ok ? (
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-semibold text-purple-700 capitalize">{phvTimingLabel}</span>
              <div className="flex gap-1 mt-1.5">
                {["early", "ontme", "late"].map((cat) => (
                  <div
                    key={cat}
                    className={`h-1.5 flex-1 rounded-full ${
                      phv.category === cat ? "bg-purple-500" : "bg-gray-200"
                    }`}
                  />
                ))}
              </div>
            </div>
            <span className="text-sm text-gray-500">
              {t("playerReportPrint.offset")}: {(phv.mirwald.offset > 0 ? "+" : "") + phv.mirwald.offset.toFixed(2)} {t("playerReportPrint.years")}
            </span>
          </div>
        ) : (
          <PhvGateNotice className="text-sm" gate={phv} />
        )}
      </div>

      {/* Características dominantes */}
      <div className="mb-6">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("playerReportPrint.dominantFeatures")}</h2>
        <div className="flex gap-2 flex-wrap mb-2">
          {dominantFeatures.dominant.map((f) => (
            <span key={f.key} className="px-2 py-1 bg-purple-100 text-purple-700 text-xs font-semibold rounded">
              {f.label} ({f.value})
            </span>
          ))}
        </div>
        <div className="text-xs text-gray-500">
          {t("playerReportPrint.style")}: <span className="font-semibold capitalize">{dominantFeatures.playStyle}</span> ·{" "}
          {t("playerReportPrint.specialization")}: {Math.round(dominantFeatures.specializationIndex * 100)}%
        </div>
      </div>

      {/* VAEP */}
      {hasVaep && (
        <div className="mb-6 p-4 bg-green-50 rounded-lg border border-green-100">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">VAEP (Value Added per 90)</h2>
          <div className="text-2xl font-black text-green-700">
            {vaepPer90 != null ? (vaepPer90 > 0 ? "+" : "") + vaepPer90.toFixed(3) : "N/D"}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {t("playerReportPrint.vaepDescription")}
          </p>
        </div>
      )}

      {/* Sin «Benchmark vs pares» (P1 bloque 5): comparaba las barras del entrenador /10
          con un campo que los jugadores no tienen (`stats`), así que imprimía P100 en cada
          dimensión. La comparación con pares es /api/benchmark/peer (percentil único). */}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="text-center p-3 bg-gray-50 rounded-lg">
          <div className="text-2xl font-black text-gray-800">{rawPlayer.minutesPlayed}</div>
          <div className="text-xs text-gray-500">{t("playerReportPrint.minutesPlayed")}</div>
        </div>
        {/* Recuento de evaluaciones CON FECHA: el largo de vsiHistory contaba como
            «evaluación» el 57.5 que la app guardaba sin que nadie evaluara (antes de #146). */}
        <div className="text-center p-3 bg-gray-50 rounded-lg" data-testid="report-dated-evaluations">
          <div className="text-2xl font-black text-gray-800">{datedEvaluations.length}</div>
          <div className="text-xs text-gray-500">{t("playerReportPrint.datedEvaluations")}</div>
        </div>
        {/* Sin pie registrado no se imprime una tarjeta «Pie dominante» en blanco. */}
        {(rawPlayer.foot === "right" || rawPlayer.foot === "left" || rawPlayer.foot === "both") && (
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <div className="text-2xl font-black text-gray-800 capitalize">
              {rawPlayer.foot === "right" ? t("playerReportPrint.footRight") : rawPlayer.foot === "left" ? t("playerReportPrint.footLeft") : t("playerReportPrint.footBoth")}
            </div>
            <div className="text-xs text-gray-500">{t("playerReportPrint.dominantFoot")}</div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="pt-6 border-t border-gray-200 flex items-center justify-between">
        <div className="text-xs text-purple-600 font-bold tracking-widest uppercase">VITAS.</div>
        <div className="text-xs text-gray-400">
          Football Intelligence · krujens.eu · {reportId}
        </div>
        <div className="text-xs text-gray-400">© {new Date().getFullYear()}</div>
      </div>
    </div>
  );
}
