/**
 * Tests · api/_lib/dropoutAssessment.ts — ÚNICA construcción de entradas del riesgo
 * de abandono en servidor (la comparten /api/wellbeing/dropout-risk y el digest al
 * director). Foco: nunca un riesgo sin señal real (inv #2) y MetricResult honesto.
 */
import { describe, it, expect } from "vitest";
import {
  computeDropoutAssessment,
  dropoutRiskMetric,
  type DropoutSignalRows,
} from "../dropoutAssessment";
import { ORIENTATIVE_CONFIDENCE } from "../../../src/lib/metrics/MetricResult";

const EMPTY: DropoutSignalRows = { attendance: [], engagement: [], fatigue: [] };

const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;

/** Señales reales que el scorer canónico sitúa en riesgo ALTO (comprobado abajo). */
function highRiskRows(playerId: string): DropoutSignalRows {
  return {
    attendance: Array.from({ length: 10 }, (_, i) => ({
      player_id: playerId, date: day(20 - i), status: "absent", source: "manual", session_id: null,
    })),
    engagement: [5, 95, 95, 95, 95].map((c, i) => ({
      session_id: `s${i}`, date: day(20 - i), physical: c, social: c, emotional: c, composite: c, trend: "declining", weekly_avg: c,
    })),
    fatigue: [{ session_date: day(20), total_load: 500, fatigue_index: 100, fatigue_severity: "critical", acwr_value: 1.8, maturation_band: "circa_phv", phv_offset: 0.2 }],
  };
}

describe("sobreentrenamiento · sin maduración no hay semáforo (P1 bloque 4)", () => {
  const ATT = Array.from({ length: 6 }, (_, i) => ({ player_id: "p1", date: day(20 - i), status: "present", source: "manual", session_id: null }));

  it("índice con maduración NO registrada → no es señal; riesgo y nivel null, se muestra la carga", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      attendance: ATT,
      fatigue: [{ session_date: day(3), total_load: 410, fatigue_index: 90, maturation_band: null, phv_offset: null }],
    });
    expect(r.signals.fatigue).toBe(false);
    expect(r.source).toBe("computed"); // por la asistencia
    if (r.source === "computed") {
      expect(r.assessment.overtraining).toMatchObject({
        risk: null, riskLevel: null, currentLoadAU: 410, recommendedLoadAU: null, adjustmentPct: null, gate_code: "maturation_unknown",
      });
      expect(r.assessment.overtraining.gate_reason).toMatch(/Maduración no registrada/);
    }
  });

  it("\"post_phv\" sin offset (valor por defecto antiguo) = maduración desconocida", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      attendance: ATT,
      fatigue: [{ session_date: day(3), total_load: 410, fatigue_index: 90, maturation_band: "post_phv", phv_offset: null }],
    });
    expect(r.signals.fatigue).toBe(false);
    if (r.source === "computed") expect(r.assessment.overtraining).toMatchObject({ risk: null, gate_code: "maturation_unknown" });
  });

  it("control positivo: la misma sesión con maduración registrada SÍ da riesgo y nivel (cortes del índice)", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      attendance: ATT,
      fatigue: [{ session_date: day(3), total_load: 410, fatigue_index: 90, maturation_band: "post_phv", phv_offset: 1.6 }],
    });
    expect(r.signals.fatigue).toBe(true);
    if (r.source === "computed") {
      expect(r.assessment.overtraining).toMatchObject({ risk: 90, riskLevel: "critical", currentLoadAU: 410, gate_code: null });
      // Nada calcula una carga recomendada: nunca se repite la actual como si lo fuera.
      expect(r.assessment.overtraining.recommendedLoadAU).toBeNull();
    }
  });

  it("la carga es la de la MISMA sesión que el riesgo; un 0 (DEFAULT de la columna) no es carga", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      attendance: ATT,
      fatigue: [
        { session_date: day(5), total_load: 0, fatigue_index: null },
        { session_date: day(4), total_load: 420, fatigue_index: 80, maturation_band: "circa_phv", phv_offset: 0.2 },
      ],
    });
    if (r.source !== "computed") throw new Error("esperaba computed");
    // Antes: { risk: 80, riskLevel: "critical", currentLoadAU: 0 } (el 0 de otra sesión).
    expect(r.assessment.overtraining).toMatchObject({ risk: 80, riskLevel: "critical", currentLoadAU: 420 });
  });

  it("sin maduración y solo cargas 0 → carga null (nunca «0 UA»)", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      attendance: ATT,
      fatigue: [{ session_date: day(3), total_load: 0, fatigue_index: 70, maturation_band: null, phv_offset: null }],
    });
    if (r.source !== "computed") throw new Error("esperaba computed");
    expect(r.assessment.overtraining).toMatchObject({ risk: null, currentLoadAU: null, gate_code: "maturation_unknown" });
  });

  it("sin implicación real registrada → engagement null (antes current 0 ⇒ «disfrute bajo» en rojo)", () => {
    const r = computeDropoutAssessment("p1", { ...EMPTY, attendance: ATT });
    expect(r.source).toBe("computed");
    if (r.source === "computed") expect(r.assessment.engagement).toBeNull();
  });

  it("sin sesiones de fatiga (calculado por otras señales) → «sin calcular», nunca «0/100 bajo»", () => {
    const r = computeDropoutAssessment("p1", { ...EMPTY, attendance: ATT });
    expect(r.source).toBe("computed");
    if (r.source === "computed") {
      expect(r.assessment.overtraining).toMatchObject({ risk: null, riskLevel: null, currentLoadAU: null, gate_code: "no_data" });
    }
  });
});

