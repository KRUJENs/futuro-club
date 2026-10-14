/**
 * VITAS · Escudo de Estirón / Growth-Spurt Shield (Sprint 2.5 💎)
 *
 * Cruce único PHV × riesgo de lesión — la seguridad del hijo es el botón
 * emocional #1 del padre pagador (canal B2C del Plan Familia).
 *
 * Durante la ventana PHV (pico de crecimiento) el riesgo de lesión de
 * crecimiento se dispara: Osgood-Schlatter (rodilla), Sever (talón),
 * Sinding-Larsen. Reutiliza los MISMOS umbrales que el injury model
 * (`api/agents/_injury-risk-calculator.ts` → phvWindowRisk) para consistencia:
 *
 *   |offset| ≤ 0.5 → 90 (pico PHV, riesgo máximo)
 *   |offset| ≤ 1.0 → 70 (cerca del PHV, alto)
 *   |offset| ≤ 1.5 → 50 (moderado)
 *   |offset| ≤ 2.0 → 30 (bajo)
 *   > 2.0          → 10 (mínimo)
 */

export type ShieldLevel = "peak" | "high" | "moderate" | "low" | "minimal";

export interface GrowthSpurtShield {
  active: boolean;             // true si conviene proteger (nivel ≥ moderate)
  /** true ⇒ NO hay offset PHV fiable (datos estimados/ausentes): estado DESCONOCIDO,
   *  no "bajo riesgo confirmado". La UI debe pintarlo como abstención, no en verde. */
  abstained: boolean;
  level: ShieldLevel;
  riskScore: number;          // 0-100 (mismo que injury phvWindowRisk)
  /** Reducción de carga recomendada (%). */
  loadReductionPct: number;
  /** Semanas estimadas de ventana sensible restante. */
  windowWeeks: number;
  /** Lesiones de crecimiento a vigilar en esta fase. */
  watchInjuries: string[];
  /** Mensaje para el COACH (técnico). */
  coachMessage: string;
  /** Mensaje para el PADRE (lenguaje llano, tranquilizador). */
  parentMessage: string;
}

/**
 * Nivel de la ventana de estirón a partir del offset PHV (de la puerta). Exportado
 * para que el modelo de riesgo de lesión use ESTA definición y no una propia
 * (P1 bloque 4b, inv #7). Los valores no cambian.
 */
export function levelFromOffset(offset: number): { level: ShieldLevel; risk: number } {
  const a = Math.abs(offset);
  if (a <= 0.5) return { level: "peak", risk: 90 };
  if (a <= 1.0) return { level: "high", risk: 70 };
  if (a <= 1.5) return { level: "moderate", risk: 50 };
  if (a <= 2.0) return { level: "low", risk: 30 };
  return { level: "minimal", risk: 10 };
}

const LOAD_REDUCTION: Record<ShieldLevel, number> = {
  peak: 25,
  high: 20,
  moderate: 10,
  low: 0,
  minimal: 0,
};

const WINDOW_WEEKS: Record<ShieldLevel, number> = {
  peak: 12,
  high: 8,
  moderate: 5,
  low: 0,
  minimal: 0,
};

export function assessGrowthSpurtShield(
  offset: number | null | undefined,
  playerName = "el jugador",
): GrowthSpurtShield {
  // offset == null ⇒ NO hay un offset PHV fiable (típicamente porque altura-sentado y/o
  // longitud-de-pierna NO están medidas y tuvieron que estimarse). NO se emite una
  // recomendación de carga/riesgo sobre datos estimados: se abstiene pidiendo las medidas.
  if (offset == null) {
    return {
      active: false,
      abstained: true, // estado DESCONOCIDO (no "bajo riesgo"): la UI lo pinta neutro, no verde
      level: "minimal",
      riskScore: 0,
      loadReductionPct: 0,
      windowWeeks: 0,
      watchInjuries: [],
      coachMessage: "Sin antropometría medida suficiente (altura sentado + longitud de pierna) para evaluar la ventana de estirón con fiabilidad.",
      parentMessage: "Faltan medidas antropométricas del jugador (altura sentado y longitud de pierna) para activar el Escudo de Estirón. Sin ellas no damos una recomendación de carga ni de riesgo.",
    };
  }

  const { level, risk } = levelFromOffset(offset);
  const loadReductionPct = LOAD_REDUCTION[level];
  const windowWeeks = WINDOW_WEEKS[level];
  const active = level === "peak" || level === "high" || level === "moderate";

  const watchInjuries =
    active
      ? ["Osgood-Schlatter (rodilla)", "Sever (talón)", "Sinding-Larsen (rótula)"]
      : [];

  let coachMessage: string;
  let parentMessage: string;

  if (level === "peak") {
    coachMessage =
      `⚠️ ${playerName} está en el PICO de su estirón (offset ${offset.toFixed(1)}). ` +
      `Riesgo de lesión de crecimiento MÁXIMO. Reduce la carga de alta intensidad ~${loadReductionPct}% durante ~${windowWeeks} semanas, ` +
      `prioriza movilidad y control excéntrico. Vigila molestias en rodilla y talón.`;
    parentMessage =
      `${playerName} está en pleno estirón 🌱. Es una fase normal y positiva, pero el cuerpo crece más rápido que músculos y tendones, ` +
      `así que hay más riesgo de molestias (rodilla, talón). VITAS ha avisado al entrenador para ajustar su carga y protegerlo estas semanas.`;
  } else if (level === "high") {
    coachMessage =
      `⚠️ ${playerName} entra en ventana de estirón (offset ${offset.toFixed(1)}). ` +
      `Riesgo elevado. Reduce carga ~${loadReductionPct}% ~${windowWeeks} semanas y monitoriza dolor de crecimiento.`;
    parentMessage =
      `${playerName} está entrando en su estirón 🌱. Ajustaremos su entrenamiento para cuidar sus articulaciones. Si se queja de rodilla o talón, es normal — coméntalo con el club.`;
  } else if (level === "moderate") {
    coachMessage =
      `${playerName} está cerca de su ventana de estirón (offset ${offset.toFixed(1)}). Riesgo moderado — vigilancia preventiva, sin cambios drásticos de carga.`;
    parentMessage =
      `${playerName} se acerca a su fase de crecimiento rápido. Todo normal; VITAS lo monitoriza para anticiparse.`;
  } else {
    coachMessage = `${playerName} fuera de la ventana de estirón de mayor riesgo (offset ${offset.toFixed(1)}). Carga normal.`;
    parentMessage = `${playerName} no está en fase de estirón de riesgo ahora mismo. Todo en orden.`;
  }

  return {
    active,
    abstained: false, // offset real → resultado computado (no abstención)
    level,
    riskScore: risk,
    loadReductionPct,
    windowWeeks,
    watchInjuries,
    coachMessage,
    parentMessage,
  };
}
