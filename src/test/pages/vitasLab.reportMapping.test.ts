/**
 * VitasLab · panel de resultados tras analizar (P1 bloque 2, inv #2 y #7).
 * Antes mapV2ToReport era una SEGUNDA copia del mapeo que rellenaba lo que faltaba con
 * textos fijos: «Análisis completado · pipeline GPU + MediaPipe.», nivel «talent»
 * (pintado «TALENT»), «Perfil táctico calculado por IA», «DNA Análisis», «Determinado y
 * competitivo», «Consolidar fundamentos técnicos», «Transición a nivel competitivo
 * superior», proyección «Semi-pro»/«Amateur alto» y comparable con 70 % por defecto (y
 * leído de bm.nombre, que el narrador no emite). Ahora usa mapDbRowToLegacy.
 */
import { describe, it, expect } from "vitest";
import { mapV2ToReport } from "@/pages/vitasLab/reportMapping";
import { mapDbRowToLegacy, type AnalysisV2Result } from "@/hooks/usePlayerAnalysisV2";

const CANNED = [
  "Análisis completado",
  "talent",
  "Perfil táctico calculado por IA",
  "DNA Análisis",
  "Determinado y competitivo",
  "Consolidar fundamentos técnicos",
  "Transición a nivel competitivo superior",
  "Semi-pro",
  "Amateur alto",
  "Progresión favorable",
  "Desarrollo consistente",
];

function result(reports: AnalysisV2Result["reports"], vsi: AnalysisV2Result["vsi"] = null): AnalysisV2Result {
  return {
    analysisId: "a1", videoId: "v1", vsi, phv: null, similarity: null, scanning: null, biomechanics: null,
    reports, completedAt: "2026-10-13T10:00:00Z",
  };
}
const rep = (report_type: string, content: Record<string, unknown>) => ({ report_type, content, model: "m", prompt_version: "1" });

describe("mapV2ToReport", () => {
  it("sin informes ⇒ null", () => {
    expect(mapV2ToReport(result(null))).toBeNull();
    expect(mapV2ToReport(result([]))).toBeNull();
  });

  it("informes sin esos campos ⇒ vacíos/null, ningún texto ni cifra de relleno", () => {
    const r = mapV2ToReport(result([rep("player-report", {}), rep("dna-profile", {}), rep("best-match", {}), rep("projection", {}), rep("development-plan", {})]))!;
    expect(r).not.toBeNull();
    expect(r.estadoActual.resumenEjecutivo).toBe("");
    expect(r.estadoActual.nivelActual).toBeNull();
    expect(r.adnFutbolistico).toMatchObject({ estiloJuego: "", arquetipoTactico: "", mentalidad: "" });
    expect(r.jugadorReferencia.bestMatch).toBeNull();
    expect(r.proyeccionCarrera).toBeNull();
    expect(r.planDesarrollo).toMatchObject({ objetivo6meses: "", objetivo18meses: "" });
    const json = JSON.stringify(r);
    for (const c of CANNED) expect(json, c).not.toContain(c);
  });

  it("comparable desde el sobre del narrador (antes buscaba bm.nombre y caía al 70 %)", () => {
    const r = mapV2ToReport(result([
      rep("best-match", { narrative: { primary_match: { player: "Pedri", club: "FC Barcelona", similarity_pct: 71.6, narrative: "Conduce." } } }),
    ]))!;
    expect(r.jugadorReferencia.bestMatch).toMatchObject({ nombre: "Pedri", club: "FC Barcelona", score: 72 });
  });

  it("misma salida que el Histórico (una sola implementación, inv #7)", () => {
    const reports = [
      rep("player-report", { executive_summary: "Resumen real", tier_label: "medio_alto" }),
      rep("development-plan", { goal_6months: "Mejorar el perfil débil" }),
    ];
    const lab = mapV2ToReport(result(reports));
    const hist = mapDbRowToLegacy({ id: "a1", player_id: "", video_id: "v1", created_at: "2026-10-13T10:00:00Z", vsi: null, reports }).report;
    expect(lab).toEqual(hist);
    expect(lab!.estadoActual.resumenEjecutivo).toBe("Resumen real");
    expect(lab!.estadoActual.nivelActual).toBe("medio_alto");
    expect(lab!.planDesarrollo.objetivo6meses).toBe("Mejorar el perfil débil");
  });
});
