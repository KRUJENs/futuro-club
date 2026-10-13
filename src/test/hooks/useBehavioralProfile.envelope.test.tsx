/**
 * useBehavioralProfile (P1 bloque 2).
 *  - El servidor devuelve { data: { playerId, profile: { scores, … } } }; antes se leía
 *    data.data.scores (no existe) y un perfil REAL nunca llegaba.
 *  - Fuera del demo, un fallo de la API ⇒ null («sin datos»), no un perfil de EJEMPLO que
 *    el IDP consumía como real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Fuera del demo, sea cual sea el .env.local de quien ejecute los tests.
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: async () => ({}) }));
vi.mock("@/services/real/behavioralProfileService", () => ({
  BehavioralProfileService: { getLatest: vi.fn(async () => null) },
}));

import { useBehavioralProfile } from "@/hooks/useBehavioralProfile";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
const SCORES = {
  decisionSpeed: 61, scanningIntelligence: 70, resilience: 55, clutchFactor: 50, leadership: 40,
  mentalFatigue: 30, unpredictability: 44, mentalComposite: 58, archetype: "architect",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useBehavioralProfile", () => {
  it("lee el perfil REAL del sobre del servidor (data.profile)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { playerId: "p1", profile: { id: "x", playerId: "p1", scores: SCORES, confidence: 0.7, videosAnalyzed: 2 } },
    }), { status: 200 }));
    const { result } = renderHook(() => useBehavioralProfile("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.scores.mentalComposite).toBe(58);
    expect(result.current.data?.source).not.toBe("mock");
  });

  it("sin perfil en el servidor ⇒ null", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { playerId: "p1", profile: null } }), { status: 200 }));
    const { result } = renderHook(() => useBehavioralProfile("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("API caída (fuera del demo) ⇒ null, NO un perfil de ejemplo", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const { result } = renderHook(() => useBehavioralProfile("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
