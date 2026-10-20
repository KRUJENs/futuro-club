/**
 * P2 bloque 8 — señal de sesgo por edad relativa en una plantilla: χ² contra reparto por
 * igual, mínimo de jugadores con fecha, siempre orientativa, nunca un veredicto.
 */
import { describe, expect, it } from "vitest";
import { squadRelativeAge } from "@/lib/shared/relativeAgeBias";
import { ORIENTATIVE_CONFIDENCE } from "@/lib/metrics/MetricResult";

const NOW = new Date("2026-10-20T10:00:00Z");
const MONTH_OF_Q = ["02", "05", "08", "11"]; // un mes de cada trimestre (corte = enero)

function squad(q1: number, q2: number, q3: number, q4: number): string[] {
  return [q1, q2, q3, q4].flatMap((n, i) => Array.from({ length: n }, () => `2013-${MONTH_OF_Q[i]}-15`));
}

describe("squadRelativeAge", () => {
  it("menos de 20 jugadores con fecha ⇒ sin señal y sin reparto (motivo con la cobertura)", () => {
    const r = squadRelativeAge([...squad(10, 5, 2, 1), null, "", "no-fecha"], { now: NOW });
    expect(r.total).toBe(21);
    expect(r.dated).toBe(18);
    expect(r.signal.value).toBeNull();
    expect(r.gate_code).toBe("insufficient_dated_players");
    expect(r.signal.gate_reason).toContain("18 de 20");
  });

  it("control positivo: reparto por igual ⇒ sin señal (none), orientativa y DERIVADA", () => {
    const r = squadRelativeAge(squad(5, 5, 5, 5), { now: NOW });
    expect(r.signal.value).toEqual({ counts: [5, 5, 5, 5], dated: 20, chiSquare: 0, direction: "none" });
    expect(r.signal.provenance).toBe("DERIVADA");
    expect(r.signal.confidence).toBe(ORIENTATIVE_CONFIDENCE);
  });

  it("más nacidos al principio del año (χ² ≥ 7,815) ⇒ señal early", () => {
    const r = squadRelativeAge(squad(11, 5, 2, 2), { now: NOW });
    expect(r.signal.value?.chiSquare).toBe(10.8);
    expect(r.signal.value?.direction).toBe("early");
  });

  it("desvío pequeño (χ² < 7,815) ⇒ none aunque haya más Q1 que Q4", () => {
    const r = squadRelativeAge(squad(10, 5, 3, 2), { now: NOW });
    expect(r.signal.value?.chiSquare).toBe(7.6);
    expect(r.signal.value?.direction).toBe("none");
  });

  it("más nacidos al final del año ⇒ late", () => {
    expect(squadRelativeAge(squad(2, 2, 5, 11), { now: NOW }).signal.value?.direction).toBe("late");
  });

  it("corte de la competición no registrado ⇒ bloqueado por el corte, nunca el año natural en silencio", () => {
    const r = squadRelativeAge(squad(5, 5, 5, 5), { cutoff: null, now: NOW });
    expect(r.signal.value).toBeNull();
    expect(r.gate_code).toBe("cutoff_unavailable");
  });

  it("corte registrado de la competición (julio) desplaza los trimestres", () => {
    // Nacidos en agosto = 1.º trimestre con corte en julio.
    const r = squadRelativeAge(squad(0, 0, 20, 0), { cutoff: { month: 7, source: "test" }, now: NOW });
    expect(r.signal.value?.counts).toEqual([20, 0, 0, 0]);
    expect(r.signal.value?.direction).toBe("early");
  });
});
