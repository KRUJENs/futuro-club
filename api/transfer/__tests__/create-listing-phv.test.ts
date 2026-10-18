/**
 * VITAS · Tests — /api/transfer/create-listing · PHV del snapshot desde el gate
 * Run: npx vitest run --config vitest.api.config.ts api/transfer/__tests__/create-listing-phv.test.ts
 *
 * El snapshot de un listing se CONGELA: lo que entra marcado `phvTrusted` se
 * muestra y puntúa para siempre (ListingCard, ListingDetailPage, matchScorer,
 * prompt de smart-match). Antes se copiaba la columna players.phv_category, que
 * hasta aplicar la migración 069 guarda el valor naive legacy (p.ej. Samu 'early')
 * y 069 no limpia los snapshots. Ahora el PHV solo sale de la ÚLTIMA fila de
 * player_anthropometrics que `trustAnthropometricsRow` da por fiable; antes de 069
 * esa fila no tiene age_source ⇒ sin PHV (falla cerrado) y el listing se crea igual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", tenantId: null, error: null }),
}));

/** Columna legacy (antes de 069): categoría naive de un menor sin medidas. */
const LEGACY_PLAYER = { user_id: "coach-1", tenant_id: null, gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", phv_category: "early", phv_offset: -1.2 };
const COMPLETE_ROW = {
  player_id: "samu", height_cm: 158, weight_kg: 46, sitting_height_cm: 80, leg_length_cm: 78,
  chronological_age: 13.33, maturity_offset: -0.91, phv_category: "ontime", phv_status: "during_phv",
};

let latestRow: Record<string, unknown> | null = null;
let latestStatus = 200;
let insertedSnapshot: Record<string, unknown> | null = null;

beforeEach(() => {
  latestRow = null;
  latestStatus = 200;
  insertedSnapshot = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/rest/v1/player_latest_anthropometrics")) {
      if (latestStatus !== 200) return new Response("boom", { status: latestStatus });
      return new Response(JSON.stringify(latestRow ? [latestRow] : []));
    }
    if (u.includes("/rest/v1/players")) {
      // Aunque la columna traiga una categoría, el endpoint NO debe usarla.
      return new Response(JSON.stringify([LEGACY_PLAYER]));
    }
    if (u.includes("/rest/v1/transfer_listings")) {
      const row = JSON.parse(String(init?.body ?? "{}"));
      insertedSnapshot = row.player_snapshot;
      return new Response(JSON.stringify([row]), { status: 201 });
    }
    return new Response("[]");
  });
});
afterEach(() => vi.restoreAllMocks());

async function create(snapshot: Record<string, unknown> = {}) {
  const { default: handler } = await import("../_create-listing");
  const res = await handler(
    new Request("https://x.test/api/transfer/create-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerId: "samu", listingType: "sale", playerSnapshot: snapshot }),
    }),
  );
  return res.status;
}

describe("create-listing · PHV del snapshot solo desde una fila fiable", () => {
  it("columna legacy 'early' + fila sin age_source (antes de 069) ⇒ snapshot SIN PHV", async () => {
    latestRow = { ...COMPLETE_ROW }; // sin age_source: la vista aún no la tiene
    expect(await create({ name: "Samu", phvCategory: "early", phvOffset: -1.2, phvTrusted: true })).toBe(200);
    expect(insertedSnapshot).not.toHaveProperty("phvCategory");
    expect(insertedSnapshot).not.toHaveProperty("phvOffset");
    expect(insertedSnapshot).not.toHaveProperty("phvTrusted");
    expect(insertedSnapshot?.name).toBe("Samu");
  });

  it("sin mediciones ⇒ sin PHV aunque la columna tenga categoría", async () => {
    latestRow = null;
    expect(await create()).toBe(200);
    expect(insertedSnapshot).not.toHaveProperty("phvTrusted");
  });

  it("la lectura de la vista falla ⇒ el listing se crea igual, sin PHV", async () => {
    latestStatus = 500;
    expect(await create()).toBe(200);
    expect(insertedSnapshot).not.toHaveProperty("phvTrusted");
  });

  it("fila COMPLETA con age_source='birth_date' ⇒ PHV de la FILA marcado phvTrusted (no el de la columna)", async () => {
    latestRow = { ...COMPLETE_ROW, age_source: "birth_date" };
    expect(await create()).toBe(200);
    expect(insertedSnapshot).toMatchObject({ phvCategory: "on-time", phvOffset: -0.91, phvTrusted: true });
  });

  it("fila con edad entera (age_source='integer_age') ⇒ sin PHV", async () => {
    latestRow = { ...COMPLETE_ROW, age_source: "integer_age" };
    expect(await create()).toBe(200);
    expect(insertedSnapshot).not.toHaveProperty("phvTrusted");
  });
});
