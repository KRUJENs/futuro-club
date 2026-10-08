/**
 * VITAS · Tests unitarios de ownsPlayer (autorización por usuario, sin BD live)
 *
 * ownsPlayer() es la puerta de autorización a nivel de objeto de los endpoints
 * que sirven datos de UN jugador (api/analyses/reports.ts, api/reports/_pdf.ts,
 * api/players/_crud.ts). Como esos endpoints consultan Supabase con
 * SERVICE_ROLE_KEY (que SALTA la RLS), el check de propiedad DEBE hacerse en
 * código. Este test blinda dos propiedades críticas:
 *
 *   1. Fail-closed: ante cualquier duda (sin userId, sin playerId, sin Supabase,
 *      query no-ok, error de red) → false. Nunca "abre por defecto".
 *   2. El predicado consultado es players WHERE id = playerId AND user_id = userId
 *      (la propiedad por usuario del modelo).
 *   3. (076) SOLO EL DUEÑO: compartir el tenant con el dueño NUNCA da acceso.
 *
 * No necesita Supabase: mockeamos `fetch`. La verificación end-to-end contra la
 * BD real vive en rls-isolation.test.ts (SKIP sin credenciales).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ownsPlayer, ownsRowOrItsPlayer, ownsVideo, ownsMatchAnalysis, ownedPlayerIds } from "../_lib/ownership";

const USER_A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const TENANT_A = "cccccccc-3333-3333-3333-cccccccccccc";
const TENANT_B = "dddddddd-4444-4444-4444-dddddddddddd";
const PLAYER = "demo-a";

function mockFetchOnce(impl: (url: string) => { ok: boolean; json?: () => Promise<unknown> }) {
  const spy = vi.fn(async (url: string | URL | Request) => {
    const res = impl(String(url));
    return {
      ok: res.ok,
      json: res.json ?? (async () => []),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("ownsPlayer · autorización por usuario (fail-closed)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("true cuando el jugador pertenece al usuario (query devuelve fila)", async () => {
    const spy = mockFetchOnce((url) => {
      // Predicado: id + user_id (propiedad por usuario)
      expect(url).toContain(`id=eq.${PLAYER}`);
      expect(url).toContain(`user_id=eq.${USER_A}`);
      return { ok: true, json: async () => [{ id: PLAYER }] };
    });
    expect(await ownsPlayer(PLAYER, USER_A)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("false cuando el jugador es de OTRO usuario (query devuelve []) — el caso IDOR", async () => {
    mockFetchOnce((url) => {
      expect(url).toContain(`user_id=eq.${USER_B}`);
      return { ok: true, json: async () => [] };
    });
    expect(await ownsPlayer(PLAYER, USER_B)).toBe(false);
  });

  it("false sin llamar a la red cuando no hay userId (JWT sin sub)", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: PLAYER }] }));
    expect(await ownsPlayer(PLAYER, null)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false sin llamar a la red cuando no hay playerId", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: PLAYER }] }));
    expect(await ownsPlayer(null, USER_A)).toBe(false);
    expect(await ownsPlayer(undefined, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false cuando la query devuelve no-ok (fail-closed)", async () => {
    mockFetchOnce(() => ({ ok: false }));
    expect(await ownsPlayer(PLAYER, USER_A)).toBe(false);
  });

  it("false cuando fetch lanza (error de red → fail-closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await ownsPlayer(PLAYER, USER_A)).toBe(false);
  });

  it("false cuando Supabase no está configurado (sin red)", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: PLAYER }] }));
    expect(await ownsPlayer(PLAYER, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 076 · SOLO EL DUEÑO. El tenant_id compartido de producción (3 jugadores con el
// MISMO valor) no identifica a nadie: ya NO existe ninguna rama por tenant.
// ─────────────────────────────────────────────────────────────────────────────

describe("ownership · ya no existe la rama por tenant (076)", () => {
  it("el módulo no exporta helpers con tenant (ownsPlayerOrTenant / ownedPlayersOrFilter)", async () => {
    const mod = (await import("../_lib/ownership")) as Record<string, unknown>;
    expect(mod.ownsPlayerOrTenant).toBeUndefined();
    expect(mod.ownedPlayersOrFilter).toBeUndefined();
  });

  it("ninguna función de ownership.ts acepta un parámetro tenantId", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../_lib/ownership.ts"), "utf8");
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    // Control positivo: el mismo patrón SÍ encuentra los parámetros userId.
    expect(code).toMatch(/userId: string \| null/);
    expect(code).not.toMatch(/tenantId/);
    expect(code).not.toMatch(/tenant_id/);
  });
});

describe("ownsRowOrItsPlayer · creador o dueño del jugador, nunca tenant (fail-closed)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("true si la fila la creó el usuario (row.user_id), sin red", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    expect(await ownsRowOrItsPlayer({ user_id: USER_A, player_id: PLAYER }, USER_A)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true si el usuario es el DUEÑO del jugador de la fila (players.user_id)", async () => {
    const spy = mockFetchOnce((url) => {
      expect(url).toContain(`id=eq.${PLAYER}`);
      expect(url).toContain(`user_id=eq.${USER_A}`);
      return { ok: true, json: async () => [{ id: PLAYER }] };
    });
    // Fila del pipeline de vídeo: user_id NULL pero player_id real.
    expect(await ownsRowOrItsPlayer({ user_id: null, player_id: PLAYER }, USER_A)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("false (el caso del P0): otra cuenta del MISMO tenant, que no creó la fila ni es dueña", async () => {
    // La fila y el jugador llevan TENANT_A y USER_B tendría TENANT_A en su JWT: da igual.
    mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    const row = { user_id: USER_A, player_id: PLAYER, tenant_id: TENANT_A } as { user_id: string; player_id: string };
    expect(await ownsRowOrItsPlayer(row, USER_B)).toBe(false);
  });

  it("false sin userId o sin fila, sin red", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: PLAYER }] }));
    expect(await ownsRowOrItsPlayer({ user_id: USER_A, player_id: PLAYER }, null)).toBe(false);
    expect(await ownsRowOrItsPlayer(null, USER_A)).toBe(false);
    expect(await ownsRowOrItsPlayer(undefined, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false sin creador que case y sin jugador (no hay dueño), sin red", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: PLAYER }] }));
    expect(await ownsRowOrItsPlayer({ user_id: USER_B, player_id: null }, USER_A)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("false fail-closed: query no-ok / fetch lanza", async () => {
    mockFetchOnce(() => ({ ok: false }));
    expect(await ownsRowOrItsPlayer({ player_id: PLAYER }, USER_A)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await ownsRowOrItsPlayer({ player_id: PLAYER }, USER_A)).toBe(false);
  });
});

describe("ownsVideo · autorización de VÍDEO (finalize/identify-player/candidates/match start, fail-closed)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("true para service-call (Modal / crons / webhook), sin tocar la red", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    expect(await ownsVideo({ player_id: PLAYER }, null, true)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true si el uploader (videos.user_id) coincide, sin red (vídeo de equipo, player_id NULL)", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    expect(await ownsVideo({ user_id: USER_A, player_id: null }, USER_A)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cae al DUEÑO del jugador del vídeo si el uploader no coincide", async () => {
    mockFetchOnce((url) => {
      expect(url).toContain(`user_id=eq.${USER_A}`);
      return { ok: true, json: async () => [{ id: PLAYER }] };
    });
    expect(await ownsVideo({ player_id: PLAYER }, USER_A)).toBe(true);
  });

  it("false (P0): mismo tenant del vídeo ya NO basta", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    const video = { tenant_id: TENANT_A, player_id: PLAYER } as { player_id: string };
    expect(await ownsVideo(video, USER_B)).toBe(false);
  });

  it("false sin player_id y sin coincidencia de uploader (fail-closed, sin red)", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [] }));
    const video = { user_id: USER_A, tenant_id: TENANT_A } as { user_id: string };
    expect(await ownsVideo(video, USER_B)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("ownsMatchAnalysis · job de partido: solo quien lo creó", () => {
  it("true para el creador (user_id)", () => {
    expect(ownsMatchAnalysis({ user_id: USER_A }, USER_A)).toBe(true);
  });
  it("false (P0) para otra cuenta aunque comparta el tenant del job", () => {
    const job = { user_id: USER_A, tenant_id: TENANT_A } as { user_id: string };
    expect(ownsMatchAnalysis(job, USER_B)).toBe(false);
  });
  it("false sin job, sin userId o sin creador", () => {
    expect(ownsMatchAnalysis(null, USER_A)).toBe(false);
    expect(ownsMatchAnalysis(undefined, USER_A)).toBe(false);
    expect(ownsMatchAnalysis({ user_id: USER_A }, null)).toBe(false);
    expect(ownsMatchAnalysis({ user_id: null }, USER_A)).toBe(false);
  });
});

describe("ownedPlayerIds · ids de los jugadores DEL usuario (multi-fila)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("consulta SOLO por user_id (nunca tenant_id) y devuelve los ids", async () => {
    mockFetchOnce((url) => {
      expect(url).toContain(`user_id=eq.${USER_A}`);
      expect(url).not.toContain("tenant_id");
      return { ok: true, json: async () => [{ id: "p1" }, { id: "p2" }, { id: null }] };
    });
    expect(await ownedPlayerIds(USER_A)).toEqual(["p1", "p2"]);
  });

  it("fail-closed: sin userId, sin Supabase, no-ok o error → []", async () => {
    const spy = mockFetchOnce(() => ({ ok: true, json: async () => [{ id: "p1" }] }));
    expect(await ownedPlayerIds(null)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    mockFetchOnce(() => ({ ok: false }));
    expect(await ownedPlayerIds(USER_A)).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await ownedPlayerIds(USER_A)).toEqual([]);
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    expect(await ownedPlayerIds(USER_A)).toEqual([]);
  });
});
