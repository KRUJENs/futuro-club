/**
 * VITAS · Proyección del perfil de rol — BLOQUEADA (P1 bloque 5c, decisión del dueño 15 oct).
 *
 * Antes (ProjectionComparator) pintaba el nivel a 0-6 / 6-18 / 18-36 meses, la «mejor
 * posición a 18 meses» con pesos fijos 0,3/0,4/0,3 y un «insight» de texto fijo («la mayor
 * evolución esperada es en el eje físico…»). Esas cifras eran el nivel actual + un
 * porcentaje fijo (regla del prompt o del respaldo): no hay base validada para proyectar.
 * Un hueco visible con su motivo es el resultado correcto (invariante #2): ninguna cifra.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function ProjectionGateCard() {
  const { t } = useTranslation();
  return (
    <Card className="border-border bg-card" data-testid="projection-gate">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-display flex items-center gap-2">
          <TrendingUp className="w-4 h-4" />
          {t("roleProjection.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground italic">{t("roleProjection.gateReason")}</p>
      </CardContent>
    </Card>
  );
}
