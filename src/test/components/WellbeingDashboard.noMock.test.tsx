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
}));

const RISK = vi.hoisted(() => ({
  playerId: "p1", isMock: false, riskScore: 40, riskLevel: "moderate", primaryFactor: "engagementDecline",
  factors: [], engagement: {}, overtraining: {}, motivation: {}, attendance: {}, intervention: { actions: [] },
}));

vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: state.player }),
  useAllPlayers: () => ({ data: [] }),
}));
vi.mock("@/hooks/useWellbeing", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useWellbeing")>()),
  useDropoutRisk: () => ({ data: RISK }),
  useEngagementHistory: () => ({ data: [] }),
  useAttendance: () => ({ data: state.attendance }),
  useBurnoutReport: () => ({ mutate: state.mutate, isPending: false, data: undefined, isError: false }),
}));
vi.mock("@/components/wellbeing/AttendanceCalendar", () => ({ default: () => <div data-testid="attendance-calendar" /> }));
vi.mock("@/components/wellbeing/DropoutRiskGauge", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/OvertrainingAlert", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/InterventionPlanView", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/AttendanceLogForm", () => ({ default: () => null }));
vi.mock("@/components/wellbeing/EngagementLogForm", () => ({ default: () => null }));
vi.mock("@/components/coaching/EngagementMiniCard", () => ({ default: () => null }));

import { PlayerDetail } from "@/components/wellbeing/WellbeingDashboard";

const NO_RECORDS = { playerId: "p1", rate: null, totalSessions: 0, records: [], isMock: false };

describe("PlayerDetail (Bienestar)", () => {
  beforeEach(() => state.mutate.mockReset());

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
    state.attendance = NO_RECORDS;
    state.player = { id: "p1", birthDate: "2010-01-15" };
    render(<PlayerDetail playerId="p1" playerName="Leo" onBack={() => {}} />);
    fireEvent.click(screen.getByText("burnoutReport.generate"));
    expect(state.mutate).toHaveBeenCalledTimes(1);
    const sent = state.mutate.mock.calls[0][0] as { playerAge: number };
    const years = (Date.now() - Date.parse("2010-01-15")) / (365.25 * 24 * 3600 * 1000);
    expect(sent.playerAge).not.toBe(13);
    expect(Math.abs(sent.playerAge - years)).toBeLessThan(0.1);
  });
});
