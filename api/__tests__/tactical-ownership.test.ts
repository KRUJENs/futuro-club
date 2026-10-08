/**
 * VITAS · Tests unitarios de ownsMatch (autorización por DUEÑO, sin BD live)
 *
 * ownsMatch() es la puerta de autorización a nivel de objeto de los endpoints
 * de api/tactical/. Como esos endpoints consultan Supabase con SERVICE_ROLE_KEY
 * (que SALTA la RLS), la propiedad DEBE comprobarse en código. Este test blinda:
 *
 *   1. Fail-closed: ante cualquier duda (sin usuario, sin Supabase, query no-ok,
 *      error de red, match inexistente) → false. Nunca "abre por defecto".
 *   2. SOLO EL DUEÑO (076): el match (== analyses.id) es del usuario si creó la
 *      analysis o si es el dueño de su jugador (players.user_id). El mismo predicado
 *      que las políticas tácticas de la migración 076. NUNCA por tenant: antes se
 *      comprobaba analyses.tenant_id = tenant del JWT, y con un tenant compartido
 *      cualquier cuenta de ese tenant leía/escribía los datos tácticos de otra.
 *
 * No necesita Supabase: mockeamos `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ownsMatch } from "../_lib/ownership";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const MATCH = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLAYER = "p-owned-by-a";

type Route = (url: string) => { ok: boolean; json?: () => Promise<unknown> };

/** fetch simulado por URL: analyses (fila del match) y players (¿es su dueño?). */
function mockFetch(route: Route) {
  const spy = vi.fn(async (url: string | URL | Request) => {
    const res = route(String(url));
    return { ok: res.ok, json: res.json ?? (async () => []) } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** La analysis del match: creada por el pipeline (user_id NULL), jugador de USER_A. */
function pipelineAnalysisOfA(url: string) {
  if (url.includes("/rest/v1/analyses")) {
    expect(url).toContain(`id=eq.${MATCH}`);
    expect(url).toContain("select=user_id,player_id");
    expect(url).not.toContain("tenant_id");
    return { ok: true, json: async () => [{ user_id: null, player_id: PLAYER }] };
  }
  if (url.includes("/rest/v1/players")) {
    return { ok: true, json: async () => (url.includes(`user_id=eq.${USER_A}`) ? [{ id: PLAYER }] : []) };
  }
  return { ok: false };
}

describe("ownsMatch · autorización por DUEÑO (fail-closed, sin tenant)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("true para el DUEÑO del jugador de la analysis (pipeline con user_id NULL)", async () => {
    const spy = mockFetch(pipelineAnalysisOfA);
    expect(await ownsMatch(MATCH, USER_A)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("true para quien CREÓ la analysis, sin consultar players", async () => {
    const spy = mockFetch((url) =>
      url.includes("/rest/v1/analyses") ? { ok: true, json: async () => [{ user_id: USER_B, player_id: PLAYER }] } : { ok: false },
    );
    expect(await ownsMatch(MATCH, USER_B)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("false (P0): otra cuenta que comparte tenant con el dueño, sin ser creadora ni dueña", async () => {
    mockFetch(pipelineAnalysisOfA);
    expect(await ownsMatch(MATCH, USER_B)).toBe(false);
  });

  it("false sin llamar a la red cuando no hay usuario", async () => {
    const spy = mockFetch(pipelineAnalysisOfA);
    expect(await ownsMatch(MATCH, null)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false sin llamar a la red cuando no hay matchId", async () => {
    const spy = mockFetch(pipelineAnalysisOfA);
    expect(await ownsMatch(null, USER_A)).toBe(false);
    expect(await ownsMatch(undefined, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false cuando el match no es una analysis (query devuelve [])", async () => {
    mockFetch((url) => (url.includes("/rest/v1/analyses") ? { ok: true, json: async () => [] } : { ok: false }));
    expect(await ownsMatch(MATCH, USER_A)).toBe(false);
  });

  it("false para un match demo (no es UUID → PostgREST 400 → no-ok)", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({ code: "22P02" }) }));
    expect(await ownsMatch("demo-abc123", USER_A)).toBe(false);
  });

  it("false cuando fetch lanza (error de red → fail-closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await ownsMatch(MATCH, USER_A)).toBe(false);
  });

  it("false cuando Supabase no está configurado", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const spy = mockFetch(pipelineAnalysisOfA);
    expect(await ownsMatch(MATCH, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
