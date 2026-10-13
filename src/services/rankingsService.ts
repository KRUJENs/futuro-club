/**
 * VITAS · Rankings Service
 * Fetches ranked players from API (server-side) with fallback to local PlayerService.
 */
import { PlayerService } from "@/services/real/playerService";
import { adaptPlayerForUI } from "@/services/real/adapters";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { phvGate, matchesTimingFilter, type MaturityTiming } from "@/lib/phv/phvGate";

export type SortField = "vsi" | "name" | "age" | "percentile";
export type SortDir = "asc" | "desc";

export interface RankingsFilters {
  /** "all" | "late" | "on_time" | "early": TIMING vs pares (lo que rotula la fila), no la fase PHV. */
  timing?: string;
  position?: string;   // Position string or "Todos"
  ageGroup?: string;   // "Sub-14", etc. or "all"
  level?: string;      // Competitive level or "all"
  search?: string;     // Name search
}

export interface RankingsResponse {
  players: RankedPlayer[];
  total: number;
  totalUnfiltered: number;
  ageGroups: string[];
  ageGroupStats: Record<
    string,
    { count: number; avgVsi: number | null; minVsi: number | null; maxVsi: number | null }
  >;
  competitiveLevels: string[];
  limit: number;
  offset: number;
}

export interface RankedPlayer {
  id: string;
  name: string;
  age: number;
  position: string;
  secondaryPositions?: string[];          // polivalencia
  positionShort: string;
  vsi: number | null;                     // null ⇒ sin evaluar
  phvCategory: string | null;             // null ⇒ PHV bloqueado (gate único)
  phvOffset: number | null;
  /** Timing vs pares del gate único (null ⇒ gate cerrado). Es lo que filtra `timing`. */
  phvTiming?: MaturityTiming | null;
  /** Motivo del gate PHV del servidor (qué falta) cuando phvCategory es null. */
  phvGateReason?: string | null;
  competitiveLevel: string;
  ageGroup: string;
  trending: "up" | "down" | "stable";
  percentile: number | null;              // null si sin evaluar
  percentileInAgeGroup: number | null;    // null si sin evaluar
  updatedAt: string;
  metrics: Record<string, number>;
  foot: string;
  height: number | null;
  weight: number | null;
  // ── Inputs de maduración (para playerMaturity → PHV/timing en el ranking) ──
  // Sin `gender`, playerMaturity marca "sexo no registrado" y el timing sale
  // "por determinar" para TODOS. Se arrastran desde el jugador crudo.
  gender?: "M" | "F";
  sittingHeight?: number;
  legLength?: number;
  motherHeightCm?: number;
  fatherHeightCm?: number;
  birthDate?: string;
}

/**
 * Fetch ranked players from the server-side API.
 * Falls back to local PlayerService if API unavailable.
 */
