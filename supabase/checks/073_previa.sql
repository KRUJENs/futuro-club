-- =====================================================================
-- VITAS · 073 · COMPROBACIÓN PREVIA · SOLO LECTURA
-- Ejecútala ANTES de la migración 073 y manda el resultado completo.
--   · Si ALGUNA fila tiene ok = false  →  NO apliques la 073; manda el resultado.
--   · ok vacío (NULL) = fila informativa: no bloquea, pero mándala también.
-- Bloquean las filas 1, 3, 4, 5, 10 y 21. La 073 es SOLO DUEÑO (decisión del
-- 30 sep 2026): las filas de tenant (2, 6, 13, 17, 18, 19, 20) solo informan de
-- lo que se ha evitado o de lo que queda abierto fuera de la 073; ninguna bloquea.
-- No escribe nada (una sola consulta SELECT). No falla si faltan tablas o
-- funciones: usa to_regclass / to_regprocedure, y los conteos de datos se hacen
-- con query_to_xml SOLO cuando la tabla y sus columnas existen.
-- Probada en SIMULACIÓN PGlite (NO en tu base), PostgreSQL 18.3 y 16.4: base
-- vacía, cadena completa y forma verificada de producción (con y sin la 050),
-- con usuarios que comparten el tenant de los jugadores en varias escrituras
-- del uuid (minúsculas, MAYÚSCULAS, {llaves}, sin guiones, no uuid).
-- =====================================================================
WITH
tablas(tabla) AS (
  VALUES ('behavioral_profiles'), ('attendance_records'), ('engagement_snapshots'),
         ('wellbeing_questionnaires'), ('dropout_risk_assessments'),
         ('player_metric_snapshots'), ('player_injuries'), ('player_valuations')
),
-- Las 6 tablas en las que una rama por tenant habría dado acceso de cliente.
tablas6(tabla) AS (
  SELECT tabla FROM tablas WHERE tabla NOT IN ('player_injuries', 'player_valuations')
),
-- Políticas que la 073 espera encontrar y retira (044 / 050), las de service_role
-- de la 072 (no las toca), las que crea ella misma (*_owner) y las de su versión
-- anterior (*_owner_or_tenant, que retira). NO están snapshots_insert_own ni
-- valuations_insert_own (044, WITH CHECK (true) para todos): si aparecen, la 072
-- no llegó a retirarlas (044 aplicada después) y la fila 10 bloquea.
conocidas(tabla, politica) AS (
  VALUES ('behavioral_profiles', 'behavioral_owner_all'),
         ('attendance_records', 'attendance_owner_all'),
         ('engagement_snapshots', 'engagement_owner_all'),
         ('wellbeing_questionnaires', 'questionnaires_owner_all'),
         ('dropout_risk_assessments', 'dropout_owner_all'),
         ('player_injuries', 'org_members_read_injuries'),
         ('player_injuries', 'org_members_insert_injuries'),
         ('player_injuries', 'org_members_update_injuries'),
         ('player_metric_snapshots', 'snapshots_read_own'),
         ('player_metric_snapshots', 'snapshots_insert_service_role'),
         ('player_valuations', 'valuations_read_own'),
         ('player_valuations', 'valuations_insert_service_role'),
         -- las 15 que crea la 073 (solo dueño)
         ('behavioral_profiles', 'behavioral_profiles_select_owner'),
         ('behavioral_profiles', 'behavioral_profiles_insert_owner'),
         ('behavioral_profiles', 'behavioral_profiles_update_owner'),
         ('attendance_records', 'attendance_records_select_owner'),
         ('attendance_records', 'attendance_records_insert_owner'),
         ('attendance_records', 'attendance_records_update_owner'),
         ('engagement_snapshots', 'engagement_snapshots_select_owner'),
         ('engagement_snapshots', 'engagement_snapshots_insert_owner'),
         ('engagement_snapshots', 'engagement_snapshots_update_owner'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_select_owner'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_insert_owner'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_update_owner'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_select_owner'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_insert_owner'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_update_owner'),
         -- las 16 de la versión anterior de la 073 (dueño O tenant; la 073 las retira)
         ('behavioral_profiles', 'behavioral_profiles_select_owner_or_tenant'),
         ('behavioral_profiles', 'behavioral_profiles_insert_owner_or_tenant'),
         ('behavioral_profiles', 'behavioral_profiles_update_owner_or_tenant'),
         ('attendance_records', 'attendance_records_select_owner_or_tenant'),
         ('attendance_records', 'attendance_records_insert_owner_or_tenant'),
         ('attendance_records', 'attendance_records_update_owner_or_tenant'),
         ('engagement_snapshots', 'engagement_snapshots_select_owner_or_tenant'),
         ('engagement_snapshots', 'engagement_snapshots_insert_owner_or_tenant'),
         ('engagement_snapshots', 'engagement_snapshots_update_owner_or_tenant'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_select_owner_or_tenant'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_insert_owner_or_tenant'),
         ('wellbeing_questionnaires', 'wellbeing_questionnaires_update_owner_or_tenant'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_select_owner_or_tenant'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_insert_owner_or_tenant'),
         ('dropout_risk_assessments', 'dropout_risk_assessments_update_owner_or_tenant'),
         ('player_metric_snapshots', 'player_metric_snapshots_select_owner_or_tenant')
),
-- Expresiones normalizadas (minúsculas, sin casts, sin espacios/comillas). q además
-- sin paréntesis; qp los conserva (para distinguir la FUNCIÓN tenant_id() de la
-- columna tenant_id). Ojo: con public en el search_path, pg_policies escribe
-- «tenant_id()» sin «public.»; por eso el esquema es opcional en los patrones.
-- cp = lo mismo para WITH CHECK (si no hay, PostgreSQL usa USING como check).
pol AS (
  SELECT tablename, policyname, cmd, roles, permissive,
         regexp_replace(regexp_replace(lower(coalesce(qual, '')), '::[a-z_]+( varying| precision)?', '', 'g'),
                        '[[:space:]()"]', '', 'g') AS q,
         regexp_replace(regexp_replace(lower(coalesce(qual, '')), '::[a-z_]+( varying| precision)?', '', 'g'),
                        '[[:space:]"]', '', 'g') AS qp,
         regexp_replace(regexp_replace(lower(coalesce(with_check, qual, '')), '::[a-z_]+( varying| precision)?', '', 'g'),
                        '[[:space:]"]', '', 'g') AS cp
    FROM pg_policies
   WHERE schemaname = 'public'
),
pl AS (
  SELECT to_regclass('public.players') IS NOT NULL AS existe,
         EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.players')
                    AND attname = 'tenant_id' AND NOT attisdropped) AS con_tenant,
         EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.players')
                    AND attname = 'tenant_id' AND NOT attisdropped
                    AND atttypid = 'uuid'::regtype) AS tenant_uuid,
         EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.players')
                    AND attname = 'user_id' AND NOT attisdropped) AS con_user,
         EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('auth.users')
                    AND attname = 'raw_app_meta_data' AND NOT attisdropped) AS con_app_meta
),
-- Resolución del tenant de cada usuario IGUAL que el hook 057 + public.tenant_id():
-- el hook copia app_metadata ->> 'tenant_id' al claim raíz (si no es NULL ni '';
-- 057:42-50) y public.tenant_id() hace NULLIF(claim, '')::uuid (003:126-131). Se
-- convierte a uuid SOLO si el texto cumple la regla de entrada de uuid de
-- PostgreSQL (llaves opcionales; guion opcional tras cada grupo de 4 hex salvo el
-- último; sin espacios); así no falla con valores que no son uuid y compara como
-- uuid, no como texto (MAYÚSCULAS, {llaves} o sin guiones cuentan igual). Sin
-- pg_input_is_valid (solo existe desde PostgreSQL 16).
re AS (
  SELECT '^([{][0-9a-f]{4}(-?[0-9a-f]{4}){7}[}]|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'::text AS uuid_re
),
-- Consulta base (texto) de «usuario NO dueño cuyo tenant (uuid) coincide con el
-- del jugador». La usan las filas 13 y 17.
alcance AS (
  SELECT format(
           'select u.id as uid, p.id::text as pid
              from auth.users u
             cross join lateral (select nullif(u.raw_app_meta_data ->> %L, %L) as t) m
              join public.players p
                on p.tenant_id is not null
               and p.tenant_id = (case when m.t ~* %L then m.t::uuid end)
             where p.user_id is distinct from u.id',
           'tenant_id', '', re.uuid_re) AS q
    FROM re
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · BLOQUEA. Tipos que da por hechos la 073 (helper con p_player_id text y
  --     players.user_id = auth.uid(), que es uuid).
  SELECT 1, 'players: columnas id / user_id',
         r, 'id:text · user_id:uuid', r = 'id:text · user_id:uuid'
    FROM (SELECT coalesce((SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ' · ' ORDER BY attname)
                             FROM pg_attribute
                            WHERE attrelid = to_regclass('public.players')
                              AND attname IN ('id', 'user_id') AND NOT attisdropped),
                          'players no existe') AS r) x
  UNION ALL
  -- 2 · INFO. La 073 (solo dueño) NO usa players.tenant_id ni public.tenant_id();
  --     solo sirven para medir las filas 13, 17, 18 y 19.
  SELECT 2, 'players.tenant_id (tipo) · public.tenant_id() existe (la 073 no los usa)',
         coalesce((SELECT 'tenant_id:' || format_type(atttypid, atttypmod) FROM pg_attribute
                    WHERE attrelid = to_regclass('public.players') AND attname = 'tenant_id' AND NOT attisdropped),
                  'sin columna tenant_id')
           || ' · public.tenant_id(): ' || (to_regprocedure('public.tenant_id()') IS NOT NULL)::text,
         'informativo', NULL::boolean
  UNION ALL
  -- 3 · BLOQUEA. Nadie más usa ya el nombre del helper (CREATE OR REPLACE lo pisaría).
  --     La de la 076 (PR #307, mismo cuerpo solo dueño, COMMENT «076 ·») no cuenta:
  --     la 073 la conserva. Mismo criterio que la fila 3 de la previa de la 076.
  SELECT 3, 'funciones public.caller_manages_player que NO son de la 073 ni de la 076',
         count(*)::text, '0', count(*) = 0
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'caller_manages_player'
     AND coalesce(obj_description(p.oid, 'pg_proc'), '') NOT LIKE '073 ·%'
     AND coalesce(obj_description(p.oid, 'pg_proc'), '') NOT LIKE '076 ·%'
  UNION ALL
  -- 4 · BLOQUEA. El helper es SECURITY INVOKER: lee players con los permisos de quien consulta.
  SELECT 4, 'authenticated puede hacer SELECT en players',
         r, 'true', r = 'true'
    FROM (SELECT CASE WHEN to_regclass('public.players') IS NULL OR to_regrole('authenticated') IS NULL THEN 'no aplica'
                      ELSE has_table_privilege('authenticated', to_regclass('public.players'), 'SELECT')::text END AS r) x
  UNION ALL
  -- 5 · BLOQUEA. Sin una política de players que deje al dueño leer SU jugador, la 073
  --     quedaría inerte (cerrada, no abre nada). Deben salir 1 o más.
  SELECT 5, 'players: políticas SELECT/ALL de dueño (user_id = auth.uid()) para authenticated',
         count(*)::text, '1 o más', count(*) >= 1
    FROM pol
   WHERE tablename = 'players' AND permissive = 'PERMISSIVE'
     AND cmd IN ('SELECT', 'ALL')
     AND roles && ARRAY['authenticated', 'public']::name[]
     AND (q ~ 'user_id=(select)?auth\.uid' OR q ~ 'auth\.uid(asuid)?=([a-z0-9_]+\.)*user_id')
  UNION ALL
  -- 6 · INFO. Vía por tenant en la RLS de la PROPIA tabla players (p. ej.
  --     players_tenant_isolation de 003, FOR ALL). La 073 NO la cierra: con ella un
  --     compañero de tenant ve la ficha del jugador (y ver fila 20). Previsto para
  --     una migración posterior (076); pendiente en docs §5-D.
  SELECT 6, 'players: políticas SELECT/UPDATE/ALL por tenant (public.tenant_id()) · la 073 NO las cierra',
         count(*)::text || coalesce(' · ' || string_agg(policyname || ':' || cmd, ', ' ORDER BY policyname), ''),
         'informativo', NULL::boolean
    FROM pol
   WHERE tablename = 'players' AND cmd IN ('SELECT', 'UPDATE', 'ALL')
     AND (qp ~ 'tenant_id=\(?(select)?(public\.)?tenant_id\(\)'
          OR qp ~ '(public\.)?tenant_id\(\)\)?=([a-z0-9_]+\.)*tenant_id')
  UNION ALL
  -- 7 · INFO. RLS de players.
  SELECT 7, 'players: RLS activada',
         coalesce((SELECT relrowsecurity::text FROM pg_class WHERE oid = to_regclass('public.players')), 'players no existe'),
         'informativo', NULL::boolean
  UNION ALL
  -- 8 · INFO. La 073 se salta las que no existan (p. ej. si la 044 no está aplicada).
  SELECT 8, 'tablas de la 073 que NO existen',
         coalesce(string_agg(tabla, ', ' ORDER BY tabla), 'ninguna'), 'informativo', NULL::boolean
    FROM tablas WHERE to_regclass('public.' || tabla) IS NULL
  UNION ALL
  -- 9 · INFO. Las políticas de la 073 convierten player_id a text.
  SELECT 9, 'tablas cuyo player_id NO es text',
         coalesce(string_agg(t.tabla || ':' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY t.tabla), 'ninguna'),
         'informativo', NULL::boolean
    FROM tablas t
    JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || t.tabla) AND a.attname = 'player_id' AND NOT a.attisdropped
   WHERE format_type(a.atttypid, a.atttypmod) <> 'text'
  UNION ALL
  -- 10 · BLOQUEA. Una política que la 073 no conoce seguiría ahí y podría dar acceso
  --      (la propia 073 también aborta en ese caso: su GUARDA). Si salen
  --      snapshots_insert_own / valuations_insert_own: vuelve a ejecutar el bloque
  --      «044 · player_metric_snapshots / player_valuations» de la 072 y repite.
  SELECT 10, 'políticas DESCONOCIDAS en las 8 tablas',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol p
    JOIN tablas t ON t.tabla = p.tablename
   WHERE NOT EXISTS (SELECT 1 FROM conocidas c WHERE c.tabla = p.tablename AND c.politica = p.policyname)
  UNION ALL
  -- 11 · INFO. Registro de lo que hay hoy (se reemplaza).
  SELECT 11, 'políticas actuales en las 8 tablas',
         coalesce(string_agg(p.tablename || ':' || p.policyname || ':' || p.cmd, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p JOIN tablas t ON t.tabla = p.tablename
  UNION ALL
  -- 12 · INFO. Producción (verificado 29-30 sep): 3 · 0 · 0.
  SELECT 12, 'jugadores: total · sin user_id · sin tenant_id',
         CASE WHEN NOT pl.existe THEN 'players no existe'
              WHEN NOT pl.con_user THEN 'players sin columna user_id'
              WHEN NOT pl.con_tenant THEN substring(query_to_xml(
                'select count(*)::text || '' · '' || count(*) filter (where user_id is null)::text || '' · sin columna tenant_id'' as c from public.players',
                false, true, '')::text from '<c>([^<]*)</c>')
              ELSE substring(query_to_xml(
                'select count(*)::text || '' · '' || count(*) filter (where user_id is null)::text || '' · '' || count(*) filter (where tenant_id is null)::text as c from public.players',
                false, true, '')::text from '<c>([^<]*)</c>')
         END,
         'informativo', NULL::boolean
    FROM pl
  UNION ALL
  -- 13 · INFO (lo EVITADO). Usuarios que NO son dueños de un jugador pero cuyo tenant
  --      (resuelto como el hook 057 + public.tenant_id(), comparado como uuid) es el
  --      de ese jugador. Con una rama «dueño O mismo tenant» habrían visto y escrito
  --      el bienestar de esos menores (con el hook activo). La 073 solo dueño NO
  --      les da acceso. Si la fila 6 > 0, esos mismos usuarios siguen viendo la
  --      ficha del jugador por la RLS de players (no lo cierra la 073).
  SELECT 13, 'usuarios NO dueños que habrían entrado con una rama por tenant (evitado) · jugadores',
         CASE WHEN NOT pl.existe OR NOT pl.con_user THEN 'no aplica (sin players.user_id)'
              WHEN NOT pl.con_tenant THEN 'no aplica (players sin tenant_id)'
              WHEN NOT pl.tenant_uuid THEN 'no aplica (players.tenant_id no es uuid)'
              WHEN NOT pl.con_app_meta THEN 'no aplica (sin auth.users.raw_app_meta_data)'
              ELSE substring(query_to_xml(
                'select count(distinct a.uid)::text || '' usuario(s) · '' || count(distinct a.pid)::text || '' jugador(es)'' as c from ('
                  || al.q || ') a',
                false, true, '')::text from '<c>([^<]*)</c>')
         END,
         'informativo', NULL::boolean
    FROM pl, alcance al
  UNION ALL
  -- 14 · INFO. La 073 retira la rama created_by = auth.uid() de player_injuries (044):
  --      con solo dueño, quien creó la fila sin ser dueño deja de verla desde el
  --      navegador (no hay llamador de navegador; el servidor usa service_role).
  SELECT 14, 'player_injuries: filas con created_by (con solo dueño dejan de verse desde el navegador)',
         CASE WHEN to_regclass('public.player_injuries') IS NULL THEN 'tabla no existe'
              WHEN NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.player_injuries')
                                  AND attname = 'created_by' AND NOT attisdropped) THEN 'sin columna created_by'
              ELSE substring(query_to_xml('select count(*) filter (where created_by is not null)::text as c from public.player_injuries',
                                          false, true, '')::text from '<c>([^<]*)</c>')
         END,
         'informativo', NULL::boolean
  UNION ALL
  -- 15 · INFO. Filas que hay hoy. Las de las 5 tablas de bienestar/perfil son lo que
  --      cada DUEÑO empezará a ver de sus jugadores tras la 073; las de
  --      player_metric_snapshots siguen sin verse desde el navegador (lectura retenida).
  SELECT 15, 'filas por tabla',
         string_agg(t.tabla || '=' || CASE WHEN to_regclass('public.' || t.tabla) IS NULL THEN 'no existe'
                                           ELSE substring(query_to_xml(format('select count(*)::text as c from public.%I', t.tabla),
                                                                       false, true, '')::text from '<c>([^<]*)</c>') END,
                    ' · ' ORDER BY t.tabla),
         'informativo', NULL::boolean
    FROM tablas t
  UNION ALL
  -- 16 · INFO. Si la función del hook existe y si su cuerpo lee user_metadata (que el
  --      propio usuario puede escribir; el del repo, 057, lee app_metadata). Se busca
  --      la clave entre comillas ('user_metadata') o raw_user_meta_data, no la palabra
  --      suelta: el cuerpo de 057 la nombra en un comentario. Si está ACTIVADA solo se
  --      ve en Dashboard > Authentication > Hooks (no por SQL).
  SELECT 16, 'función del hook 057 (custom_access_token_hook): existe · su cuerpo lee user_metadata',
         CASE WHEN to_regprocedure('public.custom_access_token_hook(jsonb)') IS NULL THEN 'no existe'
              ELSE 'existe · lee user_metadata: '
                   || (pg_get_functiondef(to_regprocedure('public.custom_access_token_hook(jsonb)'))
                         ~* '''user_metadata''|raw_user_meta')::text END
           || ' · activación: mirar Dashboard > Authentication > Hooks',
         'informativo', NULL::boolean
  UNION ALL
  -- 17 · INFO (lo EVITADO, por tabla). Filas de cada tabla que la rama por tenant
  --      habría dejado ver a usuarios NO dueños (misma resolución que la fila 13).
  SELECT 17, 'filas por tabla que una rama por tenant habría expuesto a NO dueños (evitado)',
         CASE WHEN NOT (pl.existe AND pl.con_user AND pl.con_tenant AND pl.tenant_uuid AND pl.con_app_meta)
                THEN 'no aplica (ver fila 13)'
              ELSE (SELECT string_agg(t.tabla || '=' ||
                             CASE WHEN to_regclass('public.' || t.tabla) IS NULL THEN 'no existe'
                                  WHEN NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || t.tabla)
                                                      AND attname = 'player_id' AND NOT attisdropped) THEN 'sin player_id'
                                  ELSE substring(query_to_xml(
                                         format('select count(*)::text as c from public.%I x where x.player_id::text in (select a.pid from (%s) a)',
                                                t.tabla, al.q),
                                         false, true, '')::text from '<c>([^<]*)</c>') END,
                             ' · ' ORDER BY t.tabla)
                      FROM tablas6 t)
         END,
         'informativo', NULL::boolean
    FROM pl, alcance al
  UNION ALL
  -- 18 · INFO. Valores de app_metadata.tenant_id que public.tenant_id() NO puede
  --      convertir a uuid (con el hook activo, ese usuario recibe error 22P02 en
  --      toda consulta que lo use) y valores que sí convierten pero no están en la
  --      forma canónica (minúsculas con guiones): la comparación de TEXTO de la
  --      fila 19 no los reconoce. Se muestran hasta 5 valores no convertibles.
  SELECT 18, 'app_metadata.tenant_id: no convertibles a uuid · convertibles pero no canónicos',
         CASE WHEN NOT pl.con_app_meta THEN 'no aplica (sin auth.users.raw_app_meta_data)'
              ELSE substring(query_to_xml(format(
                'select (select count(*) from auth.users u where nullif(u.raw_app_meta_data ->> %1$L, %2$L) !~* %3$L)::text
                        || '' no convertible(s)''
                        || coalesce('' [valores: '' || (select string_agg(v, '', '') from (
                             select distinct quote_literal(left(u.raw_app_meta_data ->> %1$L, 40)) as v
                               from auth.users u where nullif(u.raw_app_meta_data ->> %1$L, %2$L) !~* %3$L
                              order by 1 limit 5) s) || '']'', '''')
                        || '' · '' || (select count(*) from auth.users u
                                        where (case when nullif(u.raw_app_meta_data ->> %1$L, %2$L) ~* %3$L
                                                    then (u.raw_app_meta_data ->> %1$L)::uuid::text end)
                                              <> (u.raw_app_meta_data ->> %1$L))::text
                        || '' no canónico(s)'' as c',
                'tenant_id', '', re.uuid_re), false, true, '')::text from '<c>([^<]*)</c>')
         END,
         'informativo', NULL::boolean
    FROM pl, re
  UNION ALL
  -- 19 · INFO (ABIERTO HOY, fuera de la 073). La DSAR de la 072
  --      (dsar_caller_manages_player, 072:264,285) deja pasar al dueño O a quien
  --      tenga el mismo tenant comparando TEXTO (claim raíz o app_metadata, sin
  --      hook). Usuarios NO dueños cuyo app_metadata.tenant_id, como texto, es el
  --      tenant_id de un jugador: con la 072 del repo pueden exportar sus datos y
  --      pedir su borrado. Al final dice si la función instalada tiene esa rama.
  --      Previsto para una migración posterior (076).
  SELECT 19, 'usuarios NO dueños que HOY pasan la DSAR de la 072 por tenant (texto; NO lo cierra la 073) · jugadores',
         CASE WHEN NOT (pl.existe AND pl.con_user AND pl.con_tenant AND pl.con_app_meta)
                THEN 'no aplica (ver fila 13)'
              ELSE substring(query_to_xml(
                'select count(distinct u.id)::text || '' usuario(s) · '' || count(distinct p.id)::text || '' jugador(es)'' as c
                   from auth.users u
                   join public.players p
                     on p.tenant_id is not null
                    and p.tenant_id::text = nullif(u.raw_app_meta_data ->> ''tenant_id'', '''')
                  where p.user_id is distinct from u.id',
                false, true, '')::text from '<c>([^<]*)</c>')
         END
           || ' · función DSAR con rama tenant: '
           || coalesce((SELECT (pg_get_functiondef(p.oid) ~* 'tenant_id')::text
                          FROM pg_proc p WHERE p.oid = to_regprocedure('public.dsar_caller_manages_player(text)')),
                       'no existe'),
         'informativo', NULL::boolean
    FROM pl
  UNION ALL
  -- 20 · INFO (ABIERTO HOY, fuera de la 073). ¿Puede un compañero de tenant
  --      reescribir players.user_id y hacerse «dueño»? Hace falta el privilegio
  --      UPDATE sobre la columna user_id y una política UPDATE/ALL por tenant cuyo
  --      WITH CHECK (o USING, si no hay WITH CHECK) no fije user_id (p. ej.
  --      players_tenant_isolation de 003). Con las dos cosas, la regla «solo
  --      dueño» de la 073 (y ownsPlayer en el servidor) le trataría como dueño.
  --      Previsto para una migración posterior (076).
  SELECT 20, 'players: authenticated puede UPDATE de user_id · políticas UPDATE/ALL por tenant que no fijan user_id',
         CASE WHEN NOT pl.existe OR NOT pl.con_user OR to_regrole('authenticated') IS NULL THEN 'no aplica'
              ELSE 'UPDATE(user_id): '
                   || has_column_privilege('authenticated', to_regclass('public.players'), 'user_id', 'UPDATE')::text
                   || ' · políticas: '
                   || coalesce((SELECT string_agg(po.policyname || ':' || po.cmd, ', ' ORDER BY po.policyname)
                                  FROM pol po
                                 WHERE po.tablename = 'players' AND po.permissive = 'PERMISSIVE'
                                   AND po.cmd IN ('UPDATE', 'ALL')
                                   AND (po.cp ~ 'tenant_id=\(?(select)?(public\.)?tenant_id\(\)'
                                        OR po.cp ~ '(public\.)?tenant_id\(\)\)?=([a-z0-9_]+\.)*tenant_id')
                                   AND po.cp !~ 'user_id'), 'ninguna') END,
         'informativo', NULL::boolean
    FROM pl
  UNION ALL
  -- 21 · BLOQUEA. Escrituras de cliente en player_metric_snapshots / player_valuations
  --      que la 072 retiró (072:597-598, 605-606). Si salen, la 044 se aplicó
  --      DESPUÉS de la 072: vuelve a ejecutar el bloque «044 · player_metric_snapshots
  --      / player_valuations» de la 072 y repite esta comprobación.
  SELECT 21, 'snapshots / valoraciones: privilegios de cliente que la 072 retiró (anon: todos · authenticated: escritura)',
         r, 'ninguno', r IN ('ninguno', 'faltan roles')
    FROM (SELECT CASE WHEN to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN 'faltan roles'
                      ELSE coalesce((SELECT string_agg(rp.rol || ':' || t.tabla || ':' || rp.priv, ', ' ORDER BY t.tabla, rp.rol, rp.priv)
                                       FROM (VALUES ('player_metric_snapshots'), ('player_valuations')) t(tabla)
                                      CROSS JOIN (VALUES ('anon', 'SELECT'), ('anon', 'INSERT'), ('anon', 'UPDATE'), ('anon', 'DELETE'),
                                                         ('authenticated', 'INSERT'), ('authenticated', 'UPDATE'),
                                                         ('authenticated', 'DELETE')) rp(rol, priv)
                                      WHERE to_regclass('public.' || t.tabla) IS NOT NULL
                                        AND has_table_privilege(rp.rol, to_regclass('public.' || t.tabla), rp.priv)),
                                    'ninguno') END AS r) y
  UNION ALL
  -- 22 · INFO. Snapshots con PHV (phv_offset / phv_category) que NO respalda ninguna
  --      fila fiable de player_anthropometrics (mismo criterio que 069:298-313). La
  --      073 NO abre la lectura de snapshots al navegador (retenida); esta fila mide
  --      lo que se vería si se abriera hoy. Producción: ningún jugador tiene fecha de
  --      nacimiento (verificado), así que ninguna fila fiable puede existir.
  SELECT 22, 'player_metric_snapshots: filas con PHV no respaldado por medidas fiables (lectura retenida en la 073)',
         CASE WHEN to_regclass('public.player_metric_snapshots') IS NULL THEN 'tabla no existe'
              WHEN to_regclass('public.player_anthropometrics') IS NULL THEN 'no aplica (sin player_anthropometrics)'
              WHEN (SELECT count(*) FROM pg_attribute
                     WHERE attrelid = to_regclass('public.player_metric_snapshots') AND NOT attisdropped
                       AND attname IN ('player_id', 'phv_offset', 'phv_category')) < 3
                OR (SELECT count(*) FROM pg_attribute
                     WHERE attrelid = to_regclass('public.player_anthropometrics') AND NOT attisdropped
                       AND attname IN ('player_id', 'age_source', 'height_cm', 'weight_kg', 'sitting_height_cm',
                                       'leg_length_cm', 'maturity_offset', 'phv_category')) < 8
                THEN 'no aplica (faltan columnas)'
              ELSE substring(query_to_xml(
                'select count(*)::text as c
                   from public.player_metric_snapshots s
                  where (s.phv_category is not null or s.phv_offset is not null)
                    and not exists (
                      select 1 from public.player_anthropometrics a
                       where a.player_id = s.player_id
                         and a.age_source = ''birth_date''
                         and a.height_cm is not null and a.weight_kg is not null
                         and a.sitting_height_cm is not null
                         and (a.leg_length_cm is not null or a.height_cm > a.sitting_height_cm)
                         and a.maturity_offset is not null and a.phv_category is not null
                         and round(s.phv_offset::numeric, 2) = a.maturity_offset
                         and (case s.phv_category when ''ontme'' then ''ontime'' else s.phv_category end) = a.phv_category)',
                false, true, '')::text from '<c>([^<]*)</c>')
         END,
         'informativo', NULL::boolean
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
