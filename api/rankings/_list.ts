/**
 * VITAS · Rankings API — Server-side ranked player list
 * GET /api/rankings/list
 *
 * Features:
 * - Server-side pagination (limit/offset)
 * - Sort by VSI, age, name
 * - Filter by PHV category, position, age group, competitive level
 * - Percentiles entre pares (implementación ÚNICA src/lib/metrics/percentile.ts): solo
 *   los jugadores del propio usuario, sin jugadores de ejemplo para uno real y con un
 *   mínimo de 10 pares; si no, null + motivo (P1 bloque 5)
 * - Total count for pagination
 *
 * Sin la RPC SQL get_ranked_players (P1 bloque 5): su `percent_rank()` no tenía mínimo
 * de pares (P0 al jugador evaluado que estaba solo en su grupo de edad) y el mismo niño
 * salía P0 por la RPC y P100 por esta ruta. Con ≥10 pares, el último sigue siendo P0
 * y el primero P100: eso sí es un resultado real. La ruta en memoria ya cargaba
 * todos los jugadores del usuario, filtraba y paginaba tras la puerta PHV; ahora es la
 * única. La función SQL queda en la base sin uso (sin EXECUTE para clientes, 072).
 * Sin caché de módulo de 5 minutos: con una sola ruta, la lista no puede ir por detrás
 * de lo que el entrenador acaba de guardar.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { fichaVsiFromBlob } from "../../src/services/real/metricsService";
import { phvGate, matchesTimingFilter, type MaturityTiming, type PhvGateInput } from "../../src/lib/phv/phvGate";
import { registeredSex, withRegisteredSex } from "../../src/lib/shared/registeredSex";
import { pendingVsiReviewIdsRest } from "../_lib/vsiPendingReview";
import { vsiTrendArrow } from "../../src/lib/scoring/vsiDelta";
import { blockedPercentile, percentilesAmong, percentileGateInfo, type PercentileGateInfo } from "../../src/lib/metrics/percentile";

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
  const g = phvGate(withRegisteredSex(d) as PhvGateInput); // «M» sin confirmar ⇒ sin sexo (P1 bloque 7)
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
  // null si sin evaluar o con menos de 10 pares; el motivo va en *Gate.
  percentile: number | null;
  percentileInAgeGroup: number | null;
  percentileGate: PercentileGateInfo | null;
  percentileInAgeGroupGate: PercentileGateInfo | null;
  /** Jugador de ejemplo: en los percentiles solo se compara con otros de ejemplo. */
  isDemo: boolean;
  updatedAt: string;
  metrics: Record<string, number>;
  foot: string | null; // null ⇒ pie no registrado
  height: number | null;
  weight: number | null;
  // Campos de maduración para que el cliente compute el timing canónico
  // (resolveMaturity) con la misma fuente que esta ruta.
  // gender puede ser null: sexo no registrado ⇒ resolveMaturity abstiene (invariante #5).
  gender: "M" | "F" | null;
  birthDate: string | null;
  sittingHeight: number | null;
  legLength: number | null;
  motherHeightCm: number | null;
  fatherHeightCm: number | null;
};

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
    // sobre la categoría persistida (la RPC antigua filtraba por la persistida).
    const phvParam = url.searchParams.get("phv");
    const phvFilter = phvParam && phvParam !== "all" ? mapPhv(phvParam) : null;
    // Filtro de la UI («Madurador tardío ⭐»): TIMING vs pares ("late" | "on_time" |
    // "early") sobre el MISMO timing gateado que rotula la fila. `phv` filtra la FASE.
    const timingParam = url.searchParams.get("timing");
    const timingFilter = timingParam && timingParam !== "all" ? timingParam : null;
    const posFilter = url.searchParams.get("position"); // Position string
    const ageGroupFilter = url.searchParams.get("ageGroup"); // "Sub-14", etc.
    const levelFilter = url.searchParams.get("level"); // competitive level
    const search = url.searchParams.get("search")?.toLowerCase();

    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    };

    // TODOS los jugadores del usuario (players.user_id): son la población de los
    // percentiles (solo los propios, decisión del dueño 14 oct 2026) y el filtro y la
    // paginación se aplican después, sobre lo que se muestra.
    let allPlayers: PlayerRow[];
    // Revisión VSI pendiente (57,5 de la 070, D3): no cuenta como evaluado (ni par, ni su
    // percentil, ni las medias del grupo). null = no se pudo leer ⇒ percentiles y medias
    // BLOQUEADOS, nunca «nadie pendiente» (api/_lib/vsiPendingReview.ts, lector único).
    // Sin 500: el cliente caería al cálculo local, que no conoce las revisiones.
    let pending: Set<string> | null = null;
    {
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
        const metrics = (d.metrics ?? {}) as Record<string, number>;
        // VSI de ficha con la regla ÚNICA de «evaluado» (fichaVsiFromBlob): el GUARDADO,
        // el mismo que enseña la ficha; si no, null ("sin evaluar"). Antes se recalculaba
        // con barras parciales (una barra ausente valía 0: `metrics: {}` ⇒ VSI 0 como par).
        const vsi: number | null = fichaVsiFromBlob(d);
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
          percentile: null, // calculated below
          percentileInAgeGroup: null, // calculated below
          percentileGate: null,
          percentileInAgeGroupGate: null,
          isDemo: d.isDemo === true,
          updatedAt: row.updated_at,
          metrics,
          // Sin pie registrado ⇒ null, no «right» (P1 bloque 2, inv #2).
          foot: typeof d.foot === "string" && d.foot ? d.foot : null,
          // Sin default 170/60: son ENTRADAS del gate PHV que el cliente recalcula;
          // una talla/peso inventados abrirían el gate (invariante #2).
          height: typeof d.height === "number" ? d.height : null,
          weight: typeof d.weight === "number" ? d.weight : null,
          // Sin fallback "M": sexo ausente ⇒ null → playerMaturity reenvía sex:undefined
          // y resolveMaturity abstiene ("Sexo no registrado") (invariante #5).
          gender: registeredSex(d), // «M» sin confirmar ⇒ null (P1 bloque 7)
          birthDate: (d.birthDate as string) ?? null,
          sittingHeight: (d.sittingHeight as number) ?? null,
          legLength: (d.legLength as number) ?? null,
          motherHeightCm: (d.motherHeightCm as number) ?? null,
          fatherHeightCm: (d.fatherHeightCm as number) ?? null,
        };
      });

      // Second pass: percentiles contra el conjunto completo SIN filtrar, con la
      // implementación única (src/lib/metrics/percentile.ts): sin evaluar ⇒ null +
      // motivo; menos de 10 pares evaluados ⇒ null + motivo; un jugador de ejemplo
      // y uno real no se mezclan. Antes: «≤1 valor ⇒ P100» aquí y P0 en la RPC.
      try {
        pending = await pendingVsiReviewIdsRest(supabaseUrl, headers);
      } catch {
        pending = null;
      }
      const reviewed = pending;
      const members = allPlayers.map((p) => ({
        id: p.id,
        value: reviewed === null || reviewed.has(p.id) ? null : p.vsi,
        isDemo: p.isDemo,
        group: p.ageGroup,
      }));
      const global = percentilesAmong(members);
      const inGroup = percentilesAmong(members, { byGroup: true });
      for (const p of allPlayers) {
        const blocked = reviewed === null ? "reviews_unavailable" : reviewed.has(p.id) ? "pending_review" : null;
        const g = blocked ? blockedPercentile(blocked) : global.get(p.id)!;
        const ag = blocked ? blockedPercentile(blocked) : inGroup.get(p.id)!;
        p.percentile = g.result.value;
        p.percentileGate = percentileGateInfo(g);
        p.percentileInAgeGroup = ag.result.value;
        p.percentileInAgeGroupGate = percentileGateInfo(ag);
      }
    }

    // Build vsiByAgeGroup from allPlayers for stats.
    // avgVsi/min/max solo sobre evaluados (vsi null excluido); el conteo del
    // grupo sí cuenta a todos (un jugador sin evaluar sigue siendo del grupo).
    const vsiByAgeGroup: Record<string, number[]> = {};
    const countByAgeGroup: Record<string, number> = {};
    for (const p of allPlayers) {
      countByAgeGroup[p.ageGroup] = (countByAgeGroup[p.ageGroup] ?? 0) + 1;
      if (p.vsi === null || pending === null || pending.has(p.id)) continue;
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

// VSI de ficha: fichaVsiFromBlob / calculateFichaVsi en src/services/real/metricsService.ts (fuente única · invariante #7).

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
