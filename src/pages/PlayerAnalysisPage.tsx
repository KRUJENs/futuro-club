/**
 * VITAS · Player Analysis Page
 * /player/:id/analysis/:analysisId
 *
 * Wrapper de AnalysisDashboard que añade el header con info del jugador
 * y navegación de vuelta al historial de reportes.
 *
 * Header acciones:
 *   - Volver al historial
 *   - Imprimir / PDF (window.print con CSS @media print)
 *   - Compartir (genera HMAC token + texto WhatsApp rico copiable)
 */

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Printer, Share2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PlayerService } from "@/services/real/playerService";
import { AnalysisDashboard } from "@/components/analysis/AnalysisDashboard";
import { getAuthHeaders } from "@/lib/apiAuth";

interface LoadedData {
  analysis: {
    vsi?: { vsi?: number; tier?: string; tierLabel?: string; trend?: { delta: number | null } | null } | null;
    /** «baseline-…» ⇒ análisis base: su VSI es la evaluación del entrenador. */
    video_id?: string;
  };
  reports: Array<{ report_type: string; content: Record<string, unknown> }>;
}

function buildWhatsAppText(playerName: string, data: LoadedData | null, url: string, t: TFunction): string {
  if (!data) return `${t("playerAnalysisPage.whatsappTitle", { player: playerName })}\n\n${url}`;

  const vsi = data.analysis.vsi?.vsi ?? null;
  // Análisis base: es la EVALUACIÓN DEL ENTRENADOR y su tramo único traducido (P1 bloque 5b).
  const isCoachEvaluation = typeof data.analysis.video_id === "string" && data.analysis.video_id.startsWith("baseline-");
  const tierKey = data.analysis.vsi?.tier;
  const tier = isCoachEvaluation && tierKey && (["elite", "pro", "talent", "develop"] as string[]).includes(tierKey)
    ? t(`coachEval.tier.${tierKey}`)
    : data.analysis.vsi?.tierLabel ?? "";
  const delta = data.analysis.vsi?.trend?.delta ?? null;

  const playerReport = data.reports.find((r) => r.report_type === "player-report")?.content as
    | { strengths?: Array<{ title?: string } | string>; areas_to_improve?: Array<{ title?: string } | string> } | undefined;
  const topStrength = playerReport?.strengths?.[0];
  const topArea = playerReport?.areas_to_improve?.[0];
  const strengthText = typeof topStrength === "string" ? topStrength : topStrength?.title;
  const areaText     = typeof topArea     === "string" ? topArea     : topArea?.title;

  const lines: string[] = [];
  lines.push(`🏆 *${t("playerAnalysisPage.whatsappTitle", { player: playerName })}*`);
  lines.push("");
  if (vsi !== null) {
    let vsiLine = `*${isCoachEvaluation ? t("coachEval.label") : "VSI"} ${vsi}*`;
    if (tier) vsiLine += ` · ${tier}`;
    // Sin «· P{n}»: el percentil guardado en el análisis se retiró (P1 bloque 5).
    lines.push(vsiLine);
  }
  if (delta !== null && delta !== undefined) {
    const sign = delta > 0 ? "↗ +" : delta < 0 ? "↘ " : "→ ";
    lines.push(`${sign}${t("playerAnalysisPage.whatsappDelta", { delta })}`);
  }
  lines.push("");
  if (strengthText) lines.push(`✅ ${t("playerAnalysisPage.whatsappStrength", { value: strengthText })}`);
  if (areaText)     lines.push(`⚠️ ${t("playerAnalysisPage.whatsappArea", { value: areaText })}`);
  lines.push("");
  lines.push(`📊 ${t("playerAnalysisPage.whatsappSeeFull", { url })}`);
  lines.push("");
  lines.push(`_${t("playerAnalysisPage.whatsappFooter")}_`);

  return lines.join("\n");
}

