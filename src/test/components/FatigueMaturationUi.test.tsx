/**
 * P1 bloque 4 · pantallas de carga/fatiga SIN maduración registrada (decisión del
 * owner): sin semáforo, con aviso, y la carga se muestra. También: sin datos no hay
 * «0/100 bajo» ni «carga equilibrada», y la gráfica ACWR no reclasifica el ratio
 * con cortes fijos de adulto.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import FatiguePanel from "@/components/FatiguePanel";
import OvertrainingAlert from "@/components/wellbeing/OvertrainingAlert";
import ACWRHistoryChart from "@/components/injury/ACWRHistoryChart";
import { adjustFatigueThresholds } from "@/lib/fatigue/phvFatigueAdjuster";
import type { FatigueReport } from "@/lib/fatigue/types";

const decay = { sprintDecayPct: -45, speedDecayPct: -10, hidDecayPct: -20, metabolicDecayPct: -15, accelDecayPct: -5 };

function report(phvOffset: number | null, over: Partial<FatigueReport> = {}): FatigueReport {
  const thresholds = adjustFatigueThresholds(phvOffset);
  const known = thresholds.band !== "unknown";
  return {
    fatigueIndex: {
      value: known ? 62 : null,
      severity: known ? "high" : null,
      gate_reason: known ? null : thresholds.gate_reason,
      components: { sprintDecay: 45, speedDecay: 10, hidDecay: 20, metabolicDecay: 15, accelDecay: 5 },
      decay,
      reliable: true,
      minimumMinutesRequired: 20,
    },
    windows: [],
    posture: null,
    acwr: {
      value: 1.45, zone: known ? "danger" : null, acuteLoad: 300, chronicLoad: 200, sessionsUsed: 6, reliable: true,
      recommendation: known ? "ACWR 1.45 — ZONA DE PELIGRO" : null, gate_reason: known ? null : thresholds.gate_reason,
    },
    thresholds,
    alerts: known ? [{ level: "warning", source: "fatigue_index", title: "Fatiga Alta", message: "m", detectedAt: 0, phvAdjusted: true }] : [],
    sessionDurationMin: 60,
    totalMetabolicLoad: 900,
    playerId: "p1",
    analyzedAt: "2026-10-14T10:00:00Z",
    ...over,
  };
}

describe("FatiguePanel", () => {
  it("maduración desconocida: aviso, índice «no calculado», ratio sin zona, sin alertas ni severidad", () => {
    render(<FatiguePanel report={report(null)} />);
    expect(screen.getByTestId("fatigue-maturation-unknown")).toHaveTextContent("fatiguePanel.maturationUnknownTitle");
    expect(screen.getByTestId("fatigue-index-not-computed")).toHaveTextContent("fatiguePanel.fiNotComputedMaturity");
    expect(screen.queryByText("fatiguePanel.severityHigh")).toBeNull();
    expect(screen.getByText("1.45")).toBeInTheDocument(); // la carga sí
    expect(screen.getByTestId("acwr-no-zone")).toHaveTextContent("fatiguePanel.acwrNoZone");
    expect(screen.queryByText("fatiguePanel.acwrDangerZone")).toBeNull();
    expect(screen.queryByText("Fatiga Alta")).toBeNull();
  });

  it("informe antiguo con \"post_phv\" sin offset = maduración desconocida (aunque traiga índice y alertas)", () => {
    const legacy = report(2);
    legacy.thresholds = { ...legacy.thresholds, phvOffset: null };
    render(<FatiguePanel report={legacy} />);
    expect(screen.getByTestId("fatigue-maturation-unknown")).toBeInTheDocument();
    expect(screen.queryByText("fatiguePanel.severityHigh")).toBeNull();
    expect(screen.queryByText("Fatiga Alta")).toBeNull();
  });

  it("control: con maduración registrada, severidad, zona y alertas como antes", () => {
    render(<FatiguePanel report={report(2)} />);
    expect(screen.queryByTestId("fatigue-maturation-unknown")).toBeNull();
    expect(screen.getByText("fatiguePanel.severityHigh")).toBeInTheDocument();
    expect(screen.getByText("fatiguePanel.acwrDangerZone")).toBeInTheDocument();
    expect(screen.getByText("Fatiga Alta")).toBeInTheDocument();
  });

  it("ACWR sin ratio (pocas sesiones): lo dice, nunca un 0 ni «óptimo»", () => {
    const r = report(2, {
      acwr: { value: null, zone: null, acuteLoad: null, chronicLoad: null, sessionsUsed: 2, reliable: false, recommendation: null, gate_reason: "x" },
    });
    render(<FatiguePanel report={r} />);
    expect(screen.getByTestId("acwr-not-computed")).toHaveTextContent("fatiguePanel.acwrUnreliable");
    expect(screen.queryByText("fatiguePanel.acwrOptimal")).toBeNull();
    expect(screen.queryByText("0.00")).toBeNull();
  });
});

describe("OvertrainingAlert", () => {
  it("sin calcular por maduración: sin «N/100», con el motivo y la carga registrada", () => {
    render(<OvertrainingAlert risk={null} riskLevel={null} currentLoadAU={410} recommendedLoadAU={null} adjustmentPct={null} gateCode="maturation_unknown" />);
    expect(screen.getByTestId("overtraining-not-computed")).toHaveTextContent("overtrainingAlert.maturationUnknown");
    expect(screen.queryByText(/\/100/)).toBeNull();
    expect(screen.getByText("410")).toBeInTheDocument();
    expect(screen.queryByText("overtrainingAlert.recommended")).toBeNull();
  });

  it("sin datos: «sin carga registrada», nunca 0", () => {
    render(<OvertrainingAlert risk={null} riskLevel={null} currentLoadAU={null} recommendedLoadAU={null} adjustmentPct={null} gateCode="no_data" />);
    expect(screen.getByTestId("overtraining-not-computed")).toHaveTextContent("overtrainingAlert.noData");
    expect(screen.getByText("overtrainingAlert.noLoad")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("control: con riesgo calculado se ve el nivel", () => {
    render(<OvertrainingAlert risk={72} riskLevel="high" currentLoadAU={410} recommendedLoadAU={null} adjustmentPct={null} gateCode={null} />);
    expect(screen.getByText("72/100")).toBeInTheDocument();
    expect(screen.queryByTestId("overtraining-not-computed")).toBeNull();
  });
});

describe("ACWRHistoryChart", () => {
  // recharts (ResponsiveContainer) necesita ResizeObserver, que jsdom no trae.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

  it("la alerta de peligro sale de la ZONA de los datos, no de reclasificar el ratio con cortes de adulto", () => {
    const { rerender } = render(<ACWRHistoryChart data={[{ date: "2026-10-14", acwr: 1.8, load: 300, zone: "unknown" }]} />);
    expect(screen.queryByText(/zona de peligro/i)).toBeNull();
    rerender(<ACWRHistoryChart data={[{ date: "2026-10-14", acwr: 1.45, load: 300, zone: "danger" }]} />);
    expect(screen.getByText(/zona de peligro/i)).toBeInTheDocument();
  });
});
