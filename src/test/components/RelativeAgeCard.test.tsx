/**
 * P2 bloque 8 — tarjeta de edad relativa de la plantilla: con pocos jugadores con fecha,
 * el motivo y la cobertura (sin reparto); con suficientes, el reparto y la señal rotulada
 * por su procedencia.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));

import { RelativeAgeCard } from "@/components/team/RelativeAgeCard";

const dates = (n: number, month: string) => Array.from({ length: n }, () => `2013-${month}-15`);

describe("RelativeAgeCard", () => {
  it("pocos jugadores con fecha ⇒ motivo con la cobertura, sin barras ni señal", () => {
    render(<RelativeAgeCard birthDates={[...dates(3, "02"), null]} />);
    expect(screen.getByText(/relativeAge\.gate\.insufficient_dated_players .*"dated":3.*"min":20/)).toBeDefined();
    expect(screen.getByText(/relativeAge\.coverage .*"dated":3.*"total":4/)).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/relativeAge\.signal/)).toBeNull();
  });

  it("20 jugadores con más nacidos al principio del año ⇒ reparto + señal early con su etiqueta", () => {
    render(<RelativeAgeCard birthDates={[...dates(11, "02"), ...dates(5, "05"), ...dates(2, "08"), ...dates(2, "11")]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("relativeAge.signal.early")).toBeDefined();
    expect(screen.getByText("Calculado")).toBeDefined();
  });
});
