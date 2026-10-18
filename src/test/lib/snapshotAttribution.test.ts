/**
 * P1 bloque 7a-3 — un snapshot del Lab sin pista enfocada (o anterior al 6b, sin marca)
 * guarda velocidad, distancia, sprints y escaneos de TODAS las pistas: no se atribuyen
 * al jugador (identidad.md). Tampoco se mandan al informe.
 */
import { describe, expect, it } from "vitest";
import { attributableScanCount, snapshotAttributable } from "@/services/real/playerTrackingService";

const snap = (calcFocus: number | null | undefined, focus: number | null) =>
  ({ focusTrackId: focus, scanCount: 3, sessionMetrics: calcFocus === undefined ? {} : { focusTrackId: calcFocus } }) as never;

const LAB = import.meta.glob(["/src/pages/VitasLab.tsx", "/src/pages/PlayerHubPage.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("snapshotAttributable", () => {
  it("solo si las métricas se calcularon con la pista enfocada guardada", () => {
    expect(snapshotAttributable(snap(4, 4))).toBe(true);
    expect(snapshotAttributable(snap(null, null))).toBe(false);
    expect(snapshotAttributable(snap(undefined, 4))).toBe(false); // anterior al 6b
    expect(snapshotAttributable(snap(4, 7))).toBe(false); // otra pista
    expect(attributableScanCount(snap(4, 7))).toBeNull();
  });

  it("el Lab solo manda físicas y eventos al informe con la pista enfocada ACTUAL; sin ella no guarda eventos", () => {
    const lab = LAB["/src/pages/VitasLab.tsx"];
    expect(lab).toMatch(/if \(calibReliable && identityReliable && physicsForFocus\)/);
    expect(lab).toMatch(/eventSummary: \(focusSummary && identityReliable\)/);
    expect(lab).toMatch(/getPlayerEvents\(tracking\.state\.focusTrackId\)\s*:\s*\[\];/);
    expect(lab).toMatch(/&& tracking\.state\.sessionMetrics\?\.focusTrackId === tracking\.state\.focusTrackId/);
    // VAEP del Hub: los snapshots antiguos sin pista enfocada guardaron eventos de todas las pistas.
    expect(LAB["/src/pages/PlayerHubPage.tsx"]).toMatch(/snapshot\?\.tacticalEvents\?\.length && snapshot\.focusTrackId != null/);
  });
});
