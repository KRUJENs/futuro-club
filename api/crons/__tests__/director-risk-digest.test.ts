/**
 * Tests · cron director-risk-digest (P0 menores/legal).
 *
 * Antes el cron derivaba el riesgo de un HASH del id y enviaba por email nombres de
 * menores «en riesgo alto». Estos tests fijan el contrato nuevo:
 *   - Solo datos mock/insuficientes → NO sale ningún email (ni nombres ni resumen).
 *   - Evaluación REAL alta → sale, con procedencia, confianza y cobertura declaradas,
 *     y la cifra es la MISMA que calcula el endpoint del panel (inv #7).
 *
 * Los ids "player-2" y "player-17" se eligieron porque el scorer por hash RETIRADO
 * los marcaba en riesgo ALTO (59 y 53): con el código antiguo el test «sin datos»
 * enviaba un email con sus nombres (control negativo ejecutado al escribir el test).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, limit: 30, resetAt: Date.now() + 60000 }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.CRON_SECRET = "cron-secret";
process.env.RESEND_API_KEY = "re_test_dummy";
process.env.VITAS_PUBLIC_URL = "https://vitas.test";

import { computeDropoutAssessment, type DropoutSignalRows } from "../../_lib/dropoutAssessment";
import { provenanceLabel } from "../../../src/lib/metrics/provenanceLabel";
import { ORIENTATIVE_CONFIDENCE } from "../../../src/lib/metrics/MetricResult";

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../director-risk-digest")).default;
});

type Row = Record<string, unknown>;
interface World {
  subs: Row[];
  players: Row[];
  signals: Record<string, Partial<DropoutSignalRows>>;
  emails: Record<string, string>;
}
let world: World;
const calls: Array<{ url: string; method: string; body: string | null }> = [];

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });

  if (url.startsWith("https://api.resend.com/")) return json({ id: "email-1" });
  if (url.includes("/auth/v1/admin/users/")) {
    const id = decodeURIComponent(url.split("/auth/v1/admin/users/")[1]);
    return world.emails[id] ? json({ email: world.emails[id] }) : new Response("not found", { status: 404 });
  }
  const m = url.match(/\/rest\/v1\/([a-z_]+)\?(.*)$/);
  if (!m || method !== "GET") return new Response("unexpected", { status: 500 });
  const [, table, qs] = m;
  const params = new URLSearchParams(qs);
  const eq = (k: string) => (params.get(k) ?? "").replace(/^eq\./, "");

  switch (table) {
    case "subscriptions":
      return json(world.subs);
    case "players": {
      const uid = eq("user_id");
      return json(uid ? world.players.filter((p) => p.user_id === uid) : world.players);
    }
    case "attendance_records":
      return json(world.signals[eq("player_id")]?.attendance ?? []);
    case "engagement_snapshots":
      return json(world.signals[eq("player_id")]?.engagement ?? []);
    case "fatigue_sessions":
      return json(world.signals[eq("player_id")]?.fatigue ?? []);
    default:
      return new Response("unexpected table", { status: 500 });
  }
});
vi.stubGlobal("fetch", fetchMock);

function cronReq(auth = "Bearer cron-secret"): Request {
  return new Request("https://example.com/api/crons/director-risk-digest", {
    method: "GET",
    headers: { Authorization: auth },
  });
}

const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;

/** Señales reales que el scorer canónico sitúa en riesgo ALTO. */
function highRiskRows(playerId: string): DropoutSignalRows {
  return {
    attendance: Array.from({ length: 10 }, (_, i) => ({
      player_id: playerId, date: day(20 - i), status: "absent", source: "manual", session_id: null,
    })),
    engagement: [5, 95, 95, 95, 95].map((c, i) => ({
      session_id: `s${i}`, date: day(20 - i), physical: c, social: c, emotional: c, composite: c, trend: "declining", weekly_avg: c,
    })),
    fatigue: [{ session_date: day(20), total_load: 500, fatigue_index: 100, fatigue_severity: "critical", acwr_value: 1.8, maturation_band: "circa_phv", phv_offset: 0.2 }],
  };
}

/** Señal real de riesgo BAJO (asistencia completa). */
function lowRiskRows(playerId: string): DropoutSignalRows {
  return {
    attendance: Array.from({ length: 10 }, (_, i) => ({
      player_id: playerId, date: day(20 - i), status: "present", source: "manual", session_id: null,
    })),
    engagement: [],
    fatigue: [],
  };
}

