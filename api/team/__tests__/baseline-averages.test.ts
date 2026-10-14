/**
 * /api/team/baseline-analysis · medias de la evaluación del entrenador SOLO sobre los
 * evaluados, leídas del blob (P1 bloque 5).
 *
 * Antes: `metric_* || 0` dividido entre TODA la plantilla. Las columnas metric_* valen 0
 * para quien no está evaluado (trigger 069 + DEFAULT 0 de la 024), así que con un
 * jugador de 70 y otro sin evaluar el modelo leía «Velocidad: 35».
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "k";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn(async () => false),
  budgetExceededResponse: vi.fn(() => new Response("{}", { status: 429 })),
  recordSpendUsd: vi.fn(async () => undefined),
}));

type Mod = typeof import("../baseline-analysis");
let teamProfileBlock: Mod["teamProfileBlock"];
beforeAll(async () => {
  ({ teamProfileBlock } = await import("../baseline-analysis"));
});

function p(id: string, metrics: Record<string, number> | null, vsi: number | null): Parameters<Mod["teamProfileBlock"]>[0][number] {
  return { id, name: id, age: 12, position: "MC", vsi, phv_category: null, metrics, height_cm: null, weight_kg: null };
}

const FULL = { speed: 70, technique: 60, vision: 50, stamina: 80, shooting: 40, defending: 30 };

describe("teamProfileBlock · medias de la evaluación del entrenador", () => {
  it("un jugador sin evaluar no baja la media (70, no 35) y se declara cuántos cuentan", () => {
    const txt = teamProfileBlock([p("a", FULL, 55), p("b", null, null)], "Alevín A");
    expect(txt).toContain("Velocidad: 70 (1 de 2 evaluados)");
    expect(txt).not.toContain("Velocidad: 35");
    expect(txt).toContain("EVALUACIÓN DEL ENTRENADOR");
  });

  it("ningún evaluado ⇒ «sin evaluar», nunca 0", () => {
    const txt = teamProfileBlock([p("a", null, null), p("b", null, null)], "Alevín A");
    expect(txt).toContain("Velocidad: sin evaluar");
    expect(txt).not.toMatch(/Velocidad: 0\b/);
  });

  it("una barra ausente en un jugador solo saca a ese jugador de ESA media", () => {
    const partial = { ...FULL, defending: undefined } as unknown as Record<string, number>;
    const txt = teamProfileBlock([p("a", FULL, 55), p("b", { ...partial, speed: 50 }, 50)], "Alevín A");
    expect(txt).toContain("Velocidad: 60 (2 de 2 evaluados)");
    expect(txt).toContain("Defensa: 30 (1 de 2 evaluados)");
  });
});
