/**
 * VITAS · PositionDiscoveryBanner
 *
 * Aparece en el informe del jugador cuando el agente detecta una
 * posición no declarada con encaje >75. Click en "Añadir al perfil"
 * persiste la posición en player.secondaryPositions[] y refresca.
 */
import { Sparkles, Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PlayerService, type Player } from "@/services/real/playerService";

interface PositionAlternative {
  code: string;
  fit: number;
  alreadyDeclared: boolean;
  reason: string;
  confidence: number;
}

interface Props {
  player: Player;
  alternatives: PositionAlternative[];
  onAdded?: () => void;
}

// Mapeo código -> nombre humano (ES)
const CODE_TO_NAME: Record<string, string> = {
  GK: "Portero", RB: "Lateral Derecho", LB: "Lateral Izquierdo",
  RCB: "Defensa Central", LCB: "Defensa Central",
  RWB: "Carrilero Derecho", LWB: "Carrilero Izquierdo",
  DM: "Pivote", RCM: "Mediocentro", LCM: "Mediocentro",
  CAM: "Mediapunta", RW: "Extremo Derecho", LW: "Extremo Izquierdo",
  ST: "Delantero",
};

export default function PositionDiscoveryBanner({ player, alternatives, onAdded }: Props) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Filtrar: solo descubrimientos con fit >75 que no estén dismissed
  const discoveries = alternatives.filter((a) =>
    !a.alreadyDeclared && a.fit > 75 && !dismissed.has(a.code)
  );

  if (discoveries.length === 0) return null;

  const handleAdd = (alt: PositionAlternative) => {
    const humanName = CODE_TO_NAME[alt.code] ?? alt.code;
    // Persist desde el almacenamiento CRUDO (P1 bloque 7): la vista honesta quita el «M»
    // sin confirmar y el PHV no recalculable; reescribirla borraría esos datos de todos.
    const all = PlayerService.getAllRaw();
    const idx = all.findIndex((p) => p.id === player.id);
    if (idx !== -1) {
      const raw = all[idx];
      all[idx] = {
        ...raw,
        secondaryPositions: [...(raw.secondaryPositions ?? []), humanName],
        updatedAt: new Date().toISOString(),
      };
      try {
        localStorage.setItem("vitas_players", JSON.stringify(all));
      } catch (e) {
        toast.error(t("positionDiscoveryBanner.saveError"));
        console.error(e);
        return;
      }
    }
    toast.success(t("positionDiscoveryBanner.addSuccess", { position: humanName, player: player.name }));
    onAdded?.();
    setDismissed((prev) => new Set(prev).add(alt.code));
  };

  const handleDismiss = (code: string) => {
    setDismissed((prev) => new Set(prev).add(code));
  };

  return (
    <div className="space-y-2">
      {discoveries.map((alt) => {
        const humanName = CODE_TO_NAME[alt.code] ?? alt.code;
        return (
          <div
            key={alt.code}
            className="glass rounded-xl p-4 border border-electric/40 bg-electric/5 relative"
          >
            <button
              onClick={() => handleDismiss(alt.code)}
              className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label={t("positionDiscoveryBanner.dismiss")}
            >
              <X size={12} />
            </button>
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-electric/20 border border-electric/40 flex items-center justify-center shrink-0">
                <Sparkles size={16} className="text-electric" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-electric font-bold">
                    💡 {t("positionDiscoveryBanner.videoDiscovery")}
                  </p>
                  <p className="text-sm font-display font-bold text-foreground">
                    {t("positionDiscoveryBanner.couldPerformAsPrefix", { player: player.name })} <span className="text-electric">{humanName}</span>
                    {" "}<span className="text-muted-foreground font-normal">({t("positionDiscoveryBanner.fitLabel", { fit: alt.fit })})</span>
                  </p>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {alt.reason}
                </p>
                <button
                  onClick={() => handleAdd(alt)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-electric text-background text-xs font-display font-bold hover:bg-electric/90 transition-colors"
                >
                  <Plus size={11} /> {t("positionDiscoveryBanner.addToProfile", { position: humanName })}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
