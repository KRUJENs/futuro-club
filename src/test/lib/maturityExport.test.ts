/**
 * P2 bloque 10 (D11) — salida de maduración para FICHA/Grada: solo estado + fecha del PHV +
 * confianza; consentimiento del tutor para cualquier menor (o edad desconocida); las mismas
 * puertas del PHV que el resto del servidor (fila de confianza + phvGate + sexo registrado).
 */
import { describe, expect, it } from "vitest";
import { buildMaturityExport, MATURITY_EXPORT_SCHEMA, requiresGuardianConsent } from "@/lib/shared/maturityExport";
import { phvGate } from "@/lib/phv/phvGate";

const BIRTH = "2013-03-01";
const MEASURED = "2026-09-01T10:00:00Z";
const NOW = new Date("2026-10-21T10:00:00Z");
const INPUTS = { height: 160, weight: 48, sittingHeight: 83, legLength: 77 };
const BLOB = { gender: "M", sexConfirmedAt: "2026-08-01T00:00:00Z", birthDate: BIRTH };

// Fila tal como la guarda el endpoint de antropometría (offset/categoría del gate único).
const g = phvGate({ ...INPUTS, birthDate: BIRTH, gender: "M" }, MEASURED);
if (!g.ok) throw new Error("fixture: el gate debería abrir");
const ROW = {
  height_cm: INPUTS.height, weight_kg: INPUTS.weight, sitting_height_cm: INPUTS.sittingHeight, leg_length_cm: INPUTS.legLength,
  chronological_age: g.ageYears, age_source: "birth_date", maturity_offset: g.offset.value, phv_category: g.category,
  measured_at: MEASURED,
};

describe("buildMaturityExport", () => {
  it("control positivo: solo esquema, jugador, estado, fecha del PHV y la medición; valores del gate único", () => {
    const r = buildMaturityExport({ playerId: "p1", birthDate: BIRTH, blob: BLOB, row: ROW, hasConsent: true, now: NOW });
    if (!r.ok) throw new Error("debería exportar");
    expect(Object.keys(r.payload).sort()).toEqual(["measured_at", "phv_date", "player_id", "schema", "status"]);
    expect(r.payload.schema).toBe(MATURITY_EXPORT_SCHEMA);
    expect(r.payload.status.value).toBe(g.status);
    expect(r.payload.status.confidence).toBe(g.offset.confidence);
    expect(r.payload.phv_date.confidence).toBe(g.aphv.confidence);
    expect(r.payload.phv_date.provenance).toBe("DERIVADA");
    // Fecha = nacimiento + APHV (años), con precisión de días.
    const days = (Date.parse(`${r.payload.phv_date.value}T00:00:00Z`) - Date.parse(`${BIRTH}T00:00:00Z`)) / 86_400_000;
    expect(Math.abs(days / 365.2425 - (g.aphv.value as number))).toBeLessThan(0.01);
  });

  it("menor sin consentimiento activo del tutor ⇒ bloqueado, sin decir nada del PHV", () => {
    const r = buildMaturityExport({ playerId: "p1", birthDate: BIRTH, blob: BLOB, row: ROW, hasConsent: false, now: NOW });
    expect(r).toEqual({ ok: false, code: "consent_required", gate_reason: expect.any(String) });
  });

  it("edad desconocida ⇒ se pide el consentimiento (de más, nunca de menos); adulto no", () => {
    expect(requiresGuardianConsent(null, NOW)).toBe(true);
    expect(requiresGuardianConsent("2000-01-01", NOW)).toBe(false);
    expect(requiresGuardianConsent(BIRTH, NOW)).toBe(true);
  });

  it("«M» sin confirmar = sin sexo registrado ⇒ phv_unavailable", () => {
    const r = buildMaturityExport({ playerId: "p1", birthDate: BIRTH, blob: { gender: "M" }, row: ROW, hasConsent: true, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "phv_unavailable" });
  });

  it("fila antigua (edad entera) o sin medición ⇒ phv_unavailable con su motivo", () => {
    for (const row of [{ ...ROW, age_source: "integer_age" }, null]) {
      const r = buildMaturityExport({ playerId: "p1", birthDate: BIRTH, blob: BLOB, row, hasConsent: true, now: NOW });
      expect(r).toMatchObject({ ok: false, code: "phv_unavailable" });
    }
  });

  it("fila con una categoría que el gate no reproduce ⇒ bloqueado (nunca se exporta una fase distinta)", () => {
    const other = g.category === "early" ? "late" : "early";
    const r = buildMaturityExport({ playerId: "p1", birthDate: BIRTH, blob: BLOB, row: { ...ROW, phv_category: other }, hasConsent: true, now: NOW });
    expect(r.ok).toBe(false);
  });
});
