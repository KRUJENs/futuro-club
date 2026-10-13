/**
 * Tests · B3 (review del PR #308): el cron de rescate de tracking_jobs NO puede mandar a
 * Modal un job que no pasó por el gate de consentimiento.
 *
 * La RLS 052 deja a cualquier usuario con sesión INSERTAR en tracking_jobs con su propio
 * user_id (status 'queued', modal_call_id NULL por defecto) y la RPC
 * claim_queued_tracking_jobs reclama esas filas. Antes el cron las reenviaba a Modal sin
 * declaración, sin propiedad y sin consentimiento parental. Ahora, ANTES del spawn:
 *   - la URL tiene que estar en la allowlist (la misma que track-async);
 *   - el job tiene que tener user_id, ese usuario tiene que gestionar TODAS las filas
 *     `videos` del vídeo y a CADA jugador (si no, «forbidden», sin leer su fecha de
 *     nacimiento: B5);
 *   - tiene que haber una declaración del entrenador YA GUARDADA con la fila del vídeo;
 *   - menor de 14 conocido ⇒ consentimiento parental verificado.
 * Bloqueado → job `failed` con el motivo y SIN llamar a Modal. El body del spawn de un job
 * permitido es BYTE A BYTE el de antes (contrato con Modal sin cambios).
 *
 * Run: npx vitest run --config vitest.api.config.ts api/crons/__tests__/rescue-tracking-jobs-consent.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { MINOR_BIRTH_DATE, consentFetch, emptyConsentDb, type ConsentDbState } from "../../_lib/__tests__/consentFetchMock";

process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
process.env.CRON_SECRET = "cron-secret";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const GUID_OWN = "0a0a0a0a-0000-4000-8000-000000000001";
const GUID_VICTIM = "0b0b0b0b-0000-4000-8000-000000000002";
const MODAL_URL = "https://modal.test/track_async";
const urlOf = (guid: string) => `https://cdn.test/${guid}/play_720p.mp4`;

let handler: (req: Request) => Promise<Response>;
let db: ConsentDbState;
let mock: ReturnType<typeof consentFetch>;
let jobs: Array<Record<string, unknown>>;
let modalCalls: Array<{ url: string; init: RequestInit }>;
let jobPatches: Array<{ url: string; body: Record<string, unknown> }>;

beforeAll(async () => {
  handler = (await import("../rescue-tracking-jobs")).default;
});

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "j1",
    video_id: GUID_OWN,
    video_url: urlOf(GUID_OWN),
    player_id: null,
    user_id: USER,
    sample_fps: 5,
    attempts: 1,
    status: "processing",
    modal_call_id: null,
    ...over,
  };
}

beforeEach(() => {
  process.env.MODAL_TRACK_ASYNC_URL = MODAL_URL;
  process.env.MODAL_API_KEY = "modal-key";
  process.env.MODAL_CALLBACK_SECRET = "cb-secret";
  process.env.VITAS_PUBLIC_URL = "https://vitas.test";
  process.env.BUNNY_CDN_HOSTNAME = "cdn.test";
  db = emptyConsentDb();
  jobs = [job()];
  modalCalls = [];
  jobPatches = [];
  mock = consentFetch(db, {
    fallback: async (url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (url === MODAL_URL) {
        modalCalls.push({ url, init });
        return new Response(JSON.stringify({ call_id: "call-7" }), { status: 200 });
      }
      if (url.startsWith("https://sb.test/rest/v1/tracking_jobs?status=eq.processing")) {
        return new Response("[]", { status: 200 }); // reaper: nada colgado
      }
      if (url === "https://sb.test/rest/v1/rpc/claim_queued_tracking_jobs" && method === "POST") {
        return new Response(JSON.stringify(jobs), { status: 200 });
      }
      if (url.startsWith("https://sb.test/rest/v1/tracking_jobs?id=eq.") && method === "PATCH") {
        jobPatches.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("[]", { status: 200 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
  });
  vi.stubGlobal("fetch", mock.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BUNNY_CDN_HOSTNAME;
});

const run = async () => {
  const res = await handler(
    new Request("https://x.test/api/crons/rescue-tracking-jobs", { headers: { Authorization: "Bearer cron-secret" } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as Record<string, unknown> & { details: Array<Record<string, unknown>> };
};
const birthDateReads = () => mock.calls.filter((c) => c.url.includes("/rest/v1/players?") && c.url.includes("select=birth_date"));

describe("rescue-tracking-jobs · B3: el rescate pasa por el gate antes de Modal", () => {
  it("job insertado por un cliente sobre su vídeo SIN declaración guardada → failed con el motivo; Modal no se llama", async () => {
    db.videos.push({ id: GUID_OWN, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: GUID_OWN });
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(out.rescued).toBe(0);
    expect(jobPatches).toHaveLength(1);
    expect(jobPatches[0].url).toContain("id=eq.j1");
    expect(jobPatches[0].body).toMatchObject({ status: "failed" });
    expect(String(jobPatches[0].body.error)).toMatch(/declaración/);
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "consent_blocked", code: "attestation_required" }));
  });

  it("vídeo de OTRO usuario (GUID conocido), aunque su dueño lo declarase → failed forbidden; Modal no se llama", async () => {
    db.videos.push({ id: GUID_VICTIM, user_id: OTHER, tenant_id: null, player_id: "pMinor", bunny_video_id: GUID_VICTIM });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID_VICTIM, user_id: OTHER });
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    jobs = [job({ video_id: null, video_url: urlOf(GUID_VICTIM) })];
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "failed" });
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "consent_blocked", code: "forbidden" }));
    expect(birthDateReads()).toHaveLength(0);
  });

  it("vídeo propio declarado de un menor de 14 conocido sin consentimiento parental → failed; Modal no se llama", async () => {
    db.videos.push({ id: GUID_OWN, user_id: USER, tenant_id: null, player_id: "pMinor", bunny_video_id: GUID_OWN });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID_OWN, user_id: USER });
    db.playerOwners.pMinor = USER;
    db.birthDates.pMinor = MINOR_BIRTH_DATE;
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "failed" });
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "consent_blocked", code: "parental_consent_required" }));
  });

  it("B5 · fila propia ligada a un jugador AJENO → failed forbidden SIN leer su fecha de nacimiento (el job es legible por quien lo insertó)", async () => {
    db.videos.push({ id: GUID_OWN, user_id: USER, tenant_id: null, player_id: "pForeign", bunny_video_id: GUID_OWN });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID_OWN, user_id: USER });
    db.playerOwners.pForeign = OTHER;
    db.birthDates.pForeign = MINOR_BIRTH_DATE;
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "consent_blocked", code: "forbidden" }));
    expect(birthDateReads()).toHaveLength(0);
    expect(String(jobPatches[0].body.error)).not.toMatch(/14|parental|consentimiento parental/i);
  });

  it("job SIN user_id (no se puede atribuir) → failed; Modal no se llama", async () => {
    db.videos.push({ id: GUID_OWN, user_id: USER, tenant_id: null, player_id: null, bunny_video_id: GUID_OWN });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID_OWN, user_id: USER });
    jobs = [job({ user_id: null })];
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "failed" });
    expect(out.rescued).toBe(0);
  });

  it("URL fuera de la allowlist de vídeo → failed sin consultar nada más; Modal no se llama", async () => {
    jobs = [job({ video_url: `https://evil.test/${GUID_OWN}/play_720p.mp4` })];
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "failed" });
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "consent_blocked", code: "VIDEO_URL_NOT_ALLOWED" }));
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/videos"))).toBe(false);
  });

  it("sin hosts de Bunny configurados (configuración, no decisión) → vuelve a queued; Modal no se llama", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "queued" });
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "requeued_consent_check_failed", code: "VIDEO_HOSTS_NOT_CONFIGURED" }));
  });

  it("base caída al comprobar → el job vuelve a queued (reintento del próximo cron); Modal no se llama", async () => {
    db.failures.videos = { status: 500, body: "boom" };
    const out = await run();
    expect(modalCalls).toHaveLength(0);
    expect(jobPatches[0].body).toMatchObject({ status: "queued" });
    expect(out.details).toContainEqual(expect.objectContaining({ id: "j1", action: "requeued_consent_check_failed" }));
  });

  it("permitido (vídeo propio, declaración guardada, fecha desconocida) → spawn a Modal BYTE A BYTE igual que antes", async () => {
    db.videos.push({ id: GUID_OWN, user_id: USER, tenant_id: null, player_id: "p1", bunny_video_id: GUID_OWN });
    db.storedAttestations.push({ resource_type: "videos", resource_id: GUID_OWN, user_id: USER });
    db.playerOwners.p1 = USER;
    db.birthDates.p1 = null;
    const out = await run();
    expect(out.rescued).toBe(1);
    expect(modalCalls).toHaveLength(1);
    expect(modalCalls[0].init.method).toBe("POST");
    expect(modalCalls[0].init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer modal-key" });
    expect(String(modalCalls[0].init.body)).toBe(
      JSON.stringify({
        video_url: urlOf(GUID_OWN),
        sample_fps: 5,
        classes: [0, 32],
        job_id: "j1",
        callback_url: "https://vitas.test/api/webhooks/modal-tracking",
      }),
    );
    expect(jobPatches).toEqual([{ url: "https://sb.test/rest/v1/tracking_jobs?id=eq.j1", body: { modal_call_id: "call-7" } }]);
    // El rescate no escribe declaraciones (solo cuenta una guardada).
    expect(mock.inserts).toHaveLength(0);
  });

  it("control: attempts por encima del máximo → se entierra sin comprobar nada ni llamar a Modal (como antes)", async () => {
    jobs = [job({ attempts: 4 })];
    const out = await run();
    expect(out.buried).toBe(1);
    expect(modalCalls).toHaveLength(0);
    expect(mock.calls.some((c) => c.url.includes("/rest/v1/videos"))).toBe(false);
  });
});
