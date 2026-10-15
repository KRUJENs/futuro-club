/**
 * P1 bloque 5b · revisión del PR #318 — el rótulo «Evaluación del entrenador» SOLO donde el
 * dato es la evaluación del entrenador, y en todas las superficies donde lo es.
 *
 * BLOQUEANTE de la revisión (comprobado): el 5b rotulaba como «evaluación del entrenador»
 * dos VSI que NO lo son — la tendencia temporal de la auditoría de sesgo
 * (v_bias_by_recency = AVG(player_analyses.report->>'vsi'), VSI de los análisis de IA) y la
 * evolución longitudinal (player_metric_snapshots.vsi, orquestador de vídeo) vía el término
 * `vsi` del glosario. Y quedaban superficies con «VSI»/«—»/tramos viejos.
 */
import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { analysisVsiInline, isCoachEvaluationAnalysis } from "@/lib/metrics/coachEval";
import { GLOSSARY, glossaryLookup } from "@/lib/metrics/glossary";
import { mapDbRowToLegacy, type AnalysisDbRow } from "@/hooks/usePlayerAnalysisV2";
import biasSrc from "@/pages/BiasAuditDashboard.tsx?raw";
import snapshotSrc from "@/components/evolution/SnapshotHistoryChart.tsx?raw";
import gaugeSrc from "@/components/VsiGauge.tsx?raw";
import masterSrc from "@/pages/MasterDashboard.tsx?raw";
import dashboardSrc from "@/pages/Dashboard.tsx?raw";
import teamBaselineSrc from "@/pages/TeamBaselinePage.tsx?raw";
import rankingsSrc from "@/pages/Rankings.tsx?raw";
import hubSrc from "@/pages/PlayerHubPage.tsx?raw";
import labResultsSrc from "@/pages/vitasLab/LabResultsPanel.tsx?raw";
import analysisDashSrc from "@/components/analysis/AnalysisDashboard.tsx?raw";
import analysisPageSrc from "@/pages/PlayerAnalysisPage.tsx?raw";
import comparisonSrc from "@/pages/PlayerComparison.tsx?raw";
import compareRivalSrc from "../../../api/team/compare-rival.ts?raw";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ["es", es], ["es-419", esLA], ["en", en], ["fr", fr], ["de", de], ["it", it_], ["nl", nl],
];
const get = (o: Record<string, unknown>, k: string): unknown =>
  k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as Record<string, unknown>)[p] : undefined), o);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
const t = ((k: string) => k) as unknown as TFunction;

describe("el VSI de vídeo/IA NO se rotula como evaluación del entrenador", () => {
  it("auditoría de sesgo: la serie temporal (VSI de los análisis de IA) tiene su propio rótulo", () => {
    const src = code(biasSrc);
    expect(src).toMatch(/dataKey="avg_vsi" name=\{t\("biasAudit\.seriesAvgVideoVsi"\)\}/);
    // las barras de posición/edad/visibilidad (players.vsi) sí son la evaluación del entrenador
    expect(src.match(/biasAudit\.seriesAvgVsi/g)?.length).toBe(3);
  });

  it.each(LOCALES)("%s: el título temporal nombra el VSI de los análisis, no al entrenador", (_l, j) => {
    const title = String(get(j, "biasAudit.recencyChartTitle"));
    expect(title).toContain("VSI");
    expect(title).not.toBe(String(get(j, "coachEval.label")));
    expect(typeof get(j, "biasAudit.seriesAvgVideoVsi")).toBe("string");
    // el informe de equidad ya no dice que «la IA» puntúa la evaluación del entrenador
    expect(String(get(j, "biasEquityReport.byPositionSubtitle"))).not.toMatch(/\b(IA|AI|KI)\b/);
    expect(String(get(j, "biasEquityReport.footer"))).not.toMatch(/PHV/);
  });

  it("evolución longitudinal (player_metric_snapshots): término «VSI de vídeo», no el de la ficha", () => {
    expect(code(snapshotSrc)).toContain('termKey="videoVsi"');
    expect(GLOSSARY.videoVsi.term).toBe("VSI de vídeo");
    // el término de la ficha es otro y el gauge lo usa
    expect(GLOSSARY.coachEval.i18nKey).toBe("coachEval.glossary");
    expect(code(gaugeSrc)).toContain('termKey="coachEval"');
    expect(GLOSSARY).not.toHaveProperty("vsi");
  });
});

