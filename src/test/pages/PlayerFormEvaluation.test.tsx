/**
 * PlayerForm — semántica de «evaluación del entrenador».
 *
 * #146 ya impedía fabricar un VSI sin tocar las barras. Faltaba: tocar UNA barra
 * marcaba las 6 como evaluadas (las 5 no tocadas —60/50 por defecto— entraban en el
 * VSI como valoración del entrenador). Ahora la evaluación solo se guarda con
 * confirmación EXPLÍCITA de las 6 barras; mover barras sin confirmar bloquea el
 * guardado con un aviso (no se descarta en silencio ni se inventa).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Referencias ESTABLES entre renders: el efecto de carga de PlayerForm depende de
// `navigate`; una función nueva por render lo re-dispara → reset() → bucle infinito.
const router = vi.hoisted(() => ({ navigate: () => {}, params: { id: "p1" } }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => router.navigate,
  useParams: () => router.params, // modo edición: todas las secciones visibles
}));
const i18n = vi.hoisted(() => ({ t: (key: string) => key, i18n: { language: "es" } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => i18n,
}));
vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        ({ children, initial: _i, animate: _a, variants: _v, transition: _tr, exit: _e, ...props }: Record<string, unknown> & { children?: unknown }) => {
          const Tag = prop as unknown as React.ElementType;
          return <Tag {...props}>{children as React.ReactNode}</Tag>;
        },
    },
  );
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/usePlan", () => ({
  usePlan: () => ({ canAddPlayer: true, limits: { players: 10 }, playerCount: 1 }),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase", () => ({ SUPABASE_CONFIGURED: false, supabase: {} }));
vi.mock("@/services/real/supabasePlayerService", () => ({
  // Guardado honesto (#298): la ficha se persiste con persistOrQueue; sin nube ⇒ local_only.
  SupabasePlayerService: { persistOrQueue: vi.fn().mockResolvedValue({ status: "local_only" }) },
}));

// Jugador SIN evaluar (sin métricas): el formulario precarga las barras por defecto.
const unevaluated = {
  id: "p1", name: "Samu Test", age: 12, position: "Mediocentro", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", foot: "right",
  height: 150, weight: 40, competitiveLevel: "Regional", minutesPlayed: 300,
  vsi: null, vsiHistory: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
const svc = vi.hoisted(() => ({
  getById: vi.fn(),
  getAll: vi.fn(),
  updateMetrics: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/services/real/playerService", () => ({ PlayerService: svc }));
vi.mock("@/services/real/storageService", () => ({ StorageService: { set: vi.fn(), get: vi.fn() } }));

import PlayerForm from "@/pages/PlayerForm";

function slider(container: HTMLElement, index: number): HTMLInputElement {
  return container.querySelectorAll<HTMLInputElement>('input[type="range"]')[index];
}
function submit() {
  fireEvent.click(screen.getByText("players.form.submitEdit"));
}

describe("PlayerForm — la evaluación exige confirmar las 6 barras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getById.mockReturnValue({ ...unevaluated });
    svc.getAll.mockReturnValue([{ ...unevaluated }]);
    svc.updateMetrics.mockResolvedValue({ ...unevaluated });
  });

  it("sin tocar barras ni confirmar ⇒ guarda la ficha pero NO registra evaluación (fix #146 intacto)", async () => {
    render(<PlayerForm />);
    submit();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(svc.updateMetrics).not.toHaveBeenCalled();
  });

  it("tocar UNA barra sin confirmar ⇒ bloquea con aviso; NO marca las 6 como evaluadas", async () => {
    const { container } = render(<PlayerForm />);
    fireEvent.change(slider(container, 0), { target: { value: "75" } });
    submit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("players.form.metricsConfirmRequired"));
    expect(svc.updateMetrics).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("con confirmación explícita ⇒ registra la evaluación de las 6 barras", async () => {
    const { container } = render(<PlayerForm />);
    fireEvent.change(slider(container, 0), { target: { value: "75" } });
    fireEvent.click(screen.getByLabelText("players.form.metricsConfirm"));
    submit();
    await waitFor(() => expect(svc.updateMetrics).toHaveBeenCalledTimes(1));
    const [, metrics] = svc.updateMetrics.mock.calls[0];
    expect(metrics).toMatchObject({ speed: 75 });
    expect(Object.keys(metrics)).toHaveLength(6);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
