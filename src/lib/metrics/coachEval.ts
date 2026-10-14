/**
 * VITAS · Rótulo en línea de la EVALUACIÓN DEL ENTRENADOR (VSI de ficha) — P1 bloque 5b.
 *
 * Una sola forma de escribir la evaluación en chips y listas: «Eval. entrenador 72» o,
 * sin evaluar, «Eval. entrenador: Sin evaluar». Antes cada pantalla escribía «VSI 72»
 * y un «—» para el hueco (la regla de presentación prohíbe el guion: `value === null`
 * se nombra). El VSI de ficha son 6 barras SUBJETIVAS del entrenador, no una puntuación
 * del sistema: por eso el rótulo dice de quién es.
 */
import type { TFunction } from "i18next";

export function coachEvalInline(t: TFunction, vsi: number | null | undefined, digits = 0): string {
  const label = t("coachEval.short");
  return typeof vsi === "number" && Number.isFinite(vsi)
    ? `${label} ${vsi.toFixed(digits)}`
    : `${label}: ${t("common.notEvaluated")}`;
}
