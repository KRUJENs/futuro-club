/**
 * roleProfileService — Tests
 * Verifica que el Role Profile se alimenta de análisis de video, no de métricas manuales.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockStorage: Record<string, unknown> = {};
vi.mock("@/services/real/storageService", () => ({
  StorageService: {
    get: vi.fn((key: string, fallback: unknown) => mockStorage[key] ?? fallback),
    set: vi.fn((key: string, val: unknown) => { mockStorage[key] = val; }),
  },
}));

const mockSupabaseFrom = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
  SUPABASE_CONFIGURED: true,
}));

// Mock PlayerService
const mockPlayer = {
  id: "p1",
  name: "Samu",
  age: 15,
  foot: "right" as const,
  position: "Mediocentro",
  height: 172,
  weight: 62,
  competitiveLevel: "Nacional",
  minutesPlayed: 900,
  metrics: { speed: 70, technique: 80, vision: 75, stamina: 65, shooting: 60, defending: 55 },
  phvCategory: "on-time",
  phvOffset: 0,
};

// Alta rápida (P1 bloque 2): sin pie ni nivel registrados — no se rellenan por defecto.
const mockPlayerSinPieNiNivel = { ...mockPlayer, id: "p2", foot: undefined, competitiveLevel: undefined };

vi.mock("@/services/real/playerService", () => ({
  PlayerService: {
    getById: vi.fn((id: string) => id === "p1" ? mockPlayer : id === "p2" ? mockPlayerSinPieNiNivel : null),
  },
}));

// Mock AgentService
const mockBuildRoleProfile = vi.fn();
vi.mock("@/services/real/agentService", () => ({
  AgentService: {
    buildRoleProfile: (...args: unknown[]) => mockBuildRoleProfile(...args),
  },
}));

import { fetchRoleProfile, fetchPositionFit, fetchArchetypes, fetchAuditIndicators, recalculateWithPosition } from "@/services/roleProfileService";
import type { RoleProfileData } from "@/lib/roleProfileData";

// Helper: mock video analysis report from Supabase
const makeVideoAnalysis = (overrides = {}) => ({
  report: {
    estadoActual: {
      resumenEjecutivo: "Jugador técnico con buena visión",
      nivelActual: "medio_alto",
      fortalezasPrimarias: ["Pase entre líneas", "Control orientado"],
      areasDesarrollo: ["Velocidad de sprint", "Juego aéreo"],
      dimensiones: {
        velocidadDecision: { score: 7.5, observacion: "Decide rápido bajo presión" },
        tecnicaConBalon: { score: 8.0, observacion: "Buen primer toque orientado" },
        inteligenciaTactica: { score: 7.8, observacion: "Lee bien los espacios" },
        capacidadFisica: { score: 6.0, observacion: "Falta resistencia en 2do tiempo" },
        liderazgoPresencia: { score: 6.5, observacion: "Comunicación intermedia" },
        eficaciaCompetitiva: { score: 7.0, observacion: "Contribuye al juego colectivo" },
      },
      // Fixture con dimensiones REALES (scores medidos) → el fallback deriva de ellas.
      // Sin este flag, el servicio se abstiene (no fabrica perfil de dims constantes).
      dimensionesMedidas: true,
    },
    adnFutbolistico: {
      estiloJuego: "Organizador de juego posicional",
      arquetipoTactico: "Filtrador",
    },
    planDesarrollo: {
      objetivo6meses: "Mejorar resistencia",
    },
    jugadorReferencia: {},
    proyeccionCarrera: {},
  },
  created_at: "2026-04-01T00:00:00Z",
  video_id: "v1",
  ...overrides,
});

// Helper: setup Supabase mock
function setupSupabaseMock(analyses: unknown[]) {
  mockSupabaseFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: analyses, error: null }),
        }),
      }),
    }),
  });
}

describe("roleProfileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    // El perfil ahora se cachea en localStorage (perf: evita re-llamar al LLM).
    // Limpiarlo entre tests para que cada uno ejercite su rama (agente/fallback).
    localStorage.clear();
  });

  describe("fetchRoleProfile", () => {
    it("returns null when player does not exist", async () => {
      const result = await fetchRoleProfile("nonexistent");
      expect(result).toBeNull();
    });

    it("returns null when no video analyses exist (empty state, no metrics-only fallback)", async () => {
      // El perfil de rol EXIGE vídeo (commit "role profile requires video"); el
      // fallback metrics-only quedó deprecado. Sin vídeo → null → la UI muestra
      // empty state en vez de fabricar un perfil de baja confianza.
      setupSupabaseMock([]);
      const result = await fetchRoleProfile("p1");
      expect(result).toBeNull();
    });

    it("calls agent with video analysis data when analyses exist", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockResolvedValue({
        success: true,
        data: {
          overallConfidence: 0.82,
          capabilities: {
            tactical: { current: 78, p6m: 80, p18m: 83 },
            technical: { current: 80, p6m: 82, p18m: 85 },
            physical: { current: 60, p6m: 63, p18m: 67 },
          },
          dominantIdentity: "tecnico",
          identityDistribution: { tecnico: 0.4, ofensivo: 0.25, defensivo: 0.2, fisico: 0.1, mixto: 0.05 },
          topPositions: [
            { code: "RCM", fit: 85, confidence: 0.8 },
            { code: "DM", fit: 78, confidence: 0.75 },
          ],
          topArchetypes: [
            { code: "filtrador", fit: 88, stability: "estable" },
            { code: "organizador", fit: 82, stability: "en_desarrollo" },
          ],
          strengths: ["Pase entre líneas", "Lectura táctica"],
          risks: ["Resistencia física limitada"],
          gaps: ["Mayor volumen de carry"],
        },
      });

      const result = await fetchRoleProfile("p1");

      expect(result).not.toBeNull();
      expect(result!.player_name).toBe("Samu");
      expect(result!.player_age).toBe(15);
      expect(result!.player_id).toBe("p1");
      expect(result!.overall_confidence).toBe(0.82);
      expect(result!.positions.length).toBeGreaterThan(0);
      expect(result!.archetypes.length).toBeGreaterThan(0);

      // Verify agent was called with video analysis summary
      expect(mockBuildRoleProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          player: expect.objectContaining({
            videoAnalysisSummary: expect.objectContaining({
              totalAnalyses: 1,
              strengths: ["Pase entre líneas", "Control orientado"],
              nivelActual: "medio_alto",
            }),
          }),
        })
      );
      // P1 bloque 2: solo las 6 métricas del entrenador; sin los sustitutos falsos
      // pressing = stamina y positioning = vision.
      const sentMetrics = (mockBuildRoleProfile.mock.calls[0][0] as { player: { metrics: Record<string, unknown> } }).player.metrics;
      expect(sentMetrics).toEqual(mockPlayer.metrics);
      expect(sentMetrics).not.toHaveProperty("pressing");
      expect(sentMetrics).not.toHaveProperty("positioning");
    });

    it("cachea el perfil del agente: con la MISMA entrada no re-llama al LLM (perf, docx #6)", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockResolvedValue({
        success: true,
        data: {
          overallConfidence: 0.82,
          capabilities: {
            tactical: { current: 78, p6m: 80, p18m: 83 },
            technical: { current: 80, p6m: 82, p18m: 85 },
            physical: { current: 60, p6m: 63, p18m: 67 },
          },
          dominantIdentity: "tecnico",
          identityDistribution: { tecnico: 0.4, ofensivo: 0.25, defensivo: 0.2, fisico: 0.1, mixto: 0.05 },
          topPositions: [{ code: "RCM", fit: 85, confidence: 0.8 }],
          topArchetypes: [{ code: "filtrador", fit: 88, stability: "estable" }],
          strengths: ["Pase entre líneas"],
          risks: ["Resistencia limitada"],
          gaps: ["Volumen de carry"],
        },
      });

      const first = await fetchRoleProfile("p1");
      const second = await fetchRoleProfile("p1");

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // El agente (LLM, caro) se llamó UNA sola vez; la 2ª lectura vino de la caché.
      expect(mockBuildRoleProfile).toHaveBeenCalledTimes(1);
      expect(second!.player_id).toBe("p1");
      expect(second!.overall_confidence).toBe(0.82);
    });

    it("jugador SIN pie ni nivel: el perfil del agente se devuelve y se cachea (antes el schema lo rechazaba)", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockResolvedValue({
        success: true,
        data: {
          overallConfidence: 0.8,
          capabilities: {
            tactical: { current: 78, p6m: 80, p18m: 83 },
            technical: { current: 80, p6m: 82, p18m: 85 },
            physical: { current: 60, p6m: 63, p18m: 67 },
          },
          dominantIdentity: "tecnico",
          identityDistribution: { tecnico: 0.4, ofensivo: 0.25, defensivo: 0.2, fisico: 0.1, mixto: 0.05 },
          topPositions: [{ code: "RCM", fit: 85, confidence: 0.8 }],
          topArchetypes: [{ code: "filtrador", fit: 88, stability: "estable" }],
          strengths: ["Pase entre líneas"],
          risks: ["Resistencia limitada"],
          gaps: ["Volumen de carry"],
        },
      });

      const first = await fetchRoleProfile("p2");
      const second = await fetchRoleProfile("p2");

      expect(first).not.toBeNull();
      expect(first!.dominant_foot).toBeUndefined();     // no se asume diestro
      expect(first!.competitive_level).toBeUndefined(); // no se asume «Regional»
      expect(second).not.toBeNull();
      // Llegó a la caché: el LLM (caro) no se vuelve a llamar en la 2.ª visita.
      expect(mockBuildRoleProfile).toHaveBeenCalledTimes(1);
      const sent = (mockBuildRoleProfile.mock.calls[0][0] as { player: Record<string, unknown> }).player;
      expect(sent.foot).toBeUndefined();
      expect(sent.competitiveLevel).toBeUndefined();
    });

    it("jugador SIN pie ni nivel: el perfil desde vídeo (agente caído) también se devuelve", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("Agent timeout"));

      const result = await fetchRoleProfile("p2");
      expect(result).not.toBeNull();
      expect(result!.dominant_foot).toBeUndefined();
      expect(result!.competitive_level).toBeUndefined();
    });

    it("builds basic profile from video data when agent fails", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("Agent timeout"));

      const result = await fetchRoleProfile("p1");

      // Should still return a profile from video dimensions
      expect(result).not.toBeNull();
      expect(result!.player_name).toBe("Samu");
      expect(result!.current.technical).toBe(80); // tecnicaConBalon score 8.0 × 10
      expect(result!.current.tactical).toBe(78);  // inteligenciaTactica score 7.8 × 10
      expect(result!.current.physical).toBe(60);  // capacidadFisica score 6.0 × 10
      expect(result!.risks.some(r => r.code === "AGENT_UNAVAILABLE")).toBe(true);
      expect(result!.strengths.length).toBeGreaterThan(0);
    });

    it("se ABSTIENE (null) si el agente falla y las dimensiones NO son reales (dimensionesMedidas!==true)", async () => {
      const fabricado = makeVideoAnalysis();
      // Caso REAL de hoy: dimensiones = constante fabricada (el pipeline no mide por
      // dimensión). El fallback NO debe fabricar un perfil de rol con esos scores.
      (fabricado.report.estadoActual as Record<string, unknown>).dimensionesMedidas = false;
      setupSupabaseMock([fabricado]);
      mockBuildRoleProfile.mockRejectedValue(new Error("Agent timeout"));

      const result = await fetchRoleProfile("p1");
      expect(result).toBeNull(); // abstención, no fabricación (inv #2/#3)
    });

    it("sample_tier based on number of video analyses", async () => {
      // 1 video = bronze
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("fail"));
      let result = await fetchRoleProfile("p1");
      expect(result!.sample_tier).toBe("bronze");

      // 3 videos = gold
      setupSupabaseMock([makeVideoAnalysis(), makeVideoAnalysis(), makeVideoAnalysis()]);
      result = await fetchRoleProfile("p1");
      expect(result!.sample_tier).toBe("gold");
    });

    it("evidence comes from video dimensions, not manual metrics", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("fail"));

      const result = await fetchRoleProfile("p1");
      expect(result).not.toBeNull();

      // Evidence should have video dimension keys
      const indicators = result!.evidence.map(e => e.indicator);
      expect(indicators).toContain("tecnicaConBalon");
      expect(indicators).toContain("inteligenciaTactica");

      // Should NOT have manual metric keys
      expect(indicators).not.toContain("speed");
      expect(indicators).not.toContain("shooting");
    });

    it("projections increase over time", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("fail"));

      const result = await fetchRoleProfile("p1");
      expect(result!.projections["0_6m"].tactical).toBeGreaterThan(result!.current.tactical);
      expect(result!.projections["6_18m"].tactical).toBeGreaterThan(result!.projections["0_6m"].tactical);
      expect(result!.projections["18_36m"].tactical).toBeGreaterThan(result!.projections["6_18m"].tactical);
    });
  });

  describe("fetchPositionFit", () => {
    it("returns no positions when no video analyses (role profile requires video)", async () => {
      setupSupabaseMock([]);
      const result = await fetchPositionFit("p1");
      // Sin vídeo el perfil es null → sin estimación de posición (empty state).
      expect(result).toEqual([]);
    });

    it("returns positions from profile when available", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("fail"));

      const result = await fetchPositionFit("p1");
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("code");
      expect(result[0]).toHaveProperty("score");
    });
  });

  describe("fetchArchetypes", () => {
    it("returns empty archetypes for metrics-only profile", async () => {
      setupSupabaseMock([]);
      const result = await fetchArchetypes("p1");
      // Metrics-only profile has no archetypes (needs AI for that)
      expect(result).toEqual([]);
    });
  });

  describe("fetchAuditIndicators", () => {
    it("returns evidence from video when available", async () => {
      setupSupabaseMock([makeVideoAnalysis()]);
      mockBuildRoleProfile.mockRejectedValue(new Error("fail"));

      const result = await fetchAuditIndicators("p1");
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("indicator");
      expect(result[0]).toHaveProperty("explanation");
    });

    it("returns empty when no data", async () => {
      setupSupabaseMock([]);
      const result = await fetchAuditIndicators("p1");
      expect(result).toEqual([]);
    });
  });

  describe("recalculateWithPosition", () => {
    // Helper: build a minimal valid RoleProfileData for testing recalculate
    function makeBaseProfile(overrides: Partial<RoleProfileData> = {}): RoleProfileData {
      return {
        run_id: "run_test",
        player_id: "p1",
        player_name: "Samu",
        player_age: 15,
        dominant_foot: "derecho",
        minutes_played: 900,
        competitive_level: "Nacional",
        sample_tier: "bronze",
        overall_confidence: 0.35,
        current: { tactical: 75, technical: 80, physical: 65 },
        projections: {
          "0_6m": { tactical: 76, technical: 81, physical: 67 },
          "6_18m": { tactical: 78, technical: 83, physical: 70 },
          "18_36m": { tactical: 80, technical: 85, physical: 73 },
        },
        identity: {
          dominant: "tecnico",
          distribution: { tecnico: 0.5, ofensivo: 0.2, defensivo: 0.15, fisico: 0.15, mixto: 0 },
          explanation: "Perfil test",
        },
        positions: [
          { code: "RCM", prob: 0.5, score: 75, confidence: 0.35, reason: "Auto" },
          { code: "DM", prob: 0.3, score: 65, confidence: 0.3, reason: "Alt" },
        ],
        archetypes: [],
        strengths: [],
        risks: [],
        gaps: [],
        consolidation_notes: ["Nota original"],
        evidence: [],
        ...overrides,
      } as RoleProfileData;
    }

    it("moves forced position to first place", () => {
      const base = makeBaseProfile();
      const result = recalculateWithPosition(base, "ST");

      expect(result.positions[0].code).toBe("ST");
      expect(result.positions[0].reason).toContain("manualmente");
    });

    it("does not mutate the original profile", () => {
      const base = makeBaseProfile();
      const originalRunId = base.run_id;
      const result = recalculateWithPosition(base, "GK");

      expect(base.run_id).toBe(originalRunId);
      expect(result.run_id).not.toBe(originalRunId);
      expect(result.run_id).toContain("_pos_GK");
    });

    it("recalculates identity distribution based on position weights", () => {
      const base = makeBaseProfile();
      const result = recalculateWithPosition(base, "DM");

      // DM has high tactical weight → defensivo should be boosted
      const dist = result.identity.distribution;
      const totalDist = Object.values(dist).reduce((a, b) => a + b, 0);
      expect(totalDist).toBeCloseTo(1, 1); // sums to ~1
    });

    it("preserves existing positions (excluding forced one)", () => {
      const base = makeBaseProfile();
      const result = recalculateWithPosition(base, "ST");

      // ST is forced first, RCM and DM should still be there
      const codes = result.positions.map(p => p.code);
      expect(codes).toContain("ST");
      expect(codes).toContain("RCM");
      expect(codes).toContain("DM");
    });

    it("removes duplicate when forcing existing position", () => {
      const base = makeBaseProfile();
      const result = recalculateWithPosition(base, "RCM");

      // RCM should appear exactly once (forced version)
      const rcmPositions = result.positions.filter(p => p.code === "RCM");
      expect(rcmPositions).toHaveLength(1);
      expect(rcmPositions[0].reason).toContain("manualmente");
    });

    it("adds consolidation note about position override", () => {
      const base = makeBaseProfile();
      const result = recalculateWithPosition(base, "LW");

      expect(result.consolidation_notes.some(n => n.includes("LW"))).toBe(true);
      expect(result.consolidation_notes.some(n => n.includes("Nota original"))).toBe(true);
    });

    it("boosts confidence to at least 0.5 for forced position", () => {
      const base = makeBaseProfile({ overall_confidence: 0.3 });
      const result = recalculateWithPosition(base, "ST");

      expect(result.positions[0].confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("handles all position codes without error", () => {
      const base = makeBaseProfile();
      const codes = ["GK", "RB", "RCB", "LCB", "LB", "DM", "RCM", "LCM", "CAM", "RW", "LW", "ST"];

      for (const code of codes) {
        const result = recalculateWithPosition(base, code);
        expect(result.positions[0].code).toBe(code);
        expect(result.positions[0].score).toBeGreaterThan(0);
        expect(result.positions[0].score).toBeLessThanOrEqual(100);
      }
    });

    it("GK emphasizes physical, DM emphasizes tactical", () => {
      const base = makeBaseProfile({
        current: { tactical: 90, technical: 50, physical: 50 },
      });

      const gk = recalculateWithPosition(base, "GK");
      const dm = recalculateWithPosition(base, "DM");

      // DM with high tactical weight should score higher than GK for a tactical player
      expect(dm.positions[0].score).toBeGreaterThan(gk.positions[0].score);
    });
  });

  // El perfil metrics-only (fortalezas/gaps/posición/identidad derivadas solo de
  // métricas manuales, sin vídeo) quedó DEPRECADO: fetchRoleProfile devuelve null
  // sin análisis de vídeo. Ver commit "role profile requires video".
  describe("metrics-only profile (deprecated)", () => {
    it("no fabrica perfil sin vídeo — devuelve null (empty state)", async () => {
      setupSupabaseMock([]);
      const result = await fetchRoleProfile("p1");
      expect(result).toBeNull();
    });
  });
});
