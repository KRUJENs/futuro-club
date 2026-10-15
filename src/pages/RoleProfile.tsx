import { useState, useCallback, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { toast } from "sonner";

import PlayerHeader from "@/components/role-profile/PlayerHeader";
import IdentityCard from "@/components/role-profile/IdentityCard";
import CapabilityCards from "@/components/role-profile/CapabilityCards";
import PositionFitRanking from "@/components/role-profile/PositionFitRanking";
import ArchetypeRanking from "@/components/role-profile/ArchetypeRanking";
import StrengthsRisksPanel from "@/components/role-profile/StrengthsRisksPanel";
import ProjectionGateCard from "@/components/role-profile/ProjectionGateCard";
import RoleProfileFilterBar, { type RoleProfileFilters } from "@/components/role-profile/RoleProfileFilterBar";
import EmptyState from "@/components/role-profile/EmptyState";
import { PlayerHeaderSkeleton, IdentityCardSkeleton, CapabilityCardsSkeleton, PositionFitSkeleton } from "@/components/role-profile/Skeletons";
import { useRoleProfile } from "@/hooks/useRoleProfile";
import TrackingSnapshotPanel from "@/components/TrackingSnapshotPanel";
import { PlayerTrackingService, type TrackingSnapshot } from "@/services/real/playerTrackingService";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Table2, Zap, MapPin } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { POSITION_CODES, POSITION_LABELS, type PositionCode } from "@/lib/roleProfileData";

