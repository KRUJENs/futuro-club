/**
 * P1 bloque 7, punto 11 — un «M» guardado sin confirmar (valor por defecto antiguo de la
 * 024 y del cliente/API anteriores al 20 ago) no entra al cálculo de maduración: el PHV
 * queda bloqueado pidiendo confirmar el sexo. «F» nunca fue valor por defecto.
 */
import { describe, expect, it } from "vitest";
import {
  registeredSex,
  sexConfirmationFor,
  sexPendingConfirmation,
  withRegisteredSex,
} from "@/lib/shared/registeredSex";
import { honestPlayerView } from "@/lib/players/honestPlayerView";
import { phvGate } from "@/lib/phv/phvGate";
import { trustAnthroForPlayer, gateAnthroForPlayer, SEX_PENDING_PHV_REASON } from "@/lib/shared/sexGatedAnthro";

const CONFIRMED = "2026-10-18T10:00:00.000Z";
// Entradas completas del PHV (las 6): solo cambia el sexo entre casos.
const FULL = {
  height: 150, weight: 40, sittingHeight: 78, legLength: 72, birthDate: "2013-03-01",
  phvCategory: "early" as const, phvOffset: -1.2,
};

describe("registeredSex", () => {
  it("F cuenta siempre; M solo con la marca; lo demás ⇒ null", () => {
    expect(registeredSex({ gender: "F" })).toBe("F");
    expect(registeredSex({ gender: "M" })).toBeNull();
    expect(registeredSex({ gender: "M", sexConfirmedAt: CONFIRMED })).toBe("M");
    expect(registeredSex({ gender: "M", sexConfirmedAt: "ayer" })).toBeNull();
    expect(registeredSex({ gender: "X", sexConfirmedAt: CONFIRMED })).toBeNull();
    expect(registeredSex(null)).toBeNull();
  });

  it("pendiente = M sin marca válida", () => {
    expect(sexPendingConfirmation({ gender: "M" })).toBe(true);
    expect(sexPendingConfirmation({ gender: "M", sexConfirmedAt: CONFIRMED })).toBe(false);
    expect(sexPendingConfirmation({ gender: "F" })).toBe(false);
    expect(sexPendingConfirmation({})).toBe(false);
  });

  it("withRegisteredSex quita el M sin confirmar y lo marca; no muta la entrada", () => {
    const raw = { gender: "M", name: "Samu" };
    const v = withRegisteredSex(raw);
    expect(v).not.toHaveProperty("gender");
    expect(v.sexPendingConfirmation).toBe(true);
    expect(raw.gender).toBe("M");
    const ok = { gender: "M", sexConfirmedAt: CONFIRMED };
    expect(withRegisteredSex(ok)).toBe(ok);
  });

  it("sexConfirmationFor: conserva la fecha si no cambia; nueva si cambia o no estaba; nada sin sexo", () => {
    const now = new Date("2026-10-18T12:00:00.000Z");
    expect(sexConfirmationFor("M", { gender: "M", sexConfirmedAt: CONFIRMED }, now)).toBe(CONFIRMED);
    expect(sexConfirmationFor("F", { gender: "M", sexConfirmedAt: CONFIRMED }, now)).toBe(now.toISOString());
    expect(sexConfirmationFor("M", { gender: "M" }, now)).toBe(now.toISOString());
    expect(sexConfirmationFor(null, { gender: "M" }, now)).toBeUndefined();
  });
});

describe("honestPlayerView ⇒ gate del PHV (sin tocar el módulo PHV)", () => {
  it("M sin confirmar con las 6 entradas: bloqueado pidiendo el sexo y sin PHV persistido", () => {
    const v = honestPlayerView({ ...FULL, gender: "M" });
    const g = phvGate(v);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.missing).toContain("sex");
    expect(v).not.toHaveProperty("phvCategory");
    expect(v.sexPendingConfirmation).toBe(true);
  });

  it("M confirmado y F sin marca: el gate abre (control)", () => {
    expect(phvGate(honestPlayerView({ ...FULL, gender: "M", sexConfirmedAt: CONFIRMED })).ok).toBe(true);
    expect(phvGate(honestPlayerView({ ...FULL, gender: "F" })).ok).toBe(true);
  });
});

describe("PHV cacheado de una fila de antropometría (servidor)", () => {
  const row = {
    height_cm: 150, weight_kg: 40, sitting_height_cm: 78, leg_length_cm: 72,
    maturity_offset: -1.2, phv_category: "early", phv_status: "pre_phv", development_window: "x",
    age_source: "birth_date", chronological_age: 13.6,
  };

  it("M sin confirmar ⇒ no fiable con el motivo «por confirmar»; sin sexo ⇒ «Falta: sexo registrado»", () => {
    const t = trustAnthroForPlayer(row, { gender: "M" });
    expect(t.trusted).toBe(false);
    expect(t.gate_reason).toBe(SEX_PENDING_PHV_REASON);
    expect(trustAnthroForPlayer(row, {}).gate_reason).toBe("Falta: sexo registrado");
    const g = gateAnthroForPlayer(row, { gender: "M" });
    expect(g?.phv_category).toBeNull();
    expect(g?.maturity_offset).toBeNull();
    expect(g?.phv_trusted).toBe(false);
  });

  it("con sexo registrado delega en el gate de siempre (mismo resultado)", async () => {
    const { trustAnthropometricsRow } = await import("@/lib/phv/phvGate");
    expect(trustAnthroForPlayer(row, { gender: "F" })).toEqual(trustAnthropometricsRow(row));
    expect(trustAnthroForPlayer(row, { gender: "M", sexConfirmedAt: CONFIRMED })).toEqual(trustAnthropometricsRow(row));
  });
});
