-- =====================================================================
-- 074 · ESCRIBIR datos de un jugador exige ser su DUEÑO
--        · guardas RESTRICTIVE de INSERT y UPDATE (TO authenticated) en 10 tablas
--        · regla única: public.caller_manages_player(text) de la 073 / 076
--          (players.user_id = auth.uid()); esta migración NO la redefine
-- =====================================================================
-- DECISIÓN (quién, cuándo, por qué, cómo revisarla) · la misma de la 073 y la 076
--   · Quién: el dueño del producto, el 30 sep 2026, delegó la elección en el
--     asistente («la que veas tú mejor»); el asistente (Claude) eligió SOLO EL DUEÑO.
--   · Regla: los datos de un jugador los escriben SOLO su dueño
--     (players.user_id = auth.uid()) y service_role (backend, Modal, crons).
--     Sin rama por tenant y sin rama por organización / membresía de club.
--   · Por qué: (1) son datos de menores (carga y fatiga → riesgo de lesión y de
--     abandono, planes de desarrollo, vídeos, análisis); (2) VERIFICADO en
--     producción (consultas de solo lectura del dueño, 29-30 sep): los 3 jugadores
--     comparten un único players.tenant_id que NO es un auth.users.id ni un
--     organizations.id, así que no se sabe qué agrupa; (3) la vía por organización
--     ya está rota en producción (user_org_ids/user_in_org usan
--     team_members.org_owner_id); (4) invariante #3: no dar acceso es válido.
--   · Cómo revisarla: compartir con un club/academia se reactivará más adelante,
--     de forma EXPLÍCITA, con el diseño del alta de cuentas (directores +
--     aprobación de acceso). Ese cambio toca a la vez api/_lib/ownership.ts y
--     public.caller_manages_player (migración nueva + simulación + comprobación
--     previa). Estas guardas usan ese helper, así que lo seguirán sin editarlas.
--     Registro: docs/pendientes-metricas.md (§B, «Escrituras solo del dueño · 074»).
--
-- QUÉ CIERRA (clase de defecto: la política de ESCRITURA de cliente solo mira la
-- columna del AUTOR y deja libre player_id; el servidor luego lee por player_id
-- con service_role y mezcla esas filas con las del dueño real)
--   VERIFICADO leyendo el repositorio (fichero:línea):
--   · fatigue_sessions: INSERT WITH CHECK (auth.uid() = user_id) (043:57-59) y
--     UPDATE USING (auth.uid() = user_id) sin WITH CHECK (043:61-63); player_id
--     libre (043:12). Lectores con service_role por player_id: orquestador
--     (api/agents/_pipeline-orchestrator.ts:580-586 → ACWR/fatiga → riesgo de
--     lesión :656-676) y riesgo de abandono (api/_lib/dropoutAssessment.ts:65, lo
--     usan /api/wellbeing/dropout-risk y el email mensual al director). Ningún
--     escritor en el código: el navegador llama a /api/tracking/fatigue-session
--     (playerTrackingService.ts:142), ruta que NO existe (api/tracking/[action].ts
--     solo enruta save e history) ⇒ las filas solo pueden llegar por PostgREST
--     directo con el JWT de un usuario.
--   · development_plans: idp_plans_coach_write FOR ALL con coach_id = auth.uid()
--     (047:168-171); idp_goals / idp_milestones / idp_checkins heredan por
--     p.coach_id (047:173-195). /api/idp/get-plan devuelve con service_role el
--     plan más reciente por jugador y mes (api/idp/_get-plan.ts:200-215): el dueño
--     vería un plan plantado por otra cuenta; el índice único
--     uq_idp_player_month_active (047:46-48) además le impediría crear el suyo ese
--     mes. El navegador escribe estas 4 tablas directamente
--     (src/services/real/idpService.ts:390-419, 443, 466-468, 490-492, 522-529).
--     La 076 ya cambió sus políticas PERMISSIVE a solo dueño EN EL REPOSITORIO;
--     estas guardas cierran la escritura de no dueños TAMBIÉN si la 076 aún no
--     está aplicada (no verificado en producción) y sin depender del orden.
--   · tracking_sessions: FOR ALL auth.uid() = user_id (009:25-29) e INSERT
--     user_id = auth.uid() AND org (038:152-156). Lectores por player_id:
--     api/tracking/_history.ts:41-46 (historial del dueño) y la DSAR
--     dsar_export_player_data (072:332-333).
--   · player_analyses: FOR ALL auth.uid() = user_id (000:110-111) e INSERT
--     user_id = auth.uid() AND org (038:135-139). Lectores por player_id:
--     api/scout/generate.ts:353 (insights del dueño, sin filtrar autor) y la DSAR
--     (072:329).
--   · videos: FOR ALL auth.uid() = user_id (000:35-36, 001:69-72), INSERT
--     (038:112-116) y UPDATE (038:118-122) sin mirar player_id. El dueño ve un
--     vídeo ajeno colgado de su jugador (videos_select_owner_076, 076:236-239) y la
--     DSAR lo exporta (072:331). Ya anotado como residuo (6) de la 076.
--   · live_events: FOR ALL auth.uid() = user_id (032:114-115), player_id con FK a
--     players (032:60).
--   · scout_insights: UPDATE USING (user_id = auth.uid()) sin WITH CHECK
--     (016:46-48): el autor puede re-apuntar su insight a cualquier player_id.
--   Control positivo de la búsqueda: el lint del repositorio
--   (src/test/migrations/074_rls_player_write_ownership.test.ts) encuentra estas
--   10 tablas sin la 074 y sin la 076; con la 076 y sin la 074, las 6 que no son
--   de planes IDP; con la 074, ninguna (solo quedan las EXCLUIDAS de abajo).
--
-- MISMA CLASE, NO INCLUIDAS (el arreglo no es el mismo; quedan en docs §B):
--   · tracking_jobs (tracking_jobs_insert, 052:85-87): lo arregla el PR #308
--     (consentimiento de clips). Esta migración NO lo toca.
--   · match_events («Users manage their own events», 004:22-25): player_id sin
--     FK; el registro en directo del navegador manda eventos de los dos equipos
--     (team home/away, liveMatchService.ts:67-80, 207-219) ⇒ «dueño del jugador»
--     no es obviamente la regla (DEDUCIDO; no verificado qué playerId pone la UI
--     en los eventos del rival). Según el esquema del repo esa escritura además no
--     casa con la 004 (columnas que no existen, sin user_id NOT NULL).
--   · player_session_metrics («Access via session ownership», 044:99-106): la
--     propiedad es de la SESIÓN (training_sessions.coach_id); player_id sin FK y el
--     navegador lo escribe con jugadores de la sesión (coachingSessionService.ts:253).
--   · Ramas por ORGANIZACIÓN (players, videos, player_analyses, tracking_sessions,
--     evaluation_history, player_knowledge: 027/038/039): otra clase (pendiente
--     de la 076, residuo (2)). Las guardas de la 074 sí limitan sus ESCRITURAS a
--     filas de jugadores del propio llamador en las 10 tablas de aquí.
--
-- POR QUÉ RESTRICTIVE (y no reescribir las PERMISSIVE)
--   · PostgreSQL combina las RESTRICTIVE con AND: da igual qué PERMISSIVE haya
--     (las de 043/047/000/038, las *_076, una creada a mano o re-creada por un
--     script de supabase/pending/): ninguna escritura de cliente deja una fila de
--     un jugador que el llamador no gestiona. SIMULADO (PGlite, 18.3 y 16.4).
--   · No duplica ni pisa la 076 (no se redefine ninguna PERMISSIVE): la 074 y la
--     076 se aplican en cualquier orden y quedan igual.
--   · Solo INSERT y UPDATE, solo WITH CHECK (la fila NUEVA): el autor de una fila
--     antigua de otro jugador puede desligarla (player_id NULL o un jugador suyo),
--     pero no tocarla dejándola en ese jugador ni crear otras. LECTURA y DELETE no
--     cambian (la lectura por tenant la cierra la 076).
--   · TO authenticated (como la 073 y la 076). anon no tiene vía de escritura en
--     estas tablas por políticas de autor (auth.uid() es NULL); las comprobaciones
--     enseñan sus privilegios de tabla.
--   · service_role tiene BYPASSRLS: backend, crons y el callback de Modal
--     (api/webhooks/modal-tracking.ts, con la service key de
--     api/_lib/supabaseRest.ts:19-23; escribe tracking_jobs, que la 074 no toca)
--     no cambian.
--
-- ESTADO DE LA EVIDENCIA (léelo antes de aplicar)
-- VERIFICADO EN PRODUCCIÓN (consultas de solo lectura del dueño, 29-30 sep 2026):
--   · players: 3 filas, todas con el MISMO tenant_id, que no es un usuario ni una
--     organización; ninguna con fecha de nacimiento.
--   · Aplicadas: 045-049, 050, 051, 052, 054, 057, 060-064, 066, 067, 069, 070,
--     071, 072, el script de emergencia anon y el script provisional 03 (DSAR).
-- NO VERIFICADO (no se ha consultado la base de producción para esto):
--   · Si la 073 o la 076 están aplicadas (el dueño no ha mandado sus salidas).
--     Sin el helper, esta migración ABORTA sin cambiar nada (sección 0).
--   · Si existen y cómo están 000/001/009/016/032/038/043 (fatigue_sessions,
--     tracking_sessions, scout_insights, live_events…): todo va con to_regclass.
--   · Si esas tablas tienen RLS activada. Si alguna existe SIN RLS, esta migración
--     ABORTA (no la activa: activarla cambiaría también las LECTURAS); la
--     comprobación previa lo cuenta (fila 5).
--   · Cuántas filas «de autor no dueño» hay (residuo de antes): lo cuenta la
--     previa, filas 20-29. Esta migración NO toca datos; limpiar es decisión del dueño.
-- SIMULACIÓN PGlite (NO es la base real; script y salida en el PR): 188
-- comprobaciones, todas OK, en PostgreSQL 18.3 (PGlite 0.5.8) y en 16.4 (PGlite
-- 0.2.17), con la forma verificada de producción (3 jugadores del dueño A con un
-- tenant compartido, + 1 jugador de otra cuenta B para las pruebas):
--   · ANTES, con 073 + 076: B (mismo tenant) inserta o re-apunta filas de un
--     jugador de A en fatiga, tracking, análisis, vídeos, eventos en directo e
--     insights; sin la 076, también crea un plan IDP para el jugador de A y escribe
--     objetivos / hitos / revisiones en el plan de A; C (otro tenant) crea el plan.
--   · DESPUÉS: 42501 (o 0 filas) en todas, para B y para C. El dueño A hace las
--     MISMAS 16 operaciones del navegador y de video-init (upsert con RETURNING,
--     update, delete, upsert de vídeo sin la columna player_id) con el mismo
--     resultado que antes; B sigue escribiendo lo suyo y puede desligar su fila
--     antigua; service_role igual; anon no escribe.
--   · La 074 solo añade las 20 guardas (instantánea de funciones, permisos, vistas
--     y políticas: ningún otro cambio). 073_comprobacion y 076_posterior siguen
--     en verde. Orden 073 → 076 → 074, 073 → 074 → 076 y la cadena completa del
--     repo: mismo resultado. Dos veces: mismo estado. Sin helper, con helper por
--     tenant o con una de las tablas sin RLS: aborta y la base queda igual. Base
--     vacía: aborta; las comprobaciones no fallan. Tablas que no existen: se saltan.
--   · Control negativo: la misma migración con las guardas PERMISSIVE da 48 fallos.
--
-- QUÉ NO TOCA: PHV ni bio-banding (invariante #4); ninguna función (tampoco el
-- helper), vista, dato, permiso de tabla ni política PERMISSIVE existente; no
-- activa RLS; tracking_jobs (PR #308); Modal ni su contrato.
--
-- ORDEN DE DESPLIEGUE Y DEL OPERADOR
--   · El código del PR (comprobación de propiedad en /api/idp/approve-plan,
--     checkin, update-goal y update-milestone) se despliega al fusionar y NO
--     depende de esta migración (usa service_role + ownsPlayer).
--   · 1) Antes, la 076 (o la 073) aplicada y su comprobación posterior en verde.
--     2) supabase/checks/074_previa.sql (solo lectura): ninguna fila «BLOQUEA» con
--     ok = false; mandar el resultado COMPLETO. 3) esta migración. 4)
--     supabase/checks/074_posterior.sql: ok = true en todas las filas con ok.
--   · Idempotente: se puede ejecutar varias veces y deja el mismo estado.
--   · Si después se aplicara una versión de la 073 con rama por tenant, las guardas
--     la heredarían (usan el helper): la posterior de la 074 (fila 1) y la de la
--     076 lo detectan; volver a ejecutar la 076.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 0) Guardas previas · cualquier fallo ABORTA toda la transacción (la base
--    queda exactamente como estaba). Si aborta: manda el mensaje completo.
-- =====================================================================
DO $guard$
DECLARE
  v_fn   regprocedure := to_regprocedure('public.caller_manages_player(text)');
  v_def  boolean;
  v_src  text;
  v_bad  text;