describe("computeDropoutAssessment · sin señal real → insufficient_data (inv #2)", () => {
  it("sin ninguna fila → insufficient_data y métrica BLOQUEADA (value null + gate_reason)", () => {
    const r = computeDropoutAssessment("p1", EMPTY);
    expect(r.source).toBe("insufficient_data");
    const m = dropoutRiskMetric(r);
    expect(m.value).toBeNull();
    expect(m.gate_reason && m.gate_reason.trim().length).toBeGreaterThan(0);
    expect(m.confidence).toBe(0);
  });

  it("engagement con composite 0 (DEFAULT de columna) no cuenta como señal", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      engagement: [{ date: day(1), physical: 0, social: 0, emotional: 0, composite: 0 }],
    });
    expect(r.source).toBe("insufficient_data");
    expect(r.signals.engagement).toBe(false);
  });

  it("sesión de fatiga SIN fatigue_index (nullable, 043) no cuenta como señal", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      fatigue: [{ session_date: day(1), total_load: 0, fatigue_index: null, acwr_value: null }],
    });
    expect(r.source).toBe("insufficient_data");
    expect(r.signals.fatigue).toBe(false);
  });

  it("control positivo: la MISMA sesión con fatigue_index real sí computa", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      fatigue: [{ session_date: day(1), total_load: 300, fatigue_index: 60, acwr_value: 1.2, maturation_band: "circa_phv", phv_offset: 0.2 }],
    });
    expect(r.source).toBe("computed");
    expect(r.signals.fatigue).toBe(true);
    if (r.source === "computed") expect(r.assessment.overtraining.risk).toBe(60);
  });

  it("usa el fatigue_index REAL más reciente, no la última fila vacía", () => {
    const r = computeDropoutAssessment("p1", {
      ...EMPTY,
      fatigue: [
        { session_date: day(5), total_load: 0, fatigue_index: null },
        { session_date: day(4), total_load: 420, fatigue_index: 80, maturation_band: "circa_phv", phv_offset: 0.2 },
      ],
    });
    expect(r.source).toBe("computed");
    if (r.source === "computed") expect(r.assessment.overtraining.risk).toBe(80);
  });
});

describe("computeDropoutAssessment · con señal real", () => {
  it("fixture de riesgo alto → computed, nivel high, cobertura declarada", () => {
    const r = computeDropoutAssessment("p-high", highRiskRows("p-high"));
    expect(r.source).toBe("computed");
    expect(r.assessment.riskLevel).toBe("high");
    expect(r.signals).toEqual({ attendance: true, engagement: true, motivation: true, fatigue: true });
  });

  it("es determinista: mismas filas → misma evaluación (panel y email coinciden)", () => {
    const a = computeDropoutAssessment("p-high", highRiskRows("p-high"));
    const b = computeDropoutAssessment("p-high", highRiskRows("p-high"));
    expect(a.assessment).toEqual(b.assessment);
  });

  it("dropoutRiskMetric: DERIVADA, confianza orientativa, sin calibración, con source_ref", () => {
    const m = dropoutRiskMetric(computeDropoutAssessment("p-high", highRiskRows("p-high")));
    expect(m.provenance).toBe("DERIVADA");
    expect(m.value).toBeGreaterThanOrEqual(50);
    expect(m.confidence).toBe(ORIENTATIVE_CONFIDENCE);
    expect(m.calibrated).toBe(false);
    expect(m.gate_reason).toBeNull();
    expect(m.source_ref).toContain("pendientes de validar");
  });
});
