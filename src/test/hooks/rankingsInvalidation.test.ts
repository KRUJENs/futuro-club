/**
 * Rankings se refresca tras guardar (P1 bloque 5a, revisión del PR #317).
 *
 * La consulta de Rankings usa la clave ["ranked-players", …] con staleTime de 5 min,
 * pero las invalidaciones tras crear/editar/borrar/sincronizar usaban ["rankings"], una
 * clave que ninguna consulta tiene: el entrenador evaluaba a un niño, volvía a Rankings
 * y durante hasta 5 min veía la evaluación y el percentil anteriores.
 */
import { describe, it, expect } from "vitest";
import useRankingsSrc from "@/hooks/useRankings.ts?raw";
import usePlayersSrc from "@/hooks/usePlayers.ts?raw";
import useSupabaseSyncSrc from "@/hooks/useSupabaseSync.ts?raw";
import playerFormSrc from "@/pages/PlayerForm.tsx?raw";

describe("invalidación de Rankings", () => {
  it("la consulta de Rankings usa la clave ranked-players", () => {
    expect(useRankingsSrc).toMatch(/queryKey:\s*\["ranked-players"/);
  });

  it.each([
    ["usePlayers", usePlayersSrc],
    ["useSupabaseSync", useSupabaseSyncSrc],
    ["PlayerForm", playerFormSrc],
  ])("%s invalida ranked-players y nunca la clave inexistente rankings", (_name, src) => {
    expect(src).not.toMatch(/queryKey:\s*\["rankings"\]/);
    expect(src).toMatch(/queryKey:\s*\["ranked-players"\]/);
  });
});
