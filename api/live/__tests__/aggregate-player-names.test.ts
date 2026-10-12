/**
 * VITAS · 074 · /api/live/aggregate: solo nombra a jugadores PROPIOS.
 *
 * El agregado busca con service_role los nombres de los player_id que aparecen en
 * los eventos del partido del usuario. Antes la búsqueda no filtraba por dueño:
 * si el partido de la cuenta B tenía un evento con el player_id de un jugador de la
 * cuenta A (colgado por PostgREST antes de aplicar la 074; /api/live/events responde
 * 400 a todo POST desde que se creó y este PR no lo cambia), B recibía el NOMBRE de ese menor en
 * stats_by_player.playerName y el nombre iba también al prompt del informe (LLM).
 * Ahora la búsqueda se limita a players.user_id = el usuario (misma regla que
 * ownsPlayer): un jugador ajeno sale como "?" y su nombre no llega ni a la
 * respuesta ni al prompt. Los jugadores propios siguen con su nombre.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/live/__tests__/aggregate-player-names.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const UA = "aaaaaaaa-0000-4000-8000-00000000000a"; // dueño de pA1
const UB = "bbbbbbbb-0000-4000-8000-00000000000b"; // dueño de pB1 y del partido
const MATCH_B = "11111111-0000-4000-8000-0000000000b1";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));
vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "bbbbbbbb-0000-4000-8000-00000000000b", email: null, tenantId: null, error: null }),
}));

const prompts: string[] = [];
vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(async (init: { body: string }) => {
    prompts.push(String(init.body));
    return new Response("{}", { status: 200 });
  }),
  responseText: () => "{}",
}));

type Row = Record<string, unknown>;
const DB: Record<string, Row[]> = {};

/** Constructor de consultas en memoria: aplica de verdad eq/in (como PostgREST). */
function query(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const rows = () => (DB[table] ?? []).filter((r) => preds.every((p) => p(r)));
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => { preds.push((r) => r[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[k])); return q; },
    order: () => q,
    update: (p: Row) => { patch = p; return q; },
    single: async () => { const r = rows(); return r.length ? { data: r[0], error: null } : { data: null, error: { message: "0 rows" } }; },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (patch) { for (const r of rows()) Object.assign(r, patch); }
      return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    },
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => query(table) }),
}));

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.ANTHROPIC_API_KEY = "test-key";

beforeEach(() => {
  prompts.length = 0;
  DB.live_matches = [{
    id: MATCH_B, user_id: UB, status: "finished", analysis_result: null, video_url: null,
    team_name: "Equipo B", opponent_name: "Rival", score_home: 1, score_away: 0, duration_seconds: 3000,
  }];
  DB.live_events = [
    { match_id: MATCH_B, player_id: "pA1", event_type: "gol", timestamp_seconds: 10 },
    { match_id: MATCH_B, player_id: "pB1", event_type: "gol", timestamp_seconds: 20 },
    { match_id: MATCH_B, player_id: null, event_type: "perdida", timestamp_seconds: 30 },
  ];
  DB.players = [
    { id: "pA1", name: "Nino A1 de otra cuenta", user_id: UA },
    { id: "pB1", name: "Nino B1", user_id: UB },
  ];
});

async function run(): Promise<Response> {
  const { default: aggregate } = await import("../aggregate");
  return aggregate(
    new Request(`https://x.test/api/live/aggregate?matchId=${MATCH_B}`, {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    }),
  );
}

describe("live/aggregate · nombres de jugadores", () => {
  it("un evento con el jugador de OTRA cuenta no devuelve su nombre (sale \"?\") y su nombre no va al prompt", async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    const stats = body.data.analysis.stats_by_player as Array<{ playerId: string | null; playerName: string }>;
    expect(stats.find((s) => s.playerId === "pA1")?.playerName).toBe("?");
    expect(JSON.stringify(body)).not.toContain("Nino A1");
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).not.toContain("Nino A1");
  });

  it("los jugadores PROPIOS conservan su nombre (en la respuesta y en el prompt) y el equipo sigue igual", async () => {
    const res = await run();
    const stats = (await res.json()).data.analysis.stats_by_player as Array<{ playerId: string | null; playerName: string }>;
    expect(stats.find((s) => s.playerId === "pB1")?.playerName).toBe("Nino B1");
    expect(stats.find((s) => s.playerId === null)?.playerName).toBe("Equipo (sin asignar)");
    expect(prompts.some((p) => p.includes("Nino B1"))).toBe(true);
  });
});
