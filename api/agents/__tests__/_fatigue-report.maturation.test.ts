/**
 * VITAS · /api/agents/fatigue-report SIN maduración registrada (P1 bloque 4, revisión
 * del PR #315). La fila de la sesión trae severidad, zona y alertas calculadas con
 * otros umbrales; si se le pasa al modelo, su texto libre (resumen, recomendaciones)
 * puede repetirlas. Por eso el informe se construye de forma DETERMINISTA y el
 * modelo NO se llama, aunque haya clave de IA.
 * Run: npx vitest run --config vitest.api.config.ts api/agents/__tests__/_fatigue-report.maturation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Con clave de IA: el test demuestra que, sin maduración, aun así no se llama al modelo.
vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});
vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, limit: 100, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "coach-1", error: null }),
}));

import handler, { maturationGatedFatigueReport, MATURATION_UNKNOWN_LABEL } from "../_fatigue-report";

/** Fila «peligrosa»: índice 82 crítico, zona y alertas de adulto, maduración desconocida. */
const LEGACY_ROW = {
  session_date: "2026-09-20",
  total_load: 418.6,
  fatigue_index: 82,
  fatigue_severity: "critical",
  acwr_value: 1.62,
  acwr_zone: "danger",
  alerts: [{ title: "Fatiga Crítica", message: "Índice de fatiga 82/100. Riesgo elevado de lesión." }],
  maturation_band: "post_phv",
  phv_offset: null,
};

/** Palabras de semáforo que no pueden aparecer en ningún texto de un informe sin maduración. */
const TRAFFIC_LIGHT = /\/100|cr[ií]tic|\balt[oa]\b|moderad|\bbaj[oa]\b|[oó]ptim|precauci|peligro|danger|caution|optimal|severe|apto/i;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function call(body: Record<string, unknown>) {
  const res = await handler(
    new Request("https://x.test/api/agents/fatigue-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } };
}

describe("fatigue-report sin maduración registrada", () => {
  it("no llama al modelo y ningún texto del informe lleva semáforo (ni «82/100», ni «crítico», ni zona)", async () => {
    const { status, json } = await call({
      playerId: "p1",
      fatigueReport: LEGACY_ROW,
      fatigueHistory: Array.from({ length: 6 }, (_, i) => ({ date: `2026-09-${10 + i}`, load: 300 })),
    });
    expect(status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.data).toMatchObject({ model: "gated", source: "maturation_unknown" });
    const report = json.data.report as Record<string, Record<string, unknown>>;
    expect(report.estadoActual).toMatchObject({ indice: null, severidad: MATURATION_UNKNOWN_LABEL });
    expect(report.riesgoLesion).toEqual({ nivel: MATURATION_UNKNOWN_LABEL, factores: [], zonasExpuestas: [] });
    // La carga sí: ratio (hay ≥4 sesiones) y carga de la sesión en el resumen.
    expect(report.cargaACWR).toMatchObject({ valor: 1.62, zona: MATURATION_UNKNOWN_LABEL });
    expect(String(report.resumenEjecutivo)).toContain("419 UA");
    expect(JSON.stringify(report)).not.toMatch(TRAFFIC_LIGHT);
  });

  it("con poco historial no da ratio (el de la fila pudo calcularse con menos de 4 sesiones)", () => {
    const r = maturationGatedFatigueReport({ playerId: "p1", fatigueReport: LEGACY_ROW, fatigueHistory: [{}, {}] } as never) as Record<string, Record<string, unknown>>;
    expect(r.cargaACWR.valor).toBeNull();
  });

  it("una carga 0 (DEFAULT de la columna) no se cuenta como carga registrada", () => {
    const r = maturationGatedFatigueReport({ playerId: "p1", fatigueReport: { ...LEGACY_ROW, total_load: 0 } } as never);
    expect(String(r.resumenEjecutivo)).not.toMatch(/UA/);
  });

  it("control positivo: CON maduración registrada sí se llama al modelo", async () => {
    await call({ playerId: "p1", fatigueReport: { ...LEGACY_ROW, phv_offset: 1.6 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.anthropic.com");
  });
});
