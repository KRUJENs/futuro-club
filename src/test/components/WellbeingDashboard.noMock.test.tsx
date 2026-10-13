/**
 * Bienestar · detalle del jugador (P1 bloque 2).
 *  - Sin asistencia registrada NO se pinta un calendario inventado (antes generateMockAttendance
 *    sin banner junto a un riesgo real); se dice que no hay registros.
 *  - El informe de burnout usa la edad REAL desde la fecha de nacimiento; sin fecha, el botón
 *    queda bloqueado con el motivo (antes edad fija de 13 años).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("framer-motion", () => {
  const motion = new Proxy({}, {
    get: (_t, prop: string) => ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
      const { animate: _a, transition: _tr, initial: _i, exit: _e, ...rest } = props;
      const Tag = prop as keyof JSX.IntrinsicElements;
      return <Tag {...rest}>{children}</Tag>;
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const state = vi.hoisted(() => ({
  attendance: null as unknown,
  player: null as unknown,
  mutate: vi.fn(),
  roster: [] as unknown[],
  teamRisk: [] as unknown[],
  risk: undefined as unknown, // undefined ⇒ el RISK de abajo
}));

const RISK = vi.hoisted(() => ({
  playerId: "p1", isMock: false, riskScore: 40, riskLevel: "moderate", primaryFactor: "engagementDecline",
  factors: [], engagement: {}, overtraining: {}, motivation: {}, attendance: {}, intervention: { actions: [] },
}));

vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: state.player }),
  useAllPlayers: () => ({ data: state.roster, isLoading: false }),
}));
vi.mock("@/hooks/useWellbeing", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useWellbeing")>()),
  useDropoutRisk: () => ({ data: state.risk === undefined ? RISK : state.risk }),
  useEngagementHistory: () => ({ data: [] }),
  useAttendance: () => ({ data: state.attendance }),
  useBurnoutReport: () => ({ mutate: state.mutate, isPending: false, data: undefined, isError: false }),
  useTeamDropoutRisk: () => state.teamRisk,
  useTeamEngagement: () => state.roster.map(() => ({ data: undefined })),
}));
vi.mock("@/components/wellbeing/AttendanceCalendar", () => ({ default: () => <div data-testid="attendance-calendar" /> }));
vi.mock("@/components/wellbeing/DropoutRiskGauge", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/OvertrainingAlert", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/InterventionPlanView", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/AttendanceLogForm", () => ({ default: () => <div data-testid="attendance-form" /> }));
vi.mock("@/components/wellbeing/EngagementLogForm", () => ({ default: () => <div data-testid="engagement-form" /> }));
vi.mock("@/components/coaching/EngagementMiniCard", () => ({ default: () => null }));

import WellbeingDashboard, { PlayerDetail } from "@/components/wellbeing/WellbeingDashboard";

const NO_RECORDS = { playerId: "p1", rate: null, totalSessions: 0, records: [], isMock: false };

describe("PlayerDetail (Bienestar)", () => {
  beforeEach(() => {
    state.mutate.mockReset();
    state.risk = undefined;
  });

  it("riesgo SIN calcular (null): se dice; ni indicador, ni plan, ni burnout; los formularios de registro siguen", () => {
    state.risk = null;
    state.attendance = NO_RECORDS;
    state.player = { id: "p1", birthDate: "2013-05-01" };
    render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
    expect(screen.getByText("wellbeingDashboard.riskNotCalculated")).toBeInTheDocument();
    expect(screen.queryByText("burnoutReport.generate")).toBeNull();
    // Sin registros, los formularios son justo lo que permite calcular el riesgo.
    expect(screen.getByTestId("attendance-form")).toBeInTheDocument();
    expect(screen.getByTestId("engagement-form")).toBeInTheDocument();
  });

  it("sin asistencia registrada: ni calendario ni % inventados; se dice que no hay registros", () => {
    state.attendance = NO_RECORDS;
    state.player = { id: "p1", birthDate: "2013-05-01" };
    render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
    expect(screen.queryByTestId("attendance-calendar")).toBeNull();
    expect(screen.getByText("wellbeingDashboard.noAttendance")).toBeInTheDocument();
  });

  it("asistencia de EJEMPLO (demo) ⇒ calendario CON banner de datos de ejemplo", () => {
    state.attendance = { playerId: "p1", rate: 80, totalSessions: 5, records: [{ date: "2026-10-01", status: "present" }], isMock: true };
    state.player = { id: "p1", birthDate: "2013-05-01" };
    render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
    expect(screen.getByTestId("attendance-calendar")).toBeInTheDocument();
    expect(screen.getByText("demoData.wellbeing")).toBeInTheDocument();
  });

  it("burnout: sin fecha de nacimiento el botón está bloqueado y se explica (no edad 13)", () => {
    state.attendance = NO_RECORDS;
    state.player = { id: "p1" };
    render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
    const btn = screen.getByText("burnoutReport.generate").closest("button")!;
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("burnoutReport.birthDateRequired")).toBeInTheDocument();
  });

  it("burnout: con fecha de nacimiento manda la edad real (decimal), no 13", () => {
    // «Hoy» fijo ⇒ la edad esperada no depende del día de ejecución.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    try {
      state.attendance = NO_RECORDS;
      state.player = { id: "p1", birthDate: "2010-01-15" };
      render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
      fireEvent.click(screen.getByText("burnoutReport.generate"));
      expect(state.mutate).toHaveBeenCalledTimes(1);
      const sent = state.mutate.mock.calls[0][0] as { playerAge: number };
      expect(sent.playerAge).toBe(16.7); // 15-1-2010 → 13-10-2026 ≈ 16,74 años, a 1 decimal
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WellbeingDashboard · vista de equipo", () => {
  beforeEach(() => {
    state.roster = [{ id: "p1", name: "Leo" }];
  });

  it("riesgo sin calcular (cargando o fallido): ni «0» ni «bajo», y la asistencia dice que no hay registros", () => {
    state.teamRisk = [{ data: undefined, isLoading: true }];
    const { container } = render(<WellbeingDashboard />);
    expect(screen.getByText("teamRiskOverview.riskUnavailable")).toBeInTheDocument();
    expect(container.textContent).toContain("teamRiskOverview.noAttendance");
    expect(container.textContent).not.toMatch(/\b0\s*%/);
    expect(screen.queryByText("0")).toBeNull();
    // No se cuenta como «bajo» en los filtros.
    expect(container.textContent).toContain("teamRiskOverview.filterLow (0)");
  });

  it("riesgo SIN calcular (null, p. ej. el servidor no tiene registros): ni «0» ni «bajo» ni «insufficient_data»", () => {
    state.teamRisk = [{ data: null, isSuccess: true }];
    const { container } = render(<WellbeingDashboard />);
    expect(screen.getByText("teamRiskOverview.riskUnavailable")).toBeInTheDocument();
    expect(container.textContent).toContain("teamRiskOverview.noAttendance");
    expect(container.textContent).not.toContain("insufficient_data");
    expect(container.textContent).not.toMatch(/\b0\s*%/);
    expect(screen.queryByText("0")).toBeNull();
    expect(container.textContent).toContain("teamRiskOverview.filterLow (0)");
  });

  it("riesgo calculado sin asistencia registrada ⇒ su puntuación, y asistencia «sin registros» (no 0 %)", () => {
    state.teamRisk = [{ data: { riskScore: 40, riskLevel: "moderate", primaryFactor: "engagementDecline", attendance: { rate: null } } }];
    const { container } = render(<WellbeingDashboard />);
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(container.textContent).toContain("teamRiskOverview.noAttendance");
    expect(container.textContent).not.toMatch(/\b0\s*%/);
  });

  it("con asistencia registrada ⇒ su porcentaje", () => {
    state.teamRisk = [{ data: { riskScore: 40, riskLevel: "moderate", primaryFactor: "engagementDecline", attendance: { rate: 75 } } }];
    const { container } = render(<WellbeingDashboard />);
    expect(container.textContent).toContain("75%");
    expect(container.textContent).not.toContain("teamRiskOverview.noAttendance");
  });
});
