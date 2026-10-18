/**
 * P1 bloque 7a-3 — informes y planes IDP ANTIGUOS: se avisa, no se borra (punto 12 y
 * restos del 5d). Fechas frontera y versiones exactas.
 */
import { describe, expect, it } from "vitest";
import { legacyReportNotices } from "@/lib/reports/legacyNotices";
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
