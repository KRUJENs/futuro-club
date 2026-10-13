/**
 * /admin/consent · estado REAL del tutor + pedir la firma + retirar (P1 bloque 3).
 *
 * Antes la pantalla leía y escribía players.parental_consent_status: «Autorizar» ponía el rótulo
 * «concedido» sin el tutor (y el gate de análisis nunca lo contó), y «Solicitar de nuevo» solo
 * cambiaba ese rótulo. Ahora:
 *   - el estado sale del servidor (/api/auth/consent-status);
 *   - «Pedir firma» manda de verdad el correo al tutor (/api/auth/sign-consent: solo nombre y email;
 *     el DNI lo escribe el tutor al confirmar);
 *   - «Retirar» lo hace el servidor (/api/auth/withdraw-consent); si falla, no se dice «retirado»;
 *   - la pantalla NUNCA escribe en players.
 * Supabase y fetch simulados (mock), no es la base de datos real.
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
      t: (k: string, o?: Record<string, unknown>) => {
        const v = lookup(k);
        return typeof v === "string" ? v.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(o?.[n] ?? "")) : k;
      },
      i18n: { language: "es" },
    }),
    initReactI18next: { type: "3rdParty", init: () => {} },
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));

const sb = vi.hoisted(() => ({ playerWrites: 0, auditInserts: [] as string[] }));

vi.mock("@/lib/supabase", () => ({
  SUPABASE_CONFIGURED: true,
  supabase: {
    rpc: vi.fn(),
    from: (table: string) => {
      if (table === "players") {
        return {
          select: () => ({
            not: () => ({
              order: async () => ({
                data: [{ id: "p-minor-1", name: "Lucas Menor", birth_date: `${new Date().getUTCFullYear() - 11}-03-01` }],
                error: null,
              }),
            }),
          }),
          update: () => {
            sb.playerWrites++;
            return { eq: async () => ({ error: null }) };
          },
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

const G = (esJson as unknown as { guardianConsent: { state: Record<string, string>; actions: Record<string, string>; form: Record<string, string>; errors: Record<string, string>; withdrawn: string } }).guardianConsent;
const P = (esJson as unknown as { parentalConsentPage: { tabs: Record<string, string> } }).parentalConsentPage;

let consentState: Record<string, unknown>;
let withdrawStatus = 200;
let fetchMock: ReturnType<typeof vi.fn>;
const bodyOf = (path: string) => {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === path);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
};

beforeEach(() => {
  sb.playerWrites = 0;
  sb.auditInserts = [];
  withdrawStatus = 200;
  consentState = { state: "verified", guardianName: "Tutor Uno", guardianEmail: "tutor@x.test", verifiedAt: "2026-10-01T00:00:00Z" };
  Object.values(toastMock).forEach((f) => f.mockReset());
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/auth/consent-status") {
      return Response.json({ success: true, data: { statuses: { "p-minor-1": consentState } } });
    }
    if (url === "/api/auth/withdraw-consent") {
      return withdrawStatus === 200
        ? Response.json({ success: true, data: { withdrawn: 1 } })
        : Response.json({ success: false, error: "x" }, { status: withdrawStatus });
    }
    if (url === "/api/auth/sign-consent") {
      return Response.json({ success: true, data: { emailSent: true, status: "pending_verification" } });
    }
    throw new Error(`fetch no simulado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ParentalConsentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("/admin/consent · estado real del servidor", () => {
  it("«Confirmado» sale del servidor (no de un rótulo) y la pantalla nunca escribe en players", async () => {
    renderPage();
    fireEvent.click(await screen.findByText(new RegExp(P.tabs.granted)));
    expect(await screen.findByText(G.state.verified)).toBeInTheDocument();
    expect(screen.getByText(/tutor@x\.test/)).toBeInTheDocument();
    expect(bodyOf("/api/auth/consent-status")).toEqual({ playerIds: ["p-minor-1"] });
    expect(sb.playerWrites).toBe(0);
  });
});

describe("/admin/consent · retirar", () => {
  it("retira en el SERVIDOR, lo anota y avisa; ningún rótulo", async () => {
    renderPage();
    fireEvent.click(await screen.findByText(new RegExp(P.tabs.granted)));
    fireEvent.click(await screen.findByText(G.actions.withdraw));
    fireEvent.click(await screen.findByText(G.actions.withdrawConfirm));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(G.withdrawn));
    expect(bodyOf("/api/auth/withdraw-consent")).toEqual({ playerId: "p-minor-1" });
    expect(sb.auditInserts).toEqual(["consent_revoked"]);
    expect(sb.playerWrites).toBe(0);
  });

  it("si el servidor NO retira → error, sin anotar «retirado»", async () => {
    withdrawStatus = 500;
    renderPage();
    fireEvent.click(await screen.findByText(new RegExp(P.tabs.granted)));
    fireEvent.click(await screen.findByText(G.actions.withdraw));
    fireEvent.click(await screen.findByText(G.actions.withdrawConfirm));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(G.errors.withdraw));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(sb.auditInserts).toEqual([]);
  });
});

describe("/admin/consent · pedir la firma al tutor", () => {
  it("sin solicitud: «Pedir firma» manda el correo de verdad con SOLO nombre y email (sin DNI)", async () => {
    consentState = { state: "none" };
    renderPage();
    fireEvent.click(await screen.findByText(G.actions.request));
    expect(document.querySelector('input[type="email"]')).not.toBeNull();
    // El DNI lo escribe el TUTOR al confirmar, nunca el responsable aquí.
    expect(screen.queryByLabelText(/DNI/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(G.form.nameLabel), { target: { value: "Marta Tutora" } });
    fireEvent.change(screen.getByLabelText(G.form.emailLabel), { target: { value: "marta@familia.test" } });
    fireEvent.click(screen.getByText(G.form.submit));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(bodyOf("/api/auth/sign-consent")).toMatchObject({ playerId: "p-minor-1", parentName: "Marta Tutora", parentEmail: "marta@familia.test" });
    expect(Object.keys(bodyOf("/api/auth/sign-consent"))).not.toContain("parentDni");
    expect(sb.auditInserts).toEqual(["consent_requested"]);
    expect(sb.playerWrites).toBe(0);
  });

  it("retirado → «Pedir de nuevo» también manda el correo (antes solo cambiaba el rótulo)", async () => {
    consentState = { state: "withdrawn", guardianName: "Tutor Uno", withdrawnAt: "2026-10-02T00:00:00Z" };
    renderPage();
    fireEvent.click(await screen.findByText(new RegExp(P.tabs.denied)));
    fireEvent.click(await screen.findByText(G.actions.requestAgain));
    fireEvent.change(screen.getByLabelText(G.form.emailLabel), { target: { value: "tutor@x.test" } });
    fireEvent.click(screen.getByText(G.form.submit));
    await waitFor(() => expect(bodyOf("/api/auth/sign-consent")).not.toBeNull());
    expect(sb.playerWrites).toBe(0);
  });
});
