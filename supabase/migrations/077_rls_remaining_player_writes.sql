-- =====================================================================
-- 077 · Escrituras de cliente que quedaban sin mirar al DUEÑO del jugador
--        (P1 · bloque 1; las 3 tablas que la 074 dejó fuera)
--        · match_events y player_session_metrics: guardas RESTRICTIVE de INSERT y
--          UPDATE (TO authenticated) con la regla única public.caller_manages_player
--          (073/076, solo el dueño), igual que la 074
--        · tracking_jobs: SOLO del servidor (service_role), como parental_consents (075)
--        · anon: sin permisos de ESCRITURA de tabla ni de columna en las tablas de
--          datos de jugador (las 12 de la 074 + estas 3 + training_sessions)
-- =====================================================================
--
-- Por qué (DATO VERIFICADO en producción, consultas del owner):
--   · 13 oct, paso34 (solo lectura): las 4 tablas existen con RLS activada y 0 filas.
--     - match_events: «Users manage their own events» FOR ALL TO authenticated con
--       auth.uid() = user_id → mira al AUTOR, nunca al dueño del jugador: con sesión se
--       podía escribir un evento de CUALQUIER jugador (player_id libre).
--     - player_session_metrics: «Access via session ownership» FOR ALL TO public, solo
--       session_id ∈ sesiones del entrenador → métricas de cualquier player_id dentro
--       de una sesión propia.
--     - tracking_jobs: «tracking_jobs_insert» (user_id = auth.uid()) y
--       «tracking_jobs_select» con rama por ORGANIZACIÓN (user_org_ids()), contra la
--       decisión del 30 sep (solo el dueño).
--     - authenticated Y anon con SELECT·INSERT·UPDATE·DELETE de tabla en las 4.
--   · 13 oct, 074_previa fila 10: anon con INSERT·UPDATE de tabla en las 12 tablas de
--     la 074 (las políticas no le dejan pasar: auth.uid() es NULL; esto lo cierra del
--     todo, defensa en profundidad).
--
-- Quién escribe hoy (código de main, 13 oct):
--   · tracking_jobs: SOLO el servidor con service_role (api/coaching/_track-async.ts,
--     api/crons/rescue-tracking-jobs.ts, api/_lib/supabaseRest.ts). Ningún fichero de
--     src/ la lee ni la escribe → cerrarla al cliente no rompe nada.
--   · match_events: lo escribe el NAVEGADOR con su sesión
--     (src/services/real/liveMatchService.ts). La guarda solo exige que el jugador sea
--     del usuario; el dueño sigue escribiendo lo suyo. (Ese insert manda columnas que
--     no existen en producción —match_id/kind/team, sin user_id— y probablemente ya
--     falla: arreglo aparte, P2; 0 filas en producción.)
--   · player_session_metrics: la escribe el SERVIDOR con service_role
--     (api/coaching/_analyze-session.ts), con player_id = id de PISTA del tracking, no
--     de un jugador; service_role salta la RLS, así que la guarda no le afecta. El
--     método del navegador (coachingSessionService.saveMetric) no tiene llamadores. Si
--     un día el navegador guardara métricas de pistas anónimas, la guarda las
--     rechazaría (no son de un jugador propio): tendrían que ir por el servidor.
--
-- Qué NO toca: datos, PHV, funciones (el helper lo crean la 073/076), triggers, la
-- RLS (no la activa ni la desactiva: se exige activada), las LECTURAS de match_events,
-- player_session_metrics y training_sessions, ni los permisos de authenticated en
-- ellas (salvo tracking_jobs). service_role salta la RLS.
--
-- Orden: 1) 076 (o 073) y 074 aplicadas y verificadas (lo están desde el 9 y el 13 oct).
-- 2) supabase/checks/077_previa.sql: ninguna fila «BLOQUEA» con ok = false. 3) esta
-- migración. 4) supabase/checks/077_posterior.sql: ok = true en todas las filas con ok.
-- Idempotente. Transaccional: cualquier fallo deja la base como estaba.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 0) Guardas previas · cualquier fallo ABORTA toda la transacción.
-- =====================================================================
DO $guard$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.caller_manages_player(text)');
  v_def boolean;
  v_src text;
  v_bad text;
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION '077: faltan roles de Supabase (anon / authenticated / service_role); no se aplica nada';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '077: auth.uid() no existe; no se aplica nada';
  END IF;

  -- La 077 REUTILIZA el helper solo-dueño de la 073/076 (misma comprobación que la 074).
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '077: falta public.caller_manages_player(text). Aplica antes la 076 (o la 073); no se aplica nada';
  END IF;
  SELECT p.prosecdef, p.prosrc INTO v_def, v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF v_def
     OR v_src ~* '(tenant|org|team_member)'
     OR v_src !~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)' THEN
    RAISE EXCEPTION '077: public.caller_manages_player no es el helper SOLO DUEÑO de la 073/076. Vuelve a aplicar la 076; no se aplica nada';
  END IF;

  SELECT string_agg(t, ', ' ORDER BY t) INTO v_bad
    FROM unnest(ARRAY['match_events', 'player_session_metrics', 'tracking_jobs']) t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
   WHERE NOT c.relrowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '077: tablas SIN RLS activada: % (la 077 no la activa). Manda la comprobación previa; no se aplica nada', v_bad;
  END IF;

  SELECT string_agg(x.t || '.player_id', ', ' ORDER BY x.t) INTO v_bad
    FROM (VALUES ('match_events'), ('player_session_metrics')) x(t)
   WHERE to_regclass('public.' || x.t) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = to_regclass('public.' || x.t) AND a.attname = 'player_id' AND NOT a.attisdropped);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '077: faltan columnas que usan las guardas: %. Manda la comprobación previa; no se aplica nada', v_bad;
  END IF;
