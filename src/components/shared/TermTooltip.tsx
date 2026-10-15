/**
 * VITAS · TermTooltip (Sprint 4.4)
 *
 * Envuelve un término de dominio (VSI, PHV, ACWR…) y muestra su definición del
 * glosario al hacer hover / focus. Accesible por teclado (Radix). Si la clave no
 * existe en el glosario, renderiza el contenido tal cual (fail-safe, sin adorno).
 */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { GLOSSARY } from "@/lib/metrics/glossary";

interface TermTooltipProps {
  /** clave del glosario: "vsi" | "phv" | "vaep" | "acwr" | "scaniq" | "dmscore" */
  termKey: string;
  children?: React.ReactNode;
  className?: string;
}

export function TermTooltip({ termKey, children, className }: TermTooltipProps) {
  const { t: tr } = useTranslation();
  const g = GLOSSARY[termKey];
  if (!g) return <>{children ?? termKey}</>;
  // Términos con traducción (p. ej. la evaluación del entrenador): 7 idiomas; el resto,
  // el texto del glosario (solo español, deuda conocida).
  const t = g.i18nKey
    ? {
        term: tr(`${g.i18nKey}.term`, { defaultValue: g.term }),
        short: tr(`${g.i18nKey}.short`, { defaultValue: g.short }),
        long: tr(`${g.i18nKey}.long`, { defaultValue: g.long }),
      }
    : g;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={
              "underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 cursor-help outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm " +
              (className ?? "")
            }
          >
            {children ?? t.term}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[240px] py-2">
          <p className="font-semibold text-xs">
            {t.term} · <span className="text-muted-foreground">{t.short}</span>
          </p>
          <p className="text-[11px] leading-snug text-muted-foreground mt-1">
            {t.long}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default TermTooltip;
