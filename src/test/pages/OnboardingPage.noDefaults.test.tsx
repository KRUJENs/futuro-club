/**
 * OnboardingPage · alta rápida SIN valores inventados (P1 bloque 2, inv #2).
 * Antes el primer jugador nacía con 14 años, extremo izquierdo, pie derecho, 1,65 m,
 * 58 kg y nivel «Regional» que nadie había medido ni elegido. Ahora la edad sale de la
 * fecha de nacimiento, la posición se elige y lo demás queda vacío.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (typeof d === "string" ? k : k), i18n: { language: "es" } }),
}));
vi.mock("framer-motion", () => {
  const motion = new Proxy({}, {
    get: (_t, prop: string) => ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
      const { animate: _a, transition: _tr, initial: _i, exit: _e, ...rest } = props;
      const Tag = prop as keyof JSX.IntrinsicElements;
      return <Tag {...rest}>{children}</Tag>;
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/services/real/userProfileService", () => ({
  UserProfileService: { create: vi.fn() },
  PROFILE_TYPE_LABELS: { scout: "scout", parent: "parent", academy: "academy", club: "club" },
  PROFILE_TYPE_DESCRIPTIONS: { scout: "", parent: "", academy: "", club: "" },
}));
vi.mock("@/services/real/organizationService", () => ({ OrganizationService: { create: vi.fn() } }));
vi.mock("@/services/real/demoDataService", () => ({ DemoDataService: { seed: vi.fn() } }));
const created = vi.hoisted(() => ({ input: null as null | Record<string, unknown> }));
vi.mock("@/services/real/playerService", () => ({
  PlayerService: { create: vi.fn((input: Record<string, unknown>) => { created.input = input; return { id: "p-new", ...input }; }) },
}));
vi.mock("@/services/real/supabasePlayerService", () => ({
  SupabasePlayerService: { persistOrQueue: vi.fn(async () => ({})), pushAll: vi.fn(async () => ({})) },
}));

import OnboardingPage from "@/pages/OnboardingPage";

function goToPlayerStep() {
  render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
  fireEvent.click(screen.getByText("onboarding.start"));
  fireEvent.click(screen.getByText("scout"));
  fireEvent.click(screen.getByText("common.next"));
  fireEvent.click(screen.getByText("common.next"));
}
const dateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;
const positionSelect = () => document.querySelector("select") as HTMLSelectElement;

beforeEach(() => {
  created.input = null;
  toastMock.error.mockReset();
  toastMock.success.mockReset();
});

describe("OnboardingPage · primer jugador sin valores inventados", () => {
  it("no trae edad ni posición escritas: fecha vacía y posición sin elegir", () => {
    goToPlayerStep();
    expect(dateInput().value).toBe("");
    expect(positionSelect().value).toBe("");
    expect(document.querySelector('input[type="number"]')).toBeNull(); // ya no hay «edad 14»
  });

  it("sin fecha de nacimiento NO crea el jugador (no se inventa la edad)", async () => {
    goToPlayerStep();
    fireEvent.change(screen.getByPlaceholderText("onboarding.placeholders.playerName"), { target: { value: "Leo" } });
    fireEvent.change(positionSelect(), { target: { value: "Pivote" } });
    fireEvent.click(screen.getByText("common.male"));
    fireEvent.click(screen.getByText("common.finish"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("onboarding.birthDateRequired"));
    expect(created.input).toBeNull();
  });

  it("sin posición NO crea el jugador", async () => {
    goToPlayerStep();
    fireEvent.change(screen.getByPlaceholderText("onboarding.placeholders.playerName"), { target: { value: "Leo" } });
    fireEvent.change(dateInput(), { target: { value: "2014-03-01" } });
    fireEvent.click(screen.getByText("common.male"));
    fireEvent.click(screen.getByText("common.finish"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("firstRun.choosePosition"));
    expect(created.input).toBeNull();
  });

  it("menor de 8 años ⇒ se dice el rango de edad (antes error genérico de guardado) y no se crea", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    try {
      goToPlayerStep();
      fireEvent.change(screen.getByPlaceholderText("onboarding.placeholders.playerName"), { target: { value: "Leo" } });
      fireEvent.change(dateInput(), { target: { value: "2020-05-01" } }); // 6 años
      fireEvent.change(positionSelect(), { target: { value: "Pivote" } });
      fireEvent.click(screen.getByText("common.male"));
      fireEvent.click(screen.getByText("common.finish"));
      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("firstRun.ageRange"));
      expect(created.input).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("con lo que se escribió: edad desde la fecha y SIN pie, talla, peso ni nivel", async () => {
    // «Hoy» fijo (solo Date; los temporizadores de waitFor siguen reales) ⇒ la edad
    // esperada no depende del día en que se ejecute el test.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    try {
    goToPlayerStep();
    fireEvent.change(screen.getByPlaceholderText("onboarding.placeholders.playerName"), { target: { value: "Leo" } });
    fireEvent.change(dateInput(), { target: { value: "2014-03-01" } });
    fireEvent.change(positionSelect(), { target: { value: "Pivote" } });
    fireEvent.click(screen.getByText("common.female"));
    fireEvent.click(screen.getByText("common.finish"));
    await waitFor(() => expect(created.input).not.toBeNull());
    const input = created.input!;
    expect(input.birthDate).toBe("2014-03-01");
    expect(input.position).toBe("Pivote");
    expect(input.gender).toBe("F");
    expect(input.age).toBe(12); // nacida el 1-3-2014, «hoy» 13-10-2026
    for (const k of ["foot", "height", "weight", "competitiveLevel"]) expect(input[k], k).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
