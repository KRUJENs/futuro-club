/**
 * useDropoutRisk fuera del demo (P1 bloque 2, inv #2).
 *  - Sin ninguna señal real el servidor responde `source: "insufficient_data"` con un
 *    relleno (riesgo 0 · «low» · asistencia 0). Antes se pintaba tal cual: cada menor
 *    «riesgo 0, bajo, asistencia 0 %». Ahora es null = sin calcular.
 *  - Si la llamada falla, antes salía una evaluación de EJEMPLO por hash del id para un
 *    jugador real. Ahora es null.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// Fuera del demo, sea cual sea el .env.local de quien ejecute los tests.
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: vi.fn(async () => ({})) }));

import { useDropoutRisk } from "@/hooks/useWellbeing";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

// Forma real del relleno del servidor (api/_lib/dropoutAssessment.ts · insufficientAssessment).
const PLACEHOLDER = {
  playerId: "p1", riskScore: 0, riskLevel: "low", primaryFactor: "insufficient_data",
  attendance: { rate: 0, consecutiveAbsences: 0, recentTrend: "stable" },
};

function respond(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

async function riskFor(id: string) {
  const { result } = renderHook(() => useDropoutRisk(id), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

afterEach(() => vi.restoreAllMocks());

describe("useDropoutRisk (fuera del demo)", () => {
  it("source insufficient_data ⇒ null (sin calcular), no el relleno 0 · «low»", async () => {
    respond({ success: true, data: { assessment: PLACEHOLDER, source: "insufficient_data" } });
    expect(await riskFor("a1")).toBeNull();
  });

  it("source computed ⇒ la evaluación real, sin rótulo de ejemplo", async () => {
    respond({ success: true, data: { assessment: { ...PLACEHOLDER, riskScore: 42, riskLevel: "moderate", primaryFactor: "attendanceDecline" }, source: "computed" } });
    const r = await riskFor("a2");
    expect(r).toMatchObject({ riskScore: 42, riskLevel: "moderate", isMock: false });
  });

  it("HTTP 500 ⇒ null (antes: evaluación de ejemplo por hash del id)", async () => {
    respond({ success: false }, 500);
    expect(await riskFor("a3")).toBeNull();
  });

  it("error de red ⇒ null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await riskFor("a4")).toBeNull();
  });
});
