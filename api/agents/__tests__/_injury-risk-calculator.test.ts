/**
 * VITAS · /api/agents/injury-risk-calculator v2 (P1 bloque 4b)
 *
 * Antes cada factor ausente se rellenaba (ACWR 30, PHV por la EDAD 60, asimetría 20,
 * biomecánica 30, sin historial 5, fatiga 15): con todo vacío salía 24 «bajo» +
 * returnToPlayReady («Apto para actividad completa»). El cliente mandaba age:null
 * y el esquema lo rechazaba (400). Ahora cada factor ausente es null con motivo y
 * el compuesto exige carga + PHV (si aplica) + ≥ 70 % del peso.
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/_injury-risk-calculator.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

import handler, { computeInjuryRisk } from "../_injury-risk-calculator";

beforeEach(() => {
  process.env.CRON_SECRET = "cron-test";
});

const base = { playerId: "p1", injuryHistory: [], sessionsLast28Days: 0, matchesLast7Days: 0 };
const run = (extra: Record<string, unknown>) => computeInjuryRisk({ ...base, ...extra } as never);
const factorOf = (r: ReturnType<typeof run>, k: string) => r.factors.find((f) => f.factor === k)!;

async function call(body: Record<string, unknown>) {
  const res = await handler(
    new Request("https://x.test/api/agents/injury-risk-calculator", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer cron-test" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { data?: { report?: Record<string, unknown> } } };
}

describe("riesgo de lesión · sin datos no hay riesgo", () => {
  it("jugador sin ningún dato → compuesto null con motivo, sin categoría ni recomendaciones (antes 24 «bajo» + apto)", () => {
    const r = run({});
    expect(r.composite.value).toBeNull();
    expect(r.composite.gate_reason).toMatch(/no calculado/);
    expect(r.category).toBeNull();
    expect(r.recommendations).toEqual([]);
    expect(r).not.toHaveProperty("returnToPlayReady");
    expect(r).not.toHaveProperty("overallRisk");
    for (const f of r.factors) {
      expect(f.result.value).toBeNull();
      expect(f.result.gate_reason).toBeTruthy();
    }
  });

  it("age null y edad de sénior se aceptan (antes 400): un adulto no tiene ventana PHV (no aplica, no «ausente»)", async () => {
    expect((await call({ ...base, age: null })).status).toBe(200);
    const senior = await call({ ...base, age: 27 });
    expect(senior.status).toBe(200);
    const phv = (senior.json.data!.report!.factors as Array<Record<string, unknown>>).find((f) => f.factor === "phvWindow")!;
    expect(phv.applicable).toBe(false);
  });

  it("la ventana PHV sale SOLO del offset de la puerta: ni la categoría ni la edad la rellenan (antes 12-14 años → 60)", () => {
    const r = run({ age: 13, phvCategory: "circa_phv", phvOffset: null });
    expect(factorOf(r, "phvWindow").result.value).toBeNull();
    expect(factorOf(r, "phvWindow").result.gate_reason).toMatch(/PHV no calculado/);
  });

  it("un ratio ACWR sin zona no se reclasifica con cortes de adulto (antes > 1.5 → 95)", () => {
    const r = run({ acwrValue: 1.9, acwrZone: null });
    expect(factorOf(r, "acwr").result.value).toBeNull();
  });

  it("biomecánica sin fotogramas ni confianza no cuenta (el motor devuelve 0 por debajo del mínimo)", () => {
    const r = run({ biomechanicsInjuryRisk: 0, asymmetryPct: 0, biomechanicsFrames: 2, biomechanicsConfidence: 0 });
    expect(factorOf(r, "biomechanics").result.value).toBeNull();
    expect(factorOf(r, "asymmetry").result.value).toBeNull();
  });

  it("sin lesiones registradas es AUSENCIA (no «sin lesiones»): null, no 5", () => {
    expect(factorOf(run({}), "injuryHistory").result.value).toBeNull();
  });

  it("falta un obligatorio (carga) aunque el resto cubra mucho peso → null con «imprescindible»", () => {
    const r = run({
      phvOffset: 0.2, asymmetryPct: 10, biomechanicsInjuryRisk: 30, biomechanicsFrames: 20, biomechanicsConfidence: 0.8,
      fatigueIndex: 40, injuryHistory: [{ type: "muscle", severity: "minor", date: "2026-09-01" }],
    });
    expect(r.composite.value).toBeNull();
    expect(r.composite.gate_reason).toMatch(/imprescindible: carga/);
  });
});

describe("riesgo de lesión · con datos suficientes", () => {
  const full = {
    acwrZone: "optimal", acwrValue: 1.05, phvOffset: 0.2, age: 13.4,
    asymmetryPct: 10, biomechanicsInjuryRisk: 30, biomechanicsFrames: 20, biomechanicsConfidence: 0.8,
    fatigueIndex: 40, sessionsLast28Days: 6,
  };

  it("compone SOLO con los presentes (historial ausente fuera del peso): (15·.30 + 90·.25 + 50·.12 + 30·.08 + 40·.10) / .85 = 46", () => {
    const r = run(full);
    expect(r.composite).toMatchObject({ value: 46, provenance: "DERIVADA", calibrated: false, gate_reason: null });
    expect(r.coverage).toBe(0.85);
    expect(r.composite.confidence).toBeCloseTo(0.34, 5); // ORIENTATIVE_CONFIDENCE × cobertura: pesos sin fuente
    expect(r.category).toBe("moderate");
    expect(r.growthShieldLevel).toBe("peak"); // misma definición que el Escudo de Estirón
    expect(factorOf(r, "phvWindow").result.value).toBe(90);
  });

  it("una lesión registrada: se informa de cuándo fue, nunca «apto»", () => {
    const r = run({ ...full, injuryHistory: [{ type: "muscle", severity: "moderate", daysOut: 20, date: "2026-09-20" }], daysSinceLastInjury: 24 });
    expect(r.daysSinceLastInjury).toBe(24);
    expect(r.injuryHistoryCount).toBe(1);
    expect(factorOf(r, "injuryHistory").result.value).toBe(60); // 40 (< 30 días) + 10 (≤ 12 meses) + 10 (moderada > 14 días) — no 5
    expect(r).not.toHaveProperty("returnToPlayReady");
  });
});
