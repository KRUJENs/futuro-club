/**
 * P2 bloque 9 (D10) — bio-banding de la plantilla por % de talla adulta (Khamis-Roche,
 * bandas Cumming 2017). Consumidor de pahGate/bandFromPercentPAH: no cambia ningún valor
 * del módulo protegido; sin alturas de los padres o sin sexo REGISTRADO, sin banda.
 */
import { describe, expect, it } from "vitest";
import { squadBioBands } from "@/lib/phv/squadBioBanding";
import { pahGate } from "@/lib/phv/phvGate";
import { bandFromPercentPAH } from "@/lib/phv/khamisRoche";

const AT = "2026-10-20";
const CONFIRMED = "2026-10-01T00:00:00Z";
const child = { name: "niño", birthDate: "2017-04-10", height: 135, weight: 30, motherHeightCm: 163, fatherHeightCm: 175, gender: "M", sexConfirmedAt: CONFIRMED };
const teen = { name: "juvenil", birthDate: "2011-04-20", height: 177, weight: 70, motherHeightCm: 165, fatherHeightCm: 178, gender: "M", sexConfirmedAt: CONFIRMED };

describe("squadBioBands", () => {
  it("control positivo: la banda y el % son EXACTAMENTE los de pahGate + bandFromPercentPAH", () => {
    const r = squadBioBands([child, teen], AT);
    for (const p of [child, teen]) {
      const pct = pahGate(p, AT).percent.value as number;
      const band = bandFromPercentPAH(pct);
      const hit = r.bands[band].find((b) => b.player === p);
      expect(hit?.percent.value).toBe(pct);
      expect(hit?.percent.provenance).toBe("DERIVADA");
    }
    expect(r.bands.pre_phv.map((b) => b.player)).toContain(child);
    expect(r.bands.post_phv.map((b) => b.player)).toContain(teen);
    expect(r.unbanded).toHaveLength(0);
  });

  it("sin alturas de los padres ⇒ sin banda con su motivo, nunca desde el offset (D10)", () => {
    const noParents = { ...child, motherHeightCm: null, fatherHeightCm: null };
    const r = squadBioBands([noParents], AT);
    expect(r.unbanded).toHaveLength(1);
    expect(r.unbanded[0].missing).toEqual(["motherHeight", "fatherHeight"]);
    expect(r.unbanded[0].gate_reason).toContain("altura de la madre");
    expect(Object.values(r.bands).flat()).toHaveLength(0);
  });

  it("«M» sin confirmar = sexo no registrado ⇒ sin banda; confirmado o «F» ⇒ con banda", () => {
    const pending = { ...child, sexConfirmedAt: undefined };
    const r = squadBioBands([pending], AT);
    expect(r.unbanded[0].missing).toEqual(["sex"]);
    expect(squadBioBands([{ ...child, gender: "F", sexConfirmedAt: undefined }], AT).unbanded).toHaveLength(0);
  });

  it("fuera del rango de validez de Khamis-Roche ⇒ sin banda con ese motivo", () => {
    const adult = { ...teen, birthDate: "1990-01-01" };
    const r = squadBioBands([adult], AT);
    expect(r.unbanded).toHaveLength(1);
    expect(r.unbanded[0].missing).toEqual([]);
  });
});
