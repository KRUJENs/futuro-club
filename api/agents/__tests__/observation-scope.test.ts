/**
 * VITAS · Regresión (PR #291 review): el bloque de IDENTIFICACIÓN del jugador solo
 * aplica al ámbito "player" (cola por jugador). Los análisis de EQUIPO (baseline,
 * rival, live aggregate) mandan analysisScope:"team" y no deben abstenerse como
 * "jugador no identificado".
 *
 * Run: npm run test:api -- observation-scope
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-123", email: null, tenantId: null, error: null }),
}));

vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(),
}));

// Gate de consentimiento: aquí se prueba el prompt por ámbito, así que permite. Sus tests
// propios: api/agents/__tests__/clip-consent-agents.test.ts.
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  enforceUserVideoObservationConsent: vi.fn(async () => ({
    allowed: true,
    video: { id: "g-1", user_id: "user-123", tenant_id: null, player_id: null, bunny_video_id: "g-1" },
  })),
}));

import videoObservation from "../video-observation";

function geminiResponse() {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ resumenGeneral: "ok" }) }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function promptFor(extra: Record<string, unknown>): Promise<string> {
  let prompt = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    prompt = body.contents?.[0]?.parts?.find((p: { text?: string }) => typeof p.text === "string")?.text ?? "";
    return geminiResponse();
  }));
  const res = await videoObservation(new Request("https://x.test/api/agents/video-observation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
    body: JSON.stringify({ videoBase64: "AAAA", mediaType: "video/mp4", ...extra }),
  }));
  expect(res.status).toBe(200);
  return prompt;
}

describe("video-observation · analysisScope", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "test-gemini-key"; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.GEMINI_API_KEY; });

  it("sin analysisScope → ámbito jugador: exige identificación (estricto por defecto)", async () => {
    const p = await promptFor({ playerContext: { name: "Test", age: 14, position: "ST" } });
    expect(p).toContain("IDENTIFICACIÓN DEL JUGADOR");
    expect(p).toContain('"identificacion" es OBLIGATORIO');
  });

  it('analysisScope "team" → sin bloque de identificación ni campo "identificacion"', async () => {
    const p = await promptFor({ analysisScope: "team", playerContext: { name: "Equipo propio" } });
    expect(p).toContain("ÁMBITO: análisis del EQUIPO");
    expect(p).not.toContain("IDENTIFICACIÓN DEL JUGADOR");
    expect(p).not.toContain('"identificacion": {');
    expect(p).not.toContain("Jugador no identificado:");
  });

  it("ámbito equipo no inventa edad (antes 13 por defecto)", async () => {
    const p = await promptFor({ analysisScope: "team", playerContext: { name: "Rival" } });
    expect(p).not.toMatch(/13 años/);
    expect(p).toContain("no la estimes por el aspecto físico");
  });
});
