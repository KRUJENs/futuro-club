/**
 * Tests for useTeamIntelligence hook — initial states, Gemini observation
 * forwarding (response contract) and the no-visual-input gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: [], error: null })),
          })),
        })),
      })),
    })),
  },
  SUPABASE_CONFIGURED: false,
}));

vi.mock("@/lib/apiAuth", () => ({
  getAuthHeaders: vi.fn(async () => ({ "Content-Type": "application/json" })),
}));

vi.mock("@/lib/localVideoUtils", () => ({
  isLocalSrc: vi.fn(() => false),
  readVideoAsBase64: vi.fn(async () => null),
  extractKeyframesFromVideo: vi.fn(async () => []),
  getOptimalFrameCount: vi.fn(() => 8),
}));

import { useTeamIntelligence } from "@/hooks/useTeamIntelligence";
import { isLocalSrc, readVideoAsBase64, extractKeyframesFromVideo } from "@/lib/localVideoUtils";
import { NO_VISUAL_INPUT } from "@/lib/shared/teamVisualInput";
import i18n from "@/i18n";

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe("useTeamIntelligence", () => {
  it("initializes with idle state", () => {
    const { result } = renderHook(() => useTeamIntelligence(), {
      wrapper: createWrapper(),
    });
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.progress).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it("report starts as null", () => {
    const { result } = renderHook(() => useTeamIntelligence(), {
      wrapper: createWrapper(),
    });
    expect(result.current.analysisResult).toBeNull();
  });

  it("exposes runTeamAnalysis function", () => {
    const { result } = renderHook(() => useTeamIntelligence(), {
      wrapper: createWrapper(),
    });
    expect(typeof result.current.runAnalysis).toBe("function");
  });

  it("exposes reset function", () => {
    const { result } = renderHook(() => useTeamIntelligence(), {
      wrapper: createWrapper(),
    });
    expect(typeof result.current.reset).toBe("function");
  });

  it("reset returns to idle", () => {
    const { result } = renderHook(() => useTeamIntelligence(), {
      wrapper: createWrapper(),
    });
    result.current.reset();
    expect(result.current.state.step).toBe("idle");
    expect(result.current.analysisResult).toBeNull();
  });
});

// ── Network fakes ────────────────────────────────────────────────────────────

const REPORT = { videoId: "v1", formacion: { sistema: "4-3-3", variantes: [], rigidez: 5 }, confianza: 0.6 };
const OBSERVATIONS = { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" };

/** Minimal fetch Response whose body streams the given SSE text. */
function sseResponse(sse: string) {
  const bytes = new TextEncoder().encode(sse);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        releaseLock: () => {},
      }),
    },
    text: async () => sse,
    json: async () => ({}),
  };
}

function jsonResponse(payload: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => payload, text: async () => JSON.stringify(payload) };
}

const COMPLETE_SSE = `event: complete\ndata: ${JSON.stringify({ report: REPORT })}\n\n`;

type FetchCall = [string, { body?: string }];

