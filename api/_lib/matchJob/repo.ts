/**
 * VITAS · Match job — acceso a Supabase (PostgREST, service role)
 *
 * El service role SALTA RLS: toda comprobación de propiedad se hace en el llamador
 * (ownsVideo / ownsMatchAnalysis). Todos los ids que entran en un filtro se codifican
 * (encodeURIComponent) para que un id externo no inyecte parámetros PostgREST.
 * Escrituras con guardas (status / dispatch_epoch) = compare-and-set atómico: si otra
 * invocación movió el job, el PATCH no afecta filas y devuelve null.
 */
import { serviceHeaders, supabaseRestUrl } from "../supabaseRest";
import type { MatchJobStatus, MatchPurpose, SegmentStatus, TeamSide } from "../../../src/lib/shared/matchJob/contract";
import { ACTIVE_MATCH_JOB_STATUSES } from "./stateMachine";
import type { PlannedSegment } from "./plan";

const JOBS = "match_analyses";
const SEGS = "match_analysis_segments";

export class RepoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export interface TeamRow {
  name?: string;
  kit?: { shirt: { hex: string; label?: string }; shorts?: { hex: string; label?: string }; gk?: { hex: string; label?: string } };
}

export interface MatchJobRow {
  id: string;
  user_id: string;
  org_id: string | null;
  tenant_id: string | null;
  video_id: string;
  bunny_video_id: string;
  purpose: MatchPurpose;
  home: TeamRow;
  away: TeamRow;
  focus_team: TeamSide | null;
  attacking_dir_1h: "left_to_right" | "right_to_left" | null;
  notes: string | null;
  category: "youth" | "senior" | null;
  locale: string;
  kit_fingerprint: string;
  attested_by: string;
  attested_at: string;
  attestation_version: string;
  status: MatchJobStatus;
  stage_detail: string | null;
  dispatch_epoch: number;
  dispatch_attempts: number;
  modal_call_id: string | null;
  dispatched_at: string | null;
  heartbeat_at: string | null;
  duration_sec: number | null;
  bunny_status: number | null;
  target_variant: string | null;
  proxy: { bytes: number; sha256: string; durationSec: number; mime: string } | null;
  gemini_file_name: string | null;
  gemini_file_uri: string | null;
  gemini_file_display_name: string | null;
  gemini_file_expires_at: string | null;
  gemini_file_deleted_at: string | null;
  segments_total: number | null;
  segments_done: number;
  observation: unknown;
  coverage: unknown;
  report: unknown;
  report_gate: { code: string; reason: string } | null;
  report_model: string | null;
  report_lease_until: string | null;
  prompt_versions: Record<string, string> | null;
  model_ids: Record<string, string> | null;
  estimate: unknown;
  estimate_usd: number;
  reservation_usd: number;
  spend_usd: number;
  spend_detail: Record<string, number>;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface SegmentRow {
  match_analysis_id: string;
  idx: number;
  start_sec: number;
  end_sec: number;
  status: SegmentStatus;
  lease_until: string | null;
  lease_epoch: number | null;
  attempts: number;
  invalid_attempts: number;
  result: unknown;
  usage: unknown;
  cost_usd: number;
  error: { kind: string; attempts: number; message?: string } | null;
  finished_at: string | null;
}

export interface VideoRow {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  org_id: string | null;
  player_id: string | null;
  bunny_video_id: string | null;
}

const enc = encodeURIComponent;
const url = (path: string) => `${supabaseRestUrl()}/rest/v1/${path}`;
const inList = (values: readonly string[]) => `(${values.map((v) => `"${v.replace(/"/g, "")}"`).join(",")})`;
const ACTIVE_IN = inList(ACTIVE_MATCH_JOB_STATUSES);
const TERMINAL_IN = inList(["completed", "failed", "cancelled"]);

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(path), { ...init, headers: { ...serviceHeaders(), ...(init.headers as Record<string, string> | undefined) } });
}

