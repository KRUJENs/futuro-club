/**
 * vsiDelta — variación del VSI de ficha SOLO entre dos evaluaciones reales con fecha.
 *
 * Caso de origen (docx «Para mejoras Vitas»): el ScoutFeed de Samu mostraba
 * «67.4 (+9.9)»; 67.4 − 9.9 = 57.5 = calculateFichaVsi(60,60,60,60,50,50), el VSI de
 * las barras por defecto que la app guardaba sin evaluación antes de #146. El
 * historial legacy no tiene fechas: NUNCA debe producir una variación.
 */
import { describe, it, expect } from "vitest";
import {
  appendVsiEvaluation,
  computeVsiDelta,
  parseVsiEvaluations,
  readVsiDelta,
  realVsiEvaluations,
  withoutUndatedVsiSeries,
  VSI_DELTA_GATE_REASONS,
  type VsiEvaluation,
} from "@/lib/scoring/vsiDelta";
import { makeMetric, ORIENTATIVE_CONFIDENCE } from "@/lib/metrics/MetricResult";
import { calculateFichaVsi } from "@/services/real/metricsService";

const ev = (value: number, at: string, source: VsiEvaluation["source"] = "coach_form"): VsiEvaluation => ({
  value, at, source,
});

describe("computeVsiDelta — bloqueo sin dos evaluaciones reales con fecha", () => {
  it("el caso Samu: solo historial legacy [57.5, 67.4] ⇒ null + 'historial anterior sin fecha ni origen'", () => {
    // Precondición: 57.5 ES el VSI de las barras por defecto (no una evaluación).
    expect(calculateFichaVsi({ speed: 60, technique: 60, vision: 60, stamina: 60, shooting: 50, defending: 50 })).toBe(57.5);

    const d = computeVsiDelta({ evaluations: undefined, legacyHistory: [57.5, 67.4], currentVsi: 67.4 });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("legacy_undated");
    expect(d.gate_reason).toBe("historial anterior sin fecha ni origen");
    expect(d.from_at).toBeNull();
    expect(d.to_at).toBeNull();
    // Contrato MetricResult: value null ⇒ gate_reason no vacío (no lanza).
    expect(() => makeMetric(d)).not.toThrow();
  });

  it("una sola evaluación con fecha + historial legacy ⇒ sigue bloqueada por el legacy (la base no tiene fecha)", () => {
    const d = computeVsiDelta({
      evaluations: [ev(67.4, "2026-09-10T10:00:00.000Z")],
      legacyHistory: [57.5, 67.4],
      currentVsi: 67.4,
    });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("legacy_undated");
  });

  it("una sola evaluación y sin legacy ⇒ single_evaluation", () => {
    const d = computeVsiDelta({ evaluations: [ev(70, "2026-09-10T10:00:00.000Z")], legacyHistory: [70] });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("single_evaluation");
    expect(d.gate_reason).toBe(VSI_DELTA_GATE_REASONS.single_evaluation);
  });

  it("nada registrado ⇒ no_evaluations (nunca un 0)", () => {
    const d = computeVsiDelta({ evaluations: [], legacyHistory: [] });
    expect(d.value).toBeNull();
    expect(d.value).not.toBe(0);
    expect(d.gate_code).toBe("no_evaluations");
  });

  it("evaluaciones de DEMO no cuentan como reales", () => {
    const d = computeVsiDelta({
      evaluations: [ev(60, "2026-09-01T10:00:00.000Z", "demo_seed"), ev(70, "2026-09-20T10:00:00.000Z", "demo_seed")],
    });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("no_evaluations");
  });

  it("entradas inválidas (sin fecha, fecha rota, origen desconocido, fuera de rango) se descartan", () => {
    const d = computeVsiDelta({
      evaluations: [
        { value: 57.5 },                                            // sin fecha ni origen
        { value: 57.5, at: "no-es-fecha", source: "coach_form" },   // fecha rota
        { value: 57.5, at: "2026-09-01T10:00:00.000Z", source: "llm" }, // origen desconocido
        { value: 140, at: "2026-09-02T10:00:00.000Z", source: "coach_form" }, // fuera de 0..100
        ev(67.4, "2026-09-10T10:00:00.000Z"),
      ],
    });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("single_evaluation");
  });

  it("dos evaluaciones con la misma fecha ⇒ same_instant", () => {
    const at = "2026-09-10T10:00:00.000Z";
    const d = computeVsiDelta({ evaluations: [ev(60, at), ev(65, at)] });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("same_instant");
  });

  it("el VSI actual no coincide con la última evaluación (lo movió otra ruta) ⇒ current_mismatch", () => {
    const d = computeVsiDelta({
      evaluations: [ev(60.2, "2026-09-01T10:00:00.000Z"), ev(60.2, "2026-09-15T10:00:00.000Z")],
      currentVsi: 67.4, // p.ej. el antiguo ajuste PHV ×1.12 sobrescribió vsi
    });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("current_mismatch");
  });

  it("VSI actual null (sin evaluar) con evaluaciones registradas ⇒ current_mismatch (no se inventa)", () => {
    const d = computeVsiDelta({
      evaluations: [ev(60, "2026-09-01T10:00:00.000Z"), ev(64, "2026-09-15T10:00:00.000Z")],
      currentVsi: null,
    });
    expect(d.value).toBeNull();
    expect(d.gate_code).toBe("current_mismatch");
  });
});

