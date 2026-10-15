/**
 * Tests for simple query/mutation hooks:
 * useAudit, useDashboard, useRankings, useRoleProfile, useMatchEvents, useTeam, use-mobile
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Global mocks ─────────────────────────────────────────────────────────────

vi.mock("@/context/AuthContext", () => ({
  useAuth: vi.fn(() => ({ user: { id: "u1" }, session: null, loading: false, configured: true })),
}));

vi.mock("@/services/real/auditService", () => ({
  AuditService: {
    runSync: vi.fn(() => ({
      overall: "ok",
      summary: { total: 5, ok: 5, warnings: 0, errors: 0 },
      sections: [],
      timestamp: new Date().toISOString(),
    })),
    runFull: vi.fn(async () => ({
      overall: "ok",
      summary: { total: 5, ok: 5, warnings: 0, errors: 0 },
      sections: [],
      timestamp: new Date().toISOString(),
    })),
  },
}));

vi.mock("@/services/dashboardService", () => ({
  fetchDashboardStats: vi.fn(async () => ({
    activePlayers: 10,
    drillsCompleted: 50,
    avgVsi: 72.5,
    hiddenTalents: 2,
  })),
  fetchTrendingPlayers: vi.fn(async () => [
    { id: "p1", name: "Player 1", vsi: 80, trending: "up" },
  ]),
  fetchLiveMatches: vi.fn(async () => []),
}));

vi.mock("@/services/rankingsService", () => ({
  fetchRankedPlayers: vi.fn(async () => ({
    players: [{ id: "p1", name: "Player 1", vsi: 80 }],
    total: 1,
  })),
}));

vi.mock("@/services/roleProfileService", () => ({
  fetchRoleProfile: vi.fn(async () => ({
    run_id: "run_test",
    player_id: "p1",
    player_name: "Test",
    player_age: 15,
    dominant_foot: "derecho",
    minutes_played: 900,
    competitive_level: "Nacional",
    sample_tier: "bronze",
    overall_confidence: 0.35,
    current: { tactical: 75, technical: 80, physical: 65 },
    identity: {
      dominant: "tecnico",
      distribution: { tecnico: 0.5, fisico: 0.3, ofensivo: 0.2, defensivo: 0, mixto: 0 },
      explanation: "Perfil test",
    },
    positions: [{ code: "RCM", prob: 0.5, score: 75, confidence: 0.35, reason: "Test" }],
    archetypes: [],
    strengths: [],
    risks: [],
    gaps: [],
    consolidation_notes: [],
    evidence: [],
  })),
  recalculateWithPosition: vi.fn((profile: unknown) => profile),
  fetchPositionFit: vi.fn(async () => []),
  fetchArchetypes: vi.fn(async () => []),
  fetchAuditIndicators: vi.fn(async () => []),
}));

vi.mock("@/services/real/matchEventsService", () => ({
  MatchEventsService: {
    getByPlayerId: vi.fn(() => [
      { id: "e1", playerId: "p1", type: "gol", timestamp: "2025-06-01T00:00:00Z" },
    ]),
    create: vi.fn(async () => ({ id: "e2" })),
    delete: vi.fn(async () => {}),
  },
}));

vi.mock("@/services/real/teamService", () => ({
  TeamService: {
    getMembers: vi.fn(async () => [
      { id: "m1", email: "test@test.com", role: "scout" },
    ]),
    getInvitations: vi.fn(async () => []),
    invite: vi.fn(async () => ({ id: "inv1" })),
    removeMember: vi.fn(async () => {}),
    cancelInvitation: vi.fn(async () => {}),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { useAuditSync, useSystemStatus } from "@/hooks/useAudit";
import { useDashboardStats, useTrendingPlayers, useLiveMatches } from "@/hooks/useDashboard";
import { useRankedPlayers } from "@/hooks/useRankings";
import { useRoleProfile, usePositionFit, useArchetypes, useAuditIndicators } from "@/hooks/useRoleProfile";
import { useMatchEvents } from "@/hooks/useMatchEvents";
import { useTeamMembers, useTeamInvitations } from "@/hooks/useTeam";
import { useIsMobile } from "@/hooks/use-mobile";

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

// ── useAudit ─────────────────────────────────────────────────────────────────

describe("useAudit", () => {
  it("useAuditSync returns audit report", async () => {
    const { result } = renderHook(() => useAuditSync(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.overall).toBe("ok");
  });

  it("useSystemStatus returns status and summary", async () => {
    const { result } = renderHook(() => useSystemStatus(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe("ok");
    expect(result.current.summary.total).toBe(5);
  });
});

// ── useDashboard ─────────────────────────────────────────────────────────────

describe("useDashboard", () => {
  it("useDashboardStats returns stats", async () => {
    const { result } = renderHook(() => useDashboardStats(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.activePlayers).toBe(10);
  });

  it("useTrendingPlayers returns player list", async () => {
    const { result } = renderHook(() => useTrendingPlayers(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBeGreaterThan(0);
  });

  it("useLiveMatches returns array", async () => {
    const { result } = renderHook(() => useLiveMatches(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data)).toBe(true);
  });
});

// ── useRankings ──────────────────────────────────────────────────────────────

describe("useRankings", () => {
  it("returns ranked players data", async () => {
    const { result } = renderHook(() => useRankedPlayers("vsi", "desc", {}, 50, 0), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.players.length).toBe(1);
  });
});

// ── useRoleProfile ───────────────────────────────────────────────────────────

describe("useRoleProfile", () => {
  it("returns role profile when playerId provided", async () => {
    const { result } = renderHook(() => useRoleProfile("p1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.identity.dominant).toBe("tecnico");
  });

  it("does not fetch when playerId is undefined", () => {
    const { result } = renderHook(() => useRoleProfile(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("usePositionFit returns data", async () => {
    const { result } = renderHook(() => usePositionFit("p1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
  });

  it("useArchetypes returns data", async () => {
    const { result } = renderHook(() => useArchetypes("p1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
  });

  it("useAuditIndicators returns data", async () => {
    const { result } = renderHook(() => useAuditIndicators("p1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
  });
});

// ── useMatchEvents ───────────────────────────────────────────────────────────

describe("useMatchEvents", () => {
  it("returns events for a player", async () => {
    const { result } = renderHook(() => useMatchEvents("p1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBe(1);
  });

  it("does not fetch when playerId is undefined", () => {
    const { result } = renderHook(() => useMatchEvents(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

// ── useTeam ──────────────────────────────────────────────────────────────────

describe("useTeam", () => {
  it("useTeamMembers returns members", async () => {
    const { result } = renderHook(() => useTeamMembers("org1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBe(1);
  });

  it("useTeamInvitations returns invitations", async () => {
    const { result } = renderHook(() => useTeamInvitations("org1"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual([]);
  });

  it("does not fetch when orgOwnerId is undefined", () => {
    const { result } = renderHook(() => useTeamMembers(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

// ── useIsMobile ──────────────────────────────────────────────────────────────

describe("useIsMobile", () => {
  it("returns a boolean", () => {
    const { result } = renderHook(() => useIsMobile());
    expect(typeof result.current).toBe("boolean");
  });
});
