/**
 * VitasLab · la declaración del entrenador bloquea los dos botones de análisis
 * (decisión del owner, 30 sep): el "Analizar" 1-click (VitasLabOneClick) y el "Analizar
 * este vídeo" del panel de vídeos (LabUploadPanel), también para vídeos subidos antes.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${Object.values(opts).join(" ")}` : key),
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));
vi.mock("framer-motion", () => {
  // Un componente ESTABLE por etiqueta (si no, cada render remonta el subárbol).
  const cache = new Map<string, (p: { children?: React.ReactNode } & Record<string, unknown>) => JSX.Element>();
  const motion = new Proxy({}, {
    get: (_t, prop: string) => {
      if (!cache.has(prop)) {
        cache.set(prop, ({ children, ...props }) => {
          const { animate: _a, transition: _tr, initial: _i, exit: _e, variants: _v, whileTap: _w, ...rest } = props;
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag {...rest}>{children}</Tag>;
        });
      }
      return cache.get(prop);
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/VideoUpload", () => ({ default: () => <div data-testid="video-upload" /> }));
vi.mock("@/components/VideoCard", () => ({ default: () => <div /> }));
vi.mock("@/components/VideoPlayer", () => ({ default: () => <div data-testid="video-player" /> }));

import VitasLabOneClick from "@/components/VitasLabOneClick";
import LabUploadPanel from "@/pages/vitasLab/LabUploadPanel";
import ClipAttestationField from "@/components/consent/ClipAttestationField";
import type { VideoRecord } from "@/services/real/videoService";

const IDLE = { step: "idle", message: "", progress: 0, calibration: null, error: null, isRunning: false, isComplete: false } as const;

function OneClickHarness({ onStart }: { onStart: () => void }) {
  const [attested, setAttested] = useState(false);
  return (
    <VitasLabOneClick
      players={[{ id: "p1", name: "Ana", position: "MC", vsi: null as unknown as number, age: 13 }]}
      videos={[{ id: "v1", title: "Clip" }]}
      selectedPlayerId="p1"
      selectedVideoId="v1"
      oneClickState={IDLE as never}
      isTracking={false}
      isIAProcessing={false}
      isIAComplete={false}
      onSelectPlayer={vi.fn()}
      onSelectVideo={vi.fn()}
      onStartAnalysis={onStart}
      onStopTracking={vi.fn()}
      onOpenUploadPanel={vi.fn()}
      onViewResults={vi.fn()}
      consentControl={<ClipAttestationField id="t" checked={attested} onChange={setAttested} purpose="analysis" />}
      consentReady={attested}
    />
  );
}

describe("VitasLab · declaración antes de analizar", () => {
  it("1-click: el botón Analizar está deshabilitado hasta marcar la declaración", () => {
    const onStart = vi.fn();
    render(<OneClickHarness onStart={onStart} />);
    const analyze = screen.getByText("vitasLabOneClick.analyze").closest("button") as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    expect(screen.getByText("clipConsent.analysisNeedsAttestation")).toBeDefined();
    fireEvent.click(analyze);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(analyze.disabled).toBe(false);
    fireEvent.click(analyze);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("panel de vídeos: 'Analizar este vídeo' (vídeo subido antes) exige la declaración", () => {
    const onStart = vi.fn();
    const video = { id: "v1", title: "Clip antiguo" } as unknown as VideoRecord;
    function PanelHarness() {
      const [attested, setAttested] = useState(false);
      return (
        <LabUploadPanel
          open
          onClose={vi.fn()}
          videos={[video]}
          players={[]}
          selectedVideoId="v1"
          onSelectVideo={vi.fn()}
          onStartAnalysis={onStart}
          consentControl={<ClipAttestationField id="t2" checked={attested} onChange={setAttested} purpose="analysis" />}
          consentReady={attested}
        />
      );
    }
    render(<PanelHarness />);
    const analyze = screen.getByText("vitasLab.analyzeThisVideo").closest("button") as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(analyze.disabled).toBe(false);
    fireEvent.click(analyze);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
