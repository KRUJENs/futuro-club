/**
 * VITAS · useIDPArchitectInput
 *
 * Construye el `IDPArchitectInput` requerido por el agente IDP a partir de
 * TODAS las fuentes de datos del jugador:
 *
 *   - PlayerService          → identidad, edad, posición, VSI overall, PHV
 *   - BehavioralProfile      → 7 dimensiones mentales + arquetipo (de video)
 *   - SavedAnalyses (video)  → dimensiones técnico/táctico/físico observadas
 *                              en partido (escala 0-10 → 0-100), reemplazan
 *                              el VSI overall plano con breakdown real
 *   - InjuryRisk             → ACWR + fatigueIndex + overallRisk
 *
 * Cuanto más rico el dataset, más preciso el plan que propone Claude.
 * El agente maneja gracefully campos faltantes (fallback determinista).
 *
 * Compartido entre IDPPage (/idp/:playerId) y el tab "Plan" del PlayerHubPage.
 *
 * Devuelve también:
 *   - `liveMetrics`         → dict para `computeSummary` (progress en vivo)
 *   - `dataRichness`        → meta para el badge UI "basado en N análisis"
 */
import { useMemo } from "react";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";
import { usePlayerById } from "@/hooks/usePlayers";
import { useBehavioralProfile } from "@/hooks/useBehavioralProfile";
import { useSavedAnalysesV2 } from "@/hooks/usePlayerAnalysisV2";
import { useInjuryRisk } from "@/hooks/useInjuryRisk";
import { injuryRiskValue } from "@/lib/injury/injuryRiskTypes";
import type { IDPArchitectInput } from "@/lib/idp/idpTypes";

export interface IDPDataRichness {
  /** True si tenemos al menos 1 análisis de video. */
  hasVideoAnalysis: boolean;
  /** Nº de análisis de video disponibles. */
  videoAnalysisCount: number;
  /** True si hay perfil conductual (requiere video). */
  hasBehavioralProfile: boolean;
  /** True si hay datos antropométricos para PHV. */
  hasPHV: boolean;
  /** True si hay datos de fatiga/lesión. */
  hasFatigueData: boolean;
  /** 0-100 — qué tan rico es el dataset que alimenta al agente. */
  richnessScore: number;
}

export interface IDPInputBundle {
  architectInput: IDPArchitectInput | null;
  liveMetrics: Record<string, number>;
  playerName: string | undefined;
  loading: boolean;
  dataRichness: IDPDataRichness;
}

/**
 * Convierte un score 0-10 (escala del agente video-intelligence)
 * a 0-100 (escala VSI / IDP).
 */
function scale10to100(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v * 10)));
}

/**
 * Extrae VSI breakdown del último análisis de video disponible.
 * Mapeo: dimensiones del agente (0-10) → buckets VSI (0-100).
 */
function extractVSIFromAnalyses(analyses: unknown[] | undefined): {
  technical?: number;
  tactical?: number;
  physical?: number;
  mental?: number;
} | null {
  if (!analyses || analyses.length === 0) return null;
  const latest = analyses[0] as { report?: { estadoActual?: { dimensiones?: Record<string, { score?: number }>; dimensionesMedidas?: boolean } } };
  const dim = latest?.report?.estadoActual?.dimensiones;
  if (!dim) return null;
  // Los scores por dimensión son una CONSTANTE fabricada (el pipeline no los mide). NO
  // alimentar el breakdown técnico/táctico/físico/mental del IDP con números inventados
  // (inv #2): sin medición real, este signal se omite y el IDP usa el resto de entradas.
  if (latest?.report?.estadoActual?.dimensionesMedidas !== true) return null;

  return {
    technical: scale10to100(dim.tecnicaConBalon?.score),
    tactical: scale10to100(dim.inteligenciaTactica?.score),
    physical: scale10to100(dim.capacidadFisica?.score),
    // Mental como mejor signal disponible (BPE > eficaciaCompetitiva > liderazgo)
    mental: scale10to100(
      dim.eficaciaCompetitiva?.score ?? dim.liderazgoPresencia?.score,
    ),
  };
}

