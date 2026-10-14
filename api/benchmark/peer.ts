/**
 * VITAS · Comparación con pares (percentil entre los PROPIOS jugadores)
 * GET /api/benchmark/peer?playerId=<id>
 *
 * Compara a un jugador con los jugadores del MISMO DUEÑO (players.user_id) de su misma
 * posición y edad ±1 (y misma fase PHV si la tiene, salvo withPhv=false). Solo expone
 * agregados: jamás ids, nombres ni datos personales.
 *
 * P1 bloque 5 (decisiones del dueño, 14 oct 2026):
 *  - Población: SOLO los jugadores propios hasta que exista el acceso de clubes. Antes
 *    era un pool «cross-club» de TODAS las cuentas (service key sin filtro de dueño).
 *  - Mínimo 10 pares evaluados (sin contar al propio); si no, null + motivo.
 *  - Implementación única del percentil y de los cuantiles: src/lib/metrics/percentile.ts.
 *  - Un jugador sin evaluar NO tiene percentil (antes su valor ausente valía 0 ⇒ «P0»
 *    que veía su familia). Un par sin evaluar no cuenta (antes tampoco el 0, pero el
 *    mínimo se contaba sobre filas, evaluadas o no).
 *  - Las barras del entrenador se leen del blob `data->metrics`, no de las columnas
 *    `metric_*`: el trigger de players (069) y el DEFAULT de la columna (024) ponen 0
 *    a quien no está evaluado (corregir esas columnas es del bloque 7).
 *  - Reales y de ejemplo (`isDemo`) no se mezclan: un real solo se compara con reales.
 *
 * Response:
 *   {
 *     stratum: { position, ageMin, ageMax, phvCategory },
 *     scope: "owner_only",
 *     minPeers: 10,
 *     vsi:      PeerMetric,
 *     byMetric: { speed: PeerMetric, technique: …, … },
 *   }
 *   PeerMetric = { player: number|null, percentile: MetricResult, gate: {code,peers,min}|null,
 *                  distribution: {mean,p25,p50,p75,p90}|null }
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import {
  peerPercentile,
  peerDistribution,
  percentileGateInfo,
  type PercentileGateInfo,
  type PeerDistributionValue,
} from "../../src/lib/metrics/percentile";
import type { MetricResult } from "../../src/lib/metrics/MetricResult";
import { PERCENTILE_MIN_PEERS, PERCENTILE_POOL_SCOPE } from "../../config/percentiles";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const querySchema = z.object({
  playerId: z.string().min(1),
  withPhv: z.enum(["true", "false"]).default("true"),
});

/** Las 6 barras de la evaluación del entrenador (claves del blob `data.metrics`). */
const METRIC_KEYS = ["speed", "technique", "vision", "stamina", "shooting", "defending"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

export interface PeerMetric {
  player: number | null;
  percentile: MetricResult<number>;
  gate: PercentileGateInfo | null;
  distribution: PeerDistributionValue | null;
}

interface PoolRow {
  vsi: number | string | null;
  metrics: Record<string, unknown> | null;
  is_demo: string | null;
}

function finite(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function metricOf(metrics: Record<string, unknown> | null | undefined, key: MetricKey): number | null {
  return metrics && typeof metrics === "object" ? finite(metrics[key]) : null;
}

function compare(player: number | null, peers: Array<number | null>): PeerMetric {
  const pct = peerPercentile(player, peers);
  const dist = peerDistribution(peers);
  return {
    player,
    percentile: pct.result,
    gate: percentileGateInfo(pct),
    // Sin valor del jugador la distribución sola no se enseña (no hay con qué compararla).
    distribution: player === null ? null : dist.result.value,
  };
}

export default withHandler(
  { method: "GET", requireAuth: true, allowServiceToken: true, maxRequests: 60 },
  async ({ query, userId, isServiceCall }) => {
    const params = querySchema.safeParse(query);
    if (!params.success) {
      return errorResponse({
        code: "invalid_params",
        message: params.error.errors[0]?.message ?? "playerId requerido",
        status: 400,
      });
    }

    // El jugador OBJETIVO debe pertenecer al usuario.
    if (!isServiceCall && !(await ownsPlayer(params.data.playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar jugador ─────────────────────────────────────
    const { data: player, error: pErr } = await supabase
      .from("players")
      .select("id, user_id, age, position, phv_category, vsi, metrics:data->metrics, is_demo:data->>isDemo")
      .eq("id", params.data.playerId)
      .single();

    if (pErr || !player) {
      return errorResponse({ code: "player_not_found", message: pErr?.message ?? "no encontrado", status: 404 });
    }

    if (!player.age || !player.position) {
      return errorResponse({
        code: "missing_player_data",
        message: "Jugador necesita edad + posición para compararlo",
        status: 400,
      });
    }

    // Sin dueño no hay población propia que comparar (nunca se cae al pool global).
    if (!player.user_id) {
      return errorResponse({ code: "player_without_owner", message: "Jugador sin dueño registrado", status: 409 });
    }

    // ── 2. Pares: SOLO jugadores del mismo dueño ──────────────
    let q = supabase
      .from("players")
      .select("vsi, metrics:data->metrics, is_demo:data->>isDemo")
      .eq("user_id", player.user_id)
      .neq("id", player.id) // el propio nunca es par de sí mismo
      .gte("age", player.age - 1)
      .lte("age", player.age + 1)
      .eq("position", player.position);

    if (params.data.withPhv === "true" && player.phv_category) {
      q = q.eq("phv_category", player.phv_category);
    }

    const { data: rows, error: qErr } = await q.limit(2000);
    if (qErr) {
      return errorResponse({ code: "db_error", message: qErr.message, status: 500 });
    }

    // Reales y de ejemplo no se mezclan (misma regla que percentilesAmong).
    const targetIsDemo = player.is_demo === "true";
    const peers = ((rows ?? []) as PoolRow[]).filter((r) => (r.is_demo === "true") === targetIsDemo);

    const stratum = {
      position: player.position,
      ageMin: player.age - 1,
      ageMax: player.age + 1,
      phvCategory: params.data.withPhv === "true" ? player.phv_category : null,
    };

    const playerMetrics = player.metrics as Record<string, unknown> | null;
    const byMetric = Object.fromEntries(
      METRIC_KEYS.map((k) => [k, compare(metricOf(playerMetrics, k), peers.map((r) => metricOf(r.metrics, k)))]),
    ) as Record<MetricKey, PeerMetric>;

    return successResponse({
      stratum,
      scope: PERCENTILE_POOL_SCOPE,
      minPeers: PERCENTILE_MIN_PEERS,
      vsi: compare(finite(player.vsi), peers.map((r) => finite(r.vsi))),
      byMetric,
    });
  },
);
