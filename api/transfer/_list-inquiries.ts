/**
 * VITAS · GET /api/transfer/list-inquiries?listingId=...|buyerUserId=...
 *
 * Datos de MENORES + PII de negociación. Requiere AUTH y ownership:
 *   - listingId → solo el VENDEDOR dueño del listing (seller_user_id; sin rama por
 *     tenant desde la 076) ve su buzón de inquiries.
 *   - buyerUserId → solo puedes listar TUS propias inquiries (=== tu userId).
 * Nunca acceso anónimo con service_role (era un IDOR: cualquiera leía el buzón
 * de ofertas de cualquier listing o enumeraba la actividad de compra ajena).
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

export default withHandler(
  { method: "GET", requireAuth: true, maxRequests: 60 },
  async ({ req, userId }) => {
    const url = new URL(req.url);
    const listingId = url.searchParams.get("listingId");
    const buyerUserId = url.searchParams.get("buyerUserId");

    if (!listingId && !buyerUserId) {
      return errorResponse("listingId or buyerUserId required", 400);
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return successResponse({ inquiries: [], source: "no_supabase" });
    }

    // ── Como COMPRADOR: solo puedes ver tus propias inquiries ──
    if (buyerUserId && buyerUserId !== userId) {
      return errorResponse("Forbidden", 403);
    }

    // ── Como VENDEDOR: solo el dueño del listing ve su buzón ──
    if (listingId) {
      const lr = await fetch(
        `${SUPABASE_URL}/rest/v1/transfer_listings?id=eq.${encodeURIComponent(listingId)}&select=seller_user_id`,
        { headers: sbHeaders },
      );
      const rows = (await lr.json().catch(() => [])) as Array<{
        seller_user_id: string | null;
      }>;
      const listing = Array.isArray(rows) ? rows[0] : undefined;
      if (!listing) return errorResponse("Listing not found", 404);
      // Solo el vendedor que lo publicó (076): nunca por tenant.
      const owns = !!listing.seller_user_id && listing.seller_user_id === userId;
      if (!owns) return errorResponse("Forbidden", 403);
    }

    // El filtro usa SIEMPRE valores de confianza (listingId ya validado como
    // propio; el comprador se fija al userId autenticado, no al param) + encode.
    const filter = listingId
      ? `listing_id=eq.${encodeURIComponent(listingId)}`
      : `buyer_user_id=eq.${encodeURIComponent(String(userId))}`;

    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/transfer_inquiries?${filter}&order=created_at.desc&limit=100`,
        { headers: sbHeaders },
      );
      const data = await res.json();
      return successResponse({ inquiries: Array.isArray(data) ? data : [] });
    } catch (err) {
      console.error("[list-inquiries] error:", err);
      return errorResponse("Failed to fetch inquiries", 500);
    }
  },
);
