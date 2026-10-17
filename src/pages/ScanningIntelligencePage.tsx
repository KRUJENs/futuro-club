/**
 * VITAS · Scanning Intelligence Page
 * /scanning
 *
 * Escaneo previo a la recepción del balón. P1 bloque 6b (punto 9):
 *   - FUERA del demo: Scan IQ BLOQUEADO con su motivo (src/lib/dmscore/scanIQ.ts). No hay
 *     ranking, ni media de equipo, ni informe: no hay detector de recepciones ni identidad
 *     del jugador, ni una base por edad con fuente.
 *   - En el DEMO: el ejemplo FIJO (MOCK, el mismo para todos los jugadores) con banner.
 * Antes: un ranking con un «Scan IQ» derivado del id del jugador (hash), medias y
 * «jugadores élite» sobre esos valores, y el Scan IQ «calibrado por edad» con 14 años por
 * defecto.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Eye, Cpu, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { PlayerService, type Player } from "@/services/real/playerService";
import ScanningIntelligenceReport from "@/components/behavioral/ScanningIntelligenceReport";
import { ScanIQCard } from "@/components/dmscore/ScanIQCard";
import { scanIQDemoExample, scanIQMetric } from "@/lib/dmscore";
import ScanningAnalyzerDialog from "@/components/behavioral/ScanningAnalyzerDialog";
import DemoDataBanner from "@/components/DemoDataBanner";
import { IS_DEMO } from "@/lib/demoMode";
import { ScanningVideoAnalyses } from "@/services/real/scanningVideoDetector";

export default function ScanningIntelligencePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [players, setPlayers] = useState<Player[]>([]);
  const [analyzerOpen, setAnalyzerOpen] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setPlayers(PlayerService.getAll());
  }, []);

  // Solo en el demo: jugadores con el ejemplo cargado (nada derivado del id).
  const withExample = useMemo(() => {
    void version;
    if (!IS_DEMO) return [];
    return players.filter((p) => ScanningVideoAnalyses.getLatestForPlayer(p.id) !== null);
  }, [players, version]);

  const focusId = searchParams.get("playerId");
  const focus = useMemo(
    () => players.find((p) => p.id === focusId) ?? withExample[0] ?? players[0] ?? null,
    [players, withExample, focusId],
  );
  const focusHasExample = Boolean(focus && withExample.some((p) => p.id === focus.id));

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-30 glass-strong border-b border-border">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-pink-500 to-fuchsia-600 flex items-center justify-center shrink-0">
            <Eye size={18} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-base text-foreground">Scanning</h1>
            <p className="text-[11px] text-muted-foreground">{t("scanningIntelligencePage.headerSubtitle")}</p>
          </div>
          {IS_DEMO && (
            <>
              <button
                onClick={() => {
                  if (!focus) {
                    toast.error(t("scanningIntelligencePage.createPlayerFirst"));
                    return;
                  }
                  ScanningVideoAnalyses.seedDemo(focus.id, focus.name);
                  setVersion((v) => v + 1);
                  toast.success(t("scanningIntelligencePage.demoLoaded", { name: focus.name }));
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-pink-500/40 text-pink-600 text-xs font-display font-semibold hover:bg-pink-500/10 transition-all"
                title={t("scanningIntelligencePage.demoButtonTitle")}
              >
                <Wand2 size={14} />
                {t("scanningIntelligencePage.demoData")}
              </button>
              <button
                onClick={() => setAnalyzerOpen(true)}
                disabled={!focus}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white text-xs font-display font-semibold hover:opacity-90 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                title={t("scanningIntelligencePage.analyzeVideoTitle")}
              >
                <Cpu size={14} />
                {t("scanningIntelligencePage.analyzeVideo")}
              </button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {!IS_DEMO ? (
          // Fuera del demo: bloqueado con su motivo (inv #2). Ningún valor por jugador.
          <div className="space-y-4" data-testid="scanning-gated">
            <ScanIQCard metric={scanIQMetric()} />
            <p className="text-[11px] text-muted-foreground">{t("scanningIntelligencePage.gateUnlock")}</p>
          </div>
        ) : players.length === 0 ? (
          <div className="glass rounded-2xl p-8 text-center max-w-2xl mx-auto border border-dashed border-border space-y-3">
            <h2 className="text-lg font-display font-bold text-foreground">{t("scanningIntelligencePage.emptyTitle")}</h2>
            <button
              onClick={() => navigate("/players/new")}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-pink-500 to-fuchsia-600 text-white text-xs font-display font-semibold"
            >
              {t("scanningIntelligencePage.createFirstPlayer")}
            </button>
          </div>
        ) : (
          <>
            {/* Demo: ejemplo FIJO (MOCK), el mismo para todos los jugadores. */}
            <DemoDataBanner messageKey="scanningIntelligencePage.demoNotice" />
            <div className="grid grid-cols-1 lg:grid-cols-[240px,1fr] gap-4">
              <aside className="space-y-1.5">
                {players.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSearchParams({ playerId: p.id }, { replace: true })}
                    className={`w-full p-2 rounded-lg text-left border text-[12px] font-display font-bold transition-all ${
                      focus?.id === p.id ? "border-pink-500 bg-pink-500/10 text-foreground" : "border-border bg-secondary/30 text-foreground hover:border-pink-500/40"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </aside>
              <section className="space-y-4">
                {focus && focusHasExample ? (
                  <>
                    <ScanIQCard metric={scanIQDemoExample()} />
                    <div className="glass rounded-2xl p-4">
                      <ScanningIntelligenceReport playerId={focus.id} playerName={focus.name} />
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("scanningIntelligencePage.demoHint")}</p>
                )}
              </section>
            </div>
          </>
        )}
      </main>

      {IS_DEMO && focus && (
        <ScanningAnalyzerDialog
          open={analyzerOpen}
          onClose={() => setAnalyzerOpen(false)}
          playerId={focus.id}
          playerName={focus.name}
          onCompleted={() => setVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
