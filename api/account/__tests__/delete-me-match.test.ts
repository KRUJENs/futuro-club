/**
 * RGPD · borrado de cuenta (una implementación: api/_lib/accountErasure.ts, que usan
 * delete-me y el cron data-retention). SOLO los datos del DUEÑO (076):
 *   - jugadores por players.user_id, NUNCA por tenant (antes `players WHERE tenant_id =`
 *     borraba los jugadores de TODAS las cuentas que compartían el tenant);
 *   - vídeos: los que subió el usuario (incluidos los de partido/equipo, player_id NULL)
 *     y los de SUS jugadores, capturando antes su bunny_video_id;
 *   - los jobs de partido (+ su proxy en Gemini) se purgan ANTES que los vídeos.
 */
import { describe, expect, it, vi } from "vitest";

const purgeOwner = vi.fn(async (..._a: unknown[]) => ({ match_analyses_deleted: 2, gemini_files_deleted: 2, gemini_delete_errors: 0 }));
const purgeVideos = vi.fn(async (..._a: unknown[]) => ({ match_analyses_deleted: 1, gemini_files_deleted: 1, gemini_delete_errors: 0 }));
vi.mock("../../_lib/matchJob/retention", () => ({
  purgeMatchAnalysesForOwner: (...a: unknown[]) => purgeOwner(...a),
  purgeMatchAnalysesForVideos: (...a: unknown[]) => purgeVideos(...a),
}));
const bunny = vi.fn(async (ids: unknown[]) => ({ deleted: ids.length, failed: 0, configured: true }));
vi.mock("../../_lib/bunnyCleanup", () => ({ deleteBunnyVideos: (ids: unknown[]) => bunny(ids) }));

const USER = "11111111-1111-4111-8111-111111111111";

/** Supabase simulado que registra cada operación con su filtro. */
function fakeSupabase(log: string[], opts: { players?: string[] } = {}) {
  const players = opts.players ?? ["p1", "p2"];
  const select = (table: string) => ({
    eq: async (col: string, val: unknown) => {
      log.push(`select ${table} eq ${col}=${val}`);
      if (table === "players") return { data: players.map((id) => ({ id })) };
      if (table === "videos") return { data: [{ id: "v-team", bunny_video_id: "b-team" }] };
      return { data: [] };
    },
    in: async (col: string, vals: unknown[]) => {
      log.push(`select ${table} in ${col}=${(vals as string[]).join("|")}`);
      if (table === "videos") return { data: [{ id: "v-player", bunny_video_id: "b-player" }, { id: "v-team", bunny_video_id: "b-team" }] };
      return { data: [] };
    },
  });
  const del = (table: string) => ({
    eq: async (col: string, val: unknown) => {
      log.push(`delete ${table} eq ${col}=${val}`);
      return { count: 1 };
    },
    in: async (col: string, vals: unknown[]) => {
      log.push(`delete ${table} in ${col}=${(vals as string[]).join("|")}`);
      return { count: (vals as unknown[]).length };
    },
    or: async (f: string) => {
      log.push(`delete ${table} or ${f}`);
      return { count: 99 };
    },
  });
  return {
    from: (table: string) => ({ select: () => select(table), delete: () => del(table) }),
    auth: { admin: { deleteUser: async (id: string) => log.push(`auth delete ${id}`) } },
  };
}

describe("deleteUserDataCompletely · solo los datos del dueño (076)", () => {
  it("borra por players.user_id y por ids capturados; nunca filtra por tenant", async () => {
    process.env.SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    const { deleteUserDataCompletely } = await import("../delete-me");
    const log: string[] = [];
    purgeOwner.mockImplementationOnce(async (...args: unknown[]) => {
      log.push(`purge owner ${args.join(",")}`);
      return { match_analyses_deleted: 2, gemini_files_deleted: 2, gemini_delete_errors: 0 };
    });
    purgeVideos.mockImplementationOnce(async (ids: unknown) => {
      log.push(`purge videos ${(ids as string[]).join("|")}`);
      return { match_analyses_deleted: 1, gemini_files_deleted: 1, gemini_delete_errors: 0 };
    });
    const summary = await deleteUserDataCompletely(fakeSupabase(log), USER);

    // Jugadores y vídeos del dueño, capturados ANTES de borrar nada.
    expect(log[0]).toBe(`select players eq user_id=${USER}`);
    expect(log).toContain(`select videos eq user_id=${USER}`);
    expect(log).toContain("select videos in player_id=p1|p2");
    // Jobs (del usuario + los lanzados sobre sus vídeos) antes que los vídeos.
    expect(log).toContain(`purge owner ${USER}`);
    expect(log).toContain("purge videos v-team|v-player");
    const delVideos = "delete videos in id=v-team|v-player";
    expect(log).toContain(delVideos);
    expect(log.indexOf(`purge owner ${USER}`)).toBeLessThan(log.indexOf(delVideos));
    expect(log.indexOf("purge videos v-team|v-player")).toBeLessThan(log.indexOf(delVideos));
    // Consentimientos de SUS jugadores; jugadores y suscripciones por user_id.
    expect(log).toContain("delete parental_consents in player_id=p1|p2");
    expect(log).toContain(`delete players eq user_id=${USER}`);
    expect(log).toContain(`delete subscriptions eq user_id=${USER}`);
    // El P0: ninguna operación usa tenant_id ni un .or() amplio.
    expect(log.some((l) => l.includes("tenant"))).toBe(false);
    expect(log.some((l) => l.includes(" or "))).toBe(false);

    expect(bunny).toHaveBeenCalledWith(["b-team", "b-player"]);
    expect(summary).toMatchObject({ match_analyses_deleted: 3, gemini_files_deleted: 3, videos_deleted: 2, consents_deleted: 2 });
    expect(log[log.length - 1]).toBe(`auth delete ${USER}`);
  });

  it("sin jugadores propios: no toca vídeos ajenos ni consentimientos", async () => {
    const { deleteUserDataCompletely } = await import("../delete-me");
    const log: string[] = [];
    const summary = await deleteUserDataCompletely(fakeSupabase(log, { players: [] }), USER);
    expect(log.some((l) => l.includes("in player_id"))).toBe(false);
    expect(log).toContain("delete videos in id=v-team");
    expect(summary.consents_deleted).toBe(0);
  });

  it("el cron de borrados programados usa la MISMA implementación (inv #7)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cron = readFileSync(resolve(__dirname, "../../crons/data-retention.ts"), "utf8");
    expect(cron).toMatch(/import \{ deleteUserDataCompletely \} from "\.\.\/_lib\/accountErasure"/);
    expect(cron).toMatch(/deleteUserDataCompletely\(supabase, req\.user_id\)/);
    // Ya no borra tablas por tenant.
    expect(cron).not.toMatch(/\.eq\("tenant_id"/);
  });
});
