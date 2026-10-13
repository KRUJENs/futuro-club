/**
 * VITAS · Rankings API — Server-side ranked player list
 * GET /api/rankings/list
 *
 * Features:
 * - Server-side pagination (limit/offset)
 * - Sort by VSI, age, name
 * - Filter by PHV category, position, age group, competitive level
 * - Percentile calculation per age group
 * - Total count for pagination
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { calculateFichaVsi } from "../../src/services/real/metricsService";
import { phvGate, matchesTimingFilter, type MaturityTiming, type PhvGateInput } from "../../src/lib/phv/phvGate";
import { vsiTrendArrow } from "../../src/lib/scoring/vsiDelta";

export const config = { runtime: "edge" };

/**
 * PHV del ranking desde el GATE ÚNICO (src/lib/phv/phvGate.ts · regla del owner
 * 28-sep): categoría/offset solo con TODAS las entradas introducidas del blob
 * (talla, peso, talla sentado, pierna, fecha de nacimiento → edad decimal, sexo).
 * Si falta alguna ⇒ null + phvGateReason. Antes: el phvCategory PERSISTIDO del
 * blob con default «ontme»/offset 0 (un pre-púber sin medidas salía «on-time»).
 */
function gatedPhvFields(d: Record<string, unknown>): {
  phvCategory: string | null;
  phvOffset: number | null;
  /** Timing vs pares del MISMO gate: lo que rotula la fila y lo que filtra `timing`. */
  phvTiming: MaturityTiming | null;
  phvGateReason: string | null;
} {
  const g = phvGate(d as PhvGateInput);
  return g.ok
    ? { phvCategory: mapPhv(g.category), phvOffset: g.offset.value, phvTiming: g.assessment.timing, phvGateReason: null }
    : { phvCategory: null, phvOffset: null, phvTiming: null, phvGateReason: g.gate_reason };
}

// VSI de ficha: pesos + fórmula en fuente ÚNICA src/services/real/metricsService.ts (invariante #7).

// ── Age Group definitions ────────────────────────────────────────────────
const AGE_GROUPS: Record<string, [number, number]> = {
  "Sub-10": [8, 10],
  "Sub-12": [11, 12],
  "Sub-14": [13, 14],
  "Sub-16": [15, 16],
  "Sub-18": [17, 18],
  "Sub-21": [19, 21],
};

function getAgeGroup(age: number): string {
  for (const [label, [min, max]] of Object.entries(AGE_GROUPS)) {
    if (age >= min && age <= max) return label;
  }
  return "Sub-21";
}

/** Calculate percentile rank within a sorted array of values */
function percentileRank(value: number, allValues: number[]): number {
  if (allValues.length <= 1) return 100;
  const below = allValues.filter((v) => v < value).length;
  const equal = allValues.filter((v) => v === value).length;
  return Math.round(((below + equal * 0.5) / allValues.length) * 100);
}

// ── Module-level cache (persists across requests in same Edge instance) ──
type PlayerRow = {
  id: string;
  name: string;
  age: number;
  position: string;
  positionShort: string;
  vsi: number | null; // null ⇒ "sin evaluar" (jugador sin evaluación del coach)
  // null ⇒ PHV bloqueado por el gate único (phvGateReason dice qué falta).
  phvCategory: string | null;
  phvOffset: number | null;
  phvTiming: MaturityTiming | null;
  phvGateReason: string | null;
  competitiveLevel: string | null; // null ⇒ nivel no registrado
  ageGroup: string;
  trending: "up" | "down" | "stable";
  percentile: number | null;         // null si sin evaluar
  percentileInAgeGroup: number | null; // null si sin evaluar
  updatedAt: string;
  metrics: Record<string, number>;
  foot: string | null; // null ⇒ pie no registrado
  height: number | null;
  weight: number | null;
  // Campos de maduración para que el cliente compute el timing canónico
  // (resolveMaturity) con la misma fuente en ambas rutas (RPC/fallback).
  // gender puede ser null: sexo no registrado ⇒ resolveMaturity abstiene (invariante #5).
  gender: "M" | "F" | null;
  birthDate: string | null;
  sittingHeight: number | null;
  legLength: number | null;
  motherHeightCm: number | null;
  fatherHeightCm: number | null;
};

