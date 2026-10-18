/**
 * Pestaña «Proyección» del panel de análisis — BLOQUEADA (P1 bloque 7, decisión del
 * dueño D2). Antes pintaba escenarios con nivel futuro, factores, riesgos y una curva de
 * VSI a 3 años con incrementos fijos (+4/+9/+12, una CONSTANTE pintada como resultado).
 * No hay un modelo validado que prediga el nivel futuro de un jugador en formación: se
 * pinta el motivo, también para informes antiguos guardados (src/lib/reports/careerProjection.ts).
 */
import { useTranslation } from "react-i18next";

export default function ProjectionReportView(_props: { report: Record<string, unknown> }) {
  const { t } = useTranslation();
  return <p className="text-xs text-muted-foreground">{t("careerProjection.blocked")}</p>;
}
