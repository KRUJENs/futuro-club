/**
 * VITAS · PHV Calculator (REFACTOR DETERMINISTA · v2)
 * POST /api/agents/phv-calculator
 *
 * IMPORTANTE: Esta versión REEMPLAZA la antigua basada en LLM.
 * Mirwald formula es pura aritmética → no necesita Claude.
 *
 * Beneficios:
 * - Coste: €0 por cálculo (antes ~€0,005)
 * - Latencia: <5ms (antes 2-3 seg)
 * - Determinista: misma entrada → misma salida exacta
 * - Sin riesgo de alucinación del LLM
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ISO_DATE_RE, phvGate, type PhvGateBlocked } from "../../src/lib/phv/phvGate";

export const config = { runtime: "edge" };

const phvSchema = z.object({
  playerId: z.string().min(1),
  // Edad ENTERA del cliente: NO entra en Mirwald (regla del owner 28-sep). La edad
  // de la fórmula es la DECIMAL desde `birthDate`; sin fecha ⇒ 422.
  chronologicalAge: z.number().min(5).max(25),
  // Fecha de nacimiento del JUGADOR (ISO): fuente única de la edad decimal.
  birthDate: z.string().max(40).optional(),
  height: z.number().positive().optional(),         // cm
  weight: z.number().positive().optional(),         // kg
  sittingHeight: z.number().positive().optional(),  // cm
  legLength: z.number().positive().optional(),      // cm
  // Fecha en la que se tomaron las medidas (ISO): sin ella el gate bloquea (la edad del
  // cálculo es la de esa fecha, nunca hoy por defecto).
  measuredAt: z.string().max(40).regex(ISO_DATE_RE).optional(),
  currentVSI: z.number().min(0).max(100).optional(),
  // Sexo SIN default: el PHV es sexo-específico (invariante #5). Ausente ⇒ se
  // bloquea (throw PHV_MISSING_SEX), NUNCA se asume masculino ni femenino.
  gender: z.enum(["M", "F"]).optional(),
});

type PhvInput = z.infer<typeof phvSchema>;

interface PhvResult {
  playerId: string;
  chronologicalAge: number;
  offset: number;
  category: "early" | "ontime" | "late";
  phvStatus: "pre_phv" | "during_phv" | "post_phv";
  developmentWindow: "critical" | "active" | "stable";
  /** null sin VSI real del jugador (antes: base fija 70 ⇒ 78.4/70/64.4 inventados). */
  adjustedVSI: number | null;
  /** Motivo cuando adjustedVSI es null. */
  adjustedVSIGateReason: string | null;
  /** Edad usada en Mirwald: DECIMAL desde la fecha de nacimiento. */
  ageSource: "birth_date";
  recommendation: string;
  confidence: number;
  formula: "mirwald_male" | "mirwald_female";
  inputsUsed: { sittingHeight: "real" | "estimated"; legLength: "real" | "estimated" };
}

/**
 * Mirwald formula (Mirwald et al. 2002).
 * Calcula el offset de maduración (años) respecto al PHV.
 *
 * Para varones:
 *   MO = -9.236
 *      + 0.0002708 × (legLength × sittingHeight)
 *      − 0.001663  × (age × legLength)
 *      + 0.007216  × (age × sittingHeight)
 *      + 0.02292   × (weight / height × 100)
 *
 * Para mujeres (Moore 2015 alternativa, simplificada):
 *   MO = -9.376 + 0.0001882 × (legLength × sittingHeight)
 *      + 0.0022 × (age × legLength) + 0.005841 × (age × sittingHeight)
 *      - 0.002658 × (age × weight) + 0.07693 × (weight / height × 100)
 *
 * Nota: si no se aportan sittingHeight/legLength, se estiman:
 *   sittingHeight ≈ height × 0.52
 *   legLength     ≈ height × 0.48
 */
