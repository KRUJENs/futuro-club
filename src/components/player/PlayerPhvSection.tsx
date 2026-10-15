/**
 * VITAS · PlayerPhvSection — entrada UNIFICADA de datos PHV por jugador.
 *
 * Reúne en un solo sitio (la ficha del jugador) las DOS entradas que antes
 * estaban repartidas:
 *   1. Medidas antropométricas (altura/peso/altura sentado/pierna) → Mirwald.
 *   2. Datos de maduración (jugador y padres): la fecha de nacimiento DEL
 *      JUGADOR (edad decimal exacta; también llega a `players.birth_date`, la
 *      columna del control RGPD de consentimiento parental) y las alturas de
 *      madre+padre → Khamis-Roche (%talla adulta), la proyección fiable cuando la
 *      edad está lejos del PHV.
 *
 * Antes las alturas parentales solo vivían en "Editar jugador", así que el
 * mensaje de proyección ("añade la altura de ambos padres") era un callejón
 * sin salida. Ahora se editan aquí mismo.
 *
 * Guardado honesto: solo se anuncia «guardado» cuando el cambio está persistido
 * (localStorage + nube, o localStorage si no hay nube). Si la nube falla, queda
 * en SyncQueue y se muestra «pendiente de sincronizar»; si el jugador no está en
 * la caché local no se guarda nada y se dice.
 *
 * Usado por el Hub (/players/:id, pestaña Movimiento); /player/:id redirige al Hub.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ruler, Users, Save, Loader2, CloudOff } from "lucide-react";

import { AnthropometricsForm } from "@/components/player/AnthropometricsForm";
import GrowthVelocityChart from "@/components/player/GrowthVelocityChart";
import { PhvWindowPlan } from "@/components/player/PhvWindowPlan";
import type { Player } from "@/services/real/playerService";
import { SupabasePlayerService } from "@/services/real/supabasePlayerService";
import { SyncQueueService } from "@/services/real/syncQueueService";
import { useAuth } from "@/context/AuthContext";
import { BIRTH_DATE_MIN_ISO, latestBirthDateIso, toIsoBirthDate } from "@/lib/shared/birthDate";

interface Props {
  player: Player;
  hasPhv: boolean;
  /** Se llama tras guardar fecha de nacimiento/alturas — el host refresca su copia del jugador. */
  onSaved?: () => void;
}

// Rangos plausibles (idénticos al schema de playerService).
const MOTHER_RANGE = [120, 210] as const;
const FATHER_RANGE = [120, 230] as const;

