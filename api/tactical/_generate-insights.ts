/**
 * VITAS · POST /api/tactical/generate-insights
 *
 * Genera (o regenera) los insights tácticos del agente Claude Sonnet para
 * un partido. Lee phases + heatmaps de Supabase, construye el
 * TacticalPatternInput y delega al agente. Persiste en tactical_insights.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsMatch } from "../_lib/ownership";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import {
  TacticalPatternInputSchema,
  TacticalPatternOutputSchema,
} from "../../src/agents/contracts";
import { localeSchema } from "../../src/lib/shared/locale";
import {
  buildTacticalPatternPrompt,
  TACTICAL_PROMPT_VERSION,
} from "../../src/lib/tactical/tacticalPatternPrompt";
import type {
  GamePhase,
  PhaseHeatmap,
  PhaseSegment,
} from "../../src/lib/tactical/tacticalTypes";

export const config = { runtime: "edge" };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = MODELS.reasoning;

const GenerateInsightsSchema = z.object({
  matchId: z.string(),
  team: z
    .object({
      id: z.string().optional(),
      formation: z.string().optional(),
      averageAge: z.number().optional(),
      style: z.enum(["possession", "direct", "counter", "pressing"]).optional(),
    })
    .optional(),
  matchInfo: z
    .object({
      matchDate: z.string().optional(),
      durationMin: z.number().optional(),
      score: z.object({ ours: z.number(), theirs: z.number() }).optional(),
    })
    .optional(),
  // FASE 5 · idioma del reporte + maduración biológica del equipo (opcionales)
  locale: localeSchema.optional(),
  phvDistribution: z
    .object({ prePhv: z.number().optional(), circaPhv: z.number().optional(), postPhv: z.number().optional() })
    .optional(),
});

export default withHandler(
  {
    method: "POST",
    schema: GenerateInsightsSchema,
    // Cierra el acceso anónimo (IDOR + abuso de coste LLM): sin auth, cualquiera
    // podía escribir tactical_insights y quemar tokens de pago de Claude.
    requireAuth: true,
    maxRequests: 15,
  },
  async ({ body, userId, isServiceCall }) => {
    const { matchId, team, matchInfo, locale, phvDistribution } = body as z.infer<typeof GenerateInsightsSchema>;

    // Autorización a nivel de objeto (lectura de fases + escritura de insights +
    // gasto LLM): el service_role SALTA la RLS → propiedad en código. El match es
    // una analysis creada por el usuario o de un jugador suyo (076, nunca por tenant).
    if (!isServiceCall && !(await ownsMatch(matchId, userId))) {
      return errorResponse("No autorizado para este partido", 403, "FORBIDDEN");
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return errorResponse("Supabase no configurado", 503);
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };

    // 1. Fetch phases + team heatmaps
    const [phasesRes, heatmapsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/tactical_phases?match_id=eq.${matchId}&select=*`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/phase_heatmaps?match_id=eq.${matchId}&player_id=is.null&select=*`,
        { headers },
      ),
    ]);

    const phases = (await phasesRes.json()) as Array<{
      phase_type: GamePhase;
      start_ms: number;
      end_ms: number;
      ball_possession: string;
    }>;
    const teamHeatmaps = (await heatmapsRes.json()) as Array<{
      phase_type: GamePhase;
      hot_zones: PhaseHeatmap["hotZones"];
    }>;

    if (phases.length === 0) {
      return errorResponse("No tactical data found for this match", 404);
    }

    // 2. Build input
    const phaseDurations = {
      build_up: 0, attacking: 0, defending: 0,
      defensive_transition: 0, offensive_transition: 0, set_piece: 0,
    } satisfies Record<GamePhase, number>;
    let totalMs = 0;
    let oursMs = 0;
    for (const p of phases) {
      phaseDurations[p.phase_type] += (p.end_ms - p.start_ms) / 1000;
      totalMs += p.end_ms - p.start_ms;
      if (p.ball_possession === "ours") oursMs += p.end_ms - p.start_ms;
    }
    const possessionPct = totalMs > 0 ? Math.round((oursMs / totalMs) * 100) : 0;

    const input: z.infer<typeof TacticalPatternInputSchema> = {
      match: {
        id: matchId,
        matchDate: matchInfo?.matchDate,
        durationMin: matchInfo?.durationMin,
        score: matchInfo?.score,
      },
      team: team ?? {},
      phaseDurations,
      possessionPct,
      locale,
      phvDistribution,
      teamHotZonesByPhase: teamHeatmaps.map((h) => ({
        phase: h.phase_type,
        zones: h.hot_zones,
      })),
    };

    // 3. Call agent inline
    let insights: z.infer<typeof TacticalPatternOutputSchema> | null = null;
    let source = "deterministic-fallback";
    let model = "fallback";

    if (ANTHROPIC_API_KEY) {
      // Tripwire de presupuesto: corta si el mes superó el tope (fail-open si el
      // ledger no responde). Cae al fallback determinista, no rompe.
      if (await isOverBudget()) return budgetExceededResponse();
      await recordSpendUsd("claude-opus"); // MODELS.reasoning = claude-opus-5-5
      try {
        const prompt = buildTacticalPatternPrompt(input);
        const resp = await fetchMessages({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            ...modelParams(MODEL, 2500),
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const text = responseText(data);
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            const validated = TacticalPatternOutputSchema.safeParse(parsed);
            if (validated.success) {
              insights = validated.data;
              source = "agent";
              model = MODEL;
            }
          }
        }
      } catch (err) {
        console.warn("[generate-insights] Anthropic call failed:", err);
      }
    }

    if (!insights) {
      // Deterministic fallback
      const dominantPhase = Object.entries(phaseDurations).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "build_up";
      insights = {
        headline: `Partido con ${possessionPct}% de posesión, foco en "${dominantPhase}".`,
        summary: "Análisis heurístico básico — agente IA no disponible.",
        byPhase: input.teamHotZonesByPhase
          .filter((p) => p.zones.length > 0)
          .slice(0, 3)
          .map((p) => ({
            phase: p.phase,
            observation: `Zona principal en ${p.zones[0]?.label ?? "centro"}.`,
            risk: "low" as const,
            suggestion: "Revisar en próximos partidos.",
          })),
        strengths: [`Posesión ${possessionPct}%`],
        weaknesses: ["Análisis IA no disponible"],
        coachingTips: ["Configurar ANTHROPIC_API_KEY para insights detallados"],
      };
    }

    // 4. Persist
    const persistRow = {
      match_id: matchId,
      team_id: team?.id ?? null,
      headline: insights.headline,
      summary: insights.summary,
      by_phase: insights.byPhase,
      strengths: insights.strengths,
      weaknesses: insights.weaknesses,
      coaching_tips: insights.coachingTips,
      model_version: TACTICAL_PROMPT_VERSION,
    };

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/tactical_insights`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(persistRow),
      });
    } catch (err) {
      console.warn("[generate-insights] persistence failed:", err);
    }

    return successResponse({ insights, source, model, promptVersion: TACTICAL_PROMPT_VERSION });
  },
);
