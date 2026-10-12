-- =====================================================================
-- 075 · parental_consents: SOLO el servidor la lee y la escribe
--        · ningún permiso ni política de cliente (PUBLIC / anon / authenticated)
--        · reafirma el cierre de gdpr_audit_log de la 072 (ahí vive la evidencia
--          de que el tutor verificó el consentimiento)
-- =====================================================================
-- POR QUÉ (hallazgo B6 de la review del PR #308 «coach attestation for every clip +
-- parental consent for known under-14 before analysis»)
--
-- VERIFICADO EN PRODUCCIÓN (comprobación previa de solo lectura del dueño,
-- supabase/checks/clip_consent_previa.sql, 9 oct 2026):
--   · auth_can_update_consents = true → el rol `authenticated` tiene UPDATE sobre
--     public.parental_consents.
-- VERIFICADO LEYENDO EL CÓDIGO (repositorio, 12 oct 2026):
--   · el entrenador pone players.parental_consent_status = 'granted' desde
--     /admin/consent (src/pages/ParentalConsentPage.tsx) escribiendo él mismo el
--     nombre y el email del tutor, sin ninguna verificación del tutor;
--   · todos los que escriben parental_consents usan service_role
--     (api/auth/sign-consent.ts, api/auth/verify-consent.ts, api/_lib/accountErasure.ts)
--     y ningún fichero de src/ la lee ni la escribe (ripgrep; el único acierto en src/
--     es la clave de localStorage 'vitas_parental_consents').
-- DEDUCIDO del repositorio y reproducido en SIMULACIÓN PGlite (NO la base real; script y
-- salida en el PR): con la política 003 consent_tenant_isolation (FOR ALL TO
-- authenticated, por tenant) y un JWT con ese tenant, un usuario puede marcar como
-- verificada una fila PENDIENTE, reapuntar el player_id de una verificada, leer el token
-- del email de una pendiente y leer los datos del tutor (email, hash del DNI) de los
-- menores de ese tenant. La 076 retira esa política (que esté aplicada en producción NO
-- está verificado), pero NO los permisos de tabla.
--
-- REGLA (B6): para un menor de 14 CONOCIDO, el consentimiento que permite analizar su
-- vídeo es un registro firmado por el tutor y verificado con el token de su email
-- (api/auth/verify-consent) que el entrenador no puede crear ni cambiar; NUNCA
-- players.parental_consent_status. Fuente única en el código: api/_lib/parentalConsent.ts
-- (fila verificada + evidencia 'consent_email_verified' en gdpr_audit_log escrita por
-- verify-consent con service_role + sin retirada auditada).
--
-- ORDEN DE DESPLIEGUE (el código NO depende de esta migración)
--   · El código del PR se despliega ANTES (al fusionar). Ya no acepta una fila marcada
--     por un cliente (le falta la evidencia del servidor) y sigue aceptando un
--     consentimiento verificado de verdad, con o sin la 075. Esta migración no crea
--     columnas ni funciones que el código use: nadie se queda bloqueado por aplicarla
--     tarde, y aplicarla no rompe nada del servidor (todo va con service_role).
--   · Operador: 1) supabase/checks/075_previa.sql (solo lectura) y mandar el resultado
--     completo; 2) esta migración; 3) supabase/checks/075_posterior.sql: ok = true en
--     todas las filas. Idempotente: se puede ejecutar varias veces.
--
-- QUÉ HACE
--   0) Guarda: sin los roles anon / authenticated / service_role aborta (ROLLBACK).
--   1) parental_consents (si existe): RLS activada; se retira TODA política (cualquier
--      nombre, también consent_tenant_isolation de la 003); REVOKE ALL de tabla y de
--      cada columna a PUBLIC, anon y authenticated; GRANT SELECT, INSERT, UPDATE, DELETE
--      a service_role (los escritores del código).
--   2) gdpr_audit_log (si existe): lo mismo que la 072 (sin la política
--      audit_insert_authenticated; sin INSERT / UPDATE / DELETE / TRUNCATE de cliente, ni
--      por columna); service_role conserva SELECT e INSERT (y su secuencia).
--      authenticated conserva SELECT (política audit_read_own de la 003).
--   3) Guarda final: si queda algún permiso o política de cliente, o le falta algo a
--      service_role, aborta TODO (ROLLBACK) con la lista.
--
-- QUÉ NO TOCA: ningún dato (ni una fila se crea, cambia o borra); PHV ni bio-banding
-- (invariante #4); el trigger audit_consent_changes y log_gdpr_action (003/072);
-- players.parental_consent_status ni la página /admin/consent; consent_audit_log (036);
-- Modal ni nada de vision-pipeline.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 0) Guarda previa (aborta toda la transacción)
-- =====================================================================
DO $guard$
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION '075: faltan roles de Supabase (anon / authenticated / service_role); no se aplica nada';
  END IF;
END $guard$;