const PAID = { user_id: "dir-1", plan: "pro", status: "active" };
const resendCalls = () => calls.filter((c) => c.url.startsWith("https://api.resend.com/"));
const adminLookups = () => calls.filter((c) => c.url.includes("/auth/v1/admin/users/"));
const writes = () => calls.filter((c) => c.url.includes("/rest/v1/") && c.method !== "GET");

describe("cron director-risk-digest", () => {
  beforeEach(() => {
    calls.length = 0;
    fetchMock.mockClear();
    world = { subs: [PAID], players: [], signals: {}, emails: { "dir-1": "director@club.test" } };
  });

  it("403 sin token de servicio y sin tocar Supabase", async () => {
    const res = await handler(cronReq("Bearer wrong"));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("sin Supabase configurado → no-op (skipped) sin llamadas", async () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      // sin service key, el token de servicio válido sigue siendo CRON_SECRET
      const res = await handler(cronReq());
      const body = await res.json();
      expect(body.data.skipped).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    }
  });

  it("solo datos mock/insuficientes → NO envía nada y NO nombra a nadie", async () => {
    world.players = [
      // player-2 / player-17: el hash retirado los marcaba ALTO; aquí no tienen señal real.
      { id: "player-2", user_id: "dir-1", data: { name: "Lucía Menor" } },
      { id: "player-17", user_id: "dir-1", data: { name: "Hugo Menor" } },
      { id: "player-26", user_id: "dir-1", data: { name: "Marta Menor" } },
      { user_id: "dir-1", data: { name: "Sin Id" } },
    ];
    world.signals = {
      // composite 0 = DEFAULT de columna → no es señal
      "player-17": { engagement: [{ date: day(1), physical: 0, social: 0, emotional: 0, composite: 0 }] },
      // sesión de fatiga sin índice → no es señal
      "player-26": { fatigue: [{ session_date: day(1), total_load: 0, fatigue_index: null }] },
    };

    const res = await handler(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(resendCalls()).toHaveLength(0);
    expect(adminLookups()).toHaveLength(0); // ni siquiera busca el email del director
    expect(writes()).toHaveLength(0);       // solo lectura
    expect(body.data.directorsNotified).toBe(0);
    expect(body.data.atRiskTotal).toBe(0);
    expect(body.data.playersEvaluated).toBe(0);
    expect(body.data.playersWithoutData).toBe(4);
    // Ningún nombre sale en ninguna petición.
    for (const c of calls) {
      for (const name of ["Lucía", "Hugo", "Marta", "Sin Id"]) {
        expect(c.body ?? "").not.toContain(name);
        expect(c.url).not.toContain(encodeURIComponent(name));
      }
    }
  });

  it("evaluación REAL alta → email con el jugador, procedencia, confianza y cobertura", async () => {
    world.players = [
      { id: "p-real", user_id: "dir-1", data: { name: "Nombre Real" } },
      { id: "player-2", user_id: "dir-1", data: { name: "Lucía Menor" } }, // sin datos
      { id: "p-low", user_id: "dir-1", data: { name: "Pablo Bajo" } },     // real, riesgo bajo
    ];
    world.signals = { "p-real": highRiskRows("p-real"), "p-low": lowRiskRows("p-low") };

    // La cifra esperada la calcula la MISMA función que usa el panel (inv #7).
    const expected = computeDropoutAssessment("p-real", highRiskRows("p-real"));
    expect(expected.source).toBe("computed");
    expect(expected.assessment.riskLevel).toBe("high");

    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.directorsNotified).toBe(1);
    expect(body.data.atRiskTotal).toBe(1);
    expect(body.data.playersEvaluated).toBe(2);
    expect(body.data.playersWithoutData).toBe(1);

    const sent = resendCalls();
    expect(sent).toHaveLength(1);
    const email = JSON.parse(sent[0].body ?? "{}") as { to: string; subject: string; html: string };
    expect(email.to).toBe("director@club.test");

    // Solo el jugador con evaluación real alta.
    expect(email.html).toContain("Nombre Real");
    expect(email.html).toContain(`${expected.assessment.riskScore}/100`);
    expect(email.html).not.toContain("Lucía");
    expect(email.html).not.toContain("Pablo");

    // Procedencia (etiqueta canónica), confianza y cobertura declaradas.
    expect(email.html).toContain(`Procedencia: ${provenanceLabel("DERIVADA")}`);
    expect(email.html).toContain(`Confianza: ${Math.round(ORIENTATIVE_CONFIDENCE * 100)} %`);
    expect(email.html).toContain("pendientes de validar");
    expect(email.html).toContain("Evaluados con datos reales: <strong>2 de 3</strong>");
    expect(email.html).toContain("Datos usados: asistencia · implicación y motivación · carga (fatiga)");
    expect(email.html).not.toContain(provenanceLabel("MOCK") as string);
    expect(email.html).toContain("https://vitas.test/wellbeing");

    // El asunto no lleva nombres de menores.
    expect(email.subject).not.toContain("Nombre Real");
    expect(email.subject).toContain("1 jugador ");

    // Datos mínimos: solo se leen los jugadores de ESTE director, y nada se escribe.
    const playerReads = calls.filter((c) => c.url.includes("/rest/v1/players?"));
    expect(playerReads.every((c) => c.url.includes("user_id=eq.dir-1"))).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("evaluación real pero solo riesgo bajo/moderado → no envía nada", async () => {
    world.players = [{ id: "p-low", user_id: "dir-1", data: { name: "Pablo Bajo" } }];
    world.signals = { "p-low": lowRiskRows("p-low") };
    const res = await handler(cronReq());
    const body = await res.json();
    expect(resendCalls()).toHaveLength(0);
    expect(body.data.playersEvaluated).toBe(1);
    expect(body.data.directorsNotified).toBe(0);
  });

  it("jugador de ejemplo (data.isDemo) con señales altas → ni se leen sus señales ni se nombra", async () => {
    world.players = [
      { id: "demo-a", user_id: "dir-1", data: { name: "Ejemplo Demo", isDemo: true } },
      // isDemo no booleano NO es demo (mismo criterio estricto que api/rankings/_list.ts)
      { id: "p-real", user_id: "dir-1", data: { name: "Nombre Real", isDemo: "true" } },
    ];
    world.signals = { "demo-a": highRiskRows("demo-a"), "p-real": highRiskRows("p-real") };

    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.playersDemo).toBe(1);
    expect(body.data.playersEvaluated).toBe(1);
    expect(body.data.atRiskTotal).toBe(1);

    // Ninguna lectura de señales del jugador de ejemplo.
    expect(calls.some((c) => c.url.includes("player_id=eq.demo-a"))).toBe(false);

    const email = JSON.parse(resendCalls()[0].body ?? "{}") as { html: string };
    expect(email.html).toContain("Nombre Real");
    expect(email.html).not.toContain("Ejemplo Demo");
    expect(email.html).toContain("Evaluados con datos reales: <strong>1 de 2</strong>");
  });

  it("solo jugadores de ejemplo → no envía nada", async () => {
    world.players = [{ id: "demo-a", user_id: "dir-1", data: { name: "Ejemplo Demo", isDemo: true } }];
    world.signals = { "demo-a": highRiskRows("demo-a") };
    const res = await handler(cronReq());
    const body = await res.json();
    expect(resendCalls()).toHaveLength(0);
    expect(adminLookups()).toHaveLength(0);
    expect(body.data.directorsNotified).toBe(0);
    expect(body.data.playersDemo).toBe(1);
  });

  it("escapa el nombre del jugador en el HTML del email", async () => {
    world.players = [{ id: "p-x", user_id: "dir-1", data: { name: "<img src=x onerror=alert(1)>" } }];
    world.signals = { "p-x": highRiskRows("p-x") };
    await handler(cronReq());
    const email = JSON.parse(resendCalls()[0].body ?? "{}") as { html: string };
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).not.toContain("<img src=x");
  });

  it("solo directores de pago activos: plan free o cancelado no recibe digest", async () => {
    world.subs = [
      { user_id: "dir-free", plan: "free", status: "active" },
      { user_id: "dir-canc", plan: "club", status: "canceled" },
    ];
    world.players = [
      { id: "p-a", user_id: "dir-free", data: { name: "A" } },
      { id: "p-b", user_id: "dir-canc", data: { name: "B" } },
    ];
    world.signals = { "p-a": highRiskRows("p-a"), "p-b": highRiskRows("p-b") };
    world.emails = { "dir-free": "free@club.test", "dir-canc": "canc@club.test" };
    const res = await handler(cronReq());
    const body = await res.json();
    expect(resendCalls()).toHaveLength(0);
    expect(body.data.orgsScanned).toBe(0);
    expect(calls.some((c) => c.url.includes("/rest/v1/players?"))).toBe(false);
  });
});
