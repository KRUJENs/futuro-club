/**
 * P2 bloque 10 (D11) — GET /api/players/maturity-export: solo el dueño; menor sin
 * consentimiento activo ⇒ 403 sin leer la medición; con todo ⇒ solo el contrato mínimo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { phvGate } from "../../../src/lib/phv/phvGate";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({ verifyAuth: vi.fn(async () => ({ userId: "owner-1", error: null })) }));
const mockOwns = vi.fn();
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: (...a: unknown[]) => mockOwns(...a) }));
const mockConsent = vi.fn();
vi.mock("../../_lib/analysisConsentGate", () => ({ hasActiveParentalConsent: (...a: unknown[]) => mockConsent(...a) }));

const BIRTH = "2013-03-01";
const MEASURED = "2026-09-01T10:00:00Z";
const INPUTS = { height: 160, weight: 48, sittingHeight: 83, legLength: 77 };
const g = phvGate({ ...INPUTS, birthDate: BIRTH, gender: "M" }, MEASURED);
if (!g.ok) throw new Error("fixture");
const ROW = {
  height_cm: 160, weight_kg: 48, sitting_height_cm: 83, leg_length_cm: 77, chronological_age: g.ageYears,
  age_source: "birth_date", maturity_offset: g.offset.value, phv_category: g.category, measured_at: MEASURED,
};
const tablesRead: string[] = [];
let playerBirth: string | null = BIRTH;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      tablesRead.push(table);
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain,
        single: async () => ({ data: { birth_date: playerBirth, data: { gender: "M", sexConfirmedAt: "2026-08-01T00:00:00Z", name: "Leo", vsi: 70 } }, error: null }),
        maybeSingle: async () => ({ data: ROW, error: null }),
      });
      return b;
    },
  }),
}));

import handler from "../_maturity-export";

const get = () =>
  handler(new Request("https://x.test/api/players/maturity-export?playerId=p1", { headers: { Authorization: "Bearer jwt" } }));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  mockOwns.mockReset().mockResolvedValue(true);
  mockConsent.mockReset().mockResolvedValue(true);
  tablesRead.length = 0;
  playerBirth = BIRTH;
});

describe("GET /api/players/maturity-export", () => {
  it("no es el dueño ⇒ 403 y no se lee nada", async () => {
    mockOwns.mockResolvedValue(false);
    expect((await get()).status).toBe(403);
    expect(tablesRead).toEqual([]);
  });

  it("menor sin consentimiento activo ⇒ 403 consent_required, sin leer la medición", async () => {
    mockConsent.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorDetail: { code: string } };
    expect(body.errorDetail.code).toBe("consent_required");
    expect(tablesRead).not.toContain("player_latest_anthropometrics");
  });

  it("fallo al leer el consentimiento ⇒ 500 (falla cerrado)", async () => {
    mockConsent.mockRejectedValue(new Error("db down"));
    expect((await get()).status).toBe(500);
  });

  it("edad desconocida ⇒ también exige el consentimiento (403 sin él)", async () => {
    playerBirth = null;
    mockConsent.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorDetail: { code: string } }).errorDetail.code).toBe("consent_required");
    expect(mockConsent).toHaveBeenCalled();
  });

  it("adulto ⇒ no se consulta el consentimiento", async () => {
    playerBirth = "2000-01-01";
    const res = await get();
    expect(mockConsent).not.toHaveBeenCalled();
    // La fila de prueba es de un niño: con fecha de adulto el gate no la reproduce ⇒ 422, nunca 500.
    expect(res.status).toBe(422);
  });

  it("error de la base ⇒ mensaje genérico, nunca el texto crudo", async () => {
    mockConsent.mockRejectedValue(new Error("relation parental_consents secret detail"));
    const res = await get();
    expect(JSON.stringify(await res.json())).not.toMatch(/secret detail/);
  });

  it("control positivo: dueño + consentimiento ⇒ solo el contrato (sin nombre, VSI ni medidas)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(["measured_at", "phv_date", "player_id", "schema", "status"]);
    expect((data.status as { value: string }).value).toBe(g.status);
    expect(JSON.stringify(data)).not.toMatch(/Leo|vsi|height|weight/);
  });
});
