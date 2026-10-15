/**
 * P1 bloque 5 — las barras de la evaluación del entrenador se leen del BLOB
 * (`data->metrics`), nunca de las columnas `players.metric_*`.
 *
 * Esas columnas valen 0 para un jugador NO evaluado: el trigger de players las rellena
 * con `COALESCE(…, 0)` (069:182-187) y la columna tiene DEFAULT 0 (024). Leerlas metía
 * «velocidad 0» en percentiles, medias de equipo y prompts. Corregir las columnas es del
 * bloque 7 (migración); hasta entonces ningún lector puede usarlas.
 */
import { describe, it, expect } from "vitest";
import peerSrc from "../../../api/benchmark/peer.ts?raw";
import baselineSrc from "../../../api/players/baseline-analysis.ts?raw";
import teamBaselineSrc from "../../../api/team/baseline-analysis.ts?raw";
import telegramSrc from "../../../api/telegram/webhook.ts?raw";

/** Quita comentarios para no confundir la explicación con una lectura real. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const READERS: Array<[string, string]> = [
  ["api/benchmark/peer.ts", peerSrc],
  ["api/players/baseline-analysis.ts", baselineSrc],
  ["api/team/baseline-analysis.ts", teamBaselineSrc],
  ["api/telegram/webhook.ts", telegramSrc],
];

describe("lectores de la evaluación del entrenador: blob, no columnas metric_*", () => {
  it.each(READERS)("%s no lee players.metric_*", (_name, src) => {
    expect(code(src)).not.toMatch(/metric_(speed|technique|vision|stamina|shooting|defending)/);
  });

  it.each(READERS)("%s lee data->metrics", (_name, src) => {
    expect(code(src)).toMatch(/:data->metrics/);
  });
});