function calculateMaturityOffset(input: PhvInput): {
  offset: number;
  formula: "mirwald_male" | "mirwald_female";
  inputsUsed: { sittingHeight: "real" | "estimated"; legLength: "real" | "estimated" };
  confidence: number;
} {
  const age = input.chronologicalAge;
  const height = input.height ?? 0;
  const weight = input.weight ?? 0;

  // PHV Validation Gate: rechazar si faltan datos antropométricos reales
  if (!input.sittingHeight || !input.legLength) {
    throw new Error(
      "PHV_INCOMPLETE_DATA: Se requieren las 4 mediciones antropométricas reales " +
      "(altura, peso, altura sentado, longitud de pierna) para calcular el PHV. " +
      "No se permiten estimaciones."
    );
  }

  const sittingHeightUsed = input.sittingHeight;
  const legLengthUsed = input.legLength;

  const inputsUsed = {
    sittingHeight: "real" as const,
    legLength: "real" as const,
  };

  // Confianza: siempre alta porque ahora exigimos datos reales
  const confidence = 0.92;

  // Gate de sexo (invariante #5): sin sexo registrado NO se calcula — se bloquea,
  // en vez de caer al else (femenino) o asumir masculino.
  if (input.gender !== "M" && input.gender !== "F") {
    throw new Error(
      "PHV_MISSING_SEX: El sexo del jugador es obligatorio para el cálculo PHV " +
      "(la fórmula de Mirwald y las medias de referencia son sexo-específicas). " +
      "No se asume un sexo por defecto."
    );
  }

  let offset: number;
  let formula: "mirwald_male" | "mirwald_female";

  if (input.gender === "M") {
    formula = "mirwald_male";
    offset =
      -9.236 +
      0.0002708 * (legLengthUsed * sittingHeightUsed) -
      0.001663 * (age * legLengthUsed) +
      0.007216 * (age * sittingHeightUsed) +
      (height > 0 ? 0.02292 * ((weight / height) * 100) : 0);
  } else {
    formula = "mirwald_female";
    offset =
      -9.376 +
      0.0001882 * (legLengthUsed * sittingHeightUsed) +
      0.0022 * (age * legLengthUsed) +
      0.005841 * (age * sittingHeightUsed) -
      0.002658 * (age * weight) +
      (height > 0 ? 0.07693 * ((weight / height) * 100) : 0);
  }

  return { offset: Number(offset.toFixed(2)), formula, inputsUsed, confidence };
}

function categorize(offset: number): {
  category: PhvResult["category"];
  phvStatus: PhvResult["phvStatus"];
  developmentWindow: PhvResult["developmentWindow"];
} {
  let category: PhvResult["category"];
  let phvStatus: PhvResult["phvStatus"];
  let developmentWindow: PhvResult["developmentWindow"];

  if (offset < -1.0) {
    category = "early";
    phvStatus = "pre_phv";
  } else if (offset > 1.0) {
    category = "late";
    phvStatus = "post_phv";
  } else {
    category = "ontime";
    phvStatus = "during_phv";
  }

  if (phvStatus === "during_phv") developmentWindow = "critical";
  else if ((offset >= -2 && offset < -1) || (offset > 1 && offset <= 2))
    developmentWindow = "active";
  else developmentWindow = "stable";

  return { category, phvStatus, developmentWindow };
}

/**
 * VSI ajustado por maduración: SOLO con VSI real del jugador y con el factor
 * CANÓNICO del motor (maturity.ts · adjustmentFactor, por TIMING vs pares y 1
 * cuando el timing no es firme) que devuelve el gate único. Antes: base fija 70
 * sin VSI y ×1.12 a todo "early" (= pre-PHV, un ESTADO, no un timing) — una 5ª
 * copia paralela del ajuste (invariante #7) que inflaba a cualquier pre-púber.
 */
export const ADJUSTED_VSI_NO_VSI_REASON =
  "Sin VSI real del jugador: no se calcula un VSI ajustado por maduración.";

function adjustVSI(
  currentVSI: number | undefined,
  canonicalFactor: number,
): { value: number | null; gate_reason: string | null } {
  if (typeof currentVSI !== "number" || !Number.isFinite(currentVSI)) {
    return { value: null, gate_reason: ADJUSTED_VSI_NO_VSI_REASON };
  }
  return {
    value: Math.max(0, Math.min(100, Number((currentVSI * canonicalFactor).toFixed(1)))),
    gate_reason: null,
  };
}

