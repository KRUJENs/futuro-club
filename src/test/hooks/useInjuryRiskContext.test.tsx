/**
 * P1 bloque 4b · useInjuryRisk manda al calculador el contexto REAL del jugador:
 * el offset PHV de la puerta (useRawPlayerById ya lo sanea) y la edad decimal.
 * Antes mandaba `age: null` (el esquema lo rechazaba: 400) y la maduración de un
 * informe de fatiga guardado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: async () => ({ Authorization: "Bearer t" }) }));
vi.mock("@/hooks/usePlayers", () => ({
  useRawPlayerById: () => ({ data: { id: "p1", phvOffset: -0.4, birthDate: "2013-04-10", age: 13 }, isLoading: false }),
}));
vi.mock("@/services/real/playerTrackingService", () => ({
  PlayerTrackingService: { get: () => null, getFatigueHistory: async () => [] },
}));

import { useInjuryRisk } from "@/hooks/useInjuryRisk";

let calcBody: Record<string, unknown> | null;
beforeEach(() => {
  calcBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/injuries/list")) return Response.json({ success: true, data: [] });
      if (String(url).includes("/api/agents/injury-risk-calculator")) {
        calcBody = JSON.parse(String(init?.body));
        return Response.json({ success: true, data: { report: null } });
      }
      throw new Error(`fetch no simulado: ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("useInjuryRisk · contexto del jugador", () => {
  it("manda el offset de la puerta y la edad decimal; sin categoría ni maduración de un informe guardado", async () => {
    renderHook(() => useInjuryRisk("p1"), { wrapper });
    await waitFor(() => expect(calcBody).not.toBeNull());
    expect(calcBody!.phvOffset).toBe(-0.4);
    expect(typeof calcBody!.age).toBe("number");
    expect(calcBody!.age as number).toBeGreaterThan(13); // decimal desde la fecha de nacimiento, no el entero
    expect(calcBody).not.toHaveProperty("phvCategory");
    // Sin informe de fatiga guardado no hay carga ni fatiga (nunca un valor por defecto).
    expect(calcBody!.acwrZone).toBeNull();
    expect(calcBody!.fatigueIndex).toBeNull();
  });
});
