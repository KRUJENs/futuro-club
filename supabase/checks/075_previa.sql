-- =====================================================================
-- VITAS · 075 · COMPROBACIÓN PREVIA · SOLO LECTURA
-- Ejecútala ANTES de la migración 075 y manda el resultado COMPLETO.
--   · Fila «BLOQUEA» con ok = false  →  NO apliques la 075; manda el resultado.
--   · ok vacío (NULL) = fila informativa: no bloquea, pero mándala también.
-- No escribe nada (una sola consulta SELECT) y no falla si faltan tablas, columnas o
-- roles: usa to_regclass / to_regrole / pg_attribute, y los conteos van con
-- query_to_xml SOLO cuando la tabla y sus columnas existen («-» = no existe).
-- Solo cuenta filas: no devuelve ningún dato personal (ni emails, ni ids).
-- Probada en SIMULACIÓN PGlite (NO en tu base): base vacía, todas las migraciones del
-- repo, la forma de producción (sin 073/076) con datos, y después de la 075.
--
-- Qué mirar (hallazgo B6 del PR #308):
--   · filas 4-6: permisos de cliente sobre parental_consents HOY (el 9 oct salió
--     auth_can_update_consents = true). La 075 los deja todos en false.
--   · fila 9: consentimientos verificados que el código NUEVO deja de aceptar porque no
--     tienen la evidencia que escribe verify-consent (p. ej. marcados por un cliente con
--     UPDATE). Si sale > 0, mándalo antes de fusionar: esos menores quedarían sin análisis
--     hasta que su tutor vuelva a verificar.
--   · fila 10: enlaces de verificación PENDIENTES con el token en claro: con el código
--     nuevo (token hasheado) ya no funcionan; el tutor tiene que pedir uno nuevo.
--   · fila 11: evidencias 'consent_email_verified' que ya existen. Antes de la 072 un
--     cliente podía insertar filas en gdpr_audit_log: si sale > 0, mándalo.
--   · fila 12: menores de 14 conocidos y cuántos tienen un consentimiento que cuenta con
--     el código nuevo / con la regla anterior.
-- =====================================================================
WITH
cols AS (
  SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('parental_consents', 'gdpr_audit_log', 'players')
     AND a.attnum > 0 AND NOT a.attisdropped
),
h AS (
  SELECT
    to_regrole('anon') IS NOT NULL AS r_anon,
    to_regrole('authenticated') IS NOT NULL AS r_auth,
    to_regrole('service_role') IS NOT NULL AS r_svc,
    to_regclass('public.parental_consents') IS NOT NULL AS pc,
    to_regclass('public.gdpr_audit_log') IS NOT NULL AS al,
    (SELECT count(*) FROM cols WHERE tabla = 'parental_consents'
        AND columna IN ('id', 'player_id', 'email_verified', 'withdrawn_at')) = 4 AS pc_cols,
    (SELECT count(*) FROM cols WHERE tabla = 'parental_consents'
        AND columna IN ('email_verified', 'verification_token', 'verification_expires_at')) = 3 AS pc_tok,
    (SELECT count(*) FROM cols WHERE tabla = 'gdpr_audit_log'
        AND columna IN ('action', 'resource_type', 'resource_id', 'metadata')) = 4 AS al_cols,
    (SELECT count(*) FROM cols WHERE tabla = 'players' AND columna IN ('id', 'birth_date')) = 2 AS pl_bd
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · BLOQUEA. Sin estos roles la 075 aborta sola (no es un proyecto Supabase).
  SELECT 1, 'BLOQUEA · roles anon · authenticated · service_role existen',
         h.r_anon::text || ' · ' || h.r_auth::text || ' · ' || h.r_svc::text,
         'true · true · true',
         h.r_anon AND h.r_auth AND h.r_svc
    FROM h
  UNION ALL
  -- 2 · INFO. Sin la tabla la 075 se la salta; el gate de clips falla cerrado (500) con un
  --     menor de 14 conocido (no puede comprobar su consentimiento).
  SELECT 2, 'public.parental_consents existe', h.pc::text, 'informativo (esperado: true)', NULL::boolean
    FROM h
  UNION ALL
  -- 3 · INFO. Políticas de cliente HOY (la 075 las retira TODAS; la 003 crea consent_tenant_isolation,
  --     la 076 la retira).
  SELECT 3, 'políticas en parental_consents (la 075 las retira todas)',
         CASE WHEN NOT h.pc THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(p.policyname || ' (' || p.cmd || ' ' || array_to_string(p.roles, ',') || ')', ', '
                                               ORDER BY p.policyname)
                               FROM pg_policies p
                              WHERE p.schemaname = 'public' AND p.tablename = 'parental_consents'), 'ninguna') END,
         'informativo (después de la 075: ninguna)', NULL::boolean
    FROM h
  UNION ALL
  -- 4 · INFO (B6). Permisos de TABLA de authenticated (el 9 oct: UPDATE = true).
  SELECT 4, 'parental_consents · authenticated: SELECT · INSERT · UPDATE · DELETE',
         CASE WHEN NOT h.pc OR NOT h.r_auth THEN 'no aplica'
              ELSE has_table_privilege('authenticated', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'DELETE')::text END,
         'informativo (después de la 075: false · false · false · false)', NULL::boolean
    FROM h
  UNION ALL
  -- 5 · INFO. Lo mismo para anon.
  SELECT 5, 'parental_consents · anon: SELECT · INSERT · UPDATE · DELETE',
         CASE WHEN NOT h.pc OR NOT h.r_anon THEN 'no aplica'
              ELSE has_table_privilege('anon', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'DELETE')::text END,
         'informativo (después de la 075: false · false · false · false)', NULL::boolean
    FROM h
  UNION ALL
  -- 6 · INFO. Permisos de tabla O de alguna columna (has_any_column_privilege).
  SELECT 6, 'parental_consents · tabla o alguna columna · authenticated SELECT · INSERT · UPDATE | anon SELECT · INSERT · UPDATE',
         CASE WHEN NOT h.pc OR NOT h.r_auth OR NOT h.r_anon THEN 'no aplica'
              ELSE has_any_column_privilege('authenticated', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.parental_consents', 'UPDATE')::text || ' | '
                || has_any_column_privilege('anon', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_any_column_privilege('anon', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_any_column_privilege('anon', 'public.parental_consents', 'UPDATE')::text END,
         'informativo (después de la 075: todo false)', NULL::boolean
    FROM h
  UNION ALL
  -- 7 · INFO. service_role (los escritores del código y el gate). Si sale algún false, el
  --     gate de clips HOY falla cerrado con un menor de 14 conocido; la 075 los concede.
  SELECT 7, 'parental_consents · service_role: SELECT · INSERT · UPDATE · DELETE',
         CASE WHEN NOT h.pc OR NOT h.r_svc THEN 'no aplica'
              ELSE has_table_privilege('service_role', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'DELETE')::text END,
         'informativo (después de la 075: true · true · true · true)', NULL::boolean
    FROM h
  UNION ALL
  -- 8 · INFO. Integridad de la EVIDENCIA (vive en gdpr_audit_log): sin escritura de cliente
  --     (072). La 075 lo reafirma.
  SELECT 8, 'gdpr_audit_log: existe · política audit_insert_authenticated · authenticated INSERT · UPDATE (tabla o columna) · service_role SELECT · INSERT',
         CASE WHEN NOT h.al THEN 'tabla no existe'
              WHEN NOT h.r_auth OR NOT h.r_svc THEN 'no aplica'
              ELSE 'true · '
                || (SELECT count(*) FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'gdpr_audit_log'
                       AND p.policyname = 'audit_insert_authenticated')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'INSERT')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'UPDATE')::text || ' · '
                || has_table_privilege('service_role', 'public.gdpr_audit_log', 'SELECT')::text || ' · '
                || has_table_privilege('service_role', 'public.gdpr_audit_log', 'INSERT')::text END,
         'informativo (esperado: true · 0 · false · false · true · true)', NULL::boolean
    FROM h
  UNION ALL
  -- 9 · INFO (B6). Consentimientos: total · verificados y no retirados · de ellos con la
  --     evidencia del servidor y sin retirada auditada (CUENTAN con el código nuevo) ·
  --     verificados SIN esa evidencia (DEJAN de contar).
  SELECT 9, 'consentimientos: total · verificados no retirados · con evidencia de verify-consent · SIN evidencia (dejan de contar)',
         CASE WHEN NOT (h.pc AND h.pc_cols AND h.al AND h.al_cols) THEN '-'
              ELSE coalesce(substring(query_to_xml(
                'select (count(*))::text || '' · ''
                     || (count(*) filter (where c.email_verified and c.withdrawn_at is null))::text || '' · ''
                     || (count(*) filter (where c.email_verified and c.withdrawn_at is null and ev.ok and not wd.ok))::text || '' · ''
                     || (count(*) filter (where c.email_verified and c.withdrawn_at is null and not (ev.ok and not wd.ok)))::text as c
                   from public.parental_consents c
                   cross join lateral (select exists (
                       select 1 from public.gdpr_audit_log a
                        where a.action = ''consent_email_verified'' and a.resource_type = ''parental_consents''
                          and a.resource_id = c.id::text and a.metadata ->> ''player_id'' = c.player_id::text) as ok) ev
                   cross join lateral (select exists (
                       select 1 from public.gdpr_audit_log a
                        where a.action = ''consent_withdrawn'' and a.resource_type = ''parental_consents''
                          and a.resource_id = c.id::text) as ok) wd',
                false, true, '')::text FROM '<c>([^<]*)</c>'), '-') END,
         'informativo (la última cifra > 0 → mándalo antes de fusionar)', NULL::boolean
    FROM h
  UNION ALL
  -- 10 · INFO. Enlaces PENDIENTES: con token en claro y sin caducar (dejan de valer con el
  --      código nuevo) · con token hasheado (sha256:, ya del código nuevo).
  SELECT 10, 'pendientes: con token en claro sin caducar (dejan de valer) · con token hasheado',
         CASE WHEN NOT (h.pc AND h.pc_tok) THEN '-'
              ELSE coalesce(substring(query_to_xml(
                'select (count(*) filter (where c.verification_token is not null
                                            and c.verification_token not like ''sha256:%''
                                            and (c.verification_expires_at is null or c.verification_expires_at > now())))::text
                     || '' · '' || (count(*) filter (where c.verification_token like ''sha256:%''))::text as c
                   from public.parental_consents c
                  where not c.email_verified',
                false, true, '')::text FROM '<c>([^<]*)</c>'), '-') END,
         'informativo', NULL::boolean
    FROM h
  UNION ALL
  -- 11 · INFO. Filas de auditoría de consentimientos que ya existen.
  SELECT 11, 'gdpr_audit_log sobre parental_consents: consent_email_verified · consent_withdrawn',
         CASE WHEN NOT (h.al AND h.al_cols) THEN '-'
              ELSE coalesce(substring(query_to_xml(
                'select (count(*) filter (where action = ''consent_email_verified''))::text || '' · ''
                     || (count(*) filter (where action = ''consent_withdrawn''))::text as c
                   from public.gdpr_audit_log
                  where resource_type = ''parental_consents''',
                false, true, '')::text FROM '<c>([^<]*)</c>'), '-') END,
         'informativo (si la primera cifra > 0, mándalo)', NULL::boolean
    FROM h
  UNION ALL
  -- 12 · INFO. Menores de 14 conocidos (regla 036) · con consentimiento que cuenta con el
  --      código NUEVO · con la regla ANTERIOR (solo email_verified y no retirado).
  SELECT 12, 'menores de 14 conocidos · con consentimiento válido (código nuevo) · con la regla anterior',
         CASE WHEN NOT (h.pl_bd AND h.pc AND h.pc_cols AND h.al AND h.al_cols) THEN '-'
              ELSE coalesce(substring(query_to_xml(
                'select (count(*))::text || '' · '' || (count(*) filter (where m.nuevo))::text
                     || '' · '' || (count(*) filter (where m.anterior))::text as c
                   from (select
                           exists (select 1 from public.parental_consents c
                                    where c.player_id::text = p.id::text and c.email_verified and c.withdrawn_at is null
                                      and exists (select 1 from public.gdpr_audit_log a
                                                   where a.action = ''consent_email_verified''
                                                     and a.resource_type = ''parental_consents''
                                                     and a.resource_id = c.id::text
                                                     and a.metadata ->> ''player_id'' = c.player_id::text)
                                      and not exists (select 1 from public.gdpr_audit_log a
                                                       where a.action = ''consent_withdrawn''
                                                         and a.resource_type = ''parental_consents''
                                                         and a.resource_id = c.id::text)) as nuevo,
                           exists (select 1 from public.parental_consents c
                                    where c.player_id::text = p.id::text and c.email_verified and c.withdrawn_at is null) as anterior
                           from public.players p
                          where p.birth_date is not null and extract(year from age(now(), p.birth_date)) < 14) m',
                false, true, '')::text FROM '<c>([^<]*)</c>'), '-') END,
         'informativo', NULL::boolean
    FROM h
  UNION ALL
  -- 13 · INFO. El trigger de la 003 registra la retirada (consent_withdrawn); la 075 no lo toca.
  SELECT 13, 'trigger tr_audit_consents (003) en parental_consents',
         CASE WHEN NOT h.pc THEN 'tabla no existe'
              ELSE (EXISTS (SELECT 1 FROM pg_trigger t
                             WHERE t.tgrelid = to_regclass('public.parental_consents')
                               AND t.tgname = 'tr_audit_consents' AND NOT t.tgisinternal))::text END,
         'informativo (esperado: true)', NULL::boolean
    FROM h
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
