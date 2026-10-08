-- =====================================================================
-- VITAS · 074 · COMPROBACIÓN PREVIA · SOLO LECTURA
-- Ejecútala ANTES de la migración 074 (y DESPUÉS de la 076 o la 073, con su
-- comprobación posterior en verde) y manda el resultado COMPLETO.
--   · Fila «BLOQUEA» con ok = false  →  NO apliques la 074; manda el resultado.
--   · ok vacío (NULL) = fila informativa: no bloquea, pero mándala también.
-- No escribe nada (una sola consulta SELECT). No falla si faltan tablas,
-- columnas o funciones: usa to_regclass / to_regprocedure / pg_attribute, y los
-- conteos de datos se hacen con query_to_xml SOLO cuando la tabla y sus columnas
-- existen.
-- Filas 20-29 (por tabla): qué políticas de ESCRITURA de cliente hay hoy, cuántas
-- filas y cuántas las escribió alguien que NO es el dueño del jugador (residuo que
-- la 074 no borra; limpiar es decisión del dueño).
-- Probada en SIMULACIÓN PGlite (NO en tu base), PostgreSQL 18.3 y 16.4: base
-- vacía, cadena completa y forma verificada de producción (con 073 y 076, solo
-- con 073, sin ninguna), antes y después de la 074.
-- =====================================================================
WITH
-- Las 10 tablas de la 074: autor (columna de quien escribe) y vía al jugador.
tablas(n, tabla, autor, via) AS (
  VALUES (20, 'fatigue_sessions', 'user_id', 'player'),
         (21, 'development_plans', 'coach_id', 'player'),
         (22, 'idp_goals', NULL, 'plan'),
         (23, 'idp_milestones', NULL, 'plan'),
         (24, 'idp_checkins', NULL, 'plan'),
         (25, 'tracking_sessions', 'user_id', 'player'),
         (26, 'player_analyses', 'user_id', 'player'),
         (27, 'videos', 'user_id', 'player'),
         (28, 'live_events', 'user_id', 'player'),
         (29, 'scout_insights', 'user_id', 'player')
),
-- Columnas que usan las guardas (solo se exigen si la tabla existe).
necesarias(tabla, columna) AS (
  VALUES ('fatigue_sessions', 'player_id'), ('development_plans', 'id'), ('development_plans', 'player_id'),
         ('idp_goals', 'plan_id'), ('idp_milestones', 'plan_id'), ('idp_checkins', 'plan_id'),
         ('tracking_sessions', 'player_id'), ('player_analyses', 'player_id'), ('videos', 'player_id'),
         ('live_events', 'player_id'), ('scout_insights', 'player_id')
),
col AS (
  SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
),
-- q = USING normalizado (minúsculas, sin casts ni espacios/paréntesis/comillas);
-- w = la regla que se aplica a la fila NUEVA (WITH CHECK, o USING si no hay).
pol AS (
  SELECT tablename, policyname, cmd, permissive, roles,
         regexp_replace(regexp_replace(lower(coalesce(qual, '')), '::[a-z_]+( varying| precision)?', '', 'g'),
                        '[[:space:]()"]', '', 'g') AS q,
         lower(coalesce(with_check, qual, '')) AS w
    FROM pg_policies
   WHERE schemaname = 'public'
),
-- Escrituras de cliente: PERMISSIVE, INSERT/UPDATE/ALL, no solo para service_role.
escr AS (
  SELECT * FROM pol
   WHERE permissive = 'PERMISSIVE' AND cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND roles <> ARRAY['service_role']::name[]
),
helper AS (
  SELECT to_regprocedure('public.caller_manages_player(text)') AS f
),
base AS (
  SELECT to_regclass('public.players') IS NOT NULL AS players_ok,
         EXISTS (SELECT 1 FROM col WHERE col.tabla = 'players' AND col.columna = 'user_id') AS owner_ok
),
-- Conteo por tabla (solo si la tabla y sus columnas existen).
por_tabla AS (
  SELECT t.n, t.tabla,
         CASE
           WHEN to_regclass('public.' || t.tabla) IS NULL THEN 'tabla no existe (la 074 la salta)'
           WHEN NOT b.players_ok OR NOT b.owner_ok THEN 'players(id, user_id) no existe'
           WHEN t.via = 'player'
                AND (NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = 'player_id')
                     OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = t.autor))
             THEN 'sin player_id o sin ' || t.autor
           WHEN t.via = 'player' THEN substring(query_to_xml(format(
             'select count(*)::text || '' fila(s) · '' ||
                     count(*) filter (where x.player_id is not null and p.id is not null
                                        and x.%1$I is distinct from p.user_id)::text || '' de autor que NO es el dueño · '' ||
                     count(*) filter (where x.player_id is not null and (p.id is null or p.user_id is null))::text
                     || '' de un jugador que no existe o sin dueño'' as c
                from public.%2$I x left join public.players p on p.id::text = x.player_id::text',
             t.autor, t.tabla), false, true, '')::text FROM '<c>([^<]*)</c>')
           WHEN to_regclass('public.development_plans') IS NULL
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = 'plan_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'development_plans' AND col.columna = 'coach_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'development_plans' AND col.columna = 'player_id')
             THEN 'sin plan_id o development_plans(coach_id, player_id)'
           ELSE substring(query_to_xml(format(
             'select count(*)::text || '' fila(s) · '' ||
                     count(*) filter (where d.id is not null and p.id is not null
                                        and d.coach_id is distinct from p.user_id)::text
                     || '' en planes cuyo autor (coach_id) NO es el dueño del jugador'' as c
                from public.%1$I x
                left join public.development_plans d on d.id = x.plan_id
                left join public.players p on p.id::text = d.player_id::text',
             t.tabla), false, true, '')::text FROM '<c>([^<]*)</c>')
         END AS datos,
         coalesce((SELECT string_agg(e.policyname || ':' || e.cmd, ', ' ORDER BY e.policyname)
                     FROM escr e WHERE e.tablename = t.tabla), 'ninguna') AS escrituras
    FROM tablas t CROSS JOIN base b
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · BLOQUEA. El helper compara players.id::text con el player_id de la fila y
  --     players.user_id con auth.uid() (uuid).
  SELECT 1, 'BLOQUEA · players: columnas id / user_id',
         r, 'id:text · user_id:uuid', r = 'id:text · user_id:uuid'
    FROM (SELECT coalesce((SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ' · ' ORDER BY attname)
                             FROM pg_attribute
                            WHERE attrelid = to_regclass('public.players')
                              AND attname IN ('id', 'user_id') AND NOT attisdropped),
                          'players no existe') AS r) x
  UNION ALL
  -- 2 · BLOQUEA. auth.uid() (Supabase) lo usa el helper.
  SELECT 2, 'BLOQUEA · auth.uid() existe',
         (to_regprocedure('auth.uid()') IS NOT NULL)::text, 'true', to_regprocedure('auth.uid()') IS NOT NULL
  UNION ALL
  -- 3 · BLOQUEA. La 074 REUTILIZA el helper de la 073/076: tiene que existir, ser
  --     SECURITY INVOKER y solo dueño (sin tenant ni organización). Si no existe:
  --     aplica antes la 076 (o la 073). La propia 074 aborta en ese caso.
  SELECT 3, 'BLOQUEA · public.caller_manages_player(text): existe · security invoker · solo dueño',
         CASE WHEN h.f IS NULL THEN 'no existe (aplica antes la 076 o la 073)'
              ELSE 'true · ' || (NOT p.prosecdef)::text || ' · '
                   || (p.prosrc !~* '(tenant|org|team_member)'
                       AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)')::text END,
         'true · true · true',
         h.f IS NOT NULL AND NOT p.prosecdef AND p.prosrc !~* '(tenant|org|team_member)'
           AND p.prosrc ~* 'user_id[[:space:]]*=[[:space:]]*\([[:space:]]*select[[:space:]]+auth\.uid\(\)[[:space:]]*\)'
    FROM helper h LEFT JOIN pg_proc p ON p.oid = h.f
  UNION ALL
  -- 4 · BLOQUEA. El helper es SECURITY INVOKER: sin una política de players que
  --     deje al dueño leer SU jugador, devolvería false también al dueño y sus
  --     escrituras (p. ej. el upsert de vídeos del navegador) fallarían.
  SELECT 4, 'BLOQUEA · players: políticas SELECT/ALL de dueño (user_id = auth.uid()) para authenticated',
         count(*)::text, '1 o más', count(*) >= 1
    FROM pol
   WHERE tablename = 'players' AND permissive = 'PERMISSIVE'
     AND cmd IN ('SELECT', 'ALL')
     AND roles && ARRAY['authenticated', 'public']::name[]
     AND (q ~ 'user_id=(select)?auth\.uid' OR q ~ 'auth\.uid(asuid)?=([a-z0-9_]+\.)*user_id')
  UNION ALL
  -- 5 · BLOQUEA. Sin RLS las guardas no harían nada, y la 074 NO la activa (también
  --     cambiaría quién LEE). La propia 074 aborta en ese caso.
  SELECT 5, 'BLOQUEA · tablas de la 074 que existen SIN RLS activada',
         coalesce(string_agg(t.tabla, ', ' ORDER BY t.tabla), 'ninguna'), 'ninguna', count(*) = 0
    FROM tablas t JOIN pg_class c ON c.oid = to_regclass('public.' || t.tabla)
   WHERE NOT c.relrowsecurity
  UNION ALL
  -- 6 · BLOQUEA. Columnas que usan las guardas (de las tablas que existen).
  SELECT 6, 'BLOQUEA · columnas que usan las guardas y que faltan',
         coalesce(string_agg(nc.tabla || '.' || nc.columna, ', ' ORDER BY nc.tabla, nc.columna), 'ninguna'),
         'ninguna', count(*) = 0
    FROM necesarias nc
   WHERE to_regclass('public.' || nc.tabla) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = nc.tabla AND col.columna = nc.columna)
  UNION ALL
  -- 7 · INFO. La 074 se salta las que no existan.
  SELECT 7, 'INFO · tablas de la 074 que NO existen (la 074 las salta)',
         coalesce(string_agg(tabla, ', ' ORDER BY tabla), 'ninguna'), 'informativo', NULL::boolean
    FROM tablas WHERE to_regclass('public.' || tabla) IS NULL
  UNION ALL
  -- 8 · INFO. De qué migración es el helper que va a usar la 074.
  SELECT 8, 'INFO · comentario del helper (073 · / 076 ·)',
         coalesce(left(obj_description(h.f, 'pg_proc'), 6), CASE WHEN h.f IS NULL THEN 'no existe' ELSE 'sin comentario' END),
         'informativo', NULL::boolean
    FROM helper h
  UNION ALL
  -- 9 · INFO. Políticas de la 047 en los planes IDP (si siguen, la 076 no está
  --     aplicada). La 074 cierra igualmente las ESCRITURAS de quien no es dueño; la
  --     LECTURA por tenant la cierra la 076.
  SELECT 9, 'INFO · planes IDP: políticas de la 047 aún vivas (la 076 las retira)',
         coalesce(string_agg(tablename || ':' || policyname, ', ' ORDER BY tablename, policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol
   WHERE (tablename, policyname) IN (('development_plans', 'idp_plans_owner_read'), ('development_plans', 'idp_plans_coach_write'),
                                     ('idp_goals', 'idp_goals_via_plan'), ('idp_milestones', 'idp_milestones_via_plan'),
                                     ('idp_checkins', 'idp_checkins_via_plan'))
  UNION ALL
  -- 10 · INFO. Las guardas son TO authenticated. anon no pasa las políticas de
  --      autor (auth.uid() es NULL); aquí se ve si además tiene permiso de tabla.
  SELECT 10, 'INFO · anon: privilegios INSERT/UPDATE de tabla en las tablas de la 074',
         CASE WHEN to_regrole('anon') IS NULL THEN 'no existe el rol anon'
              ELSE coalesce((SELECT string_agg(t.tabla || ':' || pr.priv, ', ' ORDER BY t.tabla, pr.priv)
                               FROM tablas t CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) pr(priv)
                              WHERE to_regclass('public.' || t.tabla) IS NOT NULL
                                AND has_table_privilege('anon', to_regclass('public.' || t.tabla), pr.priv)), 'ninguno') END,
         'informativo', NULL::boolean
  UNION ALL
  -- 11 · INFO. OTRAS tablas con player_id cuyas escrituras de cliente no miran al
  --      dueño del jugador y que la 074 NO cubre (en el repositorio: tracking_jobs,
  --      que arregla el PR #308; match_events y player_session_metrics, con otra
  --      regla; ver docs/pendientes-metricas.md).
  SELECT 11, 'INFO · OTRAS tablas con player_id y escrituras de cliente que no miran al dueño del jugador (la 074 NO las cubre)',
         coalesce(string_agg(e.tablename || ':' || e.policyname, ', ' ORDER BY e.tablename, e.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM escr e
   WHERE EXISTS (SELECT 1 FROM col WHERE col.tabla = e.tablename AND col.columna = 'player_id')
     AND e.tablename NOT IN (SELECT tabla FROM tablas)
     AND e.w NOT LIKE '%caller_manages_player%'
     AND e.w NOT LIKE '%players%'
     AND e.w NOT LIKE '%service_role%'
  UNION ALL
  -- 20-29 · INFO por tabla.
  SELECT pt.n, 'INFO · ' || pt.tabla || ': escrituras de cliente hoy (política:cmd) | datos',
         pt.escrituras || ' | ' || coalesce(pt.datos, 'sin datos'),
         'informativo (la 074 no borra ni cambia filas)', NULL::boolean
    FROM por_tabla pt
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
