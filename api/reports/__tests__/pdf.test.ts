/**
 * POST /api/reports/pdf — la sección de evolución (antes «Evolución VSI») solo con
 * evaluaciones del entrenador con fecha (src/lib/scoring/vsiDelta.ts#realVsiEvaluations).
 *
 * Antes graficaba `data.vsiHistory` (legacy SIN fechas, con el 57.5 fabricado antes de
 * #146) con etiquetas «#1, #2»: para Samu ([57.5, 67.4]) el PDF mostraba una subida que
 * el panel de familia y el ScoutFeed ya bloquean (invariante #7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-pdf-1", email: "coach@example.com", error: null }),
}));

import pdfHandler from "../_pdf";

const METRICS = { speed: 70, technique: 70, vision: 70, stamina: 70, shooting: 70, defending: 70 };
const EVOLUTION_TITLE = "Evolución de la evaluación del entrenador";

function mockSupabase(playerData: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/subscriptions")) {
      return new Response(JSON.stringify([{ plan: "pro", status: "active" }]));
    }
    if (u.includes("/players?")) {
      return new Response(JSON.stringify([{ data: playerData }]));
    }
    if (u.includes("/player_analyses?")) {
      return new Response(JSON.stringify([]));
    }
    return new Response("[]");
  });
}

async function renderPdf(): Promise<string> {
  const req = new Request("https://example.com/api/reports/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ playerId: "p-samu" }),
  });
  const res = await pdfHandler(req);
  expect(res.status).toBe(200);
  return res.text();
}

describe("/api/reports/pdf — evolución de la evaluación del entrenador solo con evaluaciones con fecha", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("caso Samu (solo vsiHistory legacy [57.5, 67.4]): NO hay sección de evolución ni 57.5", async () => {
    mockSupabase({ name: "Samu", age: 9, vsi: 67.4, metrics: METRICS, vsiHistory: [57.5, 67.4] });
    const html = await renderPdf();
    expect(html).not.toContain(EVOLUTION_TITLE);
    expect(html).not.toContain(">58<"); // Math.round(57.5) como barra
    expect(html).not.toMatch(/>#\d+</); // etiquetas «#1, #2» sin fecha
  });

  it("dos evaluaciones reales con fecha: barras con sus valores y FECHAS (no «#1, #2»)", async () => {
    mockSupabase({
      name: "Samu", age: 9, vsi: 70, metrics: METRICS, vsiHistory: [57.5, 70],
      vsiEvaluations: [
        { value: 60, at: "2026-09-01T10:00:00.000Z", source: "coach_form" },
        { value: 70, at: "2026-09-20T10:00:00.000Z", source: "players_api" },
      ],
    });
    const html = await renderPdf();
    expect(html).toContain(`${EVOLUTION_TITLE} · evaluaciones con fecha`);
    expect(html).not.toContain("Evolución VSI");
    expect(html).toContain("01/09/26");
    expect(html).toContain("20/09/26");
    // Valores de las barras (span de 9px), en orden: 60 → 70; nunca el 57.5 legacy.
    const bars = [...html.matchAll(/font-size:9px;color:#6b7280">(\d+)</g)].map((m) => m[1]);
    expect(bars).toEqual(["60", "70"]);
    expect(html).not.toContain(">58<");
    expect(html).not.toMatch(/>#\d+</); // etiquetas «#1, #2» sin fecha
  });

  it("evaluaciones de semilla demo (no reales): solo queda una real ⇒ sin sección", async () => {
    mockSupabase({
      name: "Demo", age: 12, vsi: 70, metrics: METRICS,
      vsiEvaluations: [
        { value: 60, at: "2026-09-01T10:00:00.000Z", source: "demo_seed" },
        { value: 70, at: "2026-09-20T10:00:00.000Z", source: "coach_form" },
      ],
    });
    const html = await renderPdf();
    expect(html).not.toContain(EVOLUTION_TITLE);
  });
});

// P1 bloque 5b: el VSI de ficha es la EVALUACIÓN DEL ENTRENADOR (6 barras subjetivas).
// Antes el PDF titulaba sus barras «Métricas de Rendimiento» (como medidas del sistema),
// las pintaba aunque estuvieran incompletas y con la clave en inglés, imprimía
// «VITAS Score Index 0.0», «0 años», «0 cm», «0 kg» y «Ambidiestro» si faltaba el dato.
describe("/api/reports/pdf — evaluación del entrenador y datos ausentes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("evaluación completa ⇒ barras rotuladas en español bajo «Evaluación del entrenador», no «Métricas de Rendimiento»", async () => {
    mockSupabase({ name: "Samu", age: 9, vsi: 70, metrics: METRICS, height: 135, weight: 30, foot: "left" });
    const html = await renderPdf();
    expect(html).toContain("Evaluación del entrenador · 6 barras (valoración subjetiva, 0-100)");
    expect(html).not.toContain("Métricas de Rendimiento");
    expect(html).not.toContain("VITAS Score Index");
    expect(html).toContain('<span class="metric-label">Velocidad</span>');
    expect(html).not.toContain('<span class="metric-label">speed</span>');
    expect(html).toContain("70.0");
    expect(html).toContain("9 años");
    expect(html).toContain("135 cm");
    expect(html).toContain("Zurdo");
  });

  it("evaluación incompleta (falta una barra) ⇒ sin barras parciales, con su motivo", async () => {
    mockSupabase({ name: "Leo", age: 11, vsi: 66, metrics: { speed: 70, technique: 70 } });
    const html = await renderPdf();
    expect(html).toContain("Sin evaluación completa del entrenador");
    expect(html).not.toContain('class="metric-label"');
  });

  it("sin evaluar y sin medidas ⇒ «sin evaluar» / «sin registrar», nunca 0 ni «Ambidiestro» por defecto", async () => {
    mockSupabase({ name: "Leo" });
    const html = await renderPdf();
    expect(html).toContain("sin evaluar");
    expect(html).toContain("edad sin registrar");
    expect(html).not.toMatch(/>0\.0</);
    expect(html).not.toContain("0 años");
    expect(html).not.toContain("0 cm");
    expect(html).not.toContain("0 kg");
    expect(html).not.toContain("Ambidiestro");
  });
});
