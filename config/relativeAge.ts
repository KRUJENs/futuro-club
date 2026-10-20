/**
 * VITAS · Configuración de la EDAD RELATIVA (trimestre de nacimiento) — P1 bloque 6
 *
 * Fuente única de las constantes de `src/lib/shared/relativeAge.ts` (contrato de
 * `.claude/rules/metricas.md`: las constantes de una ruta de cálculo viven en config/
 * con su procedencia). Módulo TS (no JSON) para que lo puedan importar también las
 * Edge Functions de api/, igual que config/percentiles.ts.
 *
 * PROCEDENCIA: el mes de corte NO está validado para cada jugador. El año de la
 * categoría depende de la federación y de la competición (año natural en la mayoría
 * de categorías de fútbol base, pero no en todas). Mientras no se registre el corte
 * de la competición de cada club, el trimestre se calcula con el año natural y su
 * confianza se reduce. No se inventa una cita.
 */

/** Mes de corte del año de la categoría (1 = enero = año natural). */
export const RELATIVE_AGE_CUTOFF_MONTH = 1;

export const RELATIVE_AGE_CUTOFF_SOURCE =
  "pendiente de validar (depende de la federación y la competición; por defecto, año natural)";

// ── Señal de sesgo por edad relativa en una PLANTILLA (P2 bloque 8) ─────────────────

/**
 * Mínimo de jugadores CON FECHA para dar la señal: la prueba χ² de bondad de ajuste con 4
 * trimestres pide una frecuencia esperada de al menos 5 por casilla (4 × 5 = 20).
 */
export const RAE_MIN_DATED_PLAYERS = 20;
export const RAE_MIN_DATED_PLAYERS_SOURCE =
  "convención estadística de la prueba χ² (frecuencia esperada ≥ 5 por trimestre); pendiente de validar para este uso";

/** Valor crítico de χ² con 3 grados de libertad (4 trimestres − 1) para α = 0,05. */
export const RAE_CHI2_CRITICAL = 7.815;
export const RAE_CHI2_CRITICAL_SOURCE =
  "tabla de la distribución χ², 3 grados de libertad, α = 0,05 (convención de significación); pendiente de validar para este uso";

/**
 * Reparto esperado sin sesgo: nacimientos por igual entre los 4 trimestres. Es una
 * aproximación (la natalidad real varía por mes y país) ⇒ la señal lleva confianza orientativa.
 */
export const RAE_EXPECTED_SOURCE =
  "aproximación: nacimientos repartidos por igual entre trimestres; pendiente de validar con la natalidad real";