BEGIN
  IF to_regclass('public.players') IS NULL THEN
    RAISE EXCEPTION '074: public.players no existe; no se aplica nada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.players') AND attname = 'user_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '074: public.players no tiene user_id (el dueño); no se aplica nada';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '074: auth.uid() no existe; no se aplica nada';
  END IF;

  -- El helper lo crean la 073 y la 076 (solo dueño). La 074 lo REUTILIZA.
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '074: falta public.caller_manages_player(text). Aplica antes la 076 (o la 073) y su comprobación posterior; no se aplica nada';
  END IF;
  SELECT p.prosecdef, p.prosrc INTO v_def, v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF v_def
     OR v_src ~* '(tenant|org|team_member)'
     OR v_src !~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)' THEN
    RAISE EXCEPTION '074: public.caller_manages_player no es el helper SOLO DUEÑO de la 073/076 (SECURITY DEFINER, rama por tenant/organización o sin players.user_id = auth.uid()). Vuelve a aplicar la 076; no se aplica nada';
  END IF;

  -- Tablas de la 074 que existen pero SIN RLS activada: las guardas no harían
  -- nada y activarla cambiaría también las LECTURAS. No se activa aquí.
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_bad
    FROM unnest(ARRAY['fatigue_sessions', 'development_plans', 'idp_goals', 'idp_milestones', 'idp_checkins',
                      'tracking_sessions', 'player_analyses', 'videos', 'live_events', 'scout_insights']) t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
   WHERE NOT c.relrowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '074: tablas SIN RLS activada: % (la 074 no la activa: cambiaría también quién LEE). Manda la comprobación previa; no se aplica nada', v_bad;
  END IF;

  -- Columnas que usan las guardas (solo en las tablas que existen).
  SELECT string_agg(x.t || '.' || x.c, ', ' ORDER BY x.t, x.c) INTO v_bad
    FROM (VALUES ('fatigue_sessions', 'player_id'), ('development_plans', 'id'), ('development_plans', 'player_id'),
                 ('idp_goals', 'plan_id'), ('idp_milestones', 'plan_id'), ('idp_checkins', 'plan_id'),
                 ('tracking_sessions', 'player_id'), ('player_analyses', 'player_id'), ('videos', 'player_id'),
                 ('live_events', 'player_id'), ('scout_insights', 'player_id')) x(t, c)
   WHERE to_regclass('public.' || x.t) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = to_regclass('public.' || x.t) AND a.attname = x.c AND NOT a.attisdropped);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '074: faltan columnas que usan las guardas: %. Manda la comprobación previa; no se aplica nada', v_bad;
  END IF;
  IF to_regclass('public.development_plans') IS NULL
     AND (to_regclass('public.idp_goals') IS NOT NULL OR to_regclass('public.idp_milestones') IS NOT NULL
          OR to_regclass('public.idp_checkins') IS NOT NULL) THEN
    RAISE EXCEPTION '074: existen tablas idp_* sin development_plans; no se aplica nada';
  END IF;
