/**
 * Rankings — Tests
 * Titulo, search, lista jugadores, empty state, sort
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));

vi.mock("framer-motion", () => {
  const motion = new Proxy({}, {
    get: (_target, prop: string) => {
      return ({ children, ...props }: any) => {
        const Tag = prop as any;
        return <Tag {...props}>{children}</Tag>;
      };
    },
  });
  return { motion, AnimatePresence: ({ children }: any) => <>{children}</> };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const mockPlayers = [
  {
    id: "p1", name: "Pablo Gavi", vsi: 88, positionShort: "CM", age: 19,
    position: "Mediocentro", phvCategory: "on-time", trending: "up",
    percentile: 80, percentileInAgeGroup: 85, ageGroup: "Sub-21",
    competitiveLevel: "Regional", phvOffset: 0, metrics: {}, foot: "right", height: 170, weight: 68,
    updatedAt: "2026-01-01",
  },
  {
    id: "p2", name: "Pedri Gonzalez", vsi: 91, positionShort: "AM", age: 20,
    position: "Mediapunta", phvCategory: "late", trending: "up",
    percentile: 95, percentileInAgeGroup: 90, ageGroup: "Sub-21",
    competitiveLevel: "Regional", phvOffset: 0, metrics: {}, foot: "right", height: 174, weight: 70,
    updatedAt: "2026-01-01",
  },
  {
    id: "p3", name: "Lamine Yamal", vsi: 85, positionShort: "RW", age: 16,
    position: "Extremo Derecho", phvCategory: "early", trending: "up",
    percentile: 70, percentileInAgeGroup: 95, ageGroup: "Sub-18",
    competitiveLevel: "Regional", phvOffset: 0, metrics: {}, foot: "right", height: 180, weight: 72,
    updatedAt: "2026-01-01",
  },
];

const mockRankingsResponse = {
  players: mockPlayers,
  total: 3,
  totalUnfiltered: 3,
  ageGroups: ["Sub-18", "Sub-21"],
  ageGroupStats: { "Sub-18": { count: 1, avgVsi: 85, minVsi: 85, maxVsi: 85 }, "Sub-21": { count: 2, avgVsi: 89.5, minVsi: 88, maxVsi: 91 } },
  competitiveLevels: ["Regional"],
  limit: 50,
  offset: 0,
};

const mockUseRankedPlayers = vi.fn();
vi.mock("@/hooks/useRankings", () => ({
  useRankedPlayers: (...args: any[]) => mockUseRankedPlayers(...args),
}));

vi.mock("@/components/shared/PageHeader", () => ({
  default: ({ title, subtitle }: any) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  ),
}));

vi.mock("@/components/shared/Skeletons", () => ({
  RankingsPodiumSkeleton: () => <div data-testid="podium-skeleton">Loading podium...</div>,
  PlayerListSkeleton: () => <div data-testid="list-skeleton">Loading list...</div>,
}));

vi.mock("@/components/VsiGauge", () => ({
  default: ({ value }: any) => <span data-testid="vsi-gauge">{value}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/hooks/useUserProfile", () => ({
  useUserProfile: () => ({
    role: "director",
    permissions: {
      canCreatePlayers: true, canEditPlayers: true, canDeletePlayers: true,
      canRunAnalysis: true, canViewAllPlayers: true, canManageTeam: true,
      canViewDirectorDashboard: true, canExportPDF: true, canViewVideoAnalysis: true,
    },
    isDirector: true,
    isLoading: false,
    profile: null,
    isOnboardingCompleted: true,
  }),
}));

vi.mock("@/components/FeatureHint", () => ({
  default: () => null,
}));

import Rankings from "@/pages/Rankings";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Rankings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRankedPlayers.mockReturnValue({
      data: mockRankingsResponse,
      isLoading: false,
      isError: false,
    });
  });

  it("renderiza titulo y search input", () => {
    render(<Rankings />);
    expect(screen.getByText("players.rankings.title")).toBeDefined();
    const searchInput = document.querySelector('input[placeholder="players.rankings.searchPlaceholder"]');
    expect(searchInput).toBeDefined();
  });

  it("renderiza lista de jugadores cuando hay data", () => {
    render(<Rankings />);
    expect(screen.getByText("Pablo Gavi")).toBeDefined();
    expect(screen.getByText("Pedri Gonzalez")).toBeDefined();
    expect(screen.getByText("Lamine Yamal")).toBeDefined();
  });

  it("muestra empty state cuando no hay jugadores", () => {
    mockUseRankedPlayers.mockReturnValue({
      data: { players: [], total: 0, totalUnfiltered: 0, ageGroups: [], ageGroupStats: {}, competitiveLevels: [], limit: 50, offset: 0 },
      isLoading: false,
      isError: false,
    });
    render(<Rankings />);
    expect(screen.getByText("players.rankings.noPlayersTitle")).toBeDefined();
  });

  it("search input actualiza filtros y llama al hook con search", () => {
    render(<Rankings />);
    const searchInput = document.querySelector('input[placeholder="players.rankings.searchPlaceholder"]')!;
    fireEvent.change(searchInput, { target: { value: "Gavi" } });
    // Verify the hook is called with search filter
    const lastCall = mockUseRankedPlayers.mock.calls[mockUseRankedPlayers.mock.calls.length - 1];
    expect(lastCall[2]).toEqual(expect.objectContaining({ search: "Gavi" }));
  });

  it("botones de sort estan presentes", () => {
    render(<Rankings />);
    // Sort buttons render translated keys
    expect(screen.getByText(/players\.rankings\.sortVsi/)).toBeDefined();
    expect(screen.getByText(/players\.rankings\.sortAge/)).toBeDefined();
    expect(screen.getByText(/players\.rankings\.sortName/)).toBeDefined();
  });

  // Gate único de PHV (regla del owner 28-sep): sin TODAS las entradas
  // introducidas la fila nombra qué falta; nunca una fase/timing ni el
  // phvCategory persistido.
  it("jugadores sin todas las entradas PHV muestran el motivo del gate, no un timing", () => {
    render(<Rankings />);
    const notices = screen.getAllByTestId("phv-gate-notice");
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) {
      expect(n.textContent).toContain("maturity.gate.unavailable");
      expect(n.textContent).toContain("maturity.gate.missing");
    }
    expect(screen.queryByText(/maturity\.timing\./)).toBeNull();
  });

  it("jugador con entradas completas introducidas muestra timing del motor, sin aviso de gate", () => {
    const complete = {
      ...mockPlayers[0], id: "full", name: "Completo",
      height: 165, weight: 55, sittingHeight: 85, legLength: 80, birthDate: "2012-03-15", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M",
    };
    mockUseRankedPlayers.mockReturnValue({
      data: { ...mockRankingsResponse, players: [complete], total: 1, totalUnfiltered: 1 },
      isLoading: false,
      isError: false,
    });
    render(<Rankings />);
    expect(screen.queryByTestId("phv-gate-notice")).toBeNull();
    expect(screen.getAllByText(/maturity\.timing\./).length).toBeGreaterThan(0);
  });

  // Filtro «Maduración» = TIMING (mismo rótulo que la fila), nunca la fase: antes el
  // chip «Tardío ⭐» (phvFilter.early) filtraba pre-PHV y ocultaba al tardío en PHV.
  it("el chip de maduración y la fila usan el MISMO rótulo de timing y el chip filtra por timing", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    try {
      const lateInPhv = {
        ...mockPlayers[0], id: "late", name: "Tardio EnPHV",
        height: 160, weight: 48, sittingHeight: 80, legLength: 80, birthDate: "2011-09-29", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M",
      };
      const preOnTime = {
        ...mockPlayers[1], id: "pre", name: "Pre EnFase",
        height: 150, weight: 42, sittingHeight: 78, legLength: 72, birthDate: "2016-03-29", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M",
      };
      mockUseRankedPlayers.mockReturnValue({
        data: { ...mockRankingsResponse, players: [lateInPhv, preOnTime], total: 2, totalUnfiltered: 2 },
        isLoading: false,
        isError: false,
      });
      render(<Rankings />);
      fireEvent.click(screen.getByText("common.filters"));
      // Chip + fila del tardío en PHV; chip + fila del pre-PHV en fase.
      expect(screen.getAllByText("maturity.timing.late ⭐")).toHaveLength(2);
      expect(screen.getAllByText("maturity.timing.on_time")).toHaveLength(2);
      expect(screen.getAllByText("maturity.timing.early")).toHaveLength(1); // solo el chip
      // Las claves de fase rotuladas como timing ya no existen.
      expect(document.body.textContent).not.toMatch(/players\.rankings\.phvFilter\.(late|early|onTime)/);

      const chip = screen.getAllByText("maturity.timing.late ⭐").find((el) => el.tagName === "BUTTON")!;
      fireEvent.click(chip);
      const lastCall = mockUseRankedPlayers.mock.calls[mockUseRankedPlayers.mock.calls.length - 1];
      expect(lastCall[2]).toEqual(expect.objectContaining({ timing: "late" }));
      expect(lastCall[2]).not.toHaveProperty("phv");
    } finally {
      vi.useRealTimers();
    }
  });

  // P1 bloque 5: con menos de 10 pares evaluados el servidor no da percentil (antes P0
  // por la RPC o P100 con un solo valor): la fila lo dice, nunca un «P0».
  it("percentil bloqueado por pocos pares ⇒ motivo corto en la fila, sin «P»", () => {
    const fewPeers = {
      ...mockPlayers[0], id: "few", name: "Pocos Pares",
      percentile: null, percentileInAgeGroup: null,
      percentileGate: { code: "insufficient_peers", peers: 2, min: 10 },
      percentileInAgeGroupGate: { code: "insufficient_peers", peers: 0, min: 10 },
    };
    mockUseRankedPlayers.mockReturnValue({
      data: { ...mockRankingsResponse, players: [fewPeers], total: 1, totalUnfiltered: 1 },
      isLoading: false,
      isError: false,
    });
    render(<Rankings />);
    expect(screen.getAllByText("percentile.gate.insufficient_short").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^P\d+$/)).toBeNull();
  });

  it("muestra skeleton mientras carga", () => {
    mockUseRankedPlayers.mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
    });
    render(<Rankings />);
    expect(screen.getByTestId("podium-skeleton")).toBeDefined();
    expect(screen.getByTestId("list-skeleton")).toBeDefined();
  });
});
