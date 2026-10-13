/**
 * Historial de informes · nada por defecto (P1 bloque 2, inv #2).
 * Antes cada informe salía «Clon: Jugador Referencia (60%)», nivel «Medio» y con textos
 * fijos («Determinado y competitivo», «Consolidar fundamentos técnicos»…), porque se leía
 * bm.nombre/bm.score en el nivel superior del sobre del narrador, donde no existen.
 */
import { describe, it, expect } from "vitest";
import { bestMatchFromContent, mapDbRowToLegacy, type AnalysisDbRow } from "@/hooks/usePlayerAnalysisV2";

const NARRATOR_ENVELOPE = {
  playerId: "p1",
  narrative: {
    title: "Parecido a…",
    primary_match: { player: "Pedri", club: "FC Barcelona", similarity_pct: 71.6, narrative: "Conduce entre líneas." },
    other_matches: [],
  },
};

describe("bestMatchFromContent", () => {
  it("lee el comparable del sobre del narrador (narrative.primary_match)", () => {
    expect(bestMatchFromContent(NARRATOR_ENVELOPE)).toEqual({
      proPlayerId: "", nombre: "Pedri", posicion: "", club: "FC Barcelona", score: 72, narrativa: "Conduce entre líneas.",
    });
  });

  it("también si el sobre viene envuelto en { data }", () => {
    expect(bestMatchFromContent({ data: NARRATOR_ENVELOPE })?.nombre).toBe("Pedri");
  });

  it("sin comparable ⇒ null (nunca «Jugador Referencia (60%)»)", () => {
    expect(bestMatchFromContent({})).toBeNull();
    expect(bestMatchFromContent({ narrative: { primary_match: { player: "X" } } })).toBeNull(); // sin %
    expect(bestMatchFromContent({ narrative: { primary_match: { similarity_pct: 50 } } })).toBeNull(); // sin nombre
  });

  it("forma heredada (nombre/score arriba) sigue valiendo", () => {
    expect(bestMatchFromContent({ nombre: "Gavi", score: 64, club: "FCB" })).toMatchObject({ nombre: "Gavi", score: 64, club: "FCB" });
  });
});

describe("mapDbRowToLegacy · sin textos ni nivel por defecto", () => {
  const row = (reports: AnalysisDbRow["reports"]): AnalysisDbRow => ({
    id: "a1", player_id: "p1", video_id: "v1", created_at: "2026-10-01T00:00:00Z", vsi: null, reports,
  });

  it("informe sin best-match, nivel ni textos ⇒ campos vacíos/null, no inventados", () => {
    const out = mapDbRowToLegacy(row([{ report_type: "player-report", content: {} }]));
    const r = out.report as Record<string, any>;
    expect(r.jugadorReferencia.bestMatch).toBeNull();
    expect(r.estadoActual.nivelActual).toBeNull();
    expect(r.estadoActual.resumenEjecutivo).toBe("");
    expect(r.adnFutbolistico.mentalidad).toBe("");
    expect(r.adnFutbolistico.estiloJuego).toBe("");
    expect(r.adnFutbolistico.arquetipoTactico).toBe("");
    expect(r.planDesarrollo.objetivo6meses).toBe("");
    expect(r.planDesarrollo.objetivo18meses).toBe("");
    expect(JSON.stringify(r)).not.toMatch(/Jugador Referencia|Determinado y competitivo|Análisis completado|Consolidar fundamentos/);
  });

  it("con best-match y nivel reales los usa", () => {
    const out = mapDbRowToLegacy(row([
      { report_type: "player-report", content: { tier_label: "alto", executive_summary: "Resumen real" } },
      { report_type: "best-match", content: NARRATOR_ENVELOPE },
    ]));
    const r = out.report as Record<string, any>;
    expect(r.jugadorReferencia.bestMatch).toMatchObject({ nombre: "Pedri", score: 72 });
    expect(r.estadoActual.nivelActual).toBe("alto");
    expect(r.estadoActual.resumenEjecutivo).toBe("Resumen real");
  });
});
