/**
 * Señal de sesgo por edad relativa de la plantilla (P2 bloque 8). Cálculo único en
 * src/lib/shared/relativeAgeBias.ts; aquí solo se pinta. Sin jugadores suficientes con fecha
 * se enseña el motivo y la cobertura, nunca el reparto (con pocos niños no dice nada).
 * Señal, no veredicto: no corrige ni puntúa a nadie.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CalendarRange } from "lucide-react";
import { squadRelativeAge } from "@/lib/shared/relativeAgeBias";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";

export function RelativeAgeCard({ birthDates }: { birthDates: ReadonlyArray<unknown> }) {
  const { t } = useTranslation();
  const rae = useMemo(() => squadRelativeAge(birthDates), [birthDates]);
  const signal = rae.signal.value;
  const max = signal ? Math.max(...signal.counts, 1) : 1;

  return (
    <section className="rounded-2xl border border-border bg-card p-4 space-y-3" aria-labelledby="rae-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="rae-title" className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <CalendarRange size={13} /> {t("relativeAge.title")}
        </h2>
        {/* Con el corte bloqueado nadie tiene trimestre: la cobertura «0 de N» sería falsa. */}
        {rae.gate_code !== "cutoff_unavailable" && (
          <span className="text-[11px] text-muted-foreground">
            {t("relativeAge.coverage", { dated: rae.dated, total: rae.total })}
          </span>
        )}
      </div>

      {signal === null ? (
        <p className="text-xs text-muted-foreground italic">
          {t(`relativeAge.gate.${rae.gate_code ?? "insufficient_dated_players"}`, { dated: rae.dated, min: rae.min_dated })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2" role="list">
            {signal.counts.map((n, i) => (
              <div key={i} role="listitem" className="flex flex-col items-center gap-1">
                <div className="h-16 w-full rounded-md bg-secondary/40 flex items-end overflow-hidden">
                  <div className="w-full bg-primary/60" style={{ height: `${(n / max) * 100}%` }} />
                </div>
                <span className="text-[11px] font-mono tabular-nums">{n}</span>
                <span className="text-[10px] text-muted-foreground">{t("relativeAge.quarter", { q: i + 1 })}</span>
              </div>
            ))}
          </div>
          <p className="text-xs flex items-center gap-1.5 flex-wrap">
            <span>{t(`relativeAge.signal.${signal.direction}`)}</span>
            <ProvenanceBadge provenance={rae.signal.provenance} />
            {/* Sin cifra: la confianza es la constante orientativa, no una probabilidad medida. */}
            <span className="text-[10px] text-muted-foreground">{t("relativeAge.confidence")}</span>
          </p>
        </>
      )}

      <p className="text-[10px] text-muted-foreground leading-relaxed">{t("relativeAge.note")}</p>
    </section>
  );
}
