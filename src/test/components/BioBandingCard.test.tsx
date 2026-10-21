/**
 * P2 bloque 9 (D10) — tarjeta de bio-banding de la plantilla: banda por %PAH con su
 * procedencia; quien no tiene alturas de los padres sale «sin banda» con lo que falta.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));

import { BioBandingCard } from "@/components/team/BioBandingCard";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import de from "@/i18n/de.json";
import fr from "@/i18n/fr.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const CONFIRMED = "2026-10-01T00:00:00Z";
const child = { id: "c1", name: "Leo", birthDate: "2017-04-10", measuredAt: "2026-09-01T10:00:00.000Z", height: 135, weight: 30, motherHeightCm: 163, fatherHeightCm: 175, gender: "M", sexConfirmedAt: CONFIRMED };
const noParents = { id: "c2", name: "Hugo", birthDate: "2016-02-01", height: 140, weight: 33, gender: "F" };

describe("BioBandingCard", () => {
  it("las bandas %PAH se rotulan por el %, NUNCA como fase PHV (esa es Mirwald) en los 7 idiomas", () => {
    for (const loc of [es, esLA, en, de, fr, it_, nl]) {
      for (const label of [...Object.values(loc.bioBanding.band), loc.bioBanding.title, loc.bioBanding.percentLabel]) {
        expect(label).not.toMatch(/PHV/);
        expect(label).toMatch(/%/); // los tres rótulos, el título y la etiqueta del % lo nombran
      }
    }
  });

  it("fuera del rango de Khamis-Roche ⇒ «sin banda» con ese motivo", () => {
    render(<BioBandingCard players={[{ ...child, id: "a1", birthDate: "1990-01-01" }]} />);
    expect(screen.getByText(/bioBanding\.missing\.out_of_range/)).toBeDefined();
  });

  it("jugador con todas las entradas ⇒ en su banda, con % y procedencia", () => {
    render(<BioBandingCard players={[child]} />);
    expect(screen.getByText("Leo")).toBeDefined();
    expect(screen.getByText(/bioBanding\.coverage .*"banded":1.*"total":1/)).toBeDefined();
    expect(screen.getByText("Calculado")).toBeDefined();
  });

  it("sin alturas de los padres ⇒ «sin banda» con lo que falta; sin columnas de banda", () => {
    render(<BioBandingCard players={[noParents]} />);
    expect(screen.queryByText("Hugo")).toBeNull();
    expect(screen.getByText(/bioBanding\.unbanded .*"count":1/)).toBeDefined();
    expect(screen.getByText(/bioBanding\.missing\.motherHeight/)).toBeDefined();
    expect(screen.getByText(/bioBanding\.missing\.fatherHeight/)).toBeDefined();
    expect(screen.queryByText(/bioBanding\.band\./)).toBeNull();
  });
});
