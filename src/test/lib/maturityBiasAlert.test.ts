/**
 * P1 bloque 6 (revisiones #322 r1 y r2) — señal de sesgo madurativo del panel Master.
 * Antes: «MED BIAS ALERT» por defecto (inv #2), «LOW BIAS» con un percentil > 70 (corte
 * sin fuente) y «LOW» a los precoces, al revés que el propio motor (precoz ×0,92 =
 * evaluación inflada). Ahora: dirección del motor, y sin señal el motivo REAL del motor.
 */
import { describe, expect, it } from "vitest";
import { maturityBiasAlert, MATURITY_BIAS_FALLBACK_REASON } from "@/lib/metrics/maturityBiasAlert";
import { gatedMaturity } from "@/lib/phv/phvGate";
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

  it("dirección del motor: tardío, precoz y en fase como MetricResult DERIVADA", () => {
    for (const [p, signal] of [[LATE, "late"], [EARLY, "early"], [ON_TIME, "on_time"]] as const) {
      const r = maturityBiasAlert(p, AT);
      expect(r.value).toBe(signal);
      expect(r.provenance).toBe("DERIVADA");
      expect(r.gate_reason).toBeNull();
    }
  });

  it("sin alguna medida (sexo, talla sentado, fecha) ⇒ null + el motivo del gate, nunca un nivel por defecto", () => {
    const { gender: _g, ...noGender } = LATE;
    const { sittingHeight: _s, ...noSitting } = LATE;
    const { birthDate: _b, ...noBirth } = LATE;
    for (const p of [noGender, noSitting, noBirth, {}]) {
      const r = maturityBiasAlert(p as never, AT);
      expect(r.value).toBeNull();
      expect(r.gate_reason).toBe(gatedMaturity(p as never, AT).validityNote);
      expect(r.gate_reason?.length).toBeGreaterThan(0);
    }
  });

  it("gate ABIERTO pero sin timing afirmado (lejos del PHV) ⇒ null con el motivo REAL del motor, no «no registrada»", () => {
    const a = gatedMaturity(FAR_FROM_PHV, AT);
    expect(a.timing).toBe("unknown");
    expect(a.method).not.toBe("insufficient_data"); // el gate está abierto (control)
    const r = maturityBiasAlert(FAR_FROM_PHV, AT);
    expect(r.value).toBeNull();
    expect(r.gate_reason).toBe(a.validityNote);
    expect(r.gate_reason).not.toBe(MATURITY_BIAS_FALLBACK_REASON);
  });

  it("la evaluación del entrenador (vsi / percentil) no cambia la señal", () => {
    expect(maturityBiasAlert({ ...ON_TIME, vsi: 95 } as never, AT).value).toBe("on_time");
    expect(maturityBiasAlert({ vsi: 95 } as never, AT).value).toBeNull();
  });
});

describe("MasterDashboard usa la señal honesta", () => {
  const code = masterSrc.replace(/\/\/.*$/gm, "");

  it("sin niveles alta/media/baja, sin percentil y sin rótulo por defecto", () => {
    expect(code).not.toMatch(/BIAS ALERT/);
    expect(code).not.toMatch(/master\.bias(High|Med|Low|NoMaturity)/);
    expect(code).not.toMatch(/percentilesAmong/);
    expect(code).not.toMatch(/pct\s*>\s*70/);
    expect(code).toMatch(/maturityBiasAlert\(p\)/);
    expect(code).toMatch(/report\.biasAlert\.gate_reason/);
    expect(code).toMatch(/maturity\.timing\.\$\{signal\}/);
  });

  it("rótulos de dirección y de timing existen en los 7 idiomas; los de nivel ya no", () => {
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of ["master.biasLate", "master.biasEarly", "maturity.timing.late", "maturity.timing.early", "maturity.timing.on_time"]) {
        const v = get(json, key);
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${key}`).toBe(true);
      }
      for (const key of ["master.biasHigh", "master.biasMed", "master.biasLow", "master.biasNoMaturity"]) {
        expect(get(json, key), `${locale}: ${key}`).toBeUndefined();
      }
    }
  });
});
