/**
 * Percentil entre pares — implementación ÚNICA (src/lib/metrics/percentile.ts, P1 bloque 5).
 *
 * Antes había 6 cálculos con resultados opuestos para el mismo niño: «≤1 valor ⇒ 100»
 * (Rankings), grupo vacío ⇒ 50 (MetricsService), percent_rank() de la RPC ⇒ P0 al
 * evaluado solo en su grupo, y /api/benchmark/peer con el valor ausente del jugador
 * como 0 ⇒ «P0» que veía su familia. Ninguno tenía un mínimo de pares.
 */
import { describe, it, expect } from "vitest";
import {
  peerPercentile,
  peerDistribution,
  percentilesAmong,
  percentileGateInfo,
} from "@/lib/metrics/percentile";
import { PERCENTILE_MIN_PEERS, PERCENTILE_MIN_PEERS_SOURCE } from "../../../config/percentiles";
import { ORIENTATIVE_CONFIDENCE } from "@/lib/metrics/MetricResult";

const TEN = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

describe("peerPercentile", () => {
  it("el mínimo es 10 pares, con su procedencia declarada (decisión del producto)", () => {
    expect(PERCENTILE_MIN_PEERS).toBe(10);
    expect(PERCENTILE_MIN_PEERS_SOURCE).toMatch(/decisión del producto/);
  });

  it("jugador sin evaluar ⇒ null + motivo, nunca P0", () => {
    const r = peerPercentile(null, TEN);
    expect(r.result.value).toBeNull();
    expect(r.gate_code).toBe("not_evaluated");
    expect(r.result.gate_reason).toBeTruthy();
    expect(peerPercentile(undefined, TEN).result.value).toBeNull();
    expect(peerPercentile(Number.NaN, TEN).result.value).toBeNull();
  });

  it("con menos de 10 pares ⇒ null + motivo (antes: P100 con 1 par, P0 en la RPC)", () => {
    const one = peerPercentile(80, [50]);
    expect(one.result.value).toBeNull();
    expect(one.gate_code).toBe("insufficient_peers");
    expect(one.peers_valid).toBe(1);
    expect(one.min_peers).toBe(10);
    expect(one.result.gate_reason).toMatch(/1 jugadores evaluados comparables \(mínimo 10\)/);
    expect(peerPercentile(80, TEN.slice(0, 9)).result.value).toBeNull();
  });

  it("los pares sin evaluar no cuentan (ni como 0 ni para el mínimo)", () => {
    const r = peerPercentile(55, [...TEN.slice(0, 9), null, undefined, Number.NaN]);
    expect(r.peers_valid).toBe(9);
    expect(r.result.value).toBeNull();
  });

  it("con 10 pares: rango percentil de punto medio, DERIVADA y confianza orientativa", () => {
    const r = peerPercentile(55, TEN);
    expect(r.result.value).toBe(50); // 5 por debajo de 10
    expect(r.result.provenance).toBe("DERIVADA");
    expect(r.result.confidence).toBe(ORIENTATIVE_CONFIDENCE);
    expect(r.gate_code).toBeNull();
    // empate: cuenta la mitad
    expect(peerPercentile(50, TEN).result.value).toBe(45); // (4 + 0.5)/10
    // 0 y 100 son resultados reales con 10 pares
    expect(peerPercentile(5, TEN).result.value).toBe(0);
    expect(peerPercentile(105, TEN).result.value).toBe(100);
  });
});

describe("peerDistribution", () => {
  it("mismo mínimo: con menos de 10 pares no hay media ni cuantiles", () => {
    const d = peerDistribution([50, 60, 70]);
    expect(d.result.value).toBeNull();
    expect(d.gate_code).toBe("insufficient_peers");
  });

  it("media y cuantiles por rango más cercano sobre pares válidos", () => {
    const d = peerDistribution([...TEN, null]);
    expect(d.peers_valid).toBe(10);
    expect(d.result.value).toEqual({ mean: 55, p25: 30, p50: 60, p75: 80, p90: 100 });
  });
});

describe("percentilesAmong", () => {
  it("el propio jugador nunca es par de sí mismo: 11 evaluados ⇒ 10 pares cada uno", () => {
    const members = [...TEN, 55].map((v, i) => ({ id: `p${i}`, value: v }));
    const out = percentilesAmong(members);
    expect(out.get("p10")!.peers_valid).toBe(10);
    expect(out.get("p10")!.result.value).toBe(50);
  });

  it("10 evaluados en total ⇒ 9 pares ⇒ todos bloqueados", () => {
    const members = TEN.map((v, i) => ({ id: `p${i}`, value: v }));
    for (const r of percentilesAmong(members).values()) {
      expect(r.result.value).toBeNull();
      expect(r.gate_code).toBe("insufficient_peers");
    }
  });

  it("reales y de ejemplo no se mezclan (antes «Cargar datos de ejemplo» llenaba el grupo)", () => {
    const demos = [...TEN, 55].map((v, i) => ({ id: `d${i}`, value: v, isDemo: true }));
    const real = { id: "real", value: 55 };
    const out = percentilesAmong([...demos, real]);
    expect(out.get("real")!.result.value).toBeNull();
    expect(out.get("real")!.peers_valid).toBe(0);
    // la demo solo se compara con la demo: 11 de ejemplo ⇒ 10 pares cada uno
    expect(out.get("d10")!.peers_valid).toBe(10);
    expect(out.get("d10")!.result.value).toBe(50);
  });

  it("byGroup: solo compiten los del mismo grupo de edad", () => {
    const sub14 = TEN.map((v, i) => ({ id: `a${i}`, value: v, group: "Sub-14" }));
    const sub16 = [{ id: "solo", value: 99, group: "Sub-16" }];
    const out = percentilesAmong([...sub14, ...sub16], { byGroup: true });
    expect(out.get("solo")!.result.value).toBeNull(); // antes: P100 (≤1 valor) o P0 (RPC)
    expect(percentileGateInfo(out.get("solo")!)).toEqual({ code: "insufficient_peers", peers: 0, min: 10 });
  });
});
