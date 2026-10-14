/**
 * VITAS · IDPIndexPage
 * /idp  (sin playerId)
 *
 * Entry point cuando el usuario llega al módulo IDP sin un jugador específico.
 * Comportamiento:
 *   - 0 jugadores → CTA "Crear primer jugador" → /players/new
 *   - 1 jugador  → redirect automático a /idp/<id>
 *   - 2+         → grid selector (foto + nombre + posición)
 *
 * Esto permite tener una entrada limpia en BottomNav sin acoplar a un
 * playerId fijo. Funciona igual con Samu como único jugador (auto-redirect)
 * o con 20 jugadores del club (picker).
 */

import { useEffect } from "react";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Target, UserPlus, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { useAllPlayers } from "@/hooks/usePlayers";
import { usePlan } from "@/hooks/usePlan";

export default function IDPIndexPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { canUseIDP } = usePlan();

  // Fuente reactiva (Supabase) en vez de un snapshot de localStorage congelado
  // en useMemo([]): antes /idp podía quedarse en "sin jugadores" tras un
  // refresh/deep-link si el pull aún no había terminado.
  const { data: players = [], isLoading: playersLoading } = useAllPlayers();

  // Auto-redirect if only one player (espera a que carguen)
  useEffect(() => {
    if (canUseIDP && !playersLoading && players.length === 1) {
      navigate(`/idp/${players[0].id}`, { replace: true });
    }
  }, [canUseIDP, playersLoading, players, navigate]);

  // Feature gate
  if (!canUseIDP) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <header className="sticky top-0 z-30 glass-strong border-b border-border">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft size={18} />
            </Button>
            <div className="flex items-center gap-2">
              <Target size={18} className="text-cyan-400" />
              <h1 className="text-lg font-display font-bold">{t("idpIndexPage.title")}</h1>
            </div>
          </div>
        </header>
        <main className="max-w-3xl lg:max-w-5xl mx-auto px-4 py-16 text-center">
          <Sparkles className="size-8 text-amber-400 mx-auto mb-3" />
          <h2 className="text-xl font-semibold text-foreground mb-2">{t("idpIndexPage.proFeature")}</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
            {t("idpIndexPage.proFeatureDescription")}
          </p>
          <Button onClick={() => navigate("/billing")}>{t("idpIndexPage.viewPlans")}</Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-30 glass-strong border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={18} />
          </Button>
          <div className="flex items-center gap-2">
            <Target size={18} className="text-cyan-400" />
            <h1 className="text-lg font-display font-bold">{t("idpIndexPage.title")}</h1>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {playersLoading ? (
          // ── Cargando jugadores ──
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 text-cyan-400 animate-spin" />
          </div>
        ) : players.length === 0 ? (
          // ── 0 players ──
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-10 text-center">
            <UserPlus className="size-10 text-cyan-400 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {t("idpIndexPage.noPlayersTitle")}
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5">
              {t("idpIndexPage.noPlayersDescription")}
            </p>
            <Button onClick={() => navigate("/players/new")}>
              {t("idpIndexPage.createFirstPlayer")}
            </Button>
          </div>
        ) : (
          // ── 2+ players: picker ──
          <div>
            <div className="mb-5">
              <h2 className="text-base font-semibold text-foreground">
                {t("idpIndexPage.selectPlayer")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("idpIndexPage.selectPlayerDescription")}
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {players.map((p, i) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <Link
                    to={`/idp/${p.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl border border-white/10 bg-white/[0.02] hover:border-cyan-400/30 hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="size-10 rounded-full bg-gradient-to-br from-cyan-500 to-purple-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
                      {(p.name ?? "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">
                        {p.name}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <Badge variant="outline" className="text-[10px] capitalize px-1.5 py-0">
                          {p.position}
                        </Badge>
                        {p.age && <span>{t("idpIndexPage.years", { count: p.age })}</span>}
                        <span>· {coachEvalInline(t, typeof p.vsi === "number" ? p.vsi : null)}</span>
                      </div>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
