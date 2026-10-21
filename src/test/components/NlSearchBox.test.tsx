/**
 * P2 bloque 11 — caja de búsqueda en lenguaje natural: aplica SOLO los filtros devueltos,
 * enseña lo interpretado con su procedencia (Estimado por IA) y lo no entendido.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer t" })) }));

import { NlSearchBox } from "@/components/rankings/NlSearchBox";

let response: Response;
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
});
afterEach(() => vi.restoreAllMocks());

function search(onApply = vi.fn(), active = true) {
  render(<NlSearchBox onApply={onApply} active={active} filtersKey="k" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "lateral zurdo tardío, U14, rápido" } });
  fireEvent.click(screen.getByRole("button"));
  return onApply;
}

describe("NlSearchBox", () => {
  it("nada entendido ⇒ NO se aplica ningún filtro (no sale la lista con su podio como respuesta) y se avisa", async () => {
    response = new Response(JSON.stringify({ data: { filters: {}, not_understood: ["los más rápidos"] } }));
    const onApply = search();
    await waitFor(() => expect(screen.getByText(/rankingsNl.nothingApplied/)).toBeDefined());
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByText("Estimado por IA")).toBeNull();
  });

  it("si los filtros ya no son los de la búsqueda (active=false) ⇒ no se enseña la interpretación", async () => {
    response = new Response(JSON.stringify({ data: { filters: { foot: "left" }, not_understood: [] } }));
    const onApply = search(vi.fn(), false);
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(screen.queryByText("Estimado por IA")).toBeNull();
  });

  it("búsqueda aplicada y luego una sin nada entendido ⇒ siguen las chips de la anterior + el aviso; cambiar filtros borra el aviso", async () => {
    response = new Response(JSON.stringify({ data: { filters: { foot: "left" }, not_understood: [] } }));
    const onApply = vi.fn();
    const { rerender } = render(<NlSearchBox onApply={onApply} active filtersKey="a" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zurdo" } });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText("rankingsNl.foot.left")).toBeDefined());
    response = new Response(JSON.stringify({ data: { filters: {}, not_understood: ["rápidos"] } }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "rápidos" } });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(/rankingsNl\.nothingApplied/)).toBeDefined());
    expect(screen.getByText("rankingsNl.foot.left")).toBeDefined(); // la anterior sigue vigente
    rerender(<NlSearchBox onApply={onApply} active={false} filtersKey="b" />);
    expect(screen.queryByText(/rankingsNl\.nothingApplied/)).toBeNull();
    expect(screen.queryByText("rankingsNl.foot.left")).toBeNull();
  });

  it("límite diario (429) ⇒ aviso propio, sin tocar filtros", async () => {
    response = new Response("{}", { status: 429 });
    const onApply = search();
    await waitFor(() => expect(screen.getByText("rankingsNl.limit")).toBeDefined());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("aplica los filtros interpretados y los enseña rotulados «Estimado por IA», con lo no entendido", async () => {
    response = new Response(JSON.stringify({
      data: { filters: { position: "Lateral Izquierdo", foot: "left", timing: "late", ageGroup: "Sub-14" }, not_understood: ["rápido"] },
    }));
    const onApply = search();
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ position: "Lateral Izquierdo", foot: "left", timing: "late", ageGroup: "Sub-14" }));
    expect(screen.getByText("Lateral Izquierdo")).toBeDefined();
    expect(screen.getByText("rankingsNl.foot.left")).toBeDefined();
    expect(screen.getByText("Estimado por IA")).toBeDefined();
    expect(screen.getByText(/rápido/)).toBeDefined();
  });

  it("IA no disponible (503) ⇒ aviso y NO se tocan los filtros", async () => {
    response = new Response("{}", { status: 503 });
    const onApply = search();
    await waitFor(() => expect(screen.getByText("rankingsNl.unavailable")).toBeDefined());
    expect(onApply).not.toHaveBeenCalled();
  });
});