END $guard$;

-- =====================================================================
-- 1) Guardas de escritura RESTRICTIVE. Una tabla que no existe se salta con
--    NOTICE. Cada guarda se borra antes de crearla (re-ejecutable).
--    Jugador directo:   player_id IS NULL OR caller_manages_player(player_id)
--    Hijas de un plan:  el jugador del plan (development_plans.player_id)
-- =====================================================================
DO $pol$
BEGIN
  -- ── fatigue_sessions (043) ─────────────────────────────────────────────
  IF to_regclass('public.fatigue_sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS "fatigue_sessions_insert_requires_owner_074" ON public.fatigue_sessions;
    DROP POLICY IF EXISTS "fatigue_sessions_update_requires_owner_074" ON public.fatigue_sessions;
    CREATE POLICY "fatigue_sessions_insert_requires_owner_074" ON public.fatigue_sessions
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "fatigue_sessions_update_requires_owner_074" ON public.fatigue_sessions
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: fatigue_sessions no existe: se salta';
  END IF;

  -- ── development_plans (047) ────────────────────────────────────────────
  IF to_regclass('public.development_plans') IS NOT NULL THEN
    DROP POLICY IF EXISTS "development_plans_insert_requires_owner_074" ON public.development_plans;
    DROP POLICY IF EXISTS "development_plans_update_requires_owner_074" ON public.development_plans;
    CREATE POLICY "development_plans_insert_requires_owner_074" ON public.development_plans
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "development_plans_update_requires_owner_074" ON public.development_plans
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: development_plans no existe (047 no aplicada): se salta';
  END IF;

  -- ── idp_goals / idp_milestones / idp_checkins (047): el jugador del plan ─
  IF to_regclass('public.idp_goals') IS NOT NULL THEN
    DROP POLICY IF EXISTS "idp_goals_insert_requires_owner_074" ON public.idp_goals;
    DROP POLICY IF EXISTS "idp_goals_update_requires_owner_074" ON public.idp_goals;
    CREATE POLICY "idp_goals_insert_requires_owner_074" ON public.idp_goals
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_goals.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
    CREATE POLICY "idp_goals_update_requires_owner_074" ON public.idp_goals
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_goals.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
  ELSE
    RAISE NOTICE '074: idp_goals no existe: se salta';
  END IF;

  IF to_regclass('public.idp_milestones') IS NOT NULL THEN
    DROP POLICY IF EXISTS "idp_milestones_insert_requires_owner_074" ON public.idp_milestones;
    DROP POLICY IF EXISTS "idp_milestones_update_requires_owner_074" ON public.idp_milestones;
    CREATE POLICY "idp_milestones_insert_requires_owner_074" ON public.idp_milestones
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_milestones.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
    CREATE POLICY "idp_milestones_update_requires_owner_074" ON public.idp_milestones
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_milestones.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
  ELSE
    RAISE NOTICE '074: idp_milestones no existe: se salta';
  END IF;

  IF to_regclass('public.idp_checkins') IS NOT NULL THEN
    DROP POLICY IF EXISTS "idp_checkins_insert_requires_owner_074" ON public.idp_checkins;
    DROP POLICY IF EXISTS "idp_checkins_update_requires_owner_074" ON public.idp_checkins;
    CREATE POLICY "idp_checkins_insert_requires_owner_074" ON public.idp_checkins
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_checkins.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
    CREATE POLICY "idp_checkins_update_requires_owner_074" ON public.idp_checkins
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                           WHERE d.id = idp_checkins.plan_id
                             AND public.caller_manages_player(d.player_id::text)));
  ELSE
    RAISE NOTICE '074: idp_checkins no existe: se salta';
  END IF;

  -- ── tracking_sessions (009 / 038) ──────────────────────────────────────
  IF to_regclass('public.tracking_sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS "tracking_sessions_insert_requires_owner_074" ON public.tracking_sessions;
    DROP POLICY IF EXISTS "tracking_sessions_update_requires_owner_074" ON public.tracking_sessions;
    CREATE POLICY "tracking_sessions_insert_requires_owner_074" ON public.tracking_sessions
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "tracking_sessions_update_requires_owner_074" ON public.tracking_sessions
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: tracking_sessions no existe: se salta';
  END IF;

  -- ── player_analyses (000 / 038) ────────────────────────────────────────
  IF to_regclass('public.player_analyses') IS NOT NULL THEN
    DROP POLICY IF EXISTS "player_analyses_insert_requires_owner_074" ON public.player_analyses;
    DROP POLICY IF EXISTS "player_analyses_update_requires_owner_074" ON public.player_analyses;
    CREATE POLICY "player_analyses_insert_requires_owner_074" ON public.player_analyses
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "player_analyses_update_requires_owner_074" ON public.player_analyses
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: player_analyses no existe: se salta';
  END IF;

  -- ── videos (000 / 001 / 038 / 076) ─────────────────────────────────────
  --    El navegador y /api/upload/video-init (con el JWT del usuario) ya solo
  --    mandan player_id de un jugador del propio usuario, o NULL, o no lo mandan
  --    (supabaseVideoService.ts:120-139 y :153-176; _video-init.ts:76-86, 116).
  IF to_regclass('public.videos') IS NOT NULL THEN
    DROP POLICY IF EXISTS "videos_insert_requires_owner_074" ON public.videos;
    DROP POLICY IF EXISTS "videos_update_requires_owner_074" ON public.videos;
    CREATE POLICY "videos_insert_requires_owner_074" ON public.videos
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "videos_update_requires_owner_074" ON public.videos
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: videos no existe: se salta';
  END IF;

  -- ── live_events (032) ──────────────────────────────────────────────────
  IF to_regclass('public.live_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS "live_events_insert_requires_owner_074" ON public.live_events;
    DROP POLICY IF EXISTS "live_events_update_requires_owner_074" ON public.live_events;
    CREATE POLICY "live_events_insert_requires_owner_074" ON public.live_events
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "live_events_update_requires_owner_074" ON public.live_events
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: live_events no existe: se salta';
  END IF;

  -- ── scout_insights (016) ───────────────────────────────────────────────
  IF to_regclass('public.scout_insights') IS NOT NULL THEN
    DROP POLICY IF EXISTS "scout_insights_insert_requires_owner_074" ON public.scout_insights;
    DROP POLICY IF EXISTS "scout_insights_update_requires_owner_074" ON public.scout_insights;
    CREATE POLICY "scout_insights_insert_requires_owner_074" ON public.scout_insights
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "scout_insights_update_requires_owner_074" ON public.scout_insights
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '074: scout_insights no existe: se salta';
  END IF;
END $pol$;

-- =====================================================================
-- 2) Guarda final · ABORTA todo si, en las tablas que existen, falta alguna
--    guarda o no quedó como se espera (RESTRICTIVE, TO authenticated, solo
--    WITH CHECK con el helper).
-- =====================================================================
DO $final$
DECLARE
  v_bad text;
  v_n   int;
BEGIN
  SELECT string_agg(e.t || '.' || c.cmd, ', ' ORDER BY e.t, c.cmd) INTO v_bad
    FROM unnest(ARRAY['fatigue_sessions', 'development_plans', 'idp_goals', 'idp_milestones', 'idp_checkins',
                      'tracking_sessions', 'player_analyses', 'videos', 'live_events', 'scout_insights']) e(t)
   CROSS JOIN (VALUES ('insert'), ('update')) c(cmd)
   WHERE to_regclass('public.' || e.t) IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = e.t
              AND p.policyname = e.t || '_' || c.cmd || '_requires_owner_074'
              AND p.permissive = 'RESTRICTIVE'
              AND p.cmd = upper(c.cmd)
              AND p.roles = ARRAY['authenticated']::name[]
              AND p.qual IS NULL
              AND p.with_check LIKE '%caller_manages_player(%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '074: guardas que no quedaron como se espera: % (no se aplica nada; mándalo)', v_bad;
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND policyname LIKE '%\_074' ESCAPE '\';
  RAISE NOTICE '074: comprobación final OK: % guarda(s) RESTRICTIVE de escritura (2 por tabla existente)', v_n;
END $final$;

COMMIT;
