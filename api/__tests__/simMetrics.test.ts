/**
 * VITAS · Tests de deriveSimMetrics (docx #14 · P3).
 *
 * Fija el comportamiento HONESTO del comparable profesional:
 *   - Sin eventos observados → null → el orquestador se ABSTIENE (no fabrica un
 *     match de 6 dims con constantes; era el bug de las 65/60/55, inv #1).
 *   - Con eventos → deriva de RATIOS reales (precisión de pase, % disparos; sin duelos
 *     desde el P1 bloque 6: sin criterio validado, src/lib/tracking/duels.ts)
 *     y cuenta cuántas dims salen de un ratio real (ratioDerivedDims) para modular
 *     la confianza.
 */
import { describe, it, expect } from "vitest";
import { deriveSimMetrics } from "../_lib/simMetrics";

describe("deriveSimMetrics · abstención sin eventos", () => {
  it("null / sin observaciones → null (abstención)", () => {
    expect(deriveSimMetrics(null, 70)).toBeNull();
    expect(deriveSimMetrics({}, 70)).toBeNull();
    expect(deriveSimMetrics({ gemini: null, eventSummary: null }, 70)).toBeNull();
    // physicalMetrics presente pero SIN eventos de juego → sigue abstención
    expect(deriveSimMetrics({ physicalMetrics: { tracksDetected: 5 } }, 70)).toBeNull();
  });

  it("objeto de eventos vacío o todo-ceros → null (abstención por CONTENIDO, no presencia)", () => {
    expect(deriveSimMetrics({ gemini: { eventosContados: {} } }, 70)).toBeNull();
    expect(
      deriveSimMetrics({ eventSummary: { totalEvents: 0, passesAttempted: 0, duelsWon: 0, duelsLost: 0 } }, 70),
    ).toBeNull();
  });
});

describe("deriveSimMetrics · path Gemini (eventosContados)", () => {
  const obs = {
    gemini: {
      eventosContados: {
        pasesCompletados: 30, pasesFallados: 10, pasesProgresivos: 6,
        regatesConVentaja: 4, regatesSinVentaja: 1,
        duelosGanados: 7, duelosPerdidos: 3,
        recuperaciones: 5, robos: 2, anticipaciones: 1,
        disparosAlArco: 3, disparosFuera: 1, escaneos: 12,
      },
    },
  };

  it("technique ← precisión de pase (30/40=75) + regate (4/5=80) → ~78", () => {
    const r = deriveSimMetrics(obs, 60)!;
    expect(r).not.toBeNull();
    expect(r.source).toBe("gemini");
    expect(r.metrics.technique).toBe(78); // (75+80)/2
  });

  it("defending ← SOLO volumen defensivo; los duelos NO cuentan (P1 bloque 6); shooting ← %disparos (3/4=75)", () => {
    const r = deriveSimMetrics(obs, 60)!;
    expect(r.metrics.shooting).toBe(75); // 3/(3+1)
    const { duelosGanados: _g, duelosPerdidos: _p, ...sinDuelos } = obs.gemini.eventosContados;
    const r2 = deriveSimMetrics({ gemini: { eventosContados: sinDuelos } }, 60)!;
    expect(r.metrics.defending).toBe(r2.metrics.defending);
    expect(r.ratioDerivedDims).toBe(r2.ratioDerivedDims);
  });

  it("cuenta las dims de ratio real (pase, disparo) + física real = 3 (sin ratio de duelos)", () => {
    const r = deriveSimMetrics(obs, 60)!;
    // physical real (1) + technique-ratio (1) + shot-ratio (1)
    expect(r.ratioDerivedDims).toBe(3);
  });

  it("physicalValue null → speed/stamina neutros (50), física NO cuenta como ratio", () => {
    const r = deriveSimMetrics(obs, null)!;
    expect(r.metrics.speed).toBe(50);
    expect(r.metrics.stamina).toBe(50);
    expect(r.ratioDerivedDims).toBe(2); // sin la física
  });

  it("n=1 NO cuenta como ratio (1 disparo no da shooting=100 fiable)", () => {
    const r = deriveSimMetrics(
      { gemini: { eventosContados: { pasesCompletados: 20, pasesFallados: 5, disparosAlArco: 1, disparosFuera: 0 } } },
      60,
    )!;
    expect(r.metrics.shooting).toBeLessThan(100); // cae al proxy, no al ratio n=1
    expect(r.ratioDerivedDims).toBe(2); // física(1) + pases(1); disparo n=1 no cuenta, sin duelos
  });

  it("todas las métricas quedan en [0,100]", () => {
    const r = deriveSimMetrics(obs, 60)!;
    for (const v of Object.values(r.metrics)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("deriveSimMetrics · path cliente (eventSummary)", () => {
  it("technique ← passCompletionPct; defending ← recoveries (los duelos de un cliente antiguo no cuentan)", () => {
    const base = { passCompletionPct: 62, recoveries: 3, shots: 2, xgContributions: 0.4 };
    const r = deriveSimMetrics({ eventSummary: { ...base, duelsWon: 6, duelsLost: 4 } }, 55)!;
    const r2 = deriveSimMetrics({ eventSummary: base }, 55)!;
    expect(r.source).toBe("client");
    expect(r.metrics.technique).toBe(62);
    expect(r.metrics.defending).toBeGreaterThan(0);
    expect(r.metrics.defending).toBe(r2.metrics.defending);
    expect(r.ratioDerivedDims).toBe(2); // física + pase (sin ratio de duelos)
  });

  it("solo duelos (sin otros eventos) ⇒ abstención: no son señal (P1 bloque 6)", () => {
    expect(deriveSimMetrics({ eventSummary: { duelsWon: 6, duelsLost: 4 } }, null)).toBeNull();
    expect(deriveSimMetrics({ gemini: { eventosContados: { duelosGanados: 6, duelosPerdidos: 4 } } }, null)).toBeNull();
  });
});
