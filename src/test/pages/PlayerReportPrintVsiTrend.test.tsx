/**
 * Informe imprimible (/report/:id) — la evolución y la variación del VSI salen SOLO de
 * evaluaciones del entrenador con fecha (src/lib/scoring/vsiDelta.ts), igual que el
 * panel de familia y el ScoutFeed (invariante #7).
 *
 * Antes: la gráfica «Evolución VSI» pintaba `vsiHistory` (legacy SIN fechas, con el
 * 57.5 fabricado antes de #146) y «Tendencia» restaba sus dos últimas posiciones con
 * banda ±2. Para Samu ([57.5, 67.4], sin evaluaciones con fecha) el informe decía
 * «↑ En ascenso» mientras el panel de familia bloqueaba la variación.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { calculateFichaVsi } from "@/services/real/metricsService";

vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "p-samu" }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).some((k) => k !== "defaultValue")
        ? `${key} ${JSON.stringify(Object.fromEntries(Object.entries(opts).filter(([k]) => k !== "defaultValue")))}`
        : key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));
// Recharts no dibuja en jsdom: se sustituye por contenedores que exponen los datos.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass,
    RadarChart: Pass,
    Radar: Nothing,
    PolarGrid: Nothing,
    PolarAngleAxis: Nothing,
    LineChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="vsi-line-chart" data-points={JSON.stringify(data)}>{children}</div>
    ),
    Line: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
    CartesianGrid: Nothing,
    Tooltip: Nothing,
  };
});
const mockRawPlayer = vi.fn();
vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: mockRawPlayer(), isLoading: false }),
}));
vi.mock("@/services/real/adapters", () => ({ adaptPlayerForUI: () => ({}) }));

import PlayerReportPrint from "@/pages/PlayerReportPrint";

const METRICS = { speed: 70, technique: 70, vision: 70, stamina: 70, shooting: 70, defending: 70 };
const CURRENT = calculateFichaVsi(METRICS);

const BASE = {
  id: "p-samu", name: "Samu", age: 9, position: "MC", foot: "right",
  competitiveLevel: "Regional", minutesPlayed: 300, metrics: METRICS, vsi: CURRENT,
};
// El caso Samu: historial legacy [57.5, ...], SIN evaluaciones con fecha.
const SAMU_LEGACY = { ...BASE, vsiHistory: [57.5, CURRENT] };
const SAMU_DATED = {
  ...SAMU_LEGACY,
  vsiEvaluations: [
    { value: 60, at: "2026-09-01T10:00:00.000Z", source: "coach_form" },
    { value: CURRENT, at: "2026-09-20T10:00:00.000Z", source: "coach_form" },
  ],
};

function chartPoints(): Array<{ eval: string; vsi: number }> {
  return JSON.parse(screen.getByTestId("vsi-line-chart").getAttribute("data-points") ?? "[]");
}

describe("PlayerReportPrint — evolución y variación del VSI con fecha y procedencia", () => {
  beforeEach(() => {
    mockRawPlayer.mockReset();
    window.print = vi.fn();
  });

  // P1 bloque 5a (revisión #317): «evaluado» = VSI de ficha guardado + 6 barras. Antes
  // bastaba con que existiera `metrics`: `metrics: {}` imprimía «VSI 0».
  it.each([
    ["barras vacías", { ...BASE, metrics: {}, vsi: undefined }],
    ["barras completas sin VSI guardado", { ...BASE, vsi: undefined }],
    ["VSI guardado sin las 6 barras", { ...BASE, metrics: { speed: 70 } }],
  ])("%s ⇒ «sin evaluar», nunca un informe con VSI 0", (_c, player) => {
    mockRawPlayer.mockReturnValue(player);
    const { container } = render(<PlayerReportPrint />);
    expect(container.textContent).toContain("common.notEvaluated");
    expect(screen.queryByTestId("report-vsi-delta")).toBeNull();
  });

  it("solo historial legacy: sin gráfica, sin «En ascenso», variación bloqueada con su motivo", () => {
    mockRawPlayer.mockReturnValue(SAMU_LEGACY);
    const { container } = render(<PlayerReportPrint />);
    const text = container.textContent ?? "";

    expect(screen.queryByTestId("vsi-line-chart")).toBeNull();
    expect(text).not.toContain("57.5");
    expect(text).not.toMatch(/trendRising|trendFalling|trendStable/);
    expect(screen.getByTestId("report-vsi-delta")).toHaveTextContent("vsiDelta.gate.legacy_undated");
    expect(screen.getByTestId("report-vsi-delta")).not.toHaveTextContent("Calculado");
    // El 57.5 guardado sin evaluación no cuenta como evaluación.
    expect(screen.getByTestId("report-dated-evaluations")).toHaveTextContent("0");
    expect(screen.getByTestId("report-dated-evaluations")).toHaveTextContent("playerReportPrint.datedEvaluations");
  });

  it("dos evaluaciones con fecha: gráfica solo con ellas (por fecha) y variación «Calculado» con sus fechas", () => {
    mockRawPlayer.mockReturnValue(SAMU_DATED);
    render(<PlayerReportPrint />);

    const points = chartPoints();
    expect(points.map((p) => p.vsi)).toEqual([60, CURRENT]);
    expect(points.every((p) => p.eval.includes("2026"))).toBe(true);
    expect(points.some((p) => p.vsi === 57.5)).toBe(false);

    const delta = screen.getByTestId("report-vsi-delta");
    const expected = Math.round((CURRENT - 60) * 10) / 10;
    expect(delta).toHaveTextContent(`+${expected} pts`);
    expect(delta).toHaveTextContent("Calculado");
    expect(delta).toHaveTextContent("playerReportPrint.vsiDeltaBetween");
    expect(delta).toHaveTextContent("2026");
    expect(screen.getByTestId("report-dated-evaluations")).toHaveTextContent("2");
  });

  it("evaluaciones de la semilla demo no son reales: ni gráfica ni variación", () => {
    mockRawPlayer.mockReturnValue({
      ...BASE,
      vsiHistory: [],
      vsiEvaluations: [
        { value: 60, at: "2026-09-01T10:00:00.000Z", source: "demo_seed" },
        { value: CURRENT, at: "2026-09-20T10:00:00.000Z", source: "demo_seed" },
      ],
    });
    render(<PlayerReportPrint />);
    expect(screen.queryByTestId("vsi-line-chart")).toBeNull();
    expect(screen.getByTestId("report-vsi-delta")).toHaveTextContent("vsiDelta.gate.no_evaluations");
    expect(screen.getByTestId("report-dated-evaluations")).toHaveTextContent("0");
  });

  it("el VSI actual no coincide con la última evaluación: variación bloqueada (no describe el valor mostrado)", () => {
    mockRawPlayer.mockReturnValue({
      ...SAMU_DATED,
      vsiEvaluations: [
        { value: 60, at: "2026-09-01T10:00:00.000Z", source: "coach_form" },
        { value: 50, at: "2026-09-20T10:00:00.000Z", source: "coach_form" },
      ],
    });
    render(<PlayerReportPrint />);
    expect(screen.getByTestId("report-vsi-delta")).toHaveTextContent("vsiDelta.gate.current_mismatch");
    expect(screen.getByTestId("report-vsi-delta")).not.toHaveTextContent("-10");
  });
});
