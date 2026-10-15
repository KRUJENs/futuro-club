/**
 * VITAS · Global Search · ⌘K Command Palette (Sprint UX · día 1)
 *
 * Atajo de teclado: ⌘K (Mac) / Ctrl+K (Win/Linux)
 * Botón visible en topbar / FAB en móvil
 *
 * Indexa:
 *   - Jugadores (nombre, posición, edad)
 *   - Partidos live (rival, fecha)
 *   - Acciones rápidas (generar baseline, plan rival, match-day, etc.)
 *   - Páginas core (rankings, scout, equipo, lab)
 *
 * Diseño:
 *   - Top results agrupados por categoría
 *   - Keyboard-driven · Enter para ir, ↑↓ para navegar
 *   - Sugerencias contextuales si query vacío
 */

import { useEffect, useState, useMemo } from "react";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Command as CommandPrimitive, CommandDialog, CommandEmpty, CommandGroup,
  CommandInput, CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import {
  Users, Activity, Swords, Grid3x3, Zap, BarChart3, Target,
  Sparkles, Trophy, FileText, Search, Heart, Briefcase, Brain, Eye, ClipboardList,
} from "lucide-react";
import { useAllPlayers } from "@/hooks/usePlayers";

interface QuickAction {
  id: string;
  label: string;
  hint: string;
  Icon: React.ElementType;
  to: string;
  keywords?: string[];
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: "match-day",  label: "Match-day Live",     hint: "Tagear eventos en directo", Icon: Activity, to: "/live",            keywords: ["partido","live","directo","cronometro"] },
  { id: "rival",      label: "Plan vs Rival",      hint: "Plan de partido + drills",  Icon: Swords,   to: "/equipo/rival",    keywords: ["rival","oponente","compare","plan"] },
  { id: "match",      label: "Partido A vs B",     hint: "Informe táctico comparativo", Icon: ClipboardList, to: "/equipo/partido", keywords: ["partido","match","informe","tactico","comparar","equipos"] },
  { id: "team-base",  label: "Análisis táctico",   hint: "5 reportes equipo · 9 cuadrantes", Icon: Grid3x3, to: "/equipo/baseline", keywords: ["equipo","tactico","cuadrantes","baseline"] },
  { id: "lab",        label: "VITAS.LAB",          hint: "Subir vídeo y analizar",    Icon: Zap,      to: "/lab",             keywords: ["video","analizar","lab","subir"] },
  { id: "rankings",   label: "Rankings",           hint: "Tus jugadores por evaluación del entrenador",     Icon: BarChart3,to: "/rankings",        keywords: ["jugadores","ranking","vsi","evaluacion","entrenador","listado"] },
  { id: "scout",      label: "Scout",              hint: "Insights IA tiempo real",   Icon: Target,   to: "/scout",           keywords: ["scout","insights","feed"] },
  { id: "pulse",      label: "Pulse",              hint: "Centro de inteligencia",    Icon: Sparkles, to: "/pulse",           keywords: ["dashboard","home","inicio"] },
  { id: "team-mgmt",  label: "Mi equipo",          hint: "Miembros + invitaciones",   Icon: Users,    to: "/equipo",          keywords: ["miembros","equipo","gestion"] },
  { id: "idp",        label: "Plan IDP",           hint: "Plan de desarrollo mensual", Icon: Target,  to: "/idp",             keywords: ["idp","plan","desarrollo","objetivos","goals","metas"] },
  { id: "tactical",   label: "Heatmap táctico",    hint: "6 fases + insights IA",     Icon: Activity, to: "/tactical",        keywords: ["tactico","heatmap","fases","calor","mapa"] },
  { id: "transfer",   label: "Transfer Market",    hint: "Marketplace + matchmaking IA", Icon: Briefcase, to: "/transfer",     keywords: ["transfer","fichaje","mercado","marketplace","cesion"] },
  { id: "mental",     label: "ADN Mental",         hint: "Perfil mental · 7 dimensiones", Icon: Brain, to: "/behavioral",      keywords: ["mental","arquetipo","adn","comportamiento","psicologia"] },
  { id: "wellbeing",  label: "Bienestar",          hint: "Riesgo de abandono · engagement", Icon: Heart, to: "/wellbeing",    keywords: ["bienestar","retencion","abandono","dropout","engagement"] },
  { id: "scanning",   label: "Scanning IQ",        hint: "Escaneo previo a recepción", Icon: Eye,     to: "/scanning",        keywords: ["scanning","escaneo","scan","vision","cabeza"] },
];

// Rutas públicas/auth donde el buscador (que navega a rutas protegidas) no debe
// mostrarse — coherente con BottomNav y ContextualFAB, que sí se ocultan aquí.
const HIDDEN_ON = [
  /^\/$/, /^\/login/, /^\/register/, /^\/forgot/, /^\/reset/,
  /^\/pricing/, /^\/terms/, /^\/privacy/, /^\/share/, /^\/aceptar-invitacion/,
];

