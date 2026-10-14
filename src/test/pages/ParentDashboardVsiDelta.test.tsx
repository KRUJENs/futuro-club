/**
 * Panel de familia (/family/:id) — la variación del VSI solo existe si se CALCULÓ
 * entre dos evaluaciones reales con fecha, y se muestra con esas fechas.
 *
 * Antes: «+X pts vs hace 1 mes» restando vsiHistory[len-4] (un historial SIN fechas,
 * con 57.5 fabricados) → fecha inventada, insignia «Subiendo» desbloqueada y el mismo
 * «(↗ +9.9 pts)» en el texto que la familia comparte por WhatsApp.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ playerId: "p-samu" }),
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
vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        ({ children, initial: _i, animate: _a, transition: _tr, exit: _e, ...props }: Record<string, unknown> & { children?: unknown }) => {
          const Tag = prop as unknown as React.ElementType;
          return <Tag {...props}>{children as React.ReactNode}</Tag>;
        },
    },
  );
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock("@/services/real/playerService", () => ({
  PlayerService: { getById: () => ({ id: "p-samu", name: "Samu", age: 9 }), getAll: () => [] },
}));
const mockRawPlayer = vi.fn();
vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: mockRawPlayer() }),
  useAllPlayers: () => ({ data: [] }),
}));
vi.mock("@/hooks/usePlayerAnalysisV2", () => ({
  useSavedAnalysesV2: () => ({ data: [{ id: "a1", report: {} }] }),
}));
vi.mock("@/hooks/useWellbeing", () => ({
  useDropoutRisk: () => ({ data: null }),
  useEngagementHistory: () => ({ data: [] }),
}));
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
vi.mock("@/services/real/playerTrackingService", () => ({ PlayerTrackingService: { get: () => null } }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: async () => ({}) }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import ParentDashboardPage from "@/pages/ParentDashboardPage";

// El caso Samu: historial legacy [57.5, 67.4], SIN evaluaciones con fecha.
const SAMU_LEGACY = { id: "p-samu", name: "Samu", age: 9, vsi: 67.4, vsiHistory: [57.5, 67.4] };
const SAMU_DATED = {
  ...SAMU_LEGACY,
  vsiEvaluations: [
    { value: 57.5, at: "2026-09-01T10:00:00.000Z", source: "coach_form" },
    { value: 67.4, at: "2026-09-20T10:00:00.000Z", source: "coach_form" },
  ],
};

function improvingBadge(): HTMLElement {
  return screen.getByTitle("parentDashboardPage.badgeImprovingDesc");
}

async function shareAndGetText(): Promise<string> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { url: "/s/abc" } })),
  );
  fireEvent.click(screen.getByText("parentDashboardPage.shareProgress"));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  return String(writeText.mock.calls[0][0]);
}

describe("Panel de familia — variación del VSI con procedencia y fechas reales", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRawPlayer.mockReset();
  });

  it("solo historial legacy: NO '+9.9', NO 'vs hace 1 mes', 'Subiendo' bloqueada; se muestra el motivo", () => {
    mockRawPlayer.mockReturnValue(SAMU_LEGACY);
    const { container } = render(<ParentDashboardPage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("9.9");
    expect(text).not.toContain("ptsVsOneMonthAgo");
    expect(screen.queryByTestId("family-vsi-delta")).toBeNull();
    expect(screen.getByTestId("family-vsi-delta-gated")).toHaveTextContent("vsiDelta.gate.legacy_undated");
    expect(improvingBadge().className).toContain("grayscale");
    // El valor actual SÍ se sigue mostrando (legacy solo para el valor actual).
    expect(text).toContain("67");
  });

  it("dos evaluaciones con fecha: '+9.9 pts' «Calculado» con sus fechas y 'Subiendo' desbloqueada", () => {
    mockRawPlayer.mockReturnValue(SAMU_DATED);
    render(<ParentDashboardPage />);
    const chip = screen.getByTestId("family-vsi-delta");
    expect(chip).toHaveTextContent("+9.9 pts");
    expect(chip).toHaveTextContent("Calculado");
    expect(chip).toHaveTextContent("parentDashboardPage.vsiDeltaBetween");
    expect(chip).toHaveTextContent("2026");
    expect(improvingBadge().className).not.toContain("grayscale");
  });

  it("texto para compartir: sin variación calculada NO lleva '(↗ +9.9 pts)'", async () => {
    mockRawPlayer.mockReturnValue(SAMU_LEGACY);
    render(<ParentDashboardPage />);
    const shared = await shareAndGetText();
    expect(shared).not.toContain("9.9");
    expect(shared).not.toContain("shareDelta");
  });

  it("texto para compartir: con variación calculada lleva el valor y sus fechas", async () => {
    mockRawPlayer.mockReturnValue(SAMU_DATED);
    render(<ParentDashboardPage />);
    const shared = await shareAndGetText();
    expect(shared).toContain("parentDashboardPage.shareDelta");
    expect(shared).toContain("+9.9");
    expect(shared).toContain("2026");
  });

  it("sin evaluar (vsi null): ni 0 fabricado, ni variación, ni 'Talento'", () => {
    mockRawPlayer.mockReturnValue({ id: "p-samu", name: "Samu", age: 9, vsi: null, vsiHistory: [] });
    render(<ParentDashboardPage />);
    expect(screen.getByText("common.notEvaluated")).toBeInTheDocument();
    expect(screen.queryByTestId("family-vsi-delta")).toBeNull();
    expect(screen.queryByTestId("family-vsi-delta-gated")).toBeNull();
    expect(screen.getByTitle("parentDashboardPage.badgeEliteDesc").className).toContain("grayscale");
  });
});
