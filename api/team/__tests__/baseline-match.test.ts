/**
 * /api/team/baseline-analysis con matchAnalysisId: la observación del equipo foco se
 * carga EN SERVIDOR desde el job (nunca del cliente) y solo si el job lo creó el usuario
 * (076: compartir el tenant NO basta), es un baseline de equipo y está completado. Ajeno =
 * 404 antes de gastar.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "k";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, limit: 5, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn(async () => false),
  budgetExceededResponse: vi.fn(() => new Response("{}", { status: 429 })),
  recordSpendUsd: vi.fn(async () => undefined),
}));
const getJob = vi.fn();
vi.mock("../../_lib/matchJob/repo", () => ({ getJob: (...a: unknown[]) => getJob(...a) }));
const createClient = vi.fn(() => {
  throw new Error("must not reach Supabase players / Claude");
});
vi.mock("@supabase/supabase-js", () => ({ createClient: (...a: unknown[]) => createClient(...(a as [])) }));

import { verifyAuth } from "../../_lib/auth";

const JOB_ID = "8f6d2c1e-3b4a-4c5d-9e8f-0a1b2c3d4e5f";
let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../baseline-analysis")).default;
});
beforeEach(() => {
  getJob.mockReset();
  createClient.mockClear();
});

const post = (b: unknown) =>
  handler(new Request("https://x.test/api/team/baseline-analysis", { method: "POST", headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" }, body: JSON.stringify(b) }));

describe("baseline-analysis · matchAnalysisId", () => {
  it("runs on nodejs with 300 s (5 Claude calls do not fit Edge's 25 s first byte)", async () => {
    const mod = await import("../baseline-analysis");
    expect(mod.config).toEqual({ runtime: "nodejs", maxDuration: 300 });
  });
  it("someone else's job → 404 before loading players or calling Claude", async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, user_id: "99999999-9999-4999-8999-999999999999", tenant_id: "t-x", purpose: "team_baseline", focus_team: "home", status: "completed" });
    const res = await post({ matchAnalysisId: JOB_ID });
    expect(res.status).toBe(404);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("someone else's job in the SAME tenant → still 404 (076: owner only, no tenant branch)", async () => {
    vi.mocked(verifyAuth).mockResolvedValueOnce({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: "t-x", error: null });
    getJob.mockResolvedValueOnce({ id: JOB_ID, user_id: "99999999-9999-4999-8999-999999999999", tenant_id: "t-x", purpose: "team_baseline", focus_team: "home", status: "completed" });
    const res = await post({ matchAnalysisId: JOB_ID });
    expect(res.status).toBe(404);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("a match_ab job or an unfinished one is refused (409)", async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, user_id: "11111111-1111-4111-8111-111111111111", purpose: "match_ab", focus_team: null, status: "completed" });
    expect((await post({ matchAnalysisId: JOB_ID })).status).toBe(409);
    getJob.mockResolvedValueOnce({ id: JOB_ID, user_id: "11111111-1111-4111-8111-111111111111", purpose: "team_baseline", focus_team: "home", status: "observing" });
    expect((await post({ matchAnalysisId: JOB_ID })).status).toBe(409);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("a non-uuid matchAnalysisId is rejected by the schema", async () => {
    expect((await post({ matchAnalysisId: "../x" })).status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });
});
