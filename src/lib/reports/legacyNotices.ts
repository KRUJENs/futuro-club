/**
 * Avisos de INFORMES ANTIGUOS (P1 bloque 7, punto 12; decisión ya tomada: avisar, sin
 * borrar nada). Regla ÚNICA de qué informe guardado se generó con datos que hoy no se
 * aceptarían. Avisa de más, nunca de menos (mismo criterio que la 069).
 *
 * Cortes (procedencia = fusión en main de cada arreglo):
 *  - maturity_unverified: antes del #301 (2026-09-29 17:20 UTC) el orquestador pasaba a los
 *    agentes el PHV de la fila de antropometría SIN gate y lo guardaba en `analyses.phv`;
 *    un análisis con `phv` anterior al corte se generó con maduración no verificada.
 *  - baseline_pre_eval: los análisis base anteriores al #317 (2026-10-15 07:08 UTC) usaban
 *    el VSI de media simple o 0 para niños sin evaluar («VSI cacheado: 0/100»).
 *  - duel_figures: player-report < v2.4.0, development-plan < v1.3.0 y dna-profile < v1.3.0
 *    podían citar duelos ganados/perdidos (sin criterio validado; P1 bloque 6a).
 * Edge-safe: sin alias `@/`.
 */

export type LegacyNoticeCode = "maturity_unverified" | "baseline_pre_eval" | "duel_figures";

export const LEGACY_REPORT_CUTOFFS = {
  maturityUnverifiedBefore: "2026-09-30T00:00:00Z",
  baselinePreEvalBefore: "2026-10-15T12:00:00Z",
  duelFreeVersion: {
    "player-report": [2, 4, 0],
    "development-plan": [1, 3, 0],
    "dna-profile": [1, 3, 0],
  } as Record<string, readonly [number, number, number]>,
  /**
   * Informes cuyo prompt recibía la biomecánica completa (con duelos de Gemini) y NO
   * subieron de versión con el 6a (#323, fusionado 2026-10-17 23:00 UTC; corte con margen):
   * se decide por fecha de generación.
   */
  duelsByDateBefore: "2026-10-18T12:00:00Z",
  duelsByDateTypes: ["lab-biomechanics"] as readonly string[],
};

function before(iso: string | null | undefined, cutoff: string): boolean {
  const t = Date.parse(iso ?? "");
  return !Number.isFinite(t) || t < Date.parse(cutoff); // sin fecha ⇒ avisa
}

function versionOf(promptVersion: string | null | undefined): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)\s*$/.exec(promptVersion ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionBefore(a: number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export interface LegacyNoticeInput {
  analysis: { phv?: unknown; video_id?: string | null; completed_at?: string | null; created_at?: string | null };
  reports: Array<{ report_type: string; prompt_version?: string | null; generated_at?: string | null }>;
}

/** Avisos que aplican a un análisis y sus informes (sin duplicados, orden estable). */
export function legacyReportNotices(input: LegacyNoticeInput): LegacyNoticeCode[] {
  const out = new Set<LegacyNoticeCode>();
  const analysisAt = input.analysis.completed_at ?? input.analysis.created_at ?? null;
  const hasPhv = input.analysis.phv !== null && input.analysis.phv !== undefined;
  if (hasPhv && before(analysisAt, LEGACY_REPORT_CUTOFFS.maturityUnverifiedBefore)) out.add("maturity_unverified");
  if ((input.analysis.video_id ?? "").startsWith("baseline-") && before(analysisAt, LEGACY_REPORT_CUTOFFS.baselinePreEvalBefore)) {
    out.add("baseline_pre_eval");
  }
  for (const r of input.reports) {
    const pv = r.prompt_version ?? "";
    if (pv.startsWith("baseline-") || pv === "demo") continue; // base/demo nunca pidieron duelos
    if (LEGACY_REPORT_CUTOFFS.duelsByDateTypes.includes(r.report_type)) {
      if (before(r.generated_at, LEGACY_REPORT_CUTOFFS.duelsByDateBefore)) out.add("duel_figures");
      continue;
    }
    const min = LEGACY_REPORT_CUTOFFS.duelFreeVersion[r.report_type];
    if (!min) continue;
    const v = versionOf(pv);
    if (!v || versionBefore(v, min)) out.add("duel_figures");
  }
  return (["maturity_unverified", "baseline_pre_eval", "duel_figures"] as const).filter((c) => out.has(c));
}
