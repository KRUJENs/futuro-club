/**
 * VITAS · Match job — op=advance: exactamente UNA unidad acotada e idempotente por llamada
 *
 *   gemini_processing → files.get; ACTIVE ⇒ planificar tramos (idempotente) → observing
 *   observing         → presupuesto ANTES del tramo → claim (SKIP LOCKED + lease + epoch)
 *                       → generateContent (AbortController) → gasto REAL al ledger y al job
 *                       → normalización (identityGuard + zod + tiempos) → done/pending/failed
 *   aggregating       → agregación pura (observación, evidencias, cobertura) → reporting | completed
 *   reporting         → lease del informe → Claude team-report.v2 → completed (informe o gate)
 * Un tramo `done` nunca se vuelve a pedir ni a facturar. Dos advance simultáneos sobre el
 * mismo tramo → el claim de la RPC solo lo entrega a uno.
 */
import {
  SEGMENT_PROMPT_VERSION,
  TEAM_REPORT_PROMPT_VERSION,
  matchObservationSchema,
  type MatchJobStatus,
  type TeamKit,
} from "../../../src/lib/shared/matchJob/contract";
import { normalizeLocale } from "../../../src/lib/shared/locale";
import { GEMINI_MODEL } from "../../../src/lib/shared/geminiModel";
import { MODELS } from "../models";
import { recordSpendAmountUsd, wouldExceedBudget } from "../budgetGuard";
import { getFile } from "../gemini/files";
import { generateJson, type GenerateFailureKind } from "../gemini/generate";
import { generateMatchReportV2 } from "../../agents/_teamReportCore";
import { aggregateMatch, hasAnalysedSegments } from "./aggregate";
import { AGGREGATE_CONFIDENCE, MATCH_VIDEO_CONFIG as CFG } from "./config";
import { anthropicUsageCostUsd, geminiUsageCostUsd, reportUpperBoundUsd, segmentUpperBoundUsd } from "./costing";
import {
  completeJob,
  dispatchJob,
  failJob,
  failJobKeepingPartial,
  finalizeCleanup,
  isFileUsable,
  nowIso,
  toSegmentStates,
} from "./driver";
import { buildNameGuard, rosterRedactionFilter, type NameGuard } from "./identityGuard";
import { gateReason, type SegmentFailureKind } from "./messages";
import { planSegments } from "./plan";
import { buildSegmentGenerateRequest } from "./segmentRequest";
import * as repo from "./repo";
import type { MatchJobRow, SegmentRow } from "./repo";
import { assertTransition, isTerminal } from "./stateMachine";
import { normalizeSegmentOutput, visualBasisFromUsage, type NormalizedSegment } from "./segmentResult";

export { toSegmentStates };

export type AdvanceReply = { kind: "state"; state: MatchJobStatus; retryAfterSec: number } | { kind: "superseded" };

const reply = (state: MatchJobStatus, retryAfterSec: number): AdvanceReply => ({ kind: "state", state, retryAfterSec });
const MS = 1000;
/** Espera tras un error reintentable del proveedor (s). Decisión de diseño, no métrica. */
const RETRY_BACKOFF_SEC = 10;
/** Espera máxima cuando otro advance tiene el lease del tramo (s). */
const LEASE_WAIT_CAP_SEC = 30;

function kitOf(t: MatchJobRow["home"]): TeamKit | null {
  return (t?.kit as TeamKit | undefined) ?? null;
}

/** Nombres a filtrar en el TEXTO (notas del entrenador + plantilla). */
export async function jobNameGuard(job: MatchJobRow): Promise<NameGuard> {
  // Lista de NOMBRES A QUITAR del texto, no un permiso: sobre-filtrar es la dirección
  // segura (identidad.md). Por eso sigue incluyendo la plantilla del tenant del job,
  // igual que antes de la 076; ningún nombre llega al usuario por esta vía.
  const roster = await repo.loadRosterNames(rosterRedactionFilter(job.user_id, job.tenant_id));
  const exclude = [
    job.home?.name,
    job.away?.name,
    job.home?.kit?.shirt?.label,
    job.home?.kit?.shorts?.label,
    job.home?.kit?.gk?.label,
    job.away?.kit?.shirt?.label,
    job.away?.kit?.shorts?.label,
    job.away?.kit?.gk?.label,
  ];
  return buildNameGuard({ notes: job.notes, rosterNames: roster, exclude });
}

