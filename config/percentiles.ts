/**
 * VITAS · Configuración del PERCENTIL ENTRE PARES (P1 bloque 5)
 *
 * Fuente única de las constantes de `src/lib/metrics/percentile.ts` (contrato de
 * `.claude/rules/metricas.md`: las constantes de una ruta de cálculo viven en config/
 * con su procedencia). Módulo TS (no JSON) porque lo importan también las Edge
 * Functions de api/, igual que config/injuryRisk.ts.
 *
 * PROCEDENCIA: el mínimo de pares NO es un umbral estadístico validado. Es una
 * decisión del producto (dueño, 14 oct 2026) para no enseñar a una familia un
 * «P0» o un «P100» calculado contra 1-2 niños. No se inventa una cita.
 */

/** Mínimo de PARES evaluados (sin contar al propio jugador) para emitir un percentil:
 *  hacen falta 10 jugadores comparables ADEMÁS del evaluado. */
export const PERCENTILE_MIN_PEERS = 10;

export const PERCENTILE_MIN_PEERS_SOURCE = "decisión del producto, 14 oct 2026 (P1 bloque 5)";

/**
 * Población de comparación: SOLO los jugadores del MISMO DUEÑO (players.user_id); reales y
 * de ejemplo (`isDemo`) no se mezclan. Hasta que exista el acceso de clubes (decisión del
 * dueño, 14 oct 2026) no se compara con otras cuentas.
 */
export const PERCENTILE_POOL_SCOPE = "owner_only" as const;
