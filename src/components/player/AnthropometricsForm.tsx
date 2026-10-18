/**
 * VITAS · Antropometría + PHV
 *
 * Pantalla integrada en PlayerPhvSection (ficha del jugador · Hub) que permite:
 *   - Registrar nuevas mediciones (altura, peso, sentado, pierna)
 *   - Calcular el PHV (Mirwald) automáticamente al guardar
 *   - Ver el histórico completo de mediciones
 *   - Editar o eliminar mediciones existentes
 *
 * Toda la persistencia va a Supabase (`player_anthropometrics`) vía
 * /api/players/anthropometrics. El cálculo PHV se cachea por fila.
 */

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Ruler, Save, Loader2, Pencil, Trash2, Plus, X, Calendar,
  AlertCircle, WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getAuthHeaders } from "@/lib/apiAuth";
import { useOfflineMutation } from "@/hooks/useOfflineMutation";
import { missingPhvInputs, type PhvCategory } from "@/lib/phv/phvGate";
import { trustAnthroForPlayer } from "@/lib/shared/sexGatedAnthro";
import { PhvGateNotice } from "@/components/phv/PhvGateNotice";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { PlayerService } from "@/services/real/playerService";
import { SupabasePlayerService, type PlayerPersistStatus } from "@/services/real/supabasePlayerService";

interface Props {
  playerId: string;
  /**
   * Edad ENTERA del jugador: solo rellena la columna obligatoria cuando falta la
   * fecha de nacimiento (y entonces el PHV queda bloqueado). Mirwald usa SIEMPRE la
   * edad decimal que el servidor calcula desde `birthDate` (regla del owner 28-sep).
   */
  chronologicalAge: number;
  /** Fecha de nacimiento del JUGADOR (ISO). Sin ella no se calcula el PHV. */
  birthDate?: string;
  gender?: "M" | "F";
  /** «M» guardado sin confirmar (P1 bloque 7): se pide confirmarlo en «Editar jugador». */
  sexPending?: boolean;
  /** Marca de sexo confirmado del jugador: cada fila solo cuenta si cuadra con su sexo (P1 bloque 7). */
  sexConfirmedAt?: string;
  /** Tras guardar (enviado al servidor): las medidas introducidas, para el host. */
  onSaved?: (measures: SavedMeasures) => void;
}

export interface SavedMeasures {
  heightCm: number;
  weightKg: number;
  sittingHeightCm: number;
  legLengthCm: number;
}

interface PhvResult {
  offset: number;
  category: "early" | "ontime" | "late";
  phv_status: "pre_phv" | "during_phv" | "post_phv";
  development_window: "critical" | "active" | "stable";
}

interface AnthroRow {
  id: string;
  player_id: string;
  height_cm: number;
  weight_kg: number;
  sitting_height_cm: number | null;
  leg_length_cm: number | null;
  chronological_age: number;
  /** 'birth_date' ⇒ edad decimal desde la fecha de nacimiento (069). */
  age_source?: string | null;
  maturity_offset: number | null;
  phv_category: "early" | "ontime" | "late" | null;
  phv_status: PhvResult["phv_status"] | null;
  development_window: PhvResult["development_window"] | null;
  phv_gate_reason?: string | null;
  measured_at: string;
  notes?: string | null;
}

const PHV_LABELS = {
  early:  { label: "Pre-estirón",  color: "#1A8FFF", emoji: "🌱" },
  ontime: { label: "En estirón",   color: "#B82BD9", emoji: "🚀" },
  late:   { label: "Post-estirón", color: "#10b981", emoji: "🏆" },
} as const;

/** La categoría de la fila (convención persistida "ontime") → clave de PHV_LABELS. */
function labelKey(c: PhvCategory): keyof typeof PHV_LABELS {
  return c === "ontme" ? "ontime" : c;
}

const EMPTY_FORM = { height: "", weight: "", sitting: "", leg: "" };

