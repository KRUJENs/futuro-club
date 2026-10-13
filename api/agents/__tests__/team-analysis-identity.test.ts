/**
 * VITAS · Legacy team analysis — identity (identidad.md, P0 minors).
 *
 * The team-observation prompt asked Gemini for `jugadoresObservados[]` with a
 * GUESSED `dorsalEstimado` ("7") plus per-player counts, team-intelligence asked
 * Claude for `jugadores[]` with the same dorsal and per-player figures, and
 * /team-analysis showed "#7" next to passes/duels/recoveries of a child. There is
 * no validated dorsal identification, so the legacy path is TEAM LEVEL ONLY:
 *   - neither prompt requests a dorsal or a per-player list (schema keys pinned);
 *   - per-player data sent in by a client never reaches the Claude prompt;
 *   - whatever a model still emits per player is withheld before it leaves the
 *     server, with the count recorded in `identityWithheld`.
 *
 * Run: npm run test:api -- team-analysis-identity
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

vi.mock("../../_lib/budgetGuard", () => ({
  isOverBudget: vi.fn().mockResolvedValue(false),
  recordSpendUsd: vi.fn().mockResolvedValue(undefined),
  budgetExceededResponse: vi.fn(),
}));

vi.mock("../../_lib/anthropic", () => ({
  fetchMessages: vi.fn(),
}));

// Gate de consentimiento: aquí se prueba la identidad (nivel equipo), así que permite.
// Sus tests propios: api/agents/__tests__/clip-consent-agents.test.ts.
vi.mock("../../_lib/analysisConsentGate", async (orig) => ({
  ...(await orig<typeof import("../../_lib/analysisConsentGate")>()),
  gateClipAnalysis: vi.fn(async () => ({ allowed: true, attestation: "recorded", pendingAttestation: null, minor: null, video: null, videoPlayerIds: [] })),
}));

import teamObservation from "../team-observation";
import teamIntelligence from "../_team-intelligence";
import { fetchMessages } from "../../_lib/anthropic";

// ── Helpers ──────────────────────────────────────────────────────────────────

function post(url: string, body: unknown): Request {
  return new Request(url, {
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

/** Top-level keys of the JSON template written in a prompt (2-space indented `"key":` lines). */
function templateTopLevelKeys(templateBlock: string): string[] {
  return [...templateBlock.matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]);
}

/** The Claude prompt text of the n-th fetchMessages call. */
function claudePrompt(call = 0): string {
  const init = vi.mocked(fetchMessages).mock.calls[call]?.[0] as { body: string };
  const body = JSON.parse(init.body) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  return body.messages[0].content.find((c) => c.type === "text")?.text ?? "";
}

function claudeReturns(report: unknown) {
  vi.mocked(fetchMessages).mockImplementation(async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(report) }] }), { status: 200 }),
  );
}

const TEAM_CONTEXT = { teamColor: "rojo", opponentColor: "azul", competitiveLevel: "formativo" };

/** A team-level report as the new prompt asks for it. */
const TEAM_REPORT = {
  videoId: "v1",
  generatedAt: "2026-09-30T10:00:00.000Z",
  equipoAnalizado: { colorUniforme: "rojo", jugadoresDetectados: 9 },
  resumenEjecutivo: "Equipo ordenado en bloque medio con salida por los centrales.",
  formacion: { sistema: "4-3-3", variantes: ["En ataque los laterales suben"], rigidez: 5 },
  posesion: { porcentaje: 52, estiloCirculacion: "circulación corta", zonasDominadas: ["mediocampo"] },
  fasesJuego: {
    pressing: { tipo: "pressing medio", alturaLinea: "media", intensidad: 6, descripcion: "Los tres delanteros cierran líneas de pase." },
    transiciones: {
      ofensiva: { velocidad: "media", patron: "juego directo", descripcion: "Buscan la banda tras recuperar." },
      defensiva: { velocidad: "media", patron: "repliegue", descripcion: "La línea defensiva repliega ordenada." },
    },
  },
  metricasColectivas: { compacidad: 6, alturaLineaDefensiva: "media", amplitud: 6, sincronizacion: 5, descripcion: "Bloque razonablemente junto." },
  evaluacionGeneral: {
    fortalezasEquipo: ["Salida de balón desde atrás"],
    areasTrabajar: ["Distancia entre líneas"],
    recomendaciones: ["Rondos 4v2 para la salida de balón"],
  },
  confianza: 0.5,
};

