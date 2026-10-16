/**
 * VITAS · Observación Gemini → biomechanics (ÚNICA implementación · invariante #7)
 *
 * Antes existían DOS copias de esta conversión (api/pipeline/_gemini-analyze.ts y
 * api/crons/process-analyses-queue.ts) y ambas tapaban los huecos con valores por
 * defecto (invariantes 1-2 de CLAUDE.md):
 *   - `score_estimado ?? 5`      → un «5/10» que Gemini nunca emitió
 *   - `eventosContados.x ?? 0`   → un «0 pases» que en realidad era «no se contó»
 *   - contexto `edad ?? 12`, `posición ?? "MID"`, `pie ?? "derecho"` → datos
 *     inventados del menor que además calibraban el prompt.
 * Ahora: dato ausente ⇒ `null` + `gate_reasons[campo]`, nunca un relleno.
 *
 * Capa de identidad (.claude/rules/identidad.md): la observación de Gemini solo se
 * atribuye al jugador si se le identificó por DORSAL + COLOR de equipación (o si es
 * el único jugador del vídeo, con advertencia). Nunca por la cara. Si no se pudo
 * identificar, las cifras NO se atribuyen al menor: se devuelven vacías/null y el
 * caller se abstiene (no genera un informe bajo su nombre).
 *
 * Procedencia: todo lo que sale de aquí es ESTIMADA_LLM (un modelo de visión
 * generativo mirando el clip), nunca MEDIDA.
 */

import { GEMINI_MODEL } from "../../src/lib/shared/geminiModel";

// ─── Tipos de la observación (contrato del prompt de api/agents/video-observation.ts) ──

export type IdentityStatus = "identificado" | "unico_jugador" | "no_identificado";
export type IdentityConfidence = "alta" | "media" | "baja";
export type IdentityMethod = "dorsal_y_color" | "unico_jugador_en_plano";

export interface GeminiIdentification {
  estado?: string | null;
  metodo?: string | null;
  dorsalObservado?: string | number | null;
  colorObservado?: string | null;
  confianza?: string | null;
  motivo?: string | null;
}

export interface GeminiObservation {
  timeline?: Array<{ timestamp: string; tipo: string; descripcion: string }>;
  dimensiones?: Record<string, { observaciones?: string[]; score_estimado?: number | null }>;
  momentosDestacados?: Array<{ timestamp: string; tipo: string; descripcion: string }>;
  patronesJuego?: string[];
  resumenGeneral?: string;
  eventosContados?: Record<string, number | null>;
  identificacion?: GeminiIdentification | null;
}

// ─── Campos persistidos en analyses.biomechanics ────────────────────────────

/** biomechanics.<campo> ← dimensiones.<dimensión>.score_estimado */
export const GEMINI_SCORE_FIELDS = {
  technical_score: "tecnicaConBalon",
  tactical_score: "inteligenciaTactica",
  physical_score: "capacidadFisica",
  decision_score: "velocidadDecision",
  leadership_score: "liderazgoPresencia",
  efficacy_score: "eficaciaCompetitiva",
} as const;

/** biomechanics.<campo> ← eventosContados.<evento> */
export const GEMINI_EVENT_FIELDS = {
  passes_completed: "pasesCompletados",
  passes_failed: "pasesFallados",
  progressive_passes: "pasesProgresivos",
  dribbles_successful: "regatesConVentaja",
  dribbles_failed: "regatesSinVentaja",
  pressing_effective: "pressingEfectivo",
  recoveries: "recuperaciones",
  tackles: "robos",
  interceptions: "anticipaciones",
  turnovers: "perdidas",
  // Sin duels_won/duels_lost (P1 bloque 6): sin criterio validado de duelo
  // (src/lib/tracking/duels.ts); el modelo ya no los cuenta.
  shots_on_target: "disparosAlArco",
  shots_off_target: "disparosFuera",
  scans: "escaneos",
} as const;

// Escala que pide el prompt de video-observation ("Scores: 1-10"). Un valor fuera
// de ella no es un score válido → null, no se recorta.
const SCORE_MIN = 1;
const SCORE_MAX = 10;

type ScoreKey = keyof typeof GEMINI_SCORE_FIELDS;
type EventKey = keyof typeof GEMINI_EVENT_FIELDS;
export type GeminiMetricKey = ScoreKey | EventKey;

export interface PlayerIdentity {
  status: IdentityStatus;
  confidence: IdentityConfidence | null;
  method: IdentityMethod | null;
  /** ¿Se pueden atribuir las observaciones al jugador? false ⇒ abstención. */
  attributable: boolean;
  /** true solo si se identificó por dorsal + color contra una referencia registrada. */
  verifiedByDorsal: boolean;
  /** Motivo de la abstención, o advertencia si se atribuye sin verificación por dorsal. */
  reason: string | null;
}

