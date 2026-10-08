-- =====================================================================
-- VITAS · 076 · COMPROBACIÓN POSTERIOR · SOLO LECTURA
-- Ejecútala DESPUÉS de la migración 076 y manda el resultado COMPLETO.
--   · ok = false en cualquier fila  →  la 076 no quedó como se espera; mándalo.
--   · ok vacío (NULL) = fila informativa.
-- No escribe nada (una sola consulta SELECT) y no falla si falta algún objeto
-- (to_regclass / to_regprocedure). Probada en SIMULACIÓN PGlite (NO en tu base):
-- base vacía, esquema mínimo y la forma verificada de producción, antes y
-- después de la 076 (antes debe salir ok = false en las filas 1, 3, 4, 5, 6 y 11).
-- =====================================================================
WITH
gest(tabla, esperadas) AS (
  -- Políticas *_076 que crea la 076 en cada tabla (si la tabla existe).
  VALUES ('players', 1), ('videos', 2), ('analyses', 2), ('reports', 1), ('parental_consents', 0),
         ('player_anthropometrics', 0), ('development_plans', 2), ('idp_goals', 2), ('idp_milestones', 2),
         ('idp_checkins', 2), ('transfer_listings', 2), ('transfer_inquiries', 2), ('tactical_phases', 2),
         ('phase_heatmaps', 2), ('tactical_insights', 2), ('match_analyses', 1)
),
viejas(tabla, politica) AS (
  VALUES ('players', 'players_tenant_isolation'), ('videos', 'videos_tenant_isolation'),
         ('analyses', 'analyses_tenant_isolation'), ('reports', 'reports_tenant_isolation'),
         ('parental_consents', 'consent_tenant_isolation'),
         ('player_anthropometrics', 'anthro_tenant_isolation'),
         ('development_plans', 'idp_plans_owner_read'), ('development_plans', 'idp_plans_coach_write'),
         ('idp_goals', 'idp_goals_via_plan'), ('idp_milestones', 'idp_milestones_via_plan'),
         ('idp_checkins', 'idp_checkins_via_plan'),
         ('transfer_listings', 'listings_public_read'), ('transfer_listings', 'listings_owner_write'),
         ('transfer_inquiries', 'inquiries_participants_read'), ('transfer_inquiries', 'inquiries_participants_write'),
         ('tactical_phases', 'tactical_phases_auth_read'), ('tactical_phases', 'tactical_phases_auth_write'),
         ('tactical_phases', 'tactical_phases_owner_read'), ('tactical_phases', 'tactical_phases_owner_write'),
         ('phase_heatmaps', 'phase_heatmaps_auth_read'), ('phase_heatmaps', 'phase_heatmaps_auth_write'),
         ('phase_heatmaps', 'phase_heatmaps_owner_read'), ('phase_heatmaps', 'phase_heatmaps_owner_write'),
         ('tactical_insights', 'tactical_insights_auth_read'), ('tactical_insights', 'tactical_insights_auth_write'),
         ('tactical_insights', 'tactical_insights_owner_read'), ('tactical_insights', 'tactical_insights_owner_write'),
         ('match_analyses', 'match_analyses_select_owner')
),
pol AS (
  SELECT tablename, policyname, cmd, roles,
         lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) AS expr
    FROM pg_policies
   WHERE schemaname = 'public'
),
helper AS (
  SELECT to_regprocedure('public.caller_manages_player(text)') AS f,
         to_regprocedure('public.dsar_caller_manages_player(text)') AS d
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · Helper solo-dueño: existe, SECURITY INVOKER, sin tenant en el cuerpo.
  SELECT 1, 'public.caller_manages_player: existe · security invoker · menciona tenant',
         CASE WHEN h.f IS NULL THEN 'no existe'
              ELSE 'true · ' || (NOT p.prosecdef)::text || ' · ' || (lower(p.prosrc) LIKE '%tenant%')::text END,
         'true · true · false',
         h.f IS NOT NULL AND NOT p.prosecdef AND lower(p.prosrc) NOT LIKE '%tenant%'
    FROM helper h LEFT JOIN pg_proc p ON p.oid = h.f
  UNION ALL
  -- 2 · Permisos del helper: authenticated sí (lo evalúan las políticas), anon no.
  SELECT 2, 'caller_manages_player: EXECUTE authenticated · anon',
         CASE WHEN h.f IS NULL OR to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN 'no aplica'
              ELSE has_function_privilege('authenticated', h.f, 'EXECUTE')::text || ' · '
                   || has_function_privilege('anon', h.f, 'EXECUTE')::text END,
         'true · false',
         h.f IS NOT NULL AND to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
           AND has_function_privilege('authenticated', h.f, 'EXECUTE')
           AND NOT has_function_privilege('anon', h.f, 'EXECUTE')
    FROM helper h
  UNION ALL
  -- 3 · DSAR (072): el helper ya no menciona tenant y nadie del cliente lo ejecuta directo.
  SELECT 3, 'public.dsar_caller_manages_player: menciona tenant · EXECUTE authenticated',
         CASE WHEN h.d IS NULL THEN 'no existe'
              ELSE (lower(p.prosrc) LIKE '%tenant%')::text || ' · '
                   || CASE WHEN to_regrole('authenticated') IS NULL THEN 'no aplica'
                           ELSE has_function_privilege('authenticated', h.d, 'EXECUTE')::text END END,
         'false · false (o «no existe» si la 072 no está)',
         h.d IS NULL OR (lower(p.prosrc) NOT LIKE '%tenant%'
                         AND (to_regrole('authenticated') IS NULL OR NOT has_function_privilege('authenticated', h.d, 'EXECUTE')))
    FROM helper h LEFT JOIN pg_proc p ON p.oid = h.d
  UNION ALL
  -- 4 · Ninguna política que mencione tenant en las tablas de jugador de la 076.
  SELECT 4, 'políticas que mencionan tenant en las tablas de la 076',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol p JOIN gest g ON g.tabla = p.tablename
   WHERE p.expr LIKE '%tenant%'
  UNION ALL
  -- 5 · Las políticas viejas (tenant / 048 abiertas) ya no están.
  SELECT 5, 'políticas viejas que la 076 retira y siguen presentes',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol p JOIN viejas v ON v.tabla = p.tablename AND v.politica = p.policyname
  UNION ALL
  -- 6 · Las políticas *_076 están, según las tablas que existen.
  SELECT 6, 'políticas *_076 presentes (en las tablas que existen)',
         (SELECT count(*) FROM pol p JOIN gest g ON g.tabla = p.tablename WHERE p.policyname LIKE '%\_076' ESCAPE '\')::text,
         (SELECT coalesce(sum(g.esperadas), 0) FROM gest g WHERE to_regclass('public.' || g.tabla) IS NOT NULL)::text,
         (SELECT count(*) FROM pol p JOIN gest g ON g.tabla = p.tablename WHERE p.policyname LIKE '%\_076' ESCAPE '\')
           = (SELECT coalesce(sum(g.esperadas), 0) FROM gest g WHERE to_regclass('public.' || g.tabla) IS NOT NULL)
  UNION ALL
  -- 7 · Ninguna política *_076 es para anon ni para PUBLIC (todas TO authenticated).
  SELECT 7, 'políticas *_076 que NO son solo TO authenticated',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol p
   WHERE p.policyname LIKE '%\_076' ESCAPE '\' AND p.roles <> ARRAY['authenticated']::name[]
  UNION ALL
  -- 8 · RLS activada en las tablas de la 076 que existen.
  SELECT 8, 'tablas de la 076 SIN RLS activada',
         coalesce(string_agg(g.tabla, ', ' ORDER BY g.tabla), 'ninguna'), 'ninguna', count(*) = 0
    FROM gest g JOIN pg_class c ON c.oid = to_regclass('public.' || g.tabla)
   WHERE NOT c.relrowsecurity
  UNION ALL
  -- 9 · Las DSAR siguen llamables con sesión (el dueño las usa en /admin/consent).
  SELECT 9, 'DSAR exportar · pedir borrado: EXECUTE authenticated',
         coalesce((SELECT has_function_privilege('authenticated', to_regprocedure('public.dsar_export_player_data(text)'), 'EXECUTE')::text
                    WHERE to_regprocedure('public.dsar_export_player_data(text)') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL), 'no existe')
           || ' · ' ||
         coalesce((SELECT has_function_privilege('authenticated', to_regprocedure('public.dsar_request_deletion(text,text)'), 'EXECUTE')::text
                    WHERE to_regprocedure('public.dsar_request_deletion(text,text)') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL), 'no existe'),
         'true · true (o «no existe» si la 072 no está)',
         NOT EXISTS (SELECT 1 WHERE to_regprocedure('public.dsar_export_player_data(text)') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
                                AND NOT has_function_privilege('authenticated', to_regprocedure('public.dsar_export_player_data(text)'), 'EXECUTE'))
           AND NOT EXISTS (SELECT 1 WHERE to_regprocedure('public.dsar_request_deletion(text,text)') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
                                    AND NOT has_function_privilege('authenticated', to_regprocedure('public.dsar_request_deletion(text,text)'), 'EXECUTE'))
  UNION ALL
  -- 11 · El texto de las dos RPC DSAR ya no dice «dueño/tenant» (la 076 lo corrige;
  --      su cuerpo y sus permisos no cambian).
  SELECT 11, 'comentario de dsar_export_player_data · dsar_request_deletion menciona tenant',
         coalesce((SELECT (lower(coalesce(obj_description(to_regprocedure('public.dsar_export_player_data(text)'), 'pg_proc'), '')) LIKE '%tenant%')::text
                    WHERE to_regprocedure('public.dsar_export_player_data(text)') IS NOT NULL), 'no existe')
           || ' · ' ||
         coalesce((SELECT (lower(coalesce(obj_description(to_regprocedure('public.dsar_request_deletion(text,text)'), 'pg_proc'), '')) LIKE '%tenant%')::text
                    WHERE to_regprocedure('public.dsar_request_deletion(text,text)') IS NOT NULL), 'no existe'),
         'false · false (o «no existe» si la 072 no está)',
         NOT EXISTS (SELECT 1 WHERE to_regprocedure('public.dsar_export_player_data(text)') IS NOT NULL
                                AND lower(coalesce(obj_description(to_regprocedure('public.dsar_export_player_data(text)'), 'pg_proc'), '')) LIKE '%tenant%')
           AND NOT EXISTS (SELECT 1 WHERE to_regprocedure('public.dsar_request_deletion(text,text)') IS NOT NULL
                                    AND lower(coalesce(obj_description(to_regprocedure('public.dsar_request_deletion(text,text)'), 'pg_proc'), '')) LIKE '%tenant%')
  UNION ALL
  -- 10 · INFO. Políticas por tenant que quedan en OTRAS tablas (no de la 076): p. ej.
  --      subscriptions (no es dato de jugador) o 044/050 si la 073 no está aplicada.
  SELECT 10, 'INFO · políticas que mencionan tenant fuera de las tablas de la 076',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p
   WHERE p.expr LIKE '%tenant%'
     AND NOT EXISTS (SELECT 1 FROM gest g WHERE g.tabla = p.tablename)
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