export default function PlayerAnalysisPage() {
  const { t } = useTranslation();
  const { id, analysisId } = useParams<{ id: string; analysisId: string }>();
  const navigate = useNavigate();
  const player = id ? PlayerService.getById(id) : null;
  const [sharing, setSharing] = useState(false);
  const [loaded, setLoaded] = useState<LoadedData | null>(null);

  async function handleShare() {
    if (!analysisId || sharing) return;
    setSharing(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/analyses/share?analysisId=${analysisId}`, {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error?.message ?? t("playerAnalysisPage.errorGenerateLink"));
      }
      const fullUrl = `${window.location.origin}${data.data.url}`;
      const text = buildWhatsAppText(player?.name ?? t("playerAnalysisPage.playerFallback"), loaded, fullUrl, t);

      // Web Share API primero (móvil → menú nativo + texto rico),
      // fallback a copiar el texto rico al clipboard.
      if (navigator.share) {
        try {
          await navigator.share({
            title: t("playerAnalysisPage.whatsappTitle", { player: player?.name ?? t("playerAnalysisPage.playerFallback") }),
            text,
            url: fullUrl,
          });
          toast.success(t("playerAnalysisPage.toastShared"));
          return;
        } catch {
          // user canceled · fall back to clipboard
        }
      }

      await navigator.clipboard.writeText(text);
      toast.success(t("playerAnalysisPage.toastCopied"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("playerAnalysisPage.errorShare"));
    } finally {
      setSharing(false);
    }
  }

  // Descarga el informe COMPLETO (todos los campos de cada report_type), no una
  // captura de lo que se ve en pantalla. Serializa el content real a sessionStorage
  // y abre la vista imprimible /report-full/:id (que la pestaña nueva hereda).
  function handlePrint() {
    if (!id || !loaded) return;
    try {
      sessionStorage.setItem(
        `vitas-full-reports-${id}`,
        JSON.stringify({
          playerName: player?.name ?? t("playerAnalysisPage.playerFallback"),
          playerPosition: player?.position ?? "",
          reports: loaded.reports,
        }),
      );
    } catch {
      // sessionStorage lleno/bloqueado: la pestaña mostrará "no encontrado"
    }
    const url = `/report-full/${id}`;
    const win = window.open(url, "_blank");
    if (!win) window.location.href = url;
  }

  return (
    <div className="min-h-screen bg-background pb-28">
      {/* Header sticky · oculto al imprimir */}
      <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border px-4 py-3 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/players/${id}/reports`)}
            className="p-1.5 rounded-lg hover:bg-secondary"
            aria-label={t("playerAnalysisPage.backToHistory")}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-display font-bold text-foreground truncate">
              {player?.name ?? t("playerAnalysisPage.playerFallback")}
            </h1>
            <p className="text-[10px] text-muted-foreground">{t("playerAnalysisPage.reportsSubtitle")}</p>
          </div>
          <button
            onClick={handlePrint}
            disabled={!loaded}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            aria-label={t("playerAnalysisPage.printAria")}
            title={t("playerAnalysisPage.printTitle")}
          >
            <Printer size={16} />
          </button>
          <button
            onClick={handleShare}
            disabled={sharing || !loaded}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            aria-label={t("playerAnalysisPage.shareAria")}
            title={t("playerAnalysisPage.shareTitle")}
          >
            {sharing ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
          </button>
          <FileText size={18} className="text-primary" />
        </div>
      </div>

      {/* Print-only header */}
      <div className="hidden print:block px-4 py-3 border-b border-border">
        <h1 className="text-base font-bold">{t("playerAnalysisPage.printHeader", { player: player?.name ?? t("playerAnalysisPage.playerFallback") })}</h1>
        <p className="text-xs text-muted-foreground">
          {t("playerAnalysisPage.printGenerated", { date: new Date().toLocaleDateString("es-ES") })}
        </p>
      </div>

      <div className="px-4 py-4 max-w-3xl lg:max-w-5xl mx-auto">
        {analysisId ? (
          <AnalysisDashboard
            analysisId={analysisId}
            onLoaded={(analysis, reports) => setLoaded({ analysis, reports })}
          />
        ) : (
          <div className="text-center py-16 text-sm text-muted-foreground">
            {t("playerAnalysisPage.missingAnalysisId")}
          </div>
        )}
      </div>
    </div>
  );
}
