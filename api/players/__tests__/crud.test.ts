/**
 * Tests for /api/players/crud — Player CRUD Endpoint
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/rateLimit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 59, limit: 60, resetAt: Date.now() + 60000,
  }),
  getClientIP: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../_lib/auth", () => ({
  verifyAuth: vi.fn().mockResolvedValue({ userId: "user-crud-123", error: null }),
}));

import crudHandler from "../_crud";

function makeRequest(
  method: string,
  body?: unknown,
  searchParams?: Record<string, string>,
): Request {
  const url = new URL("https://example.com/api/players/crud");
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  }
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
  };
  if (body && method !== "GET") {
    init.body = JSON.stringify(body);
  }
  return new Request(url.toString(), init);
}

const VALID_PLAYER = {
  name: "Lucas Moreno",
  age: 15,
  position: "RW",
  foot: "right" as const,
  height: 172,
  weight: 62,
  competitiveLevel: "Regional",
  minutesPlayed: 840,
  metrics: { speed: 80, technique: 74, vision: 71, stamina: 76, shooting: 78, defending: 45 },
};

describe("/api/players/crud", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when Supabase not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await crudHandler(makeRequest("GET"));
    expect(res.status).toBe(503);
  });

  describe("GET — list players", () => {
    it("fetches all players for user", async () => {
      const mockRows = [
        { id: "p1", data: { name: "Lucas", age: 15, vsi: 70 }, updated_at: "2026-01-01" },
        { id: "p2", data: { name: "Pablo", age: 14, vsi: 65 }, updated_at: "2026-01-02" },
      ];

      // El GET ahora consulta team_members (roster del club) antes que players.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (String(url).includes("team_members")) {
          return new Response(JSON.stringify([]), {});
        }
        return new Response(JSON.stringify(mockRows), {
          headers: { "content-range": "0-1/2" },
        });
      });

      const res = await crudHandler(makeRequest("GET"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.players).toHaveLength(2);
      expect(body.data.total).toBe(2);
      expect(body.data.players[0].name).toBe("Lucas");
    });

    it("fetches single player by id", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (String(url).includes("team_members")) {
          return new Response(JSON.stringify([]), {});
        }
        return new Response(JSON.stringify([
          { id: "p1", data: { name: "Lucas", age: 15, vsi: 70 }, updated_at: "2026-01-01" },
        ]), { headers: { "content-range": "0-0/1" } });
      });

      const res = await crudHandler(makeRequest("GET", undefined, { id: "p1" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("Lucas");
      expect(body.data.id).toBe("p1");
    });
  });

  describe("POST — create player", () => {
    it("creates player and calculates VSI", async () => {
      let insertedBody: Record<string, unknown> = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        insertedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify([{
          id: insertedBody.id,
          data: insertedBody.data,
        }]), { status: 201 });
      });

      const res = await crudHandler(makeRequest("POST", VALID_PLAYER));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe("Lucas Moreno");
      expect(body.data.vsi).toBeGreaterThan(0);
      expect(body.data.vsiHistory).toHaveLength(1);
      expect(insertedBody.user_id).toBe("user-crud-123");
      // La evaluación queda con fecha y origen (base de toda variación del VSI).
      expect(body.data.vsiEvaluations).toHaveLength(1);
      expect(body.data.vsiEvaluations[0]).toMatchObject({ value: body.data.vsi, source: "players_api" });
      expect(Number.isFinite(Date.parse(body.data.vsiEvaluations[0].at))).toBe(true);
    });

    it("sin métricas (alta rápida) ⇒ sin VSI y sin evaluaciones registradas", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const parsed = JSON.parse(init?.body as string);
        return new Response(JSON.stringify([{ id: parsed.id, data: parsed.data }]), { status: 201 });
      });
      const { metrics: _omit, ...noMetrics } = VALID_PLAYER;
      const res = await crudHandler(makeRequest("POST", noMetrics));
      const body = await res.json();
      expect(body.data.vsi).toBeNull();
      expect(body.data.vsiEvaluations).toEqual([]);
    });

    it("alta rápida SIN pie, medidas ni nivel (asistente del primer jugador) ⇒ 201 y nada inventado", async () => {
      // P1 bloque 2: antes el schema exigía pie/talla/peso (400 al saltarse las medidas)
      // y ponía competitiveLevel «Regional» por defecto.
      let insertedBody: Record<string, unknown> = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        insertedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify([{ id: insertedBody.id, data: insertedBody.data }]), { status: 201 });
      });
      const res = await crudHandler(makeRequest("POST", {
        name: "Lucas Moreno", age: 11, position: "RW", birthDate: "2015-03-02",
      }));
      expect(res.status).toBe(201);
      const data = insertedBody.data as Record<string, unknown>;
      expect(data.competitiveLevel).toBeUndefined();
      expect(data.foot).toBeUndefined();
      expect(data.height).toBeUndefined();
      expect(data.weight).toBeUndefined();
      expect(insertedBody.competitive_level).toBeNull();
      expect(insertedBody.foot).toBeNull();
      expect(insertedBody.height_cm).toBeNull();
      expect(insertedBody.weight_kg).toBeNull();
    });

    it("medidas fuera de rango siguen rechazándose (opcional ≠ sin validar)", async () => {
      const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, height: 40 }));
      expect(res.status).toBe(400);
    });

    it("rejects invalid player data", async () => {
      const res = await crudHandler(makeRequest("POST", { name: "A" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorDetail.code).toBe("VALIDATION_ERROR");
    });

    it("accepts client-provided id", async () => {
      let savedId = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const parsed = JSON.parse(init?.body as string);
        savedId = parsed.id;
        return new Response(JSON.stringify([{ id: savedId, data: parsed.data }]), { status: 201 });
      });

      const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, id: "custom-id-123" }));
      expect(res.status).toBe(201);
      expect(savedId).toBe("custom-id-123");
    });
  });

  describe("PATCH — update player", () => {
    it("updates metrics and recalculates VSI", async () => {
      const currentData = { name: "Lucas", metrics: VALID_PLAYER.metrics, vsi: 70, vsiHistory: [70] };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) {
          return new Response(JSON.stringify([{ data: currentData }]));
        }
        if (init?.method === "PATCH") {
          const body = JSON.parse(init.body as string);
          return new Response(JSON.stringify([{ id: "p1", data: body.data }]));
        }
        return new Response("{}", { status: 404 });
      });

      const res = await crudHandler(makeRequest("PATCH", {
        id: "p1",
        metrics: { speed: 90, technique: 85, vision: 80, stamina: 75, shooting: 70, defending: 60 },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.vsi).toBeGreaterThan(70);
      expect(body.data.vsiHistory).toHaveLength(2);
      // El legacy sin fechas no se convierte en evaluación: solo la NUEVA queda fechada.
      expect(body.data.vsiEvaluations).toHaveLength(1);
      expect(body.data.vsiEvaluations[0]).toMatchObject({ value: body.data.vsi, source: "players_api" });
    });

    it("PATCH con métricas AÑADE una evaluación fechada a las previas", async () => {
      const prevEval = { value: 70, at: "2026-09-01T10:00:00.000Z", source: "coach_form" };
      const currentData = { name: "Lucas", metrics: VALID_PLAYER.metrics, vsi: 70, vsiHistory: [70], vsiEvaluations: [prevEval] };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) return new Response(JSON.stringify([{ data: currentData }]));
        if (init?.method === "PATCH") {
          const b = JSON.parse(init.body as string);
          return new Response(JSON.stringify([{ id: "p1", data: b.data }]));
        }
        return new Response("{}", { status: 404 });
      });
      const res = await crudHandler(makeRequest("PATCH", {
        id: "p1",
        metrics: { speed: 90, technique: 85, vision: 80, stamina: 75, shooting: 70, defending: 60 },
      }));
      const body = await res.json();
      expect(body.data.vsiEvaluations).toHaveLength(2);
      expect(body.data.vsiEvaluations[0]).toEqual(prevEval);
      expect(body.data.vsiEvaluations[1]).toMatchObject({ value: body.data.vsi, source: "players_api" });
    });

    it("PATCH sin métricas NO registra evaluación", async () => {
      const prevEval = { value: 70, at: "2026-09-01T10:00:00.000Z", source: "coach_form" };
      const currentData = { name: "Lucas", metrics: VALID_PLAYER.metrics, vsi: 70, vsiHistory: [70], vsiEvaluations: [prevEval] };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) return new Response(JSON.stringify([{ data: currentData }]));
        if (init?.method === "PATCH") {
          const b = JSON.parse(init.body as string);
          return new Response(JSON.stringify([{ id: "p1", data: b.data }]));
        }
        return new Response("{}", { status: 404 });
      });
      const res = await crudHandler(makeRequest("PATCH", { id: "p1", name: "Otro" }));
      const body = await res.json();
      expect(body.data.vsiEvaluations).toEqual([prevEval]);
    });

    it("returns 404 for non-existent player", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([])),
      );

      const res = await crudHandler(makeRequest("PATCH", { id: "nonexistent" }));
      expect(res.status).toBe(404);
    });

    it("updates name without affecting metrics", async () => {
      const currentData = { name: "Old Name", metrics: VALID_PLAYER.metrics, vsi: 70, vsiHistory: [70] };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) {
          return new Response(JSON.stringify([{ data: currentData }]));
        }
        if (init?.method === "PATCH") {
          const body = JSON.parse(init.body as string);
          return new Response(JSON.stringify([{ id: "p1", data: body.data }]));
        }
        return new Response("{}", { status: 404 });
      });

      const res = await crudHandler(makeRequest("PATCH", { id: "p1", name: "New Name" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("New Name");
      expect(body.data.vsi).toBe(70); // unchanged
    });
  });

  // La fecha de nacimiento DEL JUGADOR llega a players.birth_date: es la columna
  // que lee el control RGPD de consentimiento parental (036). Antes el POST la
  // descartaba (no estaba en el schema) y ni POST ni PATCH escribían la columna.
  describe("birth_date (control RGPD de consentimiento)", () => {
    function capturePost() {
      const cap: { body: Record<string, unknown> } = { body: {} };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        cap.body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify([{ id: cap.body.id, data: cap.body.data }]), { status: 201 });
      });
      return cap;
    }

    function capturePatch(currentData: Record<string, unknown>) {
      const cap: { body: Record<string, unknown> } = { body: {} };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) {
          return new Response(JSON.stringify([{ data: currentData, updated_at: "2026-01-01" }]));
        }
        if (init?.method === "PATCH") {
          cap.body = JSON.parse(init.body as string);
          return new Response(JSON.stringify([{ id: "p1", data: cap.body.data }]));
        }
        return new Response("{}", { status: 404 });
      });
      return cap;
    }

    it("POST con birthDate ⇒ birth_date en la columna y birthDate en el blob", async () => {
      const cap = capturePost();
      const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, birthDate: "2015-05-10" }));
      expect(res.status).toBe(201);
      expect(cap.body.birth_date).toBe("2015-05-10");
      expect((cap.body.data as Record<string, unknown>).birthDate).toBe("2015-05-10");
    });

    it("POST sin birthDate ⇒ birth_date null (nunca una fecha inventada)", async () => {
      const cap = capturePost();
      await crudHandler(makeRequest("POST", VALID_PLAYER));
      expect(cap.body).toHaveProperty("birth_date", null);
    });

    it("POST con birthDate no válida (futura / imposible) ⇒ 400, no se guarda a medias", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      for (const bad of ["2999-01-01", "2014-02-30", "10/05/2015"]) {
        const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, birthDate: bad }));
        expect(res.status).toBe(400);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("PATCH de otro campo ⇒ birth_date proyectado desde el blob", async () => {
      const cap = capturePatch({ name: "Old", birthDate: "2014-03-15", vsi: null, vsiHistory: [] });
      const res = await crudHandler(makeRequest("PATCH", { id: "p1", name: "New Name" }));
      expect(res.status).toBe(200);
      expect(cap.body.birth_date).toBe("2014-03-15");
    });

    it("PATCH birthDate ⇒ actualiza blob y columna; null la borra de ambos", async () => {
      let cap = capturePatch({ name: "Old", vsi: null, vsiHistory: [] });
      await crudHandler(makeRequest("PATCH", { id: "p1", birthDate: "2015-05-10" }));
      expect(cap.body.birth_date).toBe("2015-05-10");
      expect((cap.body.data as Record<string, unknown>).birthDate).toBe("2015-05-10");

      vi.restoreAllMocks();
      cap = capturePatch({ name: "Old", birthDate: "2015-05-10", vsi: null, vsiHistory: [] });
      await crudHandler(makeRequest("PATCH", { id: "p1", birthDate: null }));
      expect(cap.body).toHaveProperty("birth_date", null);
      expect(cap.body.data as Record<string, unknown>).not.toHaveProperty("birthDate");
    });

    // Orden de despliegue: el código se despliega antes de que el operador aplique
    // migraciones. Si una base no tuviera players.birth_date (036), PostgREST
    // rechaza la fila ENTERA: el endpoint reintenta sin esa columna (como antes)
    // en vez de devolver 500 al alta del FirstRunWizard.
    const MISSING_BIRTH_DATE = JSON.stringify({
      code: "PGRST204",
      message: "Could not find the 'birth_date' column of 'players' in the schema cache",
    });

    it("base SIN birth_date ⇒ POST reintenta sin la columna: 201, el blob conserva la fecha", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        bodies.push(body);
        if ("birth_date" in body) return new Response(MISSING_BIRTH_DATE, { status: 400 });
        return new Response(JSON.stringify([{ id: body.id, data: body.data }]), { status: 201 });
      });
      const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, birthDate: "2015-05-10" }));
      expect(res.status).toBe(201);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toHaveProperty("birth_date");
      expect((bodies[1].data as Record<string, unknown>).birthDate).toBe("2015-05-10");
    });

    it("base SIN birth_date ⇒ PATCH reintenta sin la columna: 200", async () => {
      const patches: Array<Record<string, unknown>> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("select=data")) {
          return new Response(JSON.stringify([{ data: { name: "Old", vsi: null, vsiHistory: [] }, updated_at: "2026-01-01" }]));
        }
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        patches.push(body);
        if ("birth_date" in body) return new Response(MISSING_BIRTH_DATE, { status: 400 });
        return new Response(JSON.stringify([{ id: "p1", data: body.data }]));
      });
      const res = await crudHandler(makeRequest("PATCH", { id: "p1", birthDate: "2015-05-10" }));
      expect(res.status).toBe(200);
      expect(patches).toHaveLength(2);
      expect(patches[1]).not.toHaveProperty("birth_date");
    });

    it("otro error de escritura NO se enmascara: 500 y sin reintento", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }), { status: 409 }),
      );
      const res = await crudHandler(makeRequest("POST", { ...VALID_PLAYER, birthDate: "2015-05-10" }));
      expect(res.status).toBe(500);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("DELETE — remove player", () => {
    it("deletes player by id", async () => {
      let deletedUrl = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (init?.method === "DELETE") {
          deletedUrl = typeof url === "string" ? url : url.toString();
          return new Response(null, { status: 204 });
        }
        return new Response("{}", { status: 404 });
      });

      const res = await crudHandler(makeRequest("DELETE", { id: "p1" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);
      expect(deletedUrl).toContain("id=eq.p1");
      expect(deletedUrl).toContain("user_id=eq.user-crud-123");
    });

    it("rejects DELETE without id", async () => {
      const res = await crudHandler(makeRequest("DELETE", {}));
      expect(res.status).toBe(400);
    });
  });
});
