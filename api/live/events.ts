/**
 * VITAS · Live Events API (Sprint B2 · Match-day Live Mode)
 *
 *   POST   /api/live/events                       → registrar 1 o batch eventos
 *   GET    /api/live/events?matchId=<id>          → listar eventos de un partido
 *   DELETE /api/live/events?id=<id>               → eliminar evento (mistap)
 *
 * Body POST single:
 *   {
 *     matchId, playerId, eventType, timestampSeconds,
 *     half?, zoneRow?, zoneCol?, metadata?, notes?, clientEventId?
 *   }
 *
 * Body POST batch (sync de offline queue):
 *   { matchId, events: [<single sin matchId>] }
 *
 * Idempotencia: clientEventId UUID generado en cliente · UNIQUE
 * sobre (match_id, client_event_id) evita duplicados al sync.
 *
 * Propiedad (074, solo el dueño): escribe con service_role, que salta la RLS y las
 * guardas RESTRICTIVE de la migración 074. Por eso aquí se exige, además de que el
 * PARTIDO sea del usuario, que cada playerId no nulo sea un jugador SUYO
 * (players.user_id; ownedPlayerIdsAmong = forma por lote de ownsPlayer, una sola
 * consulta). Si alguno no lo es → 403 y no se escribe NADA del lote (el cliente
 * conserva su cola); si no se puede comprobar → 503. Antes el player_id iba tal
 * cual: cualquier cuenta podía colgar eventos del jugador (menor) de otra cuenta
 * en su propio partido, y /api/live/aggregate devolvía luego su nombre.
 *
 * POST SIGUE INERTE, COMO EN main (a propósito, PR #309): withHandler ya consumió
 * el cuerpo de los POST y este handler lo vuelve a leer con req.json() → null →
 * 400 invalid_body a TODO POST, desde que se creó (457e17c). Por eso la
 * comprobación de propiedad de arriba hoy no se alcanza en producción: está para
 * que el futuro arreglo de esa doble lectura no reabra el hueco. Ese arreglo NO
 * va en este PR de seguridad porque encendería por primera vez una superficie que
 * nunca ha funcionado y que no está lista (docs/pendientes-metricas.md §B, 074):
 *   - el upsert del lote usa onConflict "match_id,client_event_id", pero el único
 *     índice único es PARCIAL (032:90-92, WHERE client_event_id IS NOT NULL) y no
 *     arbitra un ON CONFLICT sin su predicado (42P10, SIMULADO en PGlite; el mismo
 *     caso que api/webhooks/stripe.ts:154-157) → 500 en el esquema del repo;
 *   - LiveSummaryPage pinta por jugador una nota del LLM (/10) y el «impacto neto»
 *     (pesos EVENT_WEIGHTS de aggregate.ts sin fuente) sin MetricResult, sin
 *     etiqueta de procedencia y sin entrada en config/metrics.json (inv #1).
 * Encenderlo es decisión del dueño, con esas dos cosas resueltas antes.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { ownedPlayerIdsAmong } from "../_lib/ownership";

/**
 * 403/503 si algún playerId no nulo no es del usuario (o no se puede comprobar);
 * null si todos son suyos (o no hay ninguno). Una sola consulta por petición.
 * Mismo mensaje para «de otra cuenta» y «no existe»: no revela si un id existe.
 */
async function rejectForeignPlayers(
  playerIds: Array<string | null | undefined>,
  userId: string,
): Promise<Response | null> {
  const wanted = playerIds.filter((p): p is string => p !== null && p !== undefined);
  if (wanted.length === 0) return null;
  const owned = await ownedPlayerIdsAmong(wanted, userId);
  if (owned === null) {
    return errorResponse({
      code: "ownership_unavailable",
      message: "No se pudo comprobar la propiedad de los jugadores · no se ha guardado nada",
      status: 503,
    });
  }
  if (wanted.some((p) => !owned.has(p))) {
    return errorResponse({
      code: "player_not_owned",
      message: "Hay eventos de jugadores que no son tuyos · no se ha guardado nada",
      status: 403,
    });
  }
  return null;
}

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const EVENT_TYPES = [
  "gol", "pase_clave", "recuperacion", "perdida",
  "duelo_ganado", "duelo_perdido",
  "asistencia", "tarjeta_amarilla", "tarjeta_roja",
  "parada_portero", "penalti_provocado", "penalti_cometido",
] as const;

