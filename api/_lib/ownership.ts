/**
 * VITAS · Ownership guards (autorización a nivel de objeto)
 *
 * withHandler({ requireAuth }) solo garantiza que hay un USUARIO válido, NO que
 * ese usuario sea dueño del recurso pedido. Como toda la API consulta Supabase
 * con SERVICE_ROLE_KEY (que salta RLS), el check de propiedad DEBE hacerse aquí.
 *
 * MODELO DE PROPIEDAD: SOLO EL DUEÑO (decisión del 30 sep 2026).
 *   · Los datos de un JUGADOR solo los ve y cambia su dueño: players.user_id.
 *   · Una fila atada a un jugador (análisis, vídeo, informe…) la ve además quien
 *     la creó (su columna user_id), como ya hacían las políticas RLS de dueño
 *     (000/038). Escribir sobre el jugador exige ser su dueño.
 *   · Lo que no está atado a un jugador (vídeo de equipo, job de partido
 *     completo) solo lo ve quien lo creó (user_id).
 *   · NO hay rama por TENANT ni por organización. El tenant_id compartido de
 *     producción (los 3 jugadores tienen el MISMO valor, que no es ni un usuario
 *     ni una organización) no identifica a nadie: con la regla antigua
 *     «dueño o su tenant» cualquier usuario con ese tenant en su JWT veía y
 *     escribía los datos de TODOS esos menores.
 *   · Las llamadas de servicio (isServiceCall: Modal, crons, orquestador) NO
 *     pasan por aquí: los handlers las dejan pasar antes, igual que hasta ahora.
 * Quién lo decidió y cómo revisarlo: docs/pendientes-metricas.md y la cabecera de
 * supabase/migrations/076_owner_only_player_access.sql. Compartir con un club
 * se reactivará más adelante, de forma explícita (directores + aprobación de
 * acceso), cambiando ESTE fichero y public.caller_manages_player (076) a la vez.
 *
 * Uso en un handler:
 *   if (!isServiceCall && !(await ownsPlayer(playerId, userId))) {
 *     return errorResponse("No autorizado para este jugador", 403, "FORBIDDEN");
 *   }
 */

function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function serviceHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/**
 * ¿El jugador `playerId` pertenece al usuario `userId`? (players.user_id)
 * Fail-closed: ante cualquier duda (sin Supabase, query no-ok, error) → false.
 *
 * Espejo en SQL (la base de datos no puede llamar a este código):
 * public.caller_manages_player (migración 073: políticas RLS de behavioral_profiles,
 * attendance_records, engagement_snapshots, wellbeing_questionnaires y
 * dropout_risk_assessments) y public.dsar_caller_manages_player (migración 076).
 * Regla: SOLO el dueño (players.user_id = auth.uid()), sin rama por tenant ni por
 * organización (decisión del 30 sep 2026, registrada en las cabeceras de la 073 y
 * la 076). Si cambia esta regla, cambiar también esas funciones con una migración
 * nueva (invariante #7).
 */
