/**
 * usePlayerAnalysisV2 · declaración del entrenador + consentimiento parental (decisión del
 * owner, 30 sep · src/lib/shared/videoConsent). La UI (VitasLab) marca la declaración; el
 * hook solo la reenvía a finalize / generate-reports, y un bloqueo del servidor:
 *   - se lanza como ClipConsentBlockedError con el motivo traducido;
 *   - NUNCA cae a otra ruta de análisis (antes generate-reports fallido → finalize) ni se
 *     presenta como "biomecánica guardada" (completado parcial).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/apiAuth", () => ({
  getAuthHeaders: vi.fn(async () => ({ "Content-Type": "application/json", Authorization: "Bearer t" })),
}));
vi.mock("@/lib/demoMode", () => ({ IS_DEMO: false }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    upsert: () => chain,
    select: () => chain,
    single: async () => ({ data: { id: "an-1" }, error: null }),
  });
  return { supabase: { from: () => chain }, SUPABASE_CONFIGURED: true };
});
vi.mock("tus-js-client", () => ({ Upload: vi.fn() }));

import i18n from "@/i18n";
import { usePlayerAnalysisV2 } from "@/hooks/usePlayerAnalysisV2";
import { ClipConsentBlockedError, clipConsentGateReason } from "@/lib/shared/videoConsent";

const ATTESTATION = { accepted: true as const, version: "2026-09-28.v1" as const };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const consentError = (status: number, code: string) =>
  json(status, { ok: false, success: false, error: "x", errorDetail: { message: "x", code } });

let fetchMock: ReturnType<typeof vi.fn>;
const callsTo = (p: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(p));
const bodyOf = (p: string, i = 0) => JSON.parse(String((callsTo(p)[i][1] as RequestInit).body));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("analyzeExistingVideo (re-análisis de un vídeo ya subido)", () => {
  it("manda la declaración a finalize; un 403 parental para el flujo con su motivo, sin sondear", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/analyses/by-video")) return json(200, { success: true, data: { analysis: null } });
      if (url === "/api/videos/finalize") return consentError(403, "parental_consent_required");
      throw new Error(`unexpected ${url}`);
    });
    const { result } = renderHook(() => usePlayerAnalysisV2());
    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.analyzeExistingVideo({ videoId: "v1", bunnyVideoId: "v1", playerId: "p1", attestation: ATTESTATION });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ClipConsentBlockedError);
    expect(bodyOf("/api/videos/finalize").attestation).toEqual(ATTESTATION);
    expect(callsTo("/api/videos/finalize")).toHaveLength(1); // no reintenta 12 veces
    expect(callsTo("/api/analyses/by-video")).toHaveLength(1); // solo la comprobación inicial
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe(clipConsentGateReason(i18n.language, "parental_consent_required"));
  });
});

describe("analyzeWithClientData (tracking del navegador → generate-reports)", () => {
  it("manda la declaración; un bloqueo NO cae a finalize ni se presenta como 'biomecánica guardada'", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/analyses/generate-reports") return consentError(400, "attestation_required");
      throw new Error(`unexpected ${url}`);
    });
    const { result } = renderHook(() => usePlayerAnalysisV2());
    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.analyzeWithClientData({
          videoId: "v1",
          playerId: "p1",
          biomechanics: { drillScore: 1 },
          attestation: ATTESTATION,
        });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ClipConsentBlockedError);
    expect(bodyOf("/api/analyses/generate-reports").attestation).toEqual(ATTESTATION);
    expect(callsTo("/api/videos/finalize")).toHaveLength(0);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe(clipConsentGateReason(i18n.language, "attestation_required"));
    expect(result.current.isCompleted).toBe(false);
  });
});