export type GeminiBiomechanics = Record<GeminiMetricKey, number | null> & {
  /** Motivo por campo cuando su valor es null (obligatorio: inv. #2). */
  gate_reasons: Partial<Record<GeminiMetricKey, string>>;
  identity: PlayerIdentity;
  /** true ⇒ no se atribuye nada al jugador (no identificado). */
  abstained: boolean;
  provenance: "ESTIMADA_LLM";
  gemini_observation: GeminiObservation;
  source: string;
  /** Huecos del contexto del jugador enviado a Gemini (edad, posición…), si los hubo. */
  context_gate_reasons?: Record<string, string>;
};

// ─── Identidad ──────────────────────────────────────────────────────────────

function norm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s.length > 0 ? s : null;
}

function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * Decide si la observación se puede atribuir al jugador (identidad.md).
 * `referenceProvided` = se envió a Gemini un dorsal Y un color de equipación de
 * referencia. Sin referencia, Gemini NO puede afirmar «identificado»: si lo hace,
 * habría identificado por otros rasgos (cara/físico) → se descarta.
 */
export function resolvePlayerIdentity(
  obs: GeminiObservation | null | undefined,
  opts: { referenceProvided: boolean },
): PlayerIdentity {
  const raw = obs?.identificacion ?? null;
  const estado = norm(raw?.estado);
  const confianza = norm(raw?.confianza) as IdentityConfidence | null;
  const motivo = cleanText(raw?.motivo);

  const abstain = (reason: string): PlayerIdentity => ({
    status: "no_identificado",
    confidence: confianza === "alta" || confianza === "media" || confianza === "baja" ? confianza : null,
    method: null,
    attributable: false,
    verifiedByDorsal: false,
    reason,
  });

  if (!raw || (estado !== "identificado" && estado !== "unico_jugador" && estado !== "no_identificado")) {
    return abstain(
      "Gemini no informó de cómo identificó al jugador en el vídeo → no se le atribuye ninguna observación (identidad por dorsal y equipación, nunca por la cara).",
    );
  }
  if (estado === "no_identificado") {
    return abstain(
      `Jugador no identificado en el vídeo${motivo ? `: ${motivo}` : ""}. No se le atribuye ninguna observación.`,
    );
  }
  if (confianza !== "alta" && confianza !== "media") {
    return abstain(
      "Identificación del jugador con confianza baja o no informada → abstención (no se atribuyen observaciones al jugador).",
    );
  }
  if (estado === "identificado") {
    if (!opts.referenceProvided) {
      return abstain(
        "Gemini afirmó identificar al jugador sin dorsal ni color de equipación de referencia → descartado (la identidad solo se establece por dorsal y equipación, nunca por la cara ni rasgos físicos).",
      );
    }
    return {
      status: "identificado",
      confidence: confianza,
      method: "dorsal_y_color",
      attributable: true,
      verifiedByDorsal: true,
      reason:
        confianza === "media"
          ? "Jugador identificado por dorsal y equipación con confianza media: atribución no plenamente verificada."
          : null,
    };
  }
  // estado === "unico_jugador": atribución por exclusión (un solo jugador en plano).
  return {
    status: "unico_jugador",
    confidence: confianza,
    method: "unico_jugador_en_plano",
    attributable: true,
    verifiedByDorsal: false,
    reason:
      "Identidad no verificada por dorsal: solo aparece un jugador en el vídeo y se le atribuye por exclusión.",
  };
}

// ─── Conversión ─────────────────────────────────────────────────────────────

function toScore(v: unknown): { value: number | null; reason: string | null } {
  if (v === null || v === undefined) return { value: null, reason: "Gemini no emitió score para esta dimensión" };
  if (typeof v !== "number" || !Number.isFinite(v)) return { value: null, reason: "score no numérico en la respuesta de Gemini" };
  if (v < SCORE_MIN || v > SCORE_MAX) return { value: null, reason: `score fuera de la escala ${SCORE_MIN}-${SCORE_MAX}` };
  return { value: v, reason: null };
}

function toCount(v: unknown): { value: number | null; reason: string | null } {
  if (v === null || v === undefined) return { value: null, reason: "Gemini no contó este evento" };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    return { value: null, reason: "conteo no válido en la respuesta de Gemini" };
  }
  return { value: v, reason: null };
}

/** Observación sin nada atribuible al jugador (abstención): conserva solo la identificación. */
function withoutPlayerContent(obs: GeminiObservation, reason: string): GeminiObservation {
  const dims: GeminiObservation["dimensiones"] = {};
  for (const k of Object.keys(obs.dimensiones ?? {})) dims[k] = { observaciones: [], score_estimado: null };
  const events: Record<string, number | null> = {};
  for (const k of Object.keys(obs.eventosContados ?? {})) events[k] = null;
  return {
    identificacion: obs.identificacion ?? null,
    timeline: [],
    momentosDestacados: [],
    patronesJuego: [],
    dimensiones: dims,
    eventosContados: events,
    resumenGeneral: reason,
  };
}

