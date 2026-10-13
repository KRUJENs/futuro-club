/**
 * Tests · V4.5 cron de rescate de tracking_jobs.
 * El handler es una función plana (auth = Bearer CRON_SECRET), sin withHandler.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

process.env.VITE_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.CRON_SECRET = "cron-secret";

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  handler = (await import("../rescue-tracking-jobs")).default;
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function cronReq(auth = "Bearer cron-secret"): Request {
  return new Request("https://example.com/api/crons/rescue-tracking-jobs", {
    method: "GET",
    headers: { Authorization: auth },
  });
}

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("cron rescue-tracking-jobs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.MODAL_TRACK_ASYNC_URL = "https://modal.test/track_async";
    process.env.MODAL_API_KEY = "modal-key";
    process.env.MODAL_CALLBACK_SECRET = "cb-secret";
    process.env.VITAS_PUBLIC_URL = "https://vitas.test";
  });

  it("401 sin CRON_SECRET correcto", async () => {
    const res = await handler(cronReq("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reaper: marca failed los processing colgados (PATCH condicional por started_at)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes([{ id: "stale-1" }, { id: "stale-2" }])) // reap
      .mockResolvedValueOnce(jsonRes([]));                                      // claim vacío
    const res = await handler(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reaped).toBe(2);

    const reapCall = fetchMock.mock.calls[0];
    expect(String(reapCall[0])).toContain("status=eq.processing");
    expect(String(reapCall[0])).toContain("started_at=lt.");
    expect(JSON.parse(reapCall[1].body).status).toBe("failed");
  });

  it("sin Modal env → reaper corre pero el rescate se salta", async () => {
    delete process.env.MODAL_TRACK_ASYNC_URL;
    fetchMock.mockResolvedValueOnce(jsonRes([])); // reap
    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.skippedRescue).toBe("modal_env_missing");
    expect(fetchMock).toHaveBeenCalledTimes(1); // solo el reap, sin claim
  });

  // Desde B3 (review del PR #308) el rescate pasa por el gate de consentimiento antes del
  // spawn: estos dos tests montan un job de un vídeo PROPIO con la declaración guardada
  // (lo que deja track-async). Los casos bloqueados: rescue-tracking-jobs-consent.test.ts.
  const GUID = "0a0a0a0a-0000-4000-8000-000000000001";
  const USER = "11111111-1111-4111-8111-111111111111";
  const job = (id: string, attempts: number) => ({
    id, video_id: GUID, video_url: `https://cdn.test/${GUID}/play_720p.mp4`, player_id: null, user_id: USER, sample_fps: 5, attempts,
  });
  /** El gate (service role): fila `videos` propia + declaración guardada. Devuelve null si no es del gate. */
  function gateRes(url: string): Response | null {
    if (url.startsWith("https://sb.test/rest/v1/videos?id=in.")) {
      return jsonRes([{ id: GUID, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: GUID }]);
    }
    if (url.startsWith("https://sb.test/rest/v1/videos?bunny_video_id=in.")) {
      return jsonRes([{ id: GUID, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: GUID }]);
    }
    if (url.startsWith("https://sb.test/rest/v1/gdpr_audit_log?")) return jsonRes([{ id: 1 }]);
    return null;
  }

  it("rescate: re-spawnea job reclamado y guarda modal_call_id", async () => {
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const g = gateRes(url);
      if (g) { order.push("gate"); return g; }
      if (url.includes("/rpc/claim_queued_tracking_jobs")) { order.push("claim"); return jsonRes([job("j1", 1)]); }
      if (url === "https://modal.test/track_async") { order.push("spawn"); return jsonRes({ call_id: "call-7" }); }
      if (url.includes("tracking_jobs?id=eq.j1") && init.method === "PATCH") { order.push("patch"); return jsonRes([{ id: "j1" }]); }
      if (url.includes("tracking_jobs?status=eq.processing")) { order.push("reap"); return jsonRes([]); }
      throw new Error(`unexpected ${url}`);
    });
    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.rescued).toBe(1);
    // El gate va ENTRE el claim y el spawn; nada más cambia.
    expect(order[0]).toBe("reap");
    expect(order[1]).toBe("claim");
    expect(order.slice(2, -2).every((o) => o === "gate")).toBe(true);
    expect(order.slice(-2)).toEqual(["spawn", "patch"]);

    const spawnCall = fetchMock.mock.calls.find((c) => c[0] === "https://modal.test/track_async")!;
    const spawnBody = JSON.parse(spawnCall[1].body);
    expect(spawnBody.job_id).toBe("j1");
    expect(spawnBody.callback_url).toBe("https://vitas.test/api/webhooks/modal-tracking");
    delete process.env.BUNNY_CDN_HOSTNAME;
  });

  it("spawn falla → devuelve el job a queued (reintenta el próximo cron)", async () => {
    process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
    const patches: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const g = gateRes(url);
      if (g) return g;
      if (url.includes("/rpc/claim_queued_tracking_jobs")) return jsonRes([job("j2", 2)]);
      if (url === "https://modal.test/track_async") return new Response("boom", { status: 502 });
      if (url.includes("tracking_jobs?id=eq.j2") && init.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return jsonRes([{ id: "j2" }]);
      }
      if (url.includes("tracking_jobs?status=eq.processing")) return jsonRes([]);
      throw new Error(`unexpected ${url}`);
    });
    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.rescued).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].status).toBe("queued");
    delete process.env.BUNNY_CDN_HOSTNAME;
  });

  it("attempts > máximo → entierra el job como failed sin re-spawnear", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes([]))                                                 // reap
      .mockResolvedValueOnce(jsonRes([{ id: "j3", video_url: "https://v/x.mp4", sample_fps: 5, attempts: 4 }])) // claim
      .mockResolvedValueOnce(jsonRes([{ id: "j3" }]));                                     // patch failed
    const res = await handler(cronReq());
    const body = await res.json();
    expect(body.data.buried).toBe(1);
    const bury = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(bury.status).toBe("failed");
    // nunca llamó a Modal
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("modal.test"))).toBe(true);
  });
});
