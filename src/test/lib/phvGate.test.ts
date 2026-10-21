/**
 * VITAS · Tests del gate ÚNICO de PHV (regla del owner 28-sep).
 *
 * Contrato: el PHV solo existe con TODAS las entradas introducidas (talla, peso,
 * talla sentado, pierna —o talla − sentado—, fecha de nacimiento → edad decimal,
 * sexo registrado). Cada ausencia ⇒ value null + gate_reason que la nombra.
 * El gate NO cambia fórmulas: con entradas completas devuelve exactamente lo que
 * el motor existente (computeMirwald / resolveMaturity) calcula.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  phvGate,
  gatedMaturity,
  sanitizePlayerPhv,
  pahGate,
  phvLabelEs,
  PHV_STATUS_LABEL_ES,
  trustAnthropometricsRow,
  gateAnthropometricsRow,
  missingPhvInputs,
  type PhvInputKey,
} from "@/lib/phv/phvGate";
import { computeMirwald } from "@/lib/phv/mirwald";
import { resolveMaturity } from "@/lib/phv/maturity";
import { decimalAgeYears } from "@/lib/shared/age";

const AT = "2026-07-01";
const COMPLETE = {
  height: 165,
  weight: 55,
  sittingHeight: 85,
  legLength: 80,
  birthDate: "2012-03-15", measuredAt: "2026-09-01T10:00:00.000Z",
  gender: "M" as const,
};

describe("phvGate · entradas completas introducidas", () => {
  it("abre el gate y reproduce EXACTAMENTE el motor existente (fórmulas intactas)", () => {
    const g = phvGate(COMPLETE, AT);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const age = decimalAgeYears(COMPLETE.birthDate, AT)!;
    expect(g.ageYears).toBe(age);
    expect(g.ageYears % 1).not.toBe(0); // edad DECIMAL, no el entero
    const mir = computeMirwald({
      chronologicalAge: age, height: 165, weight: 55, gender: "M", sittingHeight: 85, legLength: 80,
    });
    expect(g.mirwald).toEqual(mir);
    expect(g.mirwald.estimated).toBe(false);
    expect(g.offset.value).toBe(mir.offset);
    expect(g.offset.provenance).toBe("DERIVADA");
    expect(g.aphv.value).toBe(mir.ageAtPHV);
    expect(g.assessment).toEqual(
      resolveMaturity({ sex: "M", ageYears: age, heightCm: 165, weightKg: 55, sittingHeightCm: 85, legLengthCm: 80 }),
    );
  });

  it("pierna = talla − talla sentado cuando la pierna no se introdujo", () => {
    const g = phvGate({ ...COMPLETE, legLength: undefined }, AT);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.legLengthDerived).toBe(true);
    expect(g.legLengthCm).toBe(80);
    expect(g.mirwald.estimated).toBe(false);
  });

  it("categoría persistible por ESTADO (convención early = pre-PHV)", () => {
    const g = phvGate(COMPLETE, AT);
    if (!g.ok) throw new Error("gate cerrado");
    const expected = g.mirwald.phvStatus === "pre_phv" ? "early" : g.mirwald.phvStatus === "post_phv" ? "late" : "ontme";
    expect(g.category).toBe(expected);
  });
});

describe("phvGate · cada entrada ausente ⇒ null + gate_reason", () => {
  const cases: Array<[PhvInputKey, Record<string, unknown>, string]> = [
    ["height", { height: undefined }, "talla"],
    ["weight", { weight: null }, "peso"],
    ["sittingHeight", { sittingHeight: undefined, legLength: 80 }, "talla sentado"],
    ["birthDate", { birthDate: undefined }, "fecha de nacimiento"],
    ["sex", { gender: undefined }, "sexo registrado"],
  ];
  for (const [key, patch, label] of cases) {
    it(`sin ${key} → bloqueado`, () => {
      const g = phvGate({ ...COMPLETE, ...patch }, AT);
      expect(g.ok).toBe(false);
      if (g.ok) return;
      expect(g.missing).toContain(key);
      expect(g.gate_reason).toContain("Falta:");
      expect(g.gate_reason).toContain(label);
      expect(g.offset.value).toBeNull();
      expect(g.offset.gate_reason).toBe(g.gate_reason);
      expect(g.aphv.value).toBeNull();
      expect(g.category).toBeNull();
      expect(g.assessment).toBeNull();
    });
  }

  it("sin talla sentado NI pierna → faltan las dos (no se estima ×0.52/×0.48)", () => {
    const g = phvGate({ ...COMPLETE, sittingHeight: undefined, legLength: undefined }, AT);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.missing).toEqual(["sittingHeight", "legLength"]);
    expect(g.gate_reason).toBe("Falta: talla sentado, longitud de pierna");
  });

  it("el entero `age` NO sustituye a la fecha de nacimiento", () => {
    const g = phvGate({ ...COMPLETE, birthDate: undefined, age: 14 } as never, AT);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.missing).toEqual(["birthDate"]);
  });

  it("fecha de nacimiento futura/ inválida cuenta como ausente", () => {
    expect(missingPhvInputs({ ...COMPLETE, birthDate: "2099-01-01" }, AT)).toEqual(["birthDate"]);
    expect(missingPhvInputs({ ...COMPLETE, birthDate: "no-es-fecha" }, AT)).toEqual(["birthDate"]);
  });

  it("sexo no binario-registrado (p.ej. 'X' o texto libre) no se infiere", () => {
    expect(missingPhvInputs({ ...COMPLETE, gender: "X" }, AT)).toEqual(["sex"]);
  });

  it("jugador sin NINGUNA medida → lista todas", () => {
    const g = phvGate({}, AT);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.missing).toEqual(["height", "weight", "sittingHeight", "legLength", "birthDate", "sex"]);
  });

  it("entradas completas pero fuera del rango de Mirwald (8–18) → bloqueado out_of_range", () => {
    const g = phvGate({ ...COMPLETE, birthDate: "2000-01-01" }, AT);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toBe("out_of_range");
    expect(g.missing).toEqual([]);
    expect(g.offset.value).toBeNull();
  });
});

describe("gatedMaturity · sustituto de playerMaturity", () => {
  it("bloqueado ⇒ abstención con el gate_reason como validityNote", () => {
    const a = gatedMaturity({ height: 135, weight: 30, gender: "M", birthDate: "2017-01-01" }, AT);
    expect(a.method).toBe("insufficient_data");
    expect(a.timing).toBe("unknown");
    expect(a.status).toBe("unknown");
    expect(a.adjustmentFactor).toBe(1);
    expect(a.validityNote).toBe("Falta: talla sentado, longitud de pierna");
  });

  it("abierto ⇒ la evaluación canónica", () => {
    const g = phvGate(COMPLETE, AT);
    expect(gatedMaturity(COMPLETE, AT)).toEqual(g.ok ? g.assessment : null);
  });
});

describe("phvGate · UNA sola fase aunque haya alturas parentales (%PAH ≠ PHV)", () => {
  // Casos reales del review (at = 2026-09-29): con alturas parentales el motor
  // decide su `status` por %PAH (Khamis-Roche) y discrepaba de la categoría de
  // Mirwald → «En PHV» en equipo/familia/PDF y «Pre-PHV» en el Hub.
  const TODAY = "2026-09-29T12:00:00Z";
  const BOY = {
    height: 158, weight: 46, sittingHeight: 80, legLength: 78,
    birthDate: "2013-06-01", measuredAt: "2026-09-01T10:00:00.000Z", gender: "M" as const, motherHeightCm: 170, fatherHeightCm: 185,
  };
  const GIRL = {
    height: 150, weight: 40, sittingHeight: 78, legLength: 72,
    birthDate: "2014-03-01", measuredAt: "2026-09-01T10:00:00.000Z", gender: "F" as const, motherHeightCm: 165, fatherHeightCm: 178,
  };

  beforeEach(() => {
    // Solo Date: sanitizePlayerPhv / phvLabelEs / las superficies usan «hoy».
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(TODAY));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["chico", BOY],
    ["chica", GIRL],
  ])("%s: todas las lecturas de la fase coinciden (Mirwald), el %PAH va aparte", (_l, p) => {
    const g = phvGate(p);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const age = decimalAgeYears(p.birthDate, TODAY)!;

    // El caso es significativo: el motor CON padres daba otra fase (por %PAH).
    const withParents = resolveMaturity({
      sex: p.gender, ageYears: age, heightCm: p.height, weightKg: p.weight,
      sittingHeightCm: p.sittingHeight, legLengthCm: p.legLength,
      motherHeightCm: p.motherHeightCm, fatherHeightCm: p.fatherHeightCm,
    });
    expect(withParents.method).toBe("khamis_roche_pah");
    expect(withParents.status).toBe("pre_phv");

    // Fase única = Mirwald (offset en ±1 ⇒ en PHV) en TODAS las lecturas.
    expect(Math.abs(g.offset.value as number)).toBeLessThanOrEqual(1);
    expect(g.status).toBe("circa_phv");
    expect(g.category).toBe("ontme");
    expect(g.assessment.status).toBe(g.status); // Hub header, Hub print, PHVProductCard, ScoutFeed
    expect(gatedMaturity(p).status).toBe(g.status); // VitasCard, ShareablePlayerCard, adaptadores
    expect(phvLabelEs(g)).toBe(PHV_STATUS_LABEL_ES.ontme); // PDF / prompts
    expect(sanitizePlayerPhv({ ...p, phvCategory: "early", phvOffset: -2 }).phvCategory).toBe("ontme"); // Team, familia, rankings

    // El timing (y por tanto el factor VSI) no cambia: sale del APHV en ambos métodos.
    expect(g.assessment.timing).toBe(withParents.timing);
    expect(g.assessment.adjustmentFactor).toBe(withParents.adjustmentFactor);

    // %PAH: NO viaja en la evaluación PHV; es su propia métrica «% talla adulta».
    expect(g.assessment.percentPredictedAdultHeight).toBeUndefined();
    const pah = pahGate(p);
    expect(pah.ok).toBe(true);
    expect(pah.percent.value).toBe(withParents.percentPredictedAdultHeight);
  });
});

describe("sanitizePlayerPhv · categoría persistida solo si el gate la recalcula", () => {
  it("jugador sin medidas con phvCategory 'early' persistido (caso Samu) → se elimina", () => {
    const p = sanitizePlayerPhv({ id: "samu", height: 135, weight: 30, phvCategory: "early", phvOffset: -1.2 });
    expect(p).not.toHaveProperty("phvCategory");
    expect(p).not.toHaveProperty("phvOffset");
    expect(p.id).toBe("samu");
  });

  it("jugador completo → se sustituye por el recálculo gateado", () => {
    const p = sanitizePlayerPhv({ ...COMPLETE, phvCategory: "late" as const, phvOffset: 9 });
    const g = phvGate(COMPLETE);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(p.phvCategory).toBe(g.category);
    expect(p.phvOffset).toBe(g.offset.value);
  });
});

describe("pahGate · %talla adulta es OTRA métrica con sus propias entradas", () => {
  it("sin alturas parentales → bloqueado (y no depende de talla sentado)", () => {
    const g = pahGate({ height: 165, weight: 55, birthDate: "2012-03-15", gender: "M" }, AT);
    expect(g.ok).toBe(false);
    expect(g.missing).toEqual(["motherHeight", "fatherHeight"]);
    expect(g.percent.value).toBeNull();
  });

  it("completo → % derivado con unidades '%'", () => {
    const g = pahGate(
      { height: 165, weight: 55, birthDate: "2012-03-15", gender: "M", motherHeightCm: 165, fatherHeightCm: 178 },
      AT,
    );
    expect(g.ok).toBe(true);
    expect(g.percent.value).toBeGreaterThan(0);
    expect(g.percent.units).toBe("%");
  });
});

describe("trustAnthropometricsRow · PHV persistido solo desde fila completa con edad por fecha", () => {
  const full = {
    height_cm: 165, weight_kg: 55, sitting_height_cm: 85, leg_length_cm: 80,
    chronological_age: 14.3, maturity_offset: -0.4, phv_category: "ontime",
  };

  it("fila antigua (edad entera, sin age_source) → NO fiable", () => {
    const t = trustAnthropometricsRow({ ...full, chronological_age: 14 });
    expect(t.trusted).toBe(false);
    expect(t.offset).toBeNull();
    expect(t.gate_reason).toContain("fecha de nacimiento");
  });

  it("fila completa con age_source='birth_date' → fiable", () => {
    const t = trustAnthropometricsRow({ ...full, age_source: "birth_date" });
    expect(t.trusted).toBe(true);
    expect(t.offset).toBe(-0.4);
    expect(t.category).toBe("ontme");
  });

  it("fila sin talla sentado → NO fiable aunque tenga categoría", () => {
    const t = trustAnthropometricsRow({ ...full, age_source: "birth_date", sitting_height_cm: null });
    expect(t.trusted).toBe(false);
    expect(t.gate_reason).toContain("talla sentado");
  });

  it("gateAnthropometricsRow anula los campos PHV de una fila no fiable y conserva las medidas", () => {
    const r = gateAnthropometricsRow({ ...full });
    expect(r?.maturity_offset).toBeNull();
    expect(r?.phv_category).toBeNull();
    expect(r?.height_cm).toBe(165);
    expect(r?.phv_trusted).toBe(false);
    expect(r?.phv_gate_reason).toBeTruthy();
  });
});
