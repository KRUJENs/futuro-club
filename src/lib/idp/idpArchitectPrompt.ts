/**
 * VITAS · IDP Architect Prompt builder (shared)
 *
 * Single source of truth for the prompt sent to Claude Sonnet by:
 *   - api/agents/_idp-architect.ts (public endpoint)
 *   - api/idp/_generate-plan.ts (orchestrator, calls Claude inline to skip round-trip)
 *
 * Keep both callers in sync — version the prompt here.
 */

import type { IDPArchitectInput } from "../../agents/contracts";
import { normalizeLocale, languageDirective, type ReportLocale } from "../shared/locale";
import { idpDimensionsWithData } from "./idpGoalGenerator";

// v1.1.0 (P1 bloque 5d): edad, posición y dimensiones pueden faltar («sin dato»).
// v1.2.0: metas SOLO de dimensiones con dato, entre 1 y 5 (antes 3-5 obligatorias).
export const IDP_PROMPT_VERSION = "v1.2.0";

export function buildIDPArchitectPrompt(
  data: IDPArchitectInput,
  locale: ReportLocale = normalizeLocale(data.locale),
): string {
  const p = data.player;
  // Dimensiones con dato real: las únicas en las que el agente puede fijar metas (P1 5d,
  // revisión del #320: antes debía dar 3-5 metas con baseline numérica aunque no hubiera
  // dato, y el modelo las rellenaba).
  const withData = idpDimensionsWithData(data);
  // Cada dimensión con su dato o «sin dato» (P1 bloque 5d): el cliente ya no copia la
  // evaluación del entrenador a las 4 dimensiones ni pone 60 de «overall».
  const val = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "sin dato");
  const noBreakdown =
    data.vsi && [data.vsi.technical, data.vsi.tactical, data.vsi.physical].every((v) => v == null);
  const vsi = data.vsi
    ? `Técnico ${val(data.vsi.technical)} · Táctico ${val(data.vsi.tactical)} · Físico ${val(data.vsi.physical)} · Mental ${val(data.vsi.mental)} · Evaluación del entrenador (subjetiva) ${val(data.vsi.overall)}${
        noBreakdown
          ? " (⚠ sin desglose por dimensión: no hay análisis de vídeo; NO inventes niveles por dimensión)"
          : " (desglose derivado de análisis de vídeo)"
      }`
    : "No disponible";
  const phv = data.phv
    ? `Offset ${data.phv.offset.toFixed(2)} años · Categoría ${data.phv.category}`
    : "No disponible (jugador adulto u ausente)";
  const bp = data.behavioralProfile;
  const fatigue = data.recentFatigue;
  const wb = data.wellbeing;
  const team = data.teamContext;
  const prev = data.previousPlanSummary;

  return `Eres un metodólogo de fútbol formativo con experiencia en LTAD (Long-Term Athlete Development) y planes de desarrollo individuales. Tu misión: diseñar un Plan de Desarrollo Individual (IDP) MENSUAL para un jugador, equilibrando 5 dimensiones (técnica, táctica, física, mental, maduración).

## DATOS DEL JUGADOR
- Nombre: ${p.name}
- Edad cronológica: ${p.chronologicalAge != null ? `${p.chronologicalAge} años` : "No disponible"}
- Posición: ${p.position ?? "No disponible"}${p.foot ? ` · Pie dominante: ${p.foot}` : ""}

## NIVEL POR DIMENSIÓN (0-100; técnica/táctica/física/mental del análisis de vídeo, evaluación del entrenador aparte)
${vsi}

## PHV (Peak Height Velocity)
${phv}

## PERFIL CONDUCTUAL (BPE, si disponible)
${
  bp
    ? `- Velocidad decisión: ${bp.decisionSpeed ?? "N/A"}
- Scanning: ${bp.scanning ?? "N/A"}
- Resiliencia: ${bp.resilience ?? "N/A"}
- Liderazgo: ${bp.leadership ?? "N/A"}
- Composite mental: ${bp.mentalComposite ?? "N/A"}
- Arquetipo: ${bp.archetype ?? "N/A"}`
    : "No disponible"
}

## FATIGA Y RIESGO RECIENTES
${
  fatigue
    ? `- ACWR: ${fatigue.acwr ?? "N/A"}
- Índice fatiga: ${fatigue.fatigueIndex ?? "N/A"}
- Riesgo lesión: ${fatigue.injuryRisk ?? "N/A"}%`
    : "Sin datos recientes"
}

## BIENESTAR
${
  wb
    ? `- Tendencia engagement: ${wb.engagementTrend ?? "N/A"}