describe("análisis guardados: base (evaluación del entrenador) vs vídeo", () => {
  it("análisis base «baseline-…» ⇒ evaluación del entrenador; vídeo ⇒ VSI, «sin calcular» si falta", () => {
    expect(isCoachEvaluationAnalysis("baseline-p1-123")).toBe(true);
    expect(isCoachEvaluationAnalysis("v1")).toBe(false);
    expect(isCoachEvaluationAnalysis(null)).toBe(false);
    expect(analysisVsiInline(t, "baseline-p1-1", 72)).toBe("coachEval.short 72.0");
    expect(analysisVsiInline(t, "baseline-p1-1", null)).toBe("coachEval.short: common.notEvaluated");
    expect(analysisVsiInline(t, "v1", 61.5)).toBe("VSI 61.5");
    expect(analysisVsiInline(t, "v1", null)).toBe("VSI: common.notCalculated");
  });

  it("ficha (lista de análisis) y Lab (historial) usan ese rótulo, sin «VSI … —»", () => {
    for (const src of [hubSrc, labResultsSrc]) {
      expect(code(src)).toContain("analysisVsiInline(t,");
      expect(code(src)).not.toMatch(/VSI \{[^}]*\?\? "—"/);
    }
  });

  it("cabecera y WhatsApp del análisis base: tramo RECALCULADO (cortes únicos), no el guardado", () => {
    for (const src of [analysisDashSrc, analysisPageSrc]) {
      expect(code(src)).toContain("coachEvalTier(vsi)");
      expect(code(src)).not.toMatch(/vsi\?\.tier\b/);
      expect(code(src)).not.toContain('startsWith("baseline-")'); // una sola definición
    }
  });

  it("sin «ajuste VSI» inventado (vsi − 50) en los análisis guardados", () => {
    const row: AnalysisDbRow = {
      id: "a1", player_id: "p1", video_id: "baseline-p1-1", created_at: "2026-10-01T00:00:00Z",
      vsi: { vsi: 72 }, reports: [{ report_type: "player-report", content: {} }],
    } as unknown as AnalysisDbRow;
    const out = mapDbRowToLegacy(row);
    expect((out.report as { estadoActual: { ajusteVSIVideoScore: unknown } }).estadoActual.ajusteVSIVideoScore).toBeNull();
  });
});

describe("panel del director y resto de superficies de la evaluación del entrenador", () => {
  it("«Evaluación actualizada» solo con evaluaciones con fecha; sin «VSI»/«—»", () => {
    const src = code(masterSrc);
    expect(src).not.toMatch(/vsiHistory/);
    expect(src).toContain("realVsiEvaluations(p.vsiEvaluations)");
    expect(src).not.toMatch(/VSI \{event/);
    expect(src).not.toMatch(/avgVsi \?\? "—"/);
  });

  it("Dashboard, equipo y Rankings: media sin evaluados ⇒ «Sin evaluar», nunca «—»", () => {
    expect(code(dashboardSrc)).not.toMatch(/avgVsi === null \? "—"/);
    expect(code(teamBaselineSrc)).not.toMatch(/vsiPromedio === null \? "—"/);
    expect(code(rankingsSrc)).not.toMatch(/(avgVsi|minVsi|maxVsi) \?\? "—"/);
  });

  it("comparación: con la misma evaluación no hay «más alta»", () => {
    expect(code(comparisonSrc)).toContain("sameEvaluation");
    for (const [, j] of LOCALES) expect(typeof get(j, "playerComparison.sameCoachEval")).toBe("string");
  });

  it("prompt de comparación con el rival: evaluación del entrenador, no «VSI»", () => {
    const src = code(compareRivalSrc);
    expect(src).not.toMatch(/VSI promedio|Top 8 por VSI|a, VSI \$\{/);
    expect(src).toContain("Evaluación del entrenador media");
  });

  it.each(LOCALES)("%s: textos del panel del director sin «Índice VITAS» ni «VSI < 65»", (_l, j) => {
    expect(String(get(j, "masterDashboard.vitasIndex"))).not.toMatch(/VITAS/);
    expect(String(get(j, "masterDashboard.latePhvLowVsi"))).not.toMatch(/VSI/);
    expect(typeof get(j, "common.notCalculated")).toBe("string");
  });
});

// Revisión r2 del #318 (menores y nits cerrados en el bloque 5c).
describe("revisión r2 del #318", () => {
  it.each(LOCALES)("%s: el inicio tampoco dice «VSI<65» ni «Índice academia»; auditoría sin «IA»", (_l, j) => {
    expect(String(get(j, "dashboard.stats.hiddenTalentsDesc"))).not.toMatch(/VSI/);
    expect(String(get(j, "dashboard.stats.avgVsiDesc"))).not.toMatch(/[ÍI]ndi[cz]e|index/i);
    expect(String(get(j, "biasAudit.title"))).not.toMatch(/\b(IA|AI|KI)\b/);
    expect(String(get(j, "biasEquityReport.reportTitle"))).not.toMatch(/\b(IA|AI|KI)\b/);
    for (const k of ["term", "short", "long"]) {
      expect(typeof get(j, `videoVsiGlossary.${k}`), k).toBe("string");
    }
  });

  it("un análisis SIN informes conserva su VSI (antes «Sin evaluar» de un análisis base evaluado)", () => {
    const row = {
      id: "a1", player_id: "p1", video_id: "baseline-p1-1", created_at: "2026-10-01T00:00:00Z",
      vsi: { vsi: 66.2 }, reports: [],
    } as unknown as AnalysisDbRow;
    expect((mapDbRowToLegacy(row) as { vsi?: unknown }).vsi).toBe(66.2);
  });

  it("cabecera de un análisis de vídeo sin VSI: «Sin calcular», como la lista", () => {
    expect(code(analysisDashSrc)).toContain('isCoachEvaluation ? "common.notEvaluated" : "common.notCalculated"');
  });

  it("el término de vídeo se traduce y glossaryLookup encuentra las claves camelCase", () => {
    expect(GLOSSARY.videoVsi.i18nKey).toBe("videoVsiGlossary");
    expect(glossaryLookup("coachEval")).toBe(GLOSSARY.coachEval);
    expect(glossaryLookup("videoVsi")).toBe(GLOSSARY.videoVsi);
    expect(glossaryLookup("PHV")).toBe(GLOSSARY.phv);
  });
});
