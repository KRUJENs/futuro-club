/**
 * VideoUpload component — Tests
 * Valida UI de upload: drag & drop, file validation, progress, size limit
 * (límite compartido MAX_UPLOAD_SIZE_MB), gate de duración (metadatos del
 * navegador ≤ MAX_MATCH_DURATION_MIN) y el contrato onDone(videoId, info) —
 * upload() resuelve el videoId real (#26).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  MAX_UPLOAD_SIZE_MB,
  MAX_UPLOAD_SIZE_GB,
  MAX_MATCH_DURATION_MIN,
} from "@/lib/shared/videoLimits";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("@/hooks/useVideoUpload", () => ({
  useVideoUpload: vi.fn(),
}));

// Duración leída del navegador: controlada por test (jsdom no decodifica vídeo).
const { mockReadDuration } = vi.hoisted(() => ({
  mockReadDuration: vi.fn(async (): Promise<number | null> => null),
}));
vi.mock("@/lib/localVideoUtils", () => ({
  readVideoDurationSec: mockReadDuration,
}));

// t() devuelve la clave (+ valores interpolados) — mismo patrón que el resto
// de tests del repo; las aserciones no dependen del copy en español.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(" ")}` : key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
      const { variants, initial, animate, exit, whileHover, whileTap, layout, transition, ...rest } = props;
      void variants; void initial; void animate; void exit; void whileHover; void whileTap; void layout; void transition;
      return <div {...rest}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

import VideoUpload from "@/components/VideoUpload";
import { useVideoUpload, type UploadState } from "@/hooks/useVideoUpload";

const mockUseVideoUpload = vi.mocked(useVideoUpload);

const makeState = (overrides: Partial<UploadState> = {}): UploadState => ({
  phase: "idle",
  progress: 0,
  encodeProgress: 0,
  videoId: null,
  error: null,
  video: null,
  analysis: null,
  analysisQueued: false,
  phase2Pending: false,
  uploadSpeed: 0,
  etaSeconds: 0,
  encodeStatus: null,
  syncGateDurationSec: null,
  consentBlocked: null,
  ...overrides,
});

type HookReturn = ReturnType<typeof useVideoUpload>;

const makeHook = (
  state: UploadState = makeState(),
  overrides: Partial<HookReturn> = {}
): HookReturn => ({
  state,
  upload: vi.fn(async () => null),
  cancel: vi.fn(),
  reset: vi.fn(),
  ...overrides,
});

describe("VideoUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("alert", vi.fn());
    mockReadDuration.mockResolvedValue(null);
    mockUseVideoUpload.mockReturnValue(makeHook());
  });

  afterEach(() => {
    // Restaura el `alert` stubeado; si no, fuga a otros tests del fichero.
    vi.unstubAllGlobals();
  });

  // Marca la declaración del entrenador (obligatoria antes de elegir el fichero).
  const attest = () => fireEvent.click(screen.getByRole("checkbox"));

  const pickFile = (file: File, { attested = true }: { attested?: boolean } = {}) => {
    if (attested) attest();
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    // querySelector devuelve null (no undefined) si falta → toBeDefined() nunca
    // fallaría; toBeInstanceOf sí exige que el input exista de verdad.
    expect(input).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(input, { target: { files: [file] } });
  };

  const sizedFile = (name: string, bytes: number) => {
    const f = new File(["x"], name, { type: "video/mp4" });
    Object.defineProperty(f, "size", { value: bytes });
    return f;
  };

  it("renders upload area in idle state", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.dragOrClick")).toBeDefined();
    // formatsHint interpola el límite COMPARTIDO (GB) y la duración de partido
    expect(
      screen.getByText(`videoUpload.formatsHint ${MAX_UPLOAD_SIZE_GB} ${MAX_MATCH_DURATION_MIN}`),
    ).toBeDefined();
  });

  it("acepta un partido completo de más de 2048 MB (antes: 'Máximo 2048 MB')", async () => {
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    mockReadDuration.mockResolvedValue(95 * 60); // 90' + descuento

    render(<VideoUpload />);
    pickFile(sizedFile("partido.mp4", 6 * 1024 * 1024 * 1024)); // 6 GB

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("rejects files larger than MAX_UPLOAD_SIZE_MB (shared limit)", async () => {
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));

    render(<VideoUpload />);
    pickFile(sizedFile("huge.mp4", (MAX_UPLOAD_SIZE_MB + 1) * 1024 * 1024));

    // Should NOT call upload for oversized files — alert instead (no se lee duración)
    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(`videoUpload.fileTooLarge ${MAX_UPLOAD_SIZE_GB}`),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(mockReadDuration).not.toHaveBeenCalled();
  });

  it("rechaza un vídeo más largo que MAX_MATCH_DURATION_MIN (duración real del navegador)", async () => {
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    mockReadDuration.mockResolvedValue((MAX_MATCH_DURATION_MIN + 10) * 60);

    render(<VideoUpload />);
    pickFile(sizedFile("maraton.mp4", 1024));

    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(
        `videoUpload.durationTooLong ${MAX_MATCH_DURATION_MIN + 10} ${MAX_MATCH_DURATION_MIN}`,
      ),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("acepta exactamente MAX_MATCH_DURATION_MIN y pasa la duración real a upload()", async () => {
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    mockReadDuration.mockResolvedValue(MAX_MATCH_DURATION_MIN * 60);

    render(<VideoUpload />);
    const file = sizedFile("final.mp4", 1024);
    pickFile(file);

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ durationSec: MAX_MATCH_DURATION_MIN * 60 }),
      ),
    );
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("duración ilegible → no bloquea y NO inventa un valor (durationSec: null)", async () => {
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    mockReadDuration.mockResolvedValue(null);

    render(<VideoUpload />);
    const file = sizedFile("raro.mkv", 1024);
    pickFile(file);

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(file, expect.objectContaining({ durationSec: null })),
    );
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("done con encodeStatus 'processing' → aviso de codificación en curso (no error)", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "done", progress: 100, videoId: "v1", encodeStatus: "processing" })),
    );
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.encodingPendingTitle")).toBeDefined();
    expect(screen.queryByText("videoUpload.uploadErrorTitle")).toBeNull();
  });

  it("shows uploading progress", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "uploading", progress: 45, videoId: "v1" }))
    );

    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.phaseUploading")).toBeDefined();
    expect(screen.getByText("45%")).toBeDefined();
  });

  it("shows processing state", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "processing", progress: 100, encodeProgress: 65, videoId: "v1" }))
    );

    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.phaseProcessing")).toBeDefined();
    expect(screen.getByText("65%")).toBeDefined();
  });

  it("shows analyzing state", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "analyzing", progress: 100, encodeProgress: 100, videoId: "v1" }))
    );

    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.phaseAnalyzing")).toBeDefined();
    expect(screen.getByText("videoUpload.tacticalAnalysisTitle")).toBeDefined();
  });

  it("shows done state", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "done", progress: 100, encodeProgress: 100, videoId: "v1" }))
    );

    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.uploaded")).toBeDefined();
    expect(screen.getByText(/v1/)).toBeDefined();
  });

  it("shows error state", () => {
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "error", error: "Upload failed: network error" }))
    );

    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.uploadErrorTitle")).toBeDefined();
    expect(screen.getByText("Upload failed: network error")).toBeDefined();
  });

  it("calls onDone with the videoId resolved by upload()", async () => {
    const onDone = vi.fn();
    const upload = vi.fn(async () => "vid-42");
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));

    render(<VideoUpload onDone={onDone} />);
    attest();

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ title: "clip.mp4", onDuplicate: expect.any(Function) })
      ),
    );
    // onDone recibe el videoId devuelto por upload(), no state.videoId (#26),
    // + la duración que leyó el navegador (null aquí: no se inventa).
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("vid-42", { durationSec: null }));
  });

  it("does not call onDone when upload resolves null (failed upload)", async () => {
    const onDone = vi.fn();
    const upload = vi.fn(async () => null);
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));

    render(<VideoUpload onDone={onDone} />);
    attest();

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(upload).toHaveBeenCalled());
    // Purga micro + macrotareas para que un onDone diferido (setTimeout o un
    // hop async extra) tampoco se cuele → la aserción negativa no es vacua.
    await new Promise((r) => setTimeout(r, 0));
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("VideoUpload · declaración del entrenador (decisión del owner, 30 sep)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("alert", vi.fn());
    mockReadDuration.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  const file = () => new File(["x"], "clip.mp4", { type: "video/mp4" });
  const input = () => document.querySelector("input[type='file']") as HTMLInputElement;

  it("la casilla empieza SIN marcar, con el texto versionado; sin marcarla no se sube nada", async () => {
    const upload = vi.fn(async () => "vid-1");
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    render(<VideoUpload />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText("matchJob.attestation.text_2026_09_28_v1")).toBeDefined();
    expect(screen.getByText("clipConsent.uploadNeedsAttestation")).toBeDefined();
    expect(input().disabled).toBe(true);
    expect(screen.getByTestId("video-upload-dropzone").getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(input(), { target: { files: [file()] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(upload).not.toHaveBeenCalled();
    expect(mockReadDuration).not.toHaveBeenCalled();
  });

  it("marcada → upload() recibe { accepted: true, version } (la versión vigente del servidor)", async () => {
    const upload = vi.fn(async () => "vid-1");
    mockUseVideoUpload.mockReturnValue(makeHook(makeState(), { upload }));
    render(<VideoUpload />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { files: [file()] } });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(
        expect.any(File),
        expect.objectContaining({ attestation: { accepted: true, version: "2026-09-28.v1" } }),
      ),
    );
  });

  it("bloqueo del servidor → título 'Análisis no permitido' + su motivo; 'reintentar' desmarca la casilla", () => {
    const reset = vi.fn();
    mockUseVideoUpload.mockReturnValue(
      makeHook(makeState({ phase: "error", error: "motivo del servidor", consentBlocked: "parental_consent_required" }), { reset }),
    );
    render(<VideoUpload />);
    expect(screen.getByText("clipConsent.blockedTitle")).toBeDefined();
    expect(screen.getByText("motivo del servidor")).toBeDefined();
    fireEvent.click(screen.getByText("videoUpload.retry"));
    expect(reset).toHaveBeenCalled();
  });
});
