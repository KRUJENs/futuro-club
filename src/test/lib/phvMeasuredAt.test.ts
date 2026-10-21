/**
 * PHV con la FECHA DE LA MEDICIÓN en todas las superficies (decisión del dueño 21 oct 2026:
 * sin fecha ⇒ bloquear y pedir una medición nueva). Antes, la tarjeta del Hub y el resto de
 * superficies llamaban a phvGate SIN fecha ⇒ edad de HOY con medidas viejas ⇒ fase sesgada.
 * Las fórmulas no cambian (inv #4): solo QUÉ fecha entra.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatedMaturity, measurementDateOf, missingPhvInputs, pahGate, phvGate } from "@/lib/phv/phvGate";
import { buildMaturityExport } from "@/lib/shared/maturityExport";
import { measuredAtFor } from "@/lib/shared/measuredAt";

const MEASURED = "2026-03-01T10:00:00.000Z";
const BOY = {
  height: 155, weight: 44, sittingHeight: 79, legLength: 76, birthDate: "2013-03-01",
  gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", motherHeightCm: 165, fatherHeightCm: 178,
};

afterEach(() => vi.useRealTimers());

describe("phvGate · fecha de la medición", () => {
  it("medidas sin fecha ⇒ bloqueado pidiendo una medición nueva (nunca la edad de hoy)", () => {
    const g = phvGate(BOY);
    expect(g.ok).toBe(false);
    expect(g.missing).toEqual(["measuredAt"]);
    expect(g.gate_reason).toMatch(/fecha de la medición/);
    expect(pahGate(BOY).missing).toEqual(["measuredAt"]);
    expect(gatedMaturity(BOY).status).toBe("unknown");
  });

  it("con measuredAt calcula EXACTAMENTE como con la fecha explícita; un `at` explícito manda", () => {
    const withField = phvGate({ ...BOY, measuredAt: MEASURED });
    const explicit = phvGate(BOY, MEASURED);
    expect(withField).toEqual(explicit);
    expect(phvGate({ ...BOY, measuredAt: "2020-01-01" }, MEASURED)).toEqual(explicit);
  });

  it("fecha no válida, futura o anterior al nacimiento ⇒ como si faltara", () => {
    for (const measuredAt of ["no-es-fecha", "2999-01-01", "2010-01-01", ""]) {
      expect(missingPhvInputs({ ...BOY, measuredAt })).toContain("measuredAt");
    }
    expect(measurementDateOf({ ...BOY, measuredAt: MEASURED })).toBe(MEASURED);
  });

  it("FALLA CON EL CÓDIGO VIEJO: meses después de medir, Hub (sin fecha), informes y exportación dan la MISMA fase", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); // ~8 meses después de medir
    const blob = { ...BOY, measuredAt: MEASURED };
    const hub = phvGate(blob); // la tarjeta del Hub llama sin fecha
    const atMeasurement = phvGate(BOY, MEASURED);
    const today = phvGate(BOY, new Date());
    expect(hub.ok && atMeasurement.ok && today.ok).toBe(true);
    if (!hub.ok || !atMeasurement.ok || !today.ok) return;
    expect(hub.status).toBe(atMeasurement.status);
    expect(hub.aphv.value).toBe(atMeasurement.aphv.value);
    expect(today.aphv.value).not.toBe(atMeasurement.aphv.value); // el sesgo que había antes
    // Exportación (fila guardada en la misma fecha) = Hub.
    const row = {
      height_cm: BOY.height, weight_kg: BOY.weight, sitting_height_cm: BOY.sittingHeight, leg_length_cm: BOY.legLength,
      chronological_age: atMeasurement.ageYears, age_source: "birth_date", maturity_offset: atMeasurement.offset.value,
      phv_category: atMeasurement.category, measured_at: MEASURED,
    };
    const exp = buildMaturityExport({ playerId: "p", birthDate: BOY.birthDate, blob, row, hasConsent: true });
    expect(exp.ok && exp.payload.status.value).toBe(hub.status);
  });
});

describe("measuredAtFor · cuándo cambia la fecha al guardar la ficha", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  const prev = { height: 150, weight: 40, sittingHeight: 78, legLength: 72, measuredAt: "2026-05-01T00:00:00.000Z" };
  it("medidas iguales ⇒ conserva la fecha (re-guardar no las «fecha hoy»)", () => {
    expect(measuredAtFor({ height: 150, weight: 40, sittingHeight: 78, legLength: 72 }, prev, NOW)).toBe(prev.measuredAt);
  });
  it("alguna medida cambia o se dan por primera vez ⇒ ahora", () => {
    expect(measuredAtFor({ height: 152, weight: 40, sittingHeight: 78, legLength: 72 }, prev, NOW)).toBe(NOW.toISOString());
    expect(measuredAtFor({ height: 152 }, undefined, NOW)).toBe(NOW.toISOString());
  });
  it("sin medidas ⇒ sin fecha nueva; jugador antiguo sin fecha y medidas iguales ⇒ sigue sin fecha (bloqueado)", () => {
    expect(measuredAtFor({}, undefined, NOW)).toBeUndefined();
    const legacy = { height: 150, weight: 40, sittingHeight: 78, legLength: 72 };
    expect(measuredAtFor(legacy, legacy, NOW)).toBeUndefined();
  });
});
