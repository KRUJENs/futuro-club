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
-- Filas 20-31 (por tabla): qué políticas de ESCRITURA de cliente hay hoy, cuántas
-- filas y cuántas tienen un AUTOR (user_id / coach_id) que NO es el dueño del
-- jugador: residuo que la 074 no borra (limpiar es decisión del dueño). Donde la
-- fila dice «MÍNIMO» NO es un recuento exacto de lo escrito por otras cuentas:
--   · idp_goals / idp_milestones / idp_checkins NO tienen columna de autor: se
--     cuentan las filas de planes cuyo coach_id no es el dueño; lo que otra cuenta
--     AÑADIÓ al plan del PROPIO dueño (posible con las políticas de la 047, rama
--     por tenant) no se puede contar. En idp_checkins, un reviewer_id distinto del
--     dueño es una señal débil (reviewer_id lo pone quien escribe).
--   · development_plans.coach_id y videos.user_id los pudo poner OTRA cuenta con
--     las políticas por tenant / organización de antes de la 076 (047, 003, 038).
--   · evaluation_history y player_knowledge no tienen columna de autor: se cuentan
--     las filas con un org_id cuya organización NO es del dueño del jugador.
-- Fila 32: partidos en directo con informe guardado que incluyen eventos de un
-- jugador de OTRA cuenta (su nombre pudo quedar guardado en ese informe).
-- Probada en SIMULACIÓN PGlite (NO en tu base), PostgreSQL 18.3 y 16.4: base
-- vacía, cadena completa y forma verificada de producción (con 073 y 076, solo
-- con 073, sin ninguna), antes y después de la 074.
-- =====================================================================
WITH
-- Las 12 tablas de la 074: autor (columna de quien escribe) y vía al jugador
-- ('org': sin autor; se mira la organización de la fila).
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
         (29, 'scout_insights', 'user_id', 'player'),
         (30, 'evaluation_history', NULL, 'org'),
         (31, 'player_knowledge', NULL, 'org')
),
-- Por qué el recuento de algunas tablas es solo un MÍNIMO (ver cabecera).
notas(tabla, nota) AS (
  VALUES ('development_plans', 'MÍNIMO: coach_id lo pone quien escribe; con idp_plans_coach_write de la 047 (rama por tenant) otra cuenta del mismo tenant pudo crear un plan con coach_id = el dueño o cambiar el plan del dueño, y eso no se distingue'),
         ('idp_goals', 'MÍNIMO: sin columna de autor; lo que otra cuenta añadió o cambió en el plan del PROPIO dueño (posible con idp_goals_via_plan de la 047, rama por tenant) NO se puede contar'),
         ('idp_milestones', 'MÍNIMO: sin columna de autor; lo que otra cuenta añadió o cambió en el plan del PROPIO dueño (posible con idp_milestones_via_plan de la 047, rama por tenant) NO se puede contar'),
         ('idp_checkins', 'MÍNIMO: sin columna de autor; lo que otra cuenta añadió o cambió en el plan del PROPIO dueño (posible con idp_checkins_via_plan de la 047, rama por tenant) NO se puede contar'),
         ('videos', 'MÍNIMO: con videos_tenant_isolation (003, por tenant) o la política de cambio de vídeos de la 038 (rama por organización, sin comprobación de la fila nueva) otra cuenta pudo dejar user_id = el dueño, y eso no se distingue'),
         ('evaluation_history', 'MÍNIMO: sin columna de autor; una fila que otra cuenta escribió con una organización del propio dueño (si user_org_ids() se la devolvía) no se distingue'),
         ('player_knowledge', 'MÍNIMO: sin columna de autor; una fila que otra cuenta escribió con una organización del propio dueño (si user_org_ids() se la devolvía) no se distingue')
),
-- Columnas que usan las guardas (solo se exigen si la tabla existe).
necesarias(tabla, columna) AS (
  VALUES ('fatigue_sessions', 'player_id'), ('development_plans', 'id'), ('development_plans', 'player_id'),
         ('idp_goals', 'plan_id'), ('idp_milestones', 'plan_id'), ('idp_checkins', 'plan_id'),
         ('tracking_sessions', 'player_id'), ('player_analyses', 'player_id'), ('videos', 'player_id'),
         ('live_events', 'player_id'), ('scout_insights', 'player_id'),
         ('evaluation_history', 'player_id'), ('player_knowledge', 'player_id')
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
                     count(*) filter (where x.player_id is not null and p.id is not null and p.user_id is not null
                                        and x.%1$I is not null and x.%1$I::text <> p.user_id::text)::text
                     || '' cuyo autor (%1$s) NO es el dueño · '' ||
                     count(*) filter (where x.player_id is not null and p.id is not null and p.user_id is not null
                                        and x.%1$I is null)::text || '' sin %1$s · '' ||
                     count(*) filter (where x.player_id is not null and (p.id is null or p.user_id is null))::text
                     || '' de un jugador que no existe o sin dueño'' as c
                from public.%2$I x left join public.players p on p.id::text = x.player_id::text',
             t.autor, t.tabla), false, true, '')::text FROM '<c>([^<]*)</c>')
           WHEN t.via = 'org'
                AND (NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = 'player_id')
                     OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = 'org_id')
                     OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'organizations' AND col.columna = 'id')
                     OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'organizations' AND col.columna = 'owner_id'))
             THEN 'sin player_id / org_id u organizations(id, owner_id)'
           WHEN t.via = 'org' THEN substring(query_to_xml(format(
             'select count(*)::text || '' fila(s) · '' ||
                     count(*) filter (where x.player_id is not null and p.id is not null and x.org_id is not null
                                        and o.owner_id is distinct from p.user_id)::text
                     || '' con org_id de una organización cuyo dueño NO es el dueño del jugador · '' ||
                     count(*) filter (where x.player_id is not null and (p.id is null or p.user_id is null))::text
                     || '' de un jugador que no existe o sin dueño'' as c
                from public.%1$I x
                left join public.players p on p.id::text = x.player_id::text
                left join public.organizations o on o.id = x.org_id',
             t.tabla), false, true, '')::text FROM '<c>([^<]*)</c>')
           WHEN to_regclass('public.development_plans') IS NULL
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = t.tabla AND col.columna = 'plan_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'development_plans' AND col.columna = 'coach_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'development_plans' AND col.columna = 'player_id')
             THEN 'sin plan_id o development_plans(coach_id, player_id)'
           -- Sin columna de autor: se cuenta por el coach_id del PLAN. En idp_checkins se
           -- añade reviewer_id distinto del dueño como señal débil (lo pone quien escribe).
           ELSE substring(query_to_xml(format(
             'select count(*)::text || '' fila(s) · '' ||
                     count(*) filter (where d.id is not null and p.id is not null and p.user_id is not null
                                        and (d.coach_id is null or d.coach_id::text <> p.user_id::text))::text
                     || '' en planes cuyo coach_id NO es el dueño del jugador o está vacío'' %2$s || '' · '' ||
                     count(*) filter (where d.id is not null and (p.id is null or p.user_id is null))::text
                     || '' en planes de un jugador que no existe o sin dueño'' as c
                from public.%1$I x
                left join public.development_plans d on d.id = x.plan_id
                left join public.players p on p.id::text = d.player_id::text',
             t.tabla,
             CASE WHEN t.tabla = 'idp_checkins'
                       AND EXISTS (SELECT 1 FROM col WHERE col.tabla = 'idp_checkins' AND col.columna = 'reviewer_id')
                  THEN ' || '' · '' || count(*) filter (where d.id is not null and p.id is not null and p.user_id is not null
                                                          and x.reviewer_id is not null and x.reviewer_id::text <> p.user_id::text)::text
                        || '' con reviewer_id que NO es el dueño del jugador (señal débil: reviewer_id lo pone quien escribe)'''
                  ELSE '' END), false, true, '')::text FROM '<c>([^<]*)</c>')
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
  --      regla; ver docs/pendientes-metricas.md). Una regla que menciona players
  --      pero lleva una rama por organización o tenant también sale aquí.
  SELECT 11, 'INFO · OTRAS tablas con player_id y escrituras de cliente que no miran al dueño del jugador (la 074 NO las cubre)',
         coalesce(string_agg(e.tablename || ':' || e.policyname, ', ' ORDER BY e.tablename, e.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM escr e
   WHERE EXISTS (SELECT 1 FROM col WHERE col.tabla = e.tablename AND col.columna = 'player_id')
     AND e.tablename NOT IN (SELECT tabla FROM tablas)
     AND e.w NOT LIKE '%caller_manages_player%'
     AND (e.w NOT LIKE '%players%' OR e.w ~ '(user_org_ids|user_in_org|tenant)')
     AND e.w NOT LIKE '%service_role%'
  UNION ALL
  -- 20-31 · INFO por tabla (+ por qué es solo un MÍNIMO donde lo es).
  SELECT pt.n, 'INFO · ' || pt.tabla || ': escrituras de cliente hoy (política:cmd) | datos',
         pt.escrituras || ' | ' || coalesce(pt.datos, 'sin datos') || coalesce(' | ' || nt.nota, ''),
         'informativo (la 074 no borra ni cambia filas)', NULL::boolean
    FROM por_tabla pt LEFT JOIN notas nt ON nt.tabla = pt.tabla
  UNION ALL
  -- 32 · INFO. /api/live/aggregate buscaba los nombres de los jugadores de los
  --      eventos SIN filtrar por dueño y guarda el informe en
  --      live_matches.analysis_result (lo devuelve después tal cual). Un partido con
  --      un evento de un jugador de OTRA cuenta pudo guardar el NOMBRE de ese menor
  --      (en stats_by_player y en el texto del informe). Borrarlos o recalcularlos
  --      es decisión del dueño.
  SELECT 32, 'INFO · live_matches: partidos con informe guardado (analysis_result) y algún evento de un jugador cuyo dueño NO es el autor del partido',
         CASE
           WHEN to_regclass('public.live_matches') IS NULL OR to_regclass('public.live_events') IS NULL
             THEN 'live_matches o live_events no existe'
           WHEN NOT b.players_ok OR NOT b.owner_ok THEN 'players(id, user_id) no existe'
           WHEN NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'live_matches' AND col.columna = 'id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'live_matches' AND col.columna = 'user_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'live_matches' AND col.columna = 'analysis_result')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'live_events' AND col.columna = 'match_id')
                OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'live_events' AND col.columna = 'player_id')
             THEN 'sin live_matches(id, user_id, analysis_result) o live_events(match_id, player_id)'
           ELSE substring(query_to_xml(
             'select count(*)::text || '' partido(s) con informe guardado y algún evento de un jugador cuyo dueño NO es el autor del partido o que no tiene dueño: ese informe pudo guardar el NOMBRE del jugador'' as c
                from public.live_matches m
               where m.analysis_result is not null
                 and exists (select 1 from public.live_events e
                               join public.players p on p.id::text = e.player_id::text
                              where e.match_id::text = m.id::text
                                and (p.user_id is null or p.user_id::text <> m.user_id::text))',
             false, true, '')::text FROM '<c>([^<]*)</c>')
         END,
         'informativo (la 074 no borra ni cambia filas; limpiar esos informes es decisión del dueño)', NULL::boolean
    FROM base b
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
