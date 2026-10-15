import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RoleProfileData } from "@/lib/roleProfileData";
import { Brain, Crosshair, Zap } from "lucide-react";
import type { RoleProfileFilters } from "@/components/role-profile/RoleProfileFilterBar";
import { ProvenanceBadge } from "@/components/metrics/MetricValue";
import { useTranslation } from "react-i18next";

interface Props {
  data: RoleProfileData;
  filters?: RoleProfileFilters | null;
}

const DIMS = [
  { key: "tactical" as const, icon: Brain },
  { key: "technical" as const, icon: Crosshair },
  { key: "physical" as const, icon: Zap },
];

/**
 * Nivel ACTUAL estimado por dimensión (táctica, técnica, física) del perfil de rol.
 *
 * P1 bloque 5c: solo el valor actual con su procedencia (ESTIMADA_LLM: lo estima el agente
 * a partir de los vídeos analizados y la evaluación del entrenador). Antes:
 *  - una «confianza» FIJA por dimensión (0,78 / 0,80 / 0,55) presentada como estimación,
 *    y un margen «± n» calculado desde esa constante (MetricWithInterval);
 *  - filas de proyección a 0-6 / 6-18 / 18-36 meses = el nivel actual + un porcentaje fijo
 *    (el filtro de horizonte ni se aplicaba: `|| true`). Bloqueadas: ProjectionGateCard.
 */
export default function CapabilityCards({ data, filters }: Props) {
  const { t } = useTranslation();
  const { current } = data;

  const dimMeta: Record<(typeof DIMS)[number]["key"], { label: string; description: string }> = {
    tactical: { label: t("capabilityCards.tacticalLabel"), description: t("capabilityCards.tacticalDescription") },
    technical: { label: t("capabilityCards.technicalLabel"), description: t("capabilityCards.technicalDescription") },
    physical: { label: t("capabilityCards.physicalLabel"), description: t("capabilityCards.physicalDescription") },
  };

  const activeDims = filters?.dimension && filters.dimension !== "all"
    ? DIMS.filter(d => d.key === filters.dimension)
    : DIMS;

  return (
    <div className="space-y-2">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {activeDims.map(({ key, icon: Icon }) => {
        const { label, description } = dimMeta[key];

        return (
          <Card key={key} className="border-border bg-card">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-display flex items-center gap-2">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  {label}
                </CardTitle>
                <ProvenanceBadge provenance="ESTIMADA_LLM" />
              </div>
              <p className="text-xs text-muted-foreground">{description}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-xs text-muted-foreground">{t("capabilityCards.current")}</span>
                  <span className="font-display font-bold text-2xl tabular-nums">{current[key].toFixed(1)}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full" style={{ width: `${current[key]}%` }} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
      <p className="text-[10px] text-muted-foreground/70 leading-snug px-1">
        {t("capabilityCards.legend")}
      </p>
    </div>
  );
}
