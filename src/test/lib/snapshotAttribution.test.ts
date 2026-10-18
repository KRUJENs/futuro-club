/**
 * P1 bloque 7a-3 — un snapshot del Lab sin pista enfocada (o anterior al 6b, sin marca)
 * guarda velocidad, distancia, sprints y escaneos de TODAS las pistas: no se atribuyen
 * al jugador (identidad.md). Tampoco se mandan al informe.
 */
import { describe, expect, it } from "vitest";
import { attributableScanCount, snapshotAttributable } from "@/services/real/playerTrackingService";

const snap = (calcFocus: number | null | undefined, focus: number | null) =>
  ({ focusTrackId: focus, scanCount: 3, sessionMetrics: calcFocus === undefined ? {} : { focusTrackId: calcFocus } }) as never;

const LAB = import.meta.glob(["/src/pages/VitasLab.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("snapshotAttributable", () => {
  it("solo si las métricas se calcularon con la pista enfocada guardada", () => {
    expect(snapshotAttributable(snap(4, 4))).toBe(true);
    expect(snapshotAttributable(snap(null, null))).toBe(false);
    expect(snapshotAttributable(snap(undefined, 4))).toBe(false); // anterior al 6b
    expect(snapshotAttributable(snap(4, 7))).toBe(false); // otra pista
    expect(attributableScanCount(snap(4, 7))).toBeNull();
  });

  it("el Lab solo manda las físicas al informe con la pista enfocada ACTUAL", () => {
    expect(LAB["/src/pages/VitasLab.tsx"]).toMatch(/if \(calibReliable && identityReliable && physicsForFocus\)/);
  });
});
