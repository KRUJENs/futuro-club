/**
 * P1 bloque 6 (revisiones #322 r1-r3) — señal de sesgo madurativo del panel Master.
 * Antes: «MED BIAS ALERT» por defecto (inv #2), «LOW BIAS» con un percentil > 70 (corte
 * sin fuente) y «LOW» a los precoces, al revés que el propio motor (precoz ×0,92 =
 * evaluación inflada). Ahora: dirección del motor; sin señal, el motivo TRADUCIDO
 * (PhvGateNotice con el gate cerrado; «Timing por determinar» con el gate abierto).
 */
import { describe, expect, it } from "vitest";
import {
  maturityBiasAlert,
  MATURITY_BIAS_DIRECTION_KEY,
  MATURITY_BIAS_FALLBACK_REASON,
} from "@/lib/metrics/maturityBiasAlert";
import { gatedMaturity, phvGate } from "@/lib/phv/phvGate";
import masterSrc from "@/pages/MasterDashboard.tsx?raw";
import es from "@/i18n/es.json";
import esLatam from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const AT = "2026-09-29";
// Mismas entradas que rankingTimingFilter.test.ts (todas las medidas introducidas).
const LATE = { height: 160, weight: 48, sittingHeight: 80, legLength: 80, birthDate: "2011-09-29", gender: "M" };
const ON_TIME = { height: 150, weight: 42, sittingHeight: 78, legLength: 72, birthDate: "2016-03-29", gender: "M" };
const EARLY = { height: 170, weight: 60, sittingHeight: 90, legLength: 80, birthDate: "2014-03-29", gender: "M" };
// Todas las medidas, pero lejos del PHV (9 años): el motor NO afirma el timing.
const FAR_FROM_PHV = { height: 132, weight: 28, sittingHeight: 70, legLength: 62, birthDate: "2017-09-29", gender: "M" };

const LOCALES: Record<string, unknown> = { es, "es-419": esLatam, en, fr, de, it: it_, nl };
const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

