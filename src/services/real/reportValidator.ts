/**
 * VITAS · Report Semantic Validator
 *
 * Equivalente adaptado del loop compile→lint→test para agentes de código.
 * En VITAS no generamos código, generamos REPORTES. Este servicio valida
 * que un reporte de Video Intelligence o Team Intelligence sea coherente
 * semánticamente — no solo sintácticamente (eso lo hace Zod).
 *
 * Flujo:
 *   Claude genera reporte JSON
 *     → Zod validation: ¿JSON válido con tipos correctos? (ya existe)
 *     → Semantic validation (ESTE SERVICIO):
 *        → ¿Scores coherentes con nivelActual?
 *        → ¿Edad realista para la proyección?
 *        → ¿Dimensiones alineadas con fortalezas?
 *        → ¿Métricas físicas plausibles?
 *     → Si falla → feedback estructurado al agente (retry)
 *     → Si pasa → ✅ reporte validado
 *
 * IMPORTANTE: Este servicio NO modifica los datos. Solo detecta incoherencias
 * y genera feedback estructurado para que el agente se autocorrija.
 */

import type { VideoIntelligenceOutput } from "@/agents/contracts";
import type { TeamIntelligenceOutput } from "@/agents/contracts";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  /** Regla que falló */
  rule: string;
  /** Severidad: error bloquea, warning se reporta pero pasa */
  severity: "error" | "warning";
  /** Campo(s) involucrado(s) */
  fields: string[];
  /** Descripción legible del problema */
  message: string;
  /** Sugerencia de corrección para el agente */
  suggestedFix: string;
}

export interface ValidationResult {
  /** Si el reporte es aceptable (no tiene errors, puede tener warnings) */
  valid: boolean;
  /** Issues encontrados */
  issues: ValidationIssue[];
  /** Score de calidad 0-100 (100 = perfecto) */
  qualityScore: number;
  /** Feedback estructurado para retry del agente (si inválido) */
  feedbackForAgent?: string;
}

// ── Player Report Validator ───────────────────────────────────────────────────

/**
 * Valida coherencia semántica de un reporte de Video Intelligence.
 * Recibe el output del agente + el contexto del jugador para cross-check.
 */
