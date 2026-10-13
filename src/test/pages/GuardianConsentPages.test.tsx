/**
 * Páginas públicas del TUTOR (P1 bloque 3):
 *   /auth/verify-consent  — antes hacía el POST al ABRIRSE (un escáner de enlaces del correo
 *                           podía «firmar», CWE-650). Ahora NADA se envía al abrir: el tutor
 *                           escribe SU DNI, marca condiciones y privacidad y pulsa «Confirmo».
 *   /auth/withdraw-consent — el tutor retira con su enlace, también solo al pulsar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "es" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import VerifyConsentPage from "@/pages/VerifyConsentPage";
import WithdrawConsentPage from "@/pages/WithdrawConsentPage";

const TOKEN = "a".repeat(64);
let fetchMock: ReturnType<typeof vi.fn>;
let reply: { status: number; body: unknown };

beforeEach(() => {
  reply = { status: 200, body: { success: true, data: { verified: true, withdrawToken: "b".repeat(64), confirmationEmailSent: true } } };
  fetchMock = vi.fn(async () => Response.json(reply.body, { status: reply.status }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const openAt = (url: string, page: JSX.Element) => {
  window.history.pushState({}, "", url);
  return render(<MemoryRouter>{page}</MemoryRouter>);
};

describe("/auth/verify-consent", () => {
  it("abrir la página NO verifica nada (ni un POST) y quita el token de la barra", async () => {
    openAt(`/auth/verify-consent?token=${TOKEN}`, <VerifyConsentPage />);
    await screen.findByTestId("verify-consent-form");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("el botón no se activa sin DNI y sin las DOS casillas", async () => {
    openAt(`/auth/verify-consent?token=${TOKEN}`, <VerifyConsentPage />);
    const button = await screen.findByText("verifyConsentPage.confirm");
    expect(button.closest("button")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("verifyConsentPage.dniLabel"), { target: { value: "12345678z" } });
    const [terms] = screen.getAllByRole("checkbox");
    fireEvent.click(terms);
    expect(button.closest("button")).toBeDisabled();
  });

  it("al pulsar «Confirmo» manda token + DNI (en mayúsculas) + las dos aceptaciones, y ofrece el enlace de retirada", async () => {
    openAt(`/auth/verify-consent?token=${TOKEN}`, <VerifyConsentPage />);
    fireEvent.change(await screen.findByLabelText("verifyConsentPage.dniLabel"), { target: { value: "12345678z" } });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByText("verifyConsentPage.confirm"));
    await screen.findByText("verifyConsentPage.success.done");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/verify-consent");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN, parentDni: "12345678Z", acceptedTerms: true, acceptedPrivacy: true });
    // El código va tras «#»: el fragmento no viaja a ningún servidor.
    expect(screen.getByText("verifyConsentPage.success.withdrawLink").getAttribute("href")).toBe(`/auth/withdraw-consent#token=${"b".repeat(64)}`);
    expect(screen.queryByTestId("withdraw-unavailable")).toBeNull();
  });

  it("enlace con el código tras «#» (formato del correo): se lee y se quita de la barra; nada al abrir", async () => {
    openAt(`/auth/verify-consent#token=${TOKEN}`, <VerifyConsentPage />);
    fireEvent.change(await screen.findByLabelText("verifyConsentPage.dniLabel"), { target: { value: "12345678Z" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByText("verifyConsentPage.confirm"));
    await screen.findByText("verifyConsentPage.success.done");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).token).toBe(TOKEN);
  });

  it("confirmado SIN enlace de retirada (no se pudo generar) → se le dice cómo retirarlo", async () => {
    reply = { status: 200, body: { success: true, data: { verified: true, withdrawToken: null, confirmationEmailSent: false } } };
    openAt(`/auth/verify-consent#token=${TOKEN}`, <VerifyConsentPage />);
    fireEvent.change(await screen.findByLabelText("verifyConsentPage.dniLabel"), { target: { value: "12345678Z" } });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByText("verifyConsentPage.confirm"));
    expect(await screen.findByTestId("withdraw-unavailable")).toHaveTextContent("verifyConsentPage.success.withdrawUnavailable");
  });

  it("enlace caducado (410) → lo dice; no «confirmado»", async () => {
    reply = { status: 410, body: { success: false, errorDetail: { code: "token_expired" } } };
    openAt(`/auth/verify-consent?token=${TOKEN}`, <VerifyConsentPage />);
    fireEvent.change(await screen.findByLabelText("verifyConsentPage.dniLabel"), { target: { value: "12345678Z" } });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByText("verifyConsentPage.confirm"));
    expect(await screen.findByText("verifyConsentPage.errors.expired")).toBeInTheDocument();
    expect(screen.queryByText("verifyConsentPage.success.done")).toBeNull();
  });

  it("sin token en el enlace → lo dice, sin formulario", async () => {
    openAt("/auth/verify-consent", <VerifyConsentPage />);
    expect(await screen.findByText("verifyConsentPage.errors.missingToken")).toBeInTheDocument();
    expect(screen.queryByTestId("verify-consent-form")).toBeNull();
  });
});

describe("/auth/withdraw-consent", () => {
  it("abrir NO retira; al pulsar «Retirar» manda el token y confirma", async () => {
    reply = { status: 200, body: { success: true, data: { withdrawn: true } } };
    openAt(`/auth/withdraw-consent?token=${TOKEN}`, <WithdrawConsentPage />);
    const button = await screen.findByText("withdrawConsentPage.confirm");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText("withdrawConsentPage.done");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/guardian-withdraw");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });

  it("enlace no válido (404) → lo dice", async () => {
    reply = { status: 404, body: { success: false, errorDetail: { code: "invalid_token" } } };
    openAt(`/auth/withdraw-consent?token=${TOKEN}`, <WithdrawConsentPage />);
    fireEvent.click(await screen.findByText("withdrawConsentPage.confirm"));
    await waitFor(() => expect(screen.getByText("withdrawConsentPage.errors.invalidToken")).toBeInTheDocument());
  });
});
