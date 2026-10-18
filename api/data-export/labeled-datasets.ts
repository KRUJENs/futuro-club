/**
 * VITAS · Export del dataset etiquetado (Sprint 5.3 · flywheel)
 * GET /api/data-export/labeled-datasets            → stats (count + recientes + por base legal)
 * GET /api/data-export/labeled-datasets?format=jsonl&limit=5000  → JSONL para entrenamiento
 *
 * serviceOnly: solo con token de servicio (CRON_SECRET/INTERNAL_API_TOKEN/SERVICE_ROLE_KEY;
 * ADMIN_SECRET ya no vale, CS-01).
 * Es dataset de entrenamiento propietario — nunca expuesto al cliente.
 */
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { stripDuelOutcomes } from "../../src/lib/tracking/duels";

export const config = { runtime: "edge" };

interface DatasetRow {
  analysis_id: string;
  player_id: string;
  chronological_age: number | null;
  biological_age: number | null;
  phv_offset: number | null;
  phv_category: string | null;
  position: string | null;
  features: Record<string, unknown>;
  labels: Record<string, unknown>;
  consent_basis: string;
  created_at: string;
}

export default withHandler(
  { method: "GET", serviceOnly: true, maxRequests: 30 },
  async ({ query }) => {
    const sbUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!sbUrl || !sbKey) return errorResponse("Supabase no configurado", 503);
    const headers = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
    const base = `${sbUrl}/rest/v1/labeled_datasets`;

    // ── Modo JSONL: descarga para entrenamiento ──
    if (query.format === "jsonl") {
      const limit = Math.min(Number(query.limit) || 5000, 50000);
      const res = await fetch(`${base}?select=*&order=created_at.asc&limit=${limit}`, { headers });
      if (!res.ok) return errorResponse(`Supabase ${res.status}`, 502);
      const rows = (await res.json()) as DatasetRow[];
      // Sin cifras de duelos de filas antiguas (P1 bloque 6/7: sin criterio validado).
      const jsonl = rows.map((r) => JSON.stringify(stripDuelOutcomes(r))).join("\n");
      return new Response(jsonl, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Disposition": `attachment; filename="vitas-dataset-${rows.length}.jsonl"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Modo stats (por defecto) ──
    const countRes = await fetch(`${base}?select=id&limit=1`, {
      headers: { ...headers, Prefer: "count=exact" },
    });
    const contentRange = countRes.headers.get("content-range") ?? "*/0";
    const total = Number(contentRange.split("/")[1]) || 0;

    const recentRes = await fetch(
      `${base}?select=analysis_id,player_id,chronological_age,phv_category,consent_basis,created_at&order=created_at.desc&limit=5`,
      { headers },
    );
    const recent = recentRes.ok ? await recentRes.json() : [];

    // Reparto por base legal
    const nrRes = await fetch(`${base}?select=id&consent_basis=eq.not_required&limit=1`, {
      headers: { ...headers, Prefer: "count=exact" },
    });
    const notRequired = Number((nrRes.headers.get("content-range") ?? "*/0").split("/")[1]) || 0;

    return successResponse({
      total,
      byConsentBasis: { not_required: notRequired, parental_verified: total - notRequired },
      recent,
      hint: "Añade ?format=jsonl&limit=5000 para descargar el dataset de entrenamiento.",
    });
  },
);
