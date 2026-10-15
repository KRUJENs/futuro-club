/**
 * VITAS · Glosario de métricas (Sprint 4.4)
 *
 * Definiciones in-context de los términos de dominio, para tooltips (TermTooltip).
 * Centraliza lo que antes estaba en texto suelto por los componentes.
 */
export interface GlossaryTerm {
  term: string;
  short: string;
  long: string;
  /** Si existe, TermTooltip traduce term/short/long desde `<i18nKey>.term|short|long`
   *  (7 idiomas); los textos de arriba son el respaldo en español. */
  i18nKey?: string;
}

export const GLOSSARY: Record<string, GlossaryTerm> = {
  // P1 bloque 5b: el VSI de ficha es la EVALUACIÓN DEL ENTRENADOR (6 barras subjetivas),
  // no un «índice compuesto del rendimiento» medido por el sistema. Es un término DISTINTO
  // del VSI de vídeo (abajo): no comparten entrada para que un rótulo no se cuele en el otro.
  coachEval: {
    term: "Evaluación del entrenador",
    short: "VSI de ficha",
    long: "Índice 0-100 que pondera las 6 barras que puntúa el entrenador (velocidad, técnica, visión, resistencia, tiro y defensa). Es una valoración subjetiva: no es una medida ni está corregida por maduración.",
    i18nKey: "coachEval.glossary",
  },
  // El VSI de los ANÁLISIS DE VÍDEO (pipeline/IA; p. ej. player_metric_snapshots.vsi) sigue
  // llamándose «VSI»: es otro índice y no es la evaluación del entrenador.
  videoVsi: {
    term: "VSI de vídeo",
    short: "Índice de los análisis de vídeo",
    long: "Índice 0-100 que calcula el análisis de vídeo (IA) con lo observado en el vídeo. Es distinto de la evaluación del entrenador (sus 6 barras) y se bloquea si faltan sus entradas.",
    i18nKey: "videoVsiGlossary",
  },
  phv: {
    term: "PHV",
    short: "Peak Height Velocity",
    long: "Pico de velocidad de crecimiento. VITAS estima la maduración por el % de talla adulta (Khamis-Roche) y la edad del PHV (APHV = edad − offset de Mirwald), y corrige el rendimiento según el timing vs pares (madurador precoz/tardío), no solo la edad cronológica.",
  },
  vaep: {
    term: "VAEP",
    short: "Valuing Actions by Estimating Probabilities",
    long: "Valora cada acción por cuánto cambia la probabilidad de marcar o de encajar un gol.",
  },
  acwr: {
    term: "ACWR",
    short: "Acute:Chronic Workload Ratio",
    long: "Ratio entre carga aguda (7 días) y crónica (28 días). Zona óptima ~0.8–1.3; por encima de 1.5 sube el riesgo de lesión.",
  },
  scaniq: {
    term: "Scan IQ",
    short: "Escaneo pre-recepción",
    long: "Frecuencia con que el jugador escanea el entorno antes de recibir el balón, calibrada por edad (investigación de Jordet).",
  },
  dmscore: {
    term: "DM Score",
    short: "Decision-Making Score",
    long: "Score 0-100 de toma de decisiones: Scan IQ + velocidad de decisión + composure bajo presión + lectura táctica.",
  },
};

/** Normaliza una clave ("Scan IQ", "PHV offset") a la del glosario. */
export function glossaryLookup(key: string): GlossaryTerm | undefined {
  // Sin distinguir mayúsculas: las claves pueden ser camelCase (coachEval, videoVsi).
  const k = key.replace(/[^a-zA-Z]/g, "").toLowerCase();
  return Object.entries(GLOSSARY).find(([name]) => name.toLowerCase() === k)?.[1];
}