export function AnthropometricsForm({ playerId, chronologicalAge, birthDate, gender, sexPending, sexConfirmedAt, onSaved }: Props) {
  const sexFields = { gender, sexConfirmedAt };
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [history, setHistory] = useState<AnthroRow[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Offline queue para mediciones · resilencia ante red intermitente
  const offline = useOfflineMutation({
    queueKey: "vitas_anthro_queue_v1",
    execute: async (action) => {
      const headers = await getAuthHeaders();
      const res = await fetch(action.url, {
        method: action.method,
        headers: { ...headers, "Content-Type": "application/json" },
        credentials: "include",
        body: action.payload ? JSON.stringify(action.payload) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
    },
  });

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      // Bearer: el endpoint exige auth (requireAuth); sin la cabecera respondía 401
      // y el histórico —y con él el PHV fiable de la última fila— nunca se veía.
      const res = await fetch(`/api/players/anthropometrics?playerId=${playerId}&history=true`, {
        headers: await getAuthHeaders(),
        credentials: "include",
      });
      const data = await res.json();
      if (data?.success && Array.isArray(data?.data?.history)) {
        setHistory(data.data.history as AnthroRow[]);
      }
    } catch {
      // silencioso · el usuario puede registrar uno nuevo igual
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Sin pre-relleno desde la ficha (P1 bloque 2): una medición se escribe cuando se
  // toma. Antes el formulario traía la talla y el peso del blob del jugador, que en el
  // alta rápida eran 165 cm / 58 kg que nadie había medido, y se guardaban como medición
  // (inv #2).

  /**
   * La ficha (blob que lee el gate de PHV del Hub) adopta las medidas guardadas.
   * Devuelve el estado REAL — nunca se traga un fallo de sincronización:
   *   synced / local_only → la ficha ya lee las medidas nuevas;
   *   queued      → la nube falló (o no hay sesión): en SyncQueue A NOMBRE de la
   *                 cuenta, pendiente;
   *   sync_failed → sin sesión ni cuenta a la que atribuir el cambio: la ficha
   *                 cambió SOLO en este dispositivo y NO está en cola (se avisa);
   *   not_found   → el jugador no está en este dispositivo: la ficha NO cambió.
   */
  async function adoptMeasuresLocally(m: SavedMeasures): Promise<PlayerPersistStatus | "sync_failed" | "not_found"> {
    const updated = await PlayerService.update(playerId, {
      height: m.heightCm,
      weight: m.weightKg,
      sittingHeight: m.sittingHeightCm,
      legLength: m.legLengthCm,
    }).catch(() => null); // caché local inaccesible ⇒ la ficha no cambió (se avisa)
    if (!updated) return "not_found";
    // Misma semántica que el resto de guardados de la ficha (PlayerForm,
    // PlayerPhvSection): persistOrQueue sube el jugador o lo encola A NOMBRE DE LA
    // CUENTA. Encolarlo sin dueño (como antes) era perderlo en silencio: una op sin
    // dueño no se sube nunca y se descarta al cerrar sesión.
    let status: PlayerPersistStatus | "sync_failed";
    try {
      status = (await SupabasePlayerService.persistOrQueue(user?.id, updated, "update")).status;
    } catch (err) {
      // Solo lanza sin sesión NI cuenta a la que atribuir el cambio: no hay cola posible.
      console.warn("[AnthropometricsForm] profile not synced and not queued:", err);
      status = "sync_failed";
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["player", playerId] }),
      queryClient.invalidateQueries({ queryKey: ["player-raw", playerId] }),
      queryClient.invalidateQueries({ queryKey: ["players-all"] }),
      // Rankings recalcula fase/timing PHV desde la ficha: sin esto iba hasta 5 min por detrás.
      queryClient.invalidateQueries({ queryKey: ["ranked-players"] }),
    ]).catch(() => {});
    return status;
  }

  function startNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setShowForm(true);
  }

  function startEdit(row: AnthroRow) {
    setEditingId(row.id);
    setForm({
      height:  String(row.height_cm),
      weight:  String(row.weight_kg),
      sitting: row.sitting_height_cm ? String(row.sitting_height_cm) : "",
      leg:     row.leg_length_cm     ? String(row.leg_length_cm)     : "",
    });
    setError(null);
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const heightCm = Number(form.height);
    const weightKg = Number(form.weight);
    const sittingHeightCm = form.sitting ? Number(form.sitting) : 0;
    const legLengthCm = form.leg ? Number(form.leg) : 0;

    if (!heightCm || !weightKg) {
      setError(t("anthroForm.errHeightWeightRequired"));
      setSubmitting(false);
      return;
    }

    if (!sittingHeightCm || !legLengthCm) {
      setError(t("anthroForm.errSittingLegRequired"));
      setSubmitting(false);
      return;
    }

    // birthDate: el servidor calcula con ella la edad DECIMAL de Mirwald en la
    // fecha de la medida. chronologicalAge (entero) solo rellena la columna si
    // falta la fecha — y entonces el PHV queda bloqueado con motivo.
    const payload = {
      playerId,
      heightCm,
      weightKg,
      sittingHeightCm,
      legLengthCm,
      chronologicalAge,
      ...(birthDate ? { birthDate } : {}),
      gender,
    };

    const url = editingId
      ? `/api/players/anthropometrics?id=${editingId}`
      : "/api/players/anthropometrics";
    const method: "POST" | "PATCH" = editingId ? "PATCH" : "POST";

    try {
      const result = await offline.run({
        url,
        method,
        payload,
        label: editingId ? t("anthroForm.queueLabelUpdate") : t("anthroForm.queueLabelNew"),
      });

      if (result.sent) {
        toast.success(editingId ? t("anthroForm.toastUpdated") : t("anthroForm.toastSaved"));
        // Medición NUEVA (la más reciente): la ficha local adopta las medidas
        // introducidas para que el gate único de PHV de la ficha lea lo mismo que se
        // acaba de medir (el endpoint solo escribe columnas; la ficha lee el blob).
        if (!editingId) {
          const adopted = await adoptMeasuresLocally({ heightCm, weightKg, sittingHeightCm, legLengthCm });
          if (adopted === "queued") toast.info(t("anthroForm.toastProfilePendingSync"), { duration: 6000 });
          if (adopted === "sync_failed") toast.error(t("anthroForm.toastProfileSyncFailed"), { duration: 8000 });
          if (adopted === "not_found") toast.warning(t("anthroForm.toastProfileNotOnDevice"), { duration: 6000 });
        }
        onSaved?.({ heightCm, weightKg, sittingHeightCm, legLengthCm });
        await loadHistory();
      } else if (result.queued) {
        toast.info(t("anthroForm.toastQueuedSave"), { duration: 5000 });
      }

      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("anthroForm.errUnknown");
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("anthroForm.confirmDelete"))) return;
    try {
      const result = await offline.run({
        url: `/api/players/anthropometrics?id=${id}`,
        method: "DELETE",
        label: t("anthroForm.queueLabelDelete"),
      });
      if (result.sent) {
        toast.success(t("anthroForm.toastDeleted"));
        await loadHistory();
      } else if (result.queued) {
        toast.info(t("anthroForm.toastQueuedDelete"));
        // Optimistic UI · quitar de history local
        setHistory((prev) => prev.filter((r) => r.id !== id));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("anthroForm.errDelete"));
    }
  }

  const latest = history[0];
  const latestTrust = trustAnthroForPlayer(latest, sexFields);

  // Qué le falta al PERFIL del jugador para que una medida nueva produzca PHV
  // (las 4 medidas las exige el propio formulario). Se avisa ANTES de guardar.
  const identityMissing = missingPhvInputs({
    height: Number(form.height) || undefined,
    weight: Number(form.weight) || undefined,
    sittingHeight: Number(form.sitting) || undefined,
    legLength: Number(form.leg) || undefined,
    birthDate,
    gender,
  }).filter((k) => k === "birthDate" || k === "sex");

  const phvLabel = (category: keyof typeof PHV_LABELS) =>
    t(`anthroForm.phvCategory.${category}`);

  return (
    <div className="space-y-3">
      {/* Indicador offline · solo si hay items en cola */}
      {offline.queueSize > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5">
          {offline.online && offline.syncing ? (
            <Loader2 size={11} className="text-amber-400 animate-spin shrink-0" />
          ) : (
            <WifiOff size={11} className="text-amber-400 shrink-0" />
          )}
          <span className="text-[10px] text-amber-400 font-display font-bold">
            {offline.queueSize} {offline.queueSize === 1 ? t("anthroForm.pendingChangeOne") : t("anthroForm.pendingChangeMany")}
            {offline.online ? t("anthroForm.syncingSuffix") : t("anthroForm.offlineSuffix")}
          </span>
        </div>
      )}

      {/* Última medida + CTA nueva */}
      {!loading && (
        <div className="flex items-center justify-between gap-3">
          {latest ? (
            <div className="flex-1 text-[11px] text-muted-foreground">
              {t("anthroForm.latestLabel")}{" "}
              <span className="text-foreground font-medium">
                {latest.height_cm}cm · {latest.weight_kg}kg
              </span>
              {" · "}
              {latestTrust.trusted && latestTrust.category ? (
                <span style={{ color: PHV_LABELS[labelKey(latestTrust.category)].color }}>
                  {PHV_LABELS[labelKey(latestTrust.category)].emoji} {phvLabel(labelKey(latestTrust.category))}
                </span>
              ) : (
                <PhvGateNotice code={latestTrust.code} missing={latestTrust.missing} />
              )}
              {" · "}
              <span className="text-[10px]">
                {new Date(latest.measured_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })}
              </span>
            </div>
          ) : (
            <div className="flex-1 text-[11px] text-muted-foreground">
              {t("anthroForm.noMeasurements")}
            </div>
          )}
          {!showForm && (
            <button
              onClick={startNew}
              className="flex items-center gap-1 text-[11px] font-bold text-primary hover:text-primary/80 transition-colors"
            >
              <Plus size={12} /> {t("anthroForm.newButton")}
            </button>
          )}
        </div>
      )}

      {/* Formulario · alta o edición */}
      <AnimatePresence>
        {showForm && (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            onSubmit={handleSubmit}
            className="space-y-3 rounded-xl bg-secondary/30 p-3 border border-border"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
                {editingId ? t("anthroForm.editMeasurement") : t("anthroForm.newMeasurement")}
              </span>
              <button
                type="button"
                onClick={cancelForm}
                className="p-1 rounded hover:bg-secondary text-muted-foreground"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t("anthroForm.fieldHeight")}
                value={form.height}
                onChange={(v) => setForm((f) => ({ ...f, height: v }))}
                min={80} max={230}
                required
                placeholder="165.5"
              />
              <Field
                label={t("anthroForm.fieldWeight")}
                value={form.weight}
                onChange={(v) => setForm((f) => ({ ...f, weight: v }))}
                min={15} max={150}
                required
                placeholder="55.2"
              />
              <Field
                label={t("anthroForm.fieldSitting")}
                value={form.sitting}
                onChange={(v) => setForm((f) => ({ ...f, sitting: v }))}
                min={40} max={130}
                required
                placeholder="86.0"
                hint={t("anthroForm.hintRequiredPhv")}
              />
              <Field
                label={t("anthroForm.fieldLeg")}
                value={form.leg}
                onChange={(v) => setForm((f) => ({ ...f, leg: v }))}
                min={30} max={130}
                required
                placeholder="79.5"
                hint={t("anthroForm.hintRequiredPhv")}
              />
            </div>

            {identityMissing.length > 0 && (
              <PhvGateNotice variant="card" code="missing_inputs" missing={identityMissing} sexPending={sexPending} />
            )}

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-2 text-[10px] text-destructive">
                <AlertCircle size={12} />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-display font-bold text-xs disabled:opacity-50 flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors"
            >
              {submitting ? (
                <><Loader2 size={12} className="animate-spin" /> {t("anthroForm.saving")}</>
              ) : (
                <><Save size={12} /> {editingId ? t("anthroForm.updateMeasurementBtn") : t("anthroForm.saveAndCalcBtn")}</>
              )}
            </button>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Histórico */}
      {history.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-bold pt-1">
            <Calendar size={10} />
            {t("anthroForm.historyTitle", { count: history.length })}
          </div>
          <div className="space-y-1">
            {history.map((row) => {
              // Solo filas FIABLES (completas + edad por fecha de nacimiento, 069)
              // muestran categoría/offset; el resto nombra el motivo (inv #2).
              const trust = trustAnthroForPlayer(row, sexFields);
              const phv = trust.trusted && trust.category ? PHV_LABELS[labelKey(trust.category)] : null;
              const date = new Date(row.measured_at);
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-secondary/30 px-2.5 py-2 border border-border/50"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {phv && trust.category && (
                      <span className="text-base shrink-0" title={phvLabel(labelKey(trust.category))}>{phv.emoji}</span>
                    )}
                    <div className="min-w-0">
                      <div className="text-[11px] text-foreground font-medium truncate">
                        {row.height_cm}cm · {row.weight_kg}kg
                        {trust.trusted && trust.offset !== null ? (
                          <span className="text-muted-foreground ml-2 text-[10px]">
                            {t("anthroForm.offsetAbbr")} {trust.offset > 0 ? "+" : ""}{trust.offset}
                          </span>
                        ) : (
                          <PhvGateNotice className="ml-2 text-[10px]" code={trust.code} missing={trust.missing} />
                        )}
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {date.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })}
                        {row.sitting_height_cm && ` · ${t("anthroForm.sittingAbbr")} ${row.sitting_height_cm}`}
                        {row.leg_length_cm     && ` · ${t("anthroForm.legAbbr")} ${row.leg_length_cm}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(row)}
                      className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                      title={t("anthroForm.editAction")}
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => handleDelete(row.id)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title={t("anthroForm.deleteAction")}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Hint educativo */}
      {!loading && (
        <p className="text-[10px] text-muted-foreground leading-relaxed pt-1 border-t border-border/40">
          <Ruler size={10} className="inline mr-1" />
          {t("anthroForm.hintBefore")} <strong>Mirwald</strong>{" "}
          {t("anthroForm.hintAfter")}
        </p>
      )}
    </div>
  );
}

// ─── Sub-componente: input numérico con label compacto ──────────────────────

function Field({
  label, value, onChange, min, max, required, placeholder, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-[10px] font-display text-muted-foreground uppercase tracking-wide mb-1">
        {label} {required && <span className="text-primary">*</span>}
      </label>
      <input
        type="number"
        required={required}
        min={min}
        max={max}
        step="0.1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 rounded-md bg-background border border-border text-xs text-foreground focus:border-primary focus:outline-none"
      />
      {hint && <p className="text-[9px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
