/**
 * VITAS · PlayerHubPrint
 *
 * Vista print-ready de un jugador. Usa CSS @media print para que el navegador
 * pueda imprimir/guardar como PDF.
 *
 * Diseño 2 páginas A4:
 *   1. Hero: VSI gauge gigante + identidad + métricas base
 *   2. Stats + fortalezas + comparativa pro
 *
 * Branding fuerte VITAS · diseñado para que padres lo compartan en WhatsApp.
 *
 * URL: /players/:id/print  (al cargar dispara window.print() automáticamente
 * si query param `auto=1`).
 */
import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PlayerService, type Player } from "@/services/real/playerService";
import { calculateAdvancedMetrics } from "@/services/real/advancedMetricsService";
import { maturityStatusKey, maturityConfidenceKey } from "@/lib/phv/playerMaturity";
import { phvGate, blockedAssessment } from "@/lib/phv/phvGate";
import { usePhvGateText } from "@/components/phv/PhvGateNotice";
import VsiGauge from "@/components/VsiGauge";
import { coachEvalTier, type CoachEvalTier } from "@/services/real/metricsService";
import { PUBLIC_HOST } from "@/lib/publicUrl";

export default function PlayerHubPrint() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const phvGateText = usePhvGateText();

  const METRIC_LABELS: Record<keyof Player["metrics"], string> = {
    speed:     t("playerHubPrint.metricSpeed"),
    technique: t("playerHubPrint.metricTechnique"),
    vision:    t("playerHubPrint.metricVision"),
    stamina:   t("playerHubPrint.metricStamina"),
    shooting:  t("playerHubPrint.metricShooting"),
    defending: t("playerHubPrint.metricDefending"),
  };

  const player = useMemo(() => (id ? PlayerService.getById(id) : null), [id]);
  const metrics = useMemo(() => {
    if (!player) return null;
    return calculateAdvancedMetrics(player as Parameters<typeof calculateAdvancedMetrics>[0]);
  }, [player]);

  // Auto print si ?auto=1
  useEffect(() => {
    if (searchParams.get("auto") === "1") {
      const timer = setTimeout(() => window.print(), 800);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  if (!player) {
    return <div className="p-8 text-center">{t("playerHubPrint.playerNotFound")}</div>;
  }
  // Jugador sin evaluar (sin las 6 barras del entrenador): no hay VSI de ficha,
  // radar, tier ni características que imprimir. Se nombra el hueco en vez de
  // fabricar un informe con ceros / un tier desde vsi null (invariante #2).
  if (!player.metrics) {
    return <div className="p-8 text-center text-muted-foreground">{t("common.notEvaluated")}</div>;
  }

  // Maduración desde el GATE ÚNICO (regla del owner 28-sep): solo con TODAS las
  // entradas introducidas (talla, peso, sentado, pierna, fecha de nacimiento →
  // edad decimal, sexo). Antes se imprimía «Pre-PHV» desde playerMaturity con la
  // edad ENTERA y pierna/sentado ESTIMADOS. Sin gate abierto se imprime qué falta.
  // Esta sección es STATUS-based (Pre/En/Post-PHV), no timing-vs-pares.
  const phv = phvGate(player);
  const maturity = phv.ok ? phv.assessment : blockedAssessment(phv.gate_reason);
  const phvLabel = phv.ok ? t(maturityStatusKey(maturity.status)) : phvGateText({ gate: phv });

  const phvColor =
    maturity.status === "pre_phv" ? "#10b981" :    // ventana neuromotora abierta
    maturity.status === "post_phv" ? "#3b82f6" :   // consolidado
    maturity.status === "circa_phv" ? "#f59e0b" :  // estirón en curso
    "#94a3b8";                                     // unknown

  const ageAtPhv = phv.aphv.value;
  const hasMaturity = phv.ok && ageAtPhv !== null;

  const today = new Date().toLocaleDateString("es-ES", {
    day: "numeric", month: "long", year: "numeric",
  });

  // Top 3 fortalezas + 2 áreas de mejora
  const sortedMetrics = (Object.keys(player.metrics) as Array<keyof Player["metrics"]>)
    .map((k) => ({ key: k, label: METRIC_LABELS[k], value: player.metrics[k] }))
    .sort((a, b) => b.value - a.value);
  const strengths = sortedMetrics.slice(0, 3);
  const gaps = sortedMetrics.slice(-2).reverse();

  // Tramo de la evaluación del entrenador: cortes ÚNICOS (coachEvalTier, P1 bloque 5b).
  // Sin VSI de ficha no hay tramo (antes null >= 85 … caía en «Desarrollo»).
  const TIER_HEX: Record<CoachEvalTier, string> = { elite: "#3b82f6", pro: "#a855f7", talent: "#f59e0b", develop: "#ef4444" };
  const tierKey = player.vsi != null ? coachEvalTier(player.vsi) : null;
  const tier = tierKey ? { label: t(`coachEval.tier.${tierKey}`), color: TIER_HEX[tierKey] } : null;

  return (
    <>
      {/* CSS print-specific */}
      <style>{`
        @page {
          size: A4 portrait;
          margin: 0;
        }
        @media print {
          body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .no-print { display: none !important; }
          .page-break { page-break-after: always; }
        }
        .page {
          width: 210mm;
          min-height: 297mm;
          padding: 18mm 16mm;
          box-sizing: border-box;
          background: white;
          color: #0f172a;
        }
        @media screen {
          .page {
            margin: 16px auto;
            box-shadow: 0 4px 32px rgba(0,0,0,0.08);
          }
        }
      `}</style>

      {/* Toolbar (no print) */}
      <div className="no-print sticky top-0 z-50 bg-slate-900 text-white px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-blue-500 flex items-center justify-center font-black text-xs">V</div>
          <span className="font-bold text-sm">{t("playerHubPrint.toolbarTitle")}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="px-4 py-1.5 rounded bg-blue-500 hover:bg-blue-600 text-sm font-bold"
          >
            🖨 {t("playerHubPrint.downloadPdfPrint")}
          </button>
          <button
            onClick={() => window.close()}
            className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm"
          >
            {t("playerHubPrint.close")}
          </button>
        </div>
      </div>

      <div style={{ background: "#f1f5f9", padding: "1px 0", fontFamily: "Geist, system-ui, sans-serif" }}>
        {/* ── PÁGINA 1 · Hero ────────────────────────────────────────── */}
        <div className="page page-break">
          {/* Header brand */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #0f172a", paddingBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 900, fontSize: 18 }}>V</div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "-0.02em" }}>VITAS</div>
                <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>Football Intelligence</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>{t("playerHubPrint.report")}</div>
              <div style={{ fontSize: 11, color: "#0f172a", fontWeight: 600 }}>{today}</div>
            </div>
          </div>

          {/* Hero · nombre + VSI gauge gigante */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 32, marginTop: 32, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.18em", fontWeight: 700, marginBottom: 6 }}>
                {t("playerHubPrint.playerAnalysis")}
              </div>
              <h1 style={{ fontSize: 56, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1, margin: 0, color: "#0f172a" }}>
                {player.name}
              </h1>
              <div style={{ display: "flex", gap: 18, marginTop: 14, flexWrap: "wrap" }}>
                <Stat label={t("playerHubPrint.statAge")} value={t("playerHubPrint.ageValue", { count: player.age })} />
                <Stat label={t("playerHubPrint.statPosition")} value={player.position} />
                {player.secondaryPositions && player.secondaryPositions.length > 0 && (
                  <Stat label={t("playerHubPrint.statVersatility")} value={player.secondaryPositions.join(", ")} />
                )}
                {/* Sin pie o nivel registrados no se pinta la fila (nada «por defecto»). */}
                {player.foot && (
                  <Stat label={t("playerHubPrint.statPreferredFoot")} value={player.foot === "right" ? t("playerHubPrint.footRight") : player.foot === "left" ? t("playerHubPrint.footLeft") : t("playerHubPrint.footBoth")} />
                )}
                {player.competitiveLevel && <Stat label={t("playerHubPrint.statLevel")} value={player.competitiveLevel} />}
              </div>
              <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
                {tier && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6, background: tier.color, color: "white", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em" }}>
                    {tier.label}
                  </span>
                )}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6, background: phvColor, color: "white", fontSize: 11, fontWeight: 700 }}>
                  {phvLabel}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <VsiGauge value={player.vsi} size="xl" showTier />
              {/* Rótulo honesto (P1 bloque 5b): son las 6 barras del entrenador, no un
                  «VITAS Score Index» del sistema. */}
              <div style={{ fontSize: 9, color: "#64748b", marginTop: 8, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 700 }}>
                {t("coachEval.label")}
              </div>
            </div>
          </div>

          {/* Métricas base · barras horizontales */}
          <div style={{ marginTop: 36 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0f172a", margin: 0, marginBottom: 14, paddingBottom: 6, borderBottom: "1px solid #e2e8f0" }}>
              {t("playerHubPrint.technicalPhysicalProfile")}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px" }}>
              {(Object.keys(player.metrics) as Array<keyof Player["metrics"]>).map((k) => {
                const v = player.metrics[k];
                return (
                  <div key={k}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{METRIC_LABELS[k]}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                    <div style={{ height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${v}%`, height: "100%", background: v >= 75 ? "#3b82f6" : v >= 55 ? "#a855f7" : "#f59e0b", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Fortalezas + áreas */}
          <div style={{ marginTop: 32, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#10b981", margin: 0, marginBottom: 10 }}>
                ✓ {t("playerHubPrint.strengths")}
              </h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {strengths.map((s) => (
                  <li key={s.key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f1f5f9", fontSize: 12 }}>
                    <span style={{ color: "#0f172a", fontWeight: 600 }}>{s.label}</span>
                    <span style={{ color: "#10b981", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{s.value}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#f59e0b", margin: 0, marginBottom: 10 }}>
                ↗ {t("playerHubPrint.developmentAreas")}
              </h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {gaps.map((g) => (
                  <li key={g.key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f1f5f9", fontSize: 12 }}>
                    <span style={{ color: "#0f172a", fontWeight: 600 }}>{g.label}</span>
                    <span style={{ color: "#f59e0b", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{g.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Footer página 1 */}
          <div style={{ position: "absolute", bottom: "16mm", left: "16mm", right: "16mm", display: "flex", justifyContent: "space-between", fontSize: 9, color: "#94a3b8", borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
            <span>VITAS · Football Intelligence · {t("playerHubPrint.maturationalAge")}: {hasMaturity ? t("playerHubPrint.yearsValue", { count: ageAtPhv!.toFixed(1) }) : t("playerHubPrint.notAvailable")} · {phvLabel}</span>
            <span>{t("playerHubPrint.pageOf", { current: 1, total: 2 })} · {player.name} · {today}</span>
          </div>
        </div>

        {/* ── PÁGINA 2 · Análisis avanzado ────────────────────────────── */}
        <div className="page">
          {/* Header continuación */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #0f172a", paddingBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 900, fontSize: 14 }}>V</div>
              <span style={{ fontWeight: 800, fontSize: 14 }}>{player.name}</span>
              <span style={{ fontSize: 10, color: "#64748b" }}>· {t("playerHubPrint.advancedAnalysis")}</span>
            </div>
            <div style={{ fontSize: 10, color: "#64748b" }}>
              {t("coachEval.short")}{" "}
              <strong style={{ color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{player.vsi ?? t("common.notEvaluated")}</strong>
            </div>
          </div>

          {/* PHV section */}
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0f172a", margin: 0, marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid #e2e8f0" }}>
              {t("playerHubPrint.biologicalMaturity")} · PHV
            </h2>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 16, fontSize: 12, lineHeight: 1.7, color: "#334155" }}>
              <strong style={{ color: phvColor }}>{phvLabel}</strong>
              {maturity.status === "pre_phv" && (
                <p style={{ margin: "8px 0 0 0" }}>{t("playerHubPrint.phvBodyEarly")}</p>
              )}
              {maturity.status === "post_phv" && (
                <p style={{ margin: "8px 0 0 0" }}>{t("playerHubPrint.phvBodyLate")}</p>
              )}
              {maturity.status === "circa_phv" && (
                <p style={{ margin: "8px 0 0 0" }}>{t("playerHubPrint.phvBodyOntime")}</p>
              )}
              {maturity.status === "unknown" && phv.ok && (
                <p style={{ margin: "8px 0 0 0" }}>{maturity.validityNote ?? t("maturity.confidence.none")}</p>
              )}
            </div>
          </div>

          {/* Comparativa pro */}
          {metrics && (
            <div style={{ marginTop: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0f172a", margin: 0, marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid #e2e8f0" }}>
                {t("playerHubPrint.dominantIdentity")}
              </h2>
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 16, fontSize: 12, lineHeight: 1.6 }}>
                <strong style={{ fontSize: 16, color: "#0f172a", textTransform: "capitalize" }}>{metrics.dominantFeatures.playStyle}</strong>
                <p style={{ margin: "6px 0 0 0", color: "#475569" }}>
                  {t("playerHubPrint.specialization")}: <strong>{Math.round(metrics.dominantFeatures.specializationIndex * 100)}%</strong>
                  {" · "}
                  {t("playerHubPrint.dominantAttributes")}: {metrics.dominantFeatures.dominant.slice(0, 2).join(" + ")}
                </p>
              </div>
            </div>
          )}

          {/* Recomendación próximas 4 semanas */}
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0f172a", margin: 0, marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid #e2e8f0" }}>
              {t("playerHubPrint.planNext4Weeks")}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <PlanCard
                title={t("playerHubPrint.planMaintainStrengths")}
                items={strengths.map((s) => t("playerHubPrint.planWeeklyDrills", { skill: s.label.toLowerCase() }))}
                color="#10b981"
              />
              <PlanCard
                title={t("playerHubPrint.planWorkAreas")}
                items={gaps.map((g) => t("playerHubPrint.planSpecificBlock", { skill: g.label.toLowerCase() }))}
                color="#f59e0b"
              />
            </div>
          </div>

          {/* CTA final */}
          <div style={{ marginTop: 32, padding: 20, background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)", borderRadius: 8, color: "white", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 6 }}>
              {t("playerHubPrint.analysisGeneratedBy")}
            </div>
            <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: "-0.02em" }}>VITAS Football Intelligence</div>
            <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 4 }}>
              {t("playerHubPrint.platformTagline")}
            </div>
            <div style={{ fontSize: 11, color: "#3b82f6", marginTop: 12, fontWeight: 700 }}>
              {PUBLIC_HOST}
            </div>
          </div>

          {/* Footer página 2 */}
          <div style={{ position: "absolute", bottom: "16mm", left: "16mm", right: "16mm", display: "flex", justifyContent: "space-between", fontSize: 9, color: "#94a3b8", borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
            <span>VITAS v2.0 · {t("playerHubPrint.mirwaldEvaluation")} · {t("playerHubPrint.confidence")}: {t(maturityConfidenceKey(maturity.confidence))}</span>
            <span>{t("playerHubPrint.pageOf", { current: 2, total: 2 })} · {player.name} · {today}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#0f172a", fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function PlanCard({ title, items, color }: { title: string; items: string[]; color: string }) {
  return (
    <div style={{ background: "#fafbfc", border: `1px solid ${color}30`, borderLeft: `3px solid ${color}`, borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>{title}</div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 11, color: "#334155", lineHeight: 1.7 }}>
        {items.map((it, i) => <li key={i}>• {it}</li>)}
      </ul>
    </div>
  );
}
