/**
 * P1 bloque 7, punto 11 — un «M» guardado sin confirmar (valor por defecto antiguo de la
 * 024 y del cliente/API anteriores al 20 ago) no entra al cálculo de maduración: el PHV
 * queda bloqueado pidiendo confirmar el sexo. «F» nunca fue valor por defecto.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { computeMirwald } from "@/lib/phv/mirwald";
import {
  registeredSex,
  sexConfirmationFor,
  sexPendingConfirmation,
  withRegisteredSex,
} from "@/lib/shared/registeredSex";
import { honestPlayerView } from "@/lib/players/honestPlayerView";
import { phvGate } from "@/lib/phv/phvGate";
import {
  gateAnthroForPlayer,
  phvColumnsForPlayer,
  rowComputedWithSex,
  SEX_MISMATCH_PHV_REASON,
  SEX_PENDING_PHV_REASON,
  trustAnthroForPlayer,
} from "@/lib/shared/sexGatedAnthro";

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
  // Fila REAL calculada como varón: offset = Mirwald masculino sobre sus propias medidas.
  const maleOffset = Number(
    computeMirwald({ chronologicalAge: 13.6, height: 150, weight: 40, gender: "M", sittingHeight: 78, legLength: 72 }).offset.toFixed(2),
  );
  const row = {
    height_cm: 150, weight_kg: 40, sitting_height_cm: 78, leg_length_cm: 72,
    maturity_offset: maleOffset, phv_category: "early", phv_status: "pre_phv", development_window: "critical",
    age_source: "birth_date", chronological_age: 13.6,
  };

  it("B1 · fila calculada como varón y sexo confirmado «F» ⇒ no fiable (no se arrastra la fórmula masculina)", () => {
    const t = trustAnthroForPlayer(row, { gender: "F" });
    expect(t.trusted).toBe(false);
    expect(t.gate_reason).toBe(SEX_MISMATCH_PHV_REASON);
    // Código propio: la UI dice «vuelve a guardarla», no «falta el sexo» (que ya está).
    expect(t.code).toBe("sex_mismatch");
    expect(t.missing).toEqual([]);
    expect(gateAnthroForPlayer(row, { gender: "F", sexConfirmedAt: CONFIRMED })?.phv_category).toBeNull();
    expect(rowComputedWithSex(row, "M")).toBe(true);
    expect(rowComputedWithSex(row, "F")).toBe(false);
  });

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

  it("con el MISMO sexo con el que se calculó delega en el gate de siempre (mismo resultado, inv #4)", async () => {
    const { trustAnthropometricsRow } = await import("@/lib/phv/phvGate");
    const t = trustAnthroForPlayer(row, { gender: "M", sexConfirmedAt: CONFIRMED });
    expect(t).toEqual(trustAnthropometricsRow(row));
    expect(t.trusted).toBe(true);
  });

  it("rama «F»: fila calculada como mujer (redondeo del guardado) con «F» registrado ⇒ fiable e idéntica", async () => {
    const { trustAnthropometricsRow } = await import("@/lib/phv/phvGate");
    const femaleOffset = Number(
      computeMirwald({ chronologicalAge: 13.6, height: 150, weight: 40, gender: "F", sittingHeight: 78, legLength: 72 }).offset.toFixed(2),
    );
    const fRow = { ...row, maturity_offset: femaleOffset };
    const t = trustAnthroForPlayer(fRow, { gender: "F" });
    expect(t.trusted).toBe(true);
    expect(t).toEqual(trustAnthropometricsRow(fRow));
    expect(rowComputedWithSex(fRow, "M")).toBe(false);
  });
});

describe("columnas players.phv_* (B2)", () => {
  it("sin sexo registrado ⇒ PHV null; con sexo registrado se conserva; los campos de sexo no viajan", () => {
    const pending = phvColumnsForPlayer({ name: "A", phv_category: "early", phv_offset: -1.2, gender: "M" });
    expect(pending).toEqual({ name: "A", phv_category: null, phv_offset: null });
    const ok = phvColumnsForPlayer({ name: "B", phv_category: "late", phv_offset: 1.1, gender: "F", sexConfirmedAt: null });
    expect(ok).toEqual({ name: "B", phv_category: "late", phv_offset: 1.1 });
  });
});

describe("los que ESCRIBEN no borran el sexo guardado (M1)", () => {
  beforeEach(() => localStorage.clear());

  it("estático: quien reescribe la lista de jugadores parte del crudo (getAllRaw), nunca de getAll()", () => {
    const SRC = import.meta.glob(
      ["/src/components/PositionDiscoveryBanner.tsx", "/src/pages/PlayerForm.tsx", "/src/services/real/supabasePlayerService.ts"],
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;
    for (const f of ["/src/components/PositionDiscoveryBanner.tsx", "/src/pages/PlayerForm.tsx"]) {
      expect(SRC[f]).toMatch(/PlayerService\.getAllRaw\(\)/);
      expect(SRC[f]).not.toMatch(/PlayerService\.getAll\(\)/);
    }
    expect(SRC["/src/services/real/supabasePlayerService.ts"]).toMatch(/const players = PlayerService\.getAllRaw\(\)/);
  });

  it("update de otro jugador conserva el «M» sin confirmar en el almacenamiento y no persiste la marca de la vista", async () => {
    const { PlayerService } = await import("@/services/real/playerService");
    const { StorageService } = await import("@/services/real/storageService");
    StorageService.set("players", [
      { id: "a", name: "Pendiente", age: 12, position: "MC", gender: "M", vsi: null, vsiHistory: [], createdAt: "x", updatedAt: "x" },
      { id: "b", name: "Otro", age: 12, position: "MC", gender: "F", vsi: null, vsiHistory: [], createdAt: "x", updatedAt: "x" },
    ]);
    expect(PlayerService.getById("a")?.sexPendingConfirmation).toBe(true); // vista de lectura
    await PlayerService.update("b", { height: 151 });
    const stored = StorageService.get<Array<Record<string, unknown>>>("players", []);
    const a = stored.find((p) => p.id === "a")!;
    expect(a.gender).toBe("M");
    expect(a).not.toHaveProperty("sexPendingConfirmation");
  });
});