describe("computeVsiDelta — correcta con dos evaluaciones reales con fecha", () => {
  it("DERIVADA, 1 decimal, con fechas y valores de las dos evaluaciones comparadas", () => {
    const d = computeVsiDelta({
      evaluations: [ev(57.5, "2026-09-01T10:00:00.000Z"), ev(67.4, "2026-09-20T10:00:00.000Z", "players_api")],
      legacyHistory: [50, 57.5, 67.4], // el legacy existe pero NO entra en la cuenta
      currentVsi: 67.4,
    });
    expect(d.value).toBe(9.9);
    expect(d.provenance).toBe("DERIVADA");
    expect(d.units).toBe("pts");
    expect(d.calibrated).toBe(false);
    expect(d.gate_reason).toBeNull();
    expect(d.gate_code).toBeNull();
    expect(d.confidence).toBe(ORIENTATIVE_CONFIDENCE);
    expect(d.from_at).toBe("2026-09-01T10:00:00.000Z");
    expect(d.to_at).toBe("2026-09-20T10:00:00.000Z");
    expect(d.from_value).toBe(57.5);
    expect(d.to_value).toBe(67.4);
    expect(() => makeMetric(d)).not.toThrow();
  });

  it("usa las DOS ÚLTIMAS por fecha aunque lleguen desordenadas", () => {
    const d = computeVsiDelta({
      evaluations: [
        ev(70, "2026-09-20T10:00:00.000Z"),
        ev(50, "2026-08-01T10:00:00.000Z"),
        ev(66, "2026-09-05T10:00:00.000Z"),
      ],
    });
    expect(d.value).toBe(4);
    expect(d.from_value).toBe(66);
    expect(d.to_value).toBe(70);
  });

  it("bajada ⇒ valor negativo (no se oculta)", () => {
    const d = computeVsiDelta({
      evaluations: [ev(72, "2026-09-01T10:00:00.000Z"), ev(64.5, "2026-09-20T10:00:00.000Z")],
    });
    expect(d.value).toBe(-7.5);
  });

  it("sin cambio ⇒ 0 CALCULADO (dos evaluaciones reales), distinto de bloqueado", () => {
    const d = computeVsiDelta({
      evaluations: [ev(64, "2026-09-01T10:00:00.000Z"), ev(64, "2026-09-20T10:00:00.000Z")],
      currentVsi: 64,
    });
    expect(d.value).toBe(0);
    expect(d.gate_reason).toBeNull();
  });
});

describe("registro de evaluaciones", () => {
  it("appendVsiEvaluation sanea lo previo, añade con fecha y origen y no muta", () => {
    const prev = [{ value: 57.5 }, ev(60, "2026-09-01T10:00:00.000Z")];
    const next = appendVsiEvaluation(prev, 64, "coach_form", "2026-09-10T10:00:00.000Z");
    expect(next).toEqual([ev(60, "2026-09-01T10:00:00.000Z"), ev(64, "2026-09-10T10:00:00.000Z")]);
    expect(prev).toHaveLength(2);
  });

  it("parseVsiEvaluations: no-array ⇒ []", () => {
    expect(parseVsiEvaluations(null)).toEqual([]);
    expect(parseVsiEvaluations({ value: 1 })).toEqual([]);
  });
});

