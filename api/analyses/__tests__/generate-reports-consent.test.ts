/**
 * Tests · POST /api/analyses/generate-reports con el gate de consentimiento REAL
 * (decisión del owner, 30 sep). El tracking corrió en el navegador; ESTE es el punto donde
 * el servidor lo exige antes de tocar el análisis y de llamar al orquestador.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/analyses/__tests__/generate-reports-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { ATTESTATION, MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";
const AN_ID = "33333333-3333-4333-8333-333333333333";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("203.0.113.7"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", email: null, tenantId: null, error: null }),
}));
vi.mock("../../_lib/usageGuard", () => ({
  checkUsageQuota: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  usageExceededResponse: vi.fn(),
}));

/** Análisis que existen por id (lo que lee generate-reports con analysisId). */
const ANALYSES: Record<string, { player_id: string }> = { [AN_ID]: { player_id: "p1" } };
/** Updates de `analyses` (valores + filtros .eq) para comprobar QUÉ fila se toca. */
const analysisUpdates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
const analysisInserts: Array<Record<string, unknown>> = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "players") {
        const c = { select: () => c, eq: () => c, single: async () => ({ data: { user_id: USER, tenant_id: null }, error: null }) };
        return c;
      }
      if (table === "analyses") {
        const c: Record<string, unknown> = {};
        let byId: unknown = null;
        Object.assign(c, {
          select: () => c,
          eq: (k: string, v: unknown) => { if (k === "id") byId = v; return c; },
          order: () => c,
          limit: () => c,
          // Por id (analysisId del navegador): el análisis existe y es de p1 (ANALYSES).
          // Búsqueda por (vídeo, jugador): sin análisis previo.
          maybeSingle: async () => ({ data: byId !== null ? (ANALYSES[String(byId)] ?? null) : null, error: null }),
          single: async () => ({ data: { player_id: "p1" }, error: null }),
          update: (values: Record<string, unknown>) => {
            const entry = { values, filters: [] as Array<[string, unknown]> };
            analysisUpdates.push(entry);
            const u: Record<string, unknown> = {};
            Object.assign(u, {
              eq: (k: string, v: unknown) => { entry.filters.push([k, v]); return u; },
              then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res),
            });
            return u;
          },
          insert: (row: Record<string, unknown>) => {
            analysisInserts.push(row);
            const i = { select: () => i, single: async () => ({ data: { id: "an-new" }, error: null }) };
            return i;
          },
        });
        return c;
      }
      throw new Error(`tabla inesperada ${table}`);
    },
  }),
}));

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
const orchestratorCalls = () => mock.calls.filter((c) => c.url.includes("/api/agents/pipeline-orchestrator"));

beforeAll(async () => {
  process.env.VITE_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  handler = (await import("../generate-reports")).default;
});

