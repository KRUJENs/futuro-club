-- =====================================================================
-- 073 · RLS SOLO DUEÑO para bienestar y perfil conductual
--       · sustituye las 10 políticas que comparan players.tenant_id con
--         auth.uid() (un id de TENANT contra un id de USUARIO)
--       · regla única en un helper: public.caller_manages_player(text)
--         = players.user_id = auth.uid()   (espejo de ownsPlayer)
-- =====================================================================
-- DECISIÓN DE ALCANCE (registrada el 30 sep 2026) · léela antes que nada
--   · QUÉ: por RLS y por funciones de base de datos, a los datos de un jugador
--     solo accede su DUEÑO (players.user_id = auth.uid()) y service_role. SIN
--     rama por tenant y SIN rama por organización / membresía de club.
--   · QUIÉN: el dueño del producto delegó la elección el 30 sep 2026 («la que
--     veas tú mejor») y el asistente (Claude) eligió SOLO DUEÑO.
--   · POR QUÉ:
--       1. Son datos de menores (bienestar, conducta, asistencia, riesgo de
--          abandono).
--       2. VERIFICADO en producción (consultas de solo lectura del dueño, 29-30
--          sep): los 3 jugadores comparten un ÚNICO players.tenant_id que no es
--          un auth.users.id ni un organizations.id. No se sabe qué representa,
--          así que «mismo tenant» no identifica a una academia concreta.
--       3. La vía por organización ya está rota: user_org_ids()/user_in_org() de
--          producción usan team_members.org_owner_id (docs/pendientes-metricas.md
--          §5-D). No hay hoy un modelo de membresía en el que apoyarse.
--       4. Invariante #3: no dar acceso (abstenerse) es un resultado válido.
--     Coincide con las rutas de servidor de estas mismas tablas, que ya usan
--     ownsPlayer (solo dueño): api/behavioral/[action].ts:59,
--     api/wellbeing/[action].ts:73,132, api/wellbeing/_dropout-risk.ts:51,
--     api/injuries/_list.ts:31, api/injuries/_save.ts:46 (invariante #7: una
--     sola regla para BD y servidor).
--   · CÓMO SE REVISA: compartir con club/academia se reactivará de forma
--     EXPLÍCITA en una migración POSTERIOR, junto con el diseño del alta de
--     cuentas (directores + aprobación de acceso) y con su propia comprobación
--     previa. No se hace editando esta migración.
--   · LO QUE LA 073 NO CUBRE (siguen teniendo rama por tenant; esta migración no
--     los toca; pendiente en docs/pendientes-metricas.md §5-D). Los cubre la 076,
--     en curso en el PR #307 (abierto y SIN mergear el 1 oct 2026; su cabecera
--     está leída, su contenido NO está revisado en este PR). Orden: la 073 y la
--     076 se pueden aplicar en cualquier orden (SIMULADO): la 076 deja el mismo
--     helper solo dueño y la 073 conserva el de la 076 si ya está:
--       - DSAR de la 072: public.dsar_caller_manages_player compara
--         players.tenant_id::text con el tenant del JWT, del claim raíz o de
--         app_metadata (072:264,285). SIMULADO (PGlite): un usuario NO dueño con
--         el mismo app_metadata.tenant_id exporta los datos del menor y marca su
--         borrado (con el mismo texto; en MAYÚSCULAS, no). La comprobación previa lo
--         cuenta (fila 19).
--       - RLS de la tabla players: players_tenant_isolation (003:239-247, FOR ALL
--         TO authenticated por tenant). En producción NO verificado (la previa lo
--         lista, filas 6 y 20). SIMULADO: un compañero de tenant puede hacer
--         UPDATE players SET user_id = él mismo; desde ese momento es «dueño» y
--         la 073 le deja entrar como a cualquier dueño (igual que ya le deja
--         ownsPlayer en el servidor).
--       - Código de servidor que usa ownsPlayerOrTenant: api/auth/sign-consent.ts:100,
--         api/analyses/reports.ts:73, api/videos/create-upload.ts:106,
--         api/videos/finalize.ts:114 y ownsVideo (api/_lib/ownership.ts:134).
--
-- LECTURA DE player_metric_snapshots: RETENIDA (no se crea política de cliente)
--   La única lectura de navegador (useMetricSnapshots.ts:40-47 →
--   SnapshotHistoryChart.tsx:40,93 en /players/:id/evolution) dibuja phv_offset
--   tal cual viene de la fila, sin gate PHV ni procedencia. Su escritor,
--   POST /api/agents/progression-tracker, no comprueba propiedad
--   (_progression-tracker.ts:46: requireAuth + allowServiceToken, ningún
--   ownsPlayer/isServiceCall en el fichero) y guarda el PHV que manda el
--   cliente (:64-65) con la service key. VERIFICADO en producción: ningún
--   jugador tiene fecha de nacimiento, así que ningún PHV de snapshot es fiable
--   hoy (regla del dueño: sin todas las medidas, el PHV no se muestra). Abrir
--   esa lectura convertiría PHV no medido en PHV visible en la ficha de un
--   menor. Se retira la política rota (snapshots_read_own) y NO se crea otra:
--   el gráfico sigue vacío, como hoy. Se reabrirá en una migración posterior
--   cuando (a) progression-tracker compruebe propiedad y no acepte PHV del
--   cliente y (b) el gráfico pase por el gate PHV y muestre la procedencia.
-- =====================================================================
-- ESTADO DE LA EVIDENCIA
--
-- VERIFICADO EN PRODUCCIÓN (consultas de solo lectura del dueño, 29-30 sep 2026):
--   · players: 3 filas. tenant_id = user_id en 0 filas; tenant_id <> user_id en 3;
--     tenant_id NULL en 0; user_id NULL en 0; 1 único valor de tenant_id, que NO es
--     un organizations.id NI un auth.users.id. Ninguno tiene fecha de nacimiento.
--   · Antes de la 050, behavioral_profiles, attendance_records,
--     engagement_snapshots, wellbeing_questionnaires y dropout_risk_assessments
--     tenían RLS activada y NINGUNA política (Advisor de Supabase + pg_policies).
--   · La 050 se aplicó el 30 sep («Success») ANTES de que su comprobación previa
--     pasara: creó behavioral_owner_all, attendance_owner_all, engagement_owner_all,
--     questionnaires_owner_all y dropout_owner_all (FOR ALL, sin TO) con
--     player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid()).
--   · Aplicadas también: 045-049, 051, 052, 054, 057, 060-064, 066, 067, 069,
--     070, 071, 072, el script de emergencia anon y el script provisional 03 (DSAR).
--   · public.user_org_ids() / user_in_org(uuid) de producción NO son las del repo
--     (038): usan team_members.org_owner_id. Esta migración NO las usa ni las toca.
--
-- DEDUCIDO de esos datos (y reproducido en SIMULACIÓN, ver abajo): con el dato
-- verificado, la regla «tenant_id = auth.uid()» no da acceso a NADIE. La 050 no
-- abrió nada: el navegador recibe 0 filas y sus upserts fallan (42501), igual que
-- antes de la 050.
--
-- VERIFICADO EN EL REPOSITORIO (lectura de ficheros + el test
-- src/test/migrations/rlsOwnerPolicies.test.ts, ROJO sin esta migración):
--   · Las 10 políticas rotas y aún vigentes (ninguna migración posterior las
--     cambia; 072:590-607 solo quitó snapshots_insert_own y valuations_insert_own,
--     y conservó snapshots_read_own a propósito, 072:566-567; 071 no define
--     ninguna política):
--       050:19-22 behavioral_owner_all · 050:27-30 attendance_owner_all ·
--       050:34-37 engagement_owner_all · 050:41-44 questionnaires_owner_all ·
--       050:48-51 dropout_owner_all · 044:33-37 org_members_read_injuries ·
--       044:39-43 org_members_insert_injuries · 044:45-49 org_members_update_injuries ·
--       044:80-83 snapshots_read_own · 044:116-119 valuations_read_own.
--   · Qué necesita el NAVEGADOR (cliente supabase con el JWT del usuario,
--     src/lib/supabase.ts:27), y por tanto qué se concede aquí, nada más:
--       - behavioral_profiles: SELECT (behavioralProfileService.ts:149-155, vivo vía
--         useBehavioralProfile.ts:63 y useDMScore.ts:67) + upsert
--         (localStorageMigrationService.ts:182-184) ⇒ SELECT, INSERT, UPDATE.
--       - attendance_records: SELECT (wellbeingService.ts:108-113) + upsert
--         (wellbeingService.ts:147-157; localStorageMigrationService.ts:211-213)
--         ⇒ SELECT, INSERT, UPDATE.
--       - engagement_snapshots: SELECT (wellbeingService.ts:169-174) + upsert
--         (wellbeingService.ts:203-205; localStorageMigrationService.ts:236-238)
--         ⇒ SELECT, INSERT, UPDATE.
--       - wellbeing_questionnaires y dropout_risk_assessments: upsert
--         (localStorageMigrationService.ts:265-267 y :298-300). Un upsert
--         (INSERT ... ON CONFLICT DO UPDATE) exige también política SELECT
--         (SIMULADO: sin ella, el upsert sobre una fila existente y el INSERT ...
--         RETURNING fallan con 42501; el INSERT simple pasa) ⇒ SELECT, INSERT, UPDATE.
--       - player_metric_snapshots: la lectura existe pero se RETIENE (ver arriba).
--       - player_injuries y player_valuations: NINGÚN llamador de navegador (grep de
--         src/). Sus lectores/escritores son de servidor con service_role (salta la
--         RLS). ⇒ se retiran sus políticas rotas y NO se crea ninguna de cliente.
--       - DELETE: ningún llamador vivo de navegador ⇒ no se concede.
--   · Toda política SELECT de players del repositorio incluye user_id = auth.uid()
--     (000:19-20, 001:27-31, 027:41-52, 038:76-80), y el listado de jugadores del
--     propio navegador depende de ello (supabasePlayerService.ts:89-93).
--
-- DECISIÓN TÉCNICA: helper SECURITY INVOKER (no DEFINER).
--   Se evalúa con los permisos y la RLS de players de quien consulta. Así una
--   tabla hija NUNCA da más que la tabla players: si el usuario no puede ver al
--   jugador, tampoco ve su bienestar. No añade superficie SECURITY DEFINER (el lint
--   de 072 no tiene nada que permitir). Si en producción ninguna política de
--   players deja al dueño leer su jugador (la previa lo mira, fila 5), falla
--   CERRADA (sin acceso), nunca abre. No se reutiliza dsar_caller_manages_player:
--   072:386 la revoca a authenticated, tiene rama por tenant y esta migración no
--   toca objetos de la 072.
--
-- GUARDA (sección 3): la migración ABORTA entera (RAISE EXCEPTION; BEGIN/COMMIT
-- deshace todo) si al terminar (a) el helper tuviera rama por tenant/organización
-- o fuera SECURITY DEFINER, o (b) quedara en las 8 tablas alguna política
-- PERMISSIVE que no sea de esta migración ni solo de service_role: podría dejar
-- entrar a quien no es dueño (p. ej. snapshots_insert_own / valuations_insert_own
-- de la 044, WITH CHECK (true) para todos, si la 044 se aplicó DESPUÉS de la 072).
--
-- SIMULACIÓN PGlite (NO es la base de datos real), la misma en PostgreSQL 18.3
-- (PGlite 0.5.8) y 16.4 (PGlite 0.2.17), con la forma verificada de producción (3
-- jugadores, 1 tenant que no es ni usuario ni organización, dueños A y B, 050 y 072
-- aplicadas, cuerpos de producción de user_org_ids/user_in_org) y con la cadena
-- completa del repo:
--   · ANTES de 073: en las 5 tablas de bienestar/perfil y en player_metric_snapshots
--     y player_valuations, nadie (dueño, compañero de tenant, otro usuario, anon)
--     ve filas ni escribe (42501). EXCEPCIÓN: en player_injuries cualquier usuario
--     con sesión podía INSERTAR una lesión para CUALQUIER jugador (rama created_by).
--   · DESPUÉS: el dueño A hace EXACTAMENTE las operaciones del navegador (SELECT,
--     INSERT, UPDATE/upsert, upsert con RETURNING) sobre filas de SU jugador y nada
--     sobre las de B. Un compañero de tenant NO dueño no ve ni escribe nada, lleve
--     o no el claim raíz tenant_id (claims generados con el hook 057). DELETE borra
--     0 filas; anon nada; player_metric_snapshots, player_injuries y
--     player_valuations nada para el cliente.
--   · 073 corre dos veces sin error y deja el mismo estado; también sobre la cadena
--     SIN la 050 (otros entornos, p. ej. demo: no verificado si la tienen), sobre
--     una base vacía (todo se salta con NOTICE), sin players.tenant_id y encima de
--     la versión anterior de esta migración (dueño O tenant, PR #303 en 8508b8e; la 073
--     no está en la lista verificada de aplicadas en producción): retira sus políticas
--     *_owner_or_tenant.
--   · Con una política ajena abierta en una de las 8 tablas, la 073 aborta y la
--     base queda idéntica a como estaba.
--   · Ninguna función, vista ni permiso distinto de los de abajo cambia (DSAR,
--     user_org_ids, user_in_org, PHV: definición y ACL idénticas antes y después).
--
-- NO VERIFICADO (no se ha consultado la base de datos de producción para esto):
--   · Si la 044 está aplicada en producción (player_injuries,
--     player_metric_snapshots, player_valuations). Por eso todo va con to_regclass.
--   · Las políticas REALES de players en producción (la comprobación previa las
--     mira: si ninguna deja al dueño leer su jugador, esta migración queda inerte y
--     cerrada, no abre nada).
--   · Las columnas reales de las 5 tablas en producción. Según el repo, algunas
--     escrituras del navegador fallarán por COLUMNA aunque la RLS ya deje:
--     attendance «notes», questionnaires «date», dropout «date»/«primary_factor»
--     (no existen en 046). Fallo silencioso y a la caché local, como hoy.
--
-- QUÉ NO TOCA: PHV ni bio-banding (invariante #4: ninguna fórmula, fila ni vista);
-- DSAR ni ningún objeto de la 072; user_org_ids/user_in_org; la RLS de players;
-- permisos de tabla (GRANT/REVOKE de tablas); datos. Solo: una función nueva, sus
-- permisos y políticas de las 8 tablas (DROP POLICY IF EXISTS + CREATE POLICY).
--
-- ORDEN DEL OPERADOR: 1) comprobación previa de solo lectura
-- (supabase/checks/073_previa.sql): todas las filas con ok = true (ok vacío =
-- informativa). 2) esta migración. 3) comprobación posterior
-- (supabase/checks/073_comprobacion.sql): resultado = esperado en todas. Es
-- idempotente: se puede ejecutar varias veces.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1) Helper: ¿el llamador (JWT) es el DUEÑO de este jugador?
--    Espejo en SQL de ownsPlayer (api/_lib/ownership.ts:53). Si cambia la
--    regla, cambiar ambas (invariante #7) con una migración nueva.
--    SECURITY INVOKER (ver DECISIÓN TÉCNICA). search_path fijado y nombres
--    cualificados. Un solo cuerpo: no depende de players.tenant_id ni de
--    public.tenant_id().
--    Si la 076 (PR #307) ya instaló este helper (COMMENT «076 ·», mismo cuerpo
--    solo dueño), se conserva tal cual: la 073 no lo pisa. La guarda (sección 3)
--    vuelve a comprobar que es solo dueño e INVOKER en cualquier caso.
-- =====================================================================
DO $do$
BEGIN
  IF to_regclass('public.players') IS NULL THEN
    RAISE NOTICE '073: public.players no existe: no se crea el helper ni se tocan políticas';
    RETURN;
  END IF;

  IF to_regprocedure('public.caller_manages_player(text)') IS NOT NULL
     AND coalesce(obj_description(to_regprocedure('public.caller_manages_player(text)'), 'pg_proc'), '') LIKE '076 ·%' THEN
    RAISE NOTICE '073: public.caller_manages_player ya es el de la 076 (solo dueño): se conserva';
  ELSE
    CREATE OR REPLACE FUNCTION public.caller_manages_player(p_player_id text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = public, pg_temp
    AS $fn$
      SELECT EXISTS (
        SELECT 1
          FROM public.players p
         WHERE p.id::text = p_player_id
           AND p.user_id IS NOT NULL
           AND p.user_id = (SELECT auth.uid())
      )
    $fn$;

    COMMENT ON FUNCTION public.caller_manages_player(text) IS
      '073 · ¿El llamador (JWT) es el DUEÑO de este jugador? players.user_id = auth.uid(). Solo dueño, sin rama por tenant ni por organización (decisión del 30 sep 2026, ver cabecera de la 073). SECURITY INVOKER: respeta la RLS de players. Espejo de ownsPlayer (api/_lib/ownership.ts).';
  END IF;

  -- Los default privileges de Supabase dan EXECUTE a anon al crear la función.
  -- Las políticas son TO authenticated: anon nunca las evalúa ni necesita EXECUTE.
  REVOKE ALL ON FUNCTION public.caller_manages_player(text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.caller_manages_player(text) TO authenticated, service_role;
END $do$;

-- =====================================================================
-- 2) Políticas. Cada tabla se salta si no existe. Siempre TO authenticated
--    (nunca anon), solo las operaciones que usa el navegador y WITH CHECK en las
--    escrituras. service_role salta la RLS (el backend no depende de esto).
--    Se borran también los nombres *_owner_or_tenant de la versión anterior de
--    esta migración (dueño O tenant; PR #303 en 8508b8e) y los nuevos
--    *_owner antes de crearlos (re-ejecutable).
-- =====================================================================
DO $do$
BEGIN
  IF to_regprocedure('public.caller_manages_player(text)') IS NULL THEN
    RAISE NOTICE '073: sin helper (public.players no existe): no se tocan políticas';
    RETURN;
  END IF;

  -- ── behavioral_profiles (045; política rota de 050:19-22) ──────────────
  IF to_regclass('public.behavioral_profiles') IS NOT NULL THEN
    ALTER TABLE public.behavioral_profiles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "behavioral_owner_all" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_select_owner_or_tenant" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_insert_owner_or_tenant" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_update_owner_or_tenant" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_select_owner" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_insert_owner" ON public.behavioral_profiles;
    DROP POLICY IF EXISTS "behavioral_profiles_update_owner" ON public.behavioral_profiles;
    CREATE POLICY "behavioral_profiles_select_owner" ON public.behavioral_profiles
      FOR SELECT TO authenticated
      USING (public.caller_manages_player(player_id::text));
    CREATE POLICY "behavioral_profiles_insert_owner" ON public.behavioral_profiles
      FOR INSERT TO authenticated
      WITH CHECK (public.caller_manages_player(player_id::text));
    CREATE POLICY "behavioral_profiles_update_owner" ON public.behavioral_profiles
      FOR UPDATE TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '073: behavioral_profiles no existe: se salta';
  END IF;

  -- ── attendance_records (046; política rota de 050:27-30) ───────────────
  IF to_regclass('public.attendance_records') IS NOT NULL THEN
    ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "attendance_owner_all" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_select_owner_or_tenant" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_insert_owner_or_tenant" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_update_owner_or_tenant" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_select_owner" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_insert_owner" ON public.attendance_records;
    DROP POLICY IF EXISTS "attendance_records_update_owner" ON public.attendance_records;
    CREATE POLICY "attendance_records_select_owner" ON public.attendance_records
      FOR SELECT TO authenticated
      USING (public.caller_manages_player(player_id::text));
    CREATE POLICY "attendance_records_insert_owner" ON public.attendance_records
      FOR INSERT TO authenticated
      WITH CHECK (public.caller_manages_player(player_id::text));
    CREATE POLICY "attendance_records_update_owner" ON public.attendance_records
      FOR UPDATE TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '073: attendance_records no existe: se salta';
  END IF;

  -- ── engagement_snapshots (046; política rota de 050:34-37) ─────────────
  IF to_regclass('public.engagement_snapshots') IS NOT NULL THEN
    ALTER TABLE public.engagement_snapshots ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "engagement_owner_all" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_select_owner_or_tenant" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_insert_owner_or_tenant" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_update_owner_or_tenant" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_select_owner" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_insert_owner" ON public.engagement_snapshots;
    DROP POLICY IF EXISTS "engagement_snapshots_update_owner" ON public.engagement_snapshots;
    CREATE POLICY "engagement_snapshots_select_owner" ON public.engagement_snapshots
      FOR SELECT TO authenticated
      USING (public.caller_manages_player(player_id::text));
    CREATE POLICY "engagement_snapshots_insert_owner" ON public.engagement_snapshots
      FOR INSERT TO authenticated
      WITH CHECK (public.caller_manages_player(player_id::text));
    CREATE POLICY "engagement_snapshots_update_owner" ON public.engagement_snapshots
      FOR UPDATE TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '073: engagement_snapshots no existe: se salta';
  END IF;

  -- ── wellbeing_questionnaires (046; política rota de 050:41-44) ─────────
  IF to_regclass('public.wellbeing_questionnaires') IS NOT NULL THEN
    ALTER TABLE public.wellbeing_questionnaires ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "questionnaires_owner_all" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_select_owner_or_tenant" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_insert_owner_or_tenant" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_update_owner_or_tenant" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_select_owner" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_insert_owner" ON public.wellbeing_questionnaires;
    DROP POLICY IF EXISTS "wellbeing_questionnaires_update_owner" ON public.wellbeing_questionnaires;
    CREATE POLICY "wellbeing_questionnaires_select_owner" ON public.wellbeing_questionnaires
      FOR SELECT TO authenticated
      USING (public.caller_manages_player(player_id::text));
    CREATE POLICY "wellbeing_questionnaires_insert_owner" ON public.wellbeing_questionnaires
      FOR INSERT TO authenticated
      WITH CHECK (public.caller_manages_player(player_id::text));
    CREATE POLICY "wellbeing_questionnaires_update_owner" ON public.wellbeing_questionnaires
      FOR UPDATE TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '073: wellbeing_questionnaires no existe: se salta';
  END IF;

  -- ── dropout_risk_assessments (046; política rota de 050:48-51) ─────────
  IF to_regclass('public.dropout_risk_assessments') IS NOT NULL THEN
    ALTER TABLE public.dropout_risk_assessments ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "dropout_owner_all" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_select_owner_or_tenant" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_insert_owner_or_tenant" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_update_owner_or_tenant" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_select_owner" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_insert_owner" ON public.dropout_risk_assessments;
    DROP POLICY IF EXISTS "dropout_risk_assessments_update_owner" ON public.dropout_risk_assessments;
    CREATE POLICY "dropout_risk_assessments_select_owner" ON public.dropout_risk_assessments
      FOR SELECT TO authenticated
      USING (public.caller_manages_player(player_id::text));
    CREATE POLICY "dropout_risk_assessments_insert_owner" ON public.dropout_risk_assessments
      FOR INSERT TO authenticated
      WITH CHECK (public.caller_manages_player(player_id::text));
    CREATE POLICY "dropout_risk_assessments_update_owner" ON public.dropout_risk_assessments
      FOR UPDATE TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '073: dropout_risk_assessments no existe: se salta';
  END IF;

  -- ── player_metric_snapshots (044; política rota 044:80-83) ─────────────
  --    Se retira la lectura rota y NO se crea ninguna de cliente: la lectura del
  --    navegador queda RETENIDA (ver cabecera: PHV sin gate en el gráfico de
  --    evolución + escritor sin comprobación de propiedad). La escritura sigue
  --    siendo solo service_role (snapshots_insert_service_role de 072, que NO se
  --    toca).
  IF to_regclass('public.player_metric_snapshots') IS NOT NULL THEN
    ALTER TABLE public.player_metric_snapshots ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "snapshots_read_own" ON public.player_metric_snapshots;
    DROP POLICY IF EXISTS "player_metric_snapshots_select_owner_or_tenant" ON public.player_metric_snapshots;
  ELSE
    RAISE NOTICE '073: player_metric_snapshots no existe (044 no aplicada): se salta';
  END IF;

  -- ── player_injuries (044; políticas rotas 044:33-49) ───────────────────
  --    Datos de salud (RGPD art. 9) sin ningún llamador de navegador: se retiran
  --    las 3 políticas y NO se crea ninguna de cliente (solo service_role, que
  --    salta la RLS). La rama created_by = auth.uid() de 044:41 dejaba además a
  --    cualquier usuario con sesión INSERTAR una lesión para CUALQUIER jugador
  --    poniendo created_by = él mismo (SIMULADO en PGlite).
  IF to_regclass('public.player_injuries') IS NOT NULL THEN
    ALTER TABLE public.player_injuries ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "org_members_read_injuries" ON public.player_injuries;
    DROP POLICY IF EXISTS "org_members_insert_injuries" ON public.player_injuries;
    DROP POLICY IF EXISTS "org_members_update_injuries" ON public.player_injuries;
  ELSE
    RAISE NOTICE '073: player_injuries no existe (044 no aplicada): se salta';
  END IF;

  -- ── player_valuations (044; política rota 044:116-119) ─────────────────
  --    Sin lector ni escritor en todo el repositorio: se retira la lectura de
  --    cliente. valuations_insert_service_role (072) NO se toca.
  IF to_regclass('public.player_valuations') IS NOT NULL THEN
    ALTER TABLE public.player_valuations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "valuations_read_own" ON public.player_valuations;
  ELSE
    RAISE NOTICE '073: player_valuations no existe (044 no aplicada): se salta';
  END IF;
END $do$;

-- =====================================================================
-- 3) GUARDA · ABORTA la migración entera (RAISE EXCEPTION: la transacción se
--    deshace y la base queda como estaba) si, al terminar, alguien que NO es el
--    dueño pudiera entrar por las políticas de estas 8 tablas:
--      a) el helper es SECURITY DEFINER o tiene rama por tenant/organización;
--      b) queda en las 8 tablas una política PERMISSIVE que no es de la 073 y
--         no es solo de service_role (p. ej. creada a mano, re-creada por un
--         script de supabase/pending/, o snapshots_insert_own /
--         valuations_insert_own de la 044 si la 044 se aplicó DESPUÉS de la
--         072). Las RESTRICTIVE no dan acceso: no cuentan.
--    Si aborta: manda el mensaje de error completo; no reintentes a ciegas.
-- =====================================================================
DO $do$
DECLARE
  v_definer boolean;
  v_body text;
  v_ajenas text;
