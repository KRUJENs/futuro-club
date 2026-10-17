/**
 * P1 bloque 6b, punto 9 — Scan IQ / DM-Score BLOQUEADOS con su motivo; el ejemplo del demo
 * es fijo (MOCK) y nada se deriva del id del jugador. Antes: Scan IQ «calibrado por edad»
 * con bandas sin fuente y 14 años por defecto, rotulado «Vídeo real» sobre un detector que
 * inventaba las recepciones; DM-Score con pesos sin fuente; ranking de /scanning por hash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { dmScoreMetric, scanIQMetric, scanIQDemoExample, SCAN_IQ_DEMO_EXAMPLE } from "@/lib/dmscore";
import { SCAN_IQ_GATE_REASON } from "@/lib/dmscore/scanIQ";
import { DM_SCORE_GATE_REASON } from "@/lib/dmscore/dmScore";
import {
  runScanningDetection,
  ScanningGatedError,
  ScanningVideoAnalyses,
} from "@/services/real/scanningVideoDetector";
import { ScanIQCard } from "@/components/dmscore/ScanIQCard";
import { DMScoreCard } from "@/components/dmscore/DMScoreCard";
import ScanningIntelligenceReport from "@/components/behavioral/ScanningIntelligenceReport";
import es from "@/i18n/es.json";
import esLatam from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "es", changeLanguage: vi.fn() } }),
}));

const LOCALES: Record<string, unknown> = { es, "es-419": esLatam, en, fr, de, it: it_, nl };
const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

const SOURCES = import.meta.glob(
  ["/src/**/*.{ts,tsx}", "!/src/test/**", "!**/*.test.*"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("métricas", () => {
  it("Scan IQ y DM-Score: SIEMPRE value null + motivo canónico", () => {
    const s = scanIQMetric();
    expect(s.value).toBeNull();
    expect(s.gate_reason).toBe(SCAN_IQ_GATE_REASON);
    const d = dmScoreMetric();
    expect(d.value).toBeNull();
    expect(d.gate_reason).toBe(DM_SCORE_GATE_REASON);
  });

  it("el ejemplo del demo es FIJO y MOCK", () => {
    const e = scanIQDemoExample();
    expect(e.provenance).toBe("MOCK");
    expect(e.value).toBe(SCAN_IQ_DEMO_EXAMPLE.scanIQ);
  });
});

describe("detector de escaneo fuera del demo (IS_DEMO false en tests)", () => {
  afterEach(() => localStorage.clear());

  it("vídeo real Y partido demo ⇒ ScanningGatedError con el motivo; no se guarda nada", async () => {
    for (const videoId of ["video-real-123", "demo_scan_rivalfc_2026_05_24"]) {
      const p = runScanningDetection({ playerId: "p1", playerName: "A", videoId, videoTitle: "x" });
      await expect(p).rejects.toBeInstanceOf(ScanningGatedError);
      await expect(p).rejects.toMatchObject({ gate_reason: SCAN_IQ_GATE_REASON });
    }
    expect(localStorage.getItem("vitas_scanning_video_analyses")).toBeNull();
  });

  it("análisis ANTIGUOS guardados (incluidos los «real» de MediaPipe) no se leen; el ejemplo no se siembra", () => {
    localStorage.setItem(
      "vitas_scanning_video_analyses",
      JSON.stringify([{ id: "a", playerId: "p1", scanIQ: 91, source: "real" }, { id: "b", playerId: "p1", scanIQ: 64, source: "mock" }]),
    );
    expect(ScanningVideoAnalyses.getAll()).toEqual([]);
    expect(ScanningVideoAnalyses.getLatestForPlayer("p1")).toBeNull();
    expect(ScanningVideoAnalyses.seedDemo("p1", "A")).toBeNull();
  });
});

