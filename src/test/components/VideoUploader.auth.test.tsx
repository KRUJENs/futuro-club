/**
 * VideoUploader (IDP / Tactical vía AnalysisVideoUploadDialog) — cabecera de auth
 *
 * Los tres endpoints que usa (/api/videos/create-upload, /api/videos/finalize,
 * /api/analyses/by-video) son `requireAuth` y `verifyAuth` SOLO acepta
 * `Authorization: Bearer <jwt>`. El componente mandaba `credentials: "include"` sin
 * cabecera → 401 siempre → la subida desde IDP/Tactical nunca funcionaba.
 *
 * Contrato que fija este test:
 *  - cada fetch lleva el `Authorization` del helper compartido `getAuthHeaders` (inv #7),
 *    pedido de nuevo antes de CADA llamada (una subida larga no finaliza con token viejo);
 *  - sin sesión (demo / Supabase sin configurar) el flujo no se rompe: una sola llamada,
 *    sin cabecera, error genérico traducido, sin arrancar TUS;
 *  - 401 con sesión = "sesión caducada" explícito, y en finalize corta el bucle en vez
 *    de acabar en un "Bunny tardó demasiado" falso.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ── Mocks ──────────────────────────────────────────────────────────────────
// t() devuelve la clave (+ valores interpolados): las aserciones no dependen del copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(" ")}` : key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));
vi.mock("@/i18n", () => ({ default: { language: "es", t: (k: string) => k } }));

const { mockGetAuthHeaders } = vi.hoisted(() => ({
  mockGetAuthHeaders: vi.fn(async (): Promise<Record<string, string>> => ({
    "Content-Type": "application/json",
    Authorization: "Bearer test-jwt",
  })),
}));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: mockGetAuthHeaders }));

const { tusStarts } = vi.hoisted(() => ({ tusStarts: { count: 0 } }));
vi.mock("tus-js-client", () => ({
  // `function` (no arrow): se instancia con `new tus.Upload(...)`.
  Upload: vi.fn(function MockUpload(_file: File, opts: { onProgress?: (a: number, b: number) => void; onSuccess?: () => void }) {
    return {
      start: () => {
        tusStarts.count++;
        opts.onProgress?.(100, 100);
        opts.onSuccess?.();
      },
      abort: vi.fn(),
    };
  }),
}));

import { VideoUploader } from "@/components/video/VideoUploader";

// ── Helpers ────────────────────────────────────────────────────────────────
const META = {
  videoId: "vid-abc123",
  bunnyVideoId: "bunny-guid-1",
  libraryId: 42,
  tusUploadUrl: "https://video.bunnycdn.com/tusupload",
  authorizationSignature: "sig",
  authorizationExpire: 9999999999,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Forma real de errorResponse (api/_lib/apiResponse.ts). */
const apiError = (status: number, message: string, code: string) =>
  json(status, { ok: false, success: false, error: message, errorDetail: { message, code } });

type Route = (init: RequestInit | undefined, n: number) => Response;
const fetchMock = vi.fn();

function routeFetch(routes: { create?: Route; finalize?: Route; byVideo?: Route }) {
  const counts = { create: 0, finalize: 0, byVideo: 0 };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/videos/create-upload") return routes.create!(init, ++counts.create);
    if (url === "/api/videos/finalize") return routes.finalize!(init, ++counts.finalize);
    if (url.startsWith("/api/analyses/by-video")) return routes.byVideo!(init, ++counts.byVideo);
    throw new Error(`unexpected fetch ${url}`);
  });
}

const happyRoutes = {
  create: () => json(200, { ok: true, success: true, data: META }),
  finalize: () => json(200, { ok: true, success: true, data: { ready: true, queued: true, analysisId: "an-1" } }),
  byVideo: () =>
    json(200, { ok: true, success: true, data: { analysis: { id: "an-1", status: "completed", status_message: null } } }),
};

/** Cabeceras enviadas en la llamada i-ésima a `urlPrefix` (plain object de getAuthHeaders). */
function headersOf(urlPrefix: string): Array<Record<string, string> | undefined> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith(urlPrefix))
    .map(([, init]) => (init as RequestInit | undefined)?.headers as Record<string, string> | undefined);
}

