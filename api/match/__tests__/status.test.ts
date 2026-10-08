/**
 * GET /api/match/status es SOLO LECTURA (CWE-650: un GET no muta ni gasta), solo para el
 * dueño — quien creó el job; un mismo tenant NO basta desde la 076 (ajeno = 404, no se
 * revela), y re-valida lo almacenado con el
 * contrato. Se usa el repo REAL con fetch simulado: cualquier escritura en Supabase o
 * cualquier llamada a Gemini / Anthropic / Modal haría fallar el test.
 * También: list (solo del usuario), availability («En validación») y cancel.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchAvailabilityResponseSchema, matchJobStatusResponseSchema } from "../../../src/lib/shared/matchJob/contract";
import { aggregateMatch } from "../../_lib/matchJob/aggregate";
import { CONF, doneSegment, failedSegment } from "../../_lib/matchJob/__tests__/fixtures";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, limit: 120, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
const auth = { userId: "11111111-1111-4111-8111-111111111111", email: "coach@club.test", tenantId: null as string | null, error: null };
vi.mock("../../_lib/auth", () => ({ verifyAuth: vi.fn(async () => auth) }));

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "8f6d2c1e-3b4a-4c5d-9e8f-0a1b2c3d4e5f";
const GUID = "0d2f4c1a-1b2c-4d3e-8f9a-0b1c2d3e4f5a";

const observation = aggregateMatch({
  durationSec: 1800,
  segments: [doneSegment(0, 0, 900), failedSegment(1, 900, 1800)],
  locale: "es",
  geminiModel: "gemini-2.5-flash",
  confidence: CONF,
});

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    user_id: OWNER,
    org_id: null,
    tenant_id: "33333333-3333-4333-8333-333333333333",
    video_id: GUID,
    bunny_video_id: GUID,
    purpose: "match_ab",
    home: { name: "Local FC", kit: { shirt: { hex: "#ffffff", label: "blanco" } } },
    away: { name: "Visitante CF", kit: { shirt: { hex: "#7b1e2b" } } },
    focus_team: null,
    attacking_dir_1h: null,
    notes: "privado",
    category: null,
    locale: "es",
    kit_fingerprint: "f",
    attested_by: OWNER,
    attested_at: "2026-09-29T08:00:00Z",
    attestation_version: "2026-09-28.v1",
    status: "completed",
    stage_detail: null,
    dispatch_epoch: 1,
    dispatch_attempts: 1,
    modal_call_id: "fc-1",
    dispatched_at: "2026-09-29T08:00:00Z",
    heartbeat_at: "2026-09-29T08:10:00Z",
    duration_sec: "1800",
    bunny_status: 4,
    target_variant: "360p",
    proxy: null,
    gemini_file_name: "files/x",
    gemini_file_uri: "https://generativelanguage.googleapis.com/v1beta/files/x",
    gemini_file_display_name: `vitas-match-${JOB_ID}-1`,
    gemini_file_expires_at: null,
    gemini_file_deleted_at: "2026-09-29T08:20:00Z",
    segments_total: 2,
    segments_done: 1,
    observation,
    coverage: observation.coverage,
    report: null,
    report_gate: { code: "report_engine_unavailable", reason: "Informe no disponible." },
    report_model: null,
    report_lease_until: null,
    prompt_versions: null,
    model_ids: null,
    estimate: { usd: 0.61, kind: "estimate", basis: "bunny_length", pricing_ref: "config/aiPricing.json@2026-09-28" },
    estimate_usd: "0.61",
    reservation_usd: "0",
    spend_usd: "0.3141",
    spend_detail: {},
    error: null,
    created_at: "2026-09-29T08:00:00Z",
    updated_at: "2026-09-29T08:20:00Z",
    finished_at: "2026-09-29T08:20:00Z",
    ...over,
  };
}

let current: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  handler = (await import("../[action]")).default;
});
beforeEach(() => {
  process.env.SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.BUNNY_STREAM_LIBRARY_ID = "42";
  process.env.BUNNY_STREAM_API_KEY = "bk";
  auth.userId = OWNER;
  auth.tenantId = null;
  current = jobRow();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://sb.test/rest/v1/match_analyses?id=eq.")) return new Response(JSON.stringify([current]));
    if (u.startsWith("https://sb.test/rest/v1/match_analyses?user_id=eq.")) return new Response(JSON.stringify([current]));
    if (u.startsWith("https://sb.test/rest/v1/match_analysis_segments?")) {
      return new Response(
        JSON.stringify([
          { match_analysis_id: JOB_ID, idx: 0, start_sec: "0", end_sec: "900", status: "done", attempts: 1, invalid_attempts: 0, cost_usd: "0.1" },
          { match_analysis_id: JOB_ID, idx: 1, start_sec: "900", end_sec: "1800", status: "running", attempts: 1, invalid_attempts: 0, cost_usd: "0" },
        ]),
      );
    }
    if (u.startsWith("https://video.bunnycdn.com/library/42/videos/")) {
      return new Response(JSON.stringify({ guid: GUID, status: 3, length: 0, encodeProgress: 57.4, availableResolutions: "" }));
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "MATCH_VIDEO_ENABLED"]) delete process.env[k];
});

const get = (path: string) => handler(new Request(`https://x.test${path}`, { headers: { Authorization: "Bearer jwt" } }));
const methodsCalled = () => fetchMock.mock.calls.map((c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase());

describe("GET /api/match/status", () => {
  it("returns the contract view to the owner using only GET requests (no writes, no AI calls)", async () => {
    const res = await get(`/api/match/status?jobId=${JOB_ID}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: unknown };
    const parsed = matchJobStatusResponseSchema.parse(data);
    expect(parsed.job.stage).toBe("done");
    expect(parsed.progress).toMatchObject({ segmentsDone: 1, segmentsTotal: 2, currentSegmentIdx: 1 });
    expect(parsed.observation?.possession.home.provenance).toBe("ESTIMADA_LLM");
    expect(parsed.reportGate?.code).toBe("report_engine_unavailable");
    expect(parsed.cost.spend).toMatchObject({ usd: 0.3141, kind: "ledger" });
    expect(parsed.playback?.embedUrl).toBe(`https://player.mediadelivery.net/embed/42/${GUID}`);
    expect(JSON.stringify(data)).not.toContain("privado"); // las notas del entrenador no salen en el status
    expect(methodsCalled().every((m) => m === "GET")).toBe(true);
    for (const c of fetchMock.mock.calls) expect(String(c[0])).not.toMatch(/generativelanguage|anthropic|modal\.run/);
  });
  it("while encoding it reads Bunny's progress (GET) without dispatching", async () => {
    current = jobRow({ status: "awaiting_encode", observation: null, coverage: null, report_gate: null, segments_total: null, finished_at: null });
    const res = await get(`/api/match/status?jobId=${JOB_ID}`);
    const { data } = (await res.json()) as { data: { encode: unknown; job: { stage: string } } };
    expect(data.job.stage).toBe("encoding");
    expect(data.encode).toEqual({ bunnyStatus: 3, encodeProgressPct: 57 });
    expect(methodsCalled().every((m) => m === "GET")).toBe(true);
  });
  it("someone else's job is a 404 (existence not revealed), EVEN from the same tenant (076: owner only)", async () => {
    auth.userId = "99999999-9999-4999-8999-999999999999";
    expect((await get(`/api/match/status?jobId=${JOB_ID}`)).status).toBe(404);
    // Same tenant_id as the job (a shared tenant) no longer grants access.
    auth.tenantId = "33333333-3333-4333-8333-333333333333";
    expect((await get(`/api/match/status?jobId=${JOB_ID}`)).status).toBe(404);
  });
  it("a stored blob that breaks the contract is returned as null, never patched", async () => {
    current = jobRow({ observation: { schema_version: "hacked" }, report: { overall_rating: 9 } });
    const { data } = (await (await get(`/api/match/status?jobId=${JOB_ID}`)).json()) as { data: { observation: unknown; report: unknown } };
    expect(data.observation).toBeNull();
    expect(data.report).toBeNull();
    expect(methodsCalled().every((m) => m === "GET")).toBe(true);
  });
  it("invalid jobId → 400; POST → 405", async () => {
    expect((await get("/api/match/status?jobId=../../etc")).status).toBe(400);
    expect((await handler(new Request("https://x.test/api/match/status", { method: "POST", headers: { Authorization: "Bearer jwt" } }))).status).toBe(405);
  });
});

describe("GET /api/match/list and /api/match/availability", () => {
  it("list returns only the caller's jobs (filtered by the verified user id)", async () => {
    const res = await get("/api/match/list");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { jobs: { jobId: string }[] } };
    expect(data.jobs.map((j) => j.jobId)).toEqual([JOB_ID]);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`user_id=eq.${OWNER}`);
  });
  it("availability: OFF by default with the localised 'en validación' reason (no env names); ON only with 'true' + config", async () => {
    const off = (await (await get("/api/match/availability?locale=es")).json()) as { data: unknown };
    expect(matchAvailabilityResponseSchema.parse(off.data)).toMatchObject({ enabled: false, code: "match_video_disabled" });
    expect(JSON.stringify(off.data)).toMatch(/en validación/);
    process.env.MATCH_VIDEO_ENABLED = "true";
    const partial = (await (await get("/api/match/availability?locale=en")).json()) as { data: { code: string; reason: string } };
    expect(partial.data.code).toBe("real_inference_disabled");
    expect(partial.data.reason).not.toMatch(/GEMINI_API_KEY|MODAL_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/match/cancel", () => {
  it("someone else's job → 404 without writing", async () => {
    auth.userId = "99999999-9999-4999-8999-999999999999";
    const res = await handler(
      new Request("https://x.test/api/match/cancel", {
        method: "POST",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: JOB_ID }),
      }),
    );
    expect(res.status).toBe(404);
    expect(methodsCalled().every((m) => m === "GET")).toBe(true);
  });
  it("a terminal job is returned as is (idempotent, no writes)", async () => {
    const res = await handler(
      new Request("https://x.test/api/match/cancel", {
        method: "POST",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: JOB_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ jobId: JOB_ID, status: "completed" });
    expect(methodsCalled().every((m) => m === "GET")).toBe(true);
  });
});
