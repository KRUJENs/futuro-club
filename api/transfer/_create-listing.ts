/**
 * VITAS · POST /api/transfer/create-listing
 *
 * Crea un listing en estado `draft` (el vendedor decide cuándo activarlo via
 * update-listing). Snapshot del jugador se construye desde el playerId que
 * el caller provee (futuro: leer de players table; hoy: caller manda snapshot).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { DEFAULTS } from "../../src/lib/transfer/transferConfig";
import { trustAnthropometricsRow, type AnthropometricsRowLike } from "../../src/lib/phv/phvGate";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const CreateListingSchema = z.object({
  playerId: z.string(),
  // sellerUserId / tenantId ya NO se aceptan del caller: la identidad del vendedor
  // se toma del JWT (no spoofable). sellerName es solo display.
  sellerName: z.string().optional(),
  publisherRole: z.enum(["club", "agent", "player"]).default("club"),
  listingType: z.enum(["sale", "loan", "trial"]),
  askingPriceEur: z.number().nullable().optional(),
  currency: z.enum(["EUR", "USD", "GBP"]).default("EUR"),
  valuationEurAi: z.number().nullable().optional(),
  acceptsOffers: z.boolean().default(true),
  visibility: z.enum(["public", "private"]).default("public"),
  description: z.string().max(2000).optional(),
  highlightVideoId: z.string().optional(),
  tags: z.array(z.string()).max(15).default([]),
  playerSnapshot: z.record(z.unknown()).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  status: z.enum(["draft", "active"]).default("draft"),
});

const uuid = (): string => crypto.randomUUID();

/**
 * PHV fiable para el snapshot, desde la última medición (vista
 * player_latest_anthropometrics) y el gate único `trustAnthropometricsRow`.
 * select=*: antes de la migración 069 la vista no tiene age_source ⇒ la fila no
 * es fiable ⇒ sin PHV (falla cerrado, sin error). Cualquier fallo de lectura ⇒
 * sin PHV; el listing se crea igual.
 */
async function trustedListingPhv(playerId: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/player_latest_anthropometrics?player_id=eq.${encodeURIComponent(playerId)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) return {};
    const rows = (await res.json().catch(() => [])) as AnthropometricsRowLike[];
    const t = trustAnthropometricsRow(Array.isArray(rows) ? rows[0] : null);
    if (!t.trusted || t.category === null || t.offset === null) return {};
    return {
      phvCategory: t.category === "ontme" ? "on-time" : t.category,
      phvOffset: t.offset,
      phvTrusted: true,
    };
  } catch {
    return {};
  }
}

export default withHandler(
  { method: "POST", schema: CreateListingSchema, optionalAuth: true, maxRequests: 30 },
  async ({ body, userId, tenantId }) => {
    // En PRODUCCIÓN (Supabase configurado) exige auth; en modo demo/offline sin
    // Supabase degrada al fallback client_only sin romper (invariante de fallback,
    // CLAUDE.md). Nunca se persiste anónimo en la BD real.
    if (SUPABASE_URL && SUPABASE_KEY && !userId) {
      return errorResponse("Unauthorized", 401);
    }
    const input = body as z.infer<typeof CreateListingSchema>;

    // El listing debe ser sobre un jugador del que eres DUEÑO (players.user_id): no se
    // publica en el mercado a un menor ajeno (integridad + identidad, invariante #6).
    // Solo con Supabase + auth (en offline/client_only no hay BD que consultar).
    // PHV del snapshot: NUNCA el que mande el cliente, y tampoco la columna
    // players.phv_category/phv_offset (antes de aplicar 069 guarda aún el valor
    // naive legacy, y el snapshot lo congelaría como fiable para siempre). Solo el
    // de la ÚLTIMA fila de player_anthropometrics que el gate único da por fiable
    // (4 medidas + edad decimal por fecha de nacimiento — regla del owner 28-sep),
    // marcado phvTrusted para que las vistas lo distingan de snapshots antiguos.
    const snapshot: Record<string, unknown> = { ...(input.playerSnapshot ?? {}) };
    delete snapshot.phvCategory;
    delete snapshot.phvOffset;
    delete snapshot.phvTrusted;

    if (SUPABASE_URL && SUPABASE_KEY && userId) {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/players?id=eq.${encodeURIComponent(input.playerId)}&select=user_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
      );
      // Fail-closed (076): si no se puede comprobar el dueño (respuesta no-ok), NO se
      // publica. Antes un error de la consulta se leía como «jugador local-only» y el
      // listing se insertaba igual, aunque el jugador existiera y fuera de otra cuenta.
      if (!pr.ok) {
        return errorResponse("No se pudo comprobar el dueño del jugador. Intenta de nuevo.", 503);
      }
      const rows = (await pr.json().catch(() => [])) as Array<{
        user_id: string | null;
      }>;
      const player = Array.isArray(rows) ? rows[0] : undefined;
      // Solo bloquea si el jugador EXISTE en Supabase y es de OTRO. Jugadores
      // local-only (onboarding/demo, aún no persistidos en BD) → el snapshot lo
      // aporta el caller, no hay fila que validar → se permite (no rompe el alta).
      // Solo el DUEÑO (players.user_id, 076): nunca por tenant — con un tenant
      // compartido, otra cuenta podía publicar en el mercado a un menor ajeno.
      if (player) {
        const ownsPlayer = !!player.user_id && player.user_id === userId;
        if (!ownsPlayer) return errorResponse("Forbidden: no gestionas este jugador", 403);
        Object.assign(snapshot, await trustedListingPhv(input.playerId));
      }
    }

    const expiresInDays = input.expiresInDays ?? DEFAULTS.listingTtlDays;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const row = {
      id: uuid(),
      player_id: input.playerId,
      // Identidad del vendedor SIEMPRE desde el JWT (no spoofable por el caller).
      seller_user_id: userId,
      seller_name: input.sellerName ?? null,
      tenant_id: tenantId,
      publisher_role: input.publisherRole,
      listing_type: input.listingType,
      status: input.status,
      asking_price_eur: input.askingPriceEur ?? null,
      currency: input.currency,
      valuation_eur_ai: input.valuationEurAi ?? null,
      accepts_offers: input.acceptsOffers,
      visibility: input.visibility,
      description: input.description ?? null,
      highlight_video_id: input.highlightVideoId ?? null,
      tags: input.tags,
      player_snapshot: snapshot,
      expires_at: expiresAt,
    };

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return successResponse({ listing: row, source: "client_only" });
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/transfer_listings`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(row),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return errorResponse(`Supabase insert failed: ${res.status} ${text.slice(0, 200)}`, 500);
      }

      const inserted = await res.json();
      return successResponse({ listing: Array.isArray(inserted) ? inserted[0] : inserted });
    } catch (err) {
      console.error("[create-listing] error:", err);
      return errorResponse("Internal error creating listing", 500);
    }
  },
);