async function selectFileAndUpload(container: HTMLElement, { attest = true }: { attest?: boolean } = {}) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(200 * 1024)], "clip.mp4", { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
  // Declaración del entrenador (decisión del owner, 30 sep): obligatoria para subir.
  if (attest) fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByText("videoUploader.uploadButton"));
  });
}

const ATTESTATION = { accepted: true, version: "2026-09-28.v1" };
const bodyOf = (urlPrefix: string, i = 0) =>
  JSON.parse(String((fetchMock.mock.calls.filter(([url]) => String(url).startsWith(urlPrefix))[i]?.[1] as RequestInit).body));

/** Avanza los timers falsos (5 s entre finalize, 8 s entre polls) dejando correr las promesas. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockGetAuthHeaders.mockReset();
  mockGetAuthHeaders.mockImplementation(async () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer test-jwt",
  }));
  tusStarts.count = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe("VideoUploader — Authorization header", () => {
  it("sends the shared Bearer token on create-upload, finalize and the by-video status poll", async () => {
    routeFetch(happyRoutes);
    const onComplete = vi.fn();
    const { container } = render(<VideoUploader playerId="p-1" playerName="Ana" onComplete={onComplete} />);

    await selectFileAndUpload(container);
    await advance(5000); // → finalize (ready)
    await advance(8000); // → by-video (completed)

    const create = headersOf("/api/videos/create-upload");
    const finalize = headersOf("/api/videos/finalize");
    const byVideo = headersOf("/api/analyses/by-video");
    expect(create).toHaveLength(1);
    expect(finalize).toHaveLength(1);
    expect(byVideo).toHaveLength(1);
    for (const h of [...create, ...finalize, ...byVideo]) {
      expect(h?.Authorization).toBe("Bearer test-jwt");
    }
    // El body JSON sigue declarando su tipo (lo aporta el propio helper).
    expect(create[0]?.["Content-Type"]).toBe("application/json");
    expect(finalize[0]?.["Content-Type"]).toBe("application/json");

    // Flujo completo: TUS arrancó y el análisis terminado llega al caller.
    expect(tusStarts.count).toBe(1);
    expect(onComplete).toHaveBeenCalledWith("an-1");
    expect(screen.getByText("videoUploader.statusCompleted")).toBeInTheDocument();
  });

  it("asks the helper for a fresh token before EVERY request (long uploads must not reuse a stale one)", async () => {
    let n = 0;
    mockGetAuthHeaders.mockImplementation(async () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer jwt-${++n}`,
    }));
    routeFetch({
      ...happyRoutes,
      // 1er finalize: Bunny aún codificando → reintento con token nuevo.
      finalize: (_init, i) =>
        i === 1
          ? json(200, { ok: true, success: true, data: { ready: false, status: 3 } })
          : happyRoutes.finalize(),
    });
    const { container } = render(<VideoUploader playerId="p-1" />);

    await selectFileAndUpload(container);
    await advance(5000); // finalize #1 (not ready)
    await advance(5000); // finalize #2 (ready)
    await advance(8000); // by-video

    const sent = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>).Authorization);
    expect(sent).toEqual(["Bearer jwt-1", "Bearer jwt-2", "Bearer jwt-3", "Bearer jwt-4"]);
    expect(mockGetAuthHeaders).toHaveBeenCalledTimes(4);
  });

  it("no session (demo / Supabase not configured): degrades to the translated generic error without crashing", async () => {
    // El helper real, sin sesión, NO lanza: devuelve solo Content-Type.
    mockGetAuthHeaders.mockImplementation(async () => ({ "Content-Type": "application/json" }));
    routeFetch({ create: () => apiError(401, "No autenticado", "unauthorized") });
    const { container } = render(<VideoUploader playerId="p-1" />);

    await selectFileAndUpload(container);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOf("/api/videos/create-upload")[0]?.Authorization).toBeUndefined();
    expect(tusStarts.count).toBe(0);
    // Sin sesión no hay nada que "caducar": error genérico, nunca el de sesión caducada.
    expect(screen.getByText("videoUploader.errorCreatingUpload")).toBeInTheDocument();
    expect(screen.queryByText("errors.sessionExpired")).not.toBeInTheDocument();
    expect(screen.getByText("videoUploader.uploadAnother")).toBeInTheDocument();
  });

  it("a 401 on create-upload WITH a token reports the expired session", async () => {
    routeFetch({ create: () => apiError(401, "Token rechazado: jwt expired", "unauthorized") });
    const { container } = render(<VideoUploader playerId="p-1" />);

    await selectFileAndUpload(container);

    expect(headersOf("/api/videos/create-upload")[0]?.Authorization).toBe("Bearer test-jwt");
    expect(tusStarts.count).toBe(0);
    expect(screen.getByText("errors.sessionExpired")).toBeInTheDocument();
  });

  it("a 401 on finalize stops immediately with the expired-session message (no false Bunny timeout)", async () => {
    routeFetch({
      ...happyRoutes,
      finalize: () => apiError(401, "No autenticado", "unauthorized"),
    });
    const { container } = render(<VideoUploader playerId="p-1" />);

    await selectFileAndUpload(container);
    await advance(5000); // finalize #1 → 401
    await advance(5000 * 12); // si siguiera reintentando, aquí se verían más llamadas

    expect(headersOf("/api/videos/finalize")).toHaveLength(1);
    expect(headersOf("/api/analyses/by-video")).toHaveLength(0);
    expect(screen.getByText("errors.sessionExpired")).toBeInTheDocument();
    expect(screen.queryByText("videoUploader.errorBunnyTimeout")).not.toBeInTheDocument();
  });

  it("a 401 while polling the analysis status stops with the expired-session message", async () => {
    routeFetch({
      ...happyRoutes,
      byVideo: () => apiError(401, "No autenticado", "unauthorized"),
    });
    const { container } = render(<VideoUploader playerId="p-1" />);

    await selectFileAndUpload(container);
    await advance(5000); // finalize ready
    await advance(8000); // by-video → 401
    await advance(8000 * 5);

    expect(headersOf("/api/analyses/by-video")).toHaveLength(1);
    expect(screen.getByText("errors.sessionExpired")).toBeInTheDocument();
    expect(screen.queryByText("videoUploader.statusTakingLong")).not.toBeInTheDocument();
  });
});

describe("VideoUploader — declaración del entrenador (decisión del owner, 30 sep)", () => {
  it("sin marcar la declaración el botón de subir está deshabilitado y no se llama a nada", async () => {
    routeFetch(happyRoutes);
    const { container } = render(<VideoUploader playerId="p-1" />);
    await selectFileAndUpload(container, { attest: false });
    expect((screen.getByText("videoUploader.uploadButton") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("clipConsent.uploadNeedsAttestation")).toBeInTheDocument();
  });

  it("marcada → create-upload y finalize llevan { accepted: true, version } (nunca fabricada)", async () => {
    routeFetch(happyRoutes);
    const { container } = render(<VideoUploader playerId="p-1" />);
    await selectFileAndUpload(container);
    await advance(5000);
    expect(bodyOf("/api/videos/create-upload").attestation).toEqual(ATTESTATION);
    expect(bodyOf("/api/videos/finalize").attestation).toEqual(ATTESTATION);
  });

  it("menor de 14 sin consentimiento parental (403 del servidor) → motivo traducido, sin TUS ni 'sesión caducada'", async () => {
    routeFetch({ create: () => apiError(403, "motivo", "parental_consent_required") });
    const { container } = render(<VideoUploader playerId="p-1" />);
    await selectFileAndUpload(container);
    expect(tusStarts.count).toBe(0);
    expect(screen.queryByText("errors.sessionExpired")).not.toBeInTheDocument();
    // El mensaje sale del catálogo de videoConsent en el idioma de la UI (es).
    expect(screen.getByText(/menos de 14 años/)).toBeInTheDocument();
  });

  it("bloqueo en finalize → para con su motivo (no reintenta 12 veces)", async () => {
    routeFetch({ ...happyRoutes, finalize: () => apiError(400, "motivo", "attestation_required") });
    const { container } = render(<VideoUploader playerId="p-1" />);
    await selectFileAndUpload(container);
    await advance(5000);
    await advance(5000 * 12);
    expect(headersOf("/api/videos/finalize")).toHaveLength(1);
    expect(screen.getByText(/declaración del entrenador/)).toBeInTheDocument();
  });
});
