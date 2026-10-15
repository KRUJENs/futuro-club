/**
 * VITAS · Tramos de la EVALUACIÓN DEL ENTRENADOR (VSI de ficha) — P1 bloque 5b
 *
 * Fuente única de los cortes con los que la app rotula la evaluación del entrenador
 * (Élite / Pro / Talento / En desarrollo). Antes había CUATRO juegos distintos: 80/65/50
 * (MetricsService.classifyVSI, MasterDashboard), 85/70/50 (VsiGauge, tarjeta compartible,
 * impreso del Hub), 85/70/55 (análisis base) y 85/70 (PlayerCard): el mismo niño era
 * «Élite» en una pantalla y «Pro» en otra (invariante #7).
 *
 * PROCEDENCIA: ningún corte tiene una fuente que lo respalde. Se conservan los que ya
 * veía el usuario en el indicador principal (85/70/50) y se declaran «pendiente de
 * validar». Además la evaluación es SUBJETIVA (6 barras que puntúa el entrenador): el
 * tramo describe esa valoración, no un nivel medido. No se inventa una cita.
 */

export const COACH_EVAL_TIERS_SOURCE = "pendiente de validar";

export type CoachEvalTier = "elite" | "pro" | "talent" | "develop";

/** De mayor a menor: el primer tramo cuyo mínimo se alcanza. */
export const COACH_EVAL_TIERS: ReadonlyArray<{ tier: CoachEvalTier; min: number }> = [
  { tier: "elite", min: 85 },
  { tier: "pro", min: 70 },
  { tier: "talent", min: 50 },
  { tier: "develop", min: 0 },
];
