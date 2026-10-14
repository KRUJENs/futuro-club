/**
 * VITAS · Player CRUD Endpoint
 * GET    /api/players/crud          — list all players for the user
 * GET    /api/players/crud?id=X     — get single player
 * POST   /api/players/crud          — create player
 * PATCH  /api/players/crud          — update player (metrics, PHV, etc.)
 * DELETE /api/players/crud          — delete player
 */
import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { calculateFichaVsi } from "../../src/services/real/metricsService";
import { toIsoBirthDate, isMissingBirthDateColumnError } from "../../src/lib/shared/birthDate";
import { appendVsiEvaluation } from "../../src/lib/scoring/vsiDelta";

export const config = { runtime: "edge" };

// Fecha de nacimiento DEL JUGADOR (YYYY-MM-DD). Misma regla que la columna
// players.birth_date (control RGPD de consentimiento, 036): una fecha que la
// columna rechazaría es un 400, no se guarda a medias en el blob.
const BirthDateSchema = z
  .string()
  .refine((s) => toIsoBirthDate(s) !== null, {
    message: "birthDate debe ser YYYY-MM-DD, una fecha real anterior a hoy y desde 1900",
  });

// DEFENSIVO frente al orden de despliegue: si la base no tuviera la columna
// players.birth_date (036), PostgREST rechaza la fila ENTERA. Se reintenta UNA vez
// sin esa columna (la fila se guarda como antes de enviarla) en vez de un 500.
// errText === null ⇒ escritura correcta (res es la respuesta buena).
async function retryWithoutMissingBirthDate(
  res: Response,
  payload: Record<string, unknown>,
  resend: (body: string) => Promise<Response>,
): Promise<{ res: Response; errText: string | null }> {
  if (res.ok) return { res, errText: null };
  const errText = await res.text();
  if (!isMissingBirthDateColumnError(errText)) return { res, errText };
  const { birth_date: _omitted, ...withoutBirthDate } = payload;
  const retried = await resend(JSON.stringify(withoutBirthDate));
  return { res: retried, errText: retried.ok ? null : await retried.text() };
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const MetricsSchema = z.object({
  speed: z.number().min(0).max(100),
  technique: z.number().min(0).max(100),
  vision: z.number().min(0).max(100),
  stamina: z.number().min(0).max(100),
  shooting: z.number().min(0).max(100),
  defending: z.number().min(0).max(100),
});

const CreatePlayerSchema = z.object({
  id: z.string().optional(), // client can provide or server generates
  name: z.string().min(2).max(80),
  age: z.number().min(8).max(21),
  position: z.enum([
    "GK", "CB", "RB", "LB", "RCB", "LCB", "RWB", "LWB",
    "CDM", "CM", "CAM", "DM", "LCM", "RCM", "RM", "LM",
    "RW", "LW", "ST", "CF",
    "Portero", "Defensa Central", "Lateral Derecho", "Lateral Izquierdo",
    "Pivote", "Mediocentro", "Mediapunta", "Extremo Derecho",
    "Extremo Izquierdo", "Delantero Centro", "Segundo Delantero",
  ]),
  // OPCIONALES (P1 bloque 2): el alta rápida no pide pie, medidas ni nivel y no se
  // rellenan por defecto. Requeridos, el asistente del primer jugador daba 400 al
  // saltarse las medidas; y el nivel se inventaba como «Regional» (invariante #2).
  foot: z.enum(["right", "left", "both"]).optional(),
  height: z.number().min(100).max(220).optional(),
  weight: z.number().min(20).max(120).optional(),
  sittingHeight: z.number().min(30).max(130).optional(),
  legLength: z.number().min(30).max(130).optional(),
  competitiveLevel: z.string().min(1).optional(),
  minutesPlayed: z.number().default(0),
  // OPCIONAL: el alta rápida no evalúa ⇒ sin métricas → VSI de ficha null.
  // No se rellena con defaults (sería inventar una evaluación; invariante #2).
  metrics: MetricsSchema.optional(),
  gender: z.enum(["M", "F"]).optional(), // sin default "M": sexo ausente ⇒ null (invariante #5)
  phvCategory: z.enum(["early", "ontme", "late"]).optional(),
  phvOffset: z.number().optional(),
  // Antes no estaba en el schema ⇒ zod la descartaba en silencio al crear.
  birthDate: BirthDateSchema.optional(),
});

const UpdatePlayerSchema = z.object({
  id: z.string(),
  // null ⇒ borrar la fecha (la columna birth_date pasa a NULL).
  birthDate: BirthDateSchema.nullable().optional(),
  metrics: MetricsSchema.optional(),
  phvCategory: z.enum(["early", "ontme", "late"]).optional(),
  phvOffset: z.number().optional(),
  name: z.string().min(2).max(80).optional(),
  age: z.number().min(8).max(21).optional(),
  position: z.enum([
    "GK", "CB", "RB", "LB", "RCB", "LCB", "RWB", "LWB",
    "CDM", "CM", "CAM", "DM", "LCM", "RCM", "RM", "LM",
    "RW", "LW", "ST", "CF",
    "Portero", "Defensa Central", "Lateral Derecho", "Lateral Izquierdo",
    "Pivote", "Mediocentro", "Mediapunta", "Extremo Derecho",
    "Extremo Izquierdo", "Delantero Centro", "Segundo Delantero",
  ]).optional(),
  foot: z.enum(["right", "left", "both"]).optional(),
  height: z.number().min(100).max(220).optional(),
  weight: z.number().min(20).max(120).optional(),
  sittingHeight: z.number().min(30).max(130).optional(),
  legLength: z.number().min(30).max(130).optional(),
  competitiveLevel: z.string().optional(),
  minutesPlayed: z.number().optional(),
});

const DeletePlayerSchema = z.object({
  id: z.string(),
});

// VSI de ficha: pesos + fórmula en fuente ÚNICA src/services/real/metricsService.ts (invariante #7).

// ── Handler ─────────────────────────────────────────────────────────────────

export default withHandler(
  { method: ["GET", "POST", "PATCH", "DELETE"], requireAuth: true, maxRequests: 60 },
  async ({ req, body, userId }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse("Supabase not configured", 503, "CONFIG_ERROR");
    }

    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    };

    // ── GET: List or single player ──────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      const sortBy = url.searchParams.get("sort") ?? "updated_at";
      const sortDir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 200);
      const offset = parseInt(url.searchParams.get("offset") ?? "0");

      // Roster visible = los jugadores propios + los del/los club(es) de los que
      // el caller es MIEMBRO. Los owner-ids se derivan ESTRICTAMENTE de
      // team_members(member_id = caller) → un miembro NUNCA ve otro club.
      // Fail-closed: si la resolución falla, solo se ven los propios (menos, nunca
      // más). RGPD: un fallo aquí no puede filtrar datos de menores entre clubes.
      const visibleOwnerIds = new Set<string>([userId!]);
      try {
        const tmRes = await fetch(
          `${supabaseUrl}/rest/v1/team_members?member_id=eq.${userId}&select=org_owner_id`,
          { headers },
        );
        if (tmRes.ok) {
          const tms = (await tmRes.json()) as Array<{ org_owner_id: string | null }>;
          for (const tm of tms) if (tm.org_owner_id) visibleOwnerIds.add(tm.org_owner_id);
        }
        // tmRes no-ok → no ampliamos (fail-closed): solo los propios.
      } catch { /* fail-closed: solo los propios */ }

      const ownerList = Array.from(visibleOwnerIds).join(",");
      let queryUrl = `${supabaseUrl}/rest/v1/players?user_id=in.(${ownerList})`;
      if (id) queryUrl += `&id=eq.${id}`;

      // Sort: usar columnas relacionales (024_normalize_players) — más rápido que jsonb paths
      const sortMap: Record<string, string> = {
        name: "name",
        vsi: "vsi",
        age: "age",
        position: "position",
        updated_at: "updated_at",
      };
      const sortCol = sortMap[sortBy] ?? "updated_at";
      queryUrl += `&order=${sortCol}.${sortDir}`;
      queryUrl += `&limit=${limit}&offset=${offset}`;

      const res = await fetch(queryUrl, {
        headers: { ...headers, Prefer: "count=exact" },
      });

      if (!res.ok) {
        const errText = await res.text();
        return errorResponse(`Failed to fetch players: ${errText.slice(0, 200)}`, 500);
      }

      const rows = await res.json() as Array<{ id: string; data: Record<string, unknown>; updated_at: string }>;
      const total = parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0");

      // Extract player data from JSONB
      const players = rows.map((row) => ({
        ...(row.data as Record<string, unknown>),
        id: row.id,
        updatedAt: row.updated_at,
      }));

      if (id && players.length === 1) {
        return successResponse(players[0]);
      }

      return successResponse({ players, total, limit, offset });
    }

    // ── POST: Create player ──────────────────────────────────────────────────
    if (req.method === "POST") {
      const parsed = CreatePlayerSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(
          "Invalid player data: " + parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", "),
          400, "VALIDATION_ERROR",
        );
      }

      const input = parsed.data;
      // VSI de ficha solo si el entrenador evaluó (aportó métricas). Sin métricas
      // ⇒ null ("sin evaluar"), nunca un número fabricado (invariante #2).
      const vsi = input.metrics ? calculateFichaVsi(input.metrics) : null;
      const now = new Date().toISOString();
      const playerId = input.id ?? `p${Date.now()}`;

      const playerData = {
        ...input,
        id: playerId,
        vsi,
        vsiHistory: vsi !== null ? [vsi] : [],
        // Evaluación con fecha y origen: la única base válida para una variación del
        // VSI (src/lib/scoring/vsiDelta.ts). vsiHistory queda como legacy sin fechas.
        vsiEvaluations: vsi !== null ? appendVsiEvaluation([], vsi, "players_api", now) : [],
        createdAt: now,
        updatedAt: now,
      };

      const row = {
        id: playerId,
        user_id: userId,
        data: playerData,
        updated_at: now,
        // ── Dual-write: columnas relacionales (024_normalize_players) ──
        name: input.name,
        age: input.age,
        position: input.position,
        foot: input.foot ?? null,
        height_cm: input.height ?? null,
        weight_kg: input.weight ?? null,
        sitting_height: input.sittingHeight ?? null,
        leg_length: input.legLength ?? null,
        // Sin nivel ⇒ null. OJO: el trigger de players (024, redefinido en la 069:178)
        // rellena la COLUMNA con 'Regional' (residuo P2 en docs/pendientes-metricas.md);
        // el blob `data` queda sin nivel.
        competitive_level: input.competitiveLevel ?? null,
        minutes_played: input.minutesPlayed,
        gender: input.gender ?? null, // no asumir masculino si falta el sexo (invariante #5)
        metric_speed: input.metrics?.speed ?? null,
        metric_technique: input.metrics?.technique ?? null,
        metric_vision: input.metrics?.vision ?? null,
        metric_stamina: input.metrics?.stamina ?? null,
        metric_shooting: input.metrics?.shooting ?? null,
        metric_defending: input.metrics?.defending ?? null,
        vsi, // null si no hay evaluación (columna nullable)
        vsi_history: vsi !== null ? [vsi] : [],
        phv_category: input.phvCategory ?? null,
        phv_offset: input.phvOffset ?? null,
        // Fecha del JUGADOR → columna del trigger RGPD de consentimiento (036).
        birth_date: toIsoBirthDate(input.birthDate),
      };

      // players.phv_category / phv_offset son propiedad EXCLUSIVA del endpoint
      // gateado de antropometría (migración 069 · regla del owner 28-sep): el CRUD
      // no las escribe desde lo que traiga el cliente.
      stripPersistedPhvColumns(row);
      const res = await fetch(`${supabaseUrl}/rest/v1/players`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(row),
      });

      const created = await retryWithoutMissingBirthDate(res, row, (retryBody) =>
        fetch(`${supabaseUrl}/rest/v1/players`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=representation" },
          body: retryBody,
        }),
      );
      if (created.errText !== null) {
        return errorResponse(`Failed to create player: ${created.errText.slice(0, 200)}`, 500);
      }

      const [saved] = await created.res.json() as Array<{ id: string; data: Record<string, unknown> }>;
      return successResponse({ ...saved.data, id: saved.id }, 201);
    }

    // ── PATCH: Update player ─────────────────────────────────────────────────
    if (req.method === "PATCH") {
      let patchBody = body;
      if (!patchBody || typeof patchBody !== "object" || !("id" in (patchBody as Record<string, unknown>))) {
        try { patchBody = await req.json(); } catch { /* empty */ }
      }

      const parsed = UpdatePlayerSchema.safeParse(patchBody);
      if (!parsed.success) {
        return errorResponse(
          "Invalid update data: " + parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", "),
          400, "VALIDATION_ERROR",
        );
      }

      const { id, ...updates } = parsed.data;

      // Fetch current player data
      const getRes = await fetch(
        `${supabaseUrl}/rest/v1/players?id=eq.${id}&user_id=eq.${userId}&select=data,updated_at`,
        { headers },
      );

      if (!getRes.ok) {
        return errorResponse("Failed to fetch player", 500);
      }

      const rows = await getRes.json() as Array<{ data: Record<string, unknown>; updated_at: string }>;
      if (rows.length === 0) {
        return errorResponse("Player not found", 404, "NOT_FOUND");
      }

      const currentData = rows[0].data as Record<string, unknown>;
      const originalUpdatedAt = rows[0].updated_at;
      const now = new Date().toISOString();

      // Build updated data
      const updatedData = { ...currentData };

      // Apply field updates
      if (updates.name !== undefined) updatedData.name = updates.name;
      if (updates.age !== undefined) updatedData.age = updates.age;
      if (updates.position !== undefined) updatedData.position = updates.position;
      if (updates.foot !== undefined) updatedData.foot = updates.foot;
      if (updates.height !== undefined) updatedData.height = updates.height;
      if (updates.weight !== undefined) updatedData.weight = updates.weight;
      if (updates.sittingHeight !== undefined) updatedData.sittingHeight = updates.sittingHeight;
      if (updates.legLength !== undefined) updatedData.legLength = updates.legLength;
      if (updates.competitiveLevel !== undefined) updatedData.competitiveLevel = updates.competitiveLevel;
      if (updates.minutesPlayed !== undefined) updatedData.minutesPlayed = updates.minutesPlayed;
      if (updates.phvCategory !== undefined) updatedData.phvCategory = updates.phvCategory;
      if (updates.phvOffset !== undefined) updatedData.phvOffset = updates.phvOffset;
      if (updates.birthDate === null) delete updatedData.birthDate;
      else if (updates.birthDate !== undefined) updatedData.birthDate = updates.birthDate;

      // Recalculate VSI if metrics changed
      if (updates.metrics) {
        updatedData.metrics = updates.metrics;
        const newVSI = calculateFichaVsi(updates.metrics);
        updatedData.vsi = newVSI;
        const history = Array.isArray(currentData.vsiHistory) ? [...(currentData.vsiHistory as number[])] : [];
        history.push(newVSI);
        updatedData.vsiHistory = history.slice(-10);
        updatedData.vsiEvaluations = appendVsiEvaluation(currentData.vsiEvaluations, newVSI, "players_api", now);
      }

      updatedData.updatedAt = now;

      // ── Dual-write: columnas relacionales (024_normalize_players) ──
      const ud = updatedData as Record<string, unknown>;
      const m = ud.metrics as Record<string, number> | undefined;
      const patchPayload: Record<string, unknown> = {
        data: updatedData,
        updated_at: now,
        name: ud.name,
        age: ud.age,
        position: ud.position,
        foot: ud.foot,
        height_cm: ud.height,
        weight_kg: ud.weight,
        sitting_height: ud.sittingHeight ?? null,
        leg_length: ud.legLength ?? null,
        competitive_level: ud.competitiveLevel,
        minutes_played: ud.minutesPlayed,
        gender: ud.gender ?? null, // preserva el sexo real del blob; si falta ⇒ null (invariante #5)
        // Sin evaluar ⇒ null, no 0 (P1 bloque 5). OJO: el trigger de players (069) y el
        // DEFAULT de la columna (024) siguen poniendo 0: los lectores usan el blob
        // `data->metrics` (corregir las columnas es del bloque 7).
        metric_speed: m?.speed ?? null,
        metric_technique: m?.technique ?? null,
        metric_vision: m?.vision ?? null,
        metric_stamina: m?.stamina ?? null,
        metric_shooting: m?.shooting ?? null,
        metric_defending: m?.defending ?? null,
        vsi: ud.vsi,
        vsi_history: ud.vsiHistory ?? [],
        phv_category: ud.phvCategory ?? null,
        phv_offset: ud.phvOffset ?? null,
        // Proyección del blob (fuente única de la fecha del jugador) → columna RGPD.
        birth_date: toIsoBirthDate(ud.birthDate),
      };

      stripPersistedPhvColumns(patchPayload); // ver POST: propiedad del endpoint gateado (069)
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/players?id=eq.${id}&user_id=eq.${userId}&updated_at=eq.${originalUpdatedAt}`,
        {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify(patchPayload),
        },
      );

      const patched = await retryWithoutMissingBirthDate(patchRes, patchPayload, (retryBody) =>
        fetch(
          `${supabaseUrl}/rest/v1/players?id=eq.${id}&user_id=eq.${userId}&updated_at=eq.${originalUpdatedAt}`,
          { method: "PATCH", headers: { ...headers, Prefer: "return=representation" }, body: retryBody },
        ),
      );
      if (patched.errText !== null) {
        return errorResponse(`Failed to update player: ${patched.errText.slice(0, 200)}`, 500);
      }

      const patchedRows = await patched.res.json() as Array<{ id: string; data: Record<string, unknown> }>;
      if (patchedRows.length === 0) {
        return errorResponse("Conflicto: el jugador fue modificado por otra sesión. Reintenta.", 409, "CONFLICT");
      }
      return successResponse({ ...patchedRows[0].data, id: patchedRows[0].id });
    }

    // ── DELETE: Remove player ────────────────────────────────────────────────
    if (req.method === "DELETE") {
      let deleteBody = body;
      if (!deleteBody || typeof deleteBody !== "object" || !("id" in (deleteBody as Record<string, unknown>))) {
        try { deleteBody = await req.json(); } catch { /* empty */ }
      }

      const parsed = DeletePlayerSchema.safeParse(deleteBody);
      if (!parsed.success) {
        return errorResponse("Invalid body: need {id}", 400, "VALIDATION_ERROR");
      }

      const res = await fetch(
        `${supabaseUrl}/rest/v1/players?id=eq.${parsed.data.id}&user_id=eq.${userId}`,
        { method: "DELETE", headers },
      );

      if (!res.ok) {
        return errorResponse("Failed to delete player", 500);
      }

      return successResponse({ deleted: true, id: parsed.data.id });
    }

    return errorResponse("Method not allowed", 405);
  },
);

/**
 * Retira players.phv_category / phv_offset de una escritura del CRUD. Esas columnas
 * solo las escribe api/players/anthropometrics.ts cuando el gate único de PHV
 * (src/lib/phv/phvGate.ts) se abre con una fila COMPLETA de medidas introducidas +
 * edad decimal por fecha de nacimiento + sexo (regla del owner 28-sep, migración
 * 069). Aceptarlas del cliente re-contaminaba la columna que leen Telegram, el
 * benchmark de pares, el comparador de rival y el baseline de equipo.
 */
function stripPersistedPhvColumns(cols: object): void {
  const c = cols as Record<string, unknown>;
  delete c.phv_category;
  delete c.phv_offset;
}
