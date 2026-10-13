-- =====================================================================
-- VITAS · 075 · COMPROBACIÓN POSTERIOR · SOLO LECTURA
-- Ejecútala DESPUÉS de la migración 075 y manda el resultado COMPLETO.
--   · ok = false en cualquier fila  →  la 075 no quedó como se espera; mándalo.
--   · ok vacío (NULL) = fila informativa (o «no aplica» porque la tabla no existe).
-- No escribe nada (una sola consulta SELECT) y no falla si falta algún objeto
-- (to_regclass / to_regrole / to_regprocedure). Probada en SIMULACIÓN PGlite (NO en tu
-- base): base vacía, todas las migraciones del repo y la forma de producción (sin
-- 073/076), antes de la 075 (sin la 076 sale ok = false en las filas 2-5; con la 076, en
-- las 3-5) y después (ok = true en las filas 1-8), más controles positivos (un GRANT de
-- tabla, un GRANT por columna y una política creada a mano se detectan).
-- =====================================================================
WITH
hh AS (
  SELECT
    to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL
      AND to_regrole('service_role') IS NOT NULL AS roles,
    to_regclass('public.parental_consents') IS NOT NULL AS pc,
    to_regclass('public.gdpr_audit_log') IS NOT NULL AS al
),
filas(n, comprobacion, resultado, esperado, ok) AS (
  -- 1 · Roles de Supabase.
  SELECT 1, 'roles anon · authenticated · service_role existen', hh.roles::text, 'true', hh.roles
    FROM hh
  UNION ALL
  -- 2 · Ninguna política de cliente en parental_consents.
  SELECT 2, 'políticas en parental_consents',
         CASE WHEN NOT hh.pc THEN 'tabla no existe'
              ELSE coalesce((SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) FROM pg_policies p
                              WHERE p.schemaname = 'public' AND p.tablename = 'parental_consents'), 'ninguna') END,
         'ninguna',
         CASE WHEN NOT hh.pc THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'parental_consents') END
    FROM hh
  UNION ALL
  -- 3 · authenticated sin ningún permiso de tabla.
  SELECT 3, 'parental_consents · authenticated: SELECT · INSERT · UPDATE · DELETE · TRUNCATE · REFERENCES · TRIGGER',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN 'no aplica'
              ELSE has_table_privilege('authenticated', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'DELETE')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'TRUNCATE')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'REFERENCES')::text || ' · '
                || has_table_privilege('authenticated', 'public.parental_consents', 'TRIGGER')::text END,
         'false · false · false · false · false · false · false',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN NULL
              ELSE NOT (has_table_privilege('authenticated', 'public.parental_consents', 'SELECT')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'INSERT')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'UPDATE')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'DELETE')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'TRUNCATE')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'REFERENCES')
                     OR has_table_privilege('authenticated', 'public.parental_consents', 'TRIGGER')) END
    FROM hh
  UNION ALL
  -- 4 · anon sin ningún permiso de tabla.
  SELECT 4, 'parental_consents · anon: SELECT · INSERT · UPDATE · DELETE · TRUNCATE · REFERENCES · TRIGGER',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN 'no aplica'
              ELSE has_table_privilege('anon', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'DELETE')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'TRUNCATE')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'REFERENCES')::text || ' · '
                || has_table_privilege('anon', 'public.parental_consents', 'TRIGGER')::text END,
         'false · false · false · false · false · false · false',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN NULL
              ELSE NOT (has_table_privilege('anon', 'public.parental_consents', 'SELECT')
                     OR has_table_privilege('anon', 'public.parental_consents', 'INSERT')
                     OR has_table_privilege('anon', 'public.parental_consents', 'UPDATE')
                     OR has_table_privilege('anon', 'public.parental_consents', 'DELETE')
                     OR has_table_privilege('anon', 'public.parental_consents', 'TRUNCATE')
                     OR has_table_privilege('anon', 'public.parental_consents', 'REFERENCES')
                     OR has_table_privilege('anon', 'public.parental_consents', 'TRIGGER')) END
    FROM hh
  UNION ALL
  -- 5 · Tampoco por columna (has_any_column_privilege incluye la tabla y cada columna).
  SELECT 5, 'parental_consents · alguna columna · authenticated SELECT · INSERT · UPDATE · REFERENCES | anon (igual)',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN 'no aplica'
              ELSE has_any_column_privilege('authenticated', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_any_column_privilege('authenticated', 'public.parental_consents', 'REFERENCES')::text || ' | '
                || has_any_column_privilege('anon', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_any_column_privilege('anon', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_any_column_privilege('anon', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_any_column_privilege('anon', 'public.parental_consents', 'REFERENCES')::text END,
         'false · false · false · false | false · false · false · false',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN NULL
              ELSE NOT (has_any_column_privilege('authenticated', 'public.parental_consents', 'SELECT')
                     OR has_any_column_privilege('authenticated', 'public.parental_consents', 'INSERT')
                     OR has_any_column_privilege('authenticated', 'public.parental_consents', 'UPDATE')
                     OR has_any_column_privilege('authenticated', 'public.parental_consents', 'REFERENCES')
                     OR has_any_column_privilege('anon', 'public.parental_consents', 'SELECT')
                     OR has_any_column_privilege('anon', 'public.parental_consents', 'INSERT')
                     OR has_any_column_privilege('anon', 'public.parental_consents', 'UPDATE')
                     OR has_any_column_privilege('anon', 'public.parental_consents', 'REFERENCES')) END
    FROM hh
  UNION ALL
  -- 6 · service_role conserva lo que usa el código (sign/verify-consent, el gate, el borrado RGPD).
  SELECT 6, 'parental_consents · service_role: SELECT · INSERT · UPDATE · DELETE',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN 'no aplica'
              ELSE has_table_privilege('service_role', 'public.parental_consents', 'SELECT')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'INSERT')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'UPDATE')::text || ' · '
                || has_table_privilege('service_role', 'public.parental_consents', 'DELETE')::text END,
         'true · true · true · true',
         CASE WHEN NOT hh.pc OR NOT hh.roles THEN NULL
              ELSE has_table_privilege('service_role', 'public.parental_consents', 'SELECT')
               AND has_table_privilege('service_role', 'public.parental_consents', 'INSERT')
               AND has_table_privilege('service_role', 'public.parental_consents', 'UPDATE')
               AND has_table_privilege('service_role', 'public.parental_consents', 'DELETE') END
    FROM hh
  UNION ALL
  -- 7 · gdpr_audit_log (evidencia): sin política de INSERT abierta y sin escritura de cliente.
  SELECT 7, 'gdpr_audit_log: política audit_insert_authenticated · authenticated/anon INSERT · UPDATE · DELETE (tabla o columna)',
         CASE WHEN NOT hh.al THEN 'tabla no existe'
              WHEN NOT hh.roles THEN 'no aplica'
              ELSE (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'gdpr_audit_log'
                       AND p.policyname = 'audit_insert_authenticated')::text || ' · '
                || (has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'INSERT')
                    OR has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'UPDATE')
                    OR has_table_privilege('authenticated', 'public.gdpr_audit_log', 'DELETE'))::text || ' · '
                || (has_any_column_privilege('anon', 'public.gdpr_audit_log', 'INSERT')
                    OR has_any_column_privilege('anon', 'public.gdpr_audit_log', 'UPDATE')
                    OR has_table_privilege('anon', 'public.gdpr_audit_log', 'DELETE'))::text END,
         '0 · false · false',
         CASE WHEN NOT hh.al OR NOT hh.roles THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'gdpr_audit_log'
                                  AND p.policyname = 'audit_insert_authenticated')
               AND NOT (has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'INSERT')
                        OR has_any_column_privilege('authenticated', 'public.gdpr_audit_log', 'UPDATE')
                        OR has_table_privilege('authenticated', 'public.gdpr_audit_log', 'DELETE')
                        OR has_any_column_privilege('anon', 'public.gdpr_audit_log', 'INSERT')
                        OR has_any_column_privilege('anon', 'public.gdpr_audit_log', 'UPDATE')
                        OR has_table_privilege('anon', 'public.gdpr_audit_log', 'DELETE')) END
    FROM hh
  UNION ALL
  -- 8 · gdpr_audit_log: service_role lee y escribe (el gate y verify-consent).
  SELECT 8, 'gdpr_audit_log · service_role: SELECT · INSERT',
         CASE WHEN NOT hh.al THEN 'tabla no existe'
              WHEN NOT hh.roles THEN 'no aplica'
              ELSE has_table_privilege('service_role', 'public.gdpr_audit_log', 'SELECT')::text || ' · '
                || has_table_privilege('service_role', 'public.gdpr_audit_log', 'INSERT')::text END,
         'true · true',
         CASE WHEN NOT hh.al OR NOT hh.roles THEN NULL
              ELSE has_table_privilege('service_role', 'public.gdpr_audit_log', 'SELECT')
               AND has_table_privilege('service_role', 'public.gdpr_audit_log', 'INSERT') END
    FROM hh
  UNION ALL
  -- 9 · INFO. El trigger de la 003 (registra la retirada) sigue ahí: la 075 no lo toca.
  SELECT 9, 'trigger tr_audit_consents (003) en parental_consents',
         CASE WHEN NOT hh.pc THEN 'tabla no existe'
              ELSE (EXISTS (SELECT 1 FROM pg_trigger t
                             WHERE t.tgrelid = to_regclass('public.parental_consents')
                               AND t.tgname = 'tr_audit_consents' AND NOT t.tgisinternal))::text END,
         'informativo (esperado: true)', NULL::boolean
    FROM hh
  UNION ALL
  -- 10 · INFO. log_gdpr_action (003/072): solo service_role la ejecuta (la 075 no la toca).
  SELECT 10, 'log_gdpr_action: EXECUTE authenticated · service_role',
         CASE WHEN to_regprocedure('public.log_gdpr_action(uuid, uuid, text, text, text, jsonb, inet)') IS NULL THEN 'no existe'
              WHEN NOT hh.roles THEN 'no aplica'
              ELSE has_function_privilege('authenticated', to_regprocedure('public.log_gdpr_action(uuid, uuid, text, text, text, jsonb, inet)'), 'EXECUTE')::text
                || ' · '
                || has_function_privilege('service_role', to_regprocedure('public.log_gdpr_action(uuid, uuid, text, text, text, jsonb, inet)'), 'EXECUTE')::text END,
         'informativo (esperado: false · true, estado de la 072)', NULL::boolean
    FROM hh
  UNION ALL
  -- 11 · La RLS sigue activada en parental_consents (P1 bloque 0, nit de la revisión del
  --      paquete): sin RLS, un GRANT que alguien añadiera después abriría todas las filas.
  SELECT 11, 'parental_consents: RLS activada',
         CASE WHEN NOT hh.pc THEN 'tabla no existe'
              ELSE (SELECT c.relrowsecurity::text FROM pg_class c WHERE c.oid = to_regclass('public.parental_consents')) END,
         'true',
         CASE WHEN NOT hh.pc THEN NULL
              ELSE (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.parental_consents')) END
    FROM hh
)
SELECT n, comprobacion, resultado, esperado, ok
  FROM filas
 ORDER BY n;
