/**
 * Bio-banding automático de la plantilla por % de talla adulta (P2 bloque 9, D10).
 * Cálculo único en src/lib/phv/squadBioBanding.ts (pahGate + bandas Cumming 2017); aquí
 * solo se pinta. Se rotula por el % de la talla adulta, NUNCA como fase PHV (esa es la de
 * Mirwald, phvGate.ts: el mismo niño no puede ser «En PHV» en la lista y «Pre-PHV» aquí). Quien no tiene todas las entradas del %PAH (alturas de los padres, sexo
 * registrado…) sale como «sin banda» con lo que falta: nunca se le asigna una banda.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { squadBioBands, BIO_BAND_ORDER, BIO_BAND_THRESHOLDS } from "@/lib/phv/squadBioBanding";
import type { PahInputKey, PhvGateInput } from "@/lib/phv/phvGate";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";

type BandablePlayer = PhvGateInput & { id?: string; name?: string; sexConfirmedAt?: unknown };

const MAX_NAMES = 8;

export function BioBandingCard({ players }: { players: ReadonlyArray<BandablePlayer> }) {
  const { t } = useTranslation();
  const result = useMemo(() => squadBioBands(players), [players]);
  const missingCounts = useMemo(() => {
    const counts = new Map<PahInputKey | "out_of_range", number>();
    for (const u of result.unbanded) {
      const keys: Array<PahInputKey | "out_of_range"> = u.missing.length > 0 ? u.missing : ["out_of_range"];
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [result]);
  const banded = BIO_BAND_ORDER.reduce((n, b) => n + result.bands[b].length, 0);
  const firstBanded = BIO_BAND_ORDER.map((b) => result.bands[b][0]).find(Boolean);

  return (
    <section className="rounded-2xl border border-border bg-card p-4 space-y-3" aria-labelledby="bioband-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="bioband-title" className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Layers size={13} /> {t("bioBanding.title")}
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {t("bioBanding.coverage", { banded, total: players.length })}
        </span>
      </div>

      {banded > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {BIO_BAND_ORDER.map((band) => {
            const members = result.bands[band];
            return (
              <div key={band} className="rounded-xl bg-secondary/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold">
                    {t(`bioBanding.band.${band}`, { pre: BIO_BAND_THRESHOLDS.prePhvMax, post: BIO_BAND_THRESHOLDS.postPhvMin })}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums">{members.length}</span>
                </div>
                {members.length > 0 && (
                  <ul className="text-[11px] text-muted-foreground space-y-0.5">
                    {members.slice(0, MAX_NAMES).map((m, i) => (
                      <li key={m.player.id ?? i} className="flex items-center justify-between gap-1">
                        <span className="truncate">{m.player.name}</span>
                        <span className="tabular-nums">{m.percent.value} %</span>
                      </li>
                    ))}
                    {members.length > MAX_NAMES && <li>{t("bioBanding.more", { count: members.length - MAX_NAMES })}</li>}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {firstBanded && (
        <p className="text-[11px] flex items-center gap-1.5">
          <span className="text-muted-foreground">{t("bioBanding.percentLabel")}</span>
          <ProvenanceBadge provenance={firstBanded.percent.provenance} />
        </p>
      )}

      {result.unbanded.length > 0 && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          <p className="italic">{t("bioBanding.unbanded", { count: result.unbanded.length })}</p>
          <ul className="list-disc pl-4">
            {missingCounts.map(([key, n]) => (
              <li key={key}>{t(`bioBanding.missing.${key}`, { count: n })}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground leading-relaxed">{t("bioBanding.note")}</p>
    </section>
  );
}
