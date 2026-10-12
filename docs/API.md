# VITAS API — Documentacion de Endpoints

Base URL: `https://futuro-club.vercel.app/api`

Todos los endpoints son Vercel Edge Functions (excepto los marcados como Node.js).

---

## Upload

### POST `/api/upload/image`
Sube una imagen a Bunny CDN Storage. Requiere sesión.
- **Body:** los bytes de la imagen (no multipart), máx. 10 MB en el servidor. El tipo se decide por el contenido: solo JPEG, PNG, WebP o GIF (otro → 415). Un `Content-Type` que no sea una de esas 4 imágenes (ni `application/octet-stream`) → 415.
- **Query:** `path` obligatorio. Solo se admite `players/{playerId}/avatar[.ext]` (la extensión se ignora), y solo si el usuario es el dueño del jugador (si no → 403). Sin `path` o con cualquier otra ruta → 400.
- **Ruta final (la decide el servidor):** `players/{playerId}/avatar-{uuid}.{ext}`, con la extensión del tipo real.
- **Respuesta:** `{ success: true, data: { url, path, size, contentType } }`

### POST `/api/upload/video-init`
Inicializa upload de video a Bunny Stream (genera firma TUS).
- **Body:** `{ title: string, playerId?: string, collection?: string }`
- **Respuesta:** `{ success: true, data: { videoId, libraryId, uploadUrl, authSignature, authExpire, title, cdnHostname } }`

---

## Videos

### GET `/api/videos/list`
Lista videos de Bunny Stream con paginacion.
- **Query:** `page` (default 1), `perPage` (default 20, max 100), `playerId?`, `search?`
- **Respuesta:** `{ success: true, data: { items, totalItems, currentPage, totalPages } }`

### GET `/api/videos/[id]/status`
Estado de encoding de un video.
- **Respuesta:** `{ success: true, data: { id, title, status, encodeProgress, isReady, duration, thumbnailUrl, streamUrl } }`

### DELETE `/api/videos/[id]/delete`
Elimina un video de Bunny Stream.
- **Respuesta:** `{ success: true, deletedId: string }`

---

## Pipeline

### POST `/api/pipeline/start`
Pipeline principal: analiza video con Claude para rendimiento de jugador.
- **Body:** `{ videoId: string, playerId: string, analysisMode?: string }`
- **Respuesta:** `{ success: true, report: object, pipelineMeta: object }`

---

## Agentes IA

### POST `/api/agents/phv-calculator`
Calcula Peak Height Velocity (maduracion biologica).
- **Body:** `{ playerId: string, chronologicalAge: number, height?, weight?, sitingHeight?, legLength? }`
- **Respuesta:** `{ success: true, data: { offset, category, phvStatus, adjustedVSI, recommendation, confidence } }` (la edad estimada del estirón se deriva como `ageAtPHV = chronologicalAge − offset`)

### POST `/api/agents/scout-insight`
Genera insights de scouting para un jugador.
- **Body:** `{ player: { id, name, age, position, vsi, ... }, context: string }`
- **Respuesta:** `{ success: true, data: { playerId, type, headline, body, metric, urgency, tags } }`

### POST `/api/agents/role-profile`
Construye perfil tactico del jugador.
- **Body:** `{ player: { id, name, ... }, metrics, position }`
- **Respuesta:** `{ success: true, data: { playerId, role, capabilities, confidence, identity } }`

### POST `/api/agents/tactical-label`
Asigna etiquetas tacticas a detecciones en frames de video.
- **Body:** `{ frameId: string, detections: array }`
- **Respuesta:** `{ success: true, data: { frameId, labels: array } }`

### POST `/api/agents/player-similarity`
Encuentra jugadores profesionales similares (coseno, determinista).
- **Body:** `{ metrics: { speed, shooting, vision, technique, defending, stamina }, position, options? }`
- **Respuesta:** `{ success: true, top5: array, bestMatch: object, avgScore, dominantGroup, source }`

### POST `/api/agents/video-observation` *(Node.js runtime)*
Observacion detallada de video con Gemini.
- **Body:** `{ videoBase64: string, mediaType?: string, playerContext: object }`
- **Respuesta:** `{ observations: { timeline, dimensiones, momentosDestacados, patronesJuego } }`

### POST `/api/agents/video-intelligence`
Reporte de inteligencia de video con Claude (SSE stream).
- **Body:** `{ playerContext, keyframes, videoId, playerId, vsiMetrics, geminiObservations, ... }`
- **Respuesta:** Stream SSE con eventos `progress`, `error`, `complete`

### POST `/api/agents/team-observation` *(Node.js runtime)*
Observacion tactica de equipo con Gemini.
- **Body:** `{ videoBase64: string, mediaType?: string, teamContext: object }`
- **Respuesta:** `{ observations: { formacionDetectada, posesionEstimada, fasesJuego } }`

