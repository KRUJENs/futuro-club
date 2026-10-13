/**
 * VITAS · Parental Consent Management — /admin/consent
 *
 * Gestión del consentimiento del TUTOR para menores de 14 (RGPD / LOPDGDD).
 *   - Menores: players con fecha de nacimiento y < 14 años cumplidos (misma regla que el gate).
 *   - Estado: el REAL del servidor (/api/auth/consent-status, P1 bloque 3). Antes se leía y se
 *     escribía players.parental_consent_status: un rótulo que esta pantalla ponía en «concedido»
 *     sin el tutor y que el gate de análisis nunca contó.
 *   - Acciones: pedir la firma al tutor (correo con enlace; el tutor confirma con SU DNI),
 *     volver a pedirla, retirar (en el servidor). Nada se «concede» desde aquí.
 *   - consent_audit_log (historial de esta pantalla) y RPC dsar_export_player_data /
 *     dsar_request_deletion (072; desde la 076, solo el dueño del jugador).
 * (La vista v_players_ai_blocked de 036 NO se usa aquí; 072 la cierra a clientes.)
 *
 * Sin Supabase: datos de ejemplo, con su aviso.
 */

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Shield, UserCheck, UserX, Clock, AlertTriangle,
  Send, CheckCircle2, XCircle, Loader2, Info, Search,
  Baby, Mail, FileText, Download, Trash2, Eye,
} from "lucide-react";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import type { GuardianConsentState, GuardianConsentStatus } from "@/services/real/parentalConsentService";
import { useConsentStatus, useWithdrawGuardianConsent } from "@/hooks/useParentalConsent";
import { ParentalConsentForm } from "@/components/legal/ParentalConsentForm";
import { completedYearsAt, minorStatusFromBirthDate } from "@/lib/shared/videoConsent";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { dsarErrorToastKey } from "@/lib/consent/dsarError";

/* ── Types ─────────────────────────────────────────────────────── */

interface ConsentPlayer {
  id: string;
  name: string;
  birth_date: string | null;
  age_years: number | null;
}

