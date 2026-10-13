import { type AnalysisV2Result, mapDbRowToLegacy } from "@/hooks/usePlayerAnalysisV2";
import type { AnalysisReport } from "./types";

// ── Bridge: mapea V2 reports al shape legacy que usa el panel de resultados ──
// UNA sola implementación del mapeo (inv #7): la misma que el Histórico
// (mapDbRowToLegacy). Antes esta era una segunda copia que seguía rellenando con
// textos de relleno —«Análisis completado · pipeline GPU + MediaPipe.», nivel
// «TALENT», «Determinado y competitivo», objetivos genéricos a 6/18 meses,
// proyección «Semi-pro»/«Amateur alto»— y leía el comparable de un campo que el
// narrador no emite (P1 bloque 2, inv #2).
export function mapV2ToReport(result: AnalysisV2Result): AnalysisReport | null {
  if (!result.reports || result.reports.length === 0) return null;
  const { report } = mapDbRowToLegacy({
    id: result.analysisId ?? "",
    player_id: "",
    video_id: result.videoId ?? "",
    created_at: result.completedAt ?? "",
    vsi: result.vsi as Record<string, unknown> | null,
    reports: result.reports,
  });
  return report as unknown as AnalysisReport | null;
}