BEGIN
  IF to_regprocedure('public.caller_manages_player(text)') IS NULL THEN
    RETURN; -- public.players no existe: no se ha creado nada (NOTICE de la sección 1)
  END IF;

  SELECT p.prosecdef, p.prosrc INTO v_definer, v_body
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.caller_manages_player(text)');
  IF v_definer OR v_body ~* '(tenant|org|team_member)' THEN
    RAISE EXCEPTION '073 GUARDA: public.caller_manages_player no es solo dueño (SECURITY DEFINER o rama por tenant/organización). No se aplica nada.';
  END IF;

  SELECT string_agg(format('%s.%s (%s, %s)', po.tablename, po.policyname, po.cmd, array_to_string(po.roles, ',')),
                    '; ' ORDER BY po.tablename, po.policyname)
    INTO v_ajenas
    FROM pg_policies po
   WHERE po.schemaname = 'public'
     AND po.tablename IN ('behavioral_profiles', 'attendance_records', 'engagement_snapshots',
                          'wellbeing_questionnaires', 'dropout_risk_assessments',
                          'player_metric_snapshots', 'player_injuries', 'player_valuations')
     AND po.permissive = 'PERMISSIVE'
     AND po.roles <> ARRAY['service_role']::name[]
     AND (po.tablename, po.policyname) NOT IN (
           VALUES ('behavioral_profiles'::name, 'behavioral_profiles_select_owner'::name),
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
                  ('dropout_risk_assessments', 'dropout_risk_assessments_update_owner'));
  IF v_ajenas IS NOT NULL THEN
    RAISE EXCEPTION '073 GUARDA: quedan políticas que la 073 no controla y que podrían dar acceso a quien no es dueño: %. No se aplica nada. Si son snapshots_insert_own / valuations_insert_own (044 aplicada después de la 072), vuelve a ejecutar el bloque «044 · player_metric_snapshots / player_valuations» de la 072 y repite la comprobación previa.', v_ajenas;
  END IF;

  RAISE NOTICE '073: guarda superada (helper solo dueño; ninguna política ajena en las 8 tablas)';
END $do$;

-- =====================================================================
-- 4) Comprobación final (solo lectura): avisa con WARNING de cualquier política
--    de public que siga comparando tenant_id con auth.uid() (fuera de las 8
--    tablas, p. ej. creada a mano; dentro de ellas ya lo impide la guarda). No
--    aborta: tras 073 debería salir 0.
-- =====================================================================
DO $do$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname,
           regexp_replace(regexp_replace(lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')),
                                         '::[a-z_]+( varying| precision)?', '', 'g'),
                          '[[:space:]()"]', '', 'g') AS expr
      FROM pg_policies
     WHERE schemaname = 'public'
  LOOP
    IF r.expr ~ 'tenant_id(=|in)(select)?auth\.uid'
       OR r.expr ~ 'auth\.uid(asuid)?=([a-z0-9_]+\.)*tenant_id' THEN
      n := n + 1;
      RAISE WARNING '073: la política %.% sigue comparando tenant_id con auth.uid()', r.tablename, r.policyname;
    END IF;
  END LOOP;
  RAISE NOTICE '073: comprobación final: % política(s) de public comparan tenant_id con auth.uid()', n;
END $do$;

COMMIT;