-- =====================================================================
-- 1) parental_consents: solo service_role
-- =====================================================================
DO $pc$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.parental_consents') IS NULL THEN
    RAISE NOTICE '075: public.parental_consents no existe: se salta';
    RETURN;
  END IF;

  ALTER TABLE public.parental_consents ENABLE ROW LEVEL SECURITY;

  -- La de la 003 por nombre (estática) y, además, cualquier otra (p. ej. creada a mano).
  DROP POLICY IF EXISTS "consent_tenant_isolation" ON public.parental_consents;
  FOR r IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'parental_consents'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.parental_consents', r.policyname);
    RAISE NOTICE '075: política retirada de parental_consents: %', r.policyname;
  END LOOP;

  REVOKE ALL ON TABLE public.parental_consents FROM PUBLIC, anon, authenticated;
  -- REVOKE de tabla no quita los permisos POR COLUMNA: se quitan uno a uno.
  FOR r IN
    SELECT attname FROM pg_attribute
     WHERE attrelid = 'public.parental_consents'::regclass AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON public.parental_consents FROM PUBLIC, anon, authenticated', r.attname);
  END LOOP;

  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parental_consents TO service_role;
END $pc$;

-- =====================================================================
-- 2) gdpr_audit_log: reafirma la 072 (la evidencia del consentimiento vive aquí)
-- =====================================================================
DO $audit$
DECLARE
  r record;
  v_seq text;
BEGIN
  IF to_regclass('public.gdpr_audit_log') IS NULL THEN
    RAISE NOTICE '075: public.gdpr_audit_log no existe: se salta (sin ella el gate de clips falla cerrado: supabase/checks/clip_consent_previa.sql)';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "audit_insert_authenticated" ON public.gdpr_audit_log;
  REVOKE ALL ON TABLE public.gdpr_audit_log FROM anon;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.gdpr_audit_log FROM PUBLIC, authenticated;
  FOR r IN
    SELECT attname FROM pg_attribute
     WHERE attrelid = 'public.gdpr_audit_log'::regclass AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I) ON public.gdpr_audit_log FROM PUBLIC, anon, authenticated',
                   r.attname, r.attname);
  END LOOP;

  GRANT SELECT, INSERT ON TABLE public.gdpr_audit_log TO service_role;
  v_seq := pg_get_serial_sequence('public.gdpr_audit_log', 'id');
  IF v_seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', v_seq);
  END IF;
END $audit$;

-- =====================================================================
-- 3) Guarda final (aborta TODO si queda algo de cliente o le falta algo al servidor)
-- =====================================================================
DO $final$
DECLARE
  r record;
  p text;
  rl text;
  v_seq text;
  v_bad text := '';
BEGIN
  IF to_regclass('public.parental_consents') IS NOT NULL THEN
    FOR r IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'parental_consents'
    LOOP
      v_bad := v_bad || ' parental_consents: política ' || r.policyname || ';';
    END LOOP;
    FOREACH rl IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(rl, 'public.parental_consents', p) THEN
          v_bad := v_bad || ' parental_consents: ' || rl || ' ' || p || ';';
        END IF;
      END LOOP;
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(rl, 'public.parental_consents', p) THEN
          v_bad := v_bad || ' parental_consents: ' || rl || ' ' || p || ' por columna;';
        END IF;
      END LOOP;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.parental_consents', p) THEN
        v_bad := v_bad || ' parental_consents: service_role sin ' || p || ';';
      END IF;
    END LOOP;
  END IF;

  IF to_regclass('public.gdpr_audit_log') IS NOT NULL THEN
    FOREACH rl IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(rl, 'public.gdpr_audit_log', p) THEN
          v_bad := v_bad || ' gdpr_audit_log: ' || rl || ' ' || p || ';';
        END IF;
      END LOOP;
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
        IF has_any_column_privilege(rl, 'public.gdpr_audit_log', p) THEN
          v_bad := v_bad || ' gdpr_audit_log: ' || rl || ' ' || p || ' por columna;';
        END IF;
      END LOOP;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
      IF NOT has_table_privilege('service_role', 'public.gdpr_audit_log', p) THEN
        v_bad := v_bad || ' gdpr_audit_log: service_role sin ' || p || ';';
      END IF;
    END LOOP;
    v_seq := pg_get_serial_sequence('public.gdpr_audit_log', 'id');
    IF v_seq IS NOT NULL AND NOT has_sequence_privilege('service_role', v_seq, 'USAGE') THEN
      v_bad := v_bad || ' gdpr_audit_log: service_role sin USAGE en ' || v_seq || ';';
    END IF;
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '075: quedan permisos de cliente o faltan los del servidor:% (no se aplica nada; mándalo)', v_bad;
  END IF;
  RAISE NOTICE '075: comprobación final OK: parental_consents solo service_role; gdpr_audit_log sin escritura de cliente';
END $final$;

COMMIT;