export function validatePlayerReport(
  report: VideoIntelligenceOutput,
  playerContext: {
    age: number;
    position: string;
    currentVSI?: number;
  }
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // ── Regla 1: nivelActual coherente con dimensiones ──────────────────
  const dims = report.estadoActual.dimensiones;
  const avgScore = (
    dims.velocidadDecision.score +
    dims.tecnicaConBalon.score +
    dims.inteligenciaTactica.score +
    dims.capacidadFisica.score +
    dims.liderazgoPresencia.score +
    dims.eficaciaCompetitiva.score
  ) / 6;

  const nivel = report.estadoActual.nivelActual;

  if (nivel === "elite" && avgScore < 6.5) {
    issues.push({
      rule: "nivel_dimension_coherence",
      severity: "error",
      fields: ["estadoActual.nivelActual", "estadoActual.dimensiones"],
      message: `nivelActual es "elite" pero el promedio de dimensiones es ${avgScore.toFixed(1)}/10. Un nivel elite requiere promedio >=6.5.`,
      suggestedFix: `Ajusta nivelActual a "${avgScore >= 5.5 ? "alto" : avgScore >= 4.0 ? "medio_alto" : "medio"}" o sube los scores de dimensiones para ser coherente con elite.`,
    });
  }

  if (nivel === "desarrollo" && avgScore > 5.5) {
    issues.push({
      rule: "nivel_dimension_coherence",
      severity: "error",
      fields: ["estadoActual.nivelActual", "estadoActual.dimensiones"],
      message: `nivelActual es "desarrollo" pero el promedio de dimensiones es ${avgScore.toFixed(1)}/10. Un nivel desarrollo implica promedio <5.5.`,
      suggestedFix: `Ajusta nivelActual a "${avgScore >= 7.0 ? "alto" : "medio_alto"}" o baja los scores para ser coherente con desarrollo.`,
    });
  }

  if ((nivel === "alto" || nivel === "medio_alto") && avgScore < 3.5) {
    issues.push({
      rule: "nivel_dimension_coherence",
      severity: "error",
      fields: ["estadoActual.nivelActual", "estadoActual.dimensiones"],
      message: `nivelActual es "${nivel}" pero el promedio de dimensiones es solo ${avgScore.toFixed(1)}/10. Incoherente.`,
      suggestedFix: `Ajusta nivelActual a "desarrollo" o "medio" para reflejar las dimensiones reales.`,
    });
  }

  // ── Regla 2: Fortalezas alineadas con dimensiones altas ─────────────
  const dimEntries = [
    { name: "velocidadDecision", score: dims.velocidadDecision.score },
    { name: "tecnicaConBalon", score: dims.tecnicaConBalon.score },
    { name: "inteligenciaTactica", score: dims.inteligenciaTactica.score },
    { name: "capacidadFisica", score: dims.capacidadFisica.score },
    { name: "liderazgoPresencia", score: dims.liderazgoPresencia.score },
    { name: "eficaciaCompetitiva", score: dims.eficaciaCompetitiva.score },
  ];
  const allScoresLow = dimEntries.every(d => d.score < 4);
  const hasStrengths = report.estadoActual.fortalezasPrimarias.length > 2;

  if (allScoresLow && hasStrengths) {
    issues.push({
      rule: "strengths_dimension_alignment",
      severity: "warning",
      fields: ["estadoActual.fortalezasPrimarias", "estadoActual.dimensiones"],
      message: `Se listan ${report.estadoActual.fortalezasPrimarias.length} fortalezas pero todas las dimensiones son <4/10.`,
      suggestedFix: "Reduce las fortalezas a 1-2 máximo si las dimensiones son bajas, o sube las dimensiones correspondientes.",
    });
  }

  // ── Regla 3: Edad realista para proyección ──────────────────────────
  const age = playerContext.age;

  // Si la proyección está gateada (null, sin datos reales, #40 clase) no hay nivel que validar.
  if (age <= 10 && report.proyeccionCarrera) {
    const optLevel = report.proyeccionCarrera.escenarioOptimista.nivelProyecto.toLowerCase();
    if (optLevel.includes("primera") || optLevel.includes("champions") || optLevel.includes("top")) {
      issues.push({
        rule: "age_projection_realism",
        severity: "warning",
        fields: ["proyeccionCarrera.escenarioOptimista.nivelProyecto"],
        message: `Jugador de ${age} años con proyección optimista de "${report.proyeccionCarrera.escenarioOptimista.nivelProyecto}". Es prematuro proyectar a este nivel con tan poca edad.`,
        suggestedFix: "Para menores de 11 años, usa proyecciones más cautelosas como 'categorías formativas competitivas' o 'academia de primer nivel'.",
      });
    }
  }

  if (age >= 19) {
    const window = report.planDesarrollo;
    if (window.objetivo18meses.toLowerCase().includes("formativ") || window.objetivo18meses.toLowerCase().includes("cantera")) {
      issues.push({
        rule: "age_plan_coherence",
        severity: "warning",
        fields: ["planDesarrollo.objetivo18meses"],
        message: `Jugador de ${age} años con objetivo a 18 meses de "formativo/cantera". A esta edad debería estar en transición a competición senior.`,
        suggestedFix: "Para jugadores de 19+, orienta los objetivos hacia integración en primer equipo o competición senior.",
      });
    }
  }

  // ── Regla 4: VSI adjustment coherente con dimensiones ───────────────
  // Si el VSI-vídeo está bloqueado (delta null, #40) no hay ajuste que validar.
  const vsiDelta = report.estadoActual.ajusteVSIVideoScore;

  if (vsiDelta != null && avgScore >= 7 && vsiDelta < -5) {
    issues.push({
      rule: "vsi_dimension_coherence",
      severity: "error",
      fields: ["estadoActual.ajusteVSIVideoScore", "estadoActual.dimensiones"],
      message: `Dimensiones promedio altas (${avgScore.toFixed(1)}/10) pero ajusteVSI es negativo (${vsiDelta}). Incoherente: buenas dimensiones deberían subir o mantener el VSI.`,
      suggestedFix: "Si las dimensiones son altas, el ajusteVSIVideoScore debería ser >=0.",
    });
  }

  if (vsiDelta != null && avgScore < 3.5 && vsiDelta > 5) {
    issues.push({
      rule: "vsi_dimension_coherence",
      severity: "error",
      fields: ["estadoActual.ajusteVSIVideoScore", "estadoActual.dimensiones"],
      message: `Dimensiones promedio bajas (${avgScore.toFixed(1)}/10) pero ajusteVSI es muy positivo (+${vsiDelta}). Incoherente.`,
      suggestedFix: "Si las dimensiones son bajas, el ajusteVSIVideoScore debería ser <=0.",
    });
  }

  // ── Regla 5: Métricas físicas plausibles ────────────────────────────
  const phys = report.metricasCuantitativas?.fisicas;
  if (phys) {
    if (phys.velocidadMaxKmh > 38) {
      issues.push({
        rule: "physical_plausibility",
        severity: "error",
        fields: ["metricasCuantitativas.fisicas.velocidadMaxKmh"],
        message: `Velocidad máxima de ${phys.velocidadMaxKmh} km/h es imposible. Usain Bolt alcanza ~37 km/h. Máximo razonable para juveniles: 33 km/h.`,
        suggestedFix: "Ajusta la velocidad máxima a un rango realista (15-33 km/h para juveniles de fútbol).",
      });
    }

    if (phys.velocidadPromKmh > phys.velocidadMaxKmh) {
      issues.push({
        rule: "physical_plausibility",
        severity: "error",
        fields: ["metricasCuantitativas.fisicas.velocidadPromKmh", "metricasCuantitativas.fisicas.velocidadMaxKmh"],
        message: `Velocidad promedio (${phys.velocidadPromKmh}) mayor que velocidad máxima (${phys.velocidadMaxKmh}). Imposible.`,
        suggestedFix: "La velocidad promedio siempre debe ser menor que la máxima. Típicamente: promedio = 5-9 km/h, máx = 20-33 km/h.",
      });
    }

    if (phys.distanciaM > 15000) {
      issues.push({
        rule: "physical_plausibility",
        severity: "warning",
        fields: ["metricasCuantitativas.fisicas.distanciaM"],
        message: `Distancia de ${phys.distanciaM}m (${(phys.distanciaM / 1000).toFixed(1)}km) es excesiva. Máximo en un partido profesional: ~13km.`,
        suggestedFix: "Ajusta la distancia a un rango realista según la duración del video analizado.",
      });
    }

    // Zonas de intensidad deben sumar ~100% (con tolerancia)
    const zones = phys.zonasIntensidad;
    const total = zones.caminar + zones.trotar + zones.correr + zones.sprint;
    if (total > 0 && (total < 90 || total > 110)) {
      issues.push({
        rule: "physical_zones_sum",
        severity: "warning",
        fields: ["metricasCuantitativas.fisicas.zonasIntensidad"],
        message: `Las zonas de intensidad suman ${total}%. Deberían sumar ~100% (tolerancia: 90-110%).`,
        suggestedFix: "Ajusta los porcentajes de zonas de intensidad para que sumen 100%.",
      });
    }
  }

  // ── Regla 6: Eventos coherentes entre sí ────────────────────────────
  const events = report.metricasCuantitativas?.eventos;
  if (events) {
    const totalPasses = events.pasesCompletados + events.pasesFallados;
    if (totalPasses > 0) {
      const precision = events.pasesCompletados / totalPasses * 100;
      const reportedPrecision = events.precisionPases;

      if (Math.abs(precision - reportedPrecision) > 5) {
        issues.push({
          rule: "event_consistency",
          severity: "error",
          fields: ["metricasCuantitativas.eventos.precisionPases"],
          message: `precisionPases reportada (${reportedPrecision}%) no coincide con la calculada (${precision.toFixed(1)}% = ${events.pasesCompletados}/${totalPasses}).`,
          suggestedFix: `Corrige precisionPases a ${Math.round(precision)}% basado en completados/total.`,
        });
      }
    }

    const totalDuels = events.duelosGanados + events.duelosPerdidos;
    if (totalDuels > 100) {
      issues.push({
        rule: "event_plausibility",
        severity: "warning",
        fields: ["metricasCuantitativas.eventos"],
        message: `${totalDuels} duelos totales es excesivo para un video corto. Rango típico: 5-50.`,
        suggestedFix: "Revisa el conteo de eventos. Un jugador raramente supera 30-40 duelos en un partido completo.",
      });
    }
  }

  // ── Regla 7: Jugador referencia score coherente ─────────────────────
  if (report.jugadorReferencia.bestMatch.score < 20) {
    issues.push({
      rule: "reference_player_quality",
      severity: "warning",
      fields: ["jugadorReferencia.bestMatch.score"],
      message: `El mejor match de similitud tiene score ${report.jugadorReferencia.bestMatch.score}/100. Un score tan bajo sugiere que no hay referencia real.`,
      suggestedFix: "Si no hay una similitud fuerte, menciona que el perfil es único o emergente en la narrativa.",
    });
  }

  // ── Regla 8: Plan de desarrollo coherente con áreas de desarrollo ───
  const areasDesarrollo = report.estadoActual.areasDesarrollo;
  const pilares = report.planDesarrollo.pilaresTrabajo;

  if (areasDesarrollo.length > 0 && pilares.length === 0) {
    issues.push({
      rule: "plan_coverage",
      severity: "warning",
      fields: ["planDesarrollo.pilaresTrabajo", "estadoActual.areasDesarrollo"],
      message: `Se identificaron ${areasDesarrollo.length} áreas de desarrollo pero el plan no tiene pilares de trabajo.`,
      suggestedFix: "Cada área de desarrollo debería tener al menos un pilar de trabajo asociado.",
    });
  }

  // ── Calcular quality score ──────────────────────────────────────────
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const qualityScore = Math.max(0, 100 - (errorCount * 20) - (warningCount * 5));

  // ── Generar feedback para agente ────────────────────────────────────
  const valid = errorCount === 0;
  let feedbackForAgent: string | undefined;

  if (!valid) {
    const errorIssues = issues.filter(i => i.severity === "error");
    feedbackForAgent = [
      "VALIDACIÓN SEMÁNTICA FALLIDA. Corrige estos errores:",
      ...errorIssues.map((issue, i) =>
        `${i + 1}. [${issue.rule}] ${issue.message}\n   FIX: ${issue.suggestedFix}`
      ),
      "",
      "Regenera el JSON corrigiendo SOLO los campos mencionados. Mantén el resto igual.",
    ].join("\n");
  }

  return { valid, issues, qualityScore, feedbackForAgent };
}

