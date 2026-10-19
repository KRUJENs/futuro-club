/**
 * /api/rankings/list — flecha de tendencia (ruta en memoria, cuando la RPC falla).
 *
 * Antes: trending = vsi − vsiHistory[len-2] con banda ±2, sobre el historial legacy SIN
 * fechas ni origen (con el 57.5 fabricado antes de #146). Samu ([57.5, 67.4], vsi 67.4,
 * sin evaluaciones con fecha) recibía ↑ en /rankings mientras el panel de familia y el
 * informe bloqueaban la misma variación. Ahora: vsiTrendArrow (signo de computeVsiDelta);
 * solo los jugadores demo (MOCK con banner) conservan la flecha del historial sembrado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

let userId = "user-rank-0";
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn(async () => ({ userId, error: null })),
}));

import listHandler from "../_list";

const METRICS = { speed: 70, technique: 70, vision: 70, stamina: 70, shooting: 70, defending: 70 };

const ROWS = [
  {
    id: "p-samu",
    updated_at: "2026-09-20T00:00:00.000Z",
    data: { name: "Samu", age: 9, vsi: 67.4, metrics: METRICS, vsiHistory: [57.5, 67.4] },
  },
  {
    id: "p-real",
    updated_at: "2026-09-20T00:00:00.000Z",
    data: {
      name: "Real", age: 9, vsi: 67.4, metrics: METRICS, vsiHistory: [60, 67.4],
      vsiEvaluations: [
        { value: 60, at: "2026-09-01T10:00:00.000Z", source: "players_api" },
        { value: 67.4, at: "2026-09-20T10:00:00.000Z", source: "players_api" },
      ],
    },
  },
  {
    id: "p-demo",
    updated_at: "2026-09-20T00:00:00.000Z",
    data: {
      name: "Demo", age: 9, vsi: 72.4, metrics: METRICS, isDemo: true, vsiHistory: [67, 72],
      vsiEvaluations: [{ value: 72.4, at: "2026-09-01T10:00:00.000Z", source: "demo_seed" }],
    },
  },
  {
    // Blob con isDemo no booleano: no reabre el historial legacy.
    id: "p-fake-demo",
    updated_at: "2026-09-20T00:00:00.000Z",
    data: { name: "Falso", age: 9, vsi: 67.4, metrics: METRICS, isDemo: "true", vsiHistory: [57.5, 67.4] },
  },
];

async function listTrending(): Promise<Record<string, string>> {
  const res = await listHandler(
    new Request("https://example.com/api/rankings/list", { headers: { Authorization: "Bearer test" } }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { players: Array<{ id: string; trending: string }> } };
  return Object.fromEntries(body.data.players.map((p) => [p.id, p.trending]));
}

describe("/api/rankings/list — trending (ruta en memoria)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    // Usuario distinto por test: la ruta en memoria cachea por usuario.
    userId = `user-rank-${Math.random().toString(36).slice(2)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/rpc/get_ranked_players")) {
          return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
        }
        if (url.includes("/rest/v1/players")) return new Response(JSON.stringify(ROWS));
        if (url.includes("/rest/v1/vsi_history_reviews")) return new Response("[]");
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("Samu (legacy [57.5, 67.4], sin evaluaciones con fecha) ⇒ sin flecha", async () => {
    const trending = await listTrending();
    expect(trending["p-samu"]).toBe("stable");
  });

  it("dos evaluaciones reales con fecha ⇒ ↑ (signo de computeVsiDelta)", async () => {
    const trending = await listTrending();
    expect(trending["p-real"]).toBe("up");
  });

  it("solo un jugador demo (isDemo === true) conserva la flecha del historial sembrado", async () => {
    const trending = await listTrending();
    expect(trending["p-demo"]).toBe("up");
    expect(trending["p-fake-demo"]).toBe("stable");
  });
});
