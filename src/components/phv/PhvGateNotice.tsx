/**
 * VITAS · PhvGateNotice — ÚNICO componente que pinta el motivo por el que una
 * superficie NO muestra PHV (regla del owner 28-sep: sin todas las entradas
 * introducidas, no hay PHV).
 *
 * Traduce el resultado del gate único (src/lib/phv/phvGate.ts) a texto en el
 * idioma de la UI: «PHV no disponible · Falta: talla sentado, longitud de pierna».
 * Nunca pinta una etiqueta de maduración, un 0, un guion ni un placeholder: el
 * hueco se nombra (invariante #2). Se usa en la ficha, la impresión, la lista del
 * equipo, el comparador, Rankings y el formulario de medidas.
 */
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { phvInputI18nKey, type PhvGate, type PhvGateCode, type PhvInputKey } from "@/lib/phv/phvGate";

/** + «medición calculada con otro sexo» (P1 bloque 7, src/lib/shared/sexGatedAnthro.ts). */
type NoticeCode = PhvGateCode | "sex_mismatch";

interface Props {
  /** Resultado del gate (o, para filas persistidas, code + missing). */
  gate?: PhvGate | null;
  code?: NoticeCode | null;
  missing?: readonly PhvInputKey[];
  /** inline = texto compacto (listas, chips); card = bloque con icono. */
  variant?: "inline" | "card";
  /** Sin el prefijo «PHV no disponible» (cuando el contenedor ya lo dice). */
  bare?: boolean;
  /** «M» guardado sin confirmar (P1 bloque 7): el sexo que falta se rotula «por confirmar». */
  sexPending?: boolean;
  className?: string;
}

/** Texto traducido del motivo del gate (reutilizable fuera de JSX, p.ej. `title`). */
export function usePhvGateText() {
  const { t } = useTranslation();
  return (opts: { gate?: PhvGate | null; code?: NoticeCode | null; missing?: readonly PhvInputKey[]; bare?: boolean; sexPending?: boolean }) => {
    const code: NoticeCode | null = opts.gate ? opts.gate.reason : opts.code ?? null;
    const missing = opts.gate ? opts.gate.missing : opts.missing ?? [];
    let reason: string;
    if (code === "missing_inputs" && missing.length > 0) {
      reason = t("maturity.gate.missing", { list: missing
          .map((k) => (k === "sex" && opts.sexPending ? t("maturity.sexPending") : t(phvInputI18nKey(k))))
          .join(", ") });
    } else if (code === "sex_mismatch") {
      reason = t("maturity.sexMismatch");
    } else if (code === "out_of_range") {
      reason = t("maturity.gate.outOfRange");
    } else if (code === "legacy_row") {
      reason = t("maturity.gate.legacyRow");
    } else if (code === "no_row") {
      reason = t("maturity.gate.noRow");
    } else {
      reason = t("maturity.gate.notComputed");
    }
    return opts.bare ? reason : `${t("maturity.gate.unavailable")} · ${reason}`;
  };
}

export function PhvGateNotice({ gate, code, missing, variant = "inline", bare, sexPending, className }: Props) {
  const text = usePhvGateText()({ gate, code, missing, bare, sexPending });
  if (variant === "card") {
    return (
      <div
        role="note"
        data-testid="phv-gate-notice"
        className={cn(
          "rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-muted-foreground flex items-start gap-2",
          className,
        )}
      >
        <Info className="size-3.5 shrink-0 mt-0.5 text-amber-500" />
        <span>{text}</span>
      </div>
    );
  }
  return (
    <span data-testid="phv-gate-notice" className={cn("italic text-muted-foreground", className)}>
      {text}
    </span>
  );
}
