/**
 * Regresión: el módulo IDP (/idp/:playerId y la pestaña "Plan" del Hub) crasheaba
 * con "Algo salió mal" cuando el perfil conductual llegaba truthy pero SIN objeto
 * `scores` (respuesta parcial de la API). El crash era
 * `Cannot read properties of undefined (reading 'mentalComposite')` en
 * useIDPArchitectInput. Este test fija que un perfil sin `scores` degrada
 * limpiamente (sin dimensión mental) en vez de romper.
 */
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks de las 4 fuentes que consume el hook ──
const mocks = vi.hoisted(() => ({
  player: undefined as unknown,
  behavioralProfile: undefined as unknown,
  savedAnalyses: [] as unknown[],
}));

vi.mock("@/hooks/usePlayers", () => ({
  usePlayerById: () => ({ data: mocks.player, isLoading: false }),
}));
vi.mock("@/hooks/useBehavioralProfile", () => ({
  useBehavioralProfile: () => ({ data: mocks.behavioralProfile }),
}));
vi.mock("@/hooks/usePlayerAnalysisV2", () => ({
  useSavedAnalysesV2: () => ({ data: mocks.savedAnalyses }),
}));
vi.mock("@/hooks/useInjuryRisk", () => ({
  useInjuryRisk: () => ({ riskData: null, injuries: [] }),
}));

import { useIDPArchitectInput } from "@/hooks/useIDPArchitectInput";

const PLAYER = { id: "demo-a", name: "Samu", age: 14, position: "MID", vsi: 60 };

describe("useIDPArchitectInput · perfil conductual sin scores", () => {
  beforeEach(() => {
    mocks.player = PLAYER;
    mocks.behavioralProfile = undefined;
    mocks.savedAnalyses = [];
  });

  it("NO crashea cuando el perfil llega truthy pero sin `scores`", () => {
    // La forma exacta que producía el error de producción.
    mocks.behavioralProfile = { playerId: "demo-a", confidence: 0.5 };

    const { result } = renderHook(() => useIDPArchitectInput("demo-a"));

    // No lanza, y trata el perfil como ausente (no usable).
    expect(result.current.architectInput).not.toBeNull();
    expect(result.current.architectInput?.behavioralProfile).toBeUndefined();
    expect(result.current.dataRichness.hasBehavioralProfile).toBe(false);
    // La dimensión mental cae al overall (60), no crashea leyendo mentalComposite.
    expect(result.current.architectInput?.vsi?.mental).toBe(60);
    expect(result.current.liveMetrics.mental_composite).toBeUndefined();
  });

  it("usa scores cuando el perfil está completo", () => {
    mocks.behavioralProfile = {
      playerId: "demo-a",
      scores: {
        decisionSpeed: 70,
        scanningIntelligence: 65,
        resilience: 60,
        leadership: 55,
        mentalComposite: 68,
        archetype: "architect",
      },
    };

    const { result } = renderHook(() => useIDPArchitectInput("demo-a"));

    expect(result.current.dataRichness.hasBehavioralProfile).toBe(true);
    expect(result.current.architectInput?.behavioralProfile?.mentalComposite).toBe(68);
    expect(result.current.architectInput?.vsi?.mental).toBe(68);
    expect(result.current.liveMetrics.mental_composite).toBe(68);
  });

  // P1 bloque 2: un perfil de EJEMPLO (source "mock", solo en el demo) no alimenta el IDP
  // ni sale como «perfil conductual ✓» en la riqueza de datos.
  it("un perfil de ejemplo (source mock) NO cuenta ni entra en el IDP", () => {
    mocks.behavioralProfile = {
      playerId: "demo-a",
      source: "mock",
      scores: { decisionSpeed: 68, scanningIntelligence: 72, resilience: 61, leadership: 45, mentalComposite: 63, archetype: "architect" },
    };
    const { result } = renderHook(() => useIDPArchitectInput("demo-a"));
    expect(result.current.dataRichness.hasBehavioralProfile).toBe(false);
    expect(result.current.architectInput?.behavioralProfile).toBeUndefined();
    expect(result.current.liveMetrics.mental_composite).toBeUndefined();
  });
});