/**
 * Convierte la observación de Gemini al objeto que se persiste en
 * `analyses.biomechanics` (lo leen el orchestrator y los agentes de informe).
 */
export function geminiToBiomechanics(
  obs: GeminiObservation,
  opts: { referenceProvided: boolean; contextGateReasons?: Record<string, string> },
): { biomechanics: GeminiBiomechanics; identity: PlayerIdentity } {
  const identity = resolvePlayerIdentity(obs, opts);
  const gate_reasons: Partial<Record<GeminiMetricKey, string>> = {};
  const values = {} as Record<GeminiMetricKey, number | null>;
  const dims = obs.dimensiones ?? {};
  const events = obs.eventosContados ?? {};

  for (const [field, dim] of Object.entries(GEMINI_SCORE_FIELDS) as Array<[ScoreKey, string]>) {
    if (!identity.attributable) {
      values[field] = null;
      gate_reasons[field] = identity.reason ?? "jugador no identificado";
      continue;
    }
    const { value, reason } = toScore(dims[dim]?.score_estimado);
    values[field] = value;
    if (reason) gate_reasons[field] = `${reason} (${dim})`;
  }
  for (const [field, ev] of Object.entries(GEMINI_EVENT_FIELDS) as Array<[EventKey, string]>) {
    if (!identity.attributable) {
      values[field] = null;
      gate_reasons[field] = identity.reason ?? "jugador no identificado";
      continue;
    }
    const { value, reason } = toCount(events[ev]);
    values[field] = value;
    if (reason) gate_reasons[field] = `${reason} (${ev})`;
  }

  const biomechanics: GeminiBiomechanics = {
    ...values,
    gate_reasons,
    identity,
    abstained: !identity.attributable,
    provenance: "ESTIMADA_LLM",
    gemini_observation: identity.attributable
      ? obs
      : withoutPlayerContent(obs, identity.reason ?? "Jugador no identificado"),
    source: GEMINI_MODEL,
    ...(opts.contextGateReasons && Object.keys(opts.contextGateReasons).length > 0
      ? { context_gate_reasons: opts.contextGateReasons }
      : {}),
  };
  return { biomechanics, identity };
}

// ─── Contexto del jugador para el prompt de Gemini ──────────────────────────

export interface GeminiPlayerContext {
  name: string | null;
  age: number | null;
  position: string | null;
  foot: string | null;
  height: number | null;
  weight: number | null;
  competitiveLevel: string | null;
  jerseyNumber: string | number | null;
  teamColor: string | null;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Construye el `playerContext` que se envía a video-observation SIN rellenar huecos.
 * Cada dato ausente queda `null` con su motivo en `gate_reasons` (el prompt lo trata
 * como «no registrado»). `referenceProvided` indica si hay dorsal + color de
 * referencia para identificar al jugador.
 */
export function buildGeminiPlayerContext(
  player: { name?: string | null; position?: string | null; foot?: string | null } | null | undefined,
  anthro: { chronological_age?: unknown; height_cm?: unknown; weight_kg?: unknown } | null | undefined,
  identification: { jerseyNumber?: string | number | null; teamColor?: string | null } = {},
): { playerContext: GeminiPlayerContext; gate_reasons: Record<string, string>; referenceProvided: boolean } {
  const gate_reasons: Record<string, string> = {};
  const name = cleanText(player?.name);
  if (!name) gate_reasons.name = "jugador sin nombre registrado";
  const age = toFiniteNumber(anthro?.chronological_age);
  if (age === null) gate_reasons.age = "sin edad cronológica registrada (antropometría)";
  const position = cleanText(player?.position);
  if (!position) gate_reasons.position = "sin posición registrada";
  const foot = cleanText(player?.foot);
  if (!foot) gate_reasons.foot = "sin pie dominante registrado";
  const height = toFiniteNumber(anthro?.height_cm);
  if (height === null) gate_reasons.height = "sin estatura registrada";
  const weight = toFiniteNumber(anthro?.weight_kg);
  if (weight === null) gate_reasons.weight = "sin peso registrado";
  gate_reasons.competitiveLevel = "nivel competitivo no registrado";

  const jersey =
    typeof identification.jerseyNumber === "number" && Number.isFinite(identification.jerseyNumber)
      ? identification.jerseyNumber
      : cleanText(identification.jerseyNumber);
  const teamColor = cleanText(identification.teamColor);
  const referenceProvided = jersey !== null && teamColor !== null;
  if (!referenceProvided) {
    gate_reasons.identification = "sin dorsal y color de equipación registrados para identificar al jugador en el vídeo";
  }

  return {
    playerContext: {
      name,
      age,
      position,
      foot,
      height,
      weight,
      competitiveLevel: null,
      jerseyNumber: jersey,
      teamColor,
    },
    gate_reasons,
    referenceProvided,
  };
}
