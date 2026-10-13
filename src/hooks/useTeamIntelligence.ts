/**
 * VITAS · useTeamIntelligence hook
 * Orquesta el análisis táctico de equipo:
 *  1. Envía video a Gemini (team-observation) para observación colectiva
 *  2. Llama a Claude (team-intelligence) via SSE streaming
 *  3. Devuelve TeamIntelligenceOutput — SOLO nivel de equipo (identidad.md):
 *     sin dorsal ni filas por jugador. Antes se emparejaba la pista YOLO i con
 *     el "jugador" i del LLM para su mapa de calor (atribución inventada).
 */

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TeamIntelligenceOutput } from "@/agents/contracts";
import { isLocalSrc, readVideoAsBase64, extractKeyframesFromVideo, getOptimalFrameCount } from "@/lib/localVideoUtils";
import { withholdIndividualData } from "@/lib/shared/teamReportIdentity";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { getAuthHeaders } from "@/lib/apiAuth";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";
import { aggregatePhvDistribution } from "@/lib/shared/phv";
import { NO_VISUAL_INPUT, hasGeminiObservations, hasVisualInput } from "@/lib/shared/teamVisualInput";
import { PlayerService } from "@/services/real/playerService";
import {
  ClipConsentBlockedError,
  clipConsentErrorFromResponse,
  type ClipAttestation,
} from "@/lib/shared/videoConsent";

// ——— Tipos ——————————————————————————————————————————————————————

export interface TeamIntelligenceState {
  /** "blocked" = gate: no visual input, so NO report is generated (not an error). */
  step:     "idle" | "keyframes" | "analyzing" | "done" | "error" | "blocked";
  progress: number;
  message:  string;
  /** Why the analysis was blocked (step "blocked"); absent otherwise. */
  gateReason?: string | null;
}

/**
 * The team analysis was refused because the model would not see the match
 * (no Gemini observation and no usable frames). Raised by the client gate or
 * mapped from the server's SSE error with code NO_VISUAL_INPUT.
 */
export class TeamAnalysisGateError extends Error {
  readonly code = NO_VISUAL_INPUT;
  constructor(message: string) {
    super(message);
    this.name = "TeamAnalysisGateError";
  }
}

// ——— Helper: leer SSE stream ————————————————————————————————————

async function readSSEStream(
  url: string,
  body: object,
  onProgress: (msg: string) => void
): Promise<TeamIntelligenceOutput> {
  const response = await fetch(url, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => `HTTP ${response.status}`);
    let errMsg = `HTTP ${response.status}`;
    let errJson: unknown = null;
    try { errJson = JSON.parse(errText); errMsg = (errJson as { error?: string }).error ?? errMsg; } catch { /* ok */ }
    // Consentimiento (gate antes del stream): motivo traducido, no un error genérico.
    const consentErr = clipConsentErrorFromResponse(errJson, i18n.language);
    if (consentErr) throw consentErr;
    throw new Error(errMsg);
  }

  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const eventMatch = chunk.match(/^event:\s*(.+)$/m);
        const dataMatch  = chunk.match(/^data:\s*(.+)$/m);
        const eventType = eventMatch?.[1]?.trim();
        const jsonStr   = dataMatch?.[1]?.trim();
        if (!jsonStr) continue;

        let data: Record<string, unknown>;
        try { data = JSON.parse(jsonStr) as Record<string, unknown>; }
        catch { continue; }

        if (eventType === "progress") {
          onProgress((data.step as string) ?? "Analizando...");
        } else if (eventType === "complete") {
          const report = data.report as TeamIntelligenceOutput | undefined;
          if (report) return report;
        } else if (eventType === "error") {
          const message = (data.message as string) ?? "Error en el análisis";
          if (data.code === NO_VISUAL_INPUT) throw new TeamAnalysisGateError(message);
          throw new Error(message);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("El stream terminó sin resultado");
}

// ——— Hook principal ——————————————————————————————————————————————

