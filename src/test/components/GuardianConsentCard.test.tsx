/**
 * Tarjeta «Consentimiento del tutor» de la ficha (P1 bloque 3). Antes un menor de 14 con fecha de
 * nacimiento quedaba sin análisis de vídeo y sin forma de pedir la firma desde la app.
 *   - solo para un menor de 14 CONOCIDO (misma regla que el gate); nada para ≥14 o sin fecha;
 *   - estado del servidor; pedir la firma con SOLO nombre y email del tutor; retirar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/lib/demoMode", async (orig) => ({ ...(await orig<typeof import("@/lib/demoMode")>()), IS_DEMO: false }));

const h = vi.hoisted(() => ({
  status: undefined as undefined | Record<string, unknown>,
  requested: [] as unknown[],
  withdrawn: [] as unknown[],
  lastStatusIds: [] as string[],
}));
vi.mock("@/hooks/useParentalConsent", () => ({
  useConsentStatus: (ids: string[]) => {
    h.lastStatusIds = ids;
    return { data: ids.length && h.status ? { [ids[0]]: h.status } : undefined, isLoading: false };
  },
  useRequestGuardianSignature: () => ({
    isPending: false,
    mutateAsync: async (v: unknown) => (h.requested.push(v), { emailSent: true }),
  }),
  useWithdrawGuardianConsent: () => ({
    isPending: false,
    mutateAsync: async (v: unknown) => (h.withdrawn.push(v), 1),
  }),
}));

import { GuardianConsentCard } from "@/components/legal/GuardianConsentCard";

const minorBirth = `${new Date().getUTCFullYear() - 10}-01-01`;
const adultBirth = `${new Date().getUTCFullYear() - 16}-01-01`;

beforeEach(() => {
  h.status = undefined;
  h.requested = [];
  h.withdrawn = [];
  h.lastStatusIds = [];
});

describe("GuardianConsentCard", () => {
  it("≥14 o sin fecha de nacimiento → no se muestra (ni se consulta)", () => {
    const { container: a } = render(<GuardianConsentCard playerId="p1" playerName="Iker" birthDate={adultBirth} />);
    expect(a.innerHTML).toBe("");
    const { container: b } = render(<GuardianConsentCard playerId="p1" playerName="Iker" birthDate={null} />);
    expect(b.innerHTML).toBe("");
    expect(h.lastStatusIds).toEqual([]);
  });

  it("menor sin solicitud → lo explica y «Pedir firma» abre un formulario con SOLO nombre y email (sin DNI)", async () => {
    h.status = { state: "none" };
    render(<GuardianConsentCard playerId="p1" playerName="Leo" birthDate={minorBirth} />);
    expect(screen.getByText("guardianConsent.state.noneDesc")).toBeInTheDocument();
    fireEvent.click(screen.getByText("guardianConsent.actions.request"));
    const form = screen.getByTestId("guardian-consent-form");
    expect(form.querySelectorAll("input")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("guardianConsent.form.nameLabel"), { target: { value: "Marta" } });
    fireEvent.change(screen.getByLabelText("guardianConsent.form.emailLabel"), { target: { value: "marta@x.test" } });
    fireEvent.click(screen.getByText("guardianConsent.form.submit"));
    await waitFor(() => expect(h.requested).toEqual([{ playerId: "p1", guardianName: "Marta", guardianEmail: "marta@x.test" }]));
    expect(await screen.findByText("guardianConsent.sent")).toBeInTheDocument();
  });

  it("confirmado → lo dice y se puede retirar (con confirmación)", async () => {
    h.status = { state: "verified", guardianName: "Marta", guardianEmail: "marta@x.test", verifiedAt: "2026-10-01T00:00:00Z" };
    render(<GuardianConsentCard playerId="p1" playerName="Leo" birthDate={minorBirth} />);
    expect(screen.getByText("guardianConsent.state.verified")).toBeInTheDocument();
    expect(screen.queryByText("guardianConsent.actions.request")).toBeNull();
    fireEvent.click(screen.getByText("guardianConsent.actions.withdraw"));
    fireEvent.click(screen.getByText("guardianConsent.actions.withdrawConfirm"));
    await waitFor(() => expect(h.withdrawn).toEqual([{ playerId: "p1" }]));
  });

  it("pendiente → «Volver a enviar» y «Cancelar solicitud»", () => {
    h.status = { state: "pending", guardianEmail: "marta@x.test", expiresAt: "2026-10-15T00:00:00Z" };
    render(<GuardianConsentCard playerId="p1" playerName="Leo" birthDate={minorBirth} />);
    expect(screen.getByText("guardianConsent.actions.resend")).toBeInTheDocument();
    expect(screen.getByText("guardianConsent.actions.cancelRequest")).toBeInTheDocument();
  });

  it("no se pudo comprobar → sin acciones ni «confirmado»", () => {
    h.status = { state: "unavailable" };
    render(<GuardianConsentCard playerId="p1" playerName="Leo" birthDate={minorBirth} />);
    expect(screen.getByText("guardianConsent.state.unavailableDesc")).toBeInTheDocument();
    expect(screen.queryByText("guardianConsent.actions.request")).toBeNull();
    expect(screen.queryByText("guardianConsent.actions.withdraw")).toBeNull();
  });
});