/** What an old prompt / a disobedient model produced: a guessed dorsal + per-player figures. */
const PER_PLAYER_ROW = {
  dorsalEstimado: "7",
  posicion: "extremo derecho",
  rol: "desborde por banda",
  rendimiento: "destacado",
  velocidadMaxKmh: null,
  distanciaM: null,
  pases: { completados: 8, fallados: 2 },
  duelos: { ganados: 2, perdidos: 1 },
  recuperaciones: 1,
  resumen: "Desborda por fuera",
};

// ── team-observation (Gemini) ────────────────────────────────────────────────

describe("team-observation · team level only", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let geminiReturns: unknown;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    geminiReturns = { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" };
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReturns) }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  async function run() {
    return teamObservation(
      post("https://x.test/api/agents/team-observation", {
        videoBase64: "AAAA",
        mediaType: "video/mp4",
        teamContext: { teamColor: "rojo" },
      }),
    );
  }

  function geminiPrompt(): string {
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { contents: Array<{ parts: Array<{ text?: string }> }> };
    return body.contents[0].parts.map((p) => p.text ?? "").join("");
  }

  it("the prompt requests no dorsal and no per-player list (template keys pinned)", async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const prompt = geminiPrompt();

    expect(prompt).not.toContain("dorsalEstimado");
    expect(prompt).not.toContain("jugadoresObservados");
    expect(prompt).not.toContain("eventosContados");
    expect(prompt).not.toMatch(/"dorsal/i);
    const template = prompt.slice(prompt.indexOf("Genera un análisis"), prompt.indexOf("REGLAS:"));
    expect(templateTopLevelKeys(template)).toEqual([
      "formacionDetectada",
      "posesionEstimada",
      "fasesJuego",
      "momentosColectivos",
      "resumenGeneral",
    ]);
    // …and says so explicitly.
    expect(prompt).toMatch(/SOLO NIVEL DE EQUIPO/);
  });

  it("strips a per-player list (with a guessed dorsal) if Gemini still returns one", async () => {
    geminiReturns = {
      formacionDetectada: "4-3-3",
      resumenGeneral: "Bloque medio",
      jugadoresObservados: [{ dorsalEstimado: "7", posicionEstimada: "extremo derecho", eventosContados: { pasesCompletados: 8 } }],
    };
    const res = await run();
    const json = (await res.json()) as { data: { observations: Record<string, unknown> } };
    const obs = json.data.observations;

    expect(obs.jugadoresObservados).toBeUndefined();
    expect(JSON.stringify(obs)).not.toContain("dorsalEstimado");
    expect(obs.formacionDetectada).toBe("4-3-3");
    expect(obs.identityWithheld).toEqual({ perPlayerRows: 1, texts: 0 });
  });
});

// ── team-intelligence (Claude) ───────────────────────────────────────────────

