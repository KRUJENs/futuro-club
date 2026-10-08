/**
 * VITAS · GET /api/tactical/list-matches
 *
 * Lista los matches que tienen heatmap táctico computado, ordenados por
 * última actualización descendente. Útil para el selector del módulo
 * tactical cuando no hay matchId en la URL.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse } from "../_lib/apiResponse";
import { ownedPlayerIds } from "../_lib/ownership";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

interface HeatmapRow {
  match_id: string;
  computed_at: string;
  phase_type: string;
}

// Tope de partidos por usuario que listamos (acota la longitud del `in.(...)`).
// Si un usuario supera esto, se listan los primeros OWNER_MATCH_CAP y se loguea
// (nunca truncado en silencio — invariante "No silent caps").
const OWNER_MATCH_CAP = 500;

/** Lista PostgREST `("a","b")` con cada valor entre comillas (ids de jugador son text). */
const quotedInList = (values: readonly string[]) =>
  `(${values.map((v) => `"${v.replace(/["\\]/g, "")}"`).join(",")})`;

export default withHandler(
  // Cierra el acceso anónimo: antes devolvía TODOS los match_id existentes a
  // cualquiera, eliminando la barrera de adivinar UUIDs. Scopea al DUEÑO (076): los
  // partidos son analyses que creó el usuario o de jugadores suyos (mismo predicado
  // que ownsMatch). Nunca por tenant: un tenant compartido listaba los partidos de
  // todas las cuentas de ese tenant. El service_role salta la RLS → filtramos aquí.
  { method: "GET", requireAuth: true, maxRequests: 60 },
  async ({ userId }) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return successResponse({ matches: [], source: "no_supabase" });
  }

  // Fail-closed: sin usuario no podemos scopear → no listamos nada.
  if (!userId) {
    return successResponse({ matches: [] });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // 1. Match ids del usuario: match_id == analyses.id (mismo modelo que ownsMatch).
    //    Analyses que creó (user_id) + analyses de SUS jugadores (el pipeline de vídeo
    //    las crea con user_id NULL). Sin ninguna → no hay nada que listar.
    const ownerClauses = [`user_id.eq.${encodeURIComponent(userId)}`];
    const playerIds = await ownedPlayerIds(userId);
    if (playerIds.length > 0) ownerClauses.push(`player_id.in.${encodeURIComponent(quotedInList(playerIds))}`);
    const analysesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/analyses?or=(${ownerClauses.join(",")})&select=id&limit=${OWNER_MATCH_CAP + 1}`,
      { headers },
    );
    if (!analysesRes.ok) {
      console.error(`[list-matches] analyses query non-ok (${analysesRes.status})`);
      return successResponse({ matches: [] });
    }
    const analysisRows = (await analysesRes.json()) as Array<{ id: string }>;
    let allowedIds = analysisRows.map((r) => r.id);
    if (allowedIds.length > OWNER_MATCH_CAP) {
      console.warn(
        `[list-matches] el usuario tiene >${OWNER_MATCH_CAP} analyses; listando las primeras ${OWNER_MATCH_CAP}`,
      );
      allowedIds = allowedIds.slice(0, OWNER_MATCH_CAP);
    }
    if (allowedIds.length === 0) {
      return successResponse({ matches: [] });
    }

    // 2. Heatmaps de equipo SOLO de esos matches (scoping en la propia query).
    const inList = allowedIds.map((id) => encodeURIComponent(id)).join(",");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/phase_heatmaps?player_id=is.null&match_id=in.(${inList})&select=match_id,computed_at,phase_type&order=computed_at.desc&limit=200`,
      { headers },
    );
    const rows = (await res.json()) as HeatmapRow[];

    // Group by match_id
    const map = new Map<string, { phasesCount: number; computedAt: string }>();
    for (const r of rows) {
      const entry = map.get(r.match_id) ?? { phasesCount: 0, computedAt: r.computed_at };
      entry.phasesCount += 1;
      if (r.computed_at > entry.computedAt) entry.computedAt = r.computed_at;
      map.set(r.match_id, entry);
    }

    const matches = Array.from(map.entries())
      .map(([matchId, v]) => ({ matchId, phasesCount: v.phasesCount, computedAt: v.computedAt }))
      .sort((a, b) => b.computedAt.localeCompare(a.computedAt));

    return successResponse({ matches });
  } catch (err) {
    console.error("[list-matches] error:", err);
    return successResponse({ matches: [], error: String(err) });
  }
  },
);