export default function PlayerPhvSection({ player, hasPhv, onSaved }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [birthDate, setBirthDate] = useState(player.birthDate ?? "");
  const [motherH, setMotherH] = useState(player.motherHeightCm?.toString() ?? "");
  const [fatherH, setFatherH] = useState(player.fatherHeightCm?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  // «Pendiente de sincronizar»: hay un cambio de este jugador que aún no llegó a la
  // nube. Se lee de SyncQueue en cada render (no se congela en estado): cuando la
  // cola se procesa y el host re-renderiza, el aviso desaparece solo.
  const pendingSync = SyncQueueService.hasPendingFor("player", player.id, user?.id);
  const [, rerenderAfterSave] = useState(0);

  function outOfRange(v: string, [min, max]: readonly [number, number]): boolean {
    if (!v) return false;
    const n = Number(v);
    return Number.isNaN(n) || n < min || n > max;
  }

  async function saveParental() {
    if (outOfRange(motherH, MOTHER_RANGE) || outOfRange(fatherH, FATHER_RANGE)) {
      toast.error(t("playerPhvSection.parentalRangeError"));
      return;
    }
    // Misma regla que la columna birth_date (toIsoBirthDate): una fecha que la
    // columna rechazaría no se guarda en el blob (dos fechas distintas = inv #7).
    if (birthDate && toIsoBirthDate(birthDate) === null) {
      toast.error(t("playerPhvSection.birthDateInvalid"));
      return;
    }
    setSaving(true);
    try {
      const result = await SupabasePlayerService.saveProfile(user?.id, player.id, {
        birthDate: birthDate || undefined,
        motherHeightCm: motherH ? Number(motherH) : undefined,
        fatherHeightCm: fatherH ? Number(fatherH) : undefined,
      });
      if (result.status === "not_found") {
        // PlayerService.update no encontró al jugador en la caché local ⇒ NO se
        // guardó nada. Antes esto mostraba «guardado» igualmente.
        toast.error(t("playerPhvSection.notFoundError"));
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["player", player.id] }),
        queryClient.invalidateQueries({ queryKey: ["player-raw", player.id] }),
        queryClient.invalidateQueries({ queryKey: ["players-all"] }),
        // Rankings recalcula fase/timing PHV desde la ficha: sin esto iba hasta 5 min por detrás.
        queryClient.invalidateQueries({ queryKey: ["ranked-players"] }),
      ]);
      rerenderAfterSave((n) => n + 1);
      if (result.status === "queued") {
        toast.warning(t("playerPhvSection.pendingSyncToast"));
      } else {
        toast.success(t("playerPhvSection.parentalSaved"));
      }
      onSaved?.();
    } catch {
      toast.error(t("playerPhvSection.parentalError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Ruler size={14} className="text-primary" />
        <h2 className="font-display font-semibold text-sm text-foreground">
          {t("playerProfile.anthropometrics")}
        </h2>
        <span className="text-[10px] text-muted-foreground ml-auto">PHV · Mirwald</span>
      </div>

      {/* 1 · Medidas antropométricas → Mirwald */}
      <AnthropometricsForm
        playerId={player.id}
        chronologicalAge={player.age}
        // Mirwald usa la edad DECIMAL desde la fecha de nacimiento del jugador
        // (regla del owner 28-sep); sin ella el PHV queda bloqueado con motivo.
        birthDate={player.birthDate}
        gender={player.gender}
      />

      {/* 2 · Datos de maduración (jugador y padres): fecha de nacimiento DEL
            JUGADOR (edad decimal) + alturas de los padres → Khamis-Roche */}
      <div className="mt-4 pt-4 border-t border-border/40 space-y-3">
        <div className="flex items-center gap-2">
          <Users size={13} className="text-primary" />
          <h3 className="text-xs font-display font-semibold text-foreground">
            {t("playerPhvSection.parentalTitle")}
          </h3>
          <span className="text-[10px] text-muted-foreground ml-auto">Khamis-Roche</span>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {t("playerPhvSection.parentalNote")}
        </p>
        {/* Fila propia: es la fecha del JUGADOR, no de un padre. */}
        <label className="block text-[10px] text-muted-foreground space-y-1">
          <span>{t("playerPhvSection.birthDate")}</span>
          <input
            type="date"
            value={birthDate}
            min={BIRTH_DATE_MIN_ISO}
            max={latestBirthDateIso()}
            onChange={(e) => setBirthDate(e.target.value)}
            className="w-full sm:max-w-[12rem] rounded-md bg-secondary/40 border border-border px-2 py-1.5 text-xs text-foreground"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-muted-foreground space-y-1">
            <span>{t("playerPhvSection.motherHeight")}</span>
            <input
              type="number"
              inputMode="numeric"
              value={motherH}
              onChange={(e) => setMotherH(e.target.value)}
              placeholder="165"
              className="w-full rounded-md bg-secondary/40 border border-border px-2 py-1.5 text-xs text-foreground"
            />
          </label>
          <label className="text-[10px] text-muted-foreground space-y-1">
            <span>{t("playerPhvSection.fatherHeight")}</span>
            <input
              type="number"
              inputMode="numeric"
              value={fatherH}
              onChange={(e) => setFatherH(e.target.value)}
              placeholder="178"
              className="w-full rounded-md bg-secondary/40 border border-border px-2 py-1.5 text-xs text-foreground"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={saveParental}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-display font-bold bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t("playerPhvSection.parentalSave")}
          </button>
          {pendingSync && (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              <CloudOff size={11} />
              {t("playerPhvSection.pendingSync")}
            </span>
          )}
        </div>
      </div>

      {/* 3 · Curva de velocidad de crecimiento + plan de ventana PHV */}
      <div className="mt-4 pt-4 border-t border-border/40">
        <GrowthVelocityChart playerId={player.id} />
      </div>
      <div className="mt-4 pt-4 border-t border-border/40">
        <PhvWindowPlan playerId={player.id} hasPhv={hasPhv} />
      </div>
    </div>
  );
}
