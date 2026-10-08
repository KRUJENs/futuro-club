/**
 * VITAS · Public Share Token for Analysis
 *
 *   POST /api/analyses/share?analysisId=<id>          → genera token (auth)
 *   GET  /api/analyses/share?analysisId=<id>&t=<tok>  → valida + devuelve datos (public)
 *
 * Permite a un padre/coach generar una URL pública con HMAC token que
 * cualquiera puede abrir (ej: enviar a familia por WhatsApp) sin login.
 * El token incluye expiración (default 90 días). Sin DB · sin invalidación
 * granular · revocación = rotar SHARE_SECRET.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hmacSha256Hex, timingSafeEqual } from "../_lib/edgeCrypto";
import { ownsRowOrItsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import { withoutUndatedVsiSeries } from "../../src/lib/scoring/vsiDelta";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHARE_SECRET = (() => {
  const secret = process.env.SHARE_SECRET ?? process.env.CRON_SECRET ?? process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error("[share] CRITICAL: No SHARE_SECRET, CRON_SECRET, or SUPABASE_JWT_SECRET configured. Share tokens are disabled.");
  }
  return secret ?? "";
})();

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 días

async function makeToken(analysisId: string, expiresAtMs: number): Promise<string> {
  const sig = await hmacSha256Hex(SHARE_SECRET, `${analysisId}:${expiresAtMs}`);
  return `${expiresAtMs}.${sig.slice(0, 32)}`;
}

async function verifyToken(analysisId: string, token: string): Promise<boolean> {
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig) return false;
  const expiresAtMs = Number(expStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
  const expected = (await hmacSha256Hex(SHARE_SECRET, `${analysisId}:${expiresAtMs}`)).slice(0, 32);
  return timingSafeEqual(sig, expected);
}

export default withHandler(
  {
    method: ["GET", "POST"],
    requireAuth: false, // GET es público; POST chequea auth manual
    optionalAuth: true,
    maxRequests: 60,
  },
  async ({ method, query, userId }) => {
    if (!SHARE_SECRET) {
      return errorResponse({ code: "share_disabled", message: "Share tokens disabled — no secret configured", status: 503 });
    }

    const analysisId = query.analysisId;
    if (!analysisId) {
      return errorResponse({ code: "missing_analysisId", message: "analysisId requerido", status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── POST · generar token (requiere auth y propiedad del análisis) ──
    if (method === "POST") {
      if (!userId) {
        return errorResponse({ code: "unauthorized", message: "auth required", status: 401 });
      }

      const { data: a } = await supabase
        .from("analyses")
        .select("id, user_id, player_id")
        .eq("id", analysisId)
        .single();

      if (!a) return errorResponse({ code: "not_found", message: "Análisis no existe", status: 404 });
      // Propiedad del análisis = propiedad del JUGADOR del análisis. El pipeline de
      // vídeo crea el análisis con user_id=null (bunny-uploaded) PERO con player_id de
      // un jugador real, y players.user_id SÍ se puebla — así el dueño legítimo
      // comparte y un tercero (que no gestiona al jugador) recibe 403. Antes, un
      // análisis con user_id null dejaba mintear token a cualquier autenticado (IDOR
      // de PII de un menor). Fail-closed: sin propiedad demostrable ⇒ 403.
      // Solo el dueño (076): quien creó el análisis o el dueño de su jugador. Nunca
      // por tenant (un tenant compartido dejaba mintear un enlace PÚBLICO del informe
      // de cualquier menor de ese tenant).
      const owns = await ownsRowOrItsPlayer(a, userId);
      if (!owns) {
        return errorResponse({ code: "forbidden", message: "No es tu análisis", status: 403 });
      }

      const expiresAtMs = Date.now() + DEFAULT_TTL_MS;
      const token = await makeToken(analysisId, expiresAtMs);
      return successResponse({
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
        url: `/share/analysis/${analysisId}?t=${token}`,
      });
    }

    // ── GET · validar token y devolver datos públicos ──────────────────
    const token = query.t;
    if (!token) {
      return errorResponse({ code: "missing_token", message: "token requerido", status: 400 });
    }
    const ok = await verifyToken(analysisId, token);
    if (!ok) {
      return errorResponse({ code: "invalid_token", message: "Token inválido o expirado", status: 401 });
    }

    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .select("id, status, vsi, phv, similarity, biomechanics, completed_at, player_id, video_id, created_at")
      .eq("id", analysisId)
      .single();

    if (aErr || !analysis) {
      return errorResponse({ code: "not_found", message: "Análisis no existe", status: 404 });
    }

    const { data: player } = await supabase
      .from("players")
      .select("name, position, age")
      .eq("id", analysis.player_id)
      .single();

    const { data: reports } = await supabase
      .from("reports")
      .select("report_type, content, model, prompt_version, generated_at")
      .eq("analysis_id", analysisId)
      .order("report_type", { ascending: true });

    return successResponse({
      // Enlace público (familia): vsi.trend / vsi.history de filas antiguas = serie legacy
      // SIN fechas (57.5 fabricado) → se retiran al leer (src/lib/scoring/vsiDelta.ts).
      analysis: { ...analysis, vsi: withoutUndatedVsiSeries(analysis.vsi) },
      player: player ?? null,
      reports: reports ?? [],
      shared: true,
    });
  }
);