const eventBaseSchema = z.object({
  playerId: z.string().nullable().optional(),
  eventType: z.enum(EVENT_TYPES),
  timestampSeconds: z.number().int().min(0).max(36_000),
  half: z.number().int().min(1).max(4).optional(),
  zoneRow: z.enum(["defensa", "medio", "ataque"]).optional(),
  zoneCol: z.enum(["izq", "cen", "dcha"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  notes: z.string().max(200).optional(),
  clientEventId: z.string().max(64).optional(),
});

const singleSchema = eventBaseSchema.extend({
  matchId: z.string().uuid(),
});

const batchSchema = z.object({
  matchId: z.string().uuid(),
  events: z.array(eventBaseSchema).min(1).max(200),
});

export default withHandler(
  {
    method: ["GET", "POST", "DELETE"],
    requireAuth: true,
    maxRequests: 200,
  },
  async ({ req, userId, method, query }) => {
    if (!userId) {
      return errorResponse({ code: "unauthorized", message: "Login requerido", status: 401 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── GET ─────────────────────────────────────────────────────
    if (method === "GET") {
      const matchId = query.matchId;
      if (!matchId) {
        return errorResponse({ code: "missing_matchId", message: "matchId requerido", status: 400 });
      }
      // Ownership: sin .eq(user_id) cualquier autenticado leía los eventos
      // (player_id de menores, notas, metadata) de un partido ajeno con solo su
      // matchId. POST/DELETE ya gatean por user_id; el GET no lo hacía. Los
      // live_events se insertan con user_id del creador (POST, abajo), así que
      // filtrar por user_id acota al dueño (igual que el DELETE).
      const { data: events, error } = await supabase
        .from("live_events")
        .select("*")
        .eq("match_id", matchId)
        .eq("user_id", userId)
        .order("timestamp_seconds", { ascending: true });

      if (error) {
        return errorResponse({ code: "db_error", message: error.message, status: 500 });
      }
      return successResponse({ events: events ?? [] });
    }

    // ── DELETE ──────────────────────────────────────────────────
    if (method === "DELETE") {
      const id = query.id;
      if (!id) {
        return errorResponse({ code: "missing_id", message: "id requerido", status: 400 });
      }
      // El cliente (undoLast) envía su clientEventId (UUID local), que se persiste en la
      // columna `client_event_id`, NO en `id` (uuid generado por la BD). Matchear por `id`
      // no borraba NADA → el "deshacer" fallaba en silencio. Se matchea client_event_id
      // (siempre presente: el POST lo fija) + user_id (ownership).
      const { error } = await supabase
        .from("live_events")
        .delete()
        .eq("client_event_id", id)
        .eq("user_id", userId);

      if (error) {
        return errorResponse({ code: "delete_failed", message: error.message, status: 500 });
      }
      return successResponse({ deleted: true, id });
    }

    // ── POST · single o batch ───────────────────────────────────
    // DOBLE LECTURA DEL CUERPO, SIN ARREGLAR A PROPÓSITO (ver cabecera): withHandler
    // ya leyó el cuerpo, así que esta segunda lectura da null → 400 invalid_body en
    // TODO POST, igual que en main. No cambiar a ctx.body sin antes arreglar el
    // upsert del lote frente al índice parcial de la 032 y etiquetar las cifras de
    // LiveSummaryPage, y con la decisión del dueño (el test
    // api/live/__tests__/events-ownership.test.ts «sigue inerte» lo vigila).
    const body = (await req.json().catch(() => null)) as unknown;

    // Detectar batch vs single
    const isBatch = !!(body && typeof body === "object" && "events" in (body as Record<string, unknown>));
    if (isBatch) {
      const parsed = batchSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse({
          code: "invalid_body",
          message: parsed.error.errors[0]?.message ?? "Body inválido",
          status: 400,
        });
      }
      const input = parsed.data;

      // Verificar que el match es del user
      const { data: match } = await supabase
        .from("live_matches")
        .select("id, tenant_id, user_id")
        .eq("id", input.matchId)
        .single();
      if (!match || match.user_id !== userId) {
        return errorResponse({ code: "forbidden", message: "Partido no es tuyo", status: 403 });
      }

      // Cada jugador del lote debe ser del usuario (una consulta para todo el lote).
      const foreignBatch = await rejectForeignPlayers(input.events.map((e) => e.playerId), userId);
      if (foreignBatch) return foreignBatch;

      const inserts = input.events.map((e) => ({
        tenant_id: match.tenant_id,
        match_id: input.matchId,
        player_id: e.playerId ?? null,
        user_id: userId,
        event_type: e.eventType,
        timestamp_seconds: e.timestampSeconds,
        half: e.half ?? 1,
        zone_row: e.zoneRow ?? null,
        zone_col: e.zoneCol ?? null,
        metadata: e.metadata ?? {},
        notes: e.notes ?? null,
        client_event_id: e.clientEventId ?? null,
      }));

      // upsert con onConflict en (match_id, client_event_id) para idempotencia
      const { data: rows, error } = await supabase
        .from("live_events")
        .upsert(inserts, { onConflict: "match_id,client_event_id", ignoreDuplicates: true })
        .select();

      if (error) {
        return errorResponse({ code: "insert_failed", message: error.message, status: 500 });
      }
      return successResponse({
        inserted: rows?.length ?? 0,
        skipped: inserts.length - (rows?.length ?? 0),
      });
    }

    // Single event
    const parsed = singleSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse({
        code: "invalid_body",
        message: parsed.error.errors[0]?.message ?? "Body inválido",
        status: 400,
      });
    }
    const input = parsed.data;

    const { data: match } = await supabase
      .from("live_matches")
      .select("id, tenant_id, user_id")
      .eq("id", input.matchId)
      .single();
    if (!match || match.user_id !== userId) {
      return errorResponse({ code: "forbidden", message: "Partido no es tuyo", status: 403 });
    }

    const foreignSingle = await rejectForeignPlayers([input.playerId], userId);
    if (foreignSingle) return foreignSingle;

    const { data: row, error } = await supabase
      .from("live_events")
      .insert({
        tenant_id: match.tenant_id,
        match_id: input.matchId,
        player_id: input.playerId ?? null,
        user_id: userId,
        event_type: input.eventType,
        timestamp_seconds: input.timestampSeconds,
        half: input.half ?? 1,
        zone_row: input.zoneRow ?? null,
        zone_col: input.zoneCol ?? null,
        metadata: input.metadata ?? {},
        notes: input.notes ?? null,
        client_event_id: input.clientEventId ?? null,
      })
      .select()
      .single();

    if (error) {
      return errorResponse({ code: "insert_failed", message: error.message, status: 500 });
    }
    return successResponse({ event: row });
  }
);