export function useTeamIntelligence() {
  const [state, setState] = useState<TeamIntelligenceState>({
    step: "idle", progress: 0, message: "",
  });

  const [result, setResult] = useState<TeamIntelligenceOutput | null>(null);

  /**
   * Runs the team analysis. Resolves with the report, or with `null` when the
   * analysis was BLOCKED for lack of visual input (state.step === "blocked",
   * state.gateReason set) — in that case no report is generated or saved.
   */
  const runAnalysis = useCallback(async (opts: {
    videoId:          string;
    videoDuration?:   number;
    teamColor:        string;
    opponentColor?:   string;
    competitiveLevel?: string;
    localVideoSrc?:   string;
    analysisFocus?:   string[];
    /**
     * Declaración del entrenador que marcó el usuario (decisión del owner, 30 sep). Viaja
     * en team-observation y team-intelligence, que la exigen y la guardan. Vídeo de equipo:
     * la comprobación por jugador no aplica.
     */
    attestation?:     ClipAttestation | null;
  }): Promise<TeamIntelligenceOutput | null> => {
    const { videoId, videoDuration, teamColor, opponentColor, competitiveLevel, localVideoSrc, analysisFocus, attestation } = opts;
    const hasLocalVideo = !!localVideoSrc && isLocalSrc(localVideoSrc);
    setState({ step: "analyzing", progress: 10, message: "Preparando video para análisis de equipo..." });

    try {
      let geminiObservations: Record<string, unknown> | null = null;
      let keyframes: Array<{ url: string; timestamp: number; frameIndex: number }> = [];

      // 1. Intentar Gemini con video completo
      if (localVideoSrc && hasLocalVideo) {
        setState({ step: "analyzing", progress: 15, message: "Preparando video..." });
        try {
          const videoData = await readVideoAsBase64(localVideoSrc);
          if (videoData) {
            setState({ step: "analyzing", progress: 22, message: "Analizando equipo con Gemini..." });
            const geminiRes = await fetch("/api/agents/team-observation", {
              method: "POST",
              headers: await getAuthHeaders(),
              body: JSON.stringify({
                locale: normalizeLocale(i18n.language),
                videoBase64: videoData.base64,
                mediaType: videoData.mediaType,
                videoId,
                ...(attestation ? { attestation } : {}),
                teamContext: {
                  teamColor,
                  opponentColor,
                  competitiveLevel: competitiveLevel || "formativo",
                },
              }),
            });

            if (!geminiRes.ok) {
              // Un bloqueo de consentimiento NO cae al modo fotogramas: se para aquí.
              const errJson = await geminiRes.json().catch(() => null);
              const consentErr = clipConsentErrorFromResponse(errJson, i18n.language);
              if (consentErr) throw consentErr;
            }

            if (geminiRes.ok) {
              // Contrato successResponse (api/_lib/apiResponse.ts): { ok, success, data: { observations } }.
              // Leer `observations` en la raíz descartaba SIEMPRE la observación de Gemini.
              const geminiData = await geminiRes.json() as { data?: { observations?: unknown } };
              const observations = geminiData.data?.observations;
              if (hasGeminiObservations(observations)) {
                geminiObservations = observations as Record<string, unknown>;
                console.log("[Team Intelligence] Gemini observaciones recibidas");
              }
            } else {
              console.warn("[Team Intelligence] Gemini no disponible, usando fallback frames");
            }
          }
        } catch (geminiErr) {
          if (geminiErr instanceof ClipConsentBlockedError) throw geminiErr;
          console.warn("[Team Intelligence] Error con Gemini:", geminiErr);
        }

        // Fallback: extraer frames si Gemini falló
        if (!geminiObservations) {
          setState({ step: "keyframes", progress: 20, message: "Extrayendo fotogramas..." });
          const frameCount = getOptimalFrameCount(videoDuration || 120);
          keyframes = await extractKeyframesFromVideo(localVideoSrc, videoDuration || 120, frameCount);
          if (keyframes.length === 0) throw new Error(i18n.t("errors.frameExtractError"));

          const payloadEstimate = JSON.stringify(keyframes).length;
          if (payloadEstimate > 4_000_000) {
            keyframes = keyframes.filter((_, i) => i % 2 === 0);
          }
        }
      }

      // GATE · sin entrada visual no hay informe. Un vídeo en la nube (Bunny) no
      // se puede leer desde aquí → ni Gemini ni fotogramas; antes se pedía igualmente
      // un informe "de 0 fotogramas" (inventado). Se bloquea con motivo.
      if (!hasVisualInput(geminiObservations, keyframes.length)) {
        throw new TeamAnalysisGateError("Sin entrada visual (ni observación de Gemini ni fotogramas)");
      }

      setState({ step: "analyzing", progress: 35, message: geminiObservations ? "Generando informe táctico con Claude..." : "Enviando a VITAS Intelligence..." });

      // 2. Llamar a Claude con SSE
      const rawResult = await readSSEStream(
        "/api/agents/team-intelligence",
        {
          teamContext: {
            teamColor,
            opponentColor,
            competitiveLevel,
            // FASE 5 activación · distribución PHV real del roster (diferenciador VITAS)
            phvDistribution: aggregatePhvDistribution(PlayerService.getAll()),
          },
          geminiObservations,
          keyframes,
          videoId,
          ...(attestation ? { attestation } : {}),
          analysisFocus: analysisFocus ?? null,
          // FASE 5 · idioma del reporte = idioma activo de la app (bilingüe ES/EN)
          locale: normalizeLocale(i18n.language),
        },
        (msg) => setState(prev => ({ ...prev, message: msg, progress: Math.min(prev.progress + 5, 85) }))
      );

      // 3. Identidad (identidad.md): nada por jugador se guarda ni se muestra,
      //    aunque un servidor anterior lo devolviera.
      const analysisResult = withholdIndividualData(rawResult).value as TeamIntelligenceOutput;

      // 4. Guardar en Supabase
      const savedAt = new Date().toISOString();
      if (SUPABASE_CONFIGURED) {
        try {
          const { OrganizationService } = await import("@/services/real/organizationService");
          const _orgId = OrganizationService.getOrgId();
          await supabase.from("team_analyses").insert({
            video_id:   videoId,
            ...(_orgId ? { org_id: _orgId } : {}),
            report:     analysisResult,
            created_at: savedAt,
          });
        } catch (saveErr) {
          console.warn("[Team Intelligence] No se pudo guardar en Supabase:", saveErr);
        }
      }

      setResult(analysisResult);
      setState({ step: "done", progress: 100, message: "Análisis de equipo completado" });
      return analysisResult;

    } catch (err) {
      if (err instanceof TeamAnalysisGateError) {
        // Abstención válida (no es un fallo): se muestra el motivo, no un informe.
        // Mismo código en cliente y servidor → motivo en el idioma activo.
        const gateReason = hasLocalVideo
          ? i18n.t("teamAnalysisPage.noVisualInputReason")
          : i18n.t("teamAnalysisPage.noVisualInputCloud");
        setResult(null);
        setState({ step: "blocked", progress: 0, message: gateReason, gateReason });
        return null;
      }
      const msg = err instanceof Error ? err.message : "Error desconocido";
      setState({ step: "error", progress: 0, message: msg });
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setState({ step: "idle", progress: 0, message: "", gateReason: null });
    setResult(null);
  }, []);

  const isAnalyzing = state.step === "keyframes" || state.step === "analyzing";

  return {
    state,
    isLoading: isAnalyzing,
    isAnalyzing,
    analysisResult: result,
    runAnalysis,
    reset,
  };
}

// ——— Hook para cargar análisis de equipo guardados ——————————————

/**
 * Identidad (identidad.md): las filas de `team_analyses` guardadas antes de la
 * guarda aún llevan `jugadores[]` (dorsal adivinado por el LLM + cifras por
 * jugador). Se retiran en la LECTURA, para cualquier consumidor de estos hooks;
 * la página vuelve a aplicar la misma guarda (idempotente).
 */
export function teamLevelRows<T>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).map((row) => {
    const report = (row as { report?: unknown } | null)?.report;
    if (!report || typeof report !== "object") return row;
    return { ...row, report: withholdIndividualData(report).value };
  });
}

export function useSavedTeamAnalyses(videoId: string) {
  return useQuery({
    queryKey: ["team-analyses", videoId],
    queryFn:  async () => {
      if (!SUPABASE_CONFIGURED) return [];
      const { data, error } = await supabase
        .from("team_analyses")
        .select("*")
        .eq("video_id", videoId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return teamLevelRows(data);
    },
    enabled:   !!videoId && SUPABASE_CONFIGURED,
    staleTime: 1000 * 60 * 5,
  });
}

/** Trae TODOS los análisis de equipo del usuario (sin filtrar por video) */
export function useAllTeamAnalyses() {
  return useQuery({
    queryKey: ["team-analyses-all"],
    queryFn:  async () => {
      if (!SUPABASE_CONFIGURED) return [];
      const { data, error } = await supabase
        .from("team_analyses")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return teamLevelRows(data);
    },
    enabled: SUPABASE_CONFIGURED,
    staleTime: 1000 * 60 * 5,
  });
}
