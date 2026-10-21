/**
 * VITAS · Tests — /api/agents/phv-calculator · gate único + VSI ajustado honesto
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/_phv-calculator.gate.test.ts
 *
 * Antes (origin/main, _phv-calculator.ts:144-146,163-166): Mirwald con la edad
 * ENTERA del cliente y `adjustVSI(currentVSI ?? 70, category)` con ×1.12 a todo
 * "early" (pre-PHV = un ESTADO) — sin VSI real salía 78.4 / 70 / 64.4 inventados.
 * Ahora: edad DECIMAL desde la fecha de nacimiento (sin ella ⇒ 422), y VSI
 * ajustado SOLO con VSI real y el factor CANÓNICO del motor. La fórmula no cambia.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", error: null }),
}));

import handler from "../_phv-calculator";
import { phvGate } from "../../../src/lib/phv/phvGate";
import { decimalAgeYears } from "../../../src/lib/shared/age";

const FULL = {
  playerId: "p1", chronologicalAge: 14, height: 165, weight: 55, sittingHeight: 85, legLength: 80,
  gender: "M", birthDate: "2012-03-15", measuredAt: "2026-09-01T10:00:00Z",
};

async function call(body: Record<string, unknown>) {
  const res = await handler(
    new Request("https://x.test/api/agents/phv-calculator", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

describe("phv-calculator · gate de entradas", () => {
  it("sin fecha de nacimiento ⇒ 422 phv_missing_birth_date (la edad entera no entra en Mirwald)", async () => {
    const { birthDate: _b, ...noBirth } = FULL;
    const { status, json } = await call(noBirth);
    expect(status).toBe(422);
    expect(JSON.stringify(json)).toContain("phv_missing_birth_date");
  });

  it("sin talla sentado ⇒ 422 phv_incomplete_data (sin estimar ×0.52)", async () => {
    const { status, json } = await call({ ...FULL, sittingHeight: undefined, legLength: undefined });
    expect(status).toBe(422);
    expect(JSON.stringify(json)).toContain("phv_incomplete_data");
  });

  it("sin sexo ⇒ 422 phv_missing_sex (no se asume)", async () => {
    const { status, json } = await call({ ...FULL, gender: undefined });
    expect(status).toBe(422);
    expect(JSON.stringify(json)).toContain("phv_missing_sex");
  });

  it("completo ⇒ usa la edad DECIMAL y el offset del motor canónico en esa edad", async () => {
    const { status, json } = await call(FULL);
    expect(status).toBe(200);
    const data = json.data as Record<string, unknown>;
    const age = decimalAgeYears(FULL.birthDate, FULL.measuredAt)!; // edad en la FECHA DE LA MEDICIÓN
    expect(data.chronologicalAge).toBe(age);
    expect(data.ageSource).toBe("birth_date");
    const g = phvGate(FULL);
    if (!g.ok) throw new Error("gate cerrado");
    expect(data.offset).toBe(g.mirwald.offset);
  });
});

describe("phv-calculator · VSI ajustado", () => {
  it("sin VSI real ⇒ adjustedVSI null + motivo (antes: base fija 70)", async () => {
    const { json } = await call(FULL);
    const data = json.data as Record<string, unknown>;
    expect(data.adjustedVSI).toBeNull();
    expect(String(data.adjustedVSIGateReason)).toContain("Sin VSI real");
  });

  it("con VSI real ⇒ factor CANÓNICO del motor (por timing), no ×1.12 por la categoría de estado", async () => {
    const { json } = await call({ ...FULL, currentVSI: 60 });
    const data = json.data as Record<string, unknown>;
    const g = phvGate(FULL);
    if (!g.ok) throw new Error("gate cerrado");
    const expected = Math.max(0, Math.min(100, Number((60 * g.assessment.adjustmentFactor).toFixed(1))));
    expect(data.adjustedVSI).toBe(expected);
    expect(data.adjustedVSIGateReason).toBeNull();
  });
});
