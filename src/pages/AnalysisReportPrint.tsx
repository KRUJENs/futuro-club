/**
 * VITAS — Analysis Report Print Layout
 * Ruta: /analysis-report/:id
 * Optimizado para impresión / exportación PDF.
 * Lee datos de sessionStorage o Supabase (player_analyses).
 */
import { useParams, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
} from "recharts";
import { validatePlayerReport, type ValidationResult } from "@/services/real/reportValidator";
import {
  computeMatchStats,
  RATING_LABEL_ES,
  RATING_COLOR,
  KPI_RATING_LABEL_ES,
} from "@/services/real/matchStatsService";
import type { VideoIntelligenceOutput } from "@/agents/contracts";
import { duelsGateText } from "@/lib/metrics/duelsGate";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DimensionScore {
  score: number;
  observacion: string;
}

interface AnalysisReport {
  estadoActual: {
    resumenEjecutivo: string;
    nivelActual: string | null; // null ⇒ el agente no dio nivel (no se pinta)
    fortalezasPrimarias: string[];
    areasDesarrollo: string[];
    dimensiones: {
      velocidadDecision: DimensionScore;
      tecnicaConBalon: DimensionScore;
      inteligenciaTactica: DimensionScore;
      capacidadFisica: DimensionScore;
      liderazgoPresencia: DimensionScore;
      eficaciaCompetitiva: DimensionScore;
    };
    ajusteVSIVideoScore: number | null; // null ⇒ VSI-vídeo bloqueado (#40)
  };
  adnFutbolistico: {
    estiloJuego: string;
    arquetipoTactico: string;
    patrones: Array<{ patron: string; frecuencia: string; descripcion: string }>;
    mentalidad: string;
  };
  jugadorReferencia: {
    /** null ⇒ sin comparable (no se pinta la sección). score = % 0-100. */
    bestMatch: {
      nombre: string;
      posicion: string;
      club: string;
      score: number;
      narrativa: string;
    } | null;
  };
  proyeccionCarrera: {
    escenarioOptimista: { descripcion: string; nivelProyecto: string };
    escenarioRealista: { descripcion: string; nivelProyecto: string };
    factoresClave: string[];
    riesgos: string[];
  } | null;
  planDesarrollo: {
    objetivo6meses: string;
    objetivo18meses: string;
    pilaresTrabajo: Array<{ pilar: string; acciones: string[]; prioridad: string }>;
  };
  metricasCuantitativas?: {
    fisicas?: {
      velocidadMaxKmh: number;
      velocidadPromKmh: number;
      distanciaM: number;
      sprints: number;
      zonasIntensidad: { caminar: number; trotar: number; correr: number; sprint: number };
    };
    eventos?: {
      pasesCompletados: number;
      pasesFallados: number;
      precisionPases: number;
      recuperaciones: number;
      disparosAlArco: number;
      disparosFuera: number;
    };
    fuente: string;
    confianza: number;
  };
  confianza: number | null;
}

interface StoredReport {
  report: AnalysisReport;
  playerName: string;
  playerPosition: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dimensionLabels: Record<string, string> = {
  velocidadDecision: "Velocidad de Decisión",
  tecnicaConBalon: "Técnica con Balón",
  inteligenciaTactica: "Inteligencia Táctica",
  capacidadFisica: "Capacidad Física",
  liderazgoPresencia: "Liderazgo y Presencia",
  eficaciaCompetitiva: "Eficacia Competitiva",
};

function scoreColor(score: number): string {
  if (score >= 85) return "#10b981";
  if (score >= 70) return "#7c3aed";
  if (score >= 50) return "#f59e0b";
  return "#ef4444";
}

function confianzaBadge(value: number, label: string) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 80 ? "bg-green-100 text-green-700" :
    pct >= 60 ? "bg-yellow-100 text-yellow-700" :
    "bg-red-100 text-red-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {label}: {pct}%
    </span>
  );
}

