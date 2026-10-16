/**
 * P1 bloque 6, punto 22 — Edad relativa: ÚNICA implementación del trimestre de nacimiento.
 * Sustituye al RAEService retirado (misma correspondencia mes → trimestre, sin factores
 * de sesgo ni correcciones sin fuente).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  birthQuarter,
  BIRTH_DATE_MISSING_REASON,
  INVALID_CUTOFF_REASON,
  type CategoryCutoff,
} from "@/lib/shared/relativeAge";
import { ORIENTATIVE_CONFIDENCE } from "@/lib/metrics/MetricResult";

const NOW = new Date(2026, 9, 16); // 16 oct 2026 (fechas de nacimiento siempre en el pasado)
const AUGUST: CategoryCutoff = { month: 8, source: "reglamento de la competición X (prueba)" };

describe("birthQuarter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("año natural: ene-mar Q1, abr-jun Q2, jul-sep Q3, oct-dic Q4 (misma tabla que el RAE retirado)", () => {
    const expected = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
    for (let m = 1; m <= 12; m++) {
      const iso = `2012-${String(m).padStart(2, "0")}-15`;
      expect(birthQuarter(iso, { now: NOW }).value).toBe(expected[m - 1]);
    }
  });

  it("fronteras de trimestre: 01-01 → Q1, 03-31 → Q1, 04-01 → Q2, 12-31 → Q4", () => {
    expect(birthQuarter("2012-01-01", { now: NOW }).value).toBe(1);
    expect(birthQuarter("2012-03-31", { now: NOW }).value).toBe(1);
    expect(birthQuarter("2012-04-01", { now: NOW }).value).toBe(2);
    expect(birthQuarter("2012-12-31", { now: NOW }).value).toBe(4);
  });

  it("en un huso horario NEGATIVO el 1 de enero sigue siendo Q1 y el 1 de abril Q2", () => {
    // `new Date("2012-01-01").getMonth()` daría diciembre en America/Los_Angeles.
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(new Date("2012-01-01").getMonth()).toBe(11); // el error que se evita (control)
    expect(birthQuarter("2012-01-01", { now: NOW }).value).toBe(1);
    expect(birthQuarter("2012-04-01", { now: NOW }).value).toBe(2);
  });

  it("lee el mes del TEXTO, no de Date#getMonth sobre la fecha de nacimiento", () => {
    const spy = vi.spyOn(Date.prototype, "getMonth");
    const r = birthQuarter("2012-01-01", { now: NOW });
    expect(r.value).toBe(1);
    // getMonth solo puede llamarse sobre `now` (la cota «anterior a hoy» de toIsoBirthDate),
    // nunca sobre un Date construido con la fecha de nacimiento.
    expect(spy).toHaveBeenCalled();
    for (const self of spy.mock.contexts) expect(self).toBe(NOW);
  });

  it("corte por defecto (enero): DERIVADA, confianza orientativa y «pendiente de validar» en source_ref", () => {
    const r = birthQuarter("2011-05-20", { now: NOW });
    expect(r.provenance).toBe("DERIVADA");
    expect(r.gate_reason).toBeNull();
    expect(r.confidence).toBe(ORIENTATIVE_CONFIDENCE);
    expect(r.source_ref).toContain("pendiente de validar");
    expect(r.source_ref).toContain("corte mes 1");
  });

  it("corte registrado (agosto): agosto Q1, octubre Q1, noviembre Q2, julio Q4", () => {
    const q = (iso: string) => birthQuarter(iso, { cutoff: AUGUST, now: NOW }).value;
    expect(q("2012-08-01")).toBe(1);
    expect(q("2012-10-31")).toBe(1);
    expect(q("2012-11-01")).toBe(2);
    expect(q("2013-07-31")).toBe(4);
  });

  it("corte registrado: confianza plena y su fuente en source_ref (no la del corte por defecto)", () => {
    const r = birthQuarter("2012-09-10", { cutoff: AUGUST, now: NOW });
    expect(r.provenance).toBe("DERIVADA");
    expect(r.confidence).toBe(1);
    expect(r.source_ref).toContain("corte mes 8");
    expect(r.source_ref).toContain(AUGUST.source);
    expect(r.source_ref).not.toContain("pendiente de validar");
  });

  it("sin fecha o con fecha no válida ⇒ value null + motivo (nunca un trimestre por defecto)", () => {
    for (const bad of [undefined, null, "", "2012-13-01", "2012-02-30", "15/03/2012", "2030-01-01", 2012]) {
      const r = birthQuarter(bad, { now: NOW });
      expect(r.value).toBeNull();
      expect(r.gate_reason).toBe(BIRTH_DATE_MISSING_REASON);
      expect(r.confidence).toBe(0);
    }
  });

  it("corte presente pero no válido (null, mes fuera de 1-12, sin fuente) ⇒ bloqueado, NUNCA cae a enero", () => {
    const bad = [
      null,
      { month: 0, source: "x" },
      { month: 13, source: "x" },
      { month: 1.5, source: "x" },
      { month: 8, source: "" },
      { month: 8, source: "   " },
      { month: 8 },
    ] as unknown as CategoryCutoff[];
    for (const cutoff of bad) {
      const r = birthQuarter("2012-03-01", { cutoff, now: NOW });
      expect(r.value, JSON.stringify(cutoff)).toBeNull();
      expect(r.gate_reason).toBe(INVALID_CUTOFF_REASON);
    }
  });
});