END $guard$;

-- =====================================================================
-- 1) match_events y player_session_metrics · guardas RESTRICTIVE de escritura
--    (se combinan con AND con las PERMISSIVE de autor/sesión que ya existen).
-- =====================================================================
DO $pol$
BEGIN
  IF to_regclass('public.match_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS "match_events_insert_requires_owner_077" ON public.match_events;
    DROP POLICY IF EXISTS "match_events_update_requires_owner_077" ON public.match_events;
    CREATE POLICY "match_events_insert_requires_owner_077" ON public.match_events
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "match_events_update_requires_owner_077" ON public.match_events
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '077: match_events no existe: se salta';
  END IF;

  IF to_regclass('public.player_session_metrics') IS NOT NULL THEN
    DROP POLICY IF EXISTS "player_session_metrics_insert_requires_owner_077" ON public.player_session_metrics;
    DROP POLICY IF EXISTS "player_session_metrics_update_requires_owner_077" ON public.player_session_metrics;
    CREATE POLICY "player_session_metrics_insert_requires_owner_077" ON public.player_session_metrics
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
    CREATE POLICY "player_session_metrics_update_requires_owner_077" ON public.player_session_metrics
      AS RESTRICTIVE FOR UPDATE TO authenticated
      WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '077: player_session_metrics no existe: se salta';
  END IF;
END $pol$;

-- =====================================================================
-- 2) tracking_jobs · solo del servidor: fuera TODA política y todo permiso de
--    cliente (de tabla y por columna); service_role conserva los 4.
-- =====================================================================
DO $jobs$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.tracking_jobs') IS NULL THEN
    RAISE NOTICE '077: tracking_jobs no existe: se salta';
    RETURN;
  END IF;
  -- Las dos de la 052 por su nombre, y después cualquier otra que hubiera.
  DROP POLICY IF EXISTS "tracking_jobs_insert" ON public.tracking_jobs;
  DROP POLICY IF EXISTS "tracking_jobs_select" ON public.tracking_jobs;
  FOR r IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tracking_jobs'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.tracking_jobs', r.policyname);
  END LOOP;
  REVOKE ALL ON TABLE public.tracking_jobs FROM PUBLIC, anon, authenticated;
  -- REVOKE de tabla no quita los permisos POR COLUMNA: se quitan uno a uno.
  FOR r IN
    SELECT attname FROM pg_attribute
     WHERE attrelid = to_regclass('public.tracking_jobs') AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON public.tracking_jobs FROM PUBLIC, anon, authenticated', r.attname);
  END LOOP;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tracking_jobs TO service_role;
END $jobs$;