describe("readVsiDelta — lectura defensiva de context_data.vsi_delta", () => {
  it("round-trip de un delta calculado", () => {
    const d = computeVsiDelta({
      evaluations: [ev(60, "2026-09-01T10:00:00.000Z"), ev(64, "2026-09-10T10:00:00.000Z")],
    });
    expect(readVsiDelta(JSON.parse(JSON.stringify(d)))).toEqual({ ...d, source_ref: d.source_ref });
  });

  it("insight legacy (sin vsi_delta) o forma inválida ⇒ null", () => {
    expect(readVsiDelta(undefined)).toBeNull();
    expect(readVsiDelta({ value: 9.9 })).toBeNull(); // sin provenance
    expect(readVsiDelta({ value: null, provenance: "DERIVADA", gate_reason: "" })).toBeNull(); // null sin motivo
    expect(readVsiDelta({ value: "9.9", provenance: "DERIVADA" })).toBeNull();
  });
});

describe("realVsiEvaluations — única serie para gráficas de evolución", () => {
  it("solo evaluaciones reales con fecha, en orden; fuera demo_seed y entradas sin fecha", () => {
    const raw = [
      ev(70, "2026-09-20T10:00:00.000Z"),
      ev(99, "2026-09-05T10:00:00.000Z", "demo_seed"),
      { value: 57.5 }, // sin fecha ni origen (forma del legacy)
      ev(64, "2026-09-10T10:00:00.000Z", "players_api"),
    ];
    expect(realVsiEvaluations(raw)).toEqual([
      ev(64, "2026-09-10T10:00:00.000Z", "players_api"),
      ev(70, "2026-09-20T10:00:00.000Z"),
    ]);
  });

  it("el historial legacy [57.5, 67.4] (números sueltos) no produce ninguna evaluación", () => {
    expect(realVsiEvaluations([57.5, 67.4])).toEqual([]);
    expect(realVsiEvaluations(undefined)).toEqual([]);
  });

  it("es la misma serie que usa computeVsiDelta (última − penúltima de realVsiEvaluations)", () => {
    const raw = [ev(60, "2026-09-01T10:00:00.000Z"), ev(63.5, "2026-09-10T10:00:00.000Z"), ev(99, "2026-09-12T10:00:00.000Z", "demo_seed")];
    const series = realVsiEvaluations(raw);
    const d = computeVsiDelta({ evaluations: raw });
    expect(d.value).toBe(series[series.length - 1].value - series[series.length - 2].value);
    expect(d.to_at).toBe(series[series.length - 1].at);
  });
});

describe("withoutUndatedVsiSeries — analyses.vsi sin la serie legacy retirada", () => {
  it("quita trend e history (calculados sobre vsi_history sin fechas) y conserva el resto", () => {
    // Forma real de una fila baseline-v1.0 de Samu: [57.5, 67.4] + el VSI de otra fórmula.
    const stored = {
      vsi: 67, tier: "talent", tierLabel: "Talento",
      peer: { percentile: null, peerCount: 0, stratum: "no-data" },
      trend: { slope: 4.75, momentum: "up", confidence: "medium", delta: null, samples: 3 },
      history: [57.5, 67.4, 67],
    };
    const out = withoutUndatedVsiSeries(stored);
    expect(out).toEqual({ vsi: 67, tier: "talent", tierLabel: "Talento" });
    expect(out).not.toHaveProperty("trend");
    expect(out).not.toHaveProperty("history");
    // No muta la fila leída.
    expect(stored).toHaveProperty("trend");
  });

  it("P1 bloque 5: quita también `peer` (percentil de todas las cuentas, sin mínimo, «P0»)", () => {
    const stored = { vsi: 0, tierLabel: "En desarrollo", peer: { percentile: 0, peerCount: 3, stratum: "MC U9±1 todos" } };
    const out = withoutUndatedVsiSeries(stored);
    expect(out).not.toHaveProperty("peer");
    expect(out).toEqual({ vsi: 0, tierLabel: "En desarrollo" });
  });

  it("valores no-objeto pasan tal cual (vsi null en análisis sin VSI)", () => {
    expect(withoutUndatedVsiSeries(null)).toBeNull();
    expect(withoutUndatedVsiSeries(undefined)).toBeUndefined();
  });
});
