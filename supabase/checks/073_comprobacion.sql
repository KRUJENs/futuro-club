-- =====================================================================
-- VITAS · 073 · COMPROBACIÓN POSTERIOR · SOLO LECTURA
-- Ejecútala DESPUÉS de la migración 073 y manda el resultado completo.
-- Correcto = ok = true en TODAS las filas (resultado igual a esperado).
-- No escribe nada (una sola consulta SELECT) y no falla si falta algún objeto:
-- entonces el resultado lo dice («no existe», «tabla no existe»).
-- La 073 es SOLO DUEÑO (decisión del 30 sep 2026); la fila 17 lo confirma en tu
-- base (con la versión anterior «dueño O tenant» sale false). La lectura de
-- player_metric_snapshots desde el navegador queda RETENIDA (filas 10 y 11).
-- Probada en SIMULACIÓN PGlite (NO en tu base), PostgreSQL 18.3 y 16.4: base
-- vacía, antes de 073 (da ok = false donde toca), después de 073, 073 dos veces,
-- cadena sin 050, 050 re-ejecutada después de 073 (la detecta) y la versión
-- anterior de la 073 (la detecta, fila 17).
-- =====================================================================
WITH
tablas5(tabla) AS (
  VALUES ('behavioral_profiles'), ('attendance_records'), ('engagement_snapshots'),
         ('wellbeing_questionnaires'), ('dropout_risk_assessments')
),
tablas8(tabla) AS (
  SELECT tabla FROM tablas5
  UNION ALL VALUES ('player_metric_snapshots'), ('player_injuries'), ('player_valuations')
),
pol AS (
  SELECT tablename, policyname, cmd, roles, permissive, qual, with_check,
         regexp_replace(regexp_replace(lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')),
                                       '::[a-z_]+( varying| precision)?', '', 'g'),
                        '[[:space:]()"]', '', 'g') AS expr
    FROM pg_policies
   WHERE schemaname = 'public'
),
helper AS (
  SELECT to_regprocedure('public.caller_manages_player(text)') AS oid
),
filas(n, comprobacion, resultado, esperado) AS (
  SELECT 1, 'helper public.caller_manages_player(text): tipo · search_path',
         CASE WHEN h.oid IS NULL THEN 'no existe'
              ELSE (SELECT CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
                           || ' · ' || coalesce(array_to_string(p.proconfig, ','), 'sin search_path')
                      FROM pg_proc p WHERE p.oid = h.oid) END,
         'invoker · search_path=public, pg_temp'
    FROM helper h
  UNION ALL
  SELECT 2, 'helper: quién puede ejecutarlo',
         CASE WHEN h.oid IS NULL THEN 'no existe'
              WHEN to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN 'faltan roles'
              ELSE 'anon=' || has_function_privilege('anon', h.oid, 'EXECUTE')::text
                   || ' · authenticated=' || has_function_privilege('authenticated', h.oid, 'EXECUTE')::text END,
         'anon=false · authenticated=true'
    FROM helper h
  UNION ALL
  SELECT 3, 'políticas de public que comparan tenant_id con auth.uid()',
         count(*)::text, '0'
    FROM pol
   WHERE expr ~ 'tenant_id(=|in)(select)?auth\.uid'
      OR expr ~ 'auth\.uid(asuid)?=([a-z0-9_]+\.)*tenant_id'
  UNION ALL
  -- Las 5 tablas de bienestar / perfil conductual: exactamente SELECT, INSERT y
  -- UPDATE, TO authenticated, con el helper en USING y/o WITH CHECK según toque.
  SELECT 4 + (row_number() OVER (ORDER BY t.tabla))::int, t.tabla || ': políticas (cmd:rol:regla)',
         CASE WHEN to_regclass('public.' || t.tabla) IS NULL THEN 'tabla no existe'
              ELSE coalesce((
                SELECT string_agg(p.cmd || ':' || array_to_string(p.roles, ',') || ':' ||
                         CASE WHEN p.permissive = 'PERMISSIVE'
                               AND ((p.cmd = 'SELECT' AND p.qual LIKE '%caller_manages_player(%' AND p.with_check IS NULL)
                                 OR (p.cmd = 'INSERT' AND p.with_check LIKE '%caller_manages_player(%' AND p.qual IS NULL)
                                 OR (p.cmd = 'UPDATE' AND p.qual LIKE '%caller_manages_player(%'
                                                      AND p.with_check LIKE '%caller_manages_player(%'))
                              THEN 'helper' ELSE 'OTRA' END,
                         ' · ' ORDER BY p.cmd, p.policyname)
                  FROM pol p WHERE p.tablename = t.tabla), 'sin políticas') END,
         CASE WHEN to_regclass('public.' || t.tabla) IS NULL THEN 'tabla no existe'
              ELSE 'INSERT:authenticated:helper · SELECT:authenticated:helper · UPDATE:authenticated:helper' END
    FROM tablas5 t
  UNION ALL
  -- Snapshots: solo la escritura de service_role de la 072. La lectura del
  -- navegador queda RETENIDA (gráfico de evolución con PHV sin gate; escritor
  -- progression-tracker sin comprobación de propiedad; ver cabecera de la 073).
  SELECT 10, 'player_metric_snapshots: políticas (nombre:cmd:rol)',
         CASE WHEN to_regclass('public.player_metric_snapshots') IS NULL THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' · ' ORDER BY policyname)
                               FROM pol WHERE tablename = 'player_metric_snapshots'), 'sin políticas') END,
         CASE WHEN to_regclass('public.player_metric_snapshots') IS NULL THEN 'tabla no existe'
              ELSE 'snapshots_insert_service_role:INSERT:service_role' END
  UNION ALL
  SELECT 11, 'player_metric_snapshots: políticas de LECTURA que no son solo de service_role (retenida)',
         CASE WHEN to_regclass('public.player_metric_snapshots') IS NULL THEN 'tabla no existe'
              ELSE (SELECT count(*)::text FROM pol
                     WHERE tablename = 'player_metric_snapshots' AND cmd IN ('SELECT', 'ALL')
                       AND roles <> ARRAY['service_role']::name[]) END,
         CASE WHEN to_regclass('public.player_metric_snapshots') IS NULL THEN 'tabla no existe' ELSE '0' END
  UNION ALL
  SELECT 12, 'player_injuries: políticas',
         CASE WHEN to_regclass('public.player_injuries') IS NULL THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(policyname || ':' || cmd, ' · ' ORDER BY policyname)
                               FROM pol WHERE tablename = 'player_injuries'), 'sin políticas') END,
         CASE WHEN to_regclass('public.player_injuries') IS NULL THEN 'tabla no existe' ELSE 'sin políticas' END
  UNION ALL
  SELECT 13, 'player_valuations: políticas (nombre:cmd:rol)',
         CASE WHEN to_regclass('public.player_valuations') IS NULL THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' · ' ORDER BY policyname)
                               FROM pol WHERE tablename = 'player_valuations'), 'sin políticas') END,
         CASE WHEN to_regclass('public.player_valuations') IS NULL THEN 'tabla no existe'
              ELSE 'valuations_insert_service_role:INSERT:service_role' END
  UNION ALL
  SELECT 14, 'tablas de la 073 con RLS DESACTIVADA',
         coalesce((SELECT string_agg(t.tabla, ', ' ORDER BY t.tabla)
                     FROM tablas8 t JOIN pg_class c ON c.oid = to_regclass('public.' || t.tabla)
                    WHERE NOT c.relrowsecurity), 'ninguna'),
         'ninguna'
  UNION ALL
  SELECT 15, 'políticas de las 8 tablas que aplican a anon o a public (sin TO)',
         count(*)::text, '0'
    FROM pol p JOIN tablas8 t ON t.tabla = p.tablename
   WHERE p.roles && ARRAY['anon', 'public']::name[]
  UNION ALL
  -- La 073 no toca la 072: el helper de las DSAR sigue revocado a authenticated.
  SELECT 16, 'DSAR (072) intacta: dsar_caller_manages_player(text) ejecutable por authenticated',
         CASE WHEN to_regprocedure('public.dsar_caller_manages_player(text)') IS NULL THEN 'no existe'
              WHEN to_regrole('authenticated') IS NULL THEN 'faltan roles'
              ELSE has_function_privilege('authenticated', to_regprocedure('public.dsar_caller_manages_player(text)'), 'EXECUTE')::text END,
         'false'
  UNION ALL
  -- La regla que ha quedado instalada es SOLO DUEÑO (decisión del 30 sep 2026): el
  -- cuerpo del helper no tiene rama por tenant ni por organización. Sin esta fila,
  -- las demás salen igual con un helper «dueño O tenant».
  SELECT 17, 'helper solo dueño: el cuerpo NO tiene rama por tenant ni por organización',
         CASE WHEN h.oid IS NULL THEN 'no existe'
              ELSE (pg_get_functiondef(h.oid) !~* '(tenant|org|team_member)')::text END,
         'true'
    FROM helper h
  UNION ALL
  -- Privilegios de TABLA que necesita el navegador en las 5 tablas (la RLS solo
  -- filtra filas: sin el GRANT, authenticated recibe 42501 aunque la política le
  -- deje). La 073 no toca GRANT/REVOKE de tablas; si falta alguno, dímelo antes de
  -- arreglar nada.
  SELECT 18, 'authenticated: privilegios de tabla que FALTAN en las 5 tablas (SELECT/INSERT/UPDATE)',
         CASE WHEN to_regrole('authenticated') IS NULL THEN 'faltan roles'
              ELSE coalesce((SELECT string_agg(t.tabla || ':' || pr.priv, ', ' ORDER BY t.tabla, pr.priv)
                               FROM tablas5 t
                              CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) pr(priv)
                              WHERE to_regclass('public.' || t.tabla) IS NOT NULL
                                AND NOT has_table_privilege('authenticated', to_regclass('public.' || t.tabla), pr.priv)),
                            'ninguno') END,
         'ninguno'
  UNION ALL
  -- Las escrituras de cliente que la 072 retiró en snapshots / valoraciones siguen
  -- retiradas (si no, la 044 se aplicó después de la 072).
  SELECT 19, 'snapshots / valoraciones: privilegios de cliente que la 072 retiró (anon: todos · authenticated: escritura)',
         CASE WHEN to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN 'faltan roles'
              ELSE coalesce((SELECT string_agg(rp.rol || ':' || t.tabla || ':' || rp.priv, ', ' ORDER BY t.tabla, rp.rol, rp.priv)
                               FROM (VALUES ('player_metric_snapshots'), ('player_valuations')) t(tabla)
                              CROSS JOIN (VALUES ('anon', 'SELECT'), ('anon', 'INSERT'), ('anon', 'UPDATE'), ('anon', 'DELETE'),
                                                 ('authenticated', 'INSERT'), ('authenticated', 'UPDATE'),
                                                 ('authenticated', 'DELETE')) rp(rol, priv)
                              WHERE to_regclass('public.' || t.tabla) IS NOT NULL
                                AND has_table_privilege(rp.rol, to_regclass('public.' || t.tabla), rp.priv)),
                            'ninguno') END,
         'ninguno'
)
SELECT n, comprobacion, resultado, esperado, resultado = esperado AS ok
  FROM filas
 ORDER BY n;
