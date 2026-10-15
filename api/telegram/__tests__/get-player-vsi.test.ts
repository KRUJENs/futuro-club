/**
 * Bot de Telegram · herramienta get_player — lo que recibe el LLM no incluye el
 * historial VSI legacy SIN fechas (players.vsi_history, con el 57.5 fabricado antes de
 * #146) ni la serie retirada de analyses.vsi (trend/history). Con ellos el LLM podía
 * contestar «Samu ha subido de 57.5 a 67.4»: una cifra escrita por el LLM sobre una
 * variación que la app bloquea (src/lib/scoring/vsiDelta.ts).
 */
import { describe, it, expect } from "vitest";
import { execTool } from "../webhook";

const PLAYER_ROW = {
  id: "p-samu", name: "Samu", age: 9, position: "MC", foot: "right",
  height_cm: 135, weight_kg: 30, vsi: 67.4, vsi_history: [57.5, 67.4],
  phv_category: null, phv_offset: null,
  // Barras del entrenador del blob (alias evaluacion_entrenador:data->metrics).
  evaluacion_entrenador: { speed: 70, technique: 68, vision: 66, stamina: 67, shooting: 65, defending: 66 },
};
const ANALYSIS_ROW = {
  id: "an-1", status: "completed", completed_at: "2026-08-20T10:00:00Z",
  vsi: {
    vsi: 67, tierLabel: "Talento",
    trend: { slope: 4.75, momentum: "up", confidence: "medium", delta: null, samples: 3 },
    history: [57.5, 67.4, 67],
  },
};

const playerSelects: string[] = [];

function fakeSupabase(playerRow: Record<string, unknown> = PLAYER_ROW, analysisRow: Record<string, unknown> = ANALYSIS_ROW) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: (cols: string) => { if (table === "players") playerSelects.push(cols); return b; },
        eq: chain, ilike: chain, in: chain, order: chain,
        limit: () => (table === "players" ? Promise.resolve({ data: [structuredClone(playerRow)] }) : b),
        maybeSingle: async () =>
          table === "analyses" ? { data: structuredClone(analysisRow) } : { data: null },
      });
      return b;
    },
  };
}

describe("telegram get_player — sin serie VSI legacy para el LLM", () => {
  it("el JSON de la herramienta no lleva vsi_history ni vsi.trend/history, y sí el VSI actual", async () => {
    const out = await execTool(
      fakeSupabase(),
      { userId: "user-coach-1", tenantId: "t-1", chatId: 1 },
      "get_player",
      { name_query: "samu" },
    );
    const parsed = JSON.parse(out) as {
      player: Record<string, unknown>;
      lastAnalysis: { vsi: Record<string, unknown> };
    };
    expect(parsed.player).not.toHaveProperty("vsi_history");
    expect(parsed.lastAnalysis.vsi).not.toHaveProperty("trend");
    expect(parsed.lastAnalysis.vsi).not.toHaveProperty("history");
    expect(out).not.toContain("57.5");
    expect(parsed.player.vsi).toBe(67.4);
    expect(parsed.lastAnalysis.vsi.vsi).toBe(67);
  });
});

// P1 bloque 5: las barras del entrenador salen del blob (las columnas metric_* valen 0
// para quien no está evaluado: trigger 069 + DEFAULT 0 de la 024) y el percentil viejo
// guardado en analyses.vsi.peer (pool de todas las cuentas, no evaluados como 0) no llega.
describe("telegram get_player — sin ceros de un jugador sin evaluar ni percentil viejo", () => {
  it("la consulta lee data->metrics, nunca las columnas metric_*", async () => {
    playerSelects.length = 0;
    await execTool(fakeSupabase(), { userId: "user-coach-1", tenantId: "t-1", chatId: 1 }, "get_player", { name_query: "samu" });
    expect(playerSelects[0]).toContain("evaluacion_entrenador:data->metrics");
    expect(playerSelects[0]).not.toMatch(/metric_(speed|technique|vision|stamina|shooting|defending)/);
  });

  it("jugador sin evaluar ⇒ evaluación null (no «velocidad 0») y sin percentil «P0» del análisis", async () => {
    const out = await execTool(
      fakeSupabase(
        { ...PLAYER_ROW, vsi: null, vsi_history: [], evaluacion_entrenador: null },
        { ...ANALYSIS_ROW, vsi: { vsi: 0, tierLabel: "En desarrollo", peer: { percentile: 0, peerCount: 3, stratum: "MC U9±1 todos" } } },
      ),
      { userId: "user-coach-1", tenantId: "t-1", chatId: 1 },
      "get_player",
      { name_query: "samu" },
    );
    const parsed = JSON.parse(out) as { player: Record<string, unknown>; lastAnalysis: { vsi: Record<string, unknown> } };
    expect(parsed.player.evaluacion_entrenador).toBeNull();
    expect(out).not.toMatch(/metric_speed/);
    expect(parsed.lastAnalysis.vsi).not.toHaveProperty("peer");
  });
});
