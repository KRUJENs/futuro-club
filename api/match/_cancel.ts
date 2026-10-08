/**
 * VITAS · POST /api/match/cancel — el dueño cancela un job no terminal
 *
 * → cancelled; se libera la reserva, los tramos abiertos pasan a skipped (los hechos se
 * conservan) y se borra el fichero Gemini (el barrido del tick es el respaldo). El worker
 * se entera en su siguiente op (estado terminal / `stop`). Idempotente.
 */
import { withHandler } from "../_lib/withHandler";
import { errorResponse, successResponse } from "../_lib/apiResponse";
import { ownsMatchAnalysis } from "../_lib/ownership";
import { matchCancelRequestSchema, matchCancelResponseSchema } from "../../src/lib/shared/matchJob/contract";
import { cancelJob } from "../_lib/matchJob/driver";
import * as repo from "../_lib/matchJob/repo";

export default withHandler({ method: "POST", requireAuth: true, maxRequests: 20 }, async ({ body, userId }) => {
  const parsed = matchCancelRequestSchema.safeParse(body ?? {});
  if (!parsed.success) return errorResponse({ message: "jobId inválido", status: 400, code: "invalid_input" });
  const job = await repo.getJob(parsed.data.jobId);
  if (!job || !ownsMatchAnalysis(job, userId)) {
    return errorResponse({ message: "Análisis no encontrado", status: 404, code: "job_not_found" });
  }
  const after = await cancelJob(job);
  return successResponse(matchCancelResponseSchema.parse({ jobId: job.id, status: after?.status ?? job.status }));
});
