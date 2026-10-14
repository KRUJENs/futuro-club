/**
 * P1 bloque 4 · fatiga y carga SIN maduración registrada (decisión del owner):
 * sin semáforo (ni severidad, ni zona ACWR, ni alertas); la carga se muestra.
 * Antes un offset PHV desconocido se clasificaba en silencio como "post_phv"
 * (umbrales de adulto), el ACWR sin datos salía 0 / "óptimo" y un componente del
 * índice que faltaba contaba como 0.
 */
import { describe, it, expect } from "vitest";
import {
  adjustFatigueThresholds,
  classifyBand,
  maturationKnown,
  MATURATION_UNKNOWN_REASON,
} from "@/lib/fatigue/phvFatigueAdjuster";
import { computeACWR, MIN_SESSIONS_RELIABLE, type SessionLoad } from "@/lib/fatigue/acwrService";
import { FatigueEngine, type TrackingPosition } from "@/lib/fatigue/fatigueEngine";

const sessions = (n: number, load = 100): SessionLoad[] =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(1 + i * 2).padStart(2, "0")}`, load }));

/** Recorrido de `minutes` minutos: rápido la 1.ª mitad, lento la 2.ª (hay fatiga). */
function track(minutes: number): TrackingPosition[] {
  const out: TrackingPosition[] = [];
  let x = 0;
  const steps = minutes * 60; // 1 Hz
  for (let i = 0; i <= steps; i++) {
    const firstHalf = i < steps / 2;
    // Cada 20 s un tramo a 7 m/s en la primera mitad y a 3 m/s en la segunda.
    const v = i % 20 < 4 ? (firstHalf ? 7 : 3) : firstHalf ? 3 : 1.5;
    x += v;
    out.push({ x, y: 0, timestampMs: i * 1000 });
  }
  return out;
}

/**
 * Recorrido SIN sprints (máx. 5 m/s < 5.83): la caída de sprints no se puede calcular.
 * Con `gentle` además sin aceleraciones fuertes ni alta intensidad: faltan 3 componentes.
 */
function trackNoSprint(minutes: number, gentle = false): TrackingPosition[] {
  const out: TrackingPosition[] = [];
  let x = 0;
  const steps = minutes * 60;
  for (let i = 0; i <= steps; i++) {
    const firstHalf = i < steps / 2;
    // gentle: arranque suave (sin una aceleración fuerte desde parado) y luego 3-3.6 m/s.
    const v = gentle
      ? i < 4 ? i * 0.9 : (i % 2 ? 3.6 : 3) * (firstHalf ? 1 : 0.9)
      : i % 4 < 2 ? (firstHalf ? 5 : 4.2) : 2;
    x += v;
    out.push({ x, y: 0, timestampMs: i * 1000 });
  }
  return out;
}

describe("umbrales sin maduración", () => {
  it("offset desconocido ⇒ banda \"unknown\" (antes \"post_phv\"), sin umbrales ACWR, con motivo", () => {
    expect(classifyBand(null)).toBe("unknown");
    const t = adjustFatigueThresholds(null);
    expect(t).toMatchObject({ band: "unknown", adjusted: false, acwrDangerThreshold: null, acwrCautionThreshold: null });
    expect(t.gate_reason).toBe(MATURATION_UNKNOWN_REASON);
    // Para CONTAR se usan las definiciones estándar (qué es un sprint), no para clasificar.
    expect(t.sprintThresholdMs).toBe(adjustFatigueThresholds(5).sprintThresholdMs);
  });

  it("control: con maduración conocida no cambia nada (bandas y umbrales de antes)", () => {
    expect(adjustFatigueThresholds(-3)).toMatchObject({ band: "pre_phv", adjusted: true, acwrDangerThreshold: 1.3, gate_reason: null });
    expect(adjustFatigueThresholds(0)).toMatchObject({ band: "circa_phv", adjusted: true, acwrDangerThreshold: 1.4 });
    expect(adjustFatigueThresholds(2)).toMatchObject({ band: "post_phv", adjusted: false, acwrDangerThreshold: 1.5 });
  });

  it("maturationKnown: \"post_phv\" sin offset (el valor por defecto antiguo) cuenta como desconocida", () => {
    expect(maturationKnown("circa_phv", 0.1)).toBe(true);
    expect(maturationKnown("post_phv", 1.8)).toBe(true);
    expect(maturationKnown("post_phv", null)).toBe(false);
    expect(maturationKnown("unknown", null)).toBe(false);
    expect(maturationKnown(undefined, undefined)).toBe(false);
  });
});

describe("ACWR honesto", () => {
  it(`con menos de ${MIN_SESSIONS_RELIABLE} sesiones no hay ratio ni zona (antes 0 y "óptimo")`, () => {
    const r = computeACWR(sessions(1), 100, adjustFatigueThresholds(2));
    expect(r).toMatchObject({ value: null, zone: null, acuteLoad: null, chronicLoad: null, recommendation: null, reliable: false });
    expect(r.gate_reason).toMatch(/2 de 4/);
  });

  it("maduración desconocida: el ratio SÍ se muestra (carga), la zona y la recomendación NO", () => {
    const r = computeACWR(sessions(5), 400, adjustFatigueThresholds(null));
    expect(typeof r.value).toBe("number");
    expect(r.zone).toBeNull();
    expect(r.recommendation).toBeNull();
    expect(r.gate_reason).toBe(MATURATION_UNKNOWN_REASON);
  });

  it("control: con maduración y ≥4 sesiones hay zona (con los umbrales de su banda)", () => {
    const spike = computeACWR(sessions(5), 400, adjustFatigueThresholds(0));
    expect(spike.zone).toBe("danger");
    expect(spike.gate_reason).toBeNull();
    expect(spike.recommendation).toMatch(/circa-PHV/);
  });
});

describe("índice de fatiga", () => {
  const engine = new FatigueEngine();

  it("maduración desconocida: índice y severidad null, sin alertas; la carga y las ventanas sí", () => {
    const out = engine.analyze({ positions: track(40), durationSec: 40 * 60, thresholds: adjustFatigueThresholds(null) });
    expect(out.fatigueIndex.value).toBeNull();
    expect(out.fatigueIndex.severity).toBeNull();
    expect(out.fatigueIndex.gate_reason).toBe(MATURATION_UNKNOWN_REASON);
    expect(out.alerts).toEqual([]);
    expect(out.windows.length).toBeGreaterThan(1);
    expect(out.totalMetabolicLoad).toBeGreaterThan(0);
  });

  it("control: la MISMA sesión con maduración da índice, severidad y alertas", () => {
    const out = engine.analyze({ positions: track(40), durationSec: 40 * 60, thresholds: adjustFatigueThresholds(2) });
    expect(typeof out.fatigueIndex.value).toBe("number");
    expect(out.fatigueIndex.severity).not.toBeNull();
    expect(out.fatigueIndex.gate_reason).toBeNull();
  });

  it("sesión corta: índice null con motivo (antes un número con «poco fiable» al lado)", () => {
    const out = engine.analyze({ positions: track(10), durationSec: 10 * 60, thresholds: adjustFatigueThresholds(2) });
    expect(out.fatigueIndex.value).toBeNull();
    expect(out.fatigueIndex.gate_reason).toMatch(/demasiado corta/);
  });

  it("falta solo un componente (sprints, 30 % del peso): se calcula con los demás (cobertura 70 %)", () => {
    const out = engine.analyze({ positions: trackNoSprint(40), durationSec: 40 * 60, thresholds: adjustFatigueThresholds(2) });
    expect(out.fatigueIndex.decay.sprintDecayPct).toBeNull();
    expect(out.fatigueIndex.decay.accelDecayPct).not.toBeNull();
    expect(typeof out.fatigueIndex.value).toBe("number");
  });

  it("faltan varios componentes (cobertura < 70 %): índice null, sin severidad ni alertas (antes salía con uno del 10 %)", () => {
    const out = engine.analyze({ positions: trackNoSprint(40, true), durationSec: 40 * 60, thresholds: adjustFatigueThresholds(2) });
    expect(out.fatigueIndex.decay.sprintDecayPct).toBeNull();
    expect(out.fatigueIndex.decay.accelDecayPct).toBeNull();
    expect(out.fatigueIndex.value).toBeNull();
    expect(out.fatigueIndex.severity).toBeNull();
    expect(out.fatigueIndex.gate_reason).toMatch(/suficientes métricas/);
    expect(out.alerts.filter((a) => a.source === "fatigue_index")).toEqual([]);
  });

  it("sin posiciones: índice null (antes 0 «normal») y sin carga", () => {
    const out = engine.analyze({ positions: [], durationSec: 0, thresholds: adjustFatigueThresholds(2) });
    expect(out.fatigueIndex).toMatchObject({ value: null, severity: null });
    expect(out.totalMetabolicLoad).toBeNull();
  });
});
