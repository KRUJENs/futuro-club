import { Badge } from "@/components/ui/badge";
import { RoleProfileData, getConfidenceLabel, getConfidenceColor, getSampleTierLabel, getSampleTierColor } from "@/lib/roleProfileData";
import { Shield, Clock, Footprints, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  data: RoleProfileData;
}

export default function PlayerHeader({ data }: Props) {
  const { t } = useTranslation();
  const confColor = getConfidenceColor(data.overall_confidence);
  const tierColor = getSampleTierColor(data.sample_tier);

  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-border">
      {/* Left: Name + meta */}
      <div className="space-y-2">
        <h1 className="font-display text-4xl font-bold tracking-tight">{data.player_name}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {t("rpPlayerHeader.age", { count: data.player_age })}
          </span>
          {/* Pie y nivel solo si se registraron (nunca un valor por defecto). */}
          {data.dominant_foot && (
            <span className="flex items-center gap-1.5">
              <Footprints className="w-3.5 h-3.5" />
              {t("rpPlayerHeader.foot", { foot: data.dominant_foot })}
            </span>
          )}
          {data.competitive_level && (
            <span className="flex items-center gap-1.5">
              <Trophy className="w-3.5 h-3.5" />
              {data.competitive_level}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {t("rpPlayerHeader.minutesPlayed", { count: data.minutes_played })}
          </span>
        </div>
      </div>

      {/* Right: Confidence + sample tier */}
      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{t("rpPlayerHeader.sample")}</p>
          <p className={`text-sm font-medium ${tierColor}`}>
            {getSampleTierLabel(data.sample_tier)}
          </p>
        </div>
        <div className="w-px h-10 bg-border" />
        <div className="text-right">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{t("rpPlayerHeader.overallConfidence")}</p>
          <div className="flex items-center gap-2">
            <Shield className={`w-4 h-4 ${confColor}`} />
            <span className={`text-lg font-display font-bold ${confColor}`}>
              {Math.round(data.overall_confidence * 100)}%
            </span>
            <span className={`text-xs ${confColor}`}>
              {getConfidenceLabel(data.overall_confidence)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
