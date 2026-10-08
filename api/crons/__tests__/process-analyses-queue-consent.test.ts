/**
 * Tests · cron process-analyses-queue con el gate de consentimiento REAL (defensa en
 * profundidad). Un análisis en cola (p. ej. escrito desde el navegador bajo RLS, o
 * encolado antes del gate) cuyo jugador NO es el del vídeo: el `player_id` de la fila
 * `videos` (y de cualquier otra fila del mismo vídeo de Bunny) se comprueba igualmente
 * (mismo defecto que B1 de la review del PR #308).
 *
 * Ronda 3 de la review:
 *   - B4: el GUID de Bunny que el cron mete en la URL (videos.bunny_video_id, que el dueño
 *     de la fila puede reescribir) tiene que tener forma de GUID; es EXACTAMENTE el que se
 *     comprueba en el gate y el que se pasa a gemini-analyze.
 *   - B5 (la cola escribe el motivo en analyses.status_message, que lee quien gestiona el
 *     jugador del análisis): el cron actúa en nombre del DUEÑO del jugador del análisis;
 *     las filas del vídeo y sus jugadores tienen que ser suyos, o el análisis falla con un
 *     motivo genérico SIN leer la fecha de nacimiento del jugador ajeno.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/crons/__tests__/process-analyses-queue-consent.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const G1 = "0a0a0a0a-0000-4000-8000-000000000001";
const G_VICTIM = "0b0b0b0b-0000-4000-8000-000000000002";

const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** Lo que el cron lee de la fila `videos` del análisis (paso «URL de Bunny»). */
const videoRow: { current: Record<string, unknown> | null } = { current: { bunny_video_id: G1 } };

function chainFor(table: string) {
  let isUpdate = false;
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: self,
    in: self,
    or: self,
    order: self,
    limit: self,
    update: (values: Record<string, unknown>) => {
      isUpdate = true;
      updates.push({ table, values });
      return chain;
    },
    single: async () => ({ data: table === "videos" ? videoRow.current : null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: isUpdate ? [] : null, error: null }).then(resolve, reject),
  });
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => chainFor(t),
    // Análisis en cola para el jugador p1 sobre la fila `videos` v1.
    rpc: async () => ({ data: [{ id: "a1", player_id: "p1", video_id: "v1", tenant_id: "t1" }], error: null }),
  }),
}));

process.env.SUPABASE_URL = "https://sb.test";
process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";

let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
const calledUrls = () => mock.calls.map((c) => c.url);
const geminiDispatches = () => mock.calls.filter((c) => c.url.includes("/api/pipeline/gemini-analyze"));
/** `failed` escritos para el análisis en cola (sin el reaper de colgados, que también escribe `failed`). */
const failedUpdates = () =>
  updates.filter((u) => u.table === "analyses" && u.values.status === "failed" && !/^Rescatado/.test(String(u.values.status_message)));

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  updates.length = 0;
  videoRow.current = { bunny_video_id: G1 };
  db = emptyConsentDb();
  db.birthDates.p1 = null; // jugador del análisis: fecha desconocida
  db.playerOwners.p1 = USER; // y su dueño (en su nombre actúa el cron)
  db.storedAttestations.push({ resource_type: "videos", resource_id: "v1" });
  mock = consentFetch(db, {
    fallback: async () => new Response(JSON.stringify({ success: true, data: { abstained: false } }), { status: 200 }),
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => vi.unstubAllGlobals());

async function runCron() {
  const { default: handler } = await import("../process-analyses-queue");
  return handler(new Request("https://x.test/api/crons/process-analyses-queue", { headers: { Authorization: "Bearer cron-secret" } }));
}

describe("cron · consentimiento con los jugadores de la fila videos (B1)", () => {
  it("la fila videos es de un menor de 14 sin consentimiento y el análisis es de OTRO jugador → failed; ni Gemini ni informes", async () => {
    db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: G1 });
    db.playerOwners.pMinor = USER;
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    await runCron();
    expect(calledUrls().some((u) => u.includes("/api/pipeline/gemini-analyze"))).toBe(false);
    expect(calledUrls().some((u) => u.includes("/api/agents/pipeline-orchestrator"))).toBe(false);
    const failed = failedUpdates().filter((u) => /14/.test(String(u.values.status_message)));
    expect(failed).toHaveLength(1);
  });

  it("OTRA fila con el mismo GUID liga el vídeo a un menor sin consentimiento → también failed", async () => {
    db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: G1 });
    db.videos.push({ id: "v1-dup", user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: G1 });
    db.playerOwners.pMinor = USER;
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    await runCron();
    expect(geminiDispatches()).toHaveLength(0);
  });

  it("control: la fila videos sin jugador (o con un adulto) → se despacha a gemini-analyze con ESE GUID", async () => {
    db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: "pAdult", bunny_video_id: G1 });
    db.playerOwners.pAdult = USER;
    db.birthDates.pAdult = "1990-01-01";
    await runCron();
    expect(geminiDispatches()).toHaveLength(1);
    // B4: gemini-analyze recibe el GUID que se comprobó (no lo vuelve a leer a ciegas).
    expect(JSON.parse(String(geminiDispatches()[0].init.body))).toMatchObject({ videoId: "v1", playerId: "p1", bunnyVideoId: G1 });
  });

  it("control: fila de la subida antigua SIN creador (create-upload no ponía user_id) con el jugador del dueño → se despacha", async () => {
    db.videos.push({ id: "v1", user_id: null, tenant_id: null, player_id: "p1", bunny_video_id: G1 });
    await runCron();
    expect(geminiDispatches()).toHaveLength(1);
  });
});

