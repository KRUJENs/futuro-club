/**
 * VITAS · Tests — POST /api/pipeline/gemini-analyze (honestidad del paso Gemini)
 * Run: npx vitest run --config vitest.api.config.ts api/pipeline/__tests__/gemini-analyze.test.ts
 *
 * Antes: contexto con edad 12 / "MID" / "derecho" por defecto, scores `?? 5`,
 * conteos `?? 0`, y la observación se atribuía al jugador aunque Gemini no lo
 * hubiera identificado (el prompt decía "dorsal ? y uniforme color ?").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown> | null;
interface Captured {
  updates: Array<{ table: string; values: Record<string, unknown> }>;
}

let tables: Record<string, Row> = {};
let captured: Captured = { updates: [] };

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
      captured.updates.push({ table, values });
      return chain;
    },
    single: async () => ({ data: tables[table] ?? null, error: null }),
    maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: isUpdate ? [] : tables[table] ?? null, error: null }).then(resolve, reject),
  });
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chainFor(t) }),
}));

const TOKEN = "test-internal-token";

function req(body: Record<string, unknown>) {
  return new Request("https://x.test/api/pipeline/gemini-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const BODY = { videoId: "v1", playerId: "p1", analysisId: "8f14e45f-ceea-4e7a-9b8e-1c2d3e4f5a6b" };

function geminiReply(observation: Record<string, unknown>) {
  return new Response(JSON.stringify({ success: true, data: { observations: observation } }), { status: 200 });
}

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.INTERNAL_API_TOKEN = TOKEN;
  captured = { updates: [] };
  tables = {
    videos: { bunny_video_id: "1d000000-0000-4000-8000-000000000001" },
    players: { name: "Ana", position: null, foot: null },
    player_latest_anthropometrics: null, // sin antropometría registrada
  };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(): Promise<{ status: number; json: Record<string, unknown> }> {
  const { default: handler } = await import("../_gemini-analyze");
  const res = await handler(req(BODY));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function sentPlayerContext(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/agents/video-observation"));
  return JSON.parse((call?.[1] as RequestInit).body as string).playerContext;
}

function analysesUpdate(): Record<string, unknown> {
  const u = captured.updates.filter((x) => x.table === "analyses").pop();
  return u?.values ?? {};
}

describe("gemini-analyze — sin rellenos por defecto", () => {
  it("no inventa edad/posición/pie/nivel del menor en el contexto enviado a Gemini", async () => {
    fetchMock.mockResolvedValue(
      geminiReply({ identificacion: { estado: "unico_jugador", confianza: "alta", motivo: "" }, dimensiones: {}, eventosContados: {} }),
    );
    await run();
    const ctx = sentPlayerContext();
    expect(ctx.age).toBeNull(); // antes 12
    expect(ctx.position).toBeNull(); // antes "MID"
    expect(ctx.foot).toBeNull(); // antes "derecho"
    expect(ctx.competitiveLevel).toBeNull(); // antes "formativo"
  });

  it("score/conteo ausente ⇒ null + gate_reason en lo persistido (antes 5 / 0)", async () => {
    fetchMock.mockResolvedValue(
      geminiReply({
        identificacion: { estado: "unico_jugador", confianza: "alta", motivo: "un solo jugador" },
        dimensiones: { tecnicaConBalon: { observaciones: ["x"], score_estimado: 7 } },
        eventosContados: { pasesCompletados: 4 },
      }),
    );
    const { json } = await run();
    const bm = analysesUpdate().biomechanics as Record<string, unknown>;
    expect(analysesUpdate().status).toBe("processing_reports");
    expect(bm.technical_score).toBe(7);
    expect(bm.physical_score).toBeNull();
    expect(bm.scans).toBeNull();
    expect((bm.gate_reasons as Record<string, string>).physical_score).toBeTruthy();
    expect((json.data as Record<string, unknown>).abstained).toBe(false);
  });
});

describe("gemini-analyze — identidad: abstención en vez de atribuir al menor", () => {
  it("Gemini no identifica al jugador ⇒ análisis failed con motivo, nada atribuido, abstained:true", async () => {
    fetchMock.mockResolvedValue(
      geminiReply({
        identificacion: { estado: "no_identificado", confianza: "alta", motivo: "varios jugadores y sin dorsal de referencia" },
        dimensiones: { tecnicaConBalon: { observaciones: ["x"], score_estimado: 8 } },
        eventosContados: { pasesCompletados: 9 },
      }),
    );
    const { json } = await run();
    const upd = analysesUpdate();
    expect(upd.status).toBe("failed");
    expect(String(upd.status_message)).toMatch(/no identificado/i);
    const bm = upd.biomechanics as Record<string, unknown>;
    expect(bm.technical_score).toBeNull();
    expect(bm.passes_completed).toBeNull();
    expect((json.data as Record<string, unknown>).abstained).toBe(true);
  });

  it("jugador inexistente ⇒ abstención sin llamar a Gemini (antes: «Jugador» genérico de 12 años)", async () => {
    tables.players = null;
    const { json } = await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(analysesUpdate().status).toBe("failed");
    expect((json.data as Record<string, unknown>).abstained).toBe(true);
  });
});

describe("gemini-analyze — B4: el GUID que va en la URL es el que comprobó el cron", () => {
  const G = "0a0a0a0a-0000-4000-8000-000000000001";
  const G_VICTIM = "0b0b0b0b-0000-4000-8000-000000000002";
  const observationUrl = () => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/agents/video-observation"));
    return call ? JSON.parse((call[1] as RequestInit).body as string).videoUrl : null;
  };
  const runWith = async (body: Record<string, unknown>) => {
    const { default: handler } = await import("../_gemini-analyze");
    const res = await handler(req(body));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it.each([`a/../${G_VICTIM}`, `${G}/../${G_VICTIM}`, "bunny-1"])("bunny_video_id %j ⇒ 422 sin llamar a Gemini", async (bad) => {
    tables.videos = { bunny_video_id: bad };
    const { status, json } = await runWith(BODY);
    expect(status).toBe(422);
    expect((json.errorDetail as Record<string, unknown>).code).toBe("invalid_video_reference");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("la fila cambió de GUID desde que el cron la comprobó (bunnyVideoId distinto) ⇒ 409 sin llamar a Gemini", async () => {
    tables.videos = { bunny_video_id: G_VICTIM };
    const { status } = await runWith({ ...BODY, bunnyVideoId: G });
    expect(status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GUID válido y el mismo que comprobó el cron ⇒ la URL enviada a video-observation es la de ESE GUID", async () => {
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
    tables.videos = { bunny_video_id: G };
    fetchMock.mockResolvedValue(
      geminiReply({ identificacion: { estado: "unico_jugador", confianza: "alta", motivo: "" }, dimensiones: {}, eventosContados: {} }),
    );
    await runWith({ ...BODY, bunnyVideoId: G });
    expect(observationUrl()).toBe(`https://cdn.test/${G}/play_720p.mp4`);
    delete process.env.BUNNY_CDN_HOSTNAME;
  });
});
