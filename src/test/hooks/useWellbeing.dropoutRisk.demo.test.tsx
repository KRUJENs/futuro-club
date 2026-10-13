/**
 * useDropoutRisk EN el demo: la red está interceptada (`data: null`) y se sigue
 * mostrando la evaluación de ejemplo, marcada isMock ⇒ con el rótulo «Datos de ejemplo».
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: true }));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: vi.fn(async () => ({})) }));

import { useDropoutRisk } from "@/hooks/useWellbeing";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

afterEach(() => vi.restoreAllMocks());

describe("useDropoutRisk (demo)", () => {
  it("respuesta interceptada `data: null` ⇒ evaluación de ejemplo con isMock (rótulo visible)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: null, _demo: true }), { status: 200 }),
    );
    const { result } = renderHook(() => useDropoutRisk("demo-a"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).not.toBeNull();
    expect(result.current.data!.isMock).toBe(true);
  });
});
