/**
 * PlayerForm (editar jugador) — mismo patrón de guardado honesto que la ficha:
 * antes escribía en localStorage, lanzaba pushOne sin esperar (y pushOne se
 * tragaba el error) y anunciaba «actualizado» pasara lo que pasara.
 * Ahora: «actualizado» solo con la nube OK; nube caída ⇒ «pendiente de
 * sincronizar» (en SyncQueue); y la fecha del jugador llega a birth_date.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  failUpsert: false,
}));
vi.mock("@/lib/supabase", () => ({
  SUPABASE_CONFIGURED: true,
  supabase: {
    from: () => ({
      upsert: async (payload: Record<string, unknown>) => {
        if (db.failUpsert) return { error: { message: "network down" } };
        db.rows.set(payload.id as string, payload);
        return { error: null };
      },
    }),
  },
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/hooks/usePlan", () => ({
  usePlan: () => ({ canAddPlayer: true, limits: { players: 9999 }, playerCount: 1 }),
}));
vi.mock("@/services/real/organizationService", () => ({ OrganizationService: { getOrgId: () => null } }));
vi.mock("@/services/real/agentService", () => ({ AgentService: { invalidateCacheForPlayer: vi.fn() } }));

import PlayerForm from "@/pages/PlayerForm";
import { PlayerService } from "@/services/real/playerService";
import { SyncQueueService } from "@/services/real/syncQueueService";

function renderEdit(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/players/${id}/edit`]}>
        <Routes>
          <Route path="/players/:id/edit" element={<PlayerForm />} />
          <Route path="/players/:id" element={<div>hub</div>} />
          <Route path="/rankings" element={<div>rankings</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  db.rows.clear();
  db.failUpsert = false;
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const BASE = {
  name: "Samu Prueba",
  age: 11,
  position: "ST",
  foot: "right" as const,
  height: 142,
  weight: 36,
  competitiveLevel: "Regional",
  minutesPlayed: 0,
  gender: "M" as const, sexConfirmedAt: "2026-01-01T00:00:00.000Z",
  birthDate: "2015-05-10",
};

describe("PlayerForm · editar · guardado honesto", () => {
  it("nube OK ⇒ «actualizado» y la fila lleva birth_date", async () => {
    const p = PlayerService.create(BASE);
    renderEdit(p.id);
    fireEvent.click(await screen.findByRole("button", { name: /players\.form\.submitEdit/ }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("toasts.playerUpdated"));
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(db.rows.get(p.id)?.birth_date).toBe("2015-05-10");
    expect(await screen.findByText("hub")).toBeInTheDocument();
  });

  it("fecha de las medidas: la que escribe la persona se guarda; vacía no se inventa; futura se rechaza", async () => {
    const p = PlayerService.create(BASE);
    renderEdit(p.id);
    const input = (await screen.findByLabelText("players.form.measuredAt")) as HTMLInputElement;
    expect(input.value).toBe(""); // jugador antiguo: sin fecha, no se rellena con hoy
    fireEvent.change(input, { target: { value: "2999-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /players.form.submitEdit/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("players.form.measuredAtInvalid"));
    expect(PlayerService.getAll().find((x) => x.id === p.id)?.measuredAt).toBeUndefined();
    fireEvent.change(input, { target: { value: "2026-03-01" } });
    fireEvent.click(screen.getByRole("button", { name: /players.form.submitEdit/ }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("toasts.playerUpdated"));
    expect(PlayerService.getAll().find((x) => x.id === p.id)?.measuredAt).toBe("2026-03-01");
  });

  it("jugador del alta rápida SIN pie: se guarda sin obligar a elegir uno (no se adivina) y la columna queda null", async () => {
    const { foot: _f, height: _h, weight: _w, competitiveLevel: _l, ...quick } = BASE;
    const p = PlayerService.create(quick);
    renderEdit(p.id);
    fireEvent.click(await screen.findByRole("button", { name: /players\.form\.submitEdit/ }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("toasts.playerUpdated"));
    const row = db.rows.get(p.id)!;
    expect(row.foot).toBeNull();
    expect(row.height_cm).toBeNull();
    expect(row.weight_kg).toBeNull();
  });

  it("nube caída ⇒ NO «actualizado»: aviso «pendiente de sincronizar» y op en SyncQueue", async () => {
    const p = PlayerService.create(BASE);
    db.failUpsert = true;
    renderEdit(p.id);
    fireEvent.click(await screen.findByRole("button", { name: /players\.form\.submitEdit/ }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith("toasts.playerSavedPendingSync"));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(SyncQueueService.hasPendingFor("player", p.id, "user-1")).toBe(true);
  });
});

function renderCreate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/players/new"]}>
        <Routes>
          <Route path="/players/new" element={<PlayerForm />} />
          <Route path="/rankings" element={<div>rankings</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillAndSubmitCreate() {
  fireEvent.change(screen.getByPlaceholderText("players.form.fullNamePlaceholder"), {
    target: { value: "Nuevo Jugador" },
  });
  fireEvent.change(document.getElementById("position") as HTMLSelectElement, { target: { value: "Pivote" } });
  fireEvent.click(screen.getByRole("button", { name: "common.male" }));
  // P1 bloque 2: ni la edad ni el pie vienen ya rellenos (antes 14 años y pie derecho).
  fireEvent.change(document.getElementById("age") as HTMLInputElement, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "common.footLeft" }));
  // Paso 1 → 2 → 3 (la validación por paso es asíncrona: esperar a que cambie).
  fireEvent.click(screen.getByRole("button", { name: /playerForm\.next/ }));
  await waitFor(() => expect(document.getElementById("height")).not.toBeNull());
  expect(toastMock.error).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /playerForm\.next/ }));
  fireEvent.click(await screen.findByRole("button", { name: /players\.form\.submit$/ }));
}

describe("PlayerForm · alta · guardado honesto", () => {
  it("nube OK ⇒ «agregado» y la fila está en la nube", async () => {
    renderCreate();
    await fillAndSubmitCreate();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("toasts.playerAdded"));
    expect(toastMock.warning).not.toHaveBeenCalled();
    const created = PlayerService.getAll().find((p) => p.name === "Nuevo Jugador");
    expect(created).toBeTruthy();
    expect(db.rows.has(created!.id)).toBe(true);
    expect(SyncQueueService.hasPendingFor("player", created!.id, "user-1")).toBe(false);
    // Lo que nadie escribió no se guarda: sin talla, peso ni nivel inventados (inv #2).
    expect(created!.height).toBeUndefined();
    expect(created!.weight).toBeUndefined();
    expect(created!.competitiveLevel).toBeUndefined();
    expect(created!.age).toBe(12);
    expect(created!.foot).toBe("left");
  });

  it("sin edad ni pie el paso 1 NO avanza (no se inventan 14 años ni pie derecho)", async () => {
    renderCreate();
    fireEvent.change(screen.getByPlaceholderText("players.form.fullNamePlaceholder"), {
      target: { value: "Nuevo Jugador" },
    });
    fireEvent.change(document.getElementById("position") as HTMLSelectElement, { target: { value: "Pivote" } });
    fireEvent.click(screen.getByRole("button", { name: "common.male" }));
    fireEvent.click(screen.getByRole("button", { name: /playerForm\.next/ }));
    // La validación del paso 1 falla: aviso de errores y se sigue en el paso 1.
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("players.form.fixErrors"));
    fireEvent.click(screen.getByRole("button", { name: /playerForm\.next/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /players\.form\.submit$/ })).toBeNull();
    expect(PlayerService.getAll().find((p) => p.name === "Nuevo Jugador")).toBeUndefined();
  });

  it("nube caída ⇒ NO «agregado»: «pendiente de sincronizar» y alta en SyncQueue", async () => {
    db.failUpsert = true;
    renderCreate();
    await fillAndSubmitCreate();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith("toasts.playerAddedPendingSync"));
    expect(toastMock.success).not.toHaveBeenCalled();
    const created = PlayerService.getAll().find((p) => p.name === "Nuevo Jugador");
    expect(created).toBeTruthy();
    const op = SyncQueueService.getQueue().find((q) => q.entityId === created!.id);
    expect(op?.action).toBe("create");
  });
});
