/**
 * VITAS · Tests — /api/benchmark/peer · percentil entre los PROPIOS jugadores (P1 bloque 5)
 * Run: npx vitest run --config vitest.api.config.ts api/benchmark/__tests__/peer.test.ts
 *
 * Antes: pool «cross-club» de TODAS las cuentas (service key sin filtro de dueño); el
 * valor ausente del propio jugador valía 0 ⇒ «P0» que veía su familia
 * (ParentDashboardPage); el mínimo de 10 se contaba sobre FILAS (evaluadas o no); las
 * barras salían de las columnas metric_*, que valen 0 para quien no está evaluado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "owner-1", error: null }),
}));
vi.mock("../../_lib/ownership", () => ({ ownsPlayer: vi.fn().mockResolvedValue(true) }));

type Pool = Array<{ id?: string; vsi: number | null; metrics: Record<string, number> | null; is_demo: string | null }>;
let target: Record<string, unknown> = {};
let pool: Pool = [];
const filters: Array<[string, string, unknown]> = [];
const selects: string[] = [];
// Filas `pending` de vsi_history_reviews (070, D3).
let pendingRows: Array<{ player_id: string }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      if (table === "vsi_history_reviews") {
        Object.assign(b, {
          select: () => b,
          eq: () => Promise.resolve({ data: pendingRows, error: null }),
        });
        return b;
      }
      const rec = (op: string) => (col: string, val: unknown) => { filters.push([op, col, val]); return b; };
      Object.assign(b, {
        select: (cols: string) => { selects.push(cols); return b; },
        eq: rec("eq"), neq: rec("neq"), gte: rec("gte"), lte: rec("lte"),
        single: async () => ({ data: target, error: null }),
        limit: async () => ({ data: pool, error: null }),
      });
      return b;
    },
  }),
}));

import handler from "../peer";

const BARS = { speed: 70, technique: 70, vision: 65, stamina: 65, shooting: 60, defending: 55 };

function evaluatedPeers(n: number, base = 50): Pool {
  return Array.from({ length: n }, (_, i) => ({
    id: `peer-${i}`,
    vsi: base + i,
    metrics: { speed: base + i, technique: base + i, vision: base + i, stamina: base + i, shooting: base + i, defending: base + i },
    is_demo: null,
  }));
}

interface PeerMetricJson {
  percentile: { value: number | null; provenance: string };
  gate: { code: string; peers: number; min: number } | null;
  distribution: Record<string, number> | null;
}
interface PeerJson {
  vsi: PeerMetricJson;
  byMetric: Record<string, PeerMetricJson>;
  minPeers: number;
  scope: string;
}

async function get(): Promise<{ status: number; data: PeerJson }> {
  const res = await handler(
    new Request("https://x.test/api/benchmark/peer?playerId=leo", { headers: { Authorization: "Bearer jwt" } }),
  );
  const json = (await res.json()) as { data: PeerJson };
  return { status: res.status, data: json.data };
}

beforeEach(() => {
  filters.length = 0;
  selects.length = 0;
  pendingRows = [];
  target = { id: "leo", user_id: "owner-1", age: 11, position: "RW", phv_category: null, vsi: 61.4, metrics: BARS, is_demo: null };
  pool = evaluatedPeers(10);
});

describe("/api/benchmark/peer · solo jugadores propios, mínimo 10 pares, sin P0 fabricado", () => {
  it("la población se filtra por el DUEÑO del jugador (antes: todas las cuentas)", async () => {
    await get();
    expect(filters).toContainEqual(["eq", "user_id", "owner-1"]);
    expect(filters).toContainEqual(["neq", "id", "leo"]);
  });

  it("las barras se leen del blob, nunca de las columnas metric_* (0 sin evaluar)", async () => {
    await get();
    for (const cols of selects) {
      expect(cols).toContain("metrics:data->metrics");
      expect(cols).not.toMatch(/metric_(speed|technique|vision|stamina|shooting|defending)/);
    }
  });

  it("jugador SIN evaluar ⇒ sin percentil y con motivo (antes: su 0 daba «P0»)", async () => {
    target = { ...target, vsi: null, metrics: null };
    const { status, data } = await get();
    expect(status).toBe(200);
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate).toEqual({ code: "not_evaluated", peers: 10, min: 10 });
    expect(data.vsi.distribution).toBeNull();
    expect(data.byMetric.speed.percentile.value).toBeNull();
    expect(data.byMetric.speed.gate?.code).toBe("not_evaluated");
  });

  it("menos de 10 pares EVALUADOS ⇒ sin percentil (los no evaluados no cuentan para el mínimo)", async () => {
    pool = [...evaluatedPeers(9), ...Array.from({ length: 6 }, () => ({ vsi: null, metrics: null, is_demo: null }))];
    const { data } = await get();
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate).toEqual({ code: "insufficient_peers", peers: 9, min: 10 });
  });

  it("10 pares evaluados ⇒ percentil de punto medio, DERIVADA, con su distribución", async () => {
    const { data } = await get();
    // 61.4 frente a 50..59 ⇒ los 10 por debajo
    expect(data.vsi.percentile.value).toBe(100);
    expect(data.vsi.percentile.provenance).toBe("DERIVADA");
    expect(data.vsi.gate).toBeNull();
    expect(data.vsi.distribution).toMatchObject({ p50: 54.5 }); // mediana de 50..59
    expect(data.minPeers).toBe(10);
    expect(data.scope).toBe("owner_only");
  });

  it("una barra concreta sin evaluar ⇒ esa barra sin percentil (no un 0)", async () => {
    target = { ...target, metrics: { ...BARS, defending: undefined } };
    const { data } = await get();
    expect(data.byMetric.defending.percentile.value).toBeNull();
    expect(data.byMetric.defending.gate?.code).toBe("not_evaluated");
    expect(data.byMetric.speed.percentile.value).not.toBeNull();
  });

  it("los jugadores de ejemplo no son pares de un jugador real", async () => {
    pool = evaluatedPeers(10).map((p) => ({ ...p, is_demo: "true" }));
    const { data } = await get();
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate).toEqual({ code: "insufficient_peers", peers: 0, min: 10 });
  });

  it("un VSI vacío o no numérico (texto de PostgREST) es ausencia, no 0", async () => {
    target = { ...target, vsi: "" };
    const { data } = await get();
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate?.code).toBe("not_evaluated");
  });

  it("jugador sin dueño registrado ⇒ 409, nunca se cae a un pool global", async () => {
    target = { ...target, user_id: null };
    const { status } = await get();
    expect(status).toBe(409);
  });

  it("D3: un par con revisión VSI pendiente (57,5) no cuenta; control positivo con la revisión hecha", async () => {
    pool = evaluatedPeers(10);
    expect((await get()).data.vsi.percentile.value).not.toBeNull(); // 10 pares ⇒ hay percentil
    pendingRows = [{ player_id: "peer-3" }];
    const { data } = await get();
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate).toEqual({ code: "insufficient_peers", peers: 9, min: 10 });
  });

  it("D3: el propio jugador con revisión pendiente no está evaluado (ni VSI ni barras)", async () => {
    pendingRows = [{ player_id: "leo" }];
    const { data } = await get();
    expect(data.vsi.percentile.value).toBeNull();
    expect(data.vsi.gate?.code).toBe("not_evaluated");
    expect(data.byMetric.speed.gate?.code).toBe("not_evaluated");
  });
});
