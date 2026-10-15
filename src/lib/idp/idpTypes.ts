/**
 * VITAS · IDP (Individual Development Plan) — shared types
 *
 * One monthly plan per player. Hybrid generation: AI architect (Claude
 * Sonnet) proposes 1-5 goals (only dimensions with data), coach edits + approves,
 * progress tracked weekly via milestones, monthly checkin at month end.
 *
 * Mirrors the schema in supabase/migrations/047_development_plans.sql.
 */

import type { ReportLocale } from "../shared/locale";

// ── Enums ─────────────────────────────────────────────────────────────
export type IDPDimension =
  | "technical"   // pase, control, finalización
  | "tactical"    // lectura, posicionamiento, decisión
  | "physical"    // sprint, resistencia, fuerza, agilidad
  | "mental"      // resiliencia, scanning, liderazgo (consume del BPE)
  | "maturation"; // gestión PHV, riesgo lesión (auto-omit si no hay PHV)

export type IDPPlanStatus =
  | "draft"       // AI propuso, coach revisando
  | "active"      // coach aprobó, en ejecución
  | "completed"   // mes terminado, checkin hecho
  | "abandoned";  // descartado antes de terminar

export type IDPGoalStatus =
  | "pending"
  | "in_progress"
  | "achieved"
  | "missed"
  | "cancelled";

export type IDPMilestoneStatus =
  | "pending"
  | "completed"
  | "missed"
  | "partial";

export type IDPGeneratedBy = "coach" | "agent" | "hybrid";

// ── Core entities ─────────────────────────────────────────────────────

/** A measurable metric snapshot (baseline / target / current). */
export interface IDPMetricRef {
  /** Identifier from MetricsService / VSI / behavioral / etc. */
  metric: string;
  /** Numeric value. Units are implicit per metric. */
  value: number;
  /** Optional human label for UI. */
  label?: string;
  /** Optional unit (%, ms, m/s, score). */
  unit?: string;
}

export interface IDPGoal {
  id: string;
  planId: string;
  dimension: IDPDimension;
  title: string;
  description?: string;
  /** Why this goal — usually AI-generated, coach can edit. */
  rationale?: string;
  baselineMetric: IDPMetricRef;
  targetMetric: IDPMetricRef;
  /** Updated by `idpProgressTracker`. */
  currentValue?: number;
  /** Drill IDs from `DRILLS_LIBRARY`. */
  drillsAssigned: string[];
  /** Priority 1-5 (5 = highest). */
  weight: number;
  status: IDPGoalStatus;
  aiProposed: boolean;
  coachEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IDPMilestone {
  id: string;
  planId: string;
  goalId: string;
  /** ISO date. */
  dueDate: string;
  /** 1-5 (most months are 4 weeks). */
  weekNumber: number;
  title: string;
  successCriteria?: string;
  status: IDPMilestoneStatus;
  /** Auto-collected proof (video ids, session ids, metric snapshots). */
  evidence: {
    videoIds?: string[];
    sessionIds?: string[];
    metrics?: Record<string, number>;
    notes?: string;
  };
  completedAt?: string;
  createdAt: string;
}

export interface IDPCheckin {
  id: string;
  planId: string;
  /** NULL = plan-level checkin (overall), set = per-goal. */
  goalId?: string;
  reviewerId?: string;
  reviewedAt: string;
  /** 0-100. */
  progressScore?: number;
  qualitativeNotes?: string;
  /** Raw questionnaire form responses (coach end-of-month form). */
  questionnaireAnswers: Record<string, unknown>;
  /** Forward-looking proposals for next month. */
  adjustmentsProposed: {
    nextMonthFocus?: string;
    drillsToChange?: string[];
    dimensionsToBoost?: IDPDimension[];
    notes?: string;
  };
  createdAt: string;
}

export interface DevelopmentPlan {
  id: string;
  playerId: string;
  coachId?: string;
  tenantId?: string;
  /** ISO date, first day of the month (YYYY-MM-01). */
  monthStart: string;
  /** ISO date, last day of the month. */
  monthEnd: string;
  status: IDPPlanStatus;
  overallFocus?: string;
  contextNotes?: string;
  agentSummary?: string;
  generatedBy: IDPGeneratedBy;
  agentVersion?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  // ── Loaded relations (optional, used by UI)
  goals?: IDPGoal[];
  milestones?: IDPMilestone[];
  checkins?: IDPCheckin[];
}

// ── Aggregated views ──────────────────────────────────────────────────

/** Computed by `idpProgressTracker.computeSummary()`. */
export interface IDPProgressSummary {
  planId: string;
  playerId: string;
  monthStart: string;
  monthEnd: string;
  /** 0-100 weighted average across MEASURED goals, o null si ninguna meta tiene
   *  medición todavía (inv#2: sin datos se bloquea, no se rellena con un 0%). */
  overallProgress: number | null;
  goalsAchieved: number;
  goalsOpen: number;
  goalsTotal: number;
  /** Per-dimension progress for radar chart. */
  byDimension: Record<IDPDimension, number>;
  /** Goals at risk of being missed (current trajectory < target). */
  atRiskGoals: string[];
  /** Days remaining in the month. */
  daysRemaining: number;
}

// ── Agent contract types ──────────────────────────────────────────────

/**
 * Input the `_idp-architect` agent receives. UNA sola definición: la del contrato
 * (`IDPArchitectInputSchema`, src/agents/contracts.ts). Antes había aquí una copia a mano
 * que ya divergía (P1 bloque 5d, invariante #7): edad, posición y dimensiones del VSI
 * ahora son nullable/opcionales en el contrato.
 */
export type { IDPArchitectInput } from "../../agents/contracts";

/** Output structure the `_idp-architect` returns (validated by Zod). */
export interface IDPArchitectOutput {
  overallFocus: string;
  agentSummary: string;
  goals: Array<{
    dimension: IDPDimension;
    title: string;
    description: string;
    rationale: string;
    baselineMetric: IDPMetricRef;
    targetMetric: IDPMetricRef;
    suggestedDrills: string[];
    weight: number;
  }>;
}
