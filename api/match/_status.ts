/**
 * VITAS · GET /api/match/status?jobId= — SOLO LECTURA (CWE-650)
 *
 * Nunca despacha, nunca llama a Gemini ni a Claude, nunca escribe (lección del demo
 * decide: un GET no muta ni gasta). Solo el dueño, quien creó el job (ownsMatchAnalysis;
 * el service role salta RLS; nunca por tenant, 076). Puede LEER la API de Bunny para el estado del encode (dato
 * operativo, no métrica) — sustituye el sondeo de api/videos/_status.ts, que no
 * comprueba propiedad.
 */
import { withHandler } from "../_lib/withHandler";
import { errorResponse, successResponse } from "../_lib/apiResponse";
import { ownsMatchAnalysis } from "../_lib/ownership";
import { playbackEmbed } from "../_lib/matchJob/bunnySource";
import { readBunnyVideo } from "../_lib/matchJob/driver";
import { buildStatusView } from "../_lib/matchJob/statusView";
import * as repo from "../_lib/matchJob/repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default withHandler({ method: "GET", requireAuth: true, maxRequests: 120 }, async ({ query, userId }) => {
  const jobId = query.jobId ?? "";
  if (!UUID_RE.test(jobId)) return errorResponse({ message: "jobId inválido", status: 400, code: "invalid_input" });

  const job = await repo.getJob(jobId);
  // 404 también para jobs ajenos: no se revela su existencia.
  if (!job || !ownsMatchAnalysis(job, userId)) {
    return errorResponse({ message: "Análisis no encontrado", status: 404, code: "job_not_found" });
  }

  const segments = job.segments_total ? await repo.listSegments(job.id) : [];
  let encode: { bunnyStatus: number | null; encodeProgressPct: number | null } | null = null;
  if (job.status === "awaiting_encode") {
    const bunny = await readBunnyVideo(job);
    encode = bunny
      ? {
          bunnyStatus: Number.isFinite(bunny.status) ? bunny.status : null,
          encodeProgressPct:
            bunny.encodeProgress !== null ? Math.max(0, Math.min(100, Math.round(bunny.encodeProgress))) : null,
        }
      : { bunnyStatus: job.bunny_status, encodeProgressPct: null };
  } else if (job.bunny_status !== null) {
    encode = { bunnyStatus: job.bunny_status, encodeProgressPct: null };
  }
  const playback = await playbackEmbed(job.bunny_video_id);
  return successResponse(buildStatusView({ job, segments, encode, playback }));
});
