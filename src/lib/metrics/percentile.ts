/**
 * VITAS · Percentil entre pares — implementación ÚNICA (invariante #7, P1 bloque 5).
 *
 * Antes había 6 cálculos distintos (MetricsService.calculatePercentile, rankingsService,
 * api/rankings/_list.ts, la RPC SQL get_ranked_players, api/benchmark/peer.ts y
 * api/players/baseline-analysis.ts), con resultados opuestos para el mismo niño (P0 en
 * uno, P100 en otro) y sin mínimo de pares: un padre podía ver «P0» de un hijo sin
 * evaluar o comparado contra un solo compañero. Todos los percentiles y cuantiles entre
 * pares de la app pasan por aquí.
 *
 * Reglas:
 *  - Valor del jugador ausente/no finito ⇒ bloqueado `not_evaluated` (nunca un 0).
 *  - Menos de PERCENTILE_MIN_PEERS pares válidos ⇒ bloqueado `insufficient_peers`.
 *  - Par válido = valor finito. QUIÉN entra en `peers` (mismo dueño, sin demo, mismo
 *    estrato, sin el propio jugador) lo decide el llamador; aquí solo se cuentan.
 *  - Fórmula: rango percentil de punto medio, P = round(100 · (L + 0,5·E) / N), con
 *    L = pares por debajo, E = pares empatados y N = pares válidos (sin el propio).
 *  - DERIVADA con confianza ORIENTATIVA: las entradas habituales (barras del
 *    entrenador) son subjetivas.
 *
 * Solo imports relativos: este módulo lo importan también las Edge Functions de api/.
 */

import { derived, gated, ORIENTATIVE_CONFIDENCE, type MetricResult } from "./MetricResult";
import { PERCENTILE_MIN_PEERS } from "../../../config/percentiles";

/** Motivo de bloqueo en forma de código (la UI lo traduce; `gate_reason` es el texto canónico). */
export type PercentileGateCode = "not_evaluated" | "insufficient_peers";

export const PERCENTILE_SOURCE_REF = "src/lib/metrics/percentile.ts";

export interface PeerPercentile {
  /** Percentil 0-100 (DERIVADA) o value null + gate_reason. */
  result: MetricResult<number>;
  gate_code: PercentileGateCode | null;
  /** Pares válidos contados (sin el propio jugador). */
  peers_valid: number;
  min_peers: number;
}

export interface PeerDistributionValue {
  mean: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface PeerDistribution {
  result: MetricResult<PeerDistributionValue>;
  gate_code: "insufficient_peers" | null;
  peers_valid: number;
  min_peers: number;
}

interface Opts {
  /** Solo para tests; en la app manda la constante de config/percentiles.ts. */
  minPeers?: number;
  source_ref?: string;
}

function validPeers(peers: ReadonlyArray<number | null | undefined>): number[] {
  return peers.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function insufficientPeersReason(count: number, min: number): string {
  return `solo ${count} jugadores evaluados comparables (mínimo ${min})`;
}

export const NOT_EVALUATED_REASON = "sin evaluación: no tiene percentil";

/** Percentil de `value` entre `peers` (que NO deben incluir al propio jugador). */
export function peerPercentile(
  value: number | null | undefined,
  peers: ReadonlyArray<number | null | undefined>,
  opts: Opts = {},
): PeerPercentile {
  const min = opts.minPeers ?? PERCENTILE_MIN_PEERS;
  const source_ref = opts.source_ref ?? PERCENTILE_SOURCE_REF;
  const pool = validPeers(peers);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      result: gated(NOT_EVALUATED_REASON, { source_ref }),
      gate_code: "not_evaluated",
      peers_valid: pool.length,
      min_peers: min,
    };
  }
  if (pool.length < min) {
    return {
      result: gated(insufficientPeersReason(pool.length, min), { source_ref }),
      gate_code: "insufficient_peers",
      peers_valid: pool.length,
      min_peers: min,
    };
  }
  const below = pool.filter((v) => v < value).length;
  const equal = pool.filter((v) => v === value).length;
  const pct = Math.round((100 * (below + 0.5 * equal)) / pool.length);
  return {
    result: derived(pct, { confidence: ORIENTATIVE_CONFIDENCE, source_ref }),
    gate_code: null,
    peers_valid: pool.length,
    min_peers: min,
  };
}

// ── Percentiles dentro de una población (Rankings, panel del director) ──────────

export interface PoolMember {
  id: string;
  value: number | null | undefined;
  /** Jugador de ejemplo: nunca es par de un jugador real. */
  isDemo?: boolean;
  /** Estrato (p. ej. grupo de edad). Con `byGroup`, solo compiten los del mismo. */
  group?: string | null;
}

/**
 * Percentil de cada miembro frente al RESTO de `members` (el propio nunca es par de sí
 * mismo). Reales y de ejemplo no se mezclan: un jugador real solo se compara con reales
 * y uno de ejemplo solo con los de ejemplo (la demo, con su banner). `members` ya debe
 * ser la población permitida (los jugadores del propio usuario).
 */
export function percentilesAmong(
  members: ReadonlyArray<PoolMember>,
  opts: Opts & { byGroup?: boolean } = {},
): Map<string, PeerPercentile> {
  const out = new Map<string, PeerPercentile>();
  for (const m of members) {
    const peers = members
      .filter(
        (q) =>
          q.id !== m.id &&
          (q.isDemo === true) === (m.isDemo === true) &&
          (!opts.byGroup || (q.group ?? null) === (m.group ?? null)),
      )
      .map((q) => q.value);
    out.set(m.id, peerPercentile(m.value, peers, opts));
  }
  return out;
}

/** Lo que la UI necesita para explicar un percentil bloqueado (la traduce por código). */
export interface PercentileGateInfo {
  code: PercentileGateCode;
  peers: number;
  min: number;
}

export function percentileGateInfo(p: PeerPercentile): PercentileGateInfo | null {
  return p.gate_code ? { code: p.gate_code, peers: p.peers_valid, min: p.min_peers } : null;
}

/** Cuantil por rango más cercano (índice floor(n·p), acotado al último). */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Media y cuantiles 25/50/75/90 de los pares, con el MISMO mínimo que el percentil. */
export function peerDistribution(
  peers: ReadonlyArray<number | null | undefined>,
  opts: Opts = {},
): PeerDistribution {
  const min = opts.minPeers ?? PERCENTILE_MIN_PEERS;
  const source_ref = opts.source_ref ?? PERCENTILE_SOURCE_REF;
  const pool = validPeers(peers);
  if (pool.length < min) {
    return {
      result: gated<PeerDistributionValue>(insufficientPeersReason(pool.length, min), { source_ref }),
      gate_code: "insufficient_peers",
      peers_valid: pool.length,
      min_peers: min,
    };
  }
  const sorted = [...pool].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    result: derived<PeerDistributionValue>(
      {
        mean: round1(mean),
        p25: round1(nearestRank(sorted, 0.25)),
        p50: round1(nearestRank(sorted, 0.5)),
        p75: round1(nearestRank(sorted, 0.75)),
        p90: round1(nearestRank(sorted, 0.9)),
      },
      { confidence: ORIENTATIVE_CONFIDENCE, source_ref },
    ),
    gate_code: null,
    peers_valid: pool.length,
    min_peers: min,
  };
}