/** Fichero Gemini perdido/caducado ⇒ re-despacho a `dispatched` (re-transcode); los tramos hechos se conservan. */
async function redispatchLostFile(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  const out = await dispatchJob(job, "gemini_file_lost", now, { fileLost: true });
  if (out.kind === "failed") return reply(out.job?.status ?? "failed", 0);
  // Epoch nuevo (o conflicto: otro ya lo re-despachó) ⇒ este worker queda obsoleto.
  return { kind: "superseded" };
}

// ── gemini_processing ────────────────────────────────────────────────────────

async function advanceGeminiProcessing(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  if (!job.gemini_file_name || !isFileUsable(job, now)) return redispatchLostFile(job, now);
  const got = await getFile(job.gemini_file_name);
  if (!got.ok) {
    if (got.status === 404) return redispatchLostFile(job, now);
    return reply(job.status, CFG.geminiProcessingRetrySec);
  }
  const state = got.file.state;
  if (state === "FAILED") {
    const failed = await failJob(job, "gemini_file_failed", { now });
    return reply(failed?.status ?? "failed", 0);
  }
  if (state !== "ACTIVE") return reply(job.status, CFG.geminiProcessingRetrySec);
  if (job.duration_sec === null) {
    const failed = await failJob(job, "internal_error", { now, stageDetail: "duration_unknown_at_planning" });
    return reply(failed?.status ?? "failed", 0);
  }
  const planned = planSegments(job.duration_sec, CFG.segmentSec, CFG.minTrailingSegmentSec);
  await repo.insertSegments(job.id, planned);
  assertTransition("gemini_processing", "observing");
  const updated = await repo.patchJob(
    job.id,
    {
      status: "observing",
      segments_total: planned.length,
      gemini_file_expires_at: got.file.expirationTime ?? job.gemini_file_expires_at,
      prompt_versions: { segment: SEGMENT_PROMPT_VERSION, report: TEAM_REPORT_PROMPT_VERSION },
      model_ids: { gemini: GEMINI_MODEL },
    },
    { status: "gemini_processing", epoch: job.dispatch_epoch },
  );
  return reply(updated?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
}

// ── observing ────────────────────────────────────────────────────────────────

const allTerminal = (rows: readonly SegmentRow[]) => rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed" || r.status === "skipped");

async function toAggregating(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  assertTransition("observing", "aggregating");
  const updated = await repo.patchJob(job.id, { status: "aggregating" }, { status: "observing", epoch: job.dispatch_epoch });
  if (updated) await finalizeCleanup(updated, now); // el vídeo ya no hace falta: se borra cuanto antes (minimización)
  return reply(updated?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
}

/** Presupuesto agotado: se conservan los tramos hechos (observación parcial) y el job falla con budget_exhausted. */
async function stopForBudget(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  const locale = normalizeLocale(job.locale);
  const failed = await failJobKeepingPartial(job, "budget_exhausted", {
    now,
    reportGate: job.purpose === "match_ab" ? { code: "report_budget_exhausted", reason: gateReason(locale, "report_budget_exhausted") } : null,
  });
  return reply(failed?.status ?? "failed", 0);
}

function failureKindFromGenerate(kind: GenerateFailureKind): SegmentFailureKind {
  switch (kind) {
    case "max_tokens":
      return "max_tokens";
    case "invalid_json":
      return "invalid_output";
    case "timeout":
      return "timeout";
    case "blocked":
      return "blocked";
    default:
      return "provider_error";
  }
}

async function advanceObserving(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  if (!isFileUsable(job, now)) return redispatchLostFile(job, now);
  const rows = await repo.listSegments(job.id);
  if (allTerminal(rows)) return toAggregating(job, now);

  // Presupuesto ANTES de cada tramo (cota alta del tramo; la reserva propia no se cuenta).
  const budget = await wouldExceedBudget(segmentUpperBoundUsd(CFG.segmentSec, GEMINI_MODEL), { excludeJobId: job.id });
  if (budget.exceeded) return stopForBudget(job, now);

  const seg = await repo.claimSegment({
    jobId: job.id,
    epoch: job.dispatch_epoch,
    leaseSec: CFG.segmentLeaseSec,
    maxAttempts: CFG.maxSegmentAttempts,
  });
  if (!seg) {
    const fresh = await repo.getJob(job.id);
    if (!fresh || fresh.status !== "observing" || fresh.dispatch_epoch !== job.dispatch_epoch) {
      return fresh && fresh.dispatch_epoch !== job.dispatch_epoch ? { kind: "superseded" } : reply(fresh?.status ?? job.status, 0);
    }
    const again = await repo.listSegments(job.id);
    if (allTerminal(again)) return toAggregating(fresh, now);
    const leases = again
      .filter((r) => r.status === "running" && r.lease_until)
      .map((r) => Math.ceil((Date.parse(r.lease_until as string) - now.getTime()) / MS));
    const wait = leases.length ? Math.min(Math.max(...leases, 1), LEASE_WAIT_CAP_SEC) : RETRY_BACKOFF_SEC;
    return reply("observing", wait);
  }

  // Petición EXACTA compartida con el arnés de validación (segmentRequest.ts).
  const gen = await generateJson(
    buildSegmentGenerateRequest({
      model: GEMINI_MODEL,
      fileUri: job.gemini_file_uri as string,
      locale: normalizeLocale(job.locale),
      category: job.category,
      homeKit: kitOf(job.home),
      awayKit: kitOf(job.away),
      attackingDir1h: job.attacking_dir_1h,
      segment: seg,
      totalSegments: job.segments_total ?? rows.length,
    }),
  );

  // Gasto REAL (los tokens se facturan aunque la salida no sirva).
  const usage = gen.usage;
  const cost = usage ? geminiUsageCostUsd(usage, GEMINI_MODEL).usd : 0;
  if (cost > 0) {
    await recordSpendAmountUsd("gemini", cost);
    await repo.addJobSpend(job.id, "gemini", cost);
  }
  const fence = { status: "running" as const, leaseEpoch: job.dispatch_epoch, attempts: seg.attempts };
  const base = { usage, cost_usd: seg.cost_usd + cost, lease_until: null };

  if (gen.ok) {
    // Sin tokens de vídeo en el prompt ⇒ la IA respondió SIN VER el tramo: nada de él se
    // usa (fallo del tramo, como mucho 1 reintento). Nunca se guarda como observación.
    const visualBasis = visualBasisFromUsage(usage);
    if (visualBasis === "absent") return settleFailure(job, seg, base, fence, "no_visual_input", true, now);
    const names = await jobNameGuard(job);
    const norm = normalizeSegmentOutput(gen.json, seg, names);
    if (norm.ok) {
      const result: NormalizedSegment = { ...norm.value, visual_basis: visualBasis };
      await repo.patchSegment(job.id, seg.idx, { ...base, status: "done", result, error: null, finished_at: nowIso(now) }, fence);
      const done = (await repo.listSegments(job.id)).filter((r) => r.status === "done").length;
      await repo.patchJob(job.id, { segments_done: done }, { epoch: job.dispatch_epoch });
      return reply("observing", 0);
    }
    return settleFailure(job, seg, base, fence, "invalid_output", true, now);
  }
  if (gen.kind === "file_unavailable") {
    // El fichero desapareció: el tramo vuelve a pending sin gastar intento y se re-despacha.
    await repo.patchSegment(job.id, seg.idx, { ...base, status: "pending", attempts: Math.max(0, seg.attempts - 1) }, fence);
    return redispatchLostFile(job, now);
  }
  const kind = failureKindFromGenerate(gen.kind);
  return settleFailure(job, seg, base, fence, kind, kind === "max_tokens" || kind === "invalid_output", now);
}

async function settleFailure(
  job: MatchJobRow,
  seg: SegmentRow,
  base: Record<string, unknown>,
  fence: { status: "running"; leaseEpoch: number; attempts: number },
  kind: SegmentFailureKind,
  invalidOutput: boolean,
  now: Date,
): Promise<AdvanceReply> {
  const invalidAttempts = seg.invalid_attempts + (invalidOutput ? 1 : 0);
  const exhausted =
    kind === "blocked" || seg.attempts >= CFG.maxSegmentAttempts || (invalidOutput && invalidAttempts >= CFG.maxInvalidOutputAttempts);
  await repo.patchSegment(
    job.id,
    seg.idx,
    {
      ...base,
      status: exhausted ? "failed" : "pending",
      invalid_attempts: invalidAttempts,
      error: { kind, attempts: seg.attempts },
      ...(exhausted ? { finished_at: nowIso(now) } : {}),
    },
    fence,
  );
  return reply("observing", exhausted ? 0 : RETRY_BACKOFF_SEC);
}

// ── aggregating ──────────────────────────────────────────────────────────────

async function advanceAggregating(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  const rows = await repo.listSegments(job.id);
  const locale = normalizeLocale(job.locale);
  let observation;
  try {
    observation = aggregateMatch({
      durationSec: job.duration_sec,
      segments: toSegmentStates(rows),
      locale,
      geminiModel: GEMINI_MODEL,
      confidence: AGGREGATE_CONFIDENCE,
    });
  } catch (err) {
    console.error("[match] agregación fallida:", err instanceof Error ? err.message : err);
    const failed = await failJob(job, "internal_error", { now, stageDetail: "aggregate_failed" });
    return reply(failed?.status ?? "failed", 0);
  }
  const patch = {
    observation,
    coverage: observation.coverage,
    segments_done: rows.filter((r) => r.status === "done").length,
  };
  if (job.purpose === "team_baseline") {
    // El informe del baseline lo genera /api/team/baseline-analysis con matchAnalysisId.
    const done = await completeJob(job, { ...patch, report: null, report_gate: null }, now);
    return reply(done?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
  }
  if (!hasAnalysedSegments(observation)) {
    const gate = { code: "report_no_analysed_segments", reason: gateReason(locale, "report_no_analysed_segments") };
    const done = await completeJob(job, { ...patch, report: null, report_gate: gate }, now);
    return reply(done?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
  }
  assertTransition("aggregating", "reporting");
  const updated = await repo.patchJob(job.id, { ...patch, status: "reporting" }, { status: "aggregating", epoch: job.dispatch_epoch });
  return reply(updated?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
}

// ── reporting ────────────────────────────────────────────────────────────────

async function advanceReporting(job: MatchJobRow, now: Date): Promise<AdvanceReply> {
  const locale = normalizeLocale(job.locale);
  // Lease del informe: dos advance simultáneos → una sola llamada a Claude.
  const leased = await repo.patchJob(
    job.id,
    { report_lease_until: new Date(now.getTime() + CFG.reportLeaseSec * MS).toISOString() },
    {
      status: "reporting",
      epoch: job.dispatch_epoch,
      raw: `&or=(report_lease_until.is.null,report_lease_until.lt.${encodeURIComponent(nowIso(now))})`,
    },
  );
  if (!leased) return reply("reporting", CFG.geminiProcessingRetrySec);

  const obs = matchObservationSchema.safeParse(leased.observation);
  if (!obs.success) {
    const failed = await failJob(leased, "internal_error", { now, stageDetail: "observation_invalid_at_report" });
    return reply(failed?.status ?? "failed", 0);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    const gate = { code: "report_engine_unavailable", reason: gateReason(locale, "report_engine_unavailable") };
    const done = await completeJob(leased, { report: null, report_gate: gate }, now);
    return reply(done?.status ?? "completed", 0);
  }
  const budget = await wouldExceedBudget(reportUpperBoundUsd(), { excludeJobId: job.id });
  if (budget.exceeded) {
    const gate = { code: "report_budget_exhausted", reason: gateReason(locale, "report_budget_exhausted") };
    const done = await completeJob(leased, { report: null, report_gate: gate }, now);
    return reply(done?.status ?? "completed", 0);
  }

  const result = await generateMatchReportV2({
    locale,
    category: leased.category,
    home: { name: leased.home?.name ?? null, kit: kitOf(leased.home) },
    away: { name: leased.away?.name ?? null, kit: kitOf(leased.away) },
    attackingDir1h: leased.attacking_dir_1h,
    notes: leased.notes,
    observation: obs.data,
    names: await jobNameGuard(leased),
    replyTokens: CFG.reportReplyTokens,
    timeoutMs: CFG.reportTimeoutMs,
    now,
  });
  if (result.usage) {
    const cost = anthropicUsageCostUsd(result.usage, result.model ?? MODELS.reasoning).usd;
    await recordSpendAmountUsd("claude", cost);
    await repo.addJobSpend(job.id, "claude", cost);
  }
  const modelIds = { ...(leased.model_ids ?? {}), ...(result.model ? { report: result.model } : {}) };
  const patch =
    result.kind === "report"
      ? { report: result.report, report_gate: null, report_model: result.model, model_ids: modelIds }
      : { report: null, report_gate: result.gate, report_model: result.model, model_ids: modelIds };
  const done = await completeJob(leased, patch, now);
  return reply(done?.status ?? (await repo.getJob(job.id))?.status ?? job.status, 0);
}

// ── Entrada ──────────────────────────────────────────────────────────────────

export async function advanceJob(job: MatchJobRow, now = new Date()): Promise<AdvanceReply> {
  if (isTerminal(job.status)) return reply(job.status, 0);
  switch (job.status) {
    case "gemini_processing":
      return advanceGeminiProcessing(job, now);
    case "observing":
      return advanceObserving(job, now);
    case "aggregating":
      return advanceAggregating(job, now);
    case "reporting":
      return advanceReporting(job, now);
    default:
      // awaiting_encode / dispatched / preparing / uploading: el worker aún no ha entregado el proxy.
      return reply(job.status, CFG.geminiProcessingRetrySec);
  }
}
