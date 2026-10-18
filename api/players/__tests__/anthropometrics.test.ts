/**
 * VITAS · Tests — /api/players/anthropometrics · Mirwald con EDAD DECIMAL
 * Run: npx vitest run --config vitest.api.config.ts api/players/__tests__/anthropometrics.test.ts
 *
 * Regla del owner (28-sep): el PHV solo se calcula con todas las entradas
 * introducidas, incluida la edad EXACTA desde la fecha de nacimiento del jugador.
 * Antes el endpoint metía el entero `player.age` en Mirwald
 * (PlayerPhvSection.tsx:99 → anthropometrics.ts:336,354) y persistía
 * players.phv_category/phv_offset calculados así (anthropometrics.ts:370-377).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decimalAgeYears } from "../../../src/lib/shared/age";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", error: null }),
}));
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: vi.fn().mockResolvedValue(true) }));

type Row = Record<string, unknown> | null;
let tables: Record<string, Row> = {};
let inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
let updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** Simula la BD SIN la migración 069 aplicada (no existen age_source/phv_gate_reason). */
let pre069 = false;
/** Resultado de maybeSingle() por tabla cuando difiere de single() (p.ej. tras un DELETE). */
let maybeSingleOverride: Record<string, Row> = {};

function chainFor(table: string) {
  let inserted: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: self,
    order: self,
    limit: self,
    insert: (values: Record<string, unknown>) => {
      inserted = values;
      inserts.push({ table, values });
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return chain;
    },
    delete: self,
    single: async () => {
      if (pre069 && inserted && "age_source" in inserted) {
        return { data: null, error: { message: "Could not find the 'age_source' column of 'player_anthropometrics' in the schema cache" } };
      }
      return { data: inserted ? { id: "row-1", ...inserted } : tables[table] ?? null, error: null };
    },
    maybeSingle: async () => ({
      data: table in maybeSingleOverride ? maybeSingleOverride[table] : tables[table] ?? null,
      error: null,
    }),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve, reject),
  });
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chainFor(t) }),
}));

const BIRTH = "2012-03-15";

function post(body: Record<string, unknown>) {
  return new Request("https://x.test/api/players/anthropometrics", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify(body),
  });
}

const MEASURE = { playerId: "p1", heightCm: 165, weightKg: 55, sittingHeightCm: 85, legLengthCm: 80, chronologicalAge: 14 };

