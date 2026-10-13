/**
 * VideoUpload component — Extended tests
 * Cubre estados idle/error/done/phase2Pending con un mock de estado mutable
 * tipado como UploadState (todas las phases asignables).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VideoUpload from "@/components/VideoUpload";
import type { UploadState } from "@/hooks/useVideoUpload";
import { MAX_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_GB } from "@/lib/shared/videoLimits";

// Estado inicial canónico (fuente única — evita literales duplicados que
// derivan cuando UploadState gana un campo).
const IDLE_STATE: UploadState = {
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
};

// Estado mutable compartido; tipado como UploadState para que cada bloque
// pueda asignar cualquier phase ("error", "done", …) sin narrowing a "idle".
const mockState: UploadState = { ...IDLE_STATE };

const resetState = (overrides: Partial<UploadState> = {}) => {
  Object.assign(mockState, IDLE_STATE, overrides);
};

const mockUpload = vi.fn(async (): Promise<string | null> => null);
const mockCancel = vi.fn();
const mockReset = vi.fn();

vi.mock("@/hooks/useVideoUpload", () => ({
  useVideoUpload: () => ({
    state: mockState,
    upload: mockUpload,
    cancel: mockCancel,
    reset: mockReset,
  }),
}));

// jsdom no decodifica vídeo (loadedmetadata nunca llega) → duración "no legible".
vi.mock("@/lib/localVideoUtils", () => ({
  readVideoDurationSec: vi.fn(async () => null),
}));

// t() devuelve la clave (+ valores interpolados) — patrón estándar del repo.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(" ")}` : key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, className, onClick, onDragOver, onDragLeave, onDrop }: any) => (
      <div className={className} onClick={onClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

describe("VideoUpload — idle state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  afterEach(() => {
    // Restaura spies (p.ej. window.alert) aunque una aserción haya lanzado;
    // el mockRestore inline se saltaría en ese caso y el spy fugaría.
    vi.restoreAllMocks();
  });

  it("renders dropzone in idle state", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.dragOrClick")).toBeTruthy();
  });

  it("renders title input in idle state", () => {
    render(<VideoUpload />);
    expect(screen.getByPlaceholderText("videoUpload.titlePlaceholder")).toBeTruthy();
  });

  it("shows powered by badge", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.poweredBy")).toBeTruthy();
  });

  it("rejects oversized files (shared MAX_UPLOAD_SIZE_MB)", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<VideoUpload />);
    // Declaración del entrenador: obligatoria antes de elegir el fichero.
    fireEvent.click(screen.getByRole("checkbox"));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bigFile = new File(["x".repeat(100)], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(bigFile, "size", { value: (MAX_UPLOAD_SIZE_MB + 1) * 1024 * 1024 });

    fireEvent.change(input, { target: { files: [bigFile] } });
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(`videoUpload.fileTooLarge ${MAX_UPLOAD_SIZE_GB}`),
    );
    expect(mockUpload).not.toHaveBeenCalled();
    // restore lo hace el afterEach (robusto ante fallo de aserción).
  });

  it("no rechaza un fichero de 2049 MB (el tope antiguo de 2048 MB ya no aplica)", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<VideoUpload />);
    fireEvent.click(screen.getByRole("checkbox")); // declaración obligatoria

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "partido.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 2049 * 1024 * 1024 });

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("VideoUpload — error state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState({ phase: "error", error: "Network timeout" });
  });

  it("shows error message", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.uploadErrorTitle")).toBeTruthy();
    expect(screen.getByText("Network timeout")).toBeTruthy();
  });

  it("shows retry button", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.retry")).toBeTruthy();
  });

  it("calls reset on retry click", () => {
    render(<VideoUpload />);
    fireEvent.click(screen.getByText("videoUpload.retry"));
    expect(mockReset).toHaveBeenCalled();
  });
});

describe("VideoUpload — done state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState({
      phase: "done",
      progress: 100,
      encodeProgress: 100,
      videoId: "test-video-123",
      analysisQueued: true,
    });
  });

  it("shows success message", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.uploaded")).toBeTruthy();
  });

  it("shows video ID", () => {
    render(<VideoUpload />);
    expect(screen.getByText(/test-video-123/)).toBeTruthy();
  });

  it("shows analysis queued message (no 1-frame summary)", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.analysisQueuedTitle")).toBeTruthy();
    expect(screen.getByText("videoUpload.analysisQueuedHint")).toBeTruthy();
  });

  it("shows upload another button", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.uploadAnother")).toBeTruthy();
  });
});

describe("VideoUpload — phase2Pending state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState({ phase: "error", phase2Pending: true });
  });

  it("shows phase 2 message instead of error", () => {
    render(<VideoUpload />);
    expect(screen.getByText("videoUpload.phase2ModuleTitle")).toBeTruthy();
    expect(screen.getByText("videoUpload.phase2ConfigHint")).toBeTruthy();
  });
});
