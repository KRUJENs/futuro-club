-- =====================================================================
-- VITAS · 074 · COMPROBACIÓN POSTERIOR · SOLO LECTURA
-- Ejecútala DESPUÉS de la migración 074 y manda el resultado COMPLETO.
--   · ok = false en cualquier fila  →  la 074 no quedó como se espera; mándalo.
--   · ok vacío (NULL) = fila informativa.
-- No escribe nada (una sola consulta SELECT) y no falla si falta algún objeto
-- (to_regclass / to_regprocedure). Probada en SIMULACIÓN PGlite (NO en tu base),
-- PostgreSQL 18.3 y 16.4: base vacía, antes de la 074 (salen ok = false las filas
-- 3 y 5) y después (ok = true en todas), también con la 076 aplicada después.
-- =====================================================================
WITH
tablas(tabla) AS (
  VALUES ('fatigue_sessions'), ('development_plans'), ('idp_goals'), ('idp_milestones'), ('idp_checkins'),
         ('tracking_sessions'), ('player_analyses'), ('videos'), ('live_events'), ('scout_insights')
),
cmds(cmd) AS (VALUES ('INSERT'), ('UPDATE')),
col AS (
  SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
),
pol AS (
  SELECT tablename, policyname, cmd, permissive, roles, qual, with_check,
         lower(coalesce(with_check, qual, '')) AS w
    FROM pg_policies
   WHERE schemaname = 'public'
),
helper AS (
  SELECT to_regprocedure('public.caller_manages_player(text)') AS f
),
-- Guardas que deberían existir: 2 por cada tabla de la 074 que existe.
esperadas AS (
  SELECT t.tabla, c.cmd, t.tabla || '_' || lower(c.cmd) || '_requires_owner_074' AS nombre
    FROM tablas t CROSS JOIN cmds c
   WHERE to_regclass('public.' || t.tabla) IS NOT NULL
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · El helper que usan las guardas sigue siendo SOLO DUEÑO e INVOKER (si una
  --     versión con tenant lo sustituyera, las guardas la heredarían).
  SELECT 1, 'public.caller_manages_player: existe · security invoker · solo dueño',
         CASE WHEN h.f IS NULL THEN 'no existe'
              ELSE 'true · ' || (NOT p.prosecdef)::text || ' · '
                   || (p.prosrc !~* '(tenant|org|team_member)'
                       AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)')::text END,
         'true · true · true',
         h.f IS NOT NULL AND NOT p.prosecdef AND p.prosrc !~* '(tenant|org|team_member)'
           AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)'
    FROM helper h LEFT JOIN pg_proc p ON p.oid = h.f
  UNION ALL
  -- 2 · Sin RLS las guardas no hacen nada.
  SELECT 2, 'tablas de la 074 SIN RLS activada',
         coalesce(string_agg(t.tabla, ', ' ORDER BY t.tabla), 'ninguna'), 'ninguna', count(*) = 0
    FROM tablas t JOIN pg_class c ON c.oid = to_regclass('public.' || t.tabla)
   WHERE NOT c.relrowsecurity
  UNION ALL
  -- 3 · Cada guarda: RESTRICTIVE, del comando correcto, TO authenticated, sin USING
  --     y con el helper en WITH CHECK.
  SELECT 3, 'guardas *_074 que faltan o no son RESTRICTIVE · TO authenticated · solo WITH CHECK con el helper',
         coalesce(string_agg(e.nombre, ', ' ORDER BY e.nombre), 'ninguna'), 'ninguna', count(*) = 0
    FROM esperadas e
   WHERE NOT EXISTS (SELECT 1 FROM pol p
                      WHERE p.tablename = e.tabla AND p.policyname = e.nombre
                        AND p.permissive = 'RESTRICTIVE' AND p.cmd = e.cmd
                        AND p.roles = ARRAY['authenticated']::name[]
                        AND p.qual IS NULL
                        AND p.with_check LIKE '%caller_manages_player(%')
  UNION ALL
  -- 4 · Ninguna política *_074 abre nada (todas deben ser RESTRICTIVE).
  SELECT 4, 'políticas *_074 PERMISSIVE (no deberían existir)',
         coalesce(string_agg(tablename || ':' || policyname, ', ' ORDER BY tablename, policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol
   WHERE policyname LIKE '%\_074' ESCAPE '\' AND permissive <> 'RESTRICTIVE'
  UNION ALL
  -- 5 · Cuántas guardas hay frente a las esperadas (2 por tabla que existe).
  SELECT 5, 'guardas *_074 presentes / esperadas (2 por tabla de la 074 que existe)',
         (SELECT count(*) FROM pol p JOIN esperadas e ON e.tabla = p.tablename AND e.nombre = p.policyname)::text,
         (SELECT count(*) FROM esperadas)::text,
         (SELECT count(*) FROM pol p JOIN esperadas e ON e.tabla = p.tablename AND e.nombre = p.policyname)
           = (SELECT count(*) FROM esperadas)
  UNION ALL
  -- 6 · INFO. Las PERMISSIVE de escritura que siguen (se combinan con AND con las
  --     guardas: sin una de ellas nadie escribe; con ellas, solo el dueño).
  SELECT 6, 'INFO · políticas PERMISSIVE de escritura de cliente que siguen en esas tablas',
         coalesce(string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p JOIN tablas t ON t.tabla = p.tablename
   WHERE p.permissive = 'PERMISSIVE' AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND p.roles <> ARRAY['service_role']::name[]
  UNION ALL
  -- 7 · INFO. OTRAS tablas con player_id cuyas escrituras de cliente no miran al
  --     dueño del jugador (la 074 no las cubre; ver docs/pendientes-metricas.md).
  SELECT 7, 'INFO · OTRAS tablas con player_id y escrituras de cliente que no miran al dueño del jugador (la 074 NO las cubre)',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p
   WHERE p.permissive = 'PERMISSIVE' AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND p.roles <> ARRAY['service_role']::name[]
     AND EXISTS (SELECT 1 FROM col WHERE col.tabla = p.tablename AND col.columna = 'player_id')
     AND p.tablename NOT IN (SELECT tabla FROM tablas)
     AND p.w NOT LIKE '%caller_manages_player%'
     AND p.w NOT LIKE '%players%'
     AND p.w NOT LIKE '%service_role%'
  UNION ALL
  -- 8 · INFO. Las guardas son TO authenticated; aquí se ve si anon tiene permiso de
  --     tabla para escribir (sin auth.uid() no pasa las políticas de autor).
  SELECT 8, 'INFO · anon: privilegios INSERT/UPDATE de tabla en las tablas de la 074',
         CASE WHEN to_regrole('anon') IS NULL THEN 'no existe el rol anon'
              ELSE coalesce((SELECT string_agg(t.tabla || ':' || pr.priv, ', ' ORDER BY t.tabla, pr.priv)
                               FROM tablas t CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) pr(priv)
                              WHERE to_regclass('public.' || t.tabla) IS NOT NULL
                                AND has_table_privilege('anon', to_regclass('public.' || t.tabla), pr.priv)), 'ninguno') END,
         'informativo', NULL::boolean
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
