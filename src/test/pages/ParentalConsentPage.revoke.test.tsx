/**
 * /admin/consent · Revocar (PR #308 ronda 6 + P1 bloque 0).
 *
 * - La retirada se hace PRIMERO en el servidor (POST /api/auth/withdraw-consent). Si falla,
 *   error y NO se toca el rótulo del jugador.
 * - Si el servidor retira pero falla el rótulo (players.update), NO se dice «error al
 *   registrar»: aviso específico (la retirada vale) y se refresca la lista.
 * Supabase y fetch están simulados (mock), no es la base de datos real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import esJson from "@/i18n/es.json";

vi.mock("react-i18next", async () => {
  const es = (await import("@/i18n/es.json")).default as Record<string, unknown>;
  const lookup = (k: string) => k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], es);
  return {
    useTranslation: () => ({
      t: (k: string) => (typeof lookup(k) === "string" ? (lookup(k) as string) : k),
      i18n: { language: "es" },
    }),
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const sb = vi.hoisted(() => ({ updateError: null as null | { message: string }, updates: 0, playerReads: 0, auditInserts: [] as string[] }));

vi.mock("@/lib/supabase", () => ({
  SUPABASE_CONFIGURED: true,
  supabase: {
    rpc: vi.fn(),
    from: (table: string) => {
      if (table === "players") {
        return {
          select: () => ({
            not: () => ({
              order: async () => {
                sb.playerReads++;
                return {
                  data: [{
                    id: "p-minor-1",
                    name: "Lucas Menor",
                    birth_date: "2015-03-01",
                    parental_consent_status: "granted",
                    parental_consent_granted_at: "2026-10-01T00:00:00Z",
                    parental_consent_guardian_name: "Tutor",
                    parental_consent_guardian_email: "tutor@x.test",
                  }],
                  error: null,
                };
              },
            }),
          }),
          update: () => ({
            eq: async () => {
              sb.updates++;
              return { error: sb.updateError };
            },
          }),
        };
      }
      // consent_audit_log
      return {
        select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        insert: async (row: { action: string }) => {
          sb.auditInserts.push(row.action);
          return { error: null };
        },
      };
    },
  },
}));
vi.mock("@/lib/apiAuth", () => ({
  getAuthHeaders: async () => ({ "Content-Type": "application/json", Authorization: "Bearer coach-jwt" }),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1", email: "coach@test" } }) }));

import ParentalConsentPage from "@/pages/ParentalConsentPage";

const P = (esJson as unknown as {
  parentalConsentPage: { toast: Record<string, string>; tabs: Record<string, string>; list: Record<string, string>; form: Record<string, string> };
}).parentalConsentPage;

let fetchMock: ReturnType<typeof vi.fn>;
let withdrawStatus = 200;

beforeEach(() => {
  sb.updateError = null;
  sb.updates = 0;
  sb.playerReads = 0;
  sb.auditInserts = [];
  withdrawStatus = 200;
  Object.values(toastMock).forEach((f) => f.mockReset());
  fetchMock = vi.fn(async () =>
    withdrawStatus === 200
      ? new Response(JSON.stringify({ success: true, data: { withdrawn: 1 } }), { status: 200 })
      : new Response(JSON.stringify({ success: false, error: "x" }), { status: withdrawStatus }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function revoke() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParentalConsentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText(new RegExp(P.tabs.granted)));
  fireEvent.click(await screen.findByText(P.list.revoke));
  // El formulario se abre con «revocar» preseleccionado para un jugador concedido.
  const readsBeforeSubmit = sb.playerReads;
  fireEvent.click(await screen.findByText(P.form.registerDenial));
  return readsBeforeSubmit;
}

describe("/admin/consent · revocar", () => {
  it("revoca: primero el servidor, luego el rótulo, y avisa de éxito", async () => {
    await revoke();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(P.toast.consentSuccess));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/withdraw-consent", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ playerId: "p-minor-1" });
    expect(sb.updates).toBe(1);
  });

  it("si el servidor NO retira → error y el rótulo no se toca", async () => {
    withdrawStatus = 500;
    await revoke();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(P.toast.consentError));
    expect(sb.updates).toBe(0);
    expect(sb.auditInserts).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("el servidor retira pero falla el rótulo → aviso específico (no «error al registrar») y se refresca la lista", async () => {
    sb.updateError = { message: "rls" };
    const readsBefore = await revoke();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith(P.toast.withdrawnLabelError));
    expect(toastMock.error).not.toHaveBeenCalled();
    await waitFor(() => expect(sb.playerReads).toBeGreaterThan(readsBefore));
    // La revocación queda en el historial de la pantalla aunque falle el rótulo, y el
    // formulario se cierra (no hay nada que reintentar).
    expect(sb.auditInserts).toEqual(["consent_denied"]);
    await waitFor(() => expect(screen.queryByText(P.form.registerDenial)).toBeNull());
  });
});
