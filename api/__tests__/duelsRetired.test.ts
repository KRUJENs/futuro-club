/**
 * P1 bloque 6, punto 3 — Duelos fuera del servidor: el modelo de vídeo ya no los cuenta,
 * los prompts no los piden ni los citan, el plan de desarrollo no los usa como déficit y
 * todo dato antiguo con duelos se sanea al escribir y al leer (src/lib/tracking/duels.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectObservedWeaknesses } from "../agents/_development-plan";

const read = (p: string) => readFileSync(resolve(__dirname, "..", "..", p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("plan de desarrollo: sin déficit de «duelos»", () => {
  it("Gemini con duelos perdidos 1/10: no aparece «duelos» (sí la precisión de pase, control)", () => {
    const w = detectObservedWeaknesses({
      gemini: { eventosContados: { pasesCompletados: 2, pasesFallados: 8, duelosGanados: 1, duelosPerdidos: 9 } },
    });
    expect(w).toContain("precisión de pase (observada en vídeo)");
    expect(w.join(" ")).not.toMatch(/duelo/i);
  });

  it("cliente con duelsWon 1 / duelsLost 9: no aparece «duelos»", () => {
    const w = detectObservedWeaknesses({ eventSummary: { passCompletionPct: 40, duelsWon: 1, duelsLost: 9 } });
    expect(w).toContain("precisión de pase (observada en vídeo)");
    expect(w.join(" ")).not.toMatch(/duelo/i);
  });
});

describe("prompts sin duelos", () => {
  it("video-observation: ni los pide, ni trae el ejemplo «3/1», y sanea la respuesta", () => {
    const src = read("api/agents/video-observation.ts");
    expect(src).not.toMatch(/Duelos ganados y perdidos/);
    expect(src).not.toMatch(/"duelosGanados":\s*3/);
    expect(code("api/agents/video-observation.ts")).toMatch(/stripDuelOutcomes\(JSON\.parse/);
  });

  it("player-report / dna-profile: sin el ejemplo «ganó 7 de 10 duelos», con la regla explícita y versión nueva", () => {
    const pr = code("api/agents/_player-report.ts");
    expect(pr).not.toMatch(/ganó 7 de 10 duelos/);
    // Las LISTAS de datos que se dan al modelo ya no incluyen duelos (la regla que los prohíbe sí los nombra).
    expect(pr).not.toMatch(/regates con\/sin ventaja, duelos|duelsWon\/Lost|resistencia, duelos/);
    expect(pr).toMatch(/NUNCA cites duelos/);
    expect(pr).toMatch(/player-report-v2\.4\.0/);
    const dna = read("api/agents/_dna-profile.ts");
    expect(dna).not.toMatch(/alto % duelos|duelos ganados\/perdidos/);
    expect(dna).toMatch(/dna-profile-v1\.3\.0/);
    expect(read("api/agents/_development-plan.ts")).toMatch(/dev-plan-v1\.3\.0/);
  });

  it("Telegram: /stats y la herramienta ya no ofrecen duelos", () => {
    const tg = code("api/telegram/webhook.ts");
    expect(tg).not.toMatch(/duelos:\s+m\.duelos|💥 Duelos|pase\/duelos\/recup|duelos \(ganados\/perdidos\)/);
  });

  it("el adaptador de Gemini ya no mapea duels_won/duels_lost", () => {
    expect(code("api/_lib/geminiBiomechanics.ts")).not.toMatch(/duels_won|duels_lost/);
  });
});

describe("saneado de datos antiguos al escribir y al leer", () => {
  it.each([
    ["api/analyses/generate-reports.ts", /stripDuelOutcomes\(body/],
    ["api/tracking/_save.ts", /stripDuelOutcomes\(body\.metrics/],
    ["api/agents/_pipeline-orchestrator.ts", /stripDuelOutcomes\(analysis\.biomechanics\)/],
    ["api/live/aggregate.ts", /stripDuelOutcomes\(obs\.eventosContados/],
    ["api/team/baseline-analysis.ts", /stripDuelOutcomes\(video\.eventosContados/],
    ["api/team/compare-rival.ts", /stripDuelOutcomes\(video\.eventosContados/],
  ])("%s pasa por el saneador único", (path, re) => {
    expect(code(path)).toMatch(re);
  });

  it("tracking/_history ya no devuelve duelCount", () => {
    expect(code("api/tracking/_history.ts")).not.toMatch(/duelCount|duel_events/);
  });
});
