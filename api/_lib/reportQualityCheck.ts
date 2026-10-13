/**
 * VITAS · Lightweight Report Quality Check (Edge-compatible)
 *
 * Versión simplificada del reportValidator de src/services/real/ para usar
 * en Edge Functions. Detecta incoherencias básicas y genera feedback
 * para retry del agente.
 */

export interface QualityResult {
  valid: boolean;
  qualityScore: number;
  issues: string[];
  feedbackForAgent?: string;
}

/**
 * Valida coherencia básica de un reporte de Video Intelligence.
 */
export function checkPlayerReportQuality(
  report: Record<string, unknown>,
  playerAge: number,
): QualityResult {
  const issues: string[] = [];

  // 1. Campos requeridos top-level
  const required = ["estadoActual", "evaluacionPsicologica", "adnFutbolistico", "planDesarrollo", "confianza"];
  for (const key of required) {
    if (!(key in report)) issues.push(`Campo requerido ausente: ${key}`);
  }

  // 2. estadoActual con dimensiones
  const estado = report.estadoActual as Record<string, unknown> | undefined;
  if (estado) {
    if (!estado.resumenEjecutivo) issues.push("Falta resumenEjecutivo en estadoActual");
    if (!estado.dimensiones) issues.push("Falta dimensiones en estadoActual");

    const dims = estado.dimensiones as Record<string, { score?: number }> | undefined;
    if (dims) {
      const scores = Object.values(dims).map(d => d?.score).filter((s): s is number => typeof s === "number");
      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        // Dimension scores are 0-10 (as specified in Claude prompt)
        if (scores.some(s => s < 0 || s > 10)) {
          issues.push("Scores de dimensiones fuera de rango 0-10");
        }
        // ajusteVSIVideoScore is -15 to +15 (delta, not absolute)
        // High avg (≥7) with very negative adjustment, or low avg (<3.5) with very positive → incoherent
        const vsi = estado.ajusteVSIVideoScore as number | undefined;
        if (vsi !== undefined) {
          if (vsi < -15 || vsi > 15) {
            issues.push(`ajusteVSI (${vsi}) fuera de rango permitido (-15 a +15)`);
          }
          if (avg >= 7 && vsi < -10) {
            issues.push(`ajusteVSI negativo (${vsi}) incoherente con dimensiones altas (avg=${avg.toFixed(1)})`);
          }
          if (avg < 3.5 && vsi > 10) {
            issues.push(`ajusteVSI positivo (${vsi}) incoherente con dimensiones bajas (avg=${avg.toFixed(1)})`);
          }
        }
      }
    }
  }

  // 3. Edad vs proyección
  const plan = report.planDesarrollo as Record<string, unknown> | undefined;
  if (plan && playerAge < 12) {
    const obj = (plan.objetivo18meses ?? plan.objetivo6meses ?? "") as string;
    if (obj.toLowerCase().includes("profesional") || obj.toLowerCase().includes("primera división")) {
      issues.push("Proyección demasiado ambiciosa para jugador < 12 años");
    }
  }

  // 4. Confianza en rango
  const conf = report.confianza as number | undefined;
  if (conf !== undefined && (conf < 0 || conf > 1)) {
    issues.push("Confianza fuera de rango 0-1");
  }

  // 5. Evaluación psicológica con valores
  const psych = report.evaluacionPsicologica as Record<string, unknown> | undefined;
  if (psych) {
    const vals = Object.values(psych).filter(v => typeof v === "number") as number[];
    if (vals.some(v => v < 0 || v > 100)) {
      issues.push("Valores psicológicos fuera de rango 0-100");
    }
  }

  const errorCount = issues.length;
  const qualityScore = Math.max(0, 100 - errorCount * 15);
  const valid = errorCount === 0;

  let feedbackForAgent: string | undefined;
  if (!valid) {
    feedbackForAgent = `VALIDACIÓN SEMÁNTICA FALLIDA. Corrige estos errores:\n${
      issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")
    }\n\nRegenera el JSON corrigiendo SOLO los campos mencionados. Mantén el resto igual.`;
  }

  return { valid, qualityScore, issues, feedbackForAgent };
}

/**
 * Valida coherencia básica de un reporte de Team Intelligence.
 */
export function checkTeamReportQuality(
  report: Record<string, unknown>,
): QualityResult {
  const issues: string[] = [];

  // 1. Campos requeridos — solo nivel de equipo. "jugadores" ya no se pide ni se
  //    valida (identidad.md: sin dorsal validado no hay filas por jugador); pedirlo
  //    aquí haría que el reintento las volviera a generar.
  const required = ["resumenEjecutivo", "formacion", "evaluacionGeneral"];
  for (const key of required) {
    if (!(key in report)) issues.push(`Campo requerido ausente: ${key}`);
  }

  // 2. Posesión realista
  const posesion = report.posesion as Record<string, unknown> | undefined;
  const pct = posesion?.porcentaje as number | null | undefined;
  if (typeof pct === "number" && (pct < 20 || pct > 80)) {
    issues.push(`Posesión ${pct}% fuera de rango realista (20-80%)`);
  }

  // 3. Confianza en rango
  const conf = report.confianza as number | undefined;
  if (conf !== undefined && (conf < 0 || conf > 1)) {
    issues.push("Confianza fuera de rango 0-1");
  }

  const errorCount = issues.length;
  const qualityScore = Math.max(0, 100 - errorCount * 15);
  const valid = errorCount === 0;

  let feedbackForAgent: string | undefined;
  if (!valid) {
    feedbackForAgent = `VALIDACIÓN SEMÁNTICA FALLIDA. Corrige estos errores:\n${
      issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")
    }\n\nRegenera el JSON corrigiendo SOLO los campos mencionados. Mantén el resto igual.`;
  }

  return { valid, qualityScore, issues, feedbackForAgent };
}