async function rows<T>(res: Response, what: string): Promise<T[]> {
  if (!res.ok) throw new RepoError(`${what}: HTTP ${res.status}`, res.status);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

function normalizeJob(r: MatchJobRow): MatchJobRow {
  return {
    ...r,
    duration_sec: num(r.duration_sec),
    estimate_usd: Number(r.estimate_usd ?? 0),
    reservation_usd: Number(r.reservation_usd ?? 0),
    spend_usd: Number(r.spend_usd ?? 0),
    spend_detail: r.spend_detail ?? {},
  };
}

function normalizeSeg(r: SegmentRow): SegmentRow {
  return { ...r, start_sec: Number(r.start_sec), end_sec: Number(r.end_sec), cost_usd: Number(r.cost_usd ?? 0) };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function getJob(id: string): Promise<MatchJobRow | null> {
  const res = await sb(`${JOBS}?id=eq.${enc(id)}&select=*&limit=1`);
  const [row] = await rows<MatchJobRow>(res, "getJob");
  return row ? normalizeJob(row) : null;
}

export type InsertJobResult = { ok: true; job: MatchJobRow } | { ok: false; conflict: boolean; status: number };

/** 409 = el índice único parcial (1 job activo por usuario) rechazó la carrera. */
export async function insertJob(row: Record<string, unknown>): Promise<InsertJobResult> {
  const res = await sb(JOBS, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!res.ok) return { ok: false, conflict: res.status === 409, status: res.status };
  const [job] = (await res.json()) as MatchJobRow[];
  return { ok: true, job: normalizeJob(job) };
}

export interface JobGuard {
  status?: MatchJobStatus | readonly MatchJobStatus[];
  epoch?: number;
  /** Filtro PostgREST adicional ya codificado (p. ej. "&report_lease_until=lt.<iso>"). */
  raw?: string;
}

function guardQuery(g: JobGuard): string {
  let q = "";
  if (typeof g.status === "string") q += `&status=eq.${enc(g.status)}`;
  else if (g.status) q += `&status=in.${enc(inList(g.status))}`;
  if (g.epoch !== undefined) q += `&dispatch_epoch=eq.${g.epoch}`;
  return q + (g.raw ?? "");
}

/** PATCH con guarda (compare-and-set). null ⇒ ninguna fila casó la guarda. */
export async function patchJob(id: string, patch: Record<string, unknown>, guard: JobGuard = {}): Promise<MatchJobRow | null> {
  const res = await sb(`${JOBS}?id=eq.${enc(id)}${guardQuery(guard)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  const [row] = await rows<MatchJobRow>(res, "patchJob");
  return row ? normalizeJob(row) : null;
}

export async function listUserJobs(userId: string, limit: number): Promise<MatchJobRow[]> {
  const res = await sb(`${JOBS}?user_id=eq.${enc(userId)}&select=*&order=created_at.desc&limit=${limit}`);
  return (await rows<MatchJobRow>(res, "listUserJobs")).map(normalizeJob);
}

export async function findActiveDedup(opts: {
  userId: string;
  videoId: string;
  purpose: MatchPurpose;
  kitFingerprint: string;
}): Promise<MatchJobRow | null> {
  const res = await sb(
    `${JOBS}?user_id=eq.${enc(opts.userId)}&video_id=eq.${enc(opts.videoId)}&purpose=eq.${enc(opts.purpose)}` +
      `&kit_fingerprint=eq.${enc(opts.kitFingerprint)}&status=in.${enc(ACTIVE_IN)}&select=*&limit=1`,
  );
  const [row] = await rows<MatchJobRow>(res, "findActiveDedup");
  return row ? normalizeJob(row) : null;
}

/** Nº de jobs activos (de un usuario o globales). Acotado: el tope es pequeño. */
export async function countActiveJobs(opts: { userId?: string } = {}): Promise<number> {
  const user = opts.userId ? `&user_id=eq.${enc(opts.userId)}` : "";
  const res = await sb(`${JOBS}?status=in.${enc(ACTIVE_IN)}${user}&select=id&limit=100`);
  return (await rows<{ id: string }>(res, "countActiveJobs")).length;
}

export async function listJobsByStatus(statuses: readonly MatchJobStatus[], limit: number): Promise<MatchJobRow[]> {
  const res = await sb(`${JOBS}?status=in.${enc(inList(statuses))}&select=*&order=updated_at.asc&limit=${limit}`);
  return (await rows<MatchJobRow>(res, "listJobsByStatus")).map(normalizeJob);
}

/** Jobs terminales con fichero Gemini aún sin borrar (barrido). */
export async function listTerminalJobsWithFiles(limit: number): Promise<MatchJobRow[]> {
  const res = await sb(
    `${JOBS}?status=in.${enc(TERMINAL_IN)}&gemini_file_name=not.is.null&gemini_file_deleted_at=is.null&select=*&limit=${limit}`,
  );
  return (await rows<MatchJobRow>(res, "listTerminalJobsWithFiles")).map(normalizeJob);
}

export async function getJobsByIds(ids: readonly string[]): Promise<MatchJobRow[]> {
  if (ids.length === 0) return [];
  const res = await sb(`${JOBS}?id=in.${enc(inList(ids))}&select=*`);
  return (await rows<MatchJobRow>(res, "getJobsByIds")).map(normalizeJob);
}

/** Jobs que creó un usuario (borrado RGPD). Solo por user_id, nunca por tenant (076). */
export async function listJobsForUser(userId: string): Promise<MatchJobRow[]> {
  const res = await sb(`${JOBS}?user_id=eq.${enc(userId)}&select=*`);
  return (await rows<MatchJobRow>(res, "listJobsForUser")).map(normalizeJob);
}

export async function listJobsForVideos(videoIds: readonly string[]): Promise<MatchJobRow[]> {
  if (videoIds.length === 0) return [];
  const res = await sb(`${JOBS}?video_id=in.${enc(inList(videoIds))}&select=*`);
  return (await rows<MatchJobRow>(res, "listJobsForVideos")).map(normalizeJob);
}

export async function deleteJobs(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await sb(`${JOBS}?id=in.${enc(inList(ids))}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  return (await rows<{ id: string }>(res, "deleteJobs")).length;
}

/** Gasto real acumulado en el job (RPC atómica). Best-effort: el ledger global es la referencia del tope. */
export async function addJobSpend(jobId: string, service: "gemini" | "claude" | "modal", usd: number): Promise<void> {
  if (!(usd > 0)) return;
  try {
    await sb("rpc/add_match_spend", { method: "POST", body: JSON.stringify({ p_job_id: jobId, p_service: service, p_usd: usd }) });
  } catch {
    /* best-effort */
  }
}

// ── Segmentos ────────────────────────────────────────────────────────────────

/** Idempotente: la PK (match_analysis_id, idx) + ignore-duplicates evita duplicar tramos. */
export async function insertSegments(jobId: string, planned: readonly PlannedSegment[]): Promise<void> {
  const res = await sb(`${SEGS}?on_conflict=match_analysis_id,idx`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(planned.map((p) => ({ match_analysis_id: jobId, idx: p.idx, start_sec: p.start_sec, end_sec: p.end_sec }))),
  });
  if (!res.ok) throw new RepoError(`insertSegments: HTTP ${res.status}`, res.status);
}

export async function listSegments(jobId: string): Promise<SegmentRow[]> {
  const res = await sb(`${SEGS}?match_analysis_id=eq.${enc(jobId)}&select=*&order=idx.asc`);
  return (await rows<SegmentRow>(res, "listSegments")).map(normalizeSeg);
}

/** RPC claim_next_match_segment (SKIP LOCKED + lease + fencing por epoch). */
export async function claimSegment(opts: { jobId: string; epoch: number; leaseSec: number; maxAttempts: number }): Promise<SegmentRow | null> {
  const res = await sb("rpc/claim_next_match_segment", {
    method: "POST",
    body: JSON.stringify({ p_job_id: opts.jobId, p_epoch: opts.epoch, p_lease_sec: opts.leaseSec, p_max_attempts: opts.maxAttempts }),
  });
  const [row] = await rows<SegmentRow>(res, "claimSegment");
  return row ? normalizeSeg(row) : null;
}

export async function patchSegment(
  jobId: string,
  idx: number,
  patch: Record<string, unknown>,
  guard: { status?: SegmentStatus; leaseEpoch?: number; attempts?: number } = {},
): Promise<SegmentRow | null> {
  let q = `${SEGS}?match_analysis_id=eq.${enc(jobId)}&idx=eq.${idx}`;
  if (guard.status) q += `&status=eq.${guard.status}`;
  if (guard.leaseEpoch !== undefined) q += `&lease_epoch=eq.${guard.leaseEpoch}`;
  if (guard.attempts !== undefined) q += `&attempts=eq.${guard.attempts}`;
  const res = await sb(q, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  const [row] = await rows<SegmentRow>(res, "patchSegment");
  return row ? normalizeSeg(row) : null;
}

/** Tramos aún abiertos → skipped (budget / cancel / fallo del job). Resultados hechos intactos. */
export async function skipOpenSegments(jobId: string, error: { kind: string; attempts: number }): Promise<void> {
  const res = await sb(`${SEGS}?match_analysis_id=eq.${enc(jobId)}&status=in.(pending,running)`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "skipped", lease_until: null, error, finished_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new RepoError(`skipOpenSegments: HTTP ${res.status}`, res.status);
}

// ── Otras tablas ─────────────────────────────────────────────────────────────

export async function getVideoRow(videoId: string): Promise<VideoRow | null> {
  const res = await sb(`videos?id=eq.${enc(videoId)}&select=id,user_id,tenant_id,org_id,player_id,bunny_video_id&limit=1`);
  const [row] = await rows<VideoRow>(res, "getVideoRow");
  return row ?? null;
}

/**
 * Nombres de la plantilla del usuario/tenant para el filtro de texto de identidad.
 * Best-effort: si falla, el filtro sigue con patrones + notas (se registra el aviso).
 */
export async function loadRosterNames(orFilter: string, limit = 200): Promise<string[]> {
  try {
    const res = await sb(`players?or=(${enc(orFilter)})&select=name&limit=${limit}`);
    if (!res.ok) return [];
    return ((await res.json()) as Array<{ name: string | null }>).map((p) => p.name).filter((n): n is string => !!n);
  } catch {
    return [];
  }
}