interface AuditEntry {
  id: string;
  player_id: string;
  action: string;
  actor_email: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

type ConsentTab = "pending" | "granted" | "denied" | "audit";

/** Pestaña de cada estado: confirmado → «concedidos»; retirado → «denegados»; el resto, pendientes. */
function tabOf(state: GuardianConsentState): Exclude<ConsentTab, "audit"> {
  if (state === "verified") return "granted";
  if (state === "withdrawn") return "denied";
  return "pending";
}

/* ── Mock data (solo sin Supabase, con aviso) ──────────────────── */

const MOCK_PLAYERS: ConsentPlayer[] = [
  { id: "m1", name: "Lucas Fernández", birth_date: "2014-03-15", age_years: 12 },
  { id: "m2", name: "Martina López", birth_date: "2013-08-22", age_years: 12 },
  { id: "m3", name: "Diego Ruiz", birth_date: "2013-11-05", age_years: 12 },
  { id: "m4", name: "Sofía García", birth_date: "2014-06-18", age_years: 11 },
  { id: "m5", name: "Pablo Moreno", birth_date: "2013-01-30", age_years: 13 },
];

const MOCK_STATUS: Record<string, GuardianConsentStatus> = {
  m1: { state: "pending", guardianEmail: "tutor.lucas@email.com", expiresAt: "2026-04-06T09:00:00Z" },
  m2: { state: "none" },
  m3: { state: "verified", guardianName: "Ana Ruiz Martínez", guardianEmail: "ana.ruiz@email.com", verifiedAt: "2026-04-10T10:30:00Z" },
  m4: { state: "withdrawn", guardianName: "Carlos García", withdrawnAt: "2026-04-08T14:15:00Z" },
  m5: { state: "expired", guardianEmail: "tutor.pablo@email.com" },
};

const MOCK_AUDIT: AuditEntry[] = [
  { id: "a1", player_id: "m3", action: "consent_granted", actor_email: "ana.ruiz@email.com", details: { guardian_name: "Ana Ruiz Martínez" }, created_at: "2026-04-10T10:30:00Z" },
  { id: "a2", player_id: "m4", action: "consent_denied", actor_email: "carlos.garcia@email.com", details: { reason: "No autorizo procesamiento IA" }, created_at: "2026-04-08T14:15:00Z" },
  { id: "a3", player_id: "m1", action: "consent_requested", actor_email: "coach@krujens.eu", details: {}, created_at: "2026-04-05T09:00:00Z" },
];

/* ── Status helpers ────────────────────────────────────────────── */

// Etiquetas: las mismas que la tarjeta de la ficha (guardianConsent.state.*), un solo texto por estado.
const statusConfig: Record<GuardianConsentState, { label: string; icon: JSX.Element; color: string; bg: string; border: string }> = {
  verified: { label: "guardianConsent.state.verified", icon: <CheckCircle2 size={14} />, color: "text-emerald-600", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  pending: { label: "guardianConsent.state.pending", icon: <Clock size={14} />, color: "text-amber-600", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  expired: { label: "guardianConsent.state.expired", icon: <Clock size={14} />, color: "text-red-600", bg: "bg-red-500/10", border: "border-red-500/30" },
  withdrawn: { label: "guardianConsent.state.withdrawn", icon: <XCircle size={14} />, color: "text-red-600", bg: "bg-red-500/10", border: "border-red-500/30" },
  none: { label: "guardianConsent.state.none", icon: <Info size={14} />, color: "text-muted-foreground", bg: "bg-muted/50", border: "border-border" },
  unavailable: { label: "guardianConsent.state.unavailable", icon: <AlertTriangle size={14} />, color: "text-muted-foreground", bg: "bg-muted/50", border: "border-border" },
};

// Maps audit action codes to translation keys resolved with t() at render time.
const actionLabels: Record<string, string> = {
  consent_requested: "parentalConsentPage.action.consent_requested",
  consent_granted: "parentalConsentPage.action.consent_granted",
  consent_denied: "parentalConsentPage.action.consent_denied",
  consent_revoked: "parentalConsentPage.action.consent_revoked",
  data_exported: "parentalConsentPage.action.data_exported",
  deletion_requested: "parentalConsentPage.action.deletion_requested",
};

/* ── Fetch helpers ─────────────────────────────────────────────── */

async function fetchMinorPlayers(): Promise<ConsentPlayer[]> {
  if (!SUPABASE_CONFIGURED) return MOCK_PLAYERS;
  const { data, error } = await supabase
    .from("players")
    .select("id, name, birth_date")
    .not("birth_date", "is", null)
    .order("name");
  if (error) throw error;

  // Menor = misma regla que el gate de análisis (años CUMPLIDOS < 14; inv #7). Antes se
  // dividía por 365,25 días, que no coincide con el gate en los días del cumpleaños.
  return (data ?? [])
    .map((p: Record<string, unknown>) => {
      const birthDate = typeof p.birth_date === "string" ? p.birth_date.slice(0, 10) : null;
      return {
        id: String(p.id),
        name: String(p.name ?? ""),
        birth_date: birthDate,
        age_years: birthDate ? completedYearsAt(birthDate, new Date()) : null,
      } as ConsentPlayer;
    })
    .filter((p) => minorStatusFromBirthDate(p.birth_date) === "minor");
}

async function fetchAuditLog(): Promise<AuditEntry[]> {
  if (!SUPABASE_CONFIGURED) return MOCK_AUDIT;
  const { data, error } = await supabase
    .from("consent_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as AuditEntry[];
}

/* ── Consent Action Modal ──────────────────────────────────────── */

type ConsentAction = "request" | "withdraw";

interface ConsentActionProps {
  player: ConsentPlayer;
  status: GuardianConsentStatus | undefined;
  action: ConsentAction;
  onClose: () => void;
  /** Firma pedida (con o sin correo enviado). */
  onRequested: (r: { emailSent: boolean; email: string }) => void;
  onWithdraw: () => void;
  withdrawing: boolean;
}

/**
 * Pedir la firma al tutor (solo nombre y email; el tutor confirma con SU DNI desde el correo) o
 * retirar el consentimiento en el servidor. Antes este modal «Autorizaba» o «Denegaba» escribiendo
 * un rótulo en players que el gate de análisis nunca contó (P1 bloque 3).
 */
function ConsentActionModal({ player, status, action, onClose, onRequested, onWithdraw, withdrawing }: ConsentActionProps) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-200/70 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="glass rounded-2xl p-6 max-w-lg w-full space-y-5 border border-border/40 bg-card"
        role="dialog"
        aria-modal="true"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield size={16} className="text-primary" />
            <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wider">
              {t("guardianConsent.title")}
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">{t("parentalConsentPage.form.legalRef")}</p>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/20">
          <Baby size={18} className="text-primary" />
          <div>
            <p className="text-sm font-display font-bold text-foreground">{player.name}</p>
            <p className="text-[10px] text-muted-foreground">
              {t("parentalConsentPage.list.ageYears", { age: player.age_years })}
            </p>
          </div>
        </div>

        {action === "request" ? (
          <ParentalConsentForm
            playerId={player.id}
            initialName={status?.guardianName ?? ""}
            initialEmail={status?.guardianEmail ?? ""}
            onCancel={onClose}
            onDone={onRequested}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-foreground">{t("guardianConsent.withdrawConfirm", { name: player.name })}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-lg border border-border text-xs font-display font-semibold text-muted-foreground hover:text-foreground"
              >
                {t("guardianConsent.form.cancel")}
              </button>
              <button
                type="button"
                onClick={onWithdraw}
                disabled={withdrawing}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-xs font-display font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {withdrawing ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
                {t("guardianConsent.actions.withdrawConfirm")}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ── DSAR Actions ──────────────────────────────────────────────── */

interface DSARModalProps {
  player: ConsentPlayer;
  onClose: () => void;
}

function DSARModal({ player, onClose }: DSARModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      if (SUPABASE_CONFIGURED) {
        const { data, error } = await supabase.rpc("dsar_export_player_data", { p_player_id: player.id });
        if (error) throw error;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dsar_export_${player.name.replace(/\s/g, "_")}_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t("parentalConsentPage.toast.exportSuccess"));
        // 072 registra «data_exported» en consent_audit_log: refrescar la pestaña de auditoría.
        queryClient.invalidateQueries({ queryKey: ["consent-audit"] });
      } else {
        toast.info(t("parentalConsentPage.toast.exportUnavailable"));
      }
    } catch (err) {
      toast.error(t(dsarErrorToastKey(err, "export")));
    } finally {
      setExporting(false);
    }
  };

  const handleRequestDeletion = async () => {
    setDeleting(true);
    try {
      if (SUPABASE_CONFIGURED) {
        // El solicitante lo toma la base de datos del JWT (072); el cliente no lo envía.
        const { error } = await supabase.rpc("dsar_request_deletion", {
          p_player_id: player.id,
        });
        if (error) throw error;
        toast.success(t("parentalConsentPage.toast.deletionSuccess"));
        queryClient.invalidateQueries({ queryKey: ["consent-audit"] });
      } else {
        toast.info(t("parentalConsentPage.toast.deletionDemo"));
      }
      onClose();
    } catch (err) {
      toast.error(t(dsarErrorToastKey(err, "deletion")));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="glass rounded-2xl p-6 max-w-md w-full space-y-4 border border-border/40"
      >
        <div>
          <h2 className="text-sm font-display font-bold text-foreground">{t("parentalConsentPage.dsar.title", { name: player.name })}</h2>
          <p className="text-[10px] text-muted-foreground">{t("parentalConsentPage.dsar.subtitle")}</p>
        </div>

        <div className="space-y-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors"
          >
            {exporting ? <Loader2 size={16} className="animate-spin text-primary" /> : <Download size={16} className="text-primary" />}
            <div className="text-left">
              <p className="text-xs font-display font-semibold text-foreground">{t("parentalConsentPage.dsar.exportTitle")}</p>
              <p className="text-[9px] text-muted-foreground">{t("parentalConsentPage.dsar.exportDesc")}</p>
            </div>
          </button>

          <button
            onClick={handleRequestDeletion}
            disabled={deleting}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 transition-colors"
          >
            {deleting ? <Loader2 size={16} className="animate-spin text-red-400" /> : <Trash2 size={16} className="text-red-400" />}
            <div className="text-left">
              <p className="text-xs font-display font-semibold text-red-400">{t("parentalConsentPage.dsar.deletionTitle")}</p>
              <p className="text-[9px] text-muted-foreground">{t("parentalConsentPage.dsar.deletionDesc")}</p>
            </div>
          </button>
        </div>

        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg border border-border text-xs font-display text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("parentalConsentPage.dsar.close")}
        </button>
      </motion.div>
    </motion.div>
  );
}

/* ── Main Component ────────────────────────────────────────────── */

export default function ParentalConsentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ConsentTab>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState<ConsentPlayer | null>(null);
  const [consentAction, setConsentAction] = useState<ConsentAction | null>(null);
  const [showDSAR, setShowDSAR] = useState(false);

  const { data: players, isLoading: loadingPlayers } = useQuery({
    queryKey: ["consent-players"],
    queryFn: fetchMinorPlayers,
    staleTime: 30_000,
  });

  const { data: auditLog, isLoading: loadingAudit } = useQuery({
    queryKey: ["consent-audit"],
    queryFn: fetchAuditLog,
    staleTime: 30_000,
  });

  // Estado REAL del consentimiento del tutor (servidor). Sin Supabase: los de ejemplo (con aviso).
  const { data: liveStatuses, isLoading: loadingStatuses } = useConsentStatus(
    SUPABASE_CONFIGURED ? (players ?? []).map((p) => p.id) : [],
  );
  const statuses: Record<string, GuardianConsentStatus> = SUPABASE_CONFIGURED ? (liveStatuses ?? {}) : MOCK_STATUS;
  // Sin respuesta del servidor para un jugador ⇒ «no disponible» (nunca «confirmado»).
  const stateOf = (p: ConsentPlayer): GuardianConsentState => statuses[p.id]?.state ?? "unavailable";

  const withdraw = useWithdrawGuardianConsent();

  // Historial de ESTA pantalla (informativo): un fallo no cambia lo que ya hizo el servidor.
  const logAudit = async (playerId: string, action: "consent_requested" | "consent_revoked", details: Record<string, unknown>) => {
    if (!SUPABASE_CONFIGURED) return;
    try {
      const { error: auditErr } = await supabase
        .from("consent_audit_log")
        .insert({ player_id: playerId, action, actor_email: user?.email ?? "unknown", details });
      if (auditErr) console.error("Audit log error:", auditErr);
    } catch (err) {
      console.error("Audit log error:", err);
    }
    queryClient.invalidateQueries({ queryKey: ["consent-audit"] });
  };

  const closeModal = () => {
    setConsentAction(null);
    setSelectedPlayer(null);
  };

  const handleRequested = async (r: { emailSent: boolean; email: string }) => {
    const player = selectedPlayer;
    closeModal();
    if (!player) return;
    await logAudit(player.id, "consent_requested", { guardian_email: r.email, email_sent: r.emailSent });
    if (r.emailSent) toast.success(t("guardianConsent.sent", { email: r.email }));
    else toast.warning(t("guardianConsent.sentNoEmail"));
  };

  const handleWithdraw = async () => {
    const player = selectedPlayer;
    if (!player) return;
    if (!SUPABASE_CONFIGURED) {
      closeModal();
      return;
    }
    try {
      // La retirada la hace el SERVIDOR; si falla, se dice y no se muestra «retirado».
      await withdraw.mutateAsync({ playerId: player.id });
    } catch {
      toast.error(t("guardianConsent.errors.withdraw"));
      return;
    }
    closeModal();
    await logAudit(player.id, "consent_revoked", {});
    toast.success(t("guardianConsent.withdrawn"));
  };

  // Filter players by tab and search
  const filteredPlayers = (players ?? []).filter(p => {
    const matchesTab = activeTab === "audit" || tabOf(stateOf(p)) === activeTab;
    const matchesSearch = !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const pendingCount = players?.filter(p => tabOf(stateOf(p)) === "pending").length ?? 0;
  const grantedCount = players?.filter(p => tabOf(stateOf(p)) === "granted").length ?? 0;
  const deniedCount = players?.filter(p => tabOf(stateOf(p)) === "denied").length ?? 0;

  const tabs = [
    { id: "pending" as const, label: t("parentalConsentPage.tabs.pending"), count: pendingCount, icon: <Clock size={14} /> },
    { id: "granted" as const, label: t("parentalConsentPage.tabs.granted"), count: grantedCount, icon: <UserCheck size={14} /> },
    { id: "denied" as const, label: t("parentalConsentPage.tabs.denied"), count: deniedCount, icon: <UserX size={14} /> },
    { id: "audit" as const, label: t("parentalConsentPage.tabs.audit"), count: auditLog?.length ?? 0, icon: <FileText size={14} /> },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-background pb-24"
    >
      {/* Header */}
      <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-xl hover:bg-muted/50 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <Shield size={18} className="text-primary" />
          <h1 className="font-display font-bold text-sm uppercase tracking-wider flex-1">
            {t("parentalConsentPage.title")}
          </h1>
          <span className="text-[9px] font-display font-bold uppercase tracking-wider px-2 py-1 rounded bg-primary/10 text-primary">
            {t("parentalConsentPage.header.badge")}
          </span>
        </div>

        {/* Tabs */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-display font-semibold whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              {tab.icon}
              {tab.label}
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                activeTab === tab.id ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Mock data banner */}
        {!SUPABASE_CONFIGURED && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
            <Info size={14} />
            <span>{t("parentalConsentPage.mockBanner")}</span>
          </div>
        )}

        {/* Warning banner for pending */}
        {pendingCount > 0 && activeTab === "pending" && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-display font-bold text-amber-400">
                {t("parentalConsentPage.pendingWarning.title", { count: pendingCount })}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {t("parentalConsentPage.pendingWarning.desc")}
              </p>
            </div>
          </div>
        )}

        {/* Search */}
        {activeTab !== "audit" && (
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder={t("parentalConsentPage.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
            />
          </div>
        )}

        {/* Loading */}
        {(loadingPlayers || loadingAudit) && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}

        {/* Player list */}
        {!loadingPlayers && activeTab !== "audit" && (
          <div className="space-y-2">
            {filteredPlayers.length === 0 ? (
              <div className="glass rounded-xl p-8 text-center">
                <p className="text-xs text-muted-foreground">
                  {searchQuery
                    ? t("parentalConsentPage.list.emptyNoResults")
                    : t("parentalConsentPage.list.emptyWithStatus", { status: tabs.find(tab => tab.id === activeTab)?.label })}
                </p>
              </div>
            ) : (
              filteredPlayers.map(player => {
                const st = statuses[player.id];
                const state = stateOf(player);
                const cfg = statusConfig[state];
                const fmt = (iso?: string | null) =>
                  iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "";
                return (
                  <motion.div
                    key={player.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`glass rounded-xl p-4 border ${cfg.border}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${cfg.bg}`}>
                        <Baby size={16} className={cfg.color} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-display font-bold text-foreground">{player.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {t("parentalConsentPage.list.ageYears", { age: player.age_years })}
                          {player.birth_date && ` · ${fmt(player.birth_date)}`}
                        </p>
                        {(st?.guardianName || st?.guardianEmail) && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {t("parentalConsentPage.list.guardian", { name: st?.guardianName ?? "" })}
                            {st?.guardianEmail && ` · ${st.guardianEmail}`}
                          </p>
                        )}
                        {state === "verified" && st?.verifiedAt && (
                          <p className="text-[9px] text-muted-foreground">
                            {t("parentalConsentPage.list.grantedOn", { date: fmt(st.verifiedAt) })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {/* Status badge: el estado REAL del servidor */}
                        <span className={`flex items-center gap-1 text-[9px] font-display font-bold uppercase px-2 py-1 rounded ${cfg.bg} ${cfg.color}`}>
                          {cfg.icon}
                          {t(cfg.label)}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 mt-3 pt-3 border-t border-border/20">
                      {(loadingStatuses && SUPABASE_CONFIGURED) ? null : state !== "verified" && state !== "unavailable" ? (
                        <button
                          onClick={() => { setSelectedPlayer(player); setConsentAction("request"); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[10px] font-display font-semibold hover:bg-primary/20 transition-colors"
                        >
                          <Send size={12} />
                          {state === "pending" ? t("guardianConsent.actions.resend")
                            : state === "none" ? t("guardianConsent.actions.request")
                            : t("guardianConsent.actions.requestAgain")}
                        </button>
                      ) : null}
                      {(state === "verified" || state === "pending") && (
                        <button
                          onClick={() => { setSelectedPlayer(player); setConsentAction("withdraw"); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-[10px] font-display font-semibold hover:text-foreground transition-colors"
                        >
                          <UserX size={12} />
                          {state === "verified" ? t("guardianConsent.actions.withdraw") : t("guardianConsent.actions.cancelRequest")}
                        </button>
                      )}
                      <button
                        onClick={() => { setSelectedPlayer(player); setShowDSAR(true); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-[10px] font-display font-semibold hover:text-foreground transition-colors"
                      >
                        <Eye size={12} />
                        DSAR
                      </button>
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>
        )}

        {/* Audit log */}
        {!loadingAudit && activeTab === "audit" && (
          <div className="space-y-2">
            {(auditLog ?? []).length === 0 ? (
              <div className="glass rounded-xl p-8 text-center">
                <p className="text-xs text-muted-foreground">{t("parentalConsentPage.audit.empty")}</p>
              </div>
            ) : (
              (auditLog ?? []).map(entry => {
                const playerName = players?.find(p => p.id === entry.player_id)?.name ?? entry.player_id;
                return (
                  <div key={entry.id} className="glass rounded-xl p-4 border border-border/20">
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 rounded-lg bg-muted">
                        <FileText size={14} className="text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-display font-semibold text-foreground">
                          {t(actionLabels[entry.action] ?? entry.action)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {playerName} · {entry.actor_email ?? t("parentalConsentPage.audit.system")}
                        </p>
                      </div>
                      <span className="text-[9px] text-muted-foreground">
                        {new Date(entry.created_at).toLocaleDateString("es-ES", {
                          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
                        })}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Pedir la firma al tutor / retirar (acciones reales en el servidor) */}
      <AnimatePresence>
        {consentAction && selectedPlayer && (
          <ConsentActionModal
            player={selectedPlayer}
            status={statuses[selectedPlayer.id]}
            action={consentAction}
            onClose={closeModal}
            onRequested={handleRequested}
            onWithdraw={handleWithdraw}
            withdrawing={withdraw.isPending}
          />
        )}
      </AnimatePresence>

      {/* DSAR Modal */}
      <AnimatePresence>
        {showDSAR && selectedPlayer && (
          <DSARModal
            player={selectedPlayer}
            onClose={() => { setShowDSAR(false); setSelectedPlayer(null); }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
