/**
 * TeamBaselinePage y CompareRivalPage → /api/agents/video-observation (llamadas de USUARIO)
 * con el gate de consentimiento (decisión del owner, 30 sep):
 *   - la petición identifica el vídeo GUARDADO (`videoId`) para que el servidor compruebe
 *     propiedad, URL y la declaración que se marcó al subirlo en VideoUpload;
 *   - la página no fabrica una declaración (no manda `attestation`): la del vídeo basta;
 *   - un bloqueo se muestra con su motivo traducido (no un error genérico).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";

vi.mock("@/lib/demoMode", () => ({ IS_DEMO: false, DEMO_USER: { id: "demo" } }));
vi.mock("framer-motion", () => {
  const cache = new Map<string, (p: { children?: React.ReactNode } & Record<string, unknown>) => JSX.Element>();
  const motion = new Proxy({}, {
    get: (_t, prop: string) => {
      if (!cache.has(prop)) {
        cache.set(prop, ({ children, ...props }) => {
          const { animate: _a, transition: _tr, initial: _i, exit: _e, ...rest } = props;
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag {...rest}>{children}</Tag>;
        });
      }
      return cache.get(prop);
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })) }));

const CLIP = { id: "guid-clip-1", title: "Clip", status: "finished", duration: 60, embedUrl: "", streamUrl: "https://cdn.test/guid-clip-1/playlist.m3u8" };
const CLIP_URL = "https://cdn.test/guid-clip-1/play_720p.mp4";
vi.mock("@/services/real/videoService", () => ({
  VideoService: { getById: (id: string) => (id === CLIP.id ? CLIP : null), getAll: () => [CLIP] },
  getServerVideoUrl: () => ({ url: CLIP_URL, reason: null }),
}));
vi.mock("@/components/VideoUpload", () => ({
  default: ({ onDone }: { onDone?: (id: string, info: { durationSec: number | null }) => void }) => (
    <button type="button" data-testid="stub-upload" onClick={() => onDone?.(CLIP.id, { durationSec: 60 })}>
      stub upload
    </button>
  ),
}));

import { toast } from "sonner";
import TeamBaselinePage from "@/pages/TeamBaselinePage";
import CompareRivalPage from "@/pages/CompareRivalPage";
import { clipConsentGateReason } from "@/lib/shared/videoConsent";

const fetchMock = vi.fn();
const observationCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/agents/video-observation");

function respondObservation(res: () => Response) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === "/api/agents/video-observation") return res();
    if (u.startsWith("/api/match/list")) return new Response(JSON.stringify({ success: true, data: { jobs: [] } }), { status: 200 });
    return new Response("{}", { status: 500 });
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  fetchMock.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGES = [
  ["TeamBaselinePage", () => <TeamBaselinePage />],
  ["CompareRivalPage", () => <CompareRivalPage />],
] as const;

describe.each(PAGES)("%s · video-observation con consentimiento", (_name, Page) => {
  it("manda el videoId del vídeo guardado y NO fabrica una declaración", async () => {
    respondObservation(() => new Response(JSON.stringify({ success: true, data: { observations: { resumenGeneral: "ok" } } }), { status: 200 }));
    render(<MemoryRouter><Page /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("stub-upload"));
    await waitFor(() => expect(observationCalls()).toHaveLength(1));
    const body = JSON.parse(String((observationCalls()[0][1] as RequestInit).body));
    expect(body).toMatchObject({ videoId: CLIP.id, videoUrl: CLIP_URL, analysisScope: "team" });
    expect(body).not.toHaveProperty("attestation");
  });

  it("bloqueo (403 menor sin consentimiento) → se muestra el motivo traducido", async () => {
    respondObservation(() =>
      new Response(
        JSON.stringify({ ok: false, success: false, error: "x", errorDetail: { message: "x", code: "parental_consent_required" } }),
        { status: 403 },
      ),
    );
    render(<MemoryRouter><Page /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("stub-upload"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(clipConsentGateReason("es", "parental_consent_required")),
    );
  });
});