beforeEach(() => {
  analysisUpdates.length = 0;
  analysisInserts.length = 0;
  db = emptyConsentDb();
  db.birthDates.p1 = null;
  db.playerOwners.p1 = USER; // ownership.ownsPlayer (solo el dueño, 076)
  mock = consentFetch(db, {
    fallback: async (url) => {
      if (url.includes("/api/agents/pipeline-orchestrator")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: Record<string, unknown>) =>
  handler(
    new Request("https://x.test/api/analyses/generate-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt" },
      body: JSON.stringify({ playerId: "p1", videoId: "local-vid-1", ...body }),
    }),
  );

describe("generate-reports · consentimiento", () => {
  it("vídeo solo del navegador sin declaración → 400; ni análisis nuevo ni orquestador", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).errorDetail.code).toBe("attestation_required");
    expect(analysisInserts).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it("bloqueado con analysisId del navegador → se cierra SOLO si estaba en processing_reports", async () => {
    const res = await post({ analysisId: AN_ID });
    expect(res.status).toBe(400);
    expect(analysisUpdates).toHaveLength(1);
    expect(analysisUpdates[0].values).toMatchObject({ status: "failed" });
    expect(analysisUpdates[0].filters).toEqual([["id", AN_ID], ["status", "processing_reports"]]);
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it("menor de 14 conocido sin consentimiento parental → 403", async () => {
    db.birthDates.p1 = MINOR_BIRTH_DATE;
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it("vídeo solo del navegador + declaración → se guarda (video_ref) y se lanza el orquestador", async () => {
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(mock.inserts[0]).toMatchObject({ user_id: USER, resource_type: "video_ref", resource_id: "local-vid-1" });
    expect(orchestratorCalls()).toHaveLength(1);
  });

  it("fila videos PROPIA con declaración guardada (la de la subida) → basta, sin re-declarar", async () => {
    db.videos.push({ id: "local-vid-1", user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: "local-vid-1" });
    db.storedAttestations.push({ resource_type: "videos", resource_id: "local-vid-1" });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(mock.inserts).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(1);
  });

  it("fila videos AJENA → 403", async () => {
    db.videos.push({ id: "local-vid-1", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "x" });
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it("B2 · videoId = GUID de Bunny de la fila create-upload de OTRO usuario (id vid-x) → 403; nada guardado", async () => {
    db.videos.push({ id: "vid-x", user_id: "99999999-9999-4999-8999-999999999999", tenant_id: null, player_id: null, bunny_video_id: "1a000000-0000-4000-8000-00000000000a" });
    const res = await post({ videoId: "1a000000-0000-4000-8000-00000000000a", attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect(mock.inserts).toHaveLength(0);
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
    ["jugador que no existe", undefined],
  ])(
    "B5 · analysisId que NO existe + playerId AJENO (%s) → 404 igual en los tres casos; no se lee ningún dato del jugador ni se guarda nada",
    async (_label, bd) => {
      const OTHER = "99999999-9999-4999-8999-999999999999";
      if (bd !== undefined) {
        db.birthDates.pForeign = bd;
        db.playerOwners.pForeign = OTHER;
      }
      const res = await post({ analysisId: "44444444-4444-4444-8444-444444444444", playerId: "pForeign", attestation: ATTESTATION });
      expect(res.status).toBe(404);
      expect((await res.json()).errorDetail.code).toBe("analysis_not_found");
      expect(mock.calls.some((c) => c.url.includes("/rest/v1/players"))).toBe(false);
      expect(mock.calls.some((c) => c.url.includes("/rest/v1/parental_consents"))).toBe(false);
      expect(mock.inserts).toHaveLength(0);
      expect(orchestratorCalls()).toHaveLength(0);
    },
  );

  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
  ])(
    "B5 · análisis propio + fila videos PROPIA ligada a un jugador AJENO (%s) → 403 forbidden sin leer su fecha de nacimiento",
    async (_label, bd) => {
      db.videos.push({ id: "local-vid-1", user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: null });
      db.birthDates.pForeign = bd;
      db.playerOwners.pForeign = "99999999-9999-4999-8999-999999999999";
      const res = await post({ attestation: ATTESTATION });
      expect(res.status).toBe(403);
      expect((await res.json()).errorDetail.code).toBe("forbidden");
      expect(mock.calls.some((c) => c.url.includes("/rest/v1/players?id=eq.pForeign&select=birth_date"))).toBe(false);
      expect(mock.calls.some((c) => c.url.includes("/rest/v1/parental_consents"))).toBe(false);
      expect(mock.inserts).toHaveLength(0);
      expect(orchestratorCalls()).toHaveLength(0);
    },
  );

  it("B1 · la fila videos propia es de un menor de 14 sin consentimiento y el análisis es para OTRO jugador → 403", async () => {
    db.videos.push({ id: "local-vid-1", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: "local-vid-1" });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    db.playerOwners.pMinor = USER; // jugador propio (B5)
    const res = await post({ attestation: ATTESTATION });
    expect(res.status).toBe(403);
    expect((await res.json()).errorDetail.code).toBe("parental_consent_required");
    expect(orchestratorCalls()).toHaveLength(0);
  });
});
