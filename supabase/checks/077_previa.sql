-- =====================================================================
-- VITAS · 077 · COMPROBACIÓN PREVIA · SOLO LECTURA
-- Ejecútala ANTES de la migración 077 y manda el resultado COMPLETO.
--   · Fila «BLOQUEA» con ok = false  →  NO apliques la 077; manda el resultado.
--   · ok vacío (NULL) = fila informativa: no bloquea, pero mándala también.
-- No escribe nada (una sola consulta SELECT) y no falla si faltan tablas, columnas,
-- roles o funciones (to_regclass / to_regrole / to_regprocedure; los conteos van con
-- query_to_xml SOLO cuando la tabla y sus columnas existen). Solo cuenta filas: no
-- devuelve datos de nadie.
-- Qué mirar: fila 8 (filas que la 077 no borra: eventos o métricas de un jugador cuyo
-- dueño NO es quien las escribió) y fila 9 (las 24 guardas de la 074 siguen ahí).
-- =====================================================================
WITH
r AS (
  SELECT to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
           AND to_regrole('service_role') IS NOT NULL AS roles,
         to_regprocedure('public.caller_manages_player(text)') AS f
),
anon_t(t) AS (
  VALUES ('fatigue_sessions'), ('development_plans'), ('idp_goals'), ('idp_milestones'), ('idp_checkins'),
         ('tracking_sessions'), ('player_analyses'), ('videos'), ('live_events'), ('scout_insights'),
         ('evaluation_history'), ('player_knowledge'), ('match_events'), ('player_session_metrics'), ('training_sessions')
),
col AS (
  SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · BLOQUEA. Roles de Supabase (la 077 revoca/concede a anon, authenticated y service_role).
  SELECT 1, 'BLOQUEA · roles anon · authenticated · service_role existen', r.roles::text, 'true', r.roles
    FROM r
  UNION ALL
  -- 2 · BLOQUEA. auth.uid() lo usa el helper.
  SELECT 2, 'BLOQUEA · auth.uid() existe',
         (to_regprocedure('auth.uid()') IS NOT NULL)::text, 'true', to_regprocedure('auth.uid()') IS NOT NULL
  UNION ALL
  -- 3 · BLOQUEA. La 077 REUTILIZA el helper solo-dueño de la 073/076 (misma prueba que la 074).
  SELECT 3, 'BLOQUEA · public.caller_manages_player(text): existe · security invoker · solo dueño',
         CASE WHEN r.f IS NULL THEN 'no existe (aplica antes la 076 o la 073)'
              ELSE 'true · ' || (NOT p.prosecdef)::text || ' · '
                   || (p.prosrc !~* '(tenant|org|team_member)'
                       AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)')::text END,
         'true · true · true',
         r.f IS NOT NULL AND NOT p.prosecdef AND p.prosrc !~* '(tenant|org|team_member)'
           AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)'
    FROM r LEFT JOIN pg_proc p ON p.oid = r.f
  UNION ALL
  -- 4 · BLOQUEA. Sin RLS las guardas no harían nada, y la 077 NO la activa.
  SELECT 4, 'BLOQUEA · tablas de la 077 que existen SIN RLS activada',
         coalesce(string_agg(t, ', ' ORDER BY t), 'ninguna'), 'ninguna', count(*) = 0
    FROM unnest(ARRAY['match_events', 'player_session_metrics', 'tracking_jobs']) t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
   WHERE NOT c.relrowsecurity
  UNION ALL
  -- 5 · BLOQUEA. Columna que usan las guardas.
  SELECT 5, 'BLOQUEA · player_id que falta en match_events / player_session_metrics',
         coalesce(string_agg(x.t || '.player_id', ', ' ORDER BY x.t), 'ninguna'), 'ninguna', count(*) = 0
    FROM (VALUES ('match_events'), ('player_session_metrics')) x(t)
   WHERE to_regclass('public.' || x.t) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = x.t AND col.columna = 'player_id')
  UNION ALL
  -- 6 · INFO. Políticas de hoy en las 3 tablas (la 077 añade 4 guardas y deja tracking_jobs sin ninguna).
  SELECT 6, 'INFO · políticas hoy en match_events / player_session_metrics / tracking_jobs',
         coalesce((SELECT string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd, ', ' ORDER BY p.tablename, p.policyname)
                     FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename IN ('match_events', 'player_session_metrics', 'tracking_jobs')),
                  'ninguna'),
         'informativo', NULL::boolean
  UNION ALL
  -- 7 · INFO. Permisos de cliente sobre tracking_jobs (la 077 los deja todos en false).
  SELECT 7, 'INFO · tracking_jobs · authenticated SELECT·INSERT·UPDATE·DELETE | anon (igual)',
         CASE WHEN to_regclass('public.tracking_jobs') IS NULL THEN 'tabla no existe'
              WHEN NOT r.roles THEN 'no aplica'
              ELSE has_table_privilege('authenticated', 'public.tracking_jobs', 'SELECT')::text || '·'
                || has_table_privilege('authenticated', 'public.tracking_jobs', 'INSERT')::text || '·'
                || has_table_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')::text || '·'
                || has_table_privilege('authenticated', 'public.tracking_jobs', 'DELETE')::text || ' | '
                || has_table_privilege('anon', 'public.tracking_jobs', 'SELECT')::text || '·'
                || has_table_privilege('anon', 'public.tracking_jobs', 'INSERT')::text || '·'
                || has_table_privilege('anon', 'public.tracking_jobs', 'UPDATE')::text || '·'
                || has_table_privilege('anon', 'public.tracking_jobs', 'DELETE')::text END,
         'informativo (después de la 077: todo false)', NULL::boolean
    FROM r
  UNION ALL
  -- 8 · INFO. Filas escritas para un jugador cuyo dueño NO es el autor (la 077 no borra nada;
  --     limpiar es decisión del dueño). En prod el 13 oct las 3 tablas tenían 0 filas.
  SELECT 8, 'INFO · filas: match_events (total · autor ≠ dueño del jugador) | player_session_metrics (total · entrenador de la sesión ≠ dueño) | tracking_jobs (total)',
         CASE WHEN to_regclass('public.players') IS NULL
                   OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'players' AND col.columna = 'user_id') THEN 'players(id, user_id) no existe'
              ELSE
                coalesce(CASE WHEN to_regclass('public.match_events') IS NULL THEN '-'
                              WHEN NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'match_events' AND col.columna = 'user_id')
                                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'match_events' AND col.columna = 'player_id') THEN 'sin columnas'
                              ELSE substring(query_to_xml(
                                'select count(*)::text || '' · '' || count(*) filter (where m.player_id is not null and p.user_id is not null and m.user_id is distinct from p.user_id)::text as c
                                   from public.match_events m left join public.players p on p.id::text = m.player_id::text',
                                false, true, '')::text FROM '<c>([^<]*)</c>') END, '?')
                || ' | ' ||
                coalesce(CASE WHEN to_regclass('public.player_session_metrics') IS NULL OR to_regclass('public.training_sessions') IS NULL THEN '-'
                              WHEN NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'player_session_metrics' AND col.columna = 'session_id')
                                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'player_session_metrics' AND col.columna = 'player_id')
                                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'training_sessions' AND col.columna = 'coach_id') THEN 'sin columnas'
                              ELSE substring(query_to_xml(
                                'select count(*)::text || '' · '' || count(*) filter (where x.player_id is not null and p.user_id is not null and s.coach_id is distinct from p.user_id)::text as c
                                   from public.player_session_metrics x
                                   left join public.training_sessions s on s.id = x.session_id
                                   left join public.players p on p.id::text = x.player_id::text',
                                false, true, '')::text FROM '<c>([^<]*)</c>') END, '?')
                || ' | ' ||
                coalesce(CASE WHEN to_regclass('public.tracking_jobs') IS NULL THEN '-'
                              ELSE substring(query_to_xml('select count(*)::text as c from public.tracking_jobs', false, true, '')::text
                                             FROM '<c>([^<]*)</c>') END, '?')
         END,
         'informativo (la 077 no borra ni cambia filas)', NULL::boolean
  UNION ALL
  -- 9 · INFO. La 074 sigue aplicada (24 guardas = 2 por cada una de sus 12 tablas).
  SELECT 9, 'INFO · guardas *_requires_owner_074 presentes',
         (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\_requires\_owner\_074' ESCAPE '\'),
         'informativo (esperado: 24)', NULL::boolean
  UNION ALL
  -- 10 · INFO. anon con permiso de ESCRITURA de tabla hoy (la 077 los quita en estas tablas).
  SELECT 10, 'INFO · anon: tablas de datos de jugador con INSERT, UPDATE o DELETE de tabla',
         CASE WHEN NOT (SELECT roles FROM r) THEN 'no aplica'
              ELSE coalesce((SELECT string_agg(a.t, ', ' ORDER BY a.t) FROM anon_t a
                              WHERE to_regclass('public.' || a.t) IS NOT NULL
                                AND (has_table_privilege('anon', to_regclass('public.' || a.t), 'INSERT')
                                     OR has_table_privilege('anon', to_regclass('public.' || a.t), 'UPDATE')
                                     OR has_table_privilege('anon', to_regclass('public.' || a.t), 'DELETE'))), 'ninguna') END,
         'informativo (después de la 077: ninguna)', NULL::boolean
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