describe("cron · B4: el GUID de la fila tiene que ser un GUID", () => {
  it.each([`a/../${G_VICTIM}`, `${G1}/../${G_VICTIM}`, "bunny-1"])(
    "bunny_video_id %j → failed con motivo; ni gemini-analyze ni Gemini en línea ni consultas del gate",
    async (bad) => {
      videoRow.current = { bunny_video_id: bad };
      db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: bad });
      await runCron();
      expect(geminiDispatches()).toHaveLength(0);
      expect(calledUrls().some((u) => u.includes("generativelanguage") || u.includes("/api/agents/video-observation"))).toBe(false);
      expect(failedUpdates()).toHaveLength(1);
      expect(calledUrls().some((u) => u.includes("/rest/v1/videos"))).toBe(false);
    },
  );

  it("fila sin bunny_video_id → failed 'video not found' (como antes)", async () => {
    videoRow.current = { bunny_video_id: null };
    await runCron();
    expect(geminiDispatches()).toHaveLength(0);
    expect(failedUpdates()[0].values.status_message).toBe("video not found");
  });
});

describe("cron · B5: actúa en nombre del DUEÑO del jugador del análisis", () => {
  it.each([
    ["menor de 14 sin consentimiento", MINOR_BIRTH_DATE],
    ["adulto", "1990-01-01"],
  ])("fila del vídeo ligada a un jugador AJENO (%s) → failed con el MISMO motivo genérico; sin leer su fecha; sin Gemini", async (_l, bd) => {
    db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: G1 });
    db.playerOwners.pForeign = OTHER;
    db.birthDates.pForeign = bd;
    await runCron();
    expect(geminiDispatches()).toHaveLength(0);
    expect(failedUpdates()).toHaveLength(1);
    const msg = String(failedUpdates()[0].values.status_message);
    expect(msg).not.toMatch(/14|parental/i);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/players?id=eq.pForeign&select=birth_date"))).toBe(false);
  });

  it("fila del vídeo creada por OTRO usuario (aunque apunte al jugador del dueño) → failed; sin Gemini", async () => {
    db.videos.push({ id: "v1", user_id: OTHER, tenant_id: null, player_id: "p1", bunny_video_id: G1 });
    await runCron();
    expect(geminiDispatches()).toHaveLength(0);
    expect(failedUpdates()).toHaveLength(1);
  });

  it("jugador del análisis SIN dueño → failed; no se consulta nada más del vídeo", async () => {
    delete db.playerOwners.p1;
    db.videos.push({ id: "v1", user_id: USER, tenant_id: null, player_id: null, bunny_video_id: G1 });
    await runCron();
    expect(geminiDispatches()).toHaveLength(0);
    expect(failedUpdates()).toHaveLength(1);
  });
});
