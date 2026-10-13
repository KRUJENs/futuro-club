/**
 * Tests for useAgents hooks — usePHVCalculator, useRoleProfileAgent, useRAGDrillRecommendations
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/services/real/agentService", () => ({
  AgentService: {
    calculatePHV: vi.fn(async () => ({
      success: true,
      data: {
        playerId: "p1",
        category: "ontme",
        offset: 0.3,
        adjustedVSI: 72,
        confidence: 0.8,
        phvStatus: "during_phv",
        developmentWindow: "critical",
        recommendation: "Mantener entrenamiento equilibrado",
        agentName: "PHVCalculatorAgent",
        tokensUsed: 100,
      },
    })),
    buildRoleProfile: vi.fn(async () => ({
      success: true,
      data: {
        dominantIdentity: "ofensivo",
        identityDistribution: { ofensivo: 0.4, fisico: 0.3, tecnico: 0.3 },
        overallConfidence: 0.75,
        agentName: "RoleProfileAgent",
        tokensUsed: 200,
      },
    })),
  },
}));

vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getById: vi.fn(() => ({
      id: "p1",
      name: "Test Player",
      age: 14,
      foot: "right",
      position: "delantero",
      minutesPlayed: 300,
      competitiveLevel: "Regional",
      metrics: { speed: 75, technique: 80, vision: 65, stamina: 70, shooting: 85, defending: 40 },
      phvCategory: "ontme",
      phvOffset: 0.3,
    })),
    updatePHV: vi.fn(async () => {}),
  },
}));

vi.mock("@/services/real/ragService", () => ({
  ragService: {
    query: vi.fn(async () => ({
      results: [
        { id: "d1", content: "Drill para velocidad", similarity: 0.85, metadata: {} },
      ],
    })),
  },
}));

import { usePHVCalculator, useRAGDrillRecommendations, useRecalculatePHV } from "@/hooks/useAgents";

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe("useAgents", () => {
  describe("usePHVCalculator", () => {
    it("returns PHV data when input provided", async () => {
      const input = { playerId: "p1", chronologicalAge: 13, height: 160, weight: 50 };
      const { result } = renderHook(() => usePHVCalculator(input), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data!.category).toBe("ontme");
    });

    it("does not fetch when input is null", () => {
      const { result } = renderHook(() => usePHVCalculator(null), { wrapper: createWrapper() });
      expect(result.current.fetchStatus).toBe("idle");
    });
  });


  describe("useRAGDrillRecommendations", () => {
    it("returns drill recommendations for areas", async () => {
      const { result } = renderHook(() => useRAGDrillRecommendations(["velocidad", "técnica"]), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data!.length).toBeGreaterThan(0);
      expect(result.current.data![0].area).toBe("velocidad");
    });

    it("does not fetch when areas is undefined", () => {
      const { result } = renderHook(() => useRAGDrillRecommendations(undefined), {
        wrapper: createWrapper(),
      });
      expect(result.current.fetchStatus).toBe("idle");
    });

    it("does not fetch when areas is empty", () => {
      const { result } = renderHook(() => useRAGDrillRecommendations([]), {
        wrapper: createWrapper(),
      });
      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useRecalculatePHV", () => {
    it("returns a mutation function", () => {
      const { result } = renderHook(() => useRecalculatePHV(), { wrapper: createWrapper() });
      expect(result.current.mutateAsync).toBeDefined();
      expect(typeof result.current.mutateAsync).toBe("function");
    });
  });
});
