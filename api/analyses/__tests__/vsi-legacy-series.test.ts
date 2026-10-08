/**
 * GET /api/analyses/reports y GET /api/analyses/share — las filas antiguas de
 * `analyses` (baseline-v1.0) guardaron vsi.trend / vsi.history calculados sobre el
 * vsi_history legacy SIN fechas (con el 57.5 fabricado antes de #146). Se retiran al
 * leer para que AnalysisDashboard (TrendBadge «↗», VsiSparkline «+9.5 pts») y el enlace
 * público que recibe la familia no pinten esa variación (src/lib/scoring/vsiDelta.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.SHARE_SECRET = "share-secret-test";
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 99, limit: 200, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
const mockVerifyAuth = vi.fn();
vi.mock("../../_lib/auth", () => ({ verifyAuth: (...a: unknown[]) => mockVerifyAuth(...a) }));
// Propiedad por creador (la fila la creó user-coach-1); el jugador no se consulta.
vi.mock("../../_lib/ownership", () => ({
  ownsRowOrItsPlayer: vi.fn(async (row: { user_id?: string | null } | null, userId: string | null) =>
    !!row?.user_id && row.user_id === userId,
  ),
}));

const ANALYSIS_ID = "11111111-2222-4333-8444-555555555555";
// Forma real de una fila baseline-v1.0 de Samu.
const STORED_VSI = {
  vsi: 67, tier: "talent", tierLabel: "Talento",
  peer: { percentile: null, peerCount: 0, stratum: "no-data" },
  trend: { slope: 4.75, momentum: "up", confidence: "medium", delta: null, samples: 3 },
  history: [57.5, 67.4, 67],
};
const ANALYSIS_ROW = {
  id: ANALYSIS_ID, status: "completed", vsi: STORED_VSI, phv: null, similarity: null,
  biomechanics: null, completed_at: "2026-08-20T10:00:00Z", player_id: "p-samu",
  video_id: "baseline-p-samu-1", user_id: "user-coach-1", created_at: "2026-08-20T09:59:00Z",
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, order: chain, limit: chain,
        single: async () =>
          table === "analyses" ? { data: structuredClone(ANALYSIS_ROW), error: null }
          : table === "players" ? { data: { name: "Samu", position: "MC", age: 9 }, error: null }
          : { data: null, error: null },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(res, rej),
      });
      return b;
    },
  }),
}));

import reportsHandler from "../reports";
import shareHandler from "../share";
import { hmacSha256Hex } from "../../_lib/edgeCrypto";

function expectLegacySeriesRemoved(vsi: Record<string, unknown>) {
  expect(vsi).not.toHaveProperty("trend");
  expect(vsi).not.toHaveProperty("history");
  expect(JSON.stringify(vsi)).not.toContain("57.5");
  // El resto del VSI del análisis se sirve igual.
  expect(vsi).toMatchObject({ vsi: 67, tierLabel: "Talento", peer: { stratum: "no-data" } });
}

describe("analyses — la serie VSI legacy sin fechas no sale de la API", () => {
  beforeEach(() => {
    mockVerifyAuth.mockReset();
  });

  it("GET /api/analyses/reports (dueño): analysis.vsi sin trend ni history", async () => {
    mockVerifyAuth.mockResolvedValue({ userId: "user-coach-1", error: null });
    const res = await reportsHandler(
      new Request(`https://example.com/api/analyses/reports?analysisId=${ANALYSIS_ID}`, {
        method: "GET",
        headers: { Authorization: "Bearer test" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expectLegacySeriesRemoved(body.data.analysis.vsi);
    expect(body.data.analysis.id).toBe(ANALYSIS_ID);
  });

  it("GET /api/analyses/share (enlace público de la familia): analysis.vsi sin trend ni history", async () => {
    mockVerifyAuth.mockResolvedValue({ userId: null, error: "no token" });
    const exp = Date.now() + 60_000;
    const sig = (await hmacSha256Hex("share-secret-test", `${ANALYSIS_ID}:${exp}`)).slice(0, 32);
    const res = await shareHandler(
      new Request(`https://example.com/api/analyses/share?analysisId=${ANALYSIS_ID}&t=${exp}.${sig}`, {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expectLegacySeriesRemoved(body.data.analysis.vsi);
    expect(body.data.shared).toBe(true);
  });
});