async function run(body: Record<string, unknown>) {
  const { default: handler } = await import("../anthropometrics");
  const res = await handler(post(body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const anthroInsert = () => inserts.find((i) => i.table === "player_anthropometrics")?.values ?? {};
const playersUpdate = () => updates.filter((u) => u.table === "players").pop()?.values ?? {};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  inserts = [];
  updates = [];
  pre069 = false;
  maybeSingleOverride = {};
  tables = {
    players: { tenant_id: "t1", birth_date: null, data: { birthDate: BIRTH, gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z" } },
  };
});

describe("anthropometrics POST · edad decimal desde la fecha de nacimiento", () => {
  it("guarda la edad DECIMAL usada (no el entero 14) y marca age_source='birth_date'", async () => {
    const before = decimalAgeYears(BIRTH)!;
    const { status } = await run(MEASURE);
    expect(status).toBe(200);
    const row = anthroInsert();
    expect(row.age_source).toBe("birth_date");
    expect(row.chronological_age).not.toBe(14);
    expect(Math.abs((row.chronological_age as number) - before)).toBeLessThan(0.02);
    expect(typeof row.maturity_offset).toBe("number");
    expect(row.phv_gate_reason).toBeNull();
    // El player record recibe la categoría calculada con la edad decimal.
    expect(playersUpdate().phv_offset).toBe(row.maturity_offset);
  });

  it("el offset coincide con Mirwald evaluado en la edad decimal, no en la entera", async () => {
    const { json } = await run(MEASURE);
    const phv = (json.data as Record<string, unknown>).phv as { offset: number };
    const { computeMirwald } = await import("../../../src/lib/phv/mirwald");
    const age = anthroInsert().chronological_age as number;
    const expected = computeMirwald({ chronologicalAge: age, height: 165, weight: 55, gender: "M", sittingHeight: 85, legLength: 80 });
    expect(phv.offset).toBe(expected.offset);
    const integer = computeMirwald({ chronologicalAge: 14, height: 165, weight: 55, gender: "M", sittingHeight: 85, legLength: 80 });
    expect(phv.offset).not.toBe(integer.offset);
  });

  it("birthDate del body tiene prioridad sobre la del jugador", async () => {
    await run({ ...MEASURE, birthDate: "2013-09-01" });
    const age = anthroInsert().chronological_age as number;
    expect(Math.abs(age - decimalAgeYears("2013-09-01")!)).toBeLessThan(0.02);
  });

  it("SIN fecha de nacimiento → PHV bloqueado con motivo; la medida se guarda con la edad entera marcada", async () => {
    tables.players = { tenant_id: "t1", birth_date: null, data: { gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z" } };
    const { status, json } = await run(MEASURE);
    expect(status).toBe(200);
    const row = anthroInsert();
    expect(row.maturity_offset).toBeNull();
    expect(row.phv_category).toBeNull();
    expect(row.age_source).toBe("integer_age");
    expect(row.chronological_age).toBe(14);
    expect(String(row.phv_gate_reason)).toContain("fecha de nacimiento");
    const gate = (json.data as Record<string, unknown>).phvGate as { ok: boolean; missing: string[] };
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual(["birthDate"]);
    // No re-contamina players.phv_category.
    expect(playersUpdate().phv_category).toBeNull();
    expect(playersUpdate().phv_offset).toBeNull();
  });

  it("sin sexo registrado → bloqueado (no se asume masculino)", async () => {
    tables.players = { tenant_id: "t1", birth_date: null, data: { birthDate: BIRTH } };
    await run(MEASURE);
    const row = anthroInsert();
    expect(row.maturity_offset).toBeNull();
    expect(String(row.phv_gate_reason)).toContain("sexo registrado");
  });

  it("«M» guardado SIN confirmar (posible valor por defecto antiguo) → bloqueado, aunque el cuerpo mande gender M (P1 bloque 7)", async () => {
    tables.players = { tenant_id: "t1", birth_date: null, data: { birthDate: BIRTH, gender: "M" } };
    await run({ ...MEASURE, gender: "M" });
    const row = anthroInsert();
    expect(row.maturity_offset).toBeNull();
    expect(row.phv_category).toBeNull();
    expect(String(row.phv_gate_reason)).toContain("sexo registrado");
  });

  it("sin talla sentado → bloqueado", async () => {
    await run({ ...MEASURE, sittingHeightCm: undefined, legLengthCm: undefined });
    const row = anthroInsert();
    expect(row.maturity_offset).toBeNull();
    expect(row.phv_gate_reason).toBe("Falta: talla sentado, longitud de pierna");
  });

  it("sin la migración 069 aplicada la medida se guarda igual (reintento sin columnas nuevas)", async () => {
    pre069 = true;
    const { status } = await run(MEASURE);
    expect(status).toBe(200);
    const anthro = inserts.filter((i) => i.table === "player_anthropometrics");
    expect(anthro.length).toBe(2);
    expect(anthro[1].values).not.toHaveProperty("age_source");
    expect(anthro[1].values).not.toHaveProperty("phv_gate_reason");
    // La edad guardada sigue siendo la DECIMAL.
    expect(anthro[1].values.chronological_age).not.toBe(14);
    // La fila guardada NO es fiable (sin age_source) ⇒ la columna players.phv_* no
    // recibe PHV: nunca va por delante de una fila que la respalde.
    expect(playersUpdate().phv_category).toBeNull();
    expect(playersUpdate().phv_offset).toBeNull();
  });

  it("fecha de nacimiento que da edad < 5 → 400 (no se inserta)", async () => {
    const { status } = await run({ ...MEASURE, birthDate: "2024-01-01" });
    expect(status).toBe(400);
    expect(inserts.length).toBe(0);
  });
});

describe("anthropometrics DELETE · el PHV de la columna no sobrevive a su fila", () => {
  async function del(id: string) {
    const { default: handler } = await import("../anthropometrics");
    const res = await handler(
      new Request(`https://x.test/api/players/anthropometrics?id=${id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer user-jwt" },
      }),
    );
    return res.status;
  }

  it("borrar la ÚLTIMA medición anula players.phv_category/phv_offset", async () => {
    tables.player_anthropometrics = { player_id: "p1" };
    maybeSingleOverride.player_anthropometrics = null; // no quedan filas
    expect(await del("row-9")).toBe(200);
    const u = playersUpdate();
    expect(u).toHaveProperty("phv_category", null);
    expect(u).toHaveProperty("phv_offset", null);
  });

  it("si queda una fila antigua (sin age_source) la columna tampoco recibe su PHV", async () => {
    tables.player_anthropometrics = { player_id: "p1" };
    maybeSingleOverride.player_anthropometrics = {
      player_id: "p1", height_cm: 160, weight_kg: 50, sitting_height_cm: 82, leg_length_cm: 78,
      chronological_age: 13, maturity_offset: -1.2, phv_category: "early",
    };
    expect(await del("row-9")).toBe(200);
    expect(playersUpdate().phv_category).toBeNull();
    expect(playersUpdate().phv_offset).toBeNull();
  });
});
