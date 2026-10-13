/**
 * Tarjeta VITAS · comparable (P1 bloque 2).
 * Desde la ficha (PlayerIntelligencePage) llega el comparable del INFORME guardado
 * ({ nombre, club, posicion, score }), no un SimilarityMatch. La tarjeta leía siempre
 * `bestMatch.player.short_name` ⇒ TypeError al abrirla cuando el informe tenía comparable.
 */
import { describe, it, expect } from "vitest";
import { cloneFromMatch } from "@/components/VitasCard";
import type { SimilarityMatch } from "@/services/real/similarityService";

describe("cloneFromMatch", () => {
  it("comparable del informe guardado (nombre/club/posicion) — antes TypeError", () => {
    expect(cloneFromMatch({ nombre: "Pedri", club: "FC Barcelona", posicion: "", score: 72 })).toEqual({
      name: "Pedri", club: "FC Barcelona", position: null, score: 72,
    });
  });

  it("comparable de similitud en vivo (player.*)", () => {
    const m = { score: 80, player: { short_name: "Gavi", club: "FCB", position: "CM" } } as unknown as SimilarityMatch;
    expect(cloneFromMatch(m)).toEqual({ name: "Gavi", club: "FCB", position: "CM", score: 80 });
  });

  it("sin comparable, sin nombre o sin % ⇒ null (no se pinta nada)", () => {
    expect(cloneFromMatch(null)).toBeNull();
    expect(cloneFromMatch(undefined)).toBeNull();
    expect(cloneFromMatch({ nombre: "", club: "X", posicion: "", score: 50 })).toBeNull();
    expect(cloneFromMatch({ nombre: "X", club: "", posicion: "", score: Number.NaN })).toBeNull();
  });
});
