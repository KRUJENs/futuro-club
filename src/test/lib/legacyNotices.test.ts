/**
 * P1 bloque 7a-3 — informes y planes IDP ANTIGUOS: se avisa, no se borra (punto 12 y
 * restos del 5d). Fechas frontera y versiones exactas.
 */
import { describe, expect, it } from "vitest";
import { legacyReportNotices, withLegacyPhvWithheld } from "@/lib/reports/legacyNotices";
import { isLegacyIdpPlan } from "@/lib/idp/legacyPlan";

const A = (o: Record<string, unknown>) => ({ phv: null, video_id: "v1", completed_at: "2026-10-18T00:00:00Z", ...o });

describe("legacyReportNotices", () => {
  it("maduración no verificada: análisis con PHV ANTES del corte del #301; después no", () => {
    expect(legacyReportNotices({ analysis: A({ phv: { category: "early" }, completed_at: "2026-09-01T00:00:00Z" }), reports: [] }))
      .toEqual(["maturity_unverified"]);
    expect(legacyReportNotices({ analysis: A({ phv: { category: "early" }, completed_at: "2026-10-01T00:00:00Z" }), reports: [] }))
      .toEqual([]);
    expect(legacyReportNotices({ analysis: A({ phv: null, completed_at: "2026-09-01T00:00:00Z" }), reports: [] })).toEqual([]);
  });

  it("análisis base anterior al #317 ⇒ aviso; posterior no", () => {
    expect(legacyReportNotices({ analysis: A({ video_id: "baseline-p1-1", completed_at: "2026-10-01T00:00:00Z" }), reports: [] }))
      .toEqual(["baseline_pre_eval"]);
    expect(legacyReportNotices({ analysis: A({ video_id: "baseline-p1-1", completed_at: "2026-10-16T00:00:00Z" }), reports: [] }))
      .toEqual([]);
  });

  it("duelos: por versión exacta del prompt (base y demo nunca)", () => {
    const r = (report_type: string, prompt_version: string) => ({ analysis: A({}), reports: [{ report_type, prompt_version }] });
    expect(legacyReportNotices(r("player-report", "player-report-v2.3.0"))).toEqual(["duel_figures"]);
    expect(legacyReportNotices(r("player-report", "player-report-v2.4.0"))).toEqual([]);
    expect(legacyReportNotices(r("development-plan", "dev-plan-v1.2.0"))).toEqual(["duel_figures"]);
    expect(legacyReportNotices(r("dna-profile", "dna-profile-v1.3.0"))).toEqual([]);
    expect(legacyReportNotices(r("player-report", "baseline-v1.0"))).toEqual([]);
    expect(legacyReportNotices(r("player-report", "demo"))).toEqual([]);
    expect(legacyReportNotices(r("best-match", "v0.1.0"))).toEqual([]);
  });

  it("lab-biomechanics (sin subida de versión en el 6a): por fecha de generación", () => {
    const lab = (generated_at: string | null) => ({
      analysis: A({}),
      reports: [{ report_type: "lab-biomechanics", prompt_version: "lab-biomech-v1.1.0", generated_at }],
    });
    expect(legacyReportNotices(lab("2026-10-10T00:00:00Z"))).toEqual(["duel_figures"]);
    expect(legacyReportNotices(lab(null))).toEqual(["duel_figures"]);
    expect(legacyReportNotices(lab("2026-10-19T00:00:00Z"))).toEqual([]);
  });
});

describe("isLegacyIdpPlan", () => {
  it("versión < v1.3.0 ⇒ antiguo; ≥ v1.3.0 no; el entrenador nunca", () => {
    expect(isLegacyIdpPlan({ generatedBy: "agent", agentVersion: "v1.2.0" })).toBe(true);
    expect(isLegacyIdpPlan({ generatedBy: "hybrid", agentVersion: "v1.3.1" })).toBe(false);
    expect(isLegacyIdpPlan({ generatedBy: "coach", agentVersion: "v1.0.0" })).toBe(false);
  });

  it("determinista o sin versión: por la fecha de fusión del #320", () => {
    expect(isLegacyIdpPlan({ generatedBy: "agent", agentVersion: "deterministic-v1", createdAt: "2026-10-14T00:00:00Z" })).toBe(true);
    expect(isLegacyIdpPlan({ generatedBy: "agent", agentVersion: "deterministic-v1", createdAt: "2026-10-16T00:00:00Z" })).toBe(false);
    expect(isLegacyIdpPlan({ generatedBy: "agent", agentVersion: null, createdAt: null })).toBe(true);
  });
});

describe("withLegacyPhvWithheld (7b: PHV crudo en «Datos técnicos» y enlace de la familia)", () => {
  // A() = análisis del 18 oct: el sexo debe constar confirmado ANTES de esa fecha.
  const F = { gender: "F", sexConfirmedAt: "2026-10-01T08:00:00Z" };
  const M_OK = { gender: "M", sexConfirmedAt: "2026-10-02T08:00:00Z" };
  const phv = { category: "early", offset: -1.2 };
  it("anterior al #301 ⇒ PHV fuera aunque el sexo esté registrado; el aviso sigue", () => {
    const out = withLegacyPhvWithheld(A({ phv, completed_at: "2026-09-01T00:00:00Z" }), F);
    expect(out.phv).toBeNull();
    expect(out.phv_withheld).toBe(true);
    expect(legacyReportNotices({ analysis: out, reports: [] })).toEqual(["maturity_unverified"]);
  });
  it("posterior al corte pero sin sexo registrado («M» sin confirmar o ausente) ⇒ fuera y con aviso", () => {
    for (const p of [{ gender: "M" }, {}, null]) {
      const out = withLegacyPhvWithheld(A({ phv }), p);
      expect(out.phv).toBeNull();
      expect(legacyReportNotices({ analysis: out, reports: [] })).toEqual(["maturity_unverified"]);
    }
  });
  it("sexo confirmado o cambiado DESPUÉS del análisis (p. ej. «M» por defecto → «F») o «F» sin marca ⇒ fuera", () => {
    for (const p of [{ gender: "F", sexConfirmedAt: "2026-10-19T08:00:00Z" }, { gender: "M", sexConfirmedAt: "2026-10-19T08:00:00Z" }, { gender: "F" }]) {
      const out = withLegacyPhvWithheld(A({ phv }), p);
      expect(out.phv).toBeNull();
      expect(legacyReportNotices({ analysis: out, reports: [] })).toEqual(["maturity_unverified"]);
    }
  });
  it("sexo confirmado DURANTE el procesamiento (después de created_at) ⇒ fuera", () => {
    const a = A({ phv, created_at: "2026-10-18T00:00:00Z", completed_at: "2026-10-18T00:10:00Z" });
    expect(withLegacyPhvWithheld(a, { gender: "F", sexConfirmedAt: "2026-10-18T00:05:00Z" }).phv).toBeNull();
  });
  it("control positivo: posterior al corte y sexo registrado ⇒ intacto, sin aviso", () => {
    for (const p of [F, M_OK]) {
      const a = A({ phv });
      expect(withLegacyPhvWithheld(a, p)).toBe(a);
    }
    expect(legacyReportNotices({ analysis: A({ phv }), reports: [] })).toEqual([]);
  });
  it("sin PHV guardado ⇒ nada que retirar ni avisar", () => {
    const a = A({ phv: null, completed_at: "2026-09-01T00:00:00Z" });
    expect(withLegacyPhvWithheld(a, null)).toBe(a);
  });
});