describe("team-intelligence · team level only", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(fetchMessages).mockReset();
    claudeReturns(TEAM_REPORT);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("the prompt requests no dorsal and no per-player rows (template keys pinned)", async () => {
    const res = await teamIntelligence(
      post("https://x.test/api/agents/team-intelligence", {
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" },
        keyframes: [],
      }),
    );
    await events(res);
    const prompt = claudePrompt();

    expect(prompt).not.toContain("dorsalEstimado");
    expect(prompt).not.toMatch(/"jugadores"\s*:/);
    expect(prompt).not.toMatch(/RENDIMIENTO POR JUGADOR/);
    const template = prompt.slice(prompt.indexOf("Responde EXCLUSIVAMENTE"), prompt.indexOf("REGLAS CRÍTICAS"));
    expect(templateTopLevelKeys(template)).toEqual([
      "videoId",
      "generatedAt",
      "equipoAnalizado",
      "resumenEjecutivo",
      "formacion",
      "posesion",
      "fasesJuego",
      "metricasColectivas",
      "evaluacionGeneral",
      "confianza",
    ]);
    expect(prompt).toMatch(/IDENTIDAD — SOLO NIVEL DE EQUIPO/);
  });

  it("per-player data sent by a client (legacy observation, YOLO tracks) never reaches the prompt", async () => {
    const res = await teamIntelligence(
      post("https://x.test/api/agents/team-intelligence", {
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: {
          formacionDetectada: "4-3-3",
          resumenGeneral: "Bloque medio",
          jugadoresObservados: [
            { dorsalEstimado: "7", posicionEstimada: "extremo derecho", acciones: [], eventosContados: { pasesCompletados: 8 } },
          ],
          momentosColectivos: [{ timestamp: "1:00", tipo: "positivo", descripcion: "El #10 filtra un pase" }],
        },
        keyframes: [],
        yoloTrackData: [{ trackId: 3, maxSpeedMs: 7, avgSpeedMs: 3, distanceM: 900, sprintCount: 2, duelsWon: 0, duelsLost: 0 }],
      }),
    );
    await events(res);
    const prompt = claudePrompt();

    expect(prompt).not.toContain("JUGADORES OBSERVADOS");
    expect(prompt).not.toMatch(/#7\b/);
    expect(prompt).not.toMatch(/#10\b/);
    expect(prompt).not.toContain("extremo derecho");
    expect(prompt).not.toMatch(/Track #/);
    expect(prompt).not.toMatch(/asociar cada Track/i);
    // Team-level input still arrives.
    expect(prompt).toContain("FORMACIÓN DETECTADA: 4-3-3");
  });

  it("withholds per-player rows and texts naming an individual that the model still emits", async () => {
    claudeReturns({
      ...TEAM_REPORT,
      resumenEjecutivo: "El #7 desborda una y otra vez por la derecha.",
      evaluacionGeneral: {
        ...TEAM_REPORT.evaluacionGeneral,
        recomendaciones: ["Rondos 4v2 para la salida de balón", "Que el dorsal 10 baje a recibir"],
      },
      jugadores: [PER_PLAYER_ROW, { ...PER_PLAYER_ROW, dorsalEstimado: "10" }],
    });
    const res = await teamIntelligence(
      post("https://x.test/api/agents/team-intelligence", {
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" },
        keyframes: [],
      }),
    );
    const evs = await events(res);
    const complete = evs.find((e) => e.event === "complete");
    expect(complete, JSON.stringify(evs)).toBeDefined();
    const report = complete!.data.report as Record<string, unknown>;

    expect(report.jugadores).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("dorsalEstimado");
    expect(JSON.stringify(report)).not.toMatch(/#7\b|dorsal 10/);
    expect(report.resumenEjecutivo).toBe("");
    expect((report.evaluacionGeneral as { recomendaciones: string[] }).recomendaciones).toEqual([
      "Rondos 4v2 para la salida de balón",
    ]);
    expect(report.identityWithheld).toEqual({ perPlayerRows: 2, texts: 2 });
    // Team-level content is kept as is.
    expect(report.formacion).toEqual(TEAM_REPORT.formacion);
    expect(report.metricasColectivas).toEqual(TEAM_REPORT.metricasColectivas);
  });

  it("a team-level report is not sent back for a retry for lacking per-player rows", async () => {
    const res = await teamIntelligence(
      post("https://x.test/api/agents/team-intelligence", {
        teamContext: TEAM_CONTEXT,
        videoId: "v1",
        geminiObservations: { formacionDetectada: "4-3-3", resumenGeneral: "Bloque medio" },
        keyframes: [],
      }),
    );
    const evs = await events(res);
    expect(evs.some((e) => e.event === "complete")).toBe(true);
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    const report = evs.find((e) => e.event === "complete")!.data.report as Record<string, unknown>;
    expect(report.identityWithheld).toBeUndefined();
  });
});