export async function fetchRankedPlayers(
  sortBy: SortField = "vsi",
  dir: SortDir = "desc",
  filters: RankingsFilters = {},
  limit = 50,
  offset = 0
): Promise<RankingsResponse> {
  // Try API first when Supabase is configured
  if (SUPABASE_CONFIGURED) {
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (token) {
        const params = new URLSearchParams({
          sort: sortBy,
          dir,
          limit: String(limit),
          offset: String(offset),
        });
        if (filters.timing && filters.timing !== "all") params.set("timing", filters.timing);
        if (filters.position && filters.position !== "Todos") params.set("position", filters.position);
        if (filters.ageGroup && filters.ageGroup !== "all") params.set("ageGroup", filters.ageGroup);
        if (filters.level && filters.level !== "all") params.set("level", filters.level);
        if (filters.search) params.set("search", filters.search);

        const res = await fetch(`/api/rankings/list?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const body = await res.json();
          return body.data ?? body;
        }
      }
    } catch {
      // Fallback to local
    }
  }

  // Fallback: local PlayerService
  return fetchLocalRankedPlayers(sortBy, dir, filters);
}

/** Local fallback using PlayerService (localStorage) */
function fetchLocalRankedPlayers(
  sortBy: SortField,
  dir: SortDir,
  filters: RankingsFilters
): RankingsResponse {
  const players = PlayerService.getAll();
  const sorted = PlayerService.sort(players, sortBy === "percentile" ? "vsi" : sortBy, dir);
  const uiPlayers = sorted.map(adaptPlayerForUI);

  // Calculate VSIs for percentiles — excluye jugadores sin evaluar (vsi null).
  const allVSIs = uiPlayers
    .map((p) => p.vsi)
    .filter((v): v is number => v !== null);

  const AGE_GROUPS: Record<string, [number, number]> = {
    "Sub-10": [8, 10], "Sub-12": [11, 12], "Sub-14": [13, 14],
    "Sub-16": [15, 16], "Sub-18": [17, 18], "Sub-21": [19, 21],
  };

  function getAgeGroup(age: number): string {
    for (const [label, [min, max]] of Object.entries(AGE_GROUPS)) {
      if (age >= min && age <= max) return label;
    }
    return "Sub-21";
  }

  function percentileRank(value: number, allValues: number[]): number {
    if (allValues.length <= 1) return 100;
    const below = allValues.filter((v) => v < value).length;
    const equal = allValues.filter((v) => v === value).length;
    return Math.round(((below + equal * 0.5) / allValues.length) * 100);
  }

  // Group VSIs by age group — solo evaluados para avg/percentiles; el conteo
  // por grupo cuenta a todos.
  const vsiByAgeGroup: Record<string, number[]> = {};
  const countByAgeGroup: Record<string, number> = {};
  const enriched: RankedPlayer[] = uiPlayers.map((p, i) => {
    const raw = sorted[i]; // jugador CRUDO (mismo índice) → tiene sexo/antropometría
    const ageGroup = getAgeGroup(p.age);
    countByAgeGroup[ageGroup] = (countByAgeGroup[ageGroup] ?? 0) + 1;
    if (p.vsi !== null) {
      if (!vsiByAgeGroup[ageGroup]) vsiByAgeGroup[ageGroup] = [];
      vsiByAgeGroup[ageGroup].push(p.vsi);
    }
    const row = {
      id: p.id,
      name: p.name,
      age: p.age,
      position: p.position,
      secondaryPositions: (p as unknown as { secondaryPositions?: string[] }).secondaryPositions,
      positionShort: p.positionShort ?? p.position.slice(0, 3).toUpperCase(),
      vsi: p.vsi,
      // Sin default «on-time»/0: sin PHV gateado (adaptPlayerForUI ya retira la
      // categoría persistida no recalculable) ⇒ null, no se inventa una fase.
      phvCategory: p.phvCategory ?? null,
      phvOffset: p.phvOffset ?? null,
      // Del jugador CRUDO: el adaptador de UI no conserva estos campos (antes salía
      // siempre "Regional"/"right" por defecto aunque la ficha tuviera otro valor).
      competitiveLevel: raw?.competitiveLevel, // sin nivel registrado ⇒ undefined, no «Regional»
      ageGroup,
      trending: p.trending ?? "stable",
      // Sin evaluar ⇒ percentil null (no compite ni cuenta como 0).
      percentile: p.vsi === null ? null : percentileRank(p.vsi, allVSIs),
      percentileInAgeGroup: null, // calculated below
      updatedAt: p.lastActive ?? new Date().toISOString(),
      metrics: p.stats ?? {},
      foot: raw?.foot, // sin pie registrado ⇒ undefined, no «right» por defecto (inv #2)
      // Entradas del gate PHV que Rankings recalcula: sin default 170/60 (inv #2).
      height: raw?.height ?? null,
      weight: raw?.weight ?? null,
      // Maduración desde el jugador crudo (el adaptador UI no los arrastra) → así
      // playerMaturity calcula PHV/timing en el ranking en vez de "por determinar".
      gender: raw?.gender,
      sittingHeight: raw?.sittingHeight,
      legLength: raw?.legLength,
      motherHeightCm: raw?.motherHeightCm,
      fatherHeightCm: raw?.fatherHeightCm,
      birthDate: raw?.birthDate,
    } as RankedPlayer;
    // Timing con el MISMO gate y las MISMAS entradas que pinta la fila (Rankings.tsx).
    const g = phvGate(row);
    row.phvTiming = g.ok ? g.assessment.timing : null;
    return row;
  });

  // Calculate age group percentiles (sin evaluar queda null)
  for (const p of enriched) {
    p.percentileInAgeGroup =
      p.vsi === null ? null : percentileRank(p.vsi, vsiByAgeGroup[p.ageGroup] ?? allVSIs);
  }

  // Apply filters
  let filtered = enriched;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
  }
  if (filters.timing && filters.timing !== "all") {
    filtered = filtered.filter((p) => matchesTimingFilter(p.phvTiming, filters.timing));
  }
  if (filters.position && filters.position !== "Todos") {
    // Incluye también jugadores que tienen la posición como secundaria (polivalencia)
    filtered = filtered.filter((p) => {
      const raw = p as unknown as { secondaryPositions?: string[] };
      const secondary = raw.secondaryPositions ?? [];
      return p.position === filters.position || secondary.includes(filters.position!);
    });
  }
  if (filters.ageGroup && filters.ageGroup !== "all") {
    filtered = filtered.filter((p) => p.ageGroup === filters.ageGroup);
  }
  if (filters.level && filters.level !== "all") {
    filtered = filtered.filter(
      (p) => (p.competitiveLevel ?? "").toLowerCase() === filters.level!.toLowerCase()
    );
  }

  // Age group stats — count = todos; avg/min/max solo evaluados (null si ninguno).
  const ageGroupStats: RankingsResponse["ageGroupStats"] = {};
  for (const [group, count] of Object.entries(countByAgeGroup)) {
    const vsis = vsiByAgeGroup[group] ?? [];
    ageGroupStats[group] = {
      count,
      avgVsi: vsis.length > 0 ? Math.round((vsis.reduce((a, b) => a + b, 0) / vsis.length) * 10) / 10 : null,
      minVsi: vsis.length > 0 ? Math.min(...vsis) : null,
      maxVsi: vsis.length > 0 ? Math.max(...vsis) : null,
    };
  }

  return {
    players: filtered,
    total: filtered.length,
    totalUnfiltered: enriched.length,
    ageGroups: Object.keys(countByAgeGroup),
    ageGroupStats,
    competitiveLevels: [...new Set(enriched.map((p) => p.competitiveLevel).filter((l): l is string => !!l))],
    limit: filtered.length,
    offset: 0,
  };
}
