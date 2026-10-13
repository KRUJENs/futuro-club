-- =====================================================================
-- VITAS · 077 · COMPROBACIÓN POSTERIOR · SOLO LECTURA
-- Ejecútala DESPUÉS de la migración 077 y manda el resultado COMPLETO.
--   · ok = false en cualquier fila  →  la 077 no quedó como se espera; mándalo.
--   · ok vacío (NULL) = fila informativa.
-- No escribe nada (una sola consulta SELECT) y no falla si falta algún objeto
-- (to_regclass / to_regrole). Antes de la 077 salen ok = false las filas 2-5.
-- =====================================================================
WITH
hh AS (
  SELECT to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
           AND to_regrole('service_role') IS NOT NULL AS roles,
         to_regclass('public.tracking_jobs') IS NOT NULL AS tj
),
esperadas AS (
  SELECT e.t AS tabla, c.cmd, e.t || '_' || c.cmd || '_requires_owner_077' AS nombre
    FROM unnest(ARRAY['match_events', 'player_session_metrics']) e(t)
   CROSS JOIN (VALUES ('insert'), ('update')) c(cmd)
   WHERE to_regclass('public.' || e.t) IS NOT NULL
),
anon_t(t) AS (
  VALUES ('fatigue_sessions'), ('development_plans'), ('idp_goals'), ('idp_milestones'), ('idp_checkins'),
         ('tracking_sessions'), ('player_analyses'), ('videos'), ('live_events'), ('scout_insights'),
         ('evaluation_history'), ('player_knowledge'), ('match_events'), ('player_session_metrics'), ('training_sessions')
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · Roles de Supabase.
  SELECT 1, 'roles anon · authenticated · service_role existen', hh.roles::text, 'true', hh.roles
    FROM hh
  UNION ALL
  -- 2 · Las 4 guardas existen y son RESTRICTIVE · TO authenticated · solo WITH CHECK con el helper.
  SELECT 2, 'guardas *_077 que faltan o no son RESTRICTIVE · TO authenticated · solo WITH CHECK con el helper',
         coalesce(string_agg(e.nombre, ', ' ORDER BY e.nombre), 'ninguna'), 'ninguna', count(*) = 0
    FROM esperadas e
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = e.tabla AND p.policyname = e.nombre
                        AND p.permissive = 'RESTRICTIVE' AND p.cmd = upper(e.cmd)
                        AND p.roles = ARRAY['authenticated']::name[] AND p.qual IS NULL
                        AND p.with_check LIKE '%caller_manages_player(%')
  UNION ALL
  -- 3 · tracking_jobs sin ninguna política (solo del servidor).
  SELECT 3, 'políticas en tracking_jobs',
         CASE WHEN NOT hh.tj THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) FROM pg_policies p
                              WHERE p.schemaname = 'public' AND p.tablename = 'tracking_jobs'), 'ninguna') END,
         'ninguna',
         CASE WHEN NOT hh.tj THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tracking_jobs') END
    FROM hh
  UNION ALL
  -- 4 · tracking_jobs: ningún permiso de cliente (tabla o columna) y service_role con los 4.
  SELECT 4, 'tracking_jobs · cliente (authenticated/anon) con algún permiso de tabla o columna · service_role SELECT·INSERT·UPDATE·DELETE',
         CASE WHEN NOT hh.tj THEN 'tabla no existe'
              WHEN NOT hh.roles THEN 'no aplica'
              ELSE (has_table_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
                    OR has_table_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
                    OR has_table_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
                    OR has_table_privilege('authenticated', 'public.tracking_jobs', 'DELETE')
                    OR has_table_privilege('anon', 'public.tracking_jobs', 'SELECT')
                    OR has_table_privilege('anon', 'public.tracking_jobs', 'INSERT')
                    OR has_table_privilege('anon', 'public.tracking_jobs', 'UPDATE')
                    OR has_table_privilege('anon', 'public.tracking_jobs', 'DELETE')
                    OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
                    OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
                    OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
                    OR has_any_column_privilege('anon', 'public.tracking_jobs', 'SELECT')
                    OR has_any_column_privilege('anon', 'public.tracking_jobs', 'INSERT')
                    OR has_any_column_privilege('anon', 'public.tracking_jobs', 'UPDATE'))::text
                   || ' · '
                   || has_table_privilege('service_role', 'public.tracking_jobs', 'SELECT')::text || '·'
                   || has_table_privilege('service_role', 'public.tracking_jobs', 'INSERT')::text || '·'
                   || has_table_privilege('service_role', 'public.tracking_jobs', 'UPDATE')::text || '·'
                   || has_table_privilege('service_role', 'public.tracking_jobs', 'DELETE')::text END,
         'false · true·true·true·true',
         CASE WHEN NOT hh.tj OR NOT hh.roles THEN NULL
              ELSE NOT (has_table_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
                        OR has_table_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
                        OR has_table_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
                        OR has_table_privilege('authenticated', 'public.tracking_jobs', 'DELETE')
                        OR has_table_privilege('anon', 'public.tracking_jobs', 'SELECT')
                        OR has_table_privilege('anon', 'public.tracking_jobs', 'INSERT')
                        OR has_table_privilege('anon', 'public.tracking_jobs', 'UPDATE')
                        OR has_table_privilege('anon', 'public.tracking_jobs', 'DELETE')
                        OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'SELECT')
                        OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'INSERT')
                        OR has_any_column_privilege('authenticated', 'public.tracking_jobs', 'UPDATE')
                        OR has_any_column_privilege('anon', 'public.tracking_jobs', 'SELECT')
                        OR has_any_column_privilege('anon', 'public.tracking_jobs', 'INSERT')
                        OR has_any_column_privilege('anon', 'public.tracking_jobs', 'UPDATE'))
                   AND has_table_privilege('service_role', 'public.tracking_jobs', 'SELECT')
                   AND has_table_privilege('service_role', 'public.tracking_jobs', 'INSERT')
                   AND has_table_privilege('service_role', 'public.tracking_jobs', 'UPDATE')
                   AND has_table_privilege('service_role', 'public.tracking_jobs', 'DELETE') END
    FROM hh
  UNION ALL
  -- 5 · anon sin ESCRITURA (tabla o columna) en las tablas de datos de jugador.
  SELECT 5, 'anon: tablas de datos de jugador donde aún puede escribir (tabla o columna)',
         CASE WHEN NOT (SELECT roles FROM hh) THEN 'no aplica'
              ELSE coalesce((SELECT string_agg(a.t, ', ' ORDER BY a.t) FROM anon_t a
                              WHERE to_regclass('public.' || a.t) IS NOT NULL
                                AND (has_table_privilege('anon', to_regclass('public.' || a.t), 'INSERT')
                                     OR has_table_privilege('anon', to_regclass('public.' || a.t), 'UPDATE')
                                     OR has_table_privilege('anon', to_regclass('public.' || a.t), 'DELETE')
                                     OR has_any_column_privilege('anon', to_regclass('public.' || a.t), 'INSERT')
                                     OR has_any_column_privilege('anon', to_regclass('public.' || a.t), 'UPDATE'))), 'ninguna') END,
         'ninguna',
         CASE WHEN NOT (SELECT roles FROM hh) THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM anon_t a
                                WHERE to_regclass('public.' || a.t) IS NOT NULL
                                  AND (has_table_privilege('anon', to_regclass('public.' || a.t), 'INSERT')
                                       OR has_table_privilege('anon', to_regclass('public.' || a.t), 'UPDATE')
                                       OR has_table_privilege('anon', to_regclass('public.' || a.t), 'DELETE')
                                       OR has_any_column_privilege('anon', to_regclass('public.' || a.t), 'INSERT')
                                       OR has_any_column_privilege('anon', to_regclass('public.' || a.t), 'UPDATE'))) END
  UNION ALL
  -- 6 · La RLS sigue activada en las 3 tablas (la 077 no la toca).
  SELECT 6, 'tablas de la 077 que existen SIN RLS activada',
         coalesce(string_agg(t, ', ' ORDER BY t), 'ninguna'), 'ninguna', count(*) = 0
    FROM unnest(ARRAY['match_events', 'player_session_metrics', 'tracking_jobs']) t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
   WHERE NOT c.relrowsecurity
  UNION ALL
  -- 7 · INFO. La 074 sigue intacta.
  SELECT 7, 'INFO · guardas *_requires_owner_074 presentes',
         (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\_requires\_owner\_074' ESCAPE '\'),
         'informativo (esperado: 24)', NULL::boolean
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
