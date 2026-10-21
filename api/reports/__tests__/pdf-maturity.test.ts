/**
 * VITAS · Tests — /api/reports/pdf · rótulo de maduración por el gate único
 * Run: npx vitest run --config vitest.api.config.ts api/reports/__tests__/pdf-maturity.test.ts
 *
 * Antes (origin/main, _pdf.ts:60,218): se leía el phvCategory PERSISTIDO del blob
 * y se rotulaba "early" (= pre-PHV, un ESTADO) como «Tardía», y cualquier valor
 * ausente como «Precoz». Ahora: fase por estado SOLO con todas las entradas
 * introducidas; si falta alguna, «PHV no disponible · Falta: …».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", email: "coach@test.dev", error: null }),
}));

import pdfHandler from "../_pdf";
import { phvGate, PHV_STATUS_LABEL_ES } from "../../../src/lib/phv/phvGate";

let blob: Record<string, unknown> = {};

function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/subscriptions")) return new Response(JSON.stringify([{ plan: "pro", status: "active" }]));
    if (u.includes("/players")) return new Response(JSON.stringify([{ data: blob }]));
    if (u.includes("/player_analyses")) return new Response(JSON.stringify([]));
    return new Response("[]");
  });
}

async function maturityCell(): Promise<string> {
  const res = await pdfHandler(
    new Request("https://x.test/api/reports/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerId: "samu" }),
    }),
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = html.match(/<div class="label">Maduración<\/div><div class="value">([^<]*)<\/div>/);
  expect(m).not.toBeNull();
  return m![1];
}

const BASE = {
  name: "Samu", age: 9, position: "DC", foot: "right", vsi: 67.4, height: 135, weight: 30, gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z",
  metrics: { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 },
};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

describe("PDF · Maduración", () => {
  it("phvCategory 'early' persistido SIN medidas completas ⇒ «PHV no disponible · Falta: …», nunca «Tardía»", async () => {
    blob = { ...BASE, phvCategory: "early", phvOffset: -1.2 };
    const cell = await maturityCell();
    expect(cell).toContain("PHV no disponible");
    expect(cell).toContain("Falta: talla sentado, longitud de pierna, fecha de nacimiento del jugador");
    expect(cell).not.toMatch(/Tardía|Precoz|En fase/);
  });

  it("sin categoría ⇒ ya no se imprime «Precoz» por defecto", async () => {
    blob = { ...BASE };
    const cell = await maturityCell();
    expect(cell).not.toContain("Precoz");
    expect(cell).toContain("PHV no disponible");
  });

  it("entradas completas ⇒ fase por ESTADO del gate (no un timing vs pares)", async () => {
    const complete = { height: 165, weight: 55, sittingHeight: 85, legLength: 80, birthDate: "2012-03-15", gender: "M", sexConfirmedAt: "2026-01-01T00:00:00.000Z", measuredAt: "2026-09-01T10:00:00.000Z" };
    blob = { ...BASE, ...complete, phvCategory: "late" };
    const g = phvGate(complete);
    if (!g.ok) throw new Error("gate cerrado");
    const cell = await maturityCell();
    expect(cell).toBe(PHV_STATUS_LABEL_ES[g.category]);
  });
});
