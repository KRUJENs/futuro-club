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
} from "@/lib/shared/relativeAge";
import { RELATIVE_AGE_CUTOFF_MONTH } from "../../../config/relativeAge";

const NOW = new Date(2026, 9, 16); // 16 oct 2026 (fechas de nacimiento siempre en el pasado)

describe("birthQuarter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("corte por defecto = enero (año natural)", () => {
    expect(RELATIVE_AGE_CUTOFF_MONTH).toBe(1);
  });

  it("año natural: ene-mar Q1, abr-jun Q2, jul-sep Q3, oct-dic Q4 (misma tabla que el RAE retirado)", () => {
    const expected = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
    for (let m = 1; m <= 12; m++) {
      const iso = `2012-${String(m).padStart(2, "0")}-15`;
      expect(birthQuarter(iso, { now: NOW }).value).toBe(expected[m - 1]);
    }
  });

  it("corte personalizado (agosto): agosto Q1, octubre Q1, noviembre Q2, julio Q4", () => {
    const q = (iso: string) => birthQuarter(iso, { cutoffMonth: 8, now: NOW }).value;
    expect(q("2012-08-01")).toBe(1);
    expect(q("2012-10-31")).toBe(1);
    expect(q("2012-11-01")).toBe(2);
    expect(q("2013-07-31")).toBe(4);
  });

  it("lee el mes del TEXTO, no de Date#getMonth (un 1 de enero no puede caer en diciembre por la zona horaria)", () => {
    const spy = vi.spyOn(Date.prototype, "getMonth");
    const r = birthQuarter("2012-01-01", { now: NOW });
    expect(r.value).toBe(1);
    // getMonth solo puede llamarse sobre `now` (la cota «anterior a hoy» de toIsoBirthDate),
    // nunca sobre un Date construido con la fecha de nacimiento.
    for (const self of spy.mock.instances) expect(self).toBe(NOW);
  });

  it("DERIVADA, confianza orientativa y el corte «pendiente de validar» en source_ref", () => {
    const r = birthQuarter("2011-05-20", { now: NOW });
    expect(r.provenance).toBe("DERIVADA");
    expect(r.gate_reason).toBeNull();
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(1);
    expect(r.source_ref).toContain("pendiente de validar");
    expect(r.source_ref).toContain("corte mes 1");
  });

  it("sin fecha o con fecha no válida ⇒ value null + motivo (nunca un trimestre por defecto)", () => {
    for (const bad of [undefined, null, "", "2012-13-01", "2012-02-30", "15/03/2012", "2030-01-01", 2012]) {
      const r = birthQuarter(bad, { now: NOW });
      expect(r.value).toBeNull();
      expect(r.gate_reason).toBe(BIRTH_DATE_MISSING_REASON);
      expect(r.confidence).toBe(0);
    }
  });

  it("mes de corte fuera de 1-12 ⇒ bloqueado con motivo", () => {
    for (const c of [0, 13, 1.5]) {
      const r = birthQuarter("2012-03-01", { cutoffMonth: c, now: NOW });
      expect(r.value).toBeNull();
      expect(r.gate_reason).toBe(INVALID_CUTOFF_REASON);
    }
  });
});
