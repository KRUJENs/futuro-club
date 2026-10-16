/**
 * P1 bloque 6, punto 3 — Duelos: UNA sola ruta (src/lib/tracking/duels.ts), SIEMPRE
 * bloqueada con su motivo. Antes había tres rutas con tres números distintos
 * (poseAnalyzer, eventDetectionEngine, Gemini), «0/0 ganados» porque el ganador nunca se
 * resolvía, un 50 fijo en el DrillScore y exportes con 0.
 */
import { describe, expect, it } from "vitest";
import {
  duelsMetric,
  stripDuelOutcomes,
  DUELS_GATE_REASON,
  DUEL_OUTCOME_KEYS,
} from "@/lib/tracking/duels";
import es from "@/i18n/es.json";
import esLatam from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const LOCALES: Record<string, unknown> = { es, "es-419": esLatam, en, fr, de, it: it_, nl };
const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

// Todo el código de producción (src/ y api/), sin tests.
const SOURCES = import.meta.glob(
  ["/src/**/*.{ts,tsx}", "/api/**/*.ts", "!/src/test/**", "!**/__tests__/**", "!**/*.test.*"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("duelsMetric / stripDuelOutcomes", () => {
  it("la métrica está SIEMPRE bloqueada: value null + motivo canónico", () => {
    const m = duelsMetric();
    expect(m.value).toBeNull();
    expect(m.gate_reason).toBe(DUELS_GATE_REASON);
    expect(m.confidence).toBe(0);
  });

  it("el saneador quita las claves de duelos a cualquier profundidad, sin mutar y sin tocar el resto", () => {
    const input = {
      duelsWon: 3, passes: 10,
      eventSummary: { duelsLost: 2, recoveries: 4, nested: [{ duelosGanados: 1, ok: true }] },
      gemini_observation: { eventosContados: { duelosPerdidos: 1, pasesCompletados: 7 } },
      duel_events: [{ a: 1 }], duels_won: 5, duelCount: 2, duelEvents: [],
    };
    const copy = JSON.parse(JSON.stringify(input));
    const out = stripDuelOutcomes(input);
    expect(input).toEqual(copy); // no muta
    expect(JSON.stringify(out)).not.toMatch(new RegExp(DUEL_OUTCOME_KEYS.join("|")));
    expect(out).toEqual({
      passes: 10,
      eventSummary: { recoveries: 4, nested: [{ ok: true }] },
      gemini_observation: { eventosContados: { pasesCompletados: 7 } },
    });
    expect(stripDuelOutcomes(null)).toBeNull();
    expect(stripDuelOutcomes(undefined)).toBeUndefined();
  });
});

describe("una sola ruta: ninguna otra pieza calcula, guarda ni pinta cifras de duelos", () => {
  it("el barrido encuentra el código (control)", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(300);
    expect(Object.keys(SOURCES)).toContain("/src/lib/tracking/duels.ts");
    expect(Object.keys(SOURCES)).toContain("/api/tracking/_save.ts");
  });

  it("duelsWon / duelosGanados / winnerId / duels_won / duelEvents… solo en duels.ts (y el esquema que IGNORA la clave en _save)", () => {
    const re = /\b(duelsWon|duelsLost|duelosGanados|duelosPerdidos|winnerId|duels_won|duels_lost|duelCount|DuelEvent|duelEvents)\b/;
    const allowed = new Set(["/src/lib/tracking/duels.ts", "/api/tracking/_save.ts"]);
    const offenders = Object.entries(SOURCES)
      .filter(([path, src]) => !allowed.has(path) && re.test(stripComments(src)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("el motor de eventos y el análisis de pose no detectan duelos", () => {
    for (const p of ["/src/lib/tracking/eventDetectionEngine.ts", "/src/lib/tracking/advancedEventTypes.ts", "/src/lib/yolo/poseAnalyzer.ts"]) {
      const code = stripComments(SOURCES[p]);
      expect(code, p).not.toMatch(/duel_aerial|duel_ground|aerial_won|aerial_lost|detectDuel|determineDuelOutcome|detectAerialDuel/);
    }
  });

  it("_save guarda SIEMPRE duel_events vacío (acepta la clave de clientes antiguos, la ignora)", () => {
    const code = stripComments(SOURCES["/api/tracking/_save.ts"]);
    expect(code).toMatch(/duel_events:\s*\[\],/);
    expect(code).not.toMatch(/body\.duelEvents/);
  });

  it("los demos ya no traen duelos de ejemplo", () => {
    for (const p of ["/src/services/real/demoDataService.ts", "/src/lib/demo/demoReports.ts"]) {
      expect(stripComments(SOURCES[p]), p).not.toMatch(/duel/i);
    }
  });
});

describe("i18n: el motivo existe en los 7 idiomas y las claves de cifras de duelos ya no", () => {
  it("duelsGate.value/hint/reason en los 7 idiomas", () => {
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of ["duelsGate.value", "duelsGate.hint", "duelsGate.reason"]) {
        const v = get(json, key);
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${key}`).toBe(true);
      }
    }
  });

  it("claves de cifras de duelos borradas en los 7 idiomas (con control positivo)", () => {
    const gone = [
      "trackingMetricsPanel.duelsSub", "trackingMetricsPanel.duelsUnresolved", "trackingSnapshotPanel.unitWon",
      "quantitativeMetricsPanel.duelsWonLost", "matchStatsPanel.won", "matchStatsPanel.lost",
      "matchStatsPanel.effectiveness", "vitasLab.duelsLabel", "vitasLab.wonAbbr", "vitasLab.lostAbbr",
      "analysisReportPrint.won", "analysisReportPrint.lost", "analysisReportPrint.wonSub",
    ];
    for (const [locale, json] of Object.entries(LOCALES)) {
      expect(get(json, "vitasLab.duels"), `${locale}: control`).toBeDefined();
      for (const key of gone) expect(get(json, key), `${locale}: ${key}`).toBeUndefined();
    }
  });

  it("los textos que prometían «duelos» tras analizar un vídeo ya no los prometen", () => {
    const keys = [
      "playerHubPage.unlockDescription", "playerHubPage.emptyAnalysisDescription",
      "trackingSnapshotPanel.emptyDescription", "playerIntelligencePage.statsPanelUnavailableDesc",
    ];
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of keys) {
        expect(String(get(json, key)), `${locale}: ${key}`).not.toMatch(/duel|zweikämpf/i);
      }
    }
  });
});