export function useIDPArchitectInput(playerId: string | undefined): IDPInputBundle {
  const { data: player, isLoading: loadingPlayer } = usePlayerById(playerId);
  const { data: behavioralProfileRaw } = useBehavioralProfile(playerId);
  // Un perfil de EJEMPLO (source "mock", solo en el demo) no alimenta el IDP ni cuenta
  // como señal: antes entraba como real y la riqueza de datos lo marcaba en verde
  // (P1 bloque 2, inv #4).
  const behavioralProfile = behavioralProfileRaw && behavioralProfileRaw.source !== "mock" ? behavioralProfileRaw : undefined;
  const { data: savedAnalyses } = useSavedAnalysesV2(playerId ?? "");
  const { riskData: injuryRisk, injuries } = useInjuryRisk(playerId);
  const hasInjuries = Array.isArray(injuries) && injuries.length > 0;
  // Idioma de salida del plan = idioma actual de la UI. Se lee en render (no
  // dentro del memo) para que un cambio de idioma recomponga el input.
  const locale = normalizeLocale(i18n.language);

  // ── Data richness signal ──
  const dataRichness: IDPDataRichness = useMemo(() => {
    const p = player as unknown as Record<string, unknown> | undefined;
    const videoAnalysisCount = Array.isArray(savedAnalyses) ? savedAnalyses.length : 0;
    const hasVideoAnalysis = videoAnalysisCount > 0;
    // Un perfil sin objeto `scores` NO es un perfil usable (no cuenta como señal).
    const hasBehavioralProfile = Boolean(behavioralProfile?.scores);
    const hasPHV =
      typeof p?.phvOffset === "number" && typeof p?.phvCategory === "string";
    // P1 bloque 4b: cuenta solo un riesgo CALCULADO (antes bastaba la respuesta).
    const hasFatigueData = injuryRiskValue(injuryRisk) !== null || hasInjuries;

    // Weighted richness: video analyses + BPE matter most
    const score =
      (hasVideoAnalysis ? Math.min(40, videoAnalysisCount * 10) : 0) +
      (hasBehavioralProfile ? 30 : 0) +
      (hasPHV ? 15 : 0) +
      (hasFatigueData ? 15 : 0);

    return {
      hasVideoAnalysis,
      videoAnalysisCount,
      hasBehavioralProfile,
      hasPHV,
      hasFatigueData,
      richnessScore: Math.min(100, score),
    };
  }, [player, behavioralProfile, savedAnalyses, injuryRisk, hasInjuries]);

  // ── Architect input ──
  const architectInput: IDPArchitectInput | null = useMemo(() => {
    if (!player) return null;
    const p = player as unknown as Record<string, unknown>;
    const ageYears = typeof p.age === "number" ? p.age : 14;
    const overallVsi = typeof p.vsi === "number" ? p.vsi : 0;
    const phvOffset = typeof p.phvOffset === "number" ? p.phvOffset : null;
    const phvCategory = typeof p.phvCategory === "string" ? p.phvCategory : null;

    // VSI breakdown: priorizamos lo más reciente del análisis de video
    // (escala 0-10 → 0-100). Si no hay video, fallback al overall plano.
    const videoVSI = extractVSIFromAnalyses(savedAnalyses);
    // `?.scores?.` — el perfil puede llegar truthy pero sin `scores` (respuesta
    // parcial de la API); leer `.mentalComposite` sobre undefined crasheaba el
    // módulo IDP entero (error boundary "Algo salió mal").
    const bpeMental = behavioralProfile?.scores?.mentalComposite;

    const vsi = overallVsi > 0 || videoVSI
      ? {
          overall: overallVsi || 60,
          technical: videoVSI?.technical ?? overallVsi,
          tactical: videoVSI?.tactical ?? overallVsi,
          physical: videoVSI?.physical ?? overallVsi,
          mental: bpeMental ?? videoVSI?.mental ?? overallVsi,
        }
      : undefined;

    // P1 bloque 4b: solo el riesgo de lesión CALCULADO (compuesto real). Antes se
    // leían acwrValue / fatigueIndex / overallRisk, campos que el informe no tiene
    // (siempre undefined) o que traían un número por defecto.
    const riskValue = injuryRiskValue(injuryRisk);
    const recentFatigue = riskValue !== null ? { injuryRisk: riskValue } : undefined;

    return {
      player: {
        id: String(p.id ?? playerId ?? ""),
        name: String(p.name ?? "Jugador"),
        position: String(p.position ?? p.positionShort ?? "MID"),
        chronologicalAge: ageYears,
        foot: typeof p.foot === "string" ? p.foot : undefined,
      },
      vsi,
      phv:
        phvOffset !== null && phvCategory
          ? { offset: phvOffset, category: phvCategory }
          : null,
      behavioralProfile: behavioralProfile?.scores
        ? {
            decisionSpeed: behavioralProfile.scores.decisionSpeed,
            scanning: behavioralProfile.scores.scanningIntelligence,
            resilience: behavioralProfile.scores.resilience,
            leadership: behavioralProfile.scores.leadership,
            mentalComposite: behavioralProfile.scores.mentalComposite,
            archetype: behavioralProfile.scores.archetype,
          }
        : undefined,
      recentFatigue,
      locale,
      // teamContext + wellbeing + previousPlanSummary wired in future iteration
    };
  }, [player, behavioralProfile, savedAnalyses, injuryRisk, playerId, locale]);

  // ── Live metrics dict ──
  const liveMetrics: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    const p = player as unknown as Record<string, unknown> | undefined;

    // Start with player record overall VSI
    if (typeof p?.vsi === "number") {
      out.vsi_overall = p.vsi;
    }

    // Override with video-derived breakdown if available
    const videoVSI = extractVSIFromAnalyses(savedAnalyses);
    if (videoVSI) {
      if (videoVSI.technical != null) out.vsi_technical = videoVSI.technical;
      if (videoVSI.tactical != null) out.vsi_tactical = videoVSI.tactical;
      if (videoVSI.physical != null) out.vsi_physical = videoVSI.physical;
      if (videoVSI.mental != null) out.vsi_mental = videoVSI.mental;
    } else if (typeof p?.vsi === "number") {
      // Fallback: flatten overall across dimensions
      out.vsi_technical = p.vsi;
      out.vsi_tactical = p.vsi;
      out.vsi_physical = p.vsi;
      out.vsi_mental = p.vsi;
    }

    // Behavioral profile metrics (highest signal for mental dimension)
    if (behavioralProfile?.scores) {
      out.mental_composite = behavioralProfile.scores.mentalComposite;
      out.scanning = behavioralProfile.scores.scanningIntelligence;
      out.decision_speed = behavioralProfile.scores.decisionSpeed;
    }

    // Injury risk for maturation dimension: solo el compuesto calculado (P1 bloque 4b).
    const risk2 = injuryRiskValue(injuryRisk);
    if (risk2 !== null) {
      out.injury_risk = risk2;
    }

    return out;
  }, [player, behavioralProfile, savedAnalyses, injuryRisk]);

  return {
    architectInput,
    liveMetrics,
    playerName: player?.name,
    loading: loadingPlayer,
    dataRichness,
  };
}