describe("useTeamIntelligence · data flow", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(isLocalSrc).mockReturnValue(false);
    vi.mocked(readVideoAsBase64).mockResolvedValue(null);
    vi.mocked(extractKeyframesFromVideo).mockResolvedValue([]);
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes("team-observation")) {
        // Real contract: successResponse → { ok, success, data: { observations } }
        return jsonResponse({ ok: true, success: true, data: { observations: OBSERVATIONS } });
      }
      return sseResponse(COMPLETE_SSE);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(isLocalSrc).mockReset();
    vi.mocked(readVideoAsBase64).mockReset();
    vi.mocked(extractKeyframesFromVideo).mockReset();
  });

  function intelligenceCalls(): FetchCall[] {
    return (fetchMock.mock.calls as FetchCall[]).filter(([u]) => u.includes("team-intelligence"));
  }

  it("forwards the Gemini observation read from data.observations (was always dropped)", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(readVideoAsBase64).mockResolvedValue({ base64: "AAAA", mediaType: "video/mp4" } as never);

    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    let out: unknown;
    await act(async () => {
      out = await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local" });
    });

    expect(out).toEqual(REPORT);
    const calls = intelligenceCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body ?? "{}");
    expect(body.geminiObservations).toEqual(OBSERVATIONS);
    expect(body.keyframes).toEqual([]);
    // With a real observation there is no need to fall back to frames.
    expect(extractKeyframesFromVideo).not.toHaveBeenCalled();
  });

  it("never returns (nor saves) per-player rows with an LLM-guessed dorsal (identidad.md)", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(readVideoAsBase64).mockResolvedValue({ base64: "AAAA", mediaType: "video/mp4" } as never);
    const legacy = {
      ...REPORT,
      jugadores: [{ dorsalEstimado: "7", posicion: "extremo", pases: { completados: 8, fallados: 2 }, duelos: { ganados: 2, perdidos: 1 }, recuperaciones: 1 }],
    };
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("team-observation")
        ? jsonResponse({ ok: true, success: true, data: { observations: OBSERVATIONS } })
        : sseResponse(`event: complete\ndata: ${JSON.stringify({ report: legacy })}\n\n`),
    );

    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    const run: { out: Record<string, unknown> | null } = { out: null };
    await act(async () => {
      run.out = (await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local" })) as Record<string, unknown> | null;
    });

    expect(run.out).not.toBeNull();
    expect(run.out?.jugadores).toBeUndefined();
    expect(JSON.stringify(run.out)).not.toContain("dorsalEstimado");
    expect(run.out?.identityWithheld).toEqual({ perPlayerRows: 1, texts: 0 });
    expect(result.current.analysisResult).toEqual(run.out);
    // The request carries no YOLO track payload any more (it only served the
    // index-based track → "player" heat-map pairing).
    const body = JSON.parse(intelligenceCalls()[0][1].body ?? "{}");
    expect(body).not.toHaveProperty("yoloTrackData");
  });

  it("blocks a cloud-only (Bunny) video: no request, no report, a gate reason", async () => {
    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    let out: unknown = "unset";
    await act(async () => {
      out = await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: undefined });
    });

    expect(out).toBeNull();
    expect(intelligenceCalls()).toHaveLength(0);
    expect(result.current.analysisResult).toBeNull();
    expect(result.current.state.step).toBe("blocked");
    expect(result.current.state.gateReason).toBe(i18n.t("teamAnalysisPage.noVisualInputCloud"));
    expect(result.current.state.gateReason).toBeTruthy();
  });

  it("maps the server refusal (SSE error code NO_VISUAL_INPUT) to the gate, not to an error", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(extractKeyframesFromVideo).mockResolvedValue([
      { url: "blob:not-readable-by-the-server", timestamp: 0, frameIndex: 0 },
    ] as never);
    fetchMock.mockImplementation(async () =>
      sseResponse(`event: error\ndata: ${JSON.stringify({ message: "Sin entrada visual", code: NO_VISUAL_INPUT })}\n\n`),
    );

    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    let out: unknown = "unset";
    await act(async () => {
      out = await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local" });
    });

    expect(out).toBeNull();
    expect(result.current.state.step).toBe("blocked");
    expect(result.current.state.gateReason).toBe(i18n.t("teamAnalysisPage.noVisualInputReason"));
    expect(result.current.analysisResult).toBeNull();
  });

  it("other server errors still surface as errors", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(extractKeyframesFromVideo).mockResolvedValue([
      { url: "data:image/jpeg;base64,AAAA", timestamp: 0, frameIndex: 0 },
    ] as never);
    fetchMock.mockImplementation(async () =>
      sseResponse(`event: error\ndata: ${JSON.stringify({ message: "Error de Claude API: 500" })}\n\n`),
    );

    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    await act(async () => {
      await expect(
        result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local" }),
      ).rejects.toThrow("Error de Claude API: 500");
    });
    expect(result.current.state.step).toBe("error");
  });

  // ── Coach declaration (owner decision, 30 sep · src/lib/shared/videoConsent) ──
  const ATTESTATION = { accepted: true as const, version: "2026-09-28.v1" as const };
  const consentError = (code: string) =>
    jsonResponse({ ok: false, success: false, error: "x", errorDetail: { message: "x", code } }, false);

  it("sends the ticked declaration (and the client video id) to team-observation AND team-intelligence", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(readVideoAsBase64).mockResolvedValue({ base64: "AAAA", mediaType: "video/mp4" } as never);
    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local", attestation: ATTESTATION });
    });
    const obsBody = JSON.parse(((fetchMock.mock.calls as FetchCall[]).find(([u]) => u.includes("team-observation"))![1].body) ?? "{}");
    expect(obsBody).toMatchObject({ attestation: ATTESTATION, videoId: "v1" });
    expect(JSON.parse(intelligenceCalls()[0][1].body ?? "{}")).toMatchObject({ attestation: ATTESTATION, videoId: "v1" });
  });

  it("a consent block on team-observation does NOT fall back to frames nor call team-intelligence", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(readVideoAsBase64).mockResolvedValue({ base64: "AAAA", mediaType: "video/mp4" } as never);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("team-observation") ? consentError("attestation_required") : sseResponse(COMPLETE_SSE),
    );
    const { clipConsentGateReason } = await import("@/lib/shared/videoConsent");
    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    await act(async () => {
      await expect(
        result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local" }),
      ).rejects.toThrow(clipConsentGateReason(i18n.language, "attestation_required"));
    });
    expect(extractKeyframesFromVideo).not.toHaveBeenCalled();
    expect(intelligenceCalls()).toHaveLength(0);
    expect(result.current.state.step).toBe("error");
    expect(result.current.analysisResult).toBeNull();
  });

  it("a consent block on team-intelligence (before the stream) surfaces its translated reason", async () => {
    vi.mocked(isLocalSrc).mockReturnValue(true);
    vi.mocked(extractKeyframesFromVideo).mockResolvedValue([
      { url: "data:image/jpeg;base64,AAAA", timestamp: 0, frameIndex: 0 },
    ] as never);
    fetchMock.mockImplementation(async () => consentError("consent_check_failed"));
    const { ClipConsentBlockedError } = await import("@/lib/shared/videoConsent");
    const { result } = renderHook(() => useTeamIntelligence(), { wrapper: createWrapper() });
    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.runAnalysis({ videoId: "v1", teamColor: "rojo", localVideoSrc: "blob:local", attestation: ATTESTATION });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ClipConsentBlockedError);
    expect((caught as { code: string }).code).toBe("consent_check_failed");
  });
});
