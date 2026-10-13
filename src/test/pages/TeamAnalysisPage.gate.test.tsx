/**
 * TeamAnalysisPage — no-visual-input gate in the UI.
 *
 * A cloud-only (Bunny) video gave the team analysis nothing to see, yet a
 * report was generated and shown. Now the page shows the gate reason instead
 * of a report: up front for a cloud video (button disabled), and after a run
 * the hook blocked (no success toast, no switch to the report tab).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";

vi.mock("framer-motion", () => {
  const motion = new Proxy({}, {
    get: (_target, prop: string) => {
      return ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
        const { animate: _a, transition: _t, initial: _i, exit: _e, ...rest } = props;
        const Tag = prop as keyof JSX.IntrinsicElements;
        return <Tag {...rest}>{children}</Tag>;
      };
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/VideoUpload", () => ({ default: () => <div data-testid="video-upload" /> }));
vi.mock("@/components/PlayerHeatmap", () => ({ default: () => null }));

const CLOUD_VIDEO = {
  id: "bunny-1", title: "Partido en la nube", status: "finished",
  embedUrl: "https://iframe.mediadelivery.net/embed/1/abc", streamUrl: "https://vz.b-cdn.net/abc/playlist.m3u8",
  duration: 90,
};
const LOCAL_VIDEO = {
  id: "local-1", title: "Partido local", status: "uploaded",
  embedUrl: "", streamUrl: null, localPath: "blob:http://localhost/xyz", duration: 90,
};

vi.mock("@/services/real/videoService", () => ({
  VideoService: {
    getAll: () => [CLOUD_VIDEO, LOCAL_VIDEO],
    getById: (id: string) => [CLOUD_VIDEO, LOCAL_VIDEO].find((v) => v.id === id),
  },
}));

const runAnalysis = vi.fn();
const hookState = { step: "idle" as string, progress: 0, message: "", gateReason: null as string | null };
vi.mock("@/hooks/useTeamIntelligence", () => ({
  useTeamIntelligence: () => ({
    state: hookState,
    isAnalyzing: false,
    isLoading: false,
    analysisResult: null,
    runAnalysis,
    reset: vi.fn(),
  }),
  useAllTeamAnalyses: () => ({ data: [] }),
}));

import { toast } from "sonner";
import TeamAnalysisPage from "@/pages/TeamAnalysisPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>,
  );
}

function analyzeButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(i18n.t("teamAnalysisPage.analyzeFullTeam"), "i") }) as HTMLButtonElement;
}

describe("TeamAnalysisPage · no-visual-input gate", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    runAnalysis.mockReset();
    vi.mocked(toast.success).mockReset();
    Object.assign(hookState, { step: "idle", progress: 0, message: "", gateReason: null });
  });

  function goToNewAnalysis() {
    fireEvent.click(screen.getByRole("button", { name: i18n.t("teamAnalysisPage.tabNewAnalysis") }));
  }

  it("a cloud-only video shows the reason and disables the analysis (no request)", () => {
    renderPage();
    goToNewAnalysis();
    fireEvent.click(screen.getByText(CLOUD_VIDEO.title));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("teamAnalysisPage.teamColorPlaceholder")), {
      target: { value: "rojo" },
    });

    const gate = screen.getByTestId("team-visual-input-gate");
    expect(gate).toHaveTextContent(i18n.t("teamAnalysisPage.noVisualInputTitle"));
    expect(gate).toHaveTextContent(i18n.t("teamAnalysisPage.noVisualInputCloud"));
    expect(analyzeButton()).toBeDisabled();
    fireEvent.click(analyzeButton());
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("a local video is not gated up front (only the coach declaration is still required)", () => {
    renderPage();
    goToNewAnalysis();
    fireEvent.click(screen.getByText(LOCAL_VIDEO.title));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("teamAnalysisPage.teamColorPlaceholder")), {
      target: { value: "rojo" },
    });
    expect(screen.queryByTestId("team-visual-input-gate")).toBeNull();
    // Owner decision (30 sep): the versioned declaration is required, never pre-ticked.
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(analyzeButton()).toBeDisabled();
    fireEvent.click(box);
    expect(analyzeButton()).not.toBeDisabled();
  });

  it("the declaration is unticked again when another video is selected", () => {
    renderPage();
    goToNewAnalysis();
    fireEvent.click(screen.getByText(LOCAL_VIDEO.title));
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText(CLOUD_VIDEO.title));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("a consent block from the server is shown as such (title + translated reason), not as a generic error", async () => {
    const { ClipConsentBlockedError } = await import("@/lib/shared/videoConsent");
    runAnalysis.mockImplementation(async () => {
      throw new ClipConsentBlockedError("attestation_required", "en");
    });
    renderPage();
    goToNewAnalysis();
    fireEvent.click(screen.getByText(LOCAL_VIDEO.title));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("teamAnalysisPage.teamColorPlaceholder")), {
      target: { value: "rojo" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(analyzeButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        i18n.t("clipConsent.blockedTitle"),
        expect.objectContaining({ description: expect.stringMatching(/declaration/i) }),
      ),
    );
  });

  it("a run blocked by the hook shows the gate reason instead of a report", async () => {
    const reason = "Sin fotogramas utilizables";
    runAnalysis.mockImplementation(async () => {
      // Same shape the real hook sets: message === gateReason on "blocked".
      Object.assign(hookState, { step: "blocked", progress: 0, message: reason, gateReason: reason });
      return null;
    });
    const { container } = renderPage();
    goToNewAnalysis();
    fireEvent.click(screen.getByText(LOCAL_VIDEO.title));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("teamAnalysisPage.teamColorPlaceholder")), {
      target: { value: "rojo" },
    });
    fireEvent.click(screen.getByRole("checkbox")); // coach declaration
    fireEvent.click(analyzeButton());

    await waitFor(() => expect(screen.getByTestId("team-visual-input-gate")).toHaveTextContent(reason));
    expect(runAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        localVideoSrc: LOCAL_VIDEO.localPath,
        attestation: { accepted: true, version: "2026-09-28.v1" },
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    // Still on the "new analysis" tab — no report view was opened.
    expect(screen.getByTestId("video-upload")).toBeInTheDocument();
    // Nothing is running: no progress panel / spinner, and the reason is shown
    // once (in the gate box), not repeated as a stuck progress message.
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  it("a running analysis still shows the progress panel", () => {
    Object.assign(hookState, { step: "analyzing", progress: 40, message: "Analizando…", gateReason: null });
    const { container } = renderPage();
    goToNewAnalysis();
    expect(screen.getByText("Analizando…")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-spin").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("team-visual-input-gate")).toBeNull();
  });
});