- Riesgo dropout: ${wb.dropoutRisk ?? "N/A"}%`
    : "Sin datos"
}

## CONTEXTO DEL EQUIPO
${
  team
    ? `- Nivel del equipo: ${team.teamLevel ?? "N/A"}
- VSI promedio equipo: ${team.avgVsi ?? "N/A"}
- Partidos próximo mes: ${team.upcomingFixtures ?? "N/A"}`
    : "No proporcionado — asumir equipo de nivel medio"
}

## PLAN DEL MES ANTERIOR (continuidad)
${
  prev
    ? `- Dimensiones logradas: ${prev.achievedDimensions.join(", ") || "ninguna"}
- Dimensiones falladas: ${prev.missedDimensions.join(", ") || "ninguna"}
- Notas del coach: ${prev.coachNotes ?? "Ninguna"}`
    : "Primer plan del jugador"
}

## INSTRUCCIONES METODOLÓGICAS

0. **DIMENSIONES CON DATO: ${withData.join(", ")}.** Crea metas SOLO de estas dimensiones. NUNCA una meta de una dimensión «sin dato» ni una baseline que no esté arriba.
1. **Prioriza por debilidad relativa**: entre las dimensiones con dato, identifica dónde el jugador puede crecer más con trabajo focalizado este mes.
2. **Ajusta por edad y PHV**: si el jugador está en pico de crecimiento (PHV offset cercano a 0), prioriza maduración (control de carga) sobre físico de alta intensidad.
3. **Considera el contexto del equipo**: un crack en equipo flojo tiene metas distintas a un crack en equipo top. Equipo débil → fundamentos. Equipo elite → matices y composite mental.
4. **Continúa el trabajo previo**: si una dimensión falló el mes pasado, considéralo (puede que necesite otro mes O cambiar de drill).
5. **Objetivos medibles**: la baseline de cada goal es EXACTAMENTE el valor de su dimensión mostrado arriba; el target, REALISTA para 30 días (incrementos 3-5% típicos para baselines >60, hasta 8% para <50).
6. **Entre 1 y 5 goals** (como mucho uno por dimensión con dato): no abrumes y no rellenes; si solo hay datos de una dimensión, un solo goal.
7. **Maturation solo si hay PHV**. Si no, omite esa dimensión.
8. **Drills**: NO los listes en el output — el sistema los matcheará automáticamente desde \`DRILLS_LIBRARY\`. Tú solo nombras título y rationale del goal.
9. **Si el VSI viene "plano" (sin breakdown de video)**: NO afirmes en \`rationale\` que tienes datos por dimensión que no tienes. Habla en términos generales y motiva al coach a subir un video. Ejemplo: en vez de "según las métricas técnicas observadas", di "con datos básicos disponibles". Honestidad sobre las limitaciones del dataset.
10. **Si hay datos de fatiga/ACWR**: úsalos para justificar la dimensión maduración o para advertir sobre carga en dimensión física.
11. **Si hay perfil conductual (BPE)**: úsalo activamente para la dimensión mental — referencia decisionSpeed, scanning, resilience o leadership por nombre.

## FORMATO DE RESPUESTA (JSON estricto)

\`\`\`json
{
  "overallFocus": "1 frase: foco general del mes (max 200 chars)",
  "agentSummary": "Resumen ejecutivo del plan en 2-3 oraciones para el coach",
  "goals": [
    {
      "dimension": "technical" | "tactical" | "physical" | "mental" | "maturation",
      "title": "Título corto y accionable (5-120 chars)",
      "description": "Explicación pedagógica de qué se va a trabajar (≥10 chars)",
      "rationale": "POR QUÉ esta meta este mes para este jugador (datos concretos, ≥10 chars)",
      "baselineMetric": {
        "metric": "vsi_technical" | "vsi_tactical" | "vsi_physical" | "vsi_mental" | "mental_composite" | "injury_risk" | "scanning" | "decision_speed",
        "value": 65,
        "label": "VSI Técnico",
        "unit": "score"
      },
      "targetMetric": {
        "metric": "<mismo metric que baseline>",
        "value": 70,
        "label": "VSI Técnico",
        "unit": "score"
      },
      "suggestedDrills": [],
      "weight": 5
    }
  ]
}
\`\`\`

**Importante**: \`suggestedDrills\` SIEMPRE vacío array. El sistema lo rellena. \`weight\` 1-5 donde 5 = prioridad máxima. Mínimo 3 goals, máximo 5.

Responde ÚNICAMENTE con el JSON, sin texto adicional ni markdown wrapper.

${languageDirective(locale)}
`;
}
