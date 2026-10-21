/**
 * P2 bloque 11 — la IA solo traduce a filtros del vocabulario cerrado; lo de fuera se
 * descarta como «no entendido», nunca se convierte en el valor más parecido.
 */
import { describe, expect, it } from "vitest";
import { nlFilterSystemPrompt, parseNlFilterJson } from "@/lib/search/nlRankingFilters";
import { RANKING_POSITIONS } from "@/lib/shared/rankingVocab";

describe("parseNlFilterJson", () => {
  it("control positivo: «lateral zurdo tardío, U14» ⇒ cuatro filtros válidos", () => {
    const r = parseNlFilterJson('{"position":"Lateral Izquierdo","foot":"left","timing":"late","ageGroup":"Sub-14","not_understood":[]}');
    expect(r).toEqual({ filters: { position: "Lateral Izquierdo", foot: "left", timing: "late", ageGroup: "Sub-14" }, not_understood: [] });
  });

  it("valores fuera del vocabulario ⇒ descartados y a «no entendido», nunca el más parecido", () => {
    const r = parseNlFilterJson('Aquí va: {"position":"Lateral","foot":"zurdo","timing":"pre_phv","ageGroup":"U14","not_understood":["rápido"]}');
    expect(r?.filters).toEqual({});
    expect(r?.not_understood).toEqual(["rápido", "Lateral", "zurdo", "pre_phv", "U14"]);
  });

  it("null en una clave ⇒ sin ese filtro; respuesta que no es JSON ⇒ null", () => {
    expect(parseNlFilterJson('{"position":null,"foot":"right","timing":null,"ageGroup":null}')?.filters).toEqual({ foot: "right" });
    expect(parseNlFilterJson("no sé")).toBeNull();
    expect(parseNlFilterJson("[1,2]")).toBeNull();
  });

  it("el prompt lista el vocabulario cerrado y dice que el timing no es la fase PHV", () => {
    const p = nlFilterSystemPrompt();
    for (const pos of RANKING_POSITIONS) expect(p).toContain(pos);
    expect(p).toMatch(/NO la fase PHV/);
  });
});