// ── Team Report Validator ─────────────────────────────────────────────────────

/**
 * Valida coherencia semántica de un reporte de Team Intelligence.
 *
 * Solo nivel de equipo (identidad.md): el informe ya no lleva filas por jugador
 * (dorsal estimado por el LLM + cifras por jugador), así que las antiguas reglas
 * por jugador (recuento de filas, velocidad/distancia por jugador, rendimiento
 * individual frente a la evaluación) se retiraron con ellas.
 */
export function validateTeamReport(report: TeamIntelligenceOutput): ValidationResult {
  const issues: ValidationIssue[] = [];

  // ── Regla 2: Posesión realista ──────────────────────────────────────
  // null = posesión no observada (gateada, P1 bloque 2): no hay nada que validar.
  // Antes `null < 10` era true ⇒ «Posesión de null% es extrema».
  const posesion = report.posesion?.porcentaje;
  if (typeof posesion === "number" && (posesion < 10 || posesion > 90)) {
    issues.push({
      rule: "possession_realism",
      severity: "warning",
      fields: ["posesion.porcentaje"],
      message: `Posesión de ${posesion}% es extrema. El rango típico en fútbol es 30-70%.`,
      suggestedFix: "Ajusta la posesión a un rango realista. Incluso equipos muy dominantes raramente superan 75%.",
    });
  }

  // ── Regla 3: Métricas colectivas coherentes ────────────────────────
  const { compacidad, amplitud, sincronizacion } = report.metricasColectivas;

  if (compacidad >= 9 && amplitud >= 9) {
    issues.push({
      rule: "collective_metrics_coherence",
      severity: "warning",
      fields: ["metricasColectivas.compacidad", "metricasColectivas.amplitud"],
      message: `Compacidad (${compacidad}/10) y amplitud (${amplitud}/10) ambas muy altas. Generalmente son inversamente proporcionales.`,
      suggestedFix: "Un equipo muy compacto suele tener amplitud moderada y viceversa. Ajusta una de las dos.",
    });
  }

  // ── Regla 4: Pressing coherente con línea defensiva ─────────────────
  const pressing = report.fasesJuego.pressing;
  const lineaDefensiva = report.metricasColectivas.alturaLineaDefensiva;

  if (pressing.alturaLinea === "alta" && pressing.intensidad >= 7 && lineaDefensiva === "baja") {
    issues.push({
      rule: "pressing_line_coherence",
      severity: "error",
      fields: ["fasesJuego.pressing", "metricasColectivas.alturaLineaDefensiva"],
      message: `Pressing alto (${pressing.alturaLinea}, intensidad ${pressing.intensidad}/10) con línea defensiva baja es contradictorio.`,
      suggestedFix: "Si el pressing es alto e intenso, la línea defensiva debería ser media o alta.",
    });
  }

  // ── Calcular quality score ──────────────────────────────────────────
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const qualityScore = Math.max(0, 100 - (errorCount * 20) - (warningCount * 5));

  const valid = errorCount === 0;
  let feedbackForAgent: string | undefined;

  if (!valid) {
    const errorIssues = issues.filter(i => i.severity === "error");
    feedbackForAgent = [
      "VALIDACIÓN SEMÁNTICA FALLIDA. Corrige estos errores:",
      ...errorIssues.map((issue, i) =>
        `${i + 1}. [${issue.rule}] ${issue.message}\n   FIX: ${issue.suggestedFix}`
      ),
      "",
      "Regenera el JSON corrigiendo SOLO los campos mencionados. Mantén el resto igual.",
    ].join("\n");
  }

  return { valid, issues, qualityScore, feedbackForAgent };
}