### POST `/api/agents/team-intelligence`
Reporte de inteligencia de equipo con Claude (SSE stream).
- **Body:** `{ teamContext, geminiObservations, keyframes, videoId, yoloTrackData }`
- **Respuesta:** Stream SSE con TeamIntelligenceOutput

---

## RAG (Knowledge Base)

### POST `/api/rag/embed`
Genera embeddings con Voyage AI (voyage-3, 1024 dims).
- **Body:** `{ texts: string[], inputType?: "document" | "query" }`
- **Respuesta:** `{ success: true, embeddings: (number[] | null)[], model, tokenCount? }`

### POST `/api/rag/ingest`
Indexa documentos en knowledge_base con embeddings opcionales.
- **Body:** `{ content: string, category: "drill" | "pro_player" | "report" | "methodology" | "scouting", metadata?, player_id? }`
- **Respuesta:** `{ success: true, indexed: number, errors: string[] }`

### POST `/api/rag/query`
Busqueda semantica en knowledge base (vector + full-text fallback).
- **Body:** `{ query: string, category?: string, player_id?: string, limit?: number }`
- **Respuesta:** `{ success: true, context: string, results: array, usedEmbeddings: boolean }`

### POST `/api/rag/seed` *(Protegido)*
Indexa libreria de drills en knowledge base.
- **Respuesta:** `{ success: true, totalDrills, indexed, errors, batches }`

### POST `/api/rag/seed-knowledge` *(Protegido)*
Indexa documentos de metodologia, scouting, tacticas y benchmarks.
- **Respuesta:** `{ success: true, totalDocs, indexed, errors, categories }`

---

## Jugadores

### GET `/api/players/search`
Busca jugadores en tabla players_indexed (StatsBomb/FBref).
- **Query:** `q` (nombre), `position?`, `league?`, `limit?` (default 20, max 50)
- **Respuesta:** `{ players: array, total: number }`

---

## Tracking

### POST `/api/tracking/save` *(Requiere auth)*
Guarda sesion de tracking YOLO en Supabase.
- **Body:** `{ playerId?, videoId?, targetTrackId?, durationMs?, metrics?, scanEvents?, duelEvents? }`
- **Respuesta:** `{ success: true, id: string }`

---

## Deteccion (Roboflow)

### POST `/api/roboflow/analyze`
Envia imagen a modelo YOLO de Roboflow para deteccion.
- **Body:** `{ type: "url" | "base64", imageUrl? | imageBase64?, confidence?, overlap? }`
- **Respuesta:** `{ success: true, data: { detections, summary: { totalDetections, players, balls } } }`

---

## Fixtures

### GET `/api/fixtures/live`
Proxy Football-Data.org: partidos en vivo y proximos.
- **Respuesta:** Array de `{ id, homeTeam, awayTeam, score, minute, status }`

---

## Equipo

### POST `/api/team/invite`
Crea invitacion de equipo y envia email.
- **Body:** `{ email: string, role: "scout" | "coach" | "viewer" }`
- **Respuesta:** `{ success: true }`

### POST `/api/team/accept`
Acepta invitacion por token.
- **Body:** `{ token: string }`
- **Respuesta:** `{ success: true, role, orgOwnerId }`

---

## Notificaciones

### POST `/api/notifications/subscribe`
Guarda subscripcion push.
- **Body:** `{ subscription: { endpoint, keys: { p256dh, auth } } }`
- **Respuesta:** `{ success: true }`

### DELETE `/api/notifications/subscribe`
Elimina subscripcion push.
- **Body:** `{ endpoint: string }`
- **Respuesta:** `{ success: true }`

### GET `/api/notifications/cron` *(Node.js, protegido)*
Cron diario (09:00 UTC): envia push notifications.
- **Respuesta:** `{ success: true, notifications, sent, failed }`

---

## Stripe (Pagos)

### POST `/api/stripe/checkout`
Crea sesion de Stripe Checkout.
- **Body:** `{ priceId: string, email: string, successUrl?, cancelUrl? }`
- **Respuesta:** `{ url: string }`

### POST `/api/stripe/portal`
Crea sesion de Customer Portal.
- **Body:** `{ returnUrl?: string }`
- **Respuesta:** `{ url: string }`

### POST `/api/stripe/webhook`
Procesa eventos de Stripe (checkout.session.completed, subscription.updated/deleted).
- **Respuesta:** `{ received: true }`

---

## Sistema

### GET `/api/audit` *(Protegido por CRON_SECRET)*
Health check del backend.
- **Headers:** `x-audit-secret` o query `?secret=`
- **Respuesta:** `{ timestamp, environment, overall: "ok" | "warning" | "error", checks, agentEndpoints }`

---

## Autenticacion

Los endpoints que requieren auth usan JWT de Supabase en header `Authorization: Bearer <token>`.

Endpoints protegidos por CRON_SECRET: `/api/audit`, `/api/rag/seed`, `/api/rag/seed-knowledge`, `/api/notifications/cron`.

## Rate Limiting

Los endpoints de agentes IA incluyen rate limiting (30 req/min por IP) con headers estandar:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