/**
 * p_limit de la RPC cuando hay filtro PHV: la lista COMPLETA del usuario (el
 * filtro y la paginación se aplican aquí tras el gate). La ruta en memoria ya
 * carga todos los jugadores del usuario; esto no amplía qué se lee.
 */
const RPC_ALL_ROWS = 100_000;

const rankingsCache = new Map<string, { data: PlayerRow[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Handler ──────────────────────────────────────────────────────────────

export default withHandler(
  { method: "GET", requireAuth: true, maxRequests: 60 },
  async ({ req, userId }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse("Supabase not configured", 503, "CONFIG_ERROR");
    }

    if (!userId) {
      return errorResponse("User ID required", 401, "UNAUTHORIZED");
    }

    const url = new URL(req.url);
    const sortBy = url.searchParams.get("sort") ?? "vsi";
    const sortDir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    // Filters
    // PHV: "early" | "on-time" | "late" (se acepta también la forma interna "ontme").
    // Se filtra SIEMPRE sobre el recálculo del gate único (gatedPhvFields), nunca
    // sobre la categoría persistida: ver la ruta RPC.
    const phvParam = url.searchParams.get("phv");
    const phvFilter = phvParam && phvParam !== "all" ? mapPhv(phvParam) : null;
    // Filtro de la UI («Madurador tardío ⭐»): TIMING vs pares ("late" | "on_time" |
    // "early") sobre el MISMO timing gateado que rotula la fila. `phv` filtra la FASE.
    const timingParam = url.searchParams.get("timing");
    const timingFilter = timingParam && timingParam !== "all" ? timingParam : null;
    const gatedFilter = Boolean(phvFilter) || Boolean(timingFilter);
    const posFilter = url.searchParams.get("position"); // Position string
    const ageGroupFilter = url.searchParams.get("ageGroup"); // "Sub-14", etc.
    const levelFilter = url.searchParams.get("level"); // competitive level
    const search = url.searchParams.get("search")?.toLowerCase();

    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    };

    // Try RPC first (server-side percentiles, O(n) in Postgres)
    try {
      // La RPC filtra PHV por el phvCategory PERSISTIDO del blob (con default
      // 'ontme', 059) mientras la fila muestra el recálculo del gate: filtrar por
      // «early» devolvía a un pre-púber sin medidas rotulado «PHV no disponible».
      // Con filtro PHV se pide la lista completa ordenada SIN p_phv y se filtra +
      // pagina aquí, DESPUÉS del gate (misma fuente que muestra la fila y que la
      // ruta en memoria). Los percentiles siguen siendo los de la RPC.
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/get_ranked_players`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          p_user_id: userId,
          p_sort_by: sortBy,
          p_sort_dir: sortDir,
          p_limit: gatedFilter ? RPC_ALL_ROWS : limit,
          p_offset: gatedFilter ? 0 : offset,
          p_search: search || null,
          p_phv: null,
          p_position: posFilter || null,
          p_age_group: ageGroupFilter || null,
          p_level: levelFilter || null,
        }),
      });

      if (rpcRes.ok) {
        const rpcData = await rpcRes.json();
        // RPC returns the full response object directly
        // Map player data format to match existing API contract
        const mapped: Array<Record<string, unknown>> = (rpcData.players || []).map((p: Record<string, unknown>) => ({
          id: p.id,
          name: p.name,
          age: p.age,
          position: p.position,
          vsi: p.vsi == null ? null : Number(p.vsi), // no coaccionar null→0
          // Nivel SOLO del blob (lo sobrescribe el spread de `data` de abajo si existe): el
          // `competitive_level` que devuelve la RPC es `coalesce(data->>'competitiveLevel',
          // 'Regional')` (059) ⇒ un nivel inventado cuando falta; no se usa como dato
          // (P1 bloque 2, inv #2). El filtro por nivel y la lista de niveles de la RPC
          // siguen con ese coalesce (residuo P2: cambiar la RPC).
          competitiveLevel: null,
          ageGroup: p.age_group,
          percentile: p.percentile == null ? null : Math.round(Number(p.percentile)),
          percentileInAgeGroup:
            p.percentile_in_age_group == null ? null : Math.round(Number(p.percentile_in_age_group)),
          updatedAt: p.updated_at,
          ...((p.data || {}) as Record<string, unknown>),
          // DESPUÉS del spread del blob: el phvCategory/phvOffset persistido del
          // blob NO llega al cliente; solo el recálculo gateado (o null + motivo).
          ...gatedPhvFields((p.data || {}) as Record<string, unknown>),
        }));
        // Filtros fase/timing sobre lo GATEADO (lo que se muestra), no lo persistido.
        const matching = gatedFilter
          ? mapped.filter(
              (p) =>
                (!phvFilter || p.phvCategory === phvFilter) &&
                matchesTimingFilter(p.phvTiming as MaturityTiming | null, timingFilter),
            )
          : mapped;
        const players = gatedFilter ? matching.slice(offset, offset + limit) : mapped;

        return successResponse({
          players,
          total: gatedFilter ? matching.length : rpcData.total || 0,
          limit,
          offset,
          totalUnfiltered: rpcData.totalUnfiltered || 0,
          ageGroups: rpcData.ageGroups || [],
          ageGroupStats: rpcData.ageGroupStats || {},
          competitiveLevels: rpcData.competitiveLevels || [],
        });
      }
      // RPC failed — fall through to in-memory approach
      console.warn("[rankings] RPC failed, falling back to in-memory:", rpcRes.status);
    } catch (rpcErr) {
      console.warn("[rankings] RPC exception, falling back to in-memory:", rpcErr);
    }

    // ── Fallback: in-memory approach ──
    // Fetch ALL players for this user (needed for percentile calculations)
    // This is intentional — percentiles require the full dataset
    // Use module-level cache to avoid repeated DB fetches within the same Edge instance
    let allPlayers: PlayerRow[];

    const cacheKey = `rankings:${userId}`;
    const cached = rankingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      // Use cached data — skip DB fetch
      allPlayers = cached.data;
    } else {
      const allUrl = `${supabaseUrl}/rest/v1/players?user_id=eq.${userId}&select=id,data,updated_at`;
      const allRes = await fetch(allUrl, { headers: { ...headers, Prefer: "count=exact" } });

      if (!allRes.ok) {
        const errText = await allRes.text();
        return errorResponse(`Failed to fetch players: ${errText.slice(0, 200)}`, 500);
      }

      const allRows = (await allRes.json()) as Array<{
        id: string;
        data: Record<string, unknown>;
        updated_at: string;
      }>;

      // First pass: extract all players
      allPlayers = allRows.map((row) => {
        const d = row.data as Record<string, unknown>;
        const hasMetrics = d.metrics != null && typeof d.metrics === "object";
        const metrics = (d.metrics ?? {}) as Record<string, number>;
        // VSI de ficha honesto: si el blob trae un número, úsalo; si no, solo se
        // calcula cuando hay métricas (el coach evaluó). Sin métricas ⇒ null
        // ("sin evaluar"), nunca un número fabricado (invariante #2).
        const vsi: number | null =
          typeof d.vsi === "number" ? d.vsi : hasMetrics ? calculateFichaVsi(metrics) : null;
        const age = (d.age as number) ?? 15;
        // Flecha ↑/↓ solo desde dos evaluaciones reales con fecha (fuente única
        // vsiTrendArrow → computeVsiDelta, invariante #7); el vsiHistory legacy (sin
        // fechas, con el 57.5 fabricado antes de #146) solo cuenta para jugadores demo.
        const trending = vsiTrendArrow({
          evaluations: d.vsiEvaluations,
          legacyHistory: d.vsiHistory,
          currentVsi: vsi,
          isDemo: d.isDemo === true,
        });

        return {
          id: row.id,
          name: (d.name as string) ?? "Sin nombre",
          age,
          position: (d.position as string) ?? "CM",
          positionShort: abbreviatePosition((d.position as string) ?? "CM"),
          vsi,
          ...gatedPhvFields(d),
          // Sin nivel elegido ⇒ null, no «Regional» (P1 bloque 2, inv #2).
          competitiveLevel: typeof d.competitiveLevel === "string" && d.competitiveLevel ? d.competitiveLevel : null,
          ageGroup: getAgeGroup(age),
          trending,
          percentile: 0, // calculated below
          percentileInAgeGroup: 0, // calculated below
          updatedAt: row.updated_at,
          metrics,
          // Sin pie registrado ⇒ null, no «right» (P1 bloque 2, inv #2).
          foot: typeof d.foot === "string" && d.foot ? d.foot : null,
          // Sin default 170/60: son ENTRADAS del gate PHV que el cliente recalcula;
          // una talla/peso inventados abrirían el gate (invariante #2).
          height: typeof d.height === "number" ? d.height : null,
          weight: typeof d.weight === "number" ? d.weight : null,
          // Sin fallback "M": sexo ausente ⇒ null → playerMaturity reenvía sex:undefined
          // y resolveMaturity abstiene ("Sexo no registrado"), igual que la ruta RPC (invariante #5).
          gender: d.gender === "M" || d.gender === "F" ? d.gender : null,
          birthDate: (d.birthDate as string) ?? null,
          sittingHeight: (d.sittingHeight as number) ?? null,
          legLength: (d.legLength as number) ?? null,
          motherHeightCm: (d.motherHeightCm as number) ?? null,
          fatherHeightCm: (d.fatherHeightCm as number) ?? null,
        };
      });

      // Second pass: calculate percentiles against full unfiltered dataset.
      // Los jugadores SIN evaluar (vsi null) se excluyen del cálculo y quedan
      // con percentil null: un hueco no compite ni cuenta como 0.
      const allVSIsForCache = allPlayers
        .map((p) => p.vsi)
        .filter((v): v is number => v !== null);
      const vsiByAgeGroupForCache: Record<string, number[]> = {};
      for (const p of allPlayers) {
        if (p.vsi === null) continue;
        if (!vsiByAgeGroupForCache[p.ageGroup]) vsiByAgeGroupForCache[p.ageGroup] = [];
        vsiByAgeGroupForCache[p.ageGroup].push(p.vsi);
      }
      for (const p of allPlayers) {
        if (p.vsi === null) {
          p.percentile = null;
          p.percentileInAgeGroup = null;
          continue;
        }
        p.percentile = percentileRank(p.vsi, allVSIsForCache);
        p.percentileInAgeGroup = percentileRank(
          p.vsi,
          vsiByAgeGroupForCache[p.ageGroup] ?? allVSIsForCache
        );
      }

      rankingsCache.set(cacheKey, { data: allPlayers, timestamp: Date.now() });
    }

    // Build vsiByAgeGroup from current allPlayers (cached or fresh) for stats.
    // avgVsi/min/max solo sobre evaluados (vsi null excluido); el conteo del
    // grupo sí cuenta a todos (un jugador sin evaluar sigue siendo del grupo).
    const vsiByAgeGroup: Record<string, number[]> = {};
    const countByAgeGroup: Record<string, number> = {};
    for (const p of allPlayers) {
      countByAgeGroup[p.ageGroup] = (countByAgeGroup[p.ageGroup] ?? 0) + 1;
      if (p.vsi === null) continue;
      if (!vsiByAgeGroup[p.ageGroup]) vsiByAgeGroup[p.ageGroup] = [];
      vsiByAgeGroup[p.ageGroup].push(p.vsi);
    }

    // Apply filters
    let filtered = allPlayers;

    if (search) {
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(search));
    }
    if (phvFilter) {
      filtered = filtered.filter((p) => p.phvCategory === phvFilter);
    }
    if (timingFilter) {
      filtered = filtered.filter((p) => matchesTimingFilter(p.phvTiming, timingFilter));
    }
    if (posFilter && posFilter !== "Todos") {
      filtered = filtered.filter((p) => p.position === posFilter);
    }
    if (ageGroupFilter && ageGroupFilter !== "all") {
      filtered = filtered.filter((p) => p.ageGroup === ageGroupFilter);
    }
    if (levelFilter && levelFilter !== "all") {
      filtered = filtered.filter(
        (p) => p.competitiveLevel?.toLowerCase() === levelFilter.toLowerCase()
      );
    }

    // Sort. Los valores null (sin evaluar) van SIEMPRE al final, sin importar
    // la dirección — un hueco no se ordena como 0.
    const nullLast = (
      av: number | null,
      bv: number | null,
      cmp: (x: number, y: number) => number,
    ): number | null => {
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? cmp(av, bv) : -cmp(av, bv);
    };

    filtered.sort((a, b) => {
      switch (sortBy) {
        case "vsi": {
          const r = nullLast(a.vsi, b.vsi, (x, y) => x - y);
          return r ?? 0;
        }
        case "percentile": {
          const r = nullLast(a.percentileInAgeGroup, b.percentileInAgeGroup, (x, y) => x - y);
          return r ?? 0;
        }
        case "age":
          return sortDir === "asc" ? a.age - b.age : -(a.age - b.age);
        case "name": {
          const diff = a.name.localeCompare(b.name);
          return sortDir === "asc" ? diff : -diff;
        }
        default: {
          const r = nullLast(a.vsi, b.vsi, (x, y) => x - y);
          return r ?? 0;
        }
      }
    });

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    // Age group summary stats. count = todos los jugadores del grupo; avg/min/max
    // solo sobre evaluados (null si el grupo no tiene ninguno evaluado todavía).
    const ageGroupStats: Record<
      string,
      { count: number; avgVsi: number | null; minVsi: number | null; maxVsi: number | null }
    > = {};
    for (const [group, count] of Object.entries(countByAgeGroup)) {
      const vsis = vsiByAgeGroup[group] ?? [];
      ageGroupStats[group] = {
        count,
        avgVsi: vsis.length > 0 ? Math.round((vsis.reduce((a, b) => a + b, 0) / vsis.length) * 10) / 10 : null,
        minVsi: vsis.length > 0 ? Math.min(...vsis) : null,
        maxVsi: vsis.length > 0 ? Math.max(...vsis) : null,
      };
    }

    return successResponse({
      players: paginated,
      total,
      limit,
      offset,
      totalUnfiltered: allPlayers.length,
      ageGroups: Object.keys(countByAgeGroup),
      ageGroupStats,
      competitiveLevels: [...new Set(allPlayers.map((p) => p.competitiveLevel).filter((lv): lv is string => !!lv))],
    });
  }
);

