/**
 * VITAS — TeamPage
 * /equipo — Lista de miembros del equipo + invitaciones (plan Club).
 */

import { useState, useEffect, useMemo } from "react";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft, Users, Mail, Plus, Trash2, Clock, CheckCircle2, XCircle,
  Sparkles, Grid3x3, Activity, Swords, ClipboardList,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useUserProfile } from "@/hooks/useUserProfile";
import { RoleGuard } from "@/components/RoleGuard";
import { useAuth } from "@/context/AuthContext";
import { useTeamMembers, useTeamInvitations, useInviteMember, useRemoveMember, useCancelInvitation } from "@/hooks/useTeam";
import { ROLE_LABELS, type UserRole } from "@/services/real/userProfileService";
import { PlanGuard } from "@/components/PlanGuard";
import { useTranslation } from "react-i18next";
import { PlayerService, type Player } from "@/services/real/playerService";
import { EmptyPlayers } from "@/components/illustrations/EmptyIllustrations";
import { phvGate, type PhvCategory } from "@/lib/phv/phvGate";
import { usePhvGateText } from "@/components/phv/PhvGateNotice";
import { RelativeAgeCard } from "@/components/team/RelativeAgeCard";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

export default function TeamPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile, isDirector } = useUserProfile();
  const orgOwnerId = user?.id ?? "";

  const { data: members = [], isLoading: membersLoading } = useTeamMembers(orgOwnerId);
  const { data: invitations = [], isLoading: invLoading } = useTeamInvitations(orgOwnerId);

  const inviteMutation = useInviteMember(orgOwnerId);
  const removeMutation = useRemoveMember(orgOwnerId);
  const cancelMutation = useCancelInvitation(orgOwnerId);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("scout");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [myPlayers, setMyPlayers] = useState<Player[]>([]);

  // Cargar jugadores del coach (localStorage · ya filtrados por user via PlayerService)
  useEffect(() => {
    const loadPlayers = () => {
      const all = PlayerService.getAll();
      // Ordenar por VSI desc reusando el sort canónico null-safe de PlayerService
      // (invariante #2 + #7): los jugadores sin evaluar (vsi null) van al FINAL,
      // no se ordenan como 0. Antes: Number(b.vsi || 0) coaccionaba el hueco a 0.
      const sorted = PlayerService.sort(all, "vsi", "desc");
      setMyPlayers(sorted);
    };
    loadPlayers();
    // Refrescar cuando vuelve la pestaña al foco
    const onFocus = () => loadPlayers();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Edad relativa (P2 bloque 8): solo jugadores reales; los de ejemplo nunca se mezclan
  // con ellos (misma regla que los percentiles).
  const raeBirthDates = useMemo(() => myPlayers.filter((p) => p.isDemo !== true).map((p) => p.birthDate), [myPlayers]);

  // Etapa PHV SOLO desde el gate único (regla del owner 28-sep): sin todas las
  // entradas introducidas no se rotula Pre/En/Post-PHV — se nombra qué falta. Antes
  // se pintaba el phvCategory PERSISTIDO (naive/estancado para un menor sin medidas).
  const phvGateText = usePhvGateText();
  const phvIcon = (cat: PhvCategory | null) => {
    if (cat === "early") return "🟢";
    if (cat === "ontme") return "🟡";
    if (cat === "late") return "🔵";
    return "⚪";
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      await inviteMutation.mutateAsync({ email: inviteEmail.trim(), role: inviteRole });
      toast.success(t("toasts.invitationSent", { email: inviteEmail.trim() }));
      setInviteEmail("");
      setSheetOpen(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t("toasts.invitationSendError"));
    }
  };

  const handleRemove = async (memberId: string, name?: string) => {
    try {
      await removeMutation.mutateAsync(memberId);
      toast.success(t("toasts.memberRemoved", { name: name ?? t("teamPage.memberFallback") }));
    } catch {
      toast.error(t("toasts.memberRemoveError"));
    }
  };

  const handleCancel = async (invId: string) => {
    try {
      await cancelMutation.mutateAsync(invId);
      toast.success(t("toasts.invitationCanceled"));
    } catch {
      toast.error(t("toasts.invitationCancelError"));
    }
  };

  const pendingInvitations = invitations.filter((i) => i.status === "pending");

  return (
    <RoleGuard
      roles={["director", "scout"]}
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="text-center space-y-3">
            <Users size={32} className="text-muted-foreground mx-auto" />
            <p className="font-display font-bold text-lg text-foreground">{t("teamPage.accessRestricted")}</p>
            <p className="text-sm text-muted-foreground">{t("teamPage.accessRestrictedDesc")}</p>
          </div>
        </div>
      }
    >
    <PlanGuard feature="roles">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="px-4 pt-4 pb-28 space-y-6 max-w-lg lg:max-w-5xl mx-auto"
      >
        {/* Header */}
        <motion.div variants={item} className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1">
            <h1 className="font-display font-bold text-2xl text-foreground">
              {t("team.title").replace(".", "")}<span className="text-primary">.</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              {profile?.organizationName ?? t("team.myOrg")}
            </p>
          </div>
          {isDirector && (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button size="sm" className="gap-1.5">
                  <Plus size={13} /> {t("team.invite")}
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
                <SheetHeader className="mb-4">
                  <SheetTitle className="font-display">{t("team.inviteMember")}</SheetTitle>
                </SheetHeader>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-display text-muted-foreground uppercase tracking-wider">
                      {t("team.emailLabel")}
                    </label>
                    <Input
                      type="email"
                      placeholder={t("team.emailPlaceholder")}
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-display text-muted-foreground uppercase tracking-wider">
                      {t("team.roleLabel")}
                    </label>
                    <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as UserRole)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="scout">{t("team.roles.scout")}</SelectItem>
                        <SelectItem value="coach">{t("team.roles.coach")}</SelectItem>
                        <SelectItem value="viewer">{t("team.roles.viewer")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleInvite}
                    disabled={!inviteEmail.trim() || inviteMutation.isPending}
                  >
                    {inviteMutation.isPending ? t("team.sendingInvitation") : t("team.sendInvitation")}
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          )}
        </motion.div>

        {/* CTA · Match-day Live Mode */}
        <motion.button
          variants={item}
          onClick={() => navigate("/live")}
          className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border-2 border-electric/40"
        >
          <div className="w-9 h-9 rounded-lg bg-electric/20 border border-electric/40 flex items-center justify-center shrink-0">
            <Activity size={16} className="text-electric" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-display font-bold text-foreground flex items-center gap-1.5">
              Match-day Live
              <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-electric/20 text-electric border border-electric/40">
                {t("teamPage.killerFeature")}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {t("teamPage.liveModeDesc")}
            </p>
          </div>
          <span className="text-[10px] text-electric font-bold">→</span>
        </motion.button>

        {/* CTA · Plan vs Rival */}
        <motion.button
          variants={item}
          onClick={() => navigate("/equipo/rival")}
          className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border border-amber-500/40"
        >
          <div className="w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
            <Swords size={16} className="text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-display font-bold text-foreground flex items-center gap-1.5">
              Plan vs Rival
              <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40">
                <Sparkles size={9} className="inline -mt-0.5 mr-0.5" />{t("teamPage.new")}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {t("teamPage.rivalPlanDesc")}
            </p>
          </div>
          <span className="text-[10px] text-amber-400 font-bold">→</span>
        </motion.button>

        {/* CTA · Partido A vs B (team-report) */}
        <motion.button
          variants={item}
          onClick={() => navigate("/equipo/partido")}
          className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border border-electric/40"
        >
          <div className="w-9 h-9 rounded-lg bg-electric/20 border border-electric/40 flex items-center justify-center shrink-0">
            <ClipboardList size={16} className="text-electric" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-display font-bold text-foreground flex items-center gap-1.5">
              {t("teamPage.matchReport")}
              <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-electric/20 text-electric border border-electric/40">
                <Sparkles size={9} className="inline -mt-0.5 mr-0.5" />{t("teamPage.new")}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {t("teamPage.matchReportDesc")}
            </p>
          </div>
          <span className="text-[10px] text-electric font-bold">→</span>
        </motion.button>

        {/* CTA · Análisis táctico baseline */}
        <motion.button
          variants={item}
          onClick={() => navigate("/equipo/baseline")}
          className="w-full glass rounded-xl p-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left border border-primary/30"
        >
          <div className="w-9 h-9 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
            <Grid3x3 size={16} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-display font-bold text-foreground flex items-center gap-1.5">
              {t("teamPage.tacticalAnalysis")}
              <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30">
                <Sparkles size={9} className="inline -mt-0.5 mr-0.5" />{t("teamPage.new")}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {t("teamPage.tacticalAnalysisDesc")}
            </p>
          </div>
          <span className="text-[10px] text-primary font-bold">→</span>
        </motion.button>

        {/* Tus jugadores · clicables */}
        <motion.div variants={item}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Users size={13} /> {t("teamPage.yourPlayers", { count: myPlayers.length })}
            </h2>
            <button
              onClick={() => navigate("/players/new")}
              className="text-[10px] text-primary font-display font-bold flex items-center gap-1 hover:text-primary/80 transition-colors"
            >
              <Plus size={11} /> {t("teamPage.new")}
            </button>
          </div>
          {myPlayers.length === 0 ? (
            <button
              onClick={() => navigate("/players/new")}
              className="w-full glass rounded-xl p-6 text-center hover:bg-secondary/30 transition-colors space-y-3"
            >
              <EmptyPlayers className="w-32 mx-auto" />
              <div>
                <p className="text-base font-bold text-foreground">{t("teamPage.addFirstPlayer")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t("teamPage.playerMetrics")}</p>
              </div>
            </button>
          ) : (
            <div className="glass rounded-xl divide-y divide-border">
              {myPlayers.slice(0, 10).map((p) => {
                const phv = phvGate(p);
                return (
                <button
                  key={p.id}
                  onClick={() => navigate(`/players/${p.id}`)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-secondary/30 transition-colors text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-display font-bold text-primary shrink-0">
                    {p.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-display font-semibold text-foreground truncate">
                      {p.name} <span className="text-muted-foreground font-normal">· {p.age}a · {p.position}{p.secondaryPositions && p.secondaryPositions.length > 0 ? ` / ${p.secondaryPositions.join(" / ")}` : ""}</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {coachEvalInline(t, p.vsi == null ? null : Number(p.vsi))} {phvIcon(phv.category)}
                      {phv.ok
                        ? ` · ${phv.category === "early" ? t("teamPage.prePhv") : phv.category === "late" ? t("teamPage.postPhv") : t("teamPage.inPhv")}`
                        : <span data-testid="phv-gate-notice"> · {phvGateText({ gate: phv })}</span>}
                    </p>
                  </div>
                  <span className="text-[10px] text-primary font-bold">→</span>
                </button>
                );
              })}
              {myPlayers.length > 10 && (
                <button
                  onClick={() => navigate("/rankings")}
                  className="w-full p-3 text-center text-[11px] font-display font-bold text-primary hover:bg-secondary/30 transition-colors"
                >
                  {t("teamPage.viewAll", { count: myPlayers.length })} →
                </button>
              )}
            </div>
          )}
        </motion.div>

        {/* Edad relativa de la plantilla (P2 bloque 8): señal, no veredicto */}
        {raeBirthDates.length > 0 && (
          <motion.div variants={item}>
            <RelativeAgeCard birthDates={raeBirthDates} />
          </motion.div>
        )}

        {/* Miembros activos */}
        <motion.div variants={item}>
          <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Users size={13} /> {t("team.activeMembers")}
          </h2>
          {membersLoading ? (
            <div className="glass rounded-xl p-4 text-center text-sm text-muted-foreground">
              {t("team.loadingMembers")}
            </div>
          ) : members.length === 0 ? (
            <div className="glass rounded-xl p-6 text-center text-sm text-muted-foreground">
              {t("team.noMembers")}
            </div>
          ) : (
            <div className="glass rounded-xl divide-y divide-border">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 p-3">
                  <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-display font-bold text-primary">
                    {m.memberId.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-display font-semibold text-foreground">
                      {m.displayName ?? m.memberId.slice(0, 8) + "…"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {ROLE_LABELS[m.role]} · {t("team.since")} {new Date(m.joinedAt).toLocaleDateString("es-ES")}
                    </p>
                  </div>
                  {isDirector && m.memberId !== orgOwnerId && (
                    <button
                      onClick={() => handleRemove(m.memberId)}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Invitaciones pendientes */}
        {(pendingInvitations.length > 0 || invLoading) && (
          <motion.div variants={item}>
            <h2 className="font-display font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
              <Mail size={13} /> {t("team.pendingInvitations")}
            </h2>
            {invLoading ? (
              <div className="glass rounded-xl p-4 text-center text-sm text-muted-foreground">
                {t("team.loadingInvitations")}
              </div>
            ) : (
              <div className="glass rounded-xl divide-y divide-border">
                {pendingInvitations.map((inv) => {
                  const expired = new Date(inv.expiresAt) < new Date();
                  return (
                    <div key={inv.id} className="flex items-center gap-3 p-3">
                      {expired ? (
                        <XCircle size={16} className="text-muted-foreground shrink-0" />
                      ) : (
                        <Clock size={16} className="text-yellow-500 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-display text-foreground truncate">{inv.email}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {ROLE_LABELS[inv.role]} · {t("team.expires")} {new Date(inv.expiresAt).toLocaleDateString("es-ES")}
                        </p>
                      </div>
                      {isDirector && (
                        <button
                          onClick={() => handleCancel(inv.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1"
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}

        {/* Info */}
        <motion.div variants={item} className="glass rounded-xl p-4 flex items-start gap-3">
          <CheckCircle2 size={16} className="text-primary shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            {t("team.inviteInfo")}
          </p>
        </motion.div>
      </motion.div>
    </PlanGuard>
    </RoleGuard>
  );
}