// ── PHV Sanity Check ──────────────────────────────────────────────────────────

/**
 * Validación rápida de coherencia para PHV output.
 */
export function validatePHVOutput(
  output: { ageAtPHV: number; chronologicalAge: number; offset: number; category: string; adjustedVSI: number },
  inputAge: number
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // APHV (Mirwald 2002): el offset se RESTA de la edad → ageAtPHV = edad − offset,
  // por tanto offset debe ser chronologicalAge − ageAtPHV.
  const expectedOffset = output.chronologicalAge - output.ageAtPHV;
  if (Math.abs(output.offset - expectedOffset) > 0.1) {
    issues.push({
      rule: "phv_offset_consistency",
      severity: "error",
      fields: ["offset", "ageAtPHV", "chronologicalAge"],
      message: `offset (${output.offset}) no coincide con chronologicalAge (${output.chronologicalAge}) - ageAtPHV (${output.ageAtPHV}) = ${expectedOffset.toFixed(2)}.`,
      suggestedFix: `Corrige offset a ${expectedOffset.toFixed(2)}.`,
    });
  }

  // Category debe coincidir con offset
  const expectedCategory = output.offset < -1 ? "early" : output.offset > 1 ? "late" : "ontme";
  if (output.category !== expectedCategory) {
    issues.push({
      rule: "phv_category_consistency",
      severity: "error",
      fields: ["category", "offset"],
      message: `category "${output.category}" no coincide con offset ${output.offset}. Debería ser "${expectedCategory}".`,
      suggestedFix: `Corrige category a "${expectedCategory}" basado en el offset.`,
    });
  }

  // ageAtPHV (edad estimada del estirón) plausible: el PHV ocurre ~9-18 años.
  if (output.ageAtPHV < 8 || output.ageAtPHV > 18) {
    issues.push({
      rule: "phv_age_plausibility",
      severity: "error",
      fields: ["ageAtPHV"],
      message: `ageAtPHV ${output.ageAtPHV} fuera de rango plausible (8-18).`,
      suggestedFix: "Revisa el cálculo de la fórmula Mirwald. ageAtPHV debe estar entre 8 y 18.",
    });
  }

  // adjustedVSI en rango
  if (output.adjustedVSI < 0 || output.adjustedVSI > 100) {
    issues.push({
      rule: "phv_vsi_range",
      severity: "error",
      fields: ["adjustedVSI"],
      message: `adjustedVSI ${output.adjustedVSI} fuera de rango (0-100).`,
      suggestedFix: "Clamp adjustedVSI entre 0 y 100.",
    });
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const qualityScore = Math.max(0, 100 - (errorCount * 20) - (warningCount * 5));

  return {
    valid: errorCount === 0,
    issues,
    qualityScore,
    feedbackForAgent: errorCount > 0
      ? issues.filter(i => i.severity === "error").map(i => `[${i.rule}] ${i.message} FIX: ${i.suggestedFix}`).join("\n")
      : undefined,
  };
}
