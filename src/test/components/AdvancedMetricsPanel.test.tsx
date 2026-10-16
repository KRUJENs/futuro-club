import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next, I18nextProvider } from "react-i18next";
import { AdvancedMetricsPanel } from "@/components/AdvancedMetricsPanel";
import type { AdvancedPlayerMetrics } from "@/services/real/advancedMetricsService";
import esTranslations from "@/i18n/es.json";

// AdvancedMetricsPanel se migró a react-i18next. Sin un proveedor i18n, t()
// devuelve las claves crudas (p.ej. "advancedMetricsPanel.fieldCoverageLabel")
// y las aserciones sobre el texto en español fallan. Montamos una instancia
// i18n de test con las traducciones reales de es.json, con idioma fijado a "es"
// (sin LanguageDetector, para que sea determinista) de modo que las pruebas
// verifiquen la salida en español que la app produce en producción.
const testI18n = i18next.createInstance();
testI18n.use(initReactI18next).init({
  lng: "es",
  fallbackLng: "es",
  resources: { es: { translation: esTranslations } },
  interpolation: { escapeValue: false },
});

function renderPanel(ui: ReactElement) {
  return render(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>);
}

function makeMetrics(overrides: Partial<AdvancedPlayerMetrics> = {}): AdvancedPlayerMetrics {
  return {
    dominantFeatures: {
      dominant: [
        { key: "shooting", label: "Disparo", value: 74, zScore: 1.47, description: "" },
      ],
      underdeveloped: [],
      playStyle: "ofensivo",
      specializationIndex: 0.4,
    },
    vaep: {
      vaepTotal: 2.4,
      vaep90: 2.4,
      topActions: [
        { actionId: "v_40000_shot", impact: 0.35 },
        { actionId: "v_10000_pass", impact: 0.12 },
      ],
      status: "calculated",
      message: "VAEP calculado con 6 acciones",
    },
    tracking: {
      maxSpeedMs: 8.2,
      avgSpeedMs: 3.1,
      totalDistanceM: 9200,
      fieldCoveragePct: 42.5,
      sprintCount: 6,
      sprintDistanceM: 320,
      status: "calculated",
      message: "Tracking calculado",
    },
    biomechanics: {
      drillScore: 82,
      injuryRisk: 0.16,
      asymmetryPct: 8,
      status: "calculated",
      message: "DrillScore calculado",
    },
    ...overrides,
  };
}

describe("AdvancedMetricsPanel", () => {
  it("muestra VAEP cuando status=calculated", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText("VAEP")).toBeInTheDocument();
    expect(screen.getByText("2.40")).toBeInTheDocument();
  });

  it("muestra tracking con fieldCoverage", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText("Cobertura de campo")).toBeInTheDocument();
    expect(screen.getByText("42.5%")).toBeInTheDocument();
  });

  it("muestra drillScore biomecánico", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText("DrillScore")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
  });

  it("muestra top actions del VAEP", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText(/tiro/i)).toBeInTheDocument();
    expect(screen.getByText(/pase/i)).toBeInTheDocument();
  });

  it("muestra message de stub cuando VAEP no calculado", () => {
    const metrics = makeMetrics({
      vaep: {
        vaepTotal: null, vaep90: null, topActions: [],
        status: "stub_no_data", message: "Sin acciones SPADL",
      },
    });
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText(/sin acciones spadl/i)).toBeInTheDocument();
  });

  it("muestra badge de calidad cuando se provee qualityScore", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} qualityScore={0.85} />);
    expect(screen.getByText(/excelente/i)).toBeInTheDocument();
  });

  it("muestra issues de calidad si se proveen", () => {
    const metrics = makeMetrics();
    renderPanel(
      <AdvancedMetricsPanel
        metrics={metrics}
        qualityScore={0.5}
        qualityIssues={["Pocos eventos detectados", "Muestra corta"]}
      />
    );
    expect(screen.getByText(/limitaciones del análisis/i)).toBeInTheDocument();
    expect(screen.getByText(/pocos eventos detectados/i)).toBeInTheDocument();
  });

  it("velocidad máxima se muestra cuando hay tracking calculado", () => {
    const metrics = makeMetrics();
    renderPanel(<AdvancedMetricsPanel metrics={metrics} />);
    expect(screen.getByText(/velocidad máx/i)).toBeInTheDocument();
    expect(screen.getByText(/8\.2 m\/s/)).toBeInTheDocument();
  });
});
