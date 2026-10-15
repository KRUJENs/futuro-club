/**
 * P1 bloque 5b — «Evaluación del entrenador», no «VSI Global» / «VITAS Score Index».
 *
 * El VSI de ficha son las 6 barras SUBJETIVAS que puntúa el entrenador, pero la app lo
 * presentaba como una puntuación del sistema («VSI Global», «VITAS Score Index», «VSI
 * Score»), y algunos textos afirmaban que estaba «corregido por maduración» (Rankings
 * pinta el dato crudo). Además había 4 juegos de cortes de tramo (80/65/50, 85/70/50,
 * 85/70/55, 85/70) y la comparación de jugadores fabricaba cifras desde las barras.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import PlayerReportView from "@/components/analysis/reports/PlayerReportView";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";
import hubPrintSrc from "@/pages/PlayerHubPrint.tsx?raw";
import reportPrintSrc from "@/pages/PlayerReportPrint.tsx?raw";
import hubPageSrc from "@/pages/PlayerHubPage.tsx?raw";
import vitasCardSrc from "@/components/VitasCard.tsx?raw";
import shareCardSrc from "@/components/player/ShareablePlayerCard.tsx?raw";
import masterSrc from "@/pages/MasterDashboard.tsx?raw";
import analysisDashSrc from "@/components/analysis/AnalysisDashboard.tsx?raw";
import comparisonSrc from "@/pages/PlayerComparison.tsx?raw";
import gaugeSrc from "@/components/VsiGauge.tsx?raw";
import playerCardSrc from "@/components/PlayerCard.tsx?raw";
import pdfSrc from "../../../api/reports/_pdf.ts?raw";
import cronSrc from "../../../api/notifications/_cron.ts?raw";
import telegramSrc from "../../../api/telegram/webhook.ts?raw";

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ["es", es], ["es-419", esLA], ["en", en], ["fr", fr], ["de", de], ["it", it_], ["nl", nl],
];
const get = (o: Record<string, unknown>, k: string): unknown =>
  k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as Record<string, unknown>)[p] : undefined), o);

/** Quita comentarios para no confundir la explicación con el código. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

describe("rótulo: evaluación del entrenador en todas las superficies", () => {
  it.each([
    ["PlayerHubPrint", hubPrintSrc],
    ["PlayerReportPrint", reportPrintSrc],
    ["VitasCard", vitasCardSrc],
    ["MasterDashboard", masterSrc],
    ["AnalysisDashboard", analysisDashSrc],
    ["api/reports/_pdf.ts", pdfSrc],
  ])("%s no presenta «VITAS Score Index» / «VSI Score»", (_n, src) => {
    expect(code(src)).not.toMatch(/VITAS Score Index|VSI Score/);
  });

  it("la ficha (Hub) ya no usa «VSI Global» y cuenta solo evaluaciones con fecha", () => {
    expect(code(hubPageSrc)).not.toContain("playerHubPage.vsiGlobal");
    expect(code(hubPageSrc)).not.toMatch(/updatesRecorded",\s*\{\s*count:\s*player\.vsiHistory/);
  });

  it("la tarjeta compartible (PNG) no rotula «VSI» a secas", () => {
    expect(code(shareCardSrc)).not.toMatch(/>VSI</);
    expect(code(shareCardSrc)).toContain('t("coachEval.label")');
  });

  it("el gauge ya no tiene «VSI» como rótulo por defecto", () => {
    expect(code(gaugeSrc)).not.toMatch(/label\s*=\s*"VSI"/);
  });

  it.each(LOCALES)("%s: claves coachEval completas y ningún texto dice que la evaluación esté corregida por maduración", (_l, j) => {
    for (const k of ["coachEval.label", "coachEval.short", "coachEval.hint", "coachEval.tier.elite", "coachEval.tier.pro", "coachEval.tier.talent", "coachEval.tier.develop", "coachEval.glossary.long"]) {
      expect(typeof get(j, k), k).toBe("string");
    }
    for (const k of ["shareCard.text", "shareCard.tagline", "players.rankings.subtitle", "rankingsPage.vsiHint"]) {
      const v = String(get(j, k));
      expect(v, k).not.toMatch(/VSI/);
      expect(v, k).not.toMatch(/PHV|corregid|ajustad|corrig|ajust|korrigiert|corrett|gecorrigeerd|adjusted|corrected/i);
    }
    expect(get(j, "playerHubPage.vsiGlobal")).toBeUndefined();
  });
});

describe("tramos únicos", () => {
  it("ninguna superficie conserva sus propios cortes", () => {
    expect(code(masterSrc)).not.toMatch(/v >= 80|>= 65/);
    expect(code(hubPrintSrc)).not.toMatch(/player\.vsi >= 85/);
    expect(code(playerCardSrc)).not.toMatch(/player\.vsi >= 85/);
    expect(code(shareCardSrc)).not.toMatch(/min: 85/);
  });
});

describe("comparación de jugadores: sin cifras fabricadas desde las barras", () => {
  it("ni probabilidad de élite (VSI × 0,95), ni sprints (velocidad × 0,26), ni UBI (VSI × 0,85), ni VAEP desde técnica+visión", () => {
    const src = code(comparisonSrc);
    expect(src).not.toMatch(/\* 0\.95/);
    expect(src).not.toMatch(/speed \* 0\.26/);
    expect(src).not.toMatch(/vsi \* 0\.85/);
    expect(src).not.toMatch(/stats\.technique \+ player[AB]\.stats\.vision/);
    expect(src).not.toContain("probabilityElite");
  });
});

describe("servidor", () => {
  it("el aviso de evaluación baja usa el VSI guardado, no una 2.ª fórmula con media simple", () => {
    const src = code(cronSrc);
    expect(src).not.toContain("VSI_WEIGHTS");
    expect(src).not.toMatch(/values\.reduce\(\(a, b\) => a \+ b, 0\) \/ values\.length/);
    expect(src).toContain("evaluación del entrenador");
  });

  it("Telegram ya no llama «Élite» a VSI ≥ 70", () => {
    expect(code(telegramSrc)).not.toMatch(/VSI ≥70/);
    expect(code(telegramSrc)).toContain("ELITE_MIN");
  });
});

describe("informe del jugador: sin cifras escritas por el modelo", () => {
  it("no pinta vsi_score / tier_label del LLM", () => {
    render(<PlayerReportView report={{ title: "Informe", executive_summary: "Resumen", vsi_score: 97, tier: "elite", tier_label: "Elite total" }} />);
    expect(screen.queryByText("97")).toBeNull();
    expect(screen.queryByText("Elite total")).toBeNull();
    expect(screen.getByText("Resumen")).toBeDefined();
  });
});

describe("coachEvalInline", () => {
  const t = ((k: string) => ({ "coachEval.short": "Eval. entrenador", "common.notEvaluated": "Sin evaluar" })[k] ?? k) as never;
  it("con valor: rótulo + número; sin valor: rótulo + «Sin evaluar» (nunca «—»)", () => {
    expect(coachEvalInline(t, 72.4)).toBe("Eval. entrenador 72");
    expect(coachEvalInline(t, null)).toBe("Eval. entrenador: Sin evaluar");
    expect(coachEvalInline(t, undefined)).not.toContain("—");
  });
});
