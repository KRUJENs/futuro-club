import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { POSITION_CODES, POSITION_LABELS, type PositionCode } from "@/lib/roleProfileData";

// ─── Schema ──────────────────────────────────────────────────────────────

const FilterSchema = z.object({
  currentPosition: z.enum(["all", ...POSITION_CODES] as [string, ...string[]]),
  dimension: z.enum(["all", "tactical", "technical", "physical"]),
  phase: z.enum(["all", "in_possession", "out_of_possession", "transition"]),
});

export type RoleProfileFilters = z.infer<typeof FilterSchema>;

const DEFAULTS: RoleProfileFilters = {
  currentPosition: "all",
  dimension: "all",
  phase: "all",
};

interface Props {
  onChange: (filters: RoleProfileFilters) => void;
  defaults?: Partial<RoleProfileFilters>;
}

export default function RoleProfileFilterBar({ onChange, defaults }: Props) {
  const { t } = useTranslation();
  const { control, watch } = useForm<RoleProfileFilters>({
    resolver: zodResolver(FilterSchema),
    defaultValues: { ...DEFAULTS, ...defaults },
  });

  // React to every change
  const values = watch();

  // Emit validated filters on every change
  const handleChange = () => {
    const parsed = FilterSchema.safeParse(values);
    if (parsed.success) onChange(parsed.data);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-card border border-border rounded-lg">
      {/* Sin selector de horizonte (0-6 / 6-18 / 18-36 meses) ni interruptor «Proyectado»:
          las proyecciones están bloqueadas (P1 bloque 5c, ProjectionGateCard). */}

      {/* Current position */}
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("roleProfileFilterBar.position")}</Label>
        <Controller
          control={control}
          name="currentPosition"
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { field.onChange(v); handleChange(); }}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("roleProfileFilterBar.all")}</SelectItem>
                {POSITION_CODES.map(code => (
                  <SelectItem key={code} value={code}>{code} — {POSITION_LABELS[code]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Dimension */}
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("roleProfileFilterBar.dimension")}</Label>
        <Controller
          control={control}
          name="dimension"
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { field.onChange(v); handleChange(); }}>
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("roleProfileFilterBar.all")}</SelectItem>
                <SelectItem value="tactical">{t("roleProfileFilterBar.dimensionTactical")}</SelectItem>
                <SelectItem value="technical">{t("roleProfileFilterBar.dimensionTechnical")}</SelectItem>
                <SelectItem value="physical">{t("roleProfileFilterBar.dimensionPhysical")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Phase */}
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("roleProfileFilterBar.phase")}</Label>
        <Controller
          control={control}
          name="phase"
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { field.onChange(v); handleChange(); }}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("roleProfileFilterBar.all")}</SelectItem>
                <SelectItem value="in_possession">{t("roleProfileFilterBar.phaseInPossession")}</SelectItem>
                <SelectItem value="out_of_possession">{t("roleProfileFilterBar.phaseOutOfPossession")}</SelectItem>
                <SelectItem value="transition">{t("roleProfileFilterBar.phaseTransition")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>
    </div>
  );
}
