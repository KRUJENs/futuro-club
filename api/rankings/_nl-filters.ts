/**
 * POST /api/rankings/nl-filters   { query }
 *
 * Búsqueda en lenguaje natural sobre Rankings (P2 bloque 11): un modelo rápido traduce la
 * frase a FILTROS del vocabulario cerrado (src/lib/search/nlRankingFilters.ts). No lee ni
 * devuelve jugadores: la lista la saca /api/rankings/list con esos filtros sobre los
 * jugadores reales del usuario. La interpretación es ESTIMADA_LLM.
 *  - Tope de gasto de IA (isOverBudget / recordSpendUsd).
 *  - Sin clave de IA ⇒ 503: la búsqueda manual por filtros sigue funcionando.
 */
import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import { NL_QUERY_MAX_CHARS, nlFilterSystemPrompt, parseNlFilterJson } from "../../src/lib/search/nlRankingFilters";

export const config = { runtime: "edge" };

const bodySchema = z.object({ query: z.string().trim().min(1).max(NL_QUERY_MAX_CHARS) });

export default withHandler(
  { schema: bodySchema, method: ["POST"], requireAuth: true, maxRequests: 20 },
  async ({ body }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorResponse({ code: "ai_unavailable", message: "La búsqueda con IA no está disponible: usa los filtros.", status: 503 });
    }
    if (await isOverBudget()) return budgetExceededResponse();

    const res = await fetchMessages({
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        ...modelParams(MODELS.fast, 300),
        temperature: 0,
        system: nlFilterSystemPrompt(),
        messages: [{ role: "user", content: body.query }],
      }),
    });
    if (!res.ok) {
      return errorResponse({ code: "nl_parse_failed", message: "No se pudo interpretar la búsqueda: usa los filtros.", status: 502 });
    }
    await recordSpendUsd("claude-haiku"); // llamada Claude (MODELS.fast) OK → contabilizada

    const parsed = parseNlFilterJson(responseText(await res.json()));
    if (!parsed) {
      return errorResponse({ code: "nl_parse_failed", message: "No se pudo interpretar la búsqueda: usa los filtros.", status: 502 });
    }
    return successResponse({
      ...parsed,
      provenance: "ESTIMADA_LLM" as const,
      source_ref: MODELS.fast,
    });
  },
);