describe("UI", () => {
  it("las tarjetas pintan el motivo traducido, nunca una cifra", () => {
    render(<ScanIQCard metric={scanIQMetric()} />);
    expect(screen.getByTestId("scan-iq-gated").textContent).toBe("scanIqGate.reason");
    expect(screen.getByTestId("scan-iq-card").textContent).not.toMatch(/\d/);
    render(<DMScoreCard metric={dmScoreMetric()} />);
    expect(screen.getByTestId("dm-score-gated").textContent).toBe("dmScoreGate.reason");
    expect(screen.getByTestId("dm-score-card").textContent).not.toMatch(/\d/);
  });

  it("el ejemplo MOCK lleva su etiqueta de procedencia", () => {
    render(<ScanIQCard metric={scanIQDemoExample()} />);
    expect(screen.getByText(String(SCAN_IQ_DEMO_EXAMPLE.scanIQ))).toBeInTheDocument();
    expect(screen.getByTestId("scan-iq-card").textContent).toMatch(/ejemplo/i);
  });

  it("el informe de escaneo fuera del demo es el motivo, no recepciones inventadas", () => {
    render(<ScanningIntelligenceReport playerId="p1" playerName="A" scanningScore={88} />);
    expect(screen.getByTestId("scanning-report-gated")).toBeInTheDocument();
    expect(screen.getByText("scanIqGate.reason")).toBeInTheDocument();
  });
});

describe("estático: nada derivado del id, sin bandas por edad sin fuente ni «Vídeo real»", () => {
  it("el barrido encuentra el código (control)", () => {
    expect(Object.keys(SOURCES)).toContain("/src/pages/ScanningIntelligencePage.tsx");
  });

  it("useDMScore y benchmarks.ts ya no existen; nadie usa computeScanIQ/computeDMScore", () => {
    expect(Object.keys(SOURCES)).not.toContain("/src/hooks/useDMScore.ts");
    expect(Object.keys(SOURCES)).not.toContain("/src/lib/dmscore/benchmarks.ts");
    for (const [p, src] of Object.entries(SOURCES)) {
      // (src/lib/behavioral/scanningIntelligenceDetector.ts tiene su PROPIA tabla local
      //  SCAN_BENCHMARKS: otra ruta, anotada como resto del 6b en pendientes.)
      expect(stripComments(src), p).not.toMatch(/computeScanIQ|computeDMScore|useDMScore|from "\.\/benchmarks"|dmscore\/benchmarks/);
    }
  });

  it("Scanning: sin hash del id (charCodeAt / seededRng(playerId) / scan_${playerId})", () => {
    for (const p of [
      "/src/pages/ScanningIntelligencePage.tsx",
      "/src/components/behavioral/ScanningIntelligenceReport.tsx",
      "/src/services/real/scanningVideoDetector.ts",
    ]) {
      const code = stripComments(SOURCES[p]);
      expect(code, p).not.toMatch(/seededRng\(\s*(playerId|`scan_\$\{playerId\}`|`\$\{options\.playerId\})/);
      expect(code, p).not.toMatch(/generateScanIQ|tierFor/);
    }
    expect(stripComments(SOURCES["/src/services/real/scanningVideoDetector.ts"])).not.toMatch(/charCodeAt|getMediaPipeService/);
  });

  it("el Lab guarda los escaneos del jugador ENFOCADO, no los de todas las pistas", () => {
    const lab = stripComments(SOURCES["/src/pages/VitasLab.tsx"]);
    expect(lab).not.toMatch(/scanCount:\s*tracking\.state\.scanEvents\.length/);
    expect(lab).not.toMatch(/physicalMetrics\.scanCount = tracking\.state\.scanEvents\.length/);
    expect(lab).toMatch(/scanEvents\.filter\(\(s\) => s\.trackId === tracking\.state\.focusTrackId\)/);
    // …y solo si las métricas se calcularon con la pista enfocada ACTUAL (comportamiento
    // probado en src/test/hooks/computeSessionMetrics.test.ts).
    expect(lab).toMatch(/sm\.focusTrackId === tracking\.state\.focusTrackId/);
    expect(lab).toMatch(/sessionMetrics\.focusTrackId === tracking\.state\.focusTrackId/);
  });
});

describe("i18n", () => {
  it("motivos en los 7 idiomas; los namespaces del Scan IQ «calibrado» y del DM-Score ya no existen", () => {
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of ["scanIqGate.reason", "dmScoreGate.reason", "scanningIntelligencePage.gateUnlock", "trackingSnapshotPanel.scansNotAttributable"]) {
        const v = get(json, key);
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${key}`).toBe(true);
      }
      expect(get(json, "scanIQCard"), `${locale}: scanIQCard`).toBeUndefined();
      expect(get(json, "dmScoreCard"), `${locale}: dmScoreCard`).toBeUndefined();
      expect(get(json, "scanningAnalyzerDialog.pipelineStep3"), `${locale}`).toBeUndefined();
      expect(JSON.stringify(get(json, "scanningIntelligencePage")), locale).not.toMatch(/Jordet|élite|elite|derivados del jugador/i);
    }
  });
});