// ── Helpers ──────────────────────────────────────────────────────────────

// VSI de ficha: calculateFichaVsi en src/services/real/metricsService.ts (fuente única · invariante #7).

function mapPhv(raw: string): string {
  if (raw === "ontme") return "on-time";
  return raw;
}

function abbreviatePosition(pos: string): string {
  const map: Record<string, string> = {
    "Portero": "POR",
    "Defensa Central": "DFC",
    "Lateral Derecho": "LD",
    "Lateral Izquierdo": "LI",
    "Pivote": "PIV",
    "Mediocentro": "MC",
    "Mediapunta": "MP",
    "Extremo Derecho": "ED",
    "Extremo Izquierdo": "EI",
    "Delantero Centro": "DC",
    "Segundo Delantero": "SD",
    // English/short forms pass through
    GK: "GK", CB: "CB", RB: "RB", LB: "LB",
    CDM: "CDM", CM: "CM", CAM: "CAM",
    RW: "RW", LW: "LW", ST: "ST", CF: "CF",
    RCB: "RCB", LCB: "LCB", RWB: "RWB", LWB: "LWB",
    DM: "DM", LCM: "LCM", RCM: "RCM", RM: "RM", LM: "LM",
  };
  return map[pos] ?? pos.slice(0, 3).toUpperCase();
}
