/**
 * Búsqueda en lenguaje natural de Rankings (P2 bloque 11). La IA solo traduce la frase a
 * filtros (src/lib/search/nlRankingFilters.ts, ruta /api/rankings/nl-filters); la lista la
 * saca el filtrado de siempre sobre los jugadores reales. Se enseña qué se interpretó
 * (rotulado «Estimado por IA») y qué no se entendió; nunca se rellena lo no entendido.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import { getAuthHeaders } from "@/lib/apiAuth";
import { NL_QUERY_MAX_CHARS, type NlParseResult, type NlRankingFilters } from "@/lib/search/nlRankingFilters";
import { maturityTimingKey } from "@/lib/phv/playerMaturity";

type ErrorKey = "unavailable" | "error" | "limit";

/**
 * `active` = los filtros actuales siguen siendo los que puso la búsqueda (el padre lo
 * decide): si el usuario los cambia o los limpia, la interpretación deja de enseñarse.
 * `filtersKey` cambia con cualquier filtro: borra el aviso de «nada entendido».
 */
export function NlSearchBox({
  onApply,
  active,
  filtersKey,
}: {
  onApply: (filters: NlRankingFilters) => void;
  active: boolean;
  filtersKey: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  // Última interpretación APLICADA (sus chips) y último intento sin nada entendido (aviso).
  const [result, setResult] = useState<NlParseResult | null>(null);
  const [notice, setNotice] = useState<NlParseResult | null>(null);
  useEffect(() => setNotice(null), [filtersKey]);
  const [error, setError] = useState<ErrorKey | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rankings/nl-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        setNotice(null);
        setError(res.status === 503 ? "unavailable" : res.status === 429 ? "limit" : "error");
        return;
      }
      const body = (await res.json()) as { data?: NlParseResult } & NlParseResult;
      const parsed = body.data ?? body;
      // Nada entendido ⇒ no se toca ningún filtro (si no, la lista completa con su podio
      // parecería la respuesta a «los más rápidos»); la interpretación anterior sigue vigente.
      if (Object.keys(parsed.filters).length > 0) {
        setNotice(null);
        setResult(parsed);
        onApply(parsed.filters);
      } else {
        setNotice(parsed);
      }
    } catch {
      setNotice(null);
      setError("error");
    } finally {
      setLoading(false);
    }
  };

  const chips: string[] = [];
  if (result?.filters.position) chips.push(result.filters.position);
  if (result?.filters.foot) chips.push(t(`rankingsNl.foot.${result.filters.foot}`));
  if (result?.filters.timing) chips.push(t(maturityTimingKey(result.filters.timing)));
  if (result?.filters.ageGroup) chips.push(result.filters.ageGroup);

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={query}
          maxLength={NL_QUERY_MAX_CHARS}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("rankingsNl.placeholder")}
          aria-label={t("rankingsNl.placeholder")}
          className="h-9 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={loading || !query.trim()} className="gap-1.5 shrink-0">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {t("rankingsNl.button")}
        </Button>
      </form>

      {error && <p className="text-xs text-muted-foreground italic">{t(`rankingsNl.${error}`)}</p>}

      {notice && (
        <p className="text-xs text-muted-foreground italic">
          {t("rankingsNl.nothingApplied")}
          {notice.not_understood.length > 0 && ` ${t("rankingsNl.notUnderstood")} ${notice.not_understood.join(" · ")}`}
        </p>
      )}

      {result && active && (
        <div className="text-[11px] space-y-1">
          <p className="flex items-center gap-1.5 flex-wrap">
            <span className="text-muted-foreground">{t("rankingsNl.interpreted")}</span>
            {chips.length > 0 ? (
              chips.map((c) => (
                <span key={c} className="rounded-full bg-secondary/50 px-2 py-0.5">{c}</span>
              ))
            ) : (
              <span className="italic text-muted-foreground">{t("rankingsNl.nothing")}</span>
            )}
            <ProvenanceBadge provenance="ESTIMADA_LLM" />
          </p>
          {result.not_understood.length > 0 && (
            <p className="text-muted-foreground">
              {t("rankingsNl.notUnderstood")} {result.not_understood.join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
