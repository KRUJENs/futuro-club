/**
 * Tests · GET /api/wellbeing/dropout-risk tras extraer la construcción de entradas a
 * api/_lib/dropoutAssessment.ts (compartida con el digest al director, inv #7).
 * Contrato que se mantiene: sin señal real → source "insufficient_data" y NADA se
 * persiste; con señal real → "computed" y se persiste la MISMA cifra que calcula la
 * función compartida.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.CRON_SECRET = "cron-secret";

import { computeDropoutAssessment, type DropoutSignalRows } from "../../_lib/dropoutAssessment";

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../_dropout-risk")).default;
});

type Row = Record<string, unknown>;
let signals: Partial<DropoutSignalRows> = {};
const calls: Array<{ url: string; method: string; body: string | null }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
  if (method !== "GET") return new Response(null, { status: 201 });
  const pick = (rows: Row[] | undefined) => new Response(JSON.stringify(rows ?? []), { status: 200 });
  if (url.includes("/rest/v1/attendance_records?")) return pick(signals.attendance);
  if (url.includes("/rest/v1/engagement_snapshots?")) return pick(signals.engagement);
  if (url.includes("/rest/v1/fatigue_sessions?")) return pick(signals.fatigue);
  return new Response("unexpected", { status: 500 });
});
vi.stubGlobal("fetch", fetchMock);

const req = (playerId: string) =>
  new Request(`https://example.com/api/wellbeing/dropout-risk?playerId=${encodeURIComponent(playerId)}`, {
    method: "GET",
    headers: { Authorization: "Bearer cron-secret" }, // llamada de servicio: salta ownership/plan
  });

const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;
const persisted = () => calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/dropout_risk_assessments"));

describe("GET /api/wellbeing/dropout-risk", () => {
  beforeEach(() => {
    calls.length = 0;
    signals = {};
  });

  it("sin señales → insufficient_data y no persiste nada", async () => {
    const res = await handler(req("p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.source).toBe("insufficient_data");
    expect(body.data.assessment.primaryFactor).toBe("insufficient_data");
    expect(persisted()).toHaveLength(0);
  });

  it("solo una sesión de fatiga sin índice → insufficient_data (guarda de valor)", async () => {
    signals = { fatigue: [{ session_date: day(3), total_load: 0, fatigue_index: null }] };
    const body = await (await handler(req("p1"))).json();
    expect(body.data.source).toBe("insufficient_data");
    expect(persisted()).toHaveLength(0);
  });

  it("con señales reales → computed y persiste la cifra de la función compartida", async () => {
    signals = {
      attendance: Array.from({ length: 6 }, (_, i) => ({
        player_id: "p1", date: day(20 - i), status: i < 3 ? "absent" : "present", source: "manual", session_id: null,
      })),
      fatigue: [{ session_date: day(20), total_load: 350, fatigue_index: 70, maturation_band: "circa_phv", phv_offset: 0.2 }],
    };
    const expected = computeDropoutAssessment("p1", {
      attendance: signals.attendance ?? [], engagement: [], fatigue: signals.fatigue ?? [],
    });
    expect(expected.source).toBe("computed");

    const body = await (await handler(req("p1"))).json();
    expect(body.data.source).toBe("computed");
    expect(body.data.assessment).toEqual(expected.assessment);

    const post = persisted();
    expect(post).toHaveLength(1);
    const row = JSON.parse(post[0].body ?? "{}");
    expect(row.player_id).toBe("p1");
    expect(row.risk_score).toBe(expected.assessment.riskScore);
    expect(row.risk_level).toBe(expected.assessment.riskLevel);
  });

  it("lee las tres fuentes con el id codificado", async () => {
    await handler(req("p 1"));
    const reads = calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(reads.some((u) => u.includes("attendance_records?player_id=eq.p%201"))).toBe(true);
    expect(reads.some((u) => u.includes("engagement_snapshots?player_id=eq.p%201"))).toBe(true);
    expect(reads.some((u) => u.includes("fatigue_sessions?player_id=eq.p%201"))).toBe(true);
  });
});