function formatDate(): string {
  return new Date().toLocaleDateString("es-ES", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ─── Print Styles ─────────────────────────────────────────────────────────────

const printStyles = `
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page-break { page-break-before: always; }
  .no-break { page-break-inside: avoid; }
}
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AnalysisReportPrint() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // ?mode=executive ⇒ informe serio para dirección (subconjunto curado);
  // por defecto 'technical' ⇒ todo lo que genera el software (para el cuerpo técnico).
  const mode: "executive" | "technical" =
    searchParams.get("mode") === "executive" ? "executive" : "technical";
  const [data, setData] = useState<StoredReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load report data
  useEffect(() => {
    if (!id) {
      setError(t("analysisReportPrint.errorNoId"));
      setLoading(false);
      return;
    }

    const storageKey = `vitas-analysis-report-${id}`;
    const stored = sessionStorage.getItem(storageKey);

    if (stored) {
      try {
        const parsed = JSON.parse(stored) as StoredReport;
        setData(parsed);
        setLoading(false);
        return;
      } catch {
        // fall through to Supabase
      }
    }

    // Try Supabase if ID looks like a UUID
    if (UUID_RE.test(id) && SUPABASE_CONFIGURED) {
      supabase
        .from("player_analyses")
        .select("*")
        .eq("id", id)
        .maybeSingle()
        .then(({ data: row, error: err }) => {
          if (err || !row) {
            setError(t("analysisReportPrint.errorNotFound"));
            setLoading(false);
            return;
          }
          const report = (typeof row.report === "string" ? JSON.parse(row.report) : row.report) as AnalysisReport;
          setData({
            report,
            playerName: (row as Record<string, unknown>).player_name as string ?? t("analysisReportPrint.playerFallback"),
            playerPosition: (row as Record<string, unknown>).player_position as string ?? "",
          });
          setLoading(false);
        });
    } else {
      setError(t("analysisReportPrint.errorNotFoundSession"));
      setLoading(false);
    }
  }, [id, t]);

  // Auto-print
  useEffect(() => {
    if (!data || loading) return;
    const timer = setTimeout(() => window.print(), 1500);
    return () => clearTimeout(timer);
  }, [data, loading]);

  if (loading) return <div className="p-8 text-center text-gray-500">{t("analysisReportPrint.loading")}</div>;
  if (error || !data) return <div className="p-8 text-center text-red-500">{error ?? t("analysisReportPrint.errorUnknown")}</div>;

  const { report, playerName, playerPosition } = data;
  const r = report;
  const dims = r.estadoActual.dimensiones;
  const fisicas = r.metricasCuantitativas?.fisicas;
  const eventos = r.metricasCuantitativas?.eventos;

  // #dimensiones fabricadas: el pipeline de vídeo NO puntúa por dimensión; el `score`
  // de cada DimensionScore es una CONSTANTE fabricada rotulada "Estimado por IA".
  // Solo mostramos radar/barras cuando el informe declara explícitamente que las
  // dimensiones fueron medidas (hoy siempre false ⇒ se ocultan; nunca un 0, inv #2).
  // Acceso cast-safe/null-safe al flag a nivel informe (no toca tipos declarados).
  const dimensionesMedidas =
    ((r.estadoActual as Record<string, unknown> | undefined)?.dimensionesMedidas === true);

  // Translated dimension label with Spanish module-scope fallback
  const dimLabel = (key: string): string =>
    t(`analysisReportPrint.dim.${key}`, { defaultValue: dimensionLabels[key] ?? key });

  // Panel de stats clásico tipo Wyscout — calculado on-the-fly (puro)
  const matchStats = computeMatchStats(
    r.metricasCuantitativas as VideoIntelligenceOutput["metricasCuantitativas"],
  );

  // RadarChart data from dimensions
  // #dimensiones fabricadas: no derivamos datos de radar a partir de scores fabricados;
  // si el informe no declara dimensionesMedidas===true, saltamos el cálculo (array vacío).
  const radarData = dimensionesMedidas
    ? (Object.entries(dims) as [string, DimensionScore][]).map(([key, dim]) => ({
        subject: dimLabel(key).split(" ").slice(0, 2).join(" "),
        value: dim.score,
        fullMark: 10,
      }))
    : [];

  // Quality validation: deriva de los `dim.score` (fabricados si el pipeline no mide
  // dimensiones) → solo se calcula si dimensionesMedidas===true; si no, queda null y su
  // sección (guardada por `validation &&`) se oculta (inv #2).
  // Sin «Benchmark vs pares» (P1 bloque 5): comparaba la nota del vídeo (IA, 0-10) con las
  // barras del entrenador /10 —instrumentos distintos— de jugadores de 14 años fijos,
  // leyendo un campo que los jugadores no tienen (P100 en cada dimensión).
  let validation: ValidationResult | null = null;
  if (dimensionesMedidas) {
    try {
      validation = validatePlayerReport(
        r as unknown as VideoIntelligenceOutput,
        { age: 14, position: playerPosition || "MC" },
      );
    } catch {
      // validator may fail if report structure is partial
    }
  }

  return (
    <>
      <style>{printStyles}</style>
      <div
        className="bg-white text-gray-900 min-h-screen p-8 max-w-3xl mx-auto font-sans print:p-4"
        style={{ fontFamily: "system-ui, sans-serif", fontSize: "13px" }}
      >
        {/* ── 1. Header ──────────────────────────────────────────────── */}
        <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-200 no-break">
          <div>
            <div className="text-[10px] font-bold tracking-widest text-purple-600 uppercase mb-1">
              VITAS Intelligence · {mode === "executive" ? t("analysisReportPrint.typeExecutive") : t("analysisReportPrint.typeTechnical")}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">{playerName}</h1>
            {playerPosition && (
              <div className="text-sm text-gray-500 mt-0.5">{playerPosition}</div>
            )}
            <div className="text-[10px] text-gray-400 mt-1">
              {t("analysisReportPrint.generatedLabel")}: {formatDate()}
            </div>
          </div>
          <div className="text-right shrink-0 ml-4">
            {r.confianza != null && confianzaBadge(r.confianza, t("analysisReportPrint.confidence"))}
            {r.estadoActual.ajusteVSIVideoScore != null && (
              <div className="mt-2 text-[10px] text-gray-400">
                {t("analysisReportPrint.vsiAdjust")}: <span className="font-bold text-gray-700">{r.estadoActual.ajusteVSIVideoScore}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── At-a-glance (solo ejecutivo · para dirección) ────────────── */}
        {mode === "executive" && (
          <section className="mb-6 no-break grid grid-cols-2 sm:grid-cols-4 gap-2">
            {r.estadoActual.nivelActual && (
              <GlanceCard label={t("analysisReportPrint.glanceLevel")} value={r.estadoActual.nivelActual} />
            )}
            {r.confianza != null && (
              <GlanceCard label={t("analysisReportPrint.confidence")} value={`${Math.round(r.confianza * 100)}%`} />
            )}
            {r.jugadorReferencia?.bestMatch?.nombre && (
              <GlanceCard label={t("analysisReportPrint.glanceComparable")} value={r.jugadorReferencia.bestMatch.nombre} />
            )}
            {r.proyeccionCarrera?.escenarioRealista?.nivelProyecto && (
              <GlanceCard label={t("analysisReportPrint.glanceProjection")} value={r.proyeccionCarrera.escenarioRealista.nivelProyecto} />
            )}
          </section>
        )}

        {/* ── 2. Resumen Ejecutivo ────────────────────────────────────── */}
        <section className="mb-6 no-break">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.executiveSummary")}</h2>
          {r.estadoActual.resumenEjecutivo && (
            <p className={mode === "executive" ? "text-base text-gray-800 leading-relaxed" : "text-sm text-gray-700 leading-relaxed"}>{r.estadoActual.resumenEjecutivo}</p>
          )}
          {r.estadoActual.nivelActual && (
            <div className="flex gap-4 mt-3 text-xs">
              <div>
                <span className="text-gray-400">{t("analysisReportPrint.currentLevel")}:</span>{" "}
                <span className="font-semibold text-purple-700">{r.estadoActual.nivelActual}</span>
              </div>
            </div>
          )}
          <div className="flex gap-2 flex-wrap mt-3">
            {r.estadoActual.fortalezasPrimarias.map((f, i) => (
              <span key={i} className="px-2 py-0.5 bg-green-50 text-green-700 text-[10px] font-semibold rounded">
                {f}
              </span>
            ))}
            {r.estadoActual.areasDesarrollo.map((a, i) => (
              <span key={i} className="px-2 py-0.5 bg-orange-50 text-orange-700 text-[10px] font-semibold rounded">
                {a}
              </span>
            ))}
          </div>
        </section>

        {/* ── 3. Dimensiones + RadarChart ─────────────────────────── */}
        {/* #dimensiones fabricadas: radar y barras consumen dim.score (constante fabricada).
            Se ocultan por completo salvo que el informe declare dimensionesMedidas===true
            (hoy siempre false). No se pinta nada en su lugar — hueco visible, no 0 (inv #2). */}
        {mode === "technical" && dimensionesMedidas && (
        <section className="mb-6 no-break">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("analysisReportPrint.performanceDimensions")}</h2>
          <div className="grid grid-cols-2 gap-4">
            {/* RadarChart */}
            <div style={{ width: "100%", height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData}>
                  <PolarGrid stroke="#e5e7eb" />
                  <PolarAngleAxis dataKey="subject" tick={{ fontSize: 8, fill: "#6b7280" }} />
                  <Radar
                    name={t("analysisReportPrint.dimensionsSeries")}
                    dataKey="value"
                    stroke="#7c3aed"
                    fill="#7c3aed"
                    fillOpacity={0.25}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            {/* Bars + observations */}
            <div className="space-y-2">
              {(Object.entries(dims) as [string, DimensionScore][]).map(([key, dim]) => (
                <div key={key} className="flex items-start gap-2">
                  <span className="text-[10px] text-gray-500 w-28 shrink-0 pt-0.5">
                    {dimLabel(key)}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${dim.score * 10}%`, backgroundColor: scoreColor(dim.score * 10) }}
                        />
                      </div>
                      <span className="text-[10px] font-bold w-6 text-right" style={{ color: scoreColor(dim.score * 10) }}>
                        {dim.score}
                      </span>
                    </div>
                    <p className="text-[9px] text-gray-400 mt-0.5 leading-tight">{dim.observacion}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
        )}

        {/* ── 3c. Quality Score ──────────────────────────────────────── */}
        {mode === "technical" && validation && (
          <section className="mb-6 no-break">
            <div className="flex items-center gap-3 p-3 rounded-lg border"
              style={{
                backgroundColor: validation.qualityScore >= 80 ? "#f0fdf4" : validation.qualityScore >= 50 ? "#fefce8" : "#fef2f2",
                borderColor: validation.qualityScore >= 80 ? "#bbf7d0" : validation.qualityScore >= 50 ? "#fef08a" : "#fecaca",
              }}
            >
              <div className="text-2xl font-black" style={{
                color: validation.qualityScore >= 80 ? "#16a34a" : validation.qualityScore >= 50 ? "#ca8a04" : "#dc2626",
              }}>
                {validation.qualityScore}
              </div>
              <div>
                <div className="text-[10px] font-bold text-gray-700">Quality Score</div>
                <div className="text-[9px] text-gray-500">
                  {validation.issues.length === 0
                    ? t("analysisReportPrint.noInconsistencies")
                    : t("analysisReportPrint.issuesSummary", {
                        errors: validation.issues.filter(i => i.severity === "error").length,
                        warnings: validation.issues.filter(i => i.severity === "warning").length,
                      })}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── 4. Panel de Estadísticas (Wyscout premium) ─────────────── */}
        {mode === "technical" && matchStats && (
          <section className="mb-6 no-break">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
              {t("analysisReportPrint.statsPanel")}
            </h2>
            <div
              className="rounded-lg p-4 border"
              style={{
                background: `linear-gradient(135deg, ${RATING_COLOR[matchStats.performanceLabel]}10 0%, #fafafa 100%)`,
                borderColor: `${RATING_COLOR[matchStats.performanceLabel]}33`,
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[9px] font-bold uppercase tracking-widest text-gray-500 mb-0.5">
                    {t("analysisReportPrint.matchRating")}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className="text-3xl font-black tabular-nums"
                      style={{ color: RATING_COLOR[matchStats.performanceLabel] }}
                    >
                      {matchStats.performanceRating.toFixed(1)}
                    </span>
                    <span className="text-[10px] text-gray-400">/ 10</span>
                  </div>
                </div>
                <span
                  className="px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
                  style={{
                    backgroundColor: `${RATING_COLOR[matchStats.performanceLabel]}22`,
                    color: RATING_COLOR[matchStats.performanceLabel],
                  }}
                >
                  {RATING_LABEL_ES[matchStats.performanceLabel]}
                </span>
              </div>

              {/* Totales agregados */}
              <div className="grid grid-cols-3 gap-2 mb-3 pt-3 border-t border-gray-200">
                <div>
                  <div className="text-[8px] text-gray-500 uppercase tracking-wider">{t("analysisReportPrint.totalActions")}</div>
                  <div className="text-sm font-bold text-gray-900">{matchStats.totalAcciones}</div>
                </div>
                <div>
                  <div className="text-[8px] text-gray-500 uppercase tracking-wider">{t("analysisReportPrint.offensive")}</div>
                  <div className="text-sm font-bold text-green-700">{matchStats.totalOfensivas}</div>
                </div>
                <div>
                  <div className="text-[8px] text-gray-500 uppercase tracking-wider">{t("analysisReportPrint.defensive")}</div>
                  <div className="text-sm font-bold text-blue-700">{matchStats.totalDefensivas}</div>
                </div>
              </div>

              {/* KPIs con barras W/L */}
              <div className="space-y-2">
                {matchStats.pases && matchStats.pases.total > 0 && (
                  <PrintKpiRow
                    label={t("analysisReportPrint.passes")}
                    leftValue={matchStats.pases.completados}
                    leftLabel={t("analysisReportPrint.completed")}
                    rightValue={matchStats.pases.fallados}
                    rightLabel={t("analysisReportPrint.failed")}
                    percent={matchStats.pases.precision}
                    rating={KPI_RATING_LABEL_ES[matchStats.pases.rating]}
                    leftColor="#16a34a"
                    rightColor="#dc2626"
                  />
                )}
                {/* Duelos — SIEMPRE bloqueados (P1 bloque 6): motivo, nunca una cifra. */}
                <div className="flex items-center justify-between text-[11px]" data-testid="duels-gated">
                  <span className="text-gray-700 font-medium">{t("analysisReportPrint.duels")}</span>
                  <span className="text-[10px] text-gray-500">{duelsGateText(t).hint}</span>
                </div>
                {matchStats.recuperaciones && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-gray-700 font-medium">{t("analysisReportPrint.recoveries")}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-emerald-700 tabular-nums">{matchStats.recuperaciones.total}</span>
                      <span className="text-[9px] text-gray-500 uppercase tracking-wider">
                        {KPI_RATING_LABEL_ES[matchStats.recuperaciones.rating]}
                      </span>
                    </div>
                  </div>
                )}
                {matchStats.disparos && matchStats.disparos.total > 0 && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-gray-700 font-medium">{t("analysisReportPrint.shots")}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-amber-700 tabular-nums">
                        {matchStats.disparos.alArco}/{matchStats.disparos.total}
                      </span>
                      <span className="text-[9px] text-gray-500 uppercase tracking-wider">
                        {t("analysisReportPrint.onTarget", { percent: matchStats.disparos.precision })}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── 5. Métricas Físicas ────────────────────────────────────── */}
        {mode === "technical" && fisicas && (
          <section className="mb-6 no-break">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("analysisReportPrint.physicalMetrics")}</h2>
            {/* Caveat de procedencia (#23): estas cifras vienen de la ruta de vídeo (Gemini/YOLO)
                SIN calibración de campo → estimadas, no medidas. Nunca presentar como medición. */}
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 no-break">
              <div className="flex items-center gap-2">
                <span className="text-[8px] font-black uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">
                  {t("analysisReportPrint.physicalCaveatBadge")}
                </span>
                <span className="text-[9px] text-amber-700 leading-tight">{t("analysisReportPrint.physicalCaveat")}</span>
              </div>
              {r.metricasCuantitativas && (
                <div className="text-[8px] text-amber-600 mt-0.5">
                  {t("analysisReportPrint.physicalSource", {
                    fuente: r.metricasCuantitativas.fuente,
                    pct: Math.round((r.metricasCuantitativas.confianza ?? 0) * 100),
                  })}
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <MetricCard label={t("analysisReportPrint.maxSpeed")} value={`${fisicas.velocidadMaxKmh} km/h`} />
              <MetricCard label={t("analysisReportPrint.avgSpeed")} value={`${fisicas.velocidadPromKmh} km/h`} />
              <MetricCard label={t("analysisReportPrint.distance")} value={`${fisicas.distanciaM} m`} />
              <MetricCard label={t("analysisReportPrint.sprints")} value={String(fisicas.sprints)} />
            </div>
            {fisicas.zonasIntensidad && (
              <div className="flex gap-1 mt-3">
                {(
                  [
                    ["walk", t("analysisReportPrint.zoneWalk"), fisicas.zonasIntensidad.caminar, "#d1d5db"],
                    ["jog", t("analysisReportPrint.zoneJog"), fisicas.zonasIntensidad.trotar, "#93c5fd"],
                    ["run", t("analysisReportPrint.zoneRun"), fisicas.zonasIntensidad.correr, "#fbbf24"],
                    ["sprint", t("analysisReportPrint.zoneSprint"), fisicas.zonasIntensidad.sprint, "#f87171"],
                  ] as [string, string, number, string][]
                ).map(([id, label, pct, color]) => (
                  <div key={id} className="flex-1 text-center">
                    <div className="h-2 rounded-full" style={{ backgroundColor: color, opacity: 0.7 }} />
                    <div className="text-[8px] text-gray-500 mt-0.5">{label} {pct}%</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── 5. Métricas Eventos ────────────────────────────────────── */}
        {mode === "technical" && eventos && (
          <section className="mb-6 no-break">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">{t("analysisReportPrint.eventMetrics")}</h2>
            <div className="grid grid-cols-4 gap-3">
              <MetricCard
                label={t("analysisReportPrint.passes")}
                value={`${eventos.pasesCompletados}/${eventos.pasesCompletados + eventos.pasesFallados}`}
                sub={t("analysisReportPrint.precisionSub", { percent: eventos.precisionPases })}
              />
              <MetricCard
                label={t("analysisReportPrint.duels")}
                value={duelsGateText(t).value}
                sub={duelsGateText(t).hint}
              />
              <MetricCard label={t("analysisReportPrint.recoveries")} value={String(eventos.recuperaciones)} />
              <MetricCard
                label={t("analysisReportPrint.shots")}
                value={`${eventos.disparosAlArco}/${eventos.disparosAlArco + eventos.disparosFuera}`}
                sub={t("analysisReportPrint.onTargetSub")}
              />
            </div>
          </section>
        )}

        {/* Page break hint */}
        <div className="page-break" />

        {/* ── 6. ADN Futbolístico ────────────────────────────────────── */}
        <section className="mb-6 no-break">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.footballDna")}</h2>
          {/* Solo lo que dio el agente: una celda vacía no se pinta (antes salían textos
              por defecto como «Determinado y competitivo», inv #2). */}
          {(r.adnFutbolistico.arquetipoTactico || r.adnFutbolistico.estiloJuego || r.adnFutbolistico.mentalidad) && (
            <div className="grid grid-cols-3 gap-3 mb-3">
              {r.adnFutbolistico.arquetipoTactico && (
                <div className="p-2 bg-purple-50 rounded">
                  <div className="text-[9px] text-gray-400 uppercase">{t("analysisReportPrint.archetype")}</div>
                  <div className="text-xs font-bold text-purple-700">{r.adnFutbolistico.arquetipoTactico}</div>
                </div>
              )}
              {r.adnFutbolistico.estiloJuego && (
                <div className="p-2 bg-purple-50 rounded">
                  <div className="text-[9px] text-gray-400 uppercase">{t("analysisReportPrint.style")}</div>
                  <div className="text-xs font-bold text-purple-700">{r.adnFutbolistico.estiloJuego}</div>
                </div>
              )}
              {r.adnFutbolistico.mentalidad && (
                <div className="p-2 bg-purple-50 rounded">
                  <div className="text-[9px] text-gray-400 uppercase">{t("analysisReportPrint.mentality")}</div>
                  <div className="text-xs font-bold text-purple-700">{r.adnFutbolistico.mentalidad}</div>
                </div>
              )}
            </div>
          )}
          {mode === "technical" && r.adnFutbolistico.patrones.length > 0 && (
            <div className="space-y-1">
              {r.adnFutbolistico.patrones.map((p, i) => (
                <div key={i} className="flex gap-2 text-[10px]">
                  <span className="font-semibold text-gray-700 shrink-0">{p.patron}</span>
                  <span className="text-gray-400">({p.frecuencia})</span>
                  <span className="text-gray-500">{p.descripcion}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 7. Jugador Referencia — solo si el narrador dio un comparable (null ⇒ nada) ── */}
        {r.jugadorReferencia?.bestMatch && (
          <section className="mb-6 no-break">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.referencePlayer")}</h2>
            <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-1">
                <div>
                  <span className="text-sm font-bold text-gray-900">
                    {r.jugadorReferencia.bestMatch.nombre}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">
                    {[r.jugadorReferencia.bestMatch.posicion, r.jugadorReferencia.bestMatch.club].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className="text-xs font-bold text-purple-600">
                  {/* score ya es % (0-100); antes se multiplicaba por 100 */}
                  {t("analysisReportPrint.similarity", { percent: Math.round(r.jugadorReferencia.bestMatch.score) })}
                </span>
              </div>
              <p className="text-[11px] text-gray-600 leading-relaxed">
                {r.jugadorReferencia.bestMatch.narrativa}
              </p>
            </div>
          </section>
        )}

        {/* ── 8. Proyección de Carrera — solo si hay datos reales (null ⇒ no fabricar "Semi-pro") ── */}
        {r.proyeccionCarrera && (
        <section className="mb-6 no-break">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.careerProjection")}</h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="p-3 bg-green-50 rounded border border-green-100">
              <div className="text-[9px] text-green-600 uppercase font-bold mb-1">{t("analysisReportPrint.optimisticScenario")}</div>
              <div className="text-[10px] text-gray-400 mb-1">
                {t("analysisReportPrint.level")}: <span className="font-semibold text-green-700">{r.proyeccionCarrera.escenarioOptimista.nivelProyecto}</span>
              </div>
              <p className="text-[10px] text-gray-600 leading-snug">
                {r.proyeccionCarrera.escenarioOptimista.descripcion}
              </p>
            </div>
            <div className="p-3 bg-blue-50 rounded border border-blue-100">
              <div className="text-[9px] text-blue-600 uppercase font-bold mb-1">{t("analysisReportPrint.realisticScenario")}</div>
              <div className="text-[10px] text-gray-400 mb-1">
                {t("analysisReportPrint.level")}: <span className="font-semibold text-blue-700">{r.proyeccionCarrera.escenarioRealista.nivelProyecto}</span>
              </div>
              <p className="text-[10px] text-gray-600 leading-snug">
                {r.proyeccionCarrera.escenarioRealista.descripcion}
              </p>
            </div>
          </div>
          {r.proyeccionCarrera.factoresClave.length > 0 && (
            <div className="mb-2">
              <div className="text-[9px] text-gray-400 uppercase font-bold mb-1">{t("analysisReportPrint.keyFactors")}</div>
              <div className="flex gap-1.5 flex-wrap">
                {r.proyeccionCarrera.factoresClave.map((f, i) => (
                  <span key={i} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[9px] rounded">{f}</span>
                ))}
              </div>
            </div>
          )}
        </section>
        )}

        {/* ── 9. Plan de Desarrollo ──────────────────────────────────── */}
        <section className="mb-6 no-break">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.developmentPlan")}</h2>
          {(r.planDesarrollo.objetivo6meses || r.planDesarrollo.objetivo18meses) && (
            <div className="grid grid-cols-2 gap-3 mb-3">
              {r.planDesarrollo.objetivo6meses && (
                <div className="p-2 bg-gray-50 rounded">
                  <div className="text-[9px] text-gray-400 uppercase">{t("analysisReportPrint.goal6Months")}</div>
                  <div className="text-[10px] font-semibold text-gray-700">{r.planDesarrollo.objetivo6meses}</div>
                </div>
              )}
              {r.planDesarrollo.objetivo18meses && (
                <div className="p-2 bg-gray-50 rounded">
                  <div className="text-[9px] text-gray-400 uppercase">{t("analysisReportPrint.goal18Months")}</div>
                  <div className="text-[10px] font-semibold text-gray-700">{r.planDesarrollo.objetivo18meses}</div>
                </div>
              )}
            </div>
          )}
          {mode === "technical" && r.planDesarrollo.pilaresTrabajo.length > 0 && (
            <div className="space-y-2">
              {r.planDesarrollo.pilaresTrabajo.map((pilar, i) => (
                <div key={i} className="p-2 bg-gray-50 rounded">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold text-gray-700">{pilar.pilar}</span>
                    <span
                      className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        pilar.prioridad === "alta"
                          ? "bg-red-100 text-red-600"
                          : pilar.prioridad === "media"
                          ? "bg-yellow-100 text-yellow-600"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {pilar.prioridad}
                    </span>
                  </div>
                  <ul className="list-disc list-inside text-[9px] text-gray-500 space-y-0.5">
                    {pilar.acciones.map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 10. Riesgos ────────────────────────────────────────────── */}
        {r.proyeccionCarrera && r.proyeccionCarrera.riesgos.length > 0 && (
          <section className="mb-6 no-break">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{t("analysisReportPrint.identifiedRisks")}</h2>
            <ul className="list-disc list-inside text-[10px] text-gray-600 space-y-1">
              {r.proyeccionCarrera.riesgos.map((riesgo, i) => (
                <li key={i}>{riesgo}</li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="pt-4 mt-6 border-t border-gray-200 flex items-center justify-between">
          <div className="text-[10px] text-purple-600 font-bold tracking-widest uppercase">VITAS.</div>
          <div className="text-[10px] text-gray-400">
            {t("analysisReportPrint.generatedBy")} · {formatDate()}
          </div>
          <div className="text-[10px] text-gray-400">&copy; {new Date().getFullYear()}</div>
        </div>
      </div>
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="text-center p-2 bg-gray-50 rounded">
      <div className="text-lg font-black text-gray-800 leading-tight">{value}</div>
      <div className="text-[9px] text-gray-500">{label}</div>
      {sub && <div className="text-[8px] text-gray-400">{sub}</div>}
    </div>
  );
}

// Tarjeta de "un vistazo" del informe ejecutivo — solo campos reales del informe.
function GlanceCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded-lg border border-gray-200 bg-gray-50">
      <div className="text-[8px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className="text-xs font-bold text-gray-800 leading-tight mt-0.5">{value}</div>
    </div>
  );
}

function PrintKpiRow({
  label, leftValue, leftLabel, rightValue, rightLabel,
  percent, rating, leftColor, rightColor,
}: {
  label: string;
  leftValue: number;
  leftLabel: string;
  rightValue: number;
  rightLabel: string;
  percent: number;
  rating: string;
  leftColor: string;
  rightColor: string;
}) {
  const pctLeft = Math.max(0, Math.min(100, percent));
  const pctRight = 100 - pctLeft;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-700 font-medium">{label}</span>
          <span className="text-[9px] text-gray-500 uppercase tracking-wider">{rating}</span>
        </div>
        <span className="text-[11px] font-bold text-gray-900 tabular-nums">{percent}%</span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-200">
        <div style={{ width: `${pctLeft}%`, backgroundColor: leftColor }} />
        <div style={{ width: `${pctRight}%`, backgroundColor: rightColor }} />
      </div>
      <div className="flex justify-between mt-0.5 text-[9px] text-gray-500">
        <span>
          <span className="font-bold" style={{ color: leftColor }}>{leftValue}</span> {leftLabel}
        </span>
        <span>
          {rightLabel} <span className="font-bold" style={{ color: rightColor }}>{rightValue}</span>
        </span>
      </div>
    </div>
  );
}