describe("maturityBiasAlert", () => {
  it("las entradas de prueba dan maduración FIRME con el timing esperado (control)", () => {
    for (const [p, timing] of [[LATE, "late"], [ON_TIME, "on_time"], [EARLY, "early"]] as const) {
      const a = gatedMaturity(p, AT);
      expect(a.timing).toBe(timing);
      expect(["high", "moderate"]).toContain(a.confidence);
    }
  });

  it("dirección del motor: tardío, precoz y en fase como MetricResult DERIVADA con la confianza del offset", () => {
    for (const [p, signal] of [[LATE, "late"], [EARLY, "early"], [ON_TIME, "on_time"]] as const) {
      const { signal: r, gate } = maturityBiasAlert(p, AT);
      expect(r.value).toBe(signal);
      expect(r.provenance).toBe("DERIVADA");
      expect(r.gate_reason).toBeNull();
      expect(r.confidence).toBe(gate.aphv.confidence);
    }
  });

  it("la dirección coincide con el factor del MOTOR: tardío ⇒ factor > 1 ⇒ infravaloración; precoz ⇒ < 1 ⇒ sobrevaloración", () => {
    expect(gatedMaturity(LATE, AT).adjustmentFactor).toBeGreaterThan(1);
    expect(MATURITY_BIAS_DIRECTION_KEY.late).toBe("master.biasLate");
    expect(gatedMaturity(EARLY, AT).adjustmentFactor).toBeLessThan(1);
    expect(MATURITY_BIAS_DIRECTION_KEY.early).toBe("master.biasEarly");
    expect(gatedMaturity(ON_TIME, AT).adjustmentFactor).toBe(1);
    expect(MATURITY_BIAS_DIRECTION_KEY.on_time).toBeNull();
    // Y el TEXTO dice lo mismo (un idioma con los textos cruzados fallaría aquí).
    expect(get(es, "master.biasLate")).toMatch(/infravalor/);
    expect(get(es, "master.biasEarly")).toMatch(/sobrevalor/);
    expect(get(en, "master.biasLate")).toMatch(/undervalu/);
    expect(get(en, "master.biasEarly")).toMatch(/overvalu/);
    expect(get(esLatam, "master.biasLate")).toMatch(/infravalor/);
    expect(get(esLatam, "master.biasEarly")).toMatch(/sobrevalor/);
    expect(get(fr, "master.biasLate")).toMatch(/sous-évalu/);
    expect(get(fr, "master.biasEarly")).toMatch(/surévalu/);
    expect(get(de, "master.biasLate")).toMatch(/Unterbewert/);
    expect(get(de, "master.biasEarly")).toMatch(/Überbewert/);
    expect(get(it_, "master.biasLate")).toMatch(/sottovalut/);
    expect(get(it_, "master.biasEarly")).toMatch(/sopravvalut/);
    expect(get(nl, "master.biasLate")).toMatch(/onderwaard/);
    expect(get(nl, "master.biasEarly")).toMatch(/overwaard/);
  });

  it("gate CERRADO (falta sexo, talla sentado o fecha) ⇒ null + el motivo del gate, y el gate para traducirlo", () => {
    const { gender: _g, ...noGender } = LATE;
    const { sittingHeight: _s, ...noSitting } = LATE;
    const { birthDate: _b, ...noBirth } = LATE;
    for (const p of [noGender, noSitting, noBirth, {}]) {
      const { signal, gate } = maturityBiasAlert(p as never, AT);
      expect(signal.value).toBeNull();
      expect(gate.ok).toBe(false);
      expect(signal.gate_reason).toBe(phvGate(p as never, AT).gate_reason);
    }
  });

  it("gate CERRADO por medidas fuera de rango (adulto) ⇒ null + motivo del gate, nunca el corte en silencio", () => {
    const adult = { ...LATE, birthDate: "1990-01-01" };
    const { signal, gate } = maturityBiasAlert(adult, AT);
    expect(gate.ok).toBe(false);
    expect(gate.ok ? null : gate.reason).toBe("out_of_range");
    expect(signal.value).toBeNull();
    expect(signal.gate_reason).toBe(gate.gate_reason);
  });

  it("gate ABIERTO pero sin timing afirmado (lejos del PHV) ⇒ null con la nota real del motor", () => {
    const a = gatedMaturity(FAR_FROM_PHV, AT);
    expect(a.timing).toBe("unknown");
    const { signal, gate } = maturityBiasAlert(FAR_FROM_PHV, AT);
    expect(gate.ok).toBe(true); // control: el gate está abierto
    expect(signal.value).toBeNull();
    expect(signal.gate_reason).toBe(a.validityNote);
    expect(signal.gate_reason).not.toBe(MATURITY_BIAS_FALLBACK_REASON);
  });

  it("la evaluación del entrenador (vsi / percentil) no cambia la señal", () => {
    expect(maturityBiasAlert({ ...ON_TIME, vsi: 95 } as never, AT).signal.value).toBe("on_time");
    expect(maturityBiasAlert({ vsi: 95 } as never, AT).signal.value).toBeNull();
  });
});

describe("MasterDashboard usa la señal honesta", () => {
  const code = masterSrc.replace(/\/\/.*$/gm, "");

  it("sin niveles, sin percentil, sin rótulo por defecto y sin el motivo en crudo (español en 7 idiomas)", () => {
    expect(code).not.toMatch(/BIAS ALERT/);
    expect(code).not.toMatch(/master\.bias(High|Med|Low|NoMaturity)/);
    expect(code).not.toMatch(/percentilesAmong/);
    expect(code).not.toMatch(/pct\s*>\s*70/);
    expect(code).toMatch(/maturityBiasAlert\(p\)/);
    expect(code).not.toMatch(/\.gate_reason\s*\}/); // nunca se pinta el texto del motor sin traducir
    expect(code).toMatch(/<PhvGateNotice gate=\{report\.biasAlert\.gate\}/);
    expect(code).toMatch(/t\("maturity\.timing\.unknown"\)/);
    expect(code).toMatch(/MATURITY_BIAS_DIRECTION_KEY\[signal\]/);
    expect(code).not.toMatch(/bg-destructive/); // color neutro: no es un juicio sobre el niño
  });

  it("rótulos de dirección y de timing existen en los 7 idiomas; los de nivel ya no", () => {
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of ["master.biasLate", "master.biasEarly", "maturity.timing.late", "maturity.timing.early", "maturity.timing.on_time", "maturity.timing.unknown"]) {
        const v = get(json, key);
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${key}`).toBe(true);
      }
      for (const key of ["master.biasHigh", "master.biasMed", "master.biasLow", "master.biasNoMaturity"]) {
        expect(get(json, key), `${locale}: ${key}`).toBeUndefined();
      }
    }
  });
});
