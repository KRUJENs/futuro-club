/**
 * VITAS · Agents Router
 * Consolidates Edge agent endpoints into one Vercel function.
 * Includes report agents needed by pipeline-orchestrator.
 */
import { errorResponse } from "../_lib/apiResponse";
import {
  isOverBudget,
  recordSpendUsd,
  budgetExceededResponse,
  type SpendEstimateKey,
} from "../_lib/budgetGuard";

import phvCalculator from "./_phv-calculator";
import playerSimilarity from "./_player-similarity";
import roleProfile from "./_role-profile";
// scout-insight retirado del router (FASE 3): duplicado inferior de
// /api/scout/generate (que además usa RAG). ScoutFeed consume scout/generate.
// El fichero _scout-insight.ts se conserva; solo se desregistra la ruta.
import tacticalLabel from "./_tactical-label";
import teamIntelligence from "./_team-intelligence";
import invalidateCache from "./_invalidate-cache";
import pipelineOrchestrator from "./_pipeline-orchestrator";
// Report agents (called by pipeline-orchestrator for 6 parallel reports)
import playerReport from "./_player-report";
import labBiomechanicsReport from "./_lab-biomechanics-report";
import dnaProfile from "./_dna-profile";
import bestMatchNarrator from "./_best-match-narrator";
import projectionReport from "./_projection-report";
import developmentPlan from "./_development-plan";
// Supporting agents
import vsiCalculator from "./_vsi-calculator";
import scanDetector from "./_scan-detector";
// Sprint 7: fatigue report agent
import fatigueReport from "./_fatigue-report";
// Sprint 8: team + rival report agents
import teamReport from "./_team-report";
import rivalScoutReport from "./_rival-scout-report";
// Sprint 9: progression tracking
import progressionTracker from "./_progression-tracker";
// Sprint 10: injury risk prediction
import injuryRiskCalculator from "./_injury-risk-calculator";
import injuryRiskReport from "./_injury-risk-report";
// Sprint 12: valuation model
import valuationModel from "./_valuation-model";
import valuationReport from "./_valuation-report";

export const config = { runtime: "edge" };

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "phv-calculator": phvCalculator,
  "player-similarity": playerSimilarity,
  "role-profile": roleProfile,
  "tactical-label": tacticalLabel,
  "team-intelligence": teamIntelligence,
  "invalidate-cache": invalidateCache,
  "pipeline-orchestrator": pipelineOrchestrator,
  // Report agents
  "player-report": playerReport,
  "lab-biomechanics-report": labBiomechanicsReport,
  "dna-profile": dnaProfile,
  "best-match-narrator": bestMatchNarrator,
  "projection-report": projectionReport,
  "development-plan": developmentPlan,
  // Supporting
  "vsi-calculator": vsiCalculator,
  "scan-detector": scanDetector,
  // Sprint 7: fatigue report
  "fatigue-report": fatigueReport,
  // Sprint 8: team + rival reports
  "team-report": teamReport,
  "rival-scout-report": rivalScoutReport,
  // Sprint 9: progression tracking
  "progression-tracker": progressionTracker,
  // Sprint 10: injury risk prediction
  "injury-risk-calculator": injuryRiskCalculator,
  "injury-risk-report": injuryRiskReport,
  // Sprint 12: valuation
  "valuation-model": valuationModel,
  "valuation-report": valuationReport,
};

// Agentes LLM de pago → estimación de coste para el ledger (tripwire 054).
// Los deterministas (vsi/scan/injury-calc/valuation-model/progression) se omiten.
// La clave DEBE reflejar el modelo REAL que corre el agente (MODELS.reasoning=Opus /
// MODELS.fast=Haiku), o el tripwire de presupuesto subestima el gasto y salta tarde.
// Los 6 que usan MODELS.reasoning van a "claude-opus" (antes 4 iban a "claude-sonnet"
// —que VITAS ni usa— y 2 a "claude-haiku"; ambos abarataban el coste real, #52).
const BILLABLE_ACTIONS: Record<string, SpendEstimateKey> = {
  "player-report":          "claude-opus",   // MODELS.reasoning
  "lab-biomechanics-report":"claude-opus",   // MODELS.reasoning
  "valuation-report":       "claude-opus",   // MODELS.reasoning
  "team-intelligence":      "claude-opus",   // MODELS.reasoning
  "team-report":            "claude-opus",   // MODELS.reasoning
  "rival-scout-report":     "claude-opus",   // MODELS.reasoning
  "dna-profile":            "claude-haiku",
  "best-match-narrator":    "claude-haiku",
  "development-plan":       "claude-haiku",
  "fatigue-report":         "claude-haiku",
  "injury-risk-report":     "claude-haiku",
  "role-profile":           "claude-haiku",
  "tactical-label":         "claude-haiku",
  "phv-calculator":         "claude-haiku",
  "player-similarity":      "claude-haiku",
};
// El orquestador solo PRE-chequea: sus sub-agentes (vía HTTP) ya contabilizan.
const PRECHECK_ONLY = new Set(["pipeline-orchestrator"]);

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const fn = routes[action];
  if (!fn) return errorResponse(`Agent "${action}" not found`, 404);

  // Tripwire de presupuesto (054): corta llamadas de pago si el mes supera el tope.
  const estKey = BILLABLE_ACTIONS[action];
  if ((estKey || PRECHECK_ONLY.has(action)) && await isOverBudget()) {
    return budgetExceededResponse();
  }

  const res = await fn(req);
  // Contabiliza el gasto estimado solo si la llamada fue OK (aprox. conservadora).
  if (estKey && res.ok) await recordSpendUsd(estKey);
  return res;
}