/** Código/HTTP del bloqueo del gate (se conservan los códigos históricos). */
function gateError(g: PhvGateBlocked): { code: string; message: string } {
  const measures = g.missing.filter((k) => k !== "birthDate" && k !== "sex" && k !== "measuredAt");
  if (measures.length > 0) {
    return {
      code: "phv_incomplete_data",
      message:
        "PHV_INCOMPLETE_DATA: Se requieren las 4 mediciones antropométricas reales " +
        "(altura, peso, altura sentado, longitud de pierna) para calcular el PHV. " +
        `No se permiten estimaciones. ${g.gate_reason}`,
    };
  }
  if (g.missing.includes("sex")) {
    return {
      code: "phv_missing_sex",
      message:
        "PHV_MISSING_SEX: El sexo del jugador es obligatorio para el cálculo PHV " +
        "(la fórmula de Mirwald y las medias de referencia son sexo-específicas). " +
        `No se asume un sexo por defecto. ${g.gate_reason}`,
    };
  }
  if (g.missing.includes("birthDate")) {
    return {
      code: "phv_missing_birth_date",
      message:
        "PHV_MISSING_BIRTH_DATE: Mirwald exige la edad EXACTA (decimal) desde la fecha " +
        `de nacimiento del jugador; no se usa la edad entera. ${g.gate_reason}`,
    };
  }
  if (g.missing.includes("measuredAt")) {
    return {
      code: "phv_missing_measured_at",
      message:
        "PHV_MISSING_MEASURED_AT: hace falta la fecha en la que se tomaron las medidas; la edad " +
        `del cálculo es la de esa fecha, nunca la de hoy por defecto. ${g.gate_reason}`,
    };
  }
  return { code: "phv_out_of_range", message: `PHV_OUT_OF_RANGE: ${g.gate_reason}` };
}

function buildRecommendation(result: Omit<PhvResult, "recommendation">): string {
  const cat = result.category;
  const win = result.developmentWindow;

  if (cat === "early" && win === "critical") {
    return "Estirón en curso: priorizar técnica + coordinación. Reducir cargas pesadas.";
  }
  if (cat === "early" && win === "active") {
    return "Pre-estirón cercano: aprovechar ventana técnica antes del crecimiento rápido.";
  }
  if (cat === "ontime" && win === "critical") {
    return "Período crítico de maduración: trabajo técnico-coordinativo prioritario.";
  }
  if (cat === "late" && win === "stable") {
    return "Maduración tardía: foco en fuerza y resistencia. Paciencia con el desarrollo físico.";
  }
  if (cat === "late" && win === "active") {
    return "Post-estirón: consolidar adaptaciones, incrementar trabajo de fuerza progresivo.";
  }
  return "Desarrollo estable: mantener plan equilibrado de técnica, físico y táctica.";
}

export default withHandler(
  { schema: phvSchema, requireAuth: true, maxRequests: 100 },
  async ({ body }) => {
    try {
      const rawInput = body as PhvInput;
      // GATE ÚNICO (src/lib/phv/phvGate.ts · regla del owner 28-sep): talla, peso,
      // talla sentado, pierna (o talla − sentado), fecha de nacimiento → edad
      // DECIMAL y sexo registrado. Falta cualquiera ⇒ 422 con el motivo. Solo
      // cambia QUÉ entra (G6); la fórmula de abajo no se toca (invariante #4).
      const gate = phvGate({
        height: rawInput.height,
        weight: rawInput.weight,
        sittingHeight: rawInput.sittingHeight,
        legLength: rawInput.legLength,
        birthDate: rawInput.birthDate,
        gender: rawInput.gender,
        measuredAt: rawInput.measuredAt,
      });
      if (!gate.ok) {
        const e = gateError(gate);
        return errorResponse({ code: e.code, message: e.message, status: 422 });
      }
      const input: PhvInput = {
        ...rawInput,
        chronologicalAge: gate.ageYears, // decimal desde la fecha de nacimiento
        legLength: gate.legLengthCm,     // introducida, o talla − sentado introducidas
      };
      const { offset, formula, inputsUsed, confidence } = calculateMaturityOffset(input);
      const { category, phvStatus, developmentWindow } = categorize(offset);
      const adjusted = adjustVSI(input.currentVSI, gate.assessment.adjustmentFactor);

      const partialResult = {
        playerId: input.playerId,
        chronologicalAge: input.chronologicalAge,
        ageSource: "birth_date" as const,
        offset,
        category,
        phvStatus,
        developmentWindow,
        adjustedVSI: adjusted.value,
        adjustedVSIGateReason: adjusted.gate_reason,
        confidence,
        formula,
        inputsUsed,
      };

      const recommendation = buildRecommendation(partialResult);
      const result: PhvResult = { ...partialResult, recommendation };

      return successResponse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error in PHV calculation";
      const isIncomplete = message.includes("PHV_INCOMPLETE_DATA");
      const isMissingSex = message.includes("PHV_MISSING_SEX");
      // Ambos son datos requeridos faltantes (cliente) → 422, no 500.
      const isDataGate = isIncomplete || isMissingSex;
      return errorResponse({
        code: isMissingSex ? "phv_missing_sex" : isIncomplete ? "phv_incomplete_data" : "phv_calc_failed",
        message,
        status: isDataGate ? 422 : 500,
      });
    }
  }
);