export default function GlobalSearch() {
  const { t } = useTranslation();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { data: players = [] } = useAllPlayers();

  // ⌘K / Ctrl+K listener
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filtered players
  const filteredPlayers = useMemo(() => {
    if (!query) return players.slice(0, 5);
    const q = query.toLowerCase();
    return players
      .filter((p) =>
        p.name?.toLowerCase().includes(q) ||
        p.position?.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [players, query]);

  function go(to: string) {
    setOpen(false);
    setQuery("");
    navigate(to);
  }

  // Oculto en rutas públicas/auth (tras los hooks para no romper su orden).
  if (HIDDEN_ON.some((re) => re.test(location.pathname))) return null;

  return (
    <>
      {/* Floating search trigger · bottom-left, en espejo del FAB "+" (bottom-right).
          Antes era top-right y se solapaba con las acciones de cabecera de cada
          página (p.ej. "Generar insights", Compartir/PDF/Editar). Bottom-left es una
          ranura flotante libre, por encima de la BottomNav (docx #4/#5). */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-20 left-4 z-50 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-background/85 backdrop-blur-md border border-border shadow-lg hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors print:hidden"
        aria-label={t("globalSearch.triggerAriaLabel")}
        title={t("globalSearch.triggerTitle")}
      >
        <Search size={12} />
        <span className="hidden sm:inline text-[10px] font-display">{t("globalSearch.searchLabel")}</span>
        <kbd className="hidden md:inline-block ml-1 px-1 py-0.5 rounded bg-secondary text-[8px] font-mono text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandPrimitive shouldFilter={false}>
          <CommandInput
            placeholder={t("globalSearch.inputPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{t("globalSearch.noResults")}</CommandEmpty>

            {/* Acciones rápidas */}
            <CommandGroup heading={t("globalSearch.quickActionsHeading")}>
              {QUICK_ACTIONS.filter((a) => {
                if (!query) return true;
                const q = query.toLowerCase();
                return (
                  a.label.toLowerCase().includes(q) ||
                  a.hint.toLowerCase().includes(q) ||
                  a.keywords?.some((k) => k.includes(q))
                );
              }).map((a) => {
                const Icon = a.Icon;
                return (
                  <CommandItem
                    key={a.id}
                    onSelect={() => go(a.to)}
                    className="flex items-center gap-3 cursor-pointer"
                  >
                    <Icon size={14} className="text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-display font-bold">{a.label}</div>
                      <div className="text-[10px] text-muted-foreground">{a.hint}</div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>

            {filteredPlayers.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={t("globalSearch.playersHeading", { count: filteredPlayers.length })}>
                  {filteredPlayers.map((p) => (
                    <CommandItem
                      key={p.id}
                      onSelect={() => go(`/players/${p.id}`)}
                      className="flex items-center gap-3 cursor-pointer"
                    >
                      <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-[10px] font-display font-bold text-primary shrink-0">
                        {p.name?.[0]?.toUpperCase() ?? "?"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-display font-bold truncate">{p.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {p.position ?? "?"} · {p.age ?? "?"}a · {coachEvalInline(t, p.vsi == null ? null : Number(p.vsi))}
                        </div>
                      </div>
                      <span className="text-[9px] text-muted-foreground shrink-0">{t("globalSearch.goToProfile")}</span>
                    </CommandItem>
                  ))}
                  {/* Atajo: rapido a reports / live / family */}
                  {filteredPlayers.length === 1 && (
                    <>
                      <CommandItem
                        onSelect={() => go(`/family/${filteredPlayers[0].id}`)}
                        className="flex items-center gap-3 cursor-pointer pl-12"
                      >
                        <Heart size={12} className="text-pink-400 shrink-0" />
                        <span className="text-[11px] text-foreground">
                          {t("globalSearch.familyView", { name: filteredPlayers[0].name })}
                        </span>
                      </CommandItem>
                      <CommandItem
                        onSelect={() => go(`/players/${filteredPlayers[0].id}/reports`)}
                        className="flex items-center gap-3 cursor-pointer pl-12"
                      >
                        <FileText size={12} className="text-electric shrink-0" />
                        <span className="text-[11px] text-foreground">
                          {t("globalSearch.viewReports", { name: filteredPlayers[0].name })}
                        </span>
                      </CommandItem>
                      <CommandItem
                        onSelect={() => go(`/players/${filteredPlayers[0].id}/evolution`)}
                        className="flex items-center gap-3 cursor-pointer pl-12"
                      >
                        <Trophy size={12} className="text-gold shrink-0" />
                        <span className="text-[11px] text-foreground">
                          {t("globalSearch.viewEvolution", { name: filteredPlayers[0].name })}
                        </span>
                      </CommandItem>
                    </>
                  )}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </CommandPrimitive>
      </CommandDialog>
    </>
  );
}
