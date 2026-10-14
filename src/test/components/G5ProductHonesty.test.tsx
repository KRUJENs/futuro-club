/**
 * VITAS · G5 — guard de honestidad de producto.
 *
 * Invariante (CLAUDE.md #1/#2 · .claude/rules/metricas.md): una vista de cliente
 * que pinta datos MOCK debe mostrar SIEMPRE el DemoDataBanner, y NUNCA una cifra
 * en euros derivada de datos sintéticos.
 *
 * Este test FALLA si alguien retira el banner de una vista de cliente con datos
 * de ejemplo, o si reaparece una cifra en € en el Radar de Retención.
 *
 * Superficies cubiertas (alcance G5):
 *   - Radar de Retención (/director) — RetentionRadarCard (riesgo hash-based).
 *   - Bienestar del hijo (/family/:id) — ParentWellbeingSection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks compartidos (patrón de src/test/components/Rankings.test.tsx) ───────
const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

// t(key) => key: el DemoDataBanner renderiza sus claves i18n como texto, así que
// aserta contra la CLAVE (no contra la traducción), robusto a cambios de copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));

vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        return ({ children, ...props }: Record<string, unknown> & { children?: unknown }) => {
          const Tag = prop as unknown as React.ElementType;
          return <Tag {...props}>{children as React.ReactNode}</Tag>;
        };
      },
    },
  );
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

// PlayerService: el Radar de Retención lo consulta para el roster.
const mockPlayers = [
  { id: "p1", name: "Jugador Uno" },
  { id: "p2", name: "Jugador Dos" },
  { id: "p3", name: "Jugador Tres" },
];
vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getAll: () => mockPlayers,
    getById: (id: string) => mockPlayers.find((p) => p.id === id) ?? null,
  },
}));

// useWellbeing: fuente del mock de bienestar (hash del id → isMock:true).
const mockUseDropoutRisk = vi.fn();
vi.mock("@/hooks/useWellbeing", () => ({
  useDropoutRisk: (...args: unknown[]) => mockUseDropoutRisk(...args),
  useEngagementHistory: () => ({ data: [] }),
}));

// Hermanos de ParentDashboardPage que ParentWellbeingSection NO usa: mockearlos
// resuelve el grafo de import sin arrastrar dependencias pesadas (recharts, etc.).
vi.mock("@/components/PeerBenchmark", () => ({ default: () => null }));
vi.mock("@/components/idp/IDPParentView", () => ({ IDPParentView: () => null }));
vi.mock("@/components/phv/GrowthSpurtShieldAlert", () => ({ GrowthSpurtShieldAlert: () => null }));
vi.mock("@/hooks/useIDP", () => ({ useCurrentIDP: () => ({ data: null }) }));
vi.mock("@/hooks/usePHVProduct", () => ({ usePHVProduct: () => null }));
vi.mock("@/hooks/useParentalConsent", () => ({
  // P1 bloque 3: estado real del servidor (GuardianConsentCard); aquí sin datos.
  useConsentStatus: () => ({ data: undefined, isLoading: false }),
  useWithdrawGuardianConsent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRequestGuardianSignature: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/usePlayerAnalysisV2", () => ({ useSavedAnalysesV2: () => ({ data: [] }) }));
vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: null }),
  useAllPlayers: () => ({ data: [] }),
}));
vi.mock("@/services/real/playerTrackingService", () => ({ PlayerTrackingService: { get: () => null } }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: async () => ({}) }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { RetentionRadarCard } from "@/components/retention/RetentionRadarCard";
import { ParentWellbeingSection } from "@/pages/ParentDashboardPage";
import { requiresMockBanner } from "@/components/metrics/MetricValue";
import { mock } from "@/lib/metrics/MetricResult";
import type { Provenance } from "@/lib/metrics/MetricResult";

// Con t(key)=>key, el título del DemoDataBanner renderiza su propia clave i18n.
const BANNER_TITLE = "demoData.title";

// ── Radar de Retención (/director) ────────────────────────────────────────────

describe("G5 · Radar de Retención (/director) — vista de cliente con datos MOCK", () => {
  it("muestra el DemoDataBanner (el riesgo es hash-based, no medido)", () => {
    render(<RetentionRadarCard />);
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();
    expect(screen.getByText("retentionRadarCard.demoNotice")).toBeInTheDocument();
  });

  it("NO renderiza ninguna cifra en euros (€ retirado — riesgo comercial)", () => {
    const { container } = render(<RetentionRadarCard />);
    expect(container.textContent ?? "").not.toContain("€");
  });
});

// ── Bienestar del hijo (/family/:id) ──────────────────────────────────────────

describe("G5 · Bienestar del hijo (/family/:id) — banner gateado por isMock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("con datos MOCK (isMock:true) muestra el DemoDataBanner al padre", () => {
    mockUseDropoutRisk.mockReturnValue({
      data: { isMock: true, engagement: { trend: "stable", current: 60 } },
    });
    render(<ParentWellbeingSection playerId="p1" />);
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();
    expect(screen.getByText("demoData.wellbeing")).toBeInTheDocument();
  });

  it("con datos reales (isMock:false) NO muestra el banner de ejemplo", () => {
    mockUseDropoutRisk.mockReturnValue({
      data: { isMock: false, engagement: { trend: "stable", current: 60 } },
    });
    render(<ParentWellbeingSection playerId="p1" />);
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
  });

  it("P1 bloque 4: sin implicación registrada (engagement null) lo dice; nunca «disfrute bajo» por un 0", () => {
    mockUseDropoutRisk.mockReturnValue({ data: { isMock: false, engagement: null } });
    render(<ParentWellbeingSection playerId="p1" />);
    expect(screen.getByTestId("enjoyment-no-data")).toHaveTextContent("parentDashboardPage.enjoymentNoData");
    expect(screen.queryByText("parentDashboardPage.enjoymentLow")).toBeNull();
  });
});

// ── Contrato de procedencia: MOCK exige banner ────────────────────────────────

describe("G5 · Contrato: provenance MOCK exige banner visible", () => {
  it("requiresMockBanner es true solo para MOCK", () => {
    expect(requiresMockBanner("MOCK")).toBe(true);
    (["MEDIDA", "DERIVADA", "ESTIMADA_LLM", "CONSTANTE"] as Provenance[]).forEach((p) => {
      expect(requiresMockBanner(p)).toBe(false);
    });
  });

  it("un MetricResult mock() tiene provenance MOCK → exige banner", () => {
    const m = mock(42);
    expect(m.provenance).toBe("MOCK");
    expect(requiresMockBanner(m.provenance)).toBe(true);
  });
});