export async function ownsPlayer(playerId: string | null | undefined, userId: string | null): Promise<boolean> {
  if (!playerId || !userId) return false;
  const env = supabaseEnv();
  if (!env) return false;
  try {
    const res = await fetch(
      `${env.url}/rest/v1/players?id=eq.${encodeURIComponent(playerId)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      { headers: serviceHeaders(env.key) },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * ¿Puede el usuario LEER esta fila atada (o no) a un jugador?
 * Quien la creó (row.user_id) o el dueño de su jugador (row.player_id →
 * players.user_id). Sin creador ni jugador → false. Es la regla de lectura de
 * análisis (reports/share) y de vídeos (ownsVideo). Nunca por tenant.
 * Fail-closed.
 */
export async function ownsRowOrItsPlayer(
  row: { user_id?: string | null; player_id?: string | null } | null | undefined,
  userId: string | null,
): Promise<boolean> {
  if (!row || !userId) return false;
  if (row.user_id && row.user_id === userId) return true;
  if (row.player_id) return await ownsPlayer(row.player_id, userId);
  return false;
}

/**
 * ¿El usuario es dueño de este VÍDEO? Fail-closed. Una sola implementación
 * (invariante #7) que comparten finalize/identify-player/candidates/match start —
 * todos mutan/leen la MISMA fila `videos` con service_role (saltando RLS).
 * Autoriza por: service-call (server-to-server), uploader (videos.user_id) o el
 * dueño del jugador EXISTENTE del vídeo (players.user_id). Sin ninguno → false.
 */
export async function ownsVideo(
  video: { user_id?: string | null; player_id?: string | null },
  userId: string | null,
  isServiceCall = false,
): Promise<boolean> {
  if (isServiceCall) return true;
  return await ownsRowOrItsPlayer(video, userId);
}

/**
 * ¿El usuario puede ver/gestionar este job de partido (`match_analyses`)?
 * Predicado PURO sobre la fila ya cargada con service role — el MISMO que la política
 * RLS match_analyses_select_owner_076 (migración 076): solo su creador (user_id).
 * El job es de nivel de equipo (no está atado a un jugador). NO confundir con
 * `ownsMatch` (tabla `analyses`). Fail-closed: sin userId → false.
 */
export function ownsMatchAnalysis(
  job: { user_id?: string | null } | null | undefined,
  userId: string | null,
): boolean {
  if (!job || !userId) return false;
  return !!job.user_id && job.user_id === userId;
}

/**
 * ¿La sesión de entrenamiento `sessionId` pertenece al coach `userId`?
 * (training_sessions.coach_id — se persiste en api/coaching/_analyze-session.ts)
 * Fail-closed.
 */
export async function ownsSession(sessionId: string | null | undefined, userId: string | null): Promise<boolean> {
  if (!sessionId || !userId) return false;
  const env = supabaseEnv();
  if (!env) return false;
  try {
    const res = await fetch(
      `${env.url}/rest/v1/training_sessions?id=eq.${encodeURIComponent(sessionId)}&coach_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      { headers: serviceHeaders(env.key) },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * ¿El partido táctico `matchId` es del usuario `userId`?
 *
 * En el flujo real no existe tabla `matches`: `match_id == analyses.id`. La
 * propiedad se deriva de ESA analysis con la misma regla que el resto de análisis
 * (ownsRowOrItsPlayer): quien la creó o el dueño de su jugador. El pipeline de
 * vídeo (bunny-uploaded) crea el análisis con user_id NULL pero con player_id, así
 * que el dueño real entra por players.user_id. Mismo predicado que las políticas
 * tácticas de la migración 076. Nunca por tenant.
 *
 * Fail-closed: sin userId, sin Supabase, query no-ok o error, o matchId que no es
 * una analysis (p.ej. match demo `demo-*`, que ni siquiera es un UUID válido) →
 * false. Un match sin analysis asociada no es de nadie.
 *
 * NO llamar en llamadas de servicio (isServiceCall): la cadena interna
 * (compute-from-video / modal-callback) opera con token de servicio y omite este
 * check.
 */
export async function ownsMatch(matchId: string | null | undefined, userId: string | null): Promise<boolean> {
  if (!matchId || !userId) return false;
  const env = supabaseEnv();
  if (!env) return false;
  try {
    const res = await fetch(
      `${env.url}/rest/v1/analyses?id=eq.${encodeURIComponent(matchId)}&select=user_id,player_id&limit=1`,
      { headers: serviceHeaders(env.key) },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ user_id: string | null; player_id: string | null }>;
    return await ownsRowOrItsPlayer(rows[0], userId);
  } catch {
    return false;
  }
}

/**
 * Ids de los jugadores del usuario (players.user_id). Para consultas multi-fila
 * que deben quedarse en SUS jugadores (listados, borrado de cuenta). Fail-closed:
 * sin userId, sin Supabase o ante error → [] (no abre nada).
 */
export async function ownedPlayerIds(userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const env = supabaseEnv();
  if (!env) return [];
  try {
    const res = await fetch(
      `${env.url}/rest/v1/players?user_id=eq.${encodeURIComponent(userId)}&select=id`,
      { headers: serviceHeaders(env.key) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ id: string | null }>;
    return rows.map((r) => r.id).filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

/**
 * ¿El usuario `userId` puede ver datos del equipo `teamId`?
 * No existe tabla `teams` en el esquema — `training_sessions.team_id` es un
 * soft-ref (UUID sin FK). El único vínculo usuario↔equipo es ser coach de al
 * menos una sesión de ese equipo (training_sessions.coach_id), que es además
 * lo que exige la RLS de la tabla. Fail-closed.
 */
export async function ownsTeam(teamId: string | null | undefined, userId: string | null): Promise<boolean> {
  if (!teamId || !userId) return false;
  const env = supabaseEnv();
  if (!env) return false;
  try {
    const res = await fetch(
      `${env.url}/rest/v1/training_sessions?team_id=eq.${encodeURIComponent(teamId)}&coach_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      { headers: serviceHeaders(env.key) },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}
