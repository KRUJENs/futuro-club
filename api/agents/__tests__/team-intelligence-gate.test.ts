/**
 * VITAS · team-intelligence — server-side gate: no visual input, no report.
 *
 * With a cloud (Bunny) video the client sent neither a Gemini observation nor
 * frames, and the prompt said "Analiza estos 0 fotogramas": the model wrote a
 * team report without seeing the match. The endpoint now refuses on its own
 * (SSE error, code NO_VISUAL_INPUT) and never calls Claude in that case.
 *
 * withHandler is replaced by a pass-through that hands the handler both a fresh
 * `req` and `rawBody`, so this test is independent of how the body is read.
 *
 * Run: npm run test:api -- team-intelligence-gate
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/withHandler", () => ({
  withHandler:
    (_opts: unknown, fn: (ctx: { req: Request; rawBody: string | null; userId: string | null }) => Promise<Response>) =>
    async (req: Request) =>
      fn({ req, rawBody: await req.clone().text(), userId: null }),
}));

vi.mock("../../_lib/usageGuard", () => ({
  checkUsageQuota: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  usageExceededResponse: vi.fn(),
}));

vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(),
}));

// Gate de consentimiento: aquí se prueba el gate de entrada visual, así que permite. Sus
// tests propios: api/agents/__tests__/clip-consent-agents.test.ts.
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  gateClipAnalysis: vi.fn(async () => ({ allowed: true, attestation: "recorded", pendingAttestation: null, minor: null, video: null, videoPlayerIds: [] })),
}));

import teamIntelligence from "../_team-intelligence";
import { fetchMessages } from "../../_lib/anthropic";
import { NO_VISUAL_INPUT } from "../../../src/lib/shared/teamVisualInput";

const REPORT = {
  videoId: "v1",
  resumenEjecutivo: "Equipo ordenado en bloque medio.",
  formacion: { sistema: "4-3-3", variantes: [], rigidez: 5 },
  jugadores: [],
  evaluacionGeneral: { fortalezasEquipo: [], areasTrabajar: [], recomendaciones: [] },
  confianza: 0.5,
};

function post(body: unknown): Request {
  return new Request("https://x.test/api/agents/team-intelligence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function events(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((c) => c.trim())
    .map((chunk) => ({
      event: chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "",
      data: JSON.parse(chunk.match(/^data:\s*(.+)$/m)?.[1] ?? "{}") as Record<string, unknown>,
    }));
}

const TEAM_CONTEXT = { teamColor: "rojo", opponentColor: "azul", competitiveLevel: "formativo" };

describe("team-intelligence · no-visual-input gate", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(fetchMessages).mockReset();
    vi.mocked(fetchMessages).mockImplementation(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(REPORT) }] }), { status: 200 }),
    );
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  const refusedCases: Array<[string, Record<string, unknown>]> = [
    ["neither observations nor keyframes", { geminiObservations: null, keyframes: [] }],
    ["fields missing entirely", {}],
    ["empty observation object and no keyframes", { geminiObservations: {}, keyframes: [] }],
    ["only keyframes the server cannot read (blob:)", { geminiObservations: null, keyframes: [{ url: "blob:abc" }] }],
  ];

  for (const [label, extra] of refusedCases) {
    it(`refuses with NO_VISUAL_INPUT and never calls Claude — ${label}`, async () => {
      const res = await teamIntelligence(post({ teamContext: TEAM_CONTEXT, videoId: "v1", ...extra }));
      const evs = await events(res);
      const error = evs.find((e) => e.event === "error");
      expect(error, JSON.stringify(evs)).toBeDefined();
      expect(error!.data.code).toBe(NO_VISUAL_INPUT);
      expect(String(error!.data.message)).toMatch(/entrada visual/i);
      expect(error!.data.gate_reason).toBe(error!.data.message);
      expect(evs.some((e) => e.event === "complete")).toBe(false);
      expect(fetchMessages).not.toHaveBeenCalled();
      // No "Analizando 0 fotogramas" progress step anymore.
      expect(evs.some((e) => /\b0 fotogramas\b/.test(String(e.data.step ?? "")))).toBe(false);
    });
  }

  it("lets a request with at least one usable frame through to Claude", async () => {
    const res = await teamIntelligence(
      post({
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: null,
        keyframes: [{ url: "data:image/jpeg;base64,AAAA", timestamp: 0, frameIndex: 0 }],
      }),
    );
    const evs = await events(res);
    expect(evs.find((e) => e.data.code === NO_VISUAL_INPUT)).toBeUndefined();
    expect(fetchMessages).toHaveBeenCalled();
  });

  it("lets a request with a Gemini observation through to Claude", async () => {
    const res = await teamIntelligence(
      post({
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" },
        keyframes: [],
      }),
    );
    const evs = await events(res);
    expect(evs.find((e) => e.data.code === NO_VISUAL_INPUT)).toBeUndefined();
    expect(fetchMessages).toHaveBeenCalled();
  });
});
