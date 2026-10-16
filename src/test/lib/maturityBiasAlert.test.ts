/**
 * P1 bloque 6 (revisión #322, MENOR 3) — aviso de sesgo madurativo del panel Master.
 * Antes: «MED BIAS ALERT» por defecto a todo jugador sin maduración firme (inv #2) y
 * «LOW BIAS» con un percentil de la evaluación del entrenador > 70 (corte sin fuente;
 * el percentil no mide maduración). Ahora: solo desde la maduración canónica firme.
 */
import { describe, expect, it } from "vitest";
import { maturityBiasAlert } from "@/lib/metrics/maturityBiasAlert";
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

  it("tardío ⇒ alta, precoz ⇒ baja, a tiempo ⇒ media", () => {
    expect(maturityBiasAlert(LATE, AT)).toBe("high");
    expect(maturityBiasAlert(EARLY, AT)).toBe("low");
    expect(maturityBiasAlert(ON_TIME, AT)).toBe("med");
  });

  it("sin todas las medidas (falta el sexo, la talla sentado o la fecha) ⇒ null, nunca «med» por defecto", () => {
    const { gender: _g, ...noGender } = LATE;
    const { sittingHeight: _s, ...noSitting } = LATE;
    const { birthDate: _b, ...noBirth } = LATE;
    for (const p of [noGender, noSitting, noBirth, {}]) {
      expect(maturityBiasAlert(p as never, AT)).toBeNull();
    }
  });

  it("la evaluación del entrenador (vsi / percentil) no cambia el aviso", () => {
    expect(maturityBiasAlert({ ...ON_TIME, vsi: 95 } as never, AT)).toBe("med");
    expect(maturityBiasAlert({ vsi: 95 } as never, AT)).toBeNull();
  });
});

describe("MasterDashboard usa el aviso honesto", () => {
  const code = masterSrc.replace(/\/\/.*$/gm, "");

  it("sin rótulos fijos en inglés, sin percentil y sin «med» por defecto", () => {
    expect(code).not.toMatch(/BIAS ALERT/);
    expect(code).not.toMatch(/percentilesAmong/);
    expect(code).not.toMatch(/pct\s*>\s*70/);
    expect(code).toMatch(/maturityBiasAlert\(p\)/);
    expect(code).toMatch(/t\("master\.biasNoMaturity"\)/);
  });

  it("rótulos y motivo existen en los 7 idiomas", () => {
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of ["master.biasHigh", "master.biasMed", "master.biasLow", "master.biasNoMaturity"]) {
        const v = get(json, key);
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${key}`).toBe(true);
      }
    }
  });
});