export default function RoleProfile() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [filters, setFilters] = useState<RoleProfileFilters | null>(null);
  const [positionOverride, setPositionOverride] = useState<string | null>(null);
  const [trackingSnapshot, setTrackingSnapshot] = useState<TrackingSnapshot | null>(null);
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useRoleProfile(id, positionOverride);

  // Snapshot del Lab (escaneos, duelos, distancia)
  useEffect(() => {
    if (!id) return;
    setTrackingSnapshot(PlayerTrackingService.get(id));
    const onFocus = () => id && setTrackingSnapshot(PlayerTrackingService.get(id));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [id]);

  const handleFilterChange = useCallback((f: RoleProfileFilters) => {
    setFilters(f);
  }, []);

  useEffect(() => {
    if (isError) toast.error(t("toasts.roleProfileError", { error: error?.message || t("errors.unknownError") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError, error]);

  return (
    <div className="min-h-screen bg-background">
      
      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{t("roleProfile.subtitle")}</p>
            <h2 className="font-display text-2xl font-bold">{t("roleProfile.title")}</h2>
          </div>
          <div className="flex items-center gap-3">
            {/* Sin «Comparar» (comparaba horizontes de proyección) ni el conmutador
                Scout/Analista (solo decidía si se veía la proyección): bloqueadas, P1 bloque 5c. */}
            <Link to={`/players/${id}/role-profile/audit`}>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                <Table2 className="w-3.5 h-3.5" />
                {t("common.audit")}
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => {
                if (!data) {
                  toast.error(t("roleProfilePage.noProfileToExport"));
                  return;
                }
                // Exporta JSON con todo el perfil · sirve para coach + dev
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `role-profile-${id ?? "player"}-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success(t("roleProfilePage.profileExported"));
              }}
            >
              <FileText className="w-3.5 h-3.5" />
              {t("common.export")}
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <RoleProfileFilterBar onChange={handleFilterChange} />

        {/* Loading state */}
        {isLoading && (
          <>
            <PlayerHeaderSkeleton />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <IdentityCardSkeleton />
              <div className="lg:col-span-2"><CapabilityCardsSkeleton /></div>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <PositionFitSkeleton />
              <PositionFitSkeleton />
            </div>
          </>
        )}

        {/* Error / empty state */}
        {isError && (
          <EmptyState type="no-data" onAction={() => refetch()} actionLabel={t("roleProfile.retryLoad")} />
        )}

        {/* No data at all (shouldn't happen with metrics-only fallback, but safety net) */}
        {!isLoading && !isError && data === null && (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Zap className="w-7 h-7 text-primary" />
            </div>
            <h3 className="font-display text-lg font-bold mb-2">
              {t("roleProfilePage.cannotGenerateProfile")}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mb-4 leading-relaxed">
              {t("roleProfilePage.verifyPlayerMetrics")}
            </p>
            <div className="flex gap-3">
              <Button variant="default" size="sm" className="gap-1.5" onClick={() => refetch()}>
                {t("roleProfilePage.retry")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.history.back()}>
                {t("roleProfilePage.goBack")}
              </Button>
            </div>
          </div>
        )}

        {/* Data loaded */}
        {data && (
          <>
            <PlayerHeader data={data} />

            {/* Confidence tier badge + Position override */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                  data.sample_tier === "platinum" ? "bg-purple-100 text-purple-700" :
                  data.sample_tier === "gold" ? "bg-yellow-100 text-yellow-700" :
                  data.sample_tier === "silver" ? "bg-gray-100 text-gray-700" :
                  "bg-orange-100 text-orange-700"
                }`}>
                  {data.sample_tier === "platinum" ? "💎" : data.sample_tier === "gold" ? "🥇" : data.sample_tier === "silver" ? "🥈" : "🥉"}
                  {data.sample_tier === "platinum" ? t("roleProfilePage.tierPlatinum") : data.sample_tier === "gold" ? t("roleProfilePage.tierGold") : data.sample_tier === "silver" ? t("roleProfilePage.tierSilver") : t("roleProfilePage.tierBronze")}
                  {" · "}{Math.round(data.overall_confidence * 100)}%
                </span>
                {data.sample_tier === "bronze" && (
                  <span className="text-xs text-muted-foreground">
                    {t("roleProfilePage.bronzeTierHint")}
                  </span>
                )}
              </div>

              {/* Position override selector */}
              <div className="flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{t("roleProfile.positionOverride", "Forzar posición")}:</span>
                <Select
                  value={positionOverride ?? "auto"}
                  onValueChange={(val) => setPositionOverride(val === "auto" ? null : val)}
                >
                  <SelectTrigger className="h-7 w-[180px] text-xs">
                    <SelectValue placeholder={t("roleProfile.autoPosition", "Automático")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t("roleProfile.autoPosition", "Automático")}</SelectItem>
                    {POSITION_CODES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {POSITION_LABELS[code]} ({code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {positionOverride && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => setPositionOverride(null)}
                  >
                    ✕
                  </Button>
                )}
              </div>
            </div>

            {/* Low confidence warning */}
            {data.overall_confidence < 0.5 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md">
                <p className="text-sm text-amber-700">
                  {data.risks.some(r => r.code === "NO_VIDEO_ANALYSIS")
                    ? t("roleProfilePage.manualMetricsOnlyWarning")
                    : t("roleProfile.lowConfidenceWarning")}
                </p>
                {data.risks.some(r => r.code === "NO_VIDEO_ANALYSIS") && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 gap-1.5 text-xs"
                    onClick={() => navigate(`/players/${id}/intelligence`)}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {t("roleProfilePage.generateAiReport")}
                  </Button>
                )}
              </div>
            )}

            {/* Partial data warnings */}
            {data.risks.some(r => r.code === "tracking_physical_partial") && (
              <div className="p-2 bg-muted/50 border border-border rounded-md">
                <p className="text-xs text-muted-foreground">
                  {t("roleProfilePage.trackingPartialWarning")}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-1">
                <IdentityCard data={data} />
              </div>
              <div className="lg:col-span-2">
                <CapabilityCards data={data} filters={filters} />
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <PositionFitRanking data={data} filters={filters} />
              <ArchetypeRanking data={data} />
            </div>

            <StrengthsRisksPanel data={data} />

            {/* Movimiento + Escaneo · snapshot guardado desde VITAS Lab */}
            <TrackingSnapshotPanel playerId={id ?? ""} snapshot={trackingSnapshot} />

            {/* Proyección 0-6 / 6-18 / 18-36 meses: bloqueada con su motivo (P1 bloque 5c). */}
            <ProjectionGateCard />

            {/* Cita explícita de los videos fuente */}
            {data.source_videos && data.source_videos.length > 0 && (
              <div className="p-4 rounded-md border-l-4 border-primary/40 bg-muted/30 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground mb-1">{t("roleProfilePage.reportSource")}</p>
                <p>
                  {t("roleProfilePage.reportSourceDescription", { count: data.source_videos.length })}
                </p>
                <ul className="mt-2 space-y-0.5">
                  {data.source_videos.slice(0, 3).map((v, i) => (
                    <li key={i}>• {t("roleProfilePage.videoLabel", { id: v.video_id.slice(0, 8) })} · {new Date(v.analyzed_at).toLocaleString("es-ES")}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-xs text-muted-foreground border-t border-border pt-4 flex items-center gap-4">
              <span>{t("roleProfilePage.runLabel")}: <span className="font-mono">{data.run_id}</span></span>
              <span>{t("roleProfilePage.globalConfidence")}: {Math.round(data.overall_confidence * 100)}%</span>
              <span>{t("roleProfilePage.sampleLabel")}: {data.sample_tier}</span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
