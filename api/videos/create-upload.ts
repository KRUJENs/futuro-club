/**
 * VITAS · Create Bunny Upload
 * POST /api/videos/create-upload
 *
 * Crea un vídeo "vacío" en Bunny Stream y devuelve credenciales
 * firmadas para que el cliente pueda subir directamente con TUS protocol.
 *
 * Flujo:
 *   1. Cliente llama a este endpoint con metadata del vídeo
 *   2. Servidor crea video en Bunny (POST a Bunny API)
 *   3. Servidor crea row en `videos` table (status='uploading')
 *   4. Servidor devuelve { videoId, bunnyVideoId, uploadUrl, signature }
 *   5. Cliente sube directo a Bunny via TUS (no pasa por nuestro server)
 *   6. Tras subir, cliente llama /api/videos/finalize con el bunnyVideoId
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate): antes de
 * crear nada se exige la declaración del entrenador (`attestation`) y, si el jugador es
 * menor de 14 conocido, su consentimiento parental verificado. La declaración se guarda
 * con el id del vídeo ANTES de crear el vídeo en Bunny: si no se puede guardar, no se
 * crea nada (500 consent_check_failed).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import { randomHex } from "../_lib/edgeCrypto";
import { signTusUpload } from "../_lib/bunnyStream";
import { enforceClipConsent, clipConsentErrorResponse } from "../_lib/analysisConsentGate";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID ?? "";
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY ?? "";

const createUploadSchema = z.object({
  playerId: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  durationSec: z.number().positive().optional(),
  /** Declaración del entrenador `{ accepted: true, version }` (se valida en el gate). */
  attestation: z.unknown().optional(),
});

async function createBunnyVideo(title: string): Promise<{ guid: string; libraryId: number } | null> {
  if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) {
    console.error("[VITAS] BUNNY credentials not configured");
    return null;
  }

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
      {
        method: "POST",
        headers: {
          AccessKey: BUNNY_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ title }),
      }
    );

    if (!res.ok) {
      console.error(`[VITAS] Bunny createVideo failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return {
      guid: data.guid,
      libraryId: parseInt(BUNNY_LIBRARY_ID),
    };
  } catch (err) {
    console.error("[VITAS] Bunny API error:", err);
    return null;
  }
}

export default withHandler(
  { schema: createUploadSchema, requireAuth: true, maxRequests: 30 },
  async ({ body, userId, tenantId, isServiceCall, ip }) => {
    const input = body as z.infer<typeof createUploadSchema>;

    if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) {
      return errorResponse({
        code: "bunny_not_configured",
        message: "Bunny Stream no está configurado en el servidor",
        status: 503,
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Verificar player y obtener tenant_id
    const { data: player } = await supabase
      .from("players")
      .select("id, tenant_id, name")
      .eq("id", input.playerId)
      .single();

    if (!player) {
      return errorResponse({ code: "player_not_found", message: "Jugador no existe", status: 404 });
    }

    // Autorización a nivel de objeto: sin esto, cualquier autenticado adjuntaba una
    // subida a CUALQUIER jugador (coste Bunny + siembra un análisis vía el webhook
    // bunny-uploaded sobre un menor ajeno). Solo el DUEÑO del jugador (players.user_id,
    // 076), fail-closed; nunca por tenant. Se omite en llamadas de servicio.
    if (!isServiceCall && !(await ownsPlayer(input.playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No gestionas este jugador", status: 403 });
    }

    // Consentimiento + declaración guardada con el id del vídeo ANTES de crear nada.
    const videoId = `vid-${randomHex(8)}`;
    const consent = await enforceClipConsent({
      attestation: input.attestation,
      lookupStored: false, // vídeo nuevo: la declaración tiene que venir en ESTA petición
      resource: { type: "videos", id: videoId },
      playerId: input.playerId,
      actor: { userId, tenantId, ip },
      endpoint: "videos/create-upload",
      scope: "player",
    });
    if (!consent.allowed) return clipConsentErrorResponse(consent);

    // Crear vídeo en Bunny
    const bunnyVideo = await createBunnyVideo(`${input.title} · ${player.name}`);
    if (!bunnyVideo) {
      return errorResponse({
        code: "bunny_create_failed",
        message: "No se pudo crear el vídeo en Bunny",
        status: 502,
      });
    }

    // Crear row en `videos` table (id ya generado arriba: la declaración va ligada a él)
    const { data: video, error } = await supabase
      .from("videos")
      .insert({
        id: videoId,
        user_id: userId,                    // dueño del vídeo (finalize.ownsVideo lo usa)
        tenant_id: player.tenant_id,
        player_id: input.playerId,
        bunny_video_id: bunnyVideo.guid,
        duration_sec: input.durationSec ?? null,
      })
      .select()
      .single();

    if (error) {
      return errorResponse({ code: "video_create_failed", message: error.message, status: 500 });
    }

    // Firma TUS válida 24 h (helper compartido con video-init · inv #7)
    const { signature, expire: expirationSec } = await signTusUpload({
      libraryId: BUNNY_LIBRARY_ID,
      apiKey: BUNNY_API_KEY,
      videoGuid: bunnyVideo.guid,
    });

    return successResponse({
      videoId: video.id,
      bunnyVideoId: bunnyVideo.guid,
      libraryId: bunnyVideo.libraryId,
      tusUploadUrl: "https://video.bunnycdn.com/tusupload",
      authorizationSignature: signature,
      authorizationExpire: expirationSec,
    });
  }
);
