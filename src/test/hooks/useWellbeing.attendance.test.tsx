/**
 * useAttendance fuera del demo (P1 bloque 2).
 *  - Sin registros ⇒ perfil vacío con rate null; antes un calendario de EJEMPLO sin banner.
 *  - Con registros ⇒ % de 0 a 100; antes una fracción 0-1 que el calendario pintaba como «1%».
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// Fuera del demo, sea cual sea el .env.local de quien ejecute los tests.
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));
const db = vi.hoisted(() => ({ records: [] as unknown[] }));
vi.mock("@/services/real/wellbeingService", () => ({
  WellbeingService: { getAttendance: vi.fn(async () => db.records) },
}));

import { useAttendance } from "@/hooks/useWellbeing";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("useAttendance (fuera del demo)", () => {
  it("sin registros ⇒ perfil vacío con rate null (no un calendario de ejemplo)", async () => {
    db.records = [];
    const { result } = renderHook(() => useAttendance("p1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({ rate: null, totalSessions: 0, records: [], isMock: false });
  });

  it("con registros ⇒ % de 0 a 100", async () => {
    db.records = [
      { playerId: "p1", date: "2026-10-03", status: "present" },
      { playerId: "p1", date: "2026-10-02", status: "absent" },
      { playerId: "p1", date: "2026-10-01", status: "present" },
      { playerId: "p1", date: "2026-09-30", status: "present" },
    ];
    const { result } = renderHook(() => useAttendance("p2"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.rate).toBe(75);
    expect(result.current.data?.isMock).toBeFalsy();
  });
});
