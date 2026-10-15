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