-- =====================================================================
-- 3) anon · sin ESCRITURA (tabla y columnas) en las tablas de datos de jugador.
--    Las LECTURAS de anon no se tocan aquí (la RLS ya no le deja ver filas).
-- =====================================================================
DO $anon$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['fatigue_sessions', 'development_plans', 'idp_goals', 'idp_milestones', 'idp_checkins',
                           'tracking_sessions', 'player_analyses', 'videos', 'live_events', 'scout_insights',
                           'evaluation_history', 'player_knowledge',
                           'match_events', 'player_session_metrics', 'training_sessions']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM anon', t);
    FOR r IN
      SELECT attname FROM pg_attribute
       WHERE attrelid = to_regclass('public.' || t) AND attnum > 0 AND NOT attisdropped
    LOOP
      EXECUTE format('REVOKE INSERT (%I), UPDATE (%I) ON public.%I FROM anon', r.attname, r.attname, t);
    END LOOP;
  END LOOP;
END $anon$;

-- =====================================================================
-- 4) Guarda final · ABORTA todo si algo no quedó como se espera.
-- =====================================================================
DO $final$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(e.t || '.' || c.cmd, ', ' ORDER BY e.t, c.cmd) INTO v_bad
    FROM unnest(ARRAY['match_events', 'player_session_metrics']) e(t)
   CROSS JOIN (VALUES ('insert'), ('update')) c(cmd)
   WHERE to_regclass('public.' || e.t) IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = e.t
              AND p.policyname = e.t || '_' || c.cmd || '_requires_owner_077'
              AND p.permissive = 'RESTRICTIVE'
              AND p.cmd = upper(c.cmd)
              AND p.roles = ARRAY['authenticated']::name[]
              AND p.qual IS NULL
              AND p.with_check LIKE '%caller_manages_player(%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '077: guardas que no quedaron como se espera: % (no se aplica nada; mándalo)', v_bad;
  END IF;

  IF to_regclass('public.tracking_jobs') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tracking_jobs')
       OR has_table_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
       OR has_table_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
       OR has_table_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.tracking_jobs', 'DELETE')
       OR has_table_privilege('anon', 'public.tracking_jobs', 'SELECT')
       OR has_table_privilege('anon', 'public.tracking_jobs', 'INSERT')
       OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
       OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
       OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
       OR has_any_column_privilege('anon', 'public.tracking_jobs', 'SELECT')
       OR has_any_column_privilege('anon', 'public.tracking_jobs', 'INSERT')
       OR has_any_column_privilege('anon', 'public.tracking_jobs', 'UPDATE') THEN
      RAISE EXCEPTION '077: quedan políticas o permisos de cliente en tracking_jobs (no se aplica nada; mándalo)';
    END IF;
    IF NOT (has_table_privilege('service_role', 'public.tracking_jobs', 'SELECT')
            AND has_table_privilege('service_role', 'public.tracking_jobs', 'INSERT')
            AND has_table_privilege('service_role', 'public.tracking_jobs', 'UPDATE')
            AND has_table_privilege('service_role', 'public.tracking_jobs', 'DELETE')) THEN
      RAISE EXCEPTION '077: service_role perdió permisos en tracking_jobs (no se aplica nada; mándalo)';
    END IF;
  END IF;

  SELECT string_agg(t, ', ' ORDER BY t) INTO v_bad
    FROM unnest(ARRAY['fatigue_sessions', 'development_plans', 'idp_goals', 'idp_milestones', 'idp_checkins',
                      'tracking_sessions', 'player_analyses', 'videos', 'live_events', 'scout_insights',
                      'evaluation_history', 'player_knowledge',
                      'match_events', 'player_session_metrics', 'training_sessions']) t
   WHERE to_regclass('public.' || t) IS NOT NULL
     AND (has_table_privilege('anon', to_regclass('public.' || t), 'INSERT')
          OR has_table_privilege('anon', to_regclass('public.' || t), 'UPDATE')
          OR has_table_privilege('anon', to_regclass('public.' || t), 'DELETE')
          OR has_any_column_privilege('anon', to_regclass('public.' || t), 'INSERT')
          OR has_any_column_privilege('anon', to_regclass('public.' || t), 'UPDATE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '077: anon sigue pudiendo escribir en: % (no se aplica nada; mándalo)', v_bad;
  END IF;

  RAISE NOTICE '077: comprobación final OK';
END $final$;

COMMIT;
