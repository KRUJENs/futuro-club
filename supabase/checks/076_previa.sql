-- =====================================================================
-- VITAS · 076 · COMPROBACIÓN PREVIA · SOLO LECTURA
-- Ejecútala ANTES de la migración 076 y manda el resultado COMPLETO.
--   · Fila «BLOQUEA» con ok = false  →  NO apliques la 076; manda el resultado.
--   · Fila «URGENTE» con ok = false  →  avisa YA (no depende de la 076: es el
--     código desplegado hoy; ver su texto).
--   · ok vacío (NULL) = fila informativa: no bloquea, pero mándala también.
-- No escribe nada (una sola consulta SELECT). No falla si faltan tablas o
-- columnas: usa to_regclass / pg_attribute, y los conteos se hacen con
-- query_to_xml SOLO cuando la tabla y sus columnas existen.
--
-- «Usuario NO dueño con acceso por tenant» = usuario de auth.users cuyo
-- app_metadata.tenant_id (lo que el hook 057 copia al claim RAÍZ tenant_id, que
-- es lo que lee public.tenant_id(); la API y la DSAR 072 lo leen del claim raíz
-- o, si falta, de app_metadata) coincide con el tenant_id de la fila, y que NO es
-- ni el dueño del jugador de esa fila ni quien la creó. Mismo criterio que usan
-- las ramas por tenant que la 076 retira. [si hook] = esa vía solo abre con el
-- hook 057 ACTIVADO (no visible por SQL: Dashboard > Authentication > Hooks);
-- [siempre] = abre con o sin hook (API con service_role, DSAR 072).
-- Probada en SIMULACIÓN PGlite (NO en tu base): base vacía, esquema mínimo y la
-- forma verificada de producción (con y sin 055, con y sin 073).
-- =====================================================================
WITH
-- Tablas que la 076 gestiona.
gest(tabla) AS (
  VALUES ('players'), ('videos'), ('analyses'), ('reports'), ('parental_consents'),
         ('player_anthropometrics'), ('development_plans'), ('idp_goals'), ('idp_milestones'),
         ('idp_checkins'), ('transfer_listings'), ('transfer_inquiries'), ('tactical_phases'),
         ('phase_heatmaps'), ('tactical_insights'), ('match_analyses')
),
-- Políticas por tenant que la 076 conoce y retira (repo: 003/004/005/047/049/055/067).
conocidas(tabla, politica) AS (
  VALUES ('players', 'players_tenant_isolation'), ('videos', 'videos_tenant_isolation'),
         ('analyses', 'analyses_tenant_isolation'), ('reports', 'reports_tenant_isolation'),
         ('parental_consents', 'consent_tenant_isolation'),
         ('player_anthropometrics', 'anthro_tenant_isolation'),
         ('development_plans', 'idp_plans_owner_read'), ('development_plans', 'idp_plans_coach_write'),
         ('idp_goals', 'idp_goals_via_plan'), ('idp_milestones', 'idp_milestones_via_plan'),
         ('idp_checkins', 'idp_checkins_via_plan'),
         ('transfer_listings', 'listings_public_read'), ('transfer_listings', 'listings_owner_write'),
         ('transfer_inquiries', 'inquiries_participants_read'), ('transfer_inquiries', 'inquiries_participants_write'),
         ('tactical_phases', 'tactical_phases_owner_read'), ('tactical_phases', 'tactical_phases_owner_write'),
         ('phase_heatmaps', 'phase_heatmaps_owner_read'), ('phase_heatmaps', 'phase_heatmaps_owner_write'),
         ('tactical_insights', 'tactical_insights_owner_read'), ('tactical_insights', 'tactical_insights_owner_write'),
         ('match_analyses', 'match_analyses_select_owner')
),
-- Columnas que usan las políticas de la 076 (solo se exigen si la tabla existe).
necesarias(tabla, columna) AS (
  VALUES ('players', 'id'), ('players', 'user_id'),
         ('videos', 'user_id'), ('videos', 'player_id'),
         ('analyses', 'id'), ('analyses', 'user_id'), ('analyses', 'player_id'),
         ('reports', 'player_id'), ('reports', 'analysis_id'),
         ('development_plans', 'id'), ('development_plans', 'player_id'), ('development_plans', 'coach_id'),
         ('idp_goals', 'plan_id'), ('idp_milestones', 'plan_id'), ('idp_checkins', 'plan_id'),
         ('transfer_listings', 'id'), ('transfer_listings', 'player_id'), ('transfer_listings', 'seller_user_id'),
         ('transfer_listings', 'visibility'), ('transfer_listings', 'status'),
         ('transfer_inquiries', 'listing_id'), ('transfer_inquiries', 'buyer_user_id'),
         ('tactical_phases', 'match_id'), ('phase_heatmaps', 'match_id'), ('tactical_insights', 'match_id'),
         ('match_analyses', 'user_id')
),
pol AS (
  SELECT tablename, policyname, cmd,
         lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) AS expr
    FROM pg_policies
   WHERE schemaname = 'public'
),
-- ¿Existe la columna? (tabla.columna)
col AS (
  SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
),
base AS (
  SELECT to_regclass('public.players') IS NOT NULL AS players_ok,
         to_regclass('auth.users') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('auth.users')
                          AND attname = 'raw_app_meta_data' AND NOT attisdropped) AS users_ok
),
-- Conteo por recurso: (n, recurso, tabla, columnas necesarias, SQL que devuelve c).
-- UT = tenant del usuario, como lo resuelven public.tenant_id() + hook 057.
recursos(n, recurso, tabla, cols, q) AS (
  VALUES
  (20, 'jugadores (players) · RLS players_tenant_isolation [si hook] · API reports/share/generate/consentimiento/subida/finalize/mercado/equipo [siempre] · DSAR 072 [siempre]',
   'players', ARRAY['tenant_id', 'user_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct p.id)::text || '' jugador(es)'' as c
      from auth.users u join public.players p
        on p.tenant_id is not null and p.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
     where p.user_id is distinct from u.id'),
  (21, 'vídeos · RLS videos_tenant_isolation [si hook] · API ownsVideo (finalize/identify/candidates/partido) [siempre]',
   'videos', ARRAY['tenant_id', 'user_id', 'player_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct v.id)::text || '' vídeo(s)'' as c
      from auth.users u join public.videos v
        on v.tenant_id is not null and v.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = v.player_id::text
     where v.user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (22, 'análisis (analyses) · RLS analyses_tenant_isolation [si hook] · API tácticas ownsMatch / list-matches [siempre]',
   'analyses', ARRAY['tenant_id', 'user_id', 'player_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct a.id)::text || '' análisis'' as c
      from auth.users u join public.analyses a
        on a.tenant_id is not null and a.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = a.player_id::text
     where a.user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (23, 'informes (reports) · RLS reports_tenant_isolation [si hook]',
   'reports', ARRAY['tenant_id', 'player_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct r.id)::text || '' informe(s)'' as c
      from auth.users u join public.reports r
        on r.tenant_id is not null and r.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = r.player_id::text
     where p.user_id is distinct from u.id'),
  (24, 'consentimientos parentales (parental_consents) · RLS consent_tenant_isolation [si hook]',
   'parental_consents', ARRAY['tenant_id', 'player_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct c.id)::text || '' consentimiento(s)'' as c
      from auth.users u join public.parental_consents c
        on c.tenant_id is not null and c.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = c.player_id::text
     where p.user_id is distinct from u.id'),
  (25, 'antropometría (player_anthropometrics) · RLS anthro_tenant_isolation [si hook]',
   'player_anthropometrics', ARRAY['tenant_id', 'player_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct m.id)::text || '' medida(s)'' as c
      from auth.users u join public.player_anthropometrics m
        on m.tenant_id is not null and m.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = m.player_id::text
     where p.user_id is distinct from u.id'),
  (26, 'planes IDP (development_plans, y sus objetivos/hitos/revisiones) · RLS 047 [si hook]',
   'development_plans', ARRAY['tenant_id', 'player_id', 'coach_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct d.id)::text || '' plan(es)'' as c
      from auth.users u join public.development_plans d
        on d.tenant_id is not null and d.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = d.player_id::text
     where d.coach_id is distinct from u.id and p.user_id is distinct from u.id'),
  (27, 'mercado · fichas (transfer_listings) · RLS 049 [si hook] (la lectura de fichas PÚBLICAS activas es aparte, por diseño)',
   'transfer_listings', ARRAY['tenant_id', 'player_id', 'seller_user_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct l.id)::text || '' ficha(s)'' as c
      from auth.users u join public.transfer_listings l
        on l.tenant_id is not null and l.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      left join public.players p on p.id::text = l.player_id::text
     where l.seller_user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (28, 'mercado · mensajes (transfer_inquiries) · RLS 049 vía la ficha [si hook]',
   'transfer_inquiries', ARRAY['listing_id', 'buyer_user_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct i.id)::text || '' mensaje(s)'' as c
      from auth.users u join public.transfer_listings l
        on l.tenant_id is not null and l.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      join public.transfer_inquiries i on i.listing_id = l.id
      left join public.players p on p.id::text = l.player_id::text
     where i.buyer_user_id is distinct from u.id and l.seller_user_id is distinct from u.id
       and p.user_id is distinct from u.id'),
  (29, 'tácticas · fases (tactical_phases) · RLS 055 vía analyses [si hook y si 055 aplicada]',
   'tactical_phases', ARRAY['match_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct t.id)::text || '' fila(s)'' as c
      from auth.users u join public.analyses a
        on a.tenant_id is not null and a.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      join public.tactical_phases t on t.match_id = a.id
      left join public.players p on p.id::text = a.player_id::text
     where a.user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (30, 'tácticas · heatmaps (phase_heatmaps) · RLS 055 vía analyses [si hook y si 055 aplicada]',
   'phase_heatmaps', ARRAY['match_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct t.id)::text || '' fila(s)'' as c
      from auth.users u join public.analyses a
        on a.tenant_id is not null and a.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      join public.phase_heatmaps t on t.match_id = a.id
      left join public.players p on p.id::text = a.player_id::text
     where a.user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (31, 'tácticas · insights (tactical_insights) · RLS 055 vía analyses [si hook y si 055 aplicada]',
   'tactical_insights', ARRAY['match_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct t.id)::text || '' fila(s)'' as c
      from auth.users u join public.analyses a
        on a.tenant_id is not null and a.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
      join public.tactical_insights t on t.match_id = a.id
      left join public.players p on p.id::text = a.player_id::text
     where a.user_id is distinct from u.id and p.user_id is distinct from u.id'),
  (32, 'partido completo (match_analyses) · RLS 067 [si hook] · API status/cancel/baseline de equipo [siempre]',
   'match_analyses', ARRAY['tenant_id', 'user_id'],
   'select count(distinct u.id)::text || '' usuario(s) no dueño(s) · '' || count(distinct m.id)::text || '' job(s)'' as c
      from auth.users u join public.match_analyses m
        on m.tenant_id is not null and m.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')
     where m.user_id is distinct from u.id')
),
recursos_eval AS (
  SELECT r.n, r.recurso,
         CASE
           WHEN NOT b.users_ok THEN 'auth.users sin raw_app_meta_data: no se puede contar'
           WHEN to_regclass('public.' || r.tabla) IS NULL THEN 'tabla no existe'
           WHEN r.tabla <> 'players' AND NOT b.players_ok THEN 'players no existe'
           WHEN EXISTS (SELECT 1 FROM unnest(r.cols) x(c)
                         WHERE NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = r.tabla AND col.columna = x.c))
             THEN 'sin columna ' || (SELECT string_agg(x.c, ', ') FROM unnest(r.cols) x(c)
                                        WHERE NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = r.tabla AND col.columna = x.c))
                  || ' (esta vía no puede dar acceso por tenant)'
           WHEN r.tabla IN ('tactical_phases', 'phase_heatmaps', 'tactical_insights')
                AND (to_regclass('public.analyses') IS NULL
                     OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'analyses' AND col.columna = 'tenant_id'))
             THEN 'analyses o analyses.tenant_id no existe'
           WHEN r.tabla = 'transfer_inquiries'
                AND NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'transfer_listings' AND col.columna = 'tenant_id')
             THEN 'transfer_listings.tenant_id no existe'
           ELSE substring(query_to_xml(r.q, false, true, '')::text FROM '<c>([^<]*)</c>')
         END
         || ' · políticas por tenant hoy en la tabla: '
         || coalesce((SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) FROM pol p
                       WHERE p.tablename = r.tabla AND p.expr LIKE '%tenant%'), 'ninguna') AS resultado
    FROM recursos r CROSS JOIN base b
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · BLOQUEA. La 076 exige players(id, user_id): el dueño es players.user_id.
  SELECT 1, 'BLOQUEA · players: columnas id / user_id / tenant_id',
         r, 'id:text · tenant_id:uuid · user_id:uuid (tenant_id puede faltar)',
         r LIKE 'id:%user_id:%'
    FROM (SELECT coalesce((SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ' · ' ORDER BY attname)
                             FROM pg_attribute
                            WHERE attrelid = to_regclass('public.players')
                              AND attname IN ('id', 'tenant_id', 'user_id') AND NOT attisdropped),
                          'players no existe') AS r) x
  UNION ALL
  -- 2 · BLOQUEA. auth.uid() (Supabase) lo usan todas las políticas.
  SELECT 2, 'BLOQUEA · auth.uid() existe',
         (to_regprocedure('auth.uid()') IS NOT NULL)::text, 'true', to_regprocedure('auth.uid()') IS NOT NULL
  UNION ALL
  -- 3 · BLOQUEA. public.caller_manages_player: o no existe, o es la de la 073 / 076
  --     (la 076 la sustituye por la versión solo-dueño).
  SELECT 3, 'BLOQUEA · public.caller_manages_player que NO es de la 073 ni de la 076',
         count(*)::text, '0', count(*) = 0
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'caller_manages_player'
     AND coalesce(obj_description(p.oid, 'pg_proc'), '') NOT LIKE '073 ·%'
     AND coalesce(obj_description(p.oid, 'pg_proc'), '') NOT LIKE '076 ·%'
  UNION ALL
  -- 4 · BLOQUEA. Políticas que mencionan tenant en las tablas de la 076 y que la 076
  --     NO conoce (p. ej. creadas a mano). Seguirían ahí: la 076 abortaría al final.
  SELECT 4, 'BLOQUEA · políticas por tenant DESCONOCIDAS en las tablas de la 076',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'ninguna', count(*) = 0
    FROM pol p JOIN gest g ON g.tabla = p.tablename
   WHERE p.expr LIKE '%tenant%'
     AND NOT EXISTS (SELECT 1 FROM conocidas c WHERE c.tabla = p.tablename AND c.politica = p.policyname)
  UNION ALL
  -- 5 · BLOQUEA. Columnas que usan las políticas nuevas (de las tablas que existen).
  SELECT 5, 'BLOQUEA · columnas que necesita la 076 y que faltan',
         coalesce(string_agg(n.tabla || '.' || n.columna, ', ' ORDER BY n.tabla, n.columna), 'ninguna'),
         'ninguna', count(*) = 0
    FROM necesarias n
   WHERE to_regclass('public.' || n.tabla) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = n.tabla AND col.columna = n.columna)
  UNION ALL
  -- 6 · URGENTE (no depende de la 076). El cron de borrados programados DESPLEGADO HOY
  --     (api/crons/data-retention.ts antes de este PR) borra players, videos, analyses,
  --     reports, subscriptions y parental_consents WHERE tenant_id = el de la solicitud.
  --     Cuenta jugadores de OTRAS cuentas que caerían con las solicitudes pendientes.
  --     Si sale distinto de 0: cancelar la solicitud o desplegar el código del PR ANTES
  --     del próximo cron (03:00 UTC).
  SELECT 6, 'URGENTE · bajas pendientes · jugadores de OTRAS cuentas que el cron actual borraría',
         r, '… · 0 jugador(es) ajeno(s)',
         r LIKE '% · 0 jugador(es) ajeno(s)%'
    FROM (SELECT CASE
                   WHEN to_regclass('public.deletion_requests') IS NULL THEN '0 solicitud(es) pendiente(s) · 0 jugador(es) ajeno(s) (sin tabla deletion_requests)'
                   WHEN NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'players' AND col.columna = 'tenant_id')
                     THEN substring(query_to_xml(
                       'select count(*)::text || '' solicitud(es) pendiente(s) · 0 jugador(es) ajeno(s)'' as c
                          from public.deletion_requests where status in (''pending'', ''processing'')',
                       false, true, '')::text FROM '<c>([^<]*)</c>')
                   ELSE substring(query_to_xml(
                     'select (select count(*) from public.deletion_requests where status in (''pending'', ''processing''))::text
                             || '' solicitud(es) pendiente(s) · ''
                             || (select count(distinct p.id) from public.deletion_requests d
                                   join public.players p on p.tenant_id = d.tenant_id
                                  where d.status in (''pending'', ''processing'')
                                    and p.user_id is distinct from d.user_id)::text
                             || '' jugador(es) ajeno(s)'' as c',
                     false, true, '')::text FROM '<c>([^<]*)</c>')
                 END AS r) x
  UNION ALL
  -- 7 · INFO. Jugadores. Sin user_id = sin dueño: tras la 076 solo el backend los ve.
  SELECT 7, 'jugadores: total · sin user_id (sin dueño) · sin tenant_id · valores distintos de tenant_id',
         CASE WHEN NOT b.players_ok THEN 'players no existe'
              WHEN NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'players' AND col.columna = 'tenant_id')
                THEN substring(query_to_xml(
                  'select count(*)::text || '' · '' || count(*) filter (where user_id is null)::text || '' · sin columna tenant_id'' as c from public.players',
                  false, true, '')::text FROM '<c>([^<]*)</c>')
              ELSE substring(query_to_xml(
                'select count(*)::text || '' · '' || count(*) filter (where user_id is null)::text || '' · ''
                        || count(*) filter (where tenant_id is null)::text || '' · '' || count(distinct tenant_id)::text as c
                   from public.players',
                false, true, '')::text FROM '<c>([^<]*)</c>')
         END,
         'informativo (verificado 29-30 sep: 3 jugadores, 1 valor de tenant_id)', NULL::boolean
    FROM base b
  UNION ALL
  -- 8 · INFO. Usuarios y su tenant (lo que el hook 057 pone en el JWT).
  SELECT 8, 'usuarios: total · con app_metadata.tenant_id · valores distintos · que comparten tenant con algún jugador',
         CASE WHEN NOT b.users_ok THEN 'auth.users sin raw_app_meta_data'
              WHEN NOT b.players_ok OR NOT EXISTS (SELECT 1 FROM col WHERE col.tabla = 'players' AND col.columna = 'tenant_id')
                THEN substring(query_to_xml(
                  'select count(*)::text || '' · '' || count(*) filter (where nullif(raw_app_meta_data ->> ''tenant_id'', '''') is not null)::text
                          || '' · '' || count(distinct nullif(lower(raw_app_meta_data ->> ''tenant_id''), ''''))::text || '' · no aplica'' as c
                     from auth.users',
                  false, true, '')::text FROM '<c>([^<]*)</c>')
              ELSE substring(query_to_xml(
                'select count(*)::text || '' · '' || count(*) filter (where nullif(u.raw_app_meta_data ->> ''tenant_id'', '''') is not null)::text
                        || '' · '' || count(distinct nullif(lower(u.raw_app_meta_data ->> ''tenant_id''), ''''))::text
                        || '' · '' || count(*) filter (where exists (select 1 from public.players p
                                                                     where p.tenant_id is not null
                                                                       and p.tenant_id::text = lower(u.raw_app_meta_data ->> ''tenant_id'')))::text as c
                   from auth.users u',
                false, true, '')::text FROM '<c>([^<]*)</c>')
         END,
         'informativo (docs 28 ago: 8/8 con tenant, pero si es el MISMO valor NO está verificado)', NULL::boolean
    FROM base b
  UNION ALL
  -- 9 · INFO. Si la función del hook existe. Si está ACTIVADA solo se ve en el panel.
  SELECT 9, 'función del hook 057 (custom_access_token_hook) existe',
         (to_regprocedure('public.custom_access_token_hook(jsonb)') IS NOT NULL)::text
           || ' · activación: mirar Dashboard > Authentication > Hooks',
         'informativo', NULL::boolean
  UNION ALL
  -- 10 · INFO. La DSAR de la 072 acepta hoy el tenant del JWT (sin hook).
  SELECT 10, 'public.dsar_caller_manages_player existe · su cuerpo menciona tenant',
         CASE WHEN to_regprocedure('public.dsar_caller_manages_player(text)') IS NULL THEN 'no existe'
              ELSE 'true · ' || (SELECT (lower(prosrc) LIKE '%tenant%')::text FROM pg_proc
                                  WHERE oid = to_regprocedure('public.dsar_caller_manages_player(text)')) END,
         'informativo (072 aplicada: se espera «true · true», y la 076 lo deja sin tenant)', NULL::boolean
  UNION ALL
  -- 11 · INFO. Inventario: TODAS las políticas de public que mencionan tenant, y si la
  --      076 las retira. Las que no retira (p. ej. subscriptions, o las de 044/050 que
  --      corrige la 073) se listan para que se vean.
  SELECT 11, 'políticas de public que mencionan tenant (tabla:política:la 076 la retira)',
         coalesce(string_agg(p.tablename || ':' || p.policyname || ':'
                               || CASE WHEN EXISTS (SELECT 1 FROM conocidas c WHERE c.tabla = p.tablename AND c.politica = p.policyname)
                                       THEN 'sí' ELSE 'no' END,
                             ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p
   WHERE p.expr LIKE '%tenant%'
  UNION ALL
  -- 12 · INFO. Residuo que NO es por tenant: filas cuyo CREADOR no es el dueño de su
  --      jugador. Tras la 076 el creador conserva la LECTURA (regla «quien la creó o el
  --      dueño del jugador»); sirve para decidir si se limpian a mano.
  SELECT 12, 'filas cuyo creador NO es el dueño del jugador (análisis · vídeos · planes IDP · fichas)',
         CASE WHEN NOT b.players_ok THEN 'players no existe' ELSE
           coalesce(CASE WHEN to_regclass('public.analyses') IS NOT NULL
                          AND EXISTS (SELECT 1 FROM col WHERE col.tabla = 'analyses' AND col.columna = 'user_id')
                         THEN substring(query_to_xml(
                           'select count(*)::text as c from public.analyses a join public.players p on p.id::text = a.player_id::text
                             where a.user_id is not null and a.user_id is distinct from p.user_id', false, true, '')::text FROM '<c>([^<]*)</c>')
                    END, '-') || ' · ' ||
           coalesce(CASE WHEN to_regclass('public.videos') IS NOT NULL
                          AND EXISTS (SELECT 1 FROM col WHERE col.tabla = 'videos' AND col.columna = 'user_id')
                         THEN substring(query_to_xml(
                           'select count(*)::text as c from public.videos v join public.players p on p.id::text = v.player_id::text
                             where v.user_id is not null and v.user_id is distinct from p.user_id', false, true, '')::text FROM '<c>([^<]*)</c>')
                    END, '-') || ' · ' ||
           coalesce(CASE WHEN to_regclass('public.development_plans') IS NOT NULL
                          AND EXISTS (SELECT 1 FROM col WHERE col.tabla = 'development_plans' AND col.columna = 'coach_id')
                         THEN substring(query_to_xml(
                           'select count(*)::text as c from public.development_plans d join public.players p on p.id::text = d.player_id::text
                             where d.coach_id is not null and d.coach_id is distinct from p.user_id', false, true, '')::text FROM '<c>([^<]*)</c>')
                    END, '-') || ' · ' ||
           coalesce(CASE WHEN to_regclass('public.transfer_listings') IS NOT NULL
                          AND EXISTS (SELECT 1 FROM col WHERE col.tabla = 'transfer_listings' AND col.columna = 'seller_user_id')
                         THEN substring(query_to_xml(
                           'select count(*)::text as c from public.transfer_listings l join public.players p on p.id::text = l.player_id::text
                             where l.seller_user_id is not null and l.seller_user_id is distinct from p.user_id', false, true, '')::text FROM '<c>([^<]*)</c>')
                    END, '-')
         END,
         'informativo («-» = tabla o columna no existe)', NULL::boolean
    FROM base b
  UNION ALL
  -- 13 · INFO. Las tácticas de 048 (abiertas a CUALQUIER usuario con sesión) siguen
  --      vivas si la 055 no se aplicó. La 076 las retira también.
  SELECT 13, 'políticas tácticas de 048 abiertas a todo usuario con sesión (la 076 las retira)',
         coalesce(string_agg(p.tablename || ':' || p.policyname, ', ' ORDER BY p.tablename, p.policyname), 'ninguna'),
         'informativo', NULL::boolean
    FROM pol p
   WHERE p.policyname IN ('tactical_phases_auth_read', 'tactical_phases_auth_write', 'phase_heatmaps_auth_read',
                          'phase_heatmaps_auth_write', 'tactical_insights_auth_read', 'tactical_insights_auth_write')
  UNION ALL
  -- 20-32 · DATO PEDIDO POR EL DUEÑO. Por recurso: usuarios que NO son dueños y que hoy
  --         (o con el hook activo) acceden por tenant, y filas que alcanzan.
  SELECT e.n, e.recurso, e.resultado, 'informativo (la 076 + el código del PR lo dejan en 0)', NULL::boolean
    FROM recursos_eval e
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
