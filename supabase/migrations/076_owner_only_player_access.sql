-- =====================================================================
-- 076 · Solo el DUEÑO accede a los datos de un jugador
--        · fuera toda rama por TENANT en RLS y funciones (sin acceso cruzado
--          entre cuentas a través de un tenant compartido)
--        · regla única en SQL: public.caller_manages_player(text) = dueño
-- =====================================================================
-- DECISIÓN (quién, cuándo, por qué, cómo revisarla)
--   · Quién: el dueño del producto, el 30 sep 2026, delegó la elección en el
--     asistente («la que veas tú mejor»); el asistente eligió SOLO EL DUEÑO.
--   · Regla: los datos de un jugador los ven y cambian SOLO su dueño
--     (players.user_id = auth.uid()) y service_role (backend, Modal, crons).
--     Sin rama por tenant y sin rama nueva por organización.
--   · Por qué: (1) son datos de menores; (2) el único players.tenant_id de
--     producción NO es ni un usuario ni una organización (verificado), así que no
--     se sabe qué agrupa; (3) la vía por organización ya está rota en producción
--     (user_org_ids/user_in_org usan team_members.org_owner_id); (4) invariante
--     #3: abstenerse (no dar acceso) es un resultado válido.
--   · Cómo revisarla: compartir con un club se reactivará más adelante, de forma
--     EXPLÍCITA, con el diseño del alta de cuentas (directores + aprobación de
--     acceso). Ese cambio toca a la vez api/_lib/ownership.ts y esta función
--     (public.caller_manages_player), con una migración nueva y su simulación.
--     Registro: docs/pendientes-metricas.md (§B, «Acceso solo del dueño · 076»).
--
-- ESTADO DE LA EVIDENCIA (léelo antes de aplicar)
--
-- VERIFICADO EN PRODUCCIÓN (consultas de solo lectura del dueño, 29-30 sep 2026):
--   · players: 3 filas, todas con el MISMO tenant_id; ese valor no es un
--     auth.users.id ni un organizations.id; ninguna tiene fecha de nacimiento.
--   · Aplicadas: 045-049, 050, 051, 052, 054, 057, 060-064, 066, 067, 069, 070,
--     071, 072, el script de emergencia anon y el script provisional 03 (DSAR).
--   · Por tanto están vivas en producción, con rama por tenant:
--       - public.dsar_caller_manages_player (072:254-296): acepta el tenant del
--         JWT (claim raíz o app_metadata.tenant_id, SIN depender del hook 057)
--         para exportar el expediente RGPD completo de un menor y pedir su borrado;
--       - match_analyses_select_owner (067:242-247);
--       - idp_plans_owner_read / idp_plans_coach_write / idp_*_via_plan (047);
--       - listings_public_read / listings_owner_write /
--         inquiries_participants_read / inquiries_participants_write (049).
--
-- NO VERIFICADO (no se ha consultado la base de datos de producción para esto):
--   · Si los usuarios comparten ese mismo tenant_id en app_metadata. Los docs
--     dicen que el 28 ago 8/8 usuarios tenían app_metadata.tenant_id (C1), pero
--     NO si es el mismo valor. La comprobación previa lo cuenta, por recurso.
--   · Si el hook 057 está ACTIVADO (solo se ve en el panel). Las políticas que
--     usan public.tenant_id() / auth.jwt()->>'tenant_id' solo abren con él; la
--     DSAR y el código de la API abren con o sin él.
--   · Si 003/004/005 (players/videos/analyses/reports/parental_consents/
--     player_anthropometrics *_tenant_isolation) y 055 (tácticas) están aplicadas
--     tal cual. Por eso todo va con to_regclass y DROP POLICY IF EXISTS.
--   · Las políticas reales de players en producción. Esta migración CREA siempre
--     una política de dueño para players, así el dueño no depende de ellas.
--
-- DEDUCIDO (del repositorio) y reproducido en SIMULACIÓN (PGlite, NO es la base
-- real; script y salida en el PR): con el hook activo y varios usuarios con el
-- mismo tenant, ANTES de la 076 un usuario que no es dueño lee, cambia y borra
-- desde el navegador jugadores, vídeos, análisis, informes, planes IDP, fichas
-- del mercado y datos tácticos de otras cuentas, y (sin hook) exporta su
-- expediente DSAR. DESPUÉS: nada de eso; los dueños conservan lo suyo;
-- service_role igual que antes.
--
-- QUÉ HACE
--   0) Guardas: sin public.players(id, user_id) o sin auth.uid() → aborta
--      (ROLLBACK, no cambia nada).
--   1) public.caller_manages_player(text): SOLO el dueño, SECURITY INVOKER (lee
--      players con los permisos y la RLS de quien consulta). Si la 073 ya la creó
--      con rama por tenant, aquí se sustituye: sus políticas quedan solo-dueño.
--   2) public.dsar_caller_manages_player(text) (072): misma firma, sin tenant.
--      Las DSAR siguen igual para el dueño y para service_role. Se corrige solo
--      el TEXTO del comentario de dsar_export_player_data / dsar_request_deletion
--      (decía «dueño/tenant»); su cuerpo y sus permisos no cambian.
--   3) Políticas: se retiran las de tenant y se crean *_076 solo-dueño (siempre
--      TO authenticated, solo lo que usa el navegador):
--        players, videos, analyses, reports, parental_consents,
--        player_anthropometrics, development_plans, idp_goals, idp_milestones,
--        idp_checkins, transfer_listings, transfer_inquiries, tactical_phases,
--        phase_heatmaps, tactical_insights, match_analyses.
--      Regla de cada fila: LEER = quien la creó (su user_id/coach/seller) o el
--      dueño de su jugador; ESCRIBIR = el dueño del jugador. Lo que no está atado
--      a un jugador (vídeo de equipo, job de partido) = solo quien lo creó.
--      parental_consents y player_anthropometrics: el navegador no los lee ni
--      escribe (grep de src/), así que no se crea política de cliente.
--   4) Guarda final: si en esas tablas queda ALGUNA política que mencione
--      tenant (p. ej. creada a mano) o si alguno de los dos helpers la menciona,
--      aborta TODO (ROLLBACK). La comprobación previa las lista antes.
--
-- QUÉ NO TOCA: PHV ni bio-banding (invariante #4: ninguna fórmula, fila, vista
-- ni valor; en player_anthropometrics solo cambia quién puede leer por RLS); las
-- políticas por organización de 027/038/039/052 (la decisión dice «sin rama por
-- organización», pero retirarlas es una migración aparte, PENDIENTE: ver pendientes);
-- user_org_ids / user_in_org; las tablas de la 073 (bienestar, conducta,
-- snapshots, lesiones, valoraciones) salvo a través del helper; subscriptions
-- (no es dato de jugador); ningún dato (ni una fila se borra ni se modifica);
-- ningún permiso de tabla (GRANT/REVOKE de tablas); Modal y service_role.
--
-- ORDEN DE DESPLIEGUE Y DEL OPERADOR
--   · El código del PR se despliega ANTES (al fusionar): ya no usa el tenant para
--     dar acceso y no depende de esta migración (el dueño entra por
--     players.user_id con service_role), así que el dueño no pierde nada.
--   · 1) supabase/checks/076_previa.sql (solo lectura): ninguna fila BLOQUEA con
--     ok = false; mandar el resultado completo. 2) esta migración. 3)
--     supabase/checks/076_posterior.sql: resultado = esperado en todas.
--   · Si la 073 se aplica DESPUÉS de esta con una versión que aún tenga la rama
--     por tenant, volver a ejecutar la 076 (la posterior lo detecta).
--   · Idempotente: se puede ejecutar varias veces y deja el mismo estado.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 0) Guardas previas (abortan toda la transacción)
-- =====================================================================
DO $guard$
BEGIN
  IF to_regclass('public.players') IS NULL THEN
    RAISE EXCEPTION '076: public.players no existe; no se aplica nada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.players'::regclass AND attname = 'user_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '076: public.players no tiene user_id (el dueño); no se aplica nada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.players'::regclass AND attname = 'id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '076: public.players no tiene id; no se aplica nada';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '076: auth.uid() no existe; no se aplica nada';
  END IF;
END $guard$;

-- =====================================================================
-- 1) Helper: ¿el llamador (JWT) es el DUEÑO de este jugador?
--    Espejo en SQL de ownsPlayer (api/_lib/ownership.ts). Si cambia la regla,
--    cambiar ambas (invariante #7) con una migración nueva.
--    SECURITY INVOKER: una tabla hija nunca da más que la tabla players.
-- =====================================================================
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

-- Los default privileges de Supabase dan EXECUTE a anon al crear la función.
-- Las políticas son TO authenticated: anon nunca las evalúa.
REVOKE ALL ON FUNCTION public.caller_manages_player(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_manages_player(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.caller_manages_player(text) IS
  '076 · ¿El llamador (JWT) es el DUEÑO del jugador? players.user_id = auth.uid(). Sin rama por tenant ni por organización (decisión 30 sep 2026). SECURITY INVOKER. Espejo de ownsPlayer (api/_lib/ownership.ts).';

-- =====================================================================
-- 2) DSAR (072): el llamador debe ser el dueño (o service_role)
--    Misma firma y lenguaje que la 072 (CREATE OR REPLACE conserva permisos y
--    lo que la llaman: dsar_export_player_data y dsar_request_deletion).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.dsar_caller_manages_player(p_player_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role   text  := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_uid    uuid  := auth.uid();
BEGIN
  IF p_player_id IS NULL OR p_player_id = '' THEN
    RETURN false;
  END IF;
  IF v_role = 'service_role' THEN
    RETURN true;
  END IF;
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.players p
     WHERE p.id::text = p_player_id
       AND p.user_id IS NOT NULL AND p.user_id = v_uid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_caller_manages_player(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dsar_caller_manages_player(text) IS
  '076 · ¿El llamador (JWT) es el DUEÑO del jugador (players.user_id = auth.uid()) o service_role? Sin rama por tenant. Solo la usan las DSAR. Espejo de ownsPlayer (api/_lib/ownership.ts).';

-- Los COMENTARIOS de la 072 en las dos RPC DSAR decían «dueño/tenant». Solo se
-- corrige el texto (firma, cuerpo, SECURITY DEFINER y permisos NO cambian), y solo
-- si la función existe (otros entornos pueden no tener la 072).
DO $cm$
BEGIN
  IF to_regprocedure('public.dsar_export_player_data(text)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.dsar_export_player_data(text) IS
      '076 · Exportación DSAR (RGPD art. 15) solo para el DUEÑO del jugador (players.user_id = auth.uid()) o service_role, vía dsar_caller_manages_player. Registra data_exported en consent_audit_log.'$c$;
  END IF;
  IF to_regprocedure('public.dsar_request_deletion(text,text)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.dsar_request_deletion(text, text) IS
      '076 · Solicitud de supresión (RGPD art. 17) solo para el DUEÑO del jugador (players.user_id = auth.uid()) o service_role, vía dsar_caller_manages_player. El solicitante sale del JWT; p_requested_by se ignora.'$c$;
  END IF;
END $cm$;

-- =====================================================================
-- 3) Políticas solo-dueño. Cada tabla se salta si no existe. Nunca anon.
--    service_role salta la RLS (el backend no depende de nada de esto).
-- =====================================================================
DO $pol$
BEGIN
  -- ── players (003 players_tenant_isolation) ─────────────────────────────
  --    Siempre una política de dueño: el dueño no depende de que sigan vivas
  --    las de 000/001/017/038 (no verificado en producción).
  ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "players_tenant_isolation" ON public.players;
  DROP POLICY IF EXISTS "players_owner_076" ON public.players;
  CREATE POLICY "players_owner_076" ON public.players
    FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

  -- ── videos (003 videos_tenant_isolation) ───────────────────────────────
  IF to_regclass('public.videos') IS NOT NULL THEN
    ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "videos_tenant_isolation" ON public.videos;
    DROP POLICY IF EXISTS "videos_select_owner_076" ON public.videos;
    DROP POLICY IF EXISTS "videos_write_owner_076" ON public.videos;
    CREATE POLICY "videos_select_owner_076" ON public.videos
      FOR SELECT TO authenticated
      USING (user_id = (SELECT auth.uid())
             OR (player_id IS NOT NULL AND public.caller_manages_player(player_id::text)));
    CREATE POLICY "videos_write_owner_076" ON public.videos
      FOR ALL TO authenticated
      USING (user_id = (SELECT auth.uid())
             AND (player_id IS NULL OR public.caller_manages_player(player_id::text)))
      WITH CHECK (user_id = (SELECT auth.uid())
                  AND (player_id IS NULL OR public.caller_manages_player(player_id::text)));
  ELSE
    RAISE NOTICE '076: videos no existe: se salta';
  END IF;

  -- ── analyses (003/004 analyses_tenant_isolation) ───────────────────────
  --    El pipeline de vídeo crea filas con user_id NULL: el dueño entra por
  --    players.user_id de su player_id.
  IF to_regclass('public.analyses') IS NOT NULL THEN
    ALTER TABLE public.analyses ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "analyses_tenant_isolation" ON public.analyses;
    DROP POLICY IF EXISTS "analyses_select_owner_076" ON public.analyses;
    DROP POLICY IF EXISTS "analyses_write_owner_076" ON public.analyses;
    CREATE POLICY "analyses_select_owner_076" ON public.analyses
      FOR SELECT TO authenticated
      USING (user_id = (SELECT auth.uid()) OR public.caller_manages_player(player_id::text));
    CREATE POLICY "analyses_write_owner_076" ON public.analyses
      FOR ALL TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));
  ELSE
    RAISE NOTICE '076: analyses no existe: se salta';
  END IF;

  -- ── reports (003/004 reports_tenant_isolation) ─────────────────────────
  --    El navegador solo los LEE (embebidos en analyses, usePlayerAnalysisV2).
  IF to_regclass('public.reports') IS NOT NULL THEN
    ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "reports_tenant_isolation" ON public.reports;
    DROP POLICY IF EXISTS "reports_select_owner_076" ON public.reports;
    IF to_regclass('public.analyses') IS NOT NULL THEN
      CREATE POLICY "reports_select_owner_076" ON public.reports
        FOR SELECT TO authenticated
        USING (public.caller_manages_player(player_id::text)
               OR EXISTS (SELECT 1 FROM public.analyses a
                           WHERE a.id = reports.analysis_id AND a.user_id = (SELECT auth.uid())));
    ELSE
      CREATE POLICY "reports_select_owner_076" ON public.reports
        FOR SELECT TO authenticated
        USING (public.caller_manages_player(player_id::text));
    END IF;
  ELSE
    RAISE NOTICE '076: reports no existe: se salta';
  END IF;

  -- ── parental_consents (003 consent_tenant_isolation) ───────────────────
  --    Sin lector ni escritor de navegador: solo service_role.
  IF to_regclass('public.parental_consents') IS NOT NULL THEN
    ALTER TABLE public.parental_consents ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "consent_tenant_isolation" ON public.parental_consents;
  ELSE
    RAISE NOTICE '076: parental_consents no existe: se salta';
  END IF;

  -- ── player_anthropometrics (005 anthro_tenant_isolation) ───────────────
  --    Sin lector ni escritor de navegador (api/players/anthropometrics.ts usa
  --    service_role). Solo cambia quién lee por RLS: ninguna medida ni PHV.
  IF to_regclass('public.player_anthropometrics') IS NOT NULL THEN
    ALTER TABLE public.player_anthropometrics ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "anthro_tenant_isolation" ON public.player_anthropometrics;
  ELSE
    RAISE NOTICE '076: player_anthropometrics no existe: se salta';
  END IF;

  -- ── development_plans + idp_goals / idp_milestones / idp_checkins (047) ─
  IF to_regclass('public.development_plans') IS NOT NULL THEN
    ALTER TABLE public.development_plans ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "idp_plans_owner_read" ON public.development_plans;
    DROP POLICY IF EXISTS "idp_plans_coach_write" ON public.development_plans;
    DROP POLICY IF EXISTS "development_plans_select_owner_076" ON public.development_plans;
    DROP POLICY IF EXISTS "development_plans_write_owner_076" ON public.development_plans;
    CREATE POLICY "development_plans_select_owner_076" ON public.development_plans
      FOR SELECT TO authenticated
      USING (coach_id = (SELECT auth.uid()) OR public.caller_manages_player(player_id::text));
    CREATE POLICY "development_plans_write_owner_076" ON public.development_plans
      FOR ALL TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (public.caller_manages_player(player_id::text));

    IF to_regclass('public.idp_goals') IS NOT NULL THEN
      ALTER TABLE public.idp_goals ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "idp_goals_via_plan" ON public.idp_goals;
      DROP POLICY IF EXISTS "idp_goals_select_owner_076" ON public.idp_goals;
      DROP POLICY IF EXISTS "idp_goals_write_owner_076" ON public.idp_goals;
      CREATE POLICY "idp_goals_select_owner_076" ON public.idp_goals
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_goals.plan_id
                          AND (d.coach_id = (SELECT auth.uid()) OR public.caller_manages_player(d.player_id::text))));
      CREATE POLICY "idp_goals_write_owner_076" ON public.idp_goals
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_goals.plan_id AND public.caller_manages_player(d.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                             WHERE d.id = idp_goals.plan_id AND public.caller_manages_player(d.player_id::text)));
    END IF;

    IF to_regclass('public.idp_milestones') IS NOT NULL THEN
      ALTER TABLE public.idp_milestones ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "idp_milestones_via_plan" ON public.idp_milestones;
      DROP POLICY IF EXISTS "idp_milestones_select_owner_076" ON public.idp_milestones;
      DROP POLICY IF EXISTS "idp_milestones_write_owner_076" ON public.idp_milestones;
      CREATE POLICY "idp_milestones_select_owner_076" ON public.idp_milestones
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_milestones.plan_id
                          AND (d.coach_id = (SELECT auth.uid()) OR public.caller_manages_player(d.player_id::text))));
      CREATE POLICY "idp_milestones_write_owner_076" ON public.idp_milestones
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_milestones.plan_id AND public.caller_manages_player(d.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                             WHERE d.id = idp_milestones.plan_id AND public.caller_manages_player(d.player_id::text)));
    END IF;

    IF to_regclass('public.idp_checkins') IS NOT NULL THEN
      ALTER TABLE public.idp_checkins ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "idp_checkins_via_plan" ON public.idp_checkins;
      DROP POLICY IF EXISTS "idp_checkins_select_owner_076" ON public.idp_checkins;
      DROP POLICY IF EXISTS "idp_checkins_write_owner_076" ON public.idp_checkins;
      CREATE POLICY "idp_checkins_select_owner_076" ON public.idp_checkins
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_checkins.plan_id
                          AND (d.coach_id = (SELECT auth.uid()) OR public.caller_manages_player(d.player_id::text))));
      CREATE POLICY "idp_checkins_write_owner_076" ON public.idp_checkins
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.development_plans d
                        WHERE d.id = idp_checkins.plan_id AND public.caller_manages_player(d.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.development_plans d
                             WHERE d.id = idp_checkins.plan_id AND public.caller_manages_player(d.player_id::text)));
    END IF;
  ELSE
    RAISE NOTICE '076: development_plans no existe (047 no aplicada): se salta con sus tablas hijas';
  END IF;

  -- ── transfer_listings / transfer_inquiries (049) ───────────────────────
  --    La lectura PÚBLICA de fichas activas (el mercado) se conserva, ahora solo
  --    con sesión (las rutas /transfer/* van bajo ProtectedRoute, App.tsx:285-287).
  IF to_regclass('public.transfer_listings') IS NOT NULL THEN
    ALTER TABLE public.transfer_listings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "listings_public_read" ON public.transfer_listings;
    DROP POLICY IF EXISTS "listings_owner_write" ON public.transfer_listings;
    DROP POLICY IF EXISTS "transfer_listings_select_076" ON public.transfer_listings;
    DROP POLICY IF EXISTS "transfer_listings_write_owner_076" ON public.transfer_listings;
    CREATE POLICY "transfer_listings_select_076" ON public.transfer_listings
      FOR SELECT TO authenticated
      USING ((visibility = 'public' AND status = 'active')
             OR seller_user_id = (SELECT auth.uid())
             OR public.caller_manages_player(player_id::text));
    CREATE POLICY "transfer_listings_write_owner_076" ON public.transfer_listings
      FOR ALL TO authenticated
      USING (public.caller_manages_player(player_id::text))
      WITH CHECK (seller_user_id = (SELECT auth.uid()) AND public.caller_manages_player(player_id::text));

    IF to_regclass('public.transfer_inquiries') IS NOT NULL THEN
      ALTER TABLE public.transfer_inquiries ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "inquiries_participants_read" ON public.transfer_inquiries;
      DROP POLICY IF EXISTS "inquiries_participants_write" ON public.transfer_inquiries;
      DROP POLICY IF EXISTS "transfer_inquiries_select_076" ON public.transfer_inquiries;
      DROP POLICY IF EXISTS "transfer_inquiries_write_076" ON public.transfer_inquiries;
      CREATE POLICY "transfer_inquiries_select_076" ON public.transfer_inquiries
        FOR SELECT TO authenticated
        USING (buyer_user_id = (SELECT auth.uid())
               OR EXISTS (SELECT 1 FROM public.transfer_listings l
                           WHERE l.id = transfer_inquiries.listing_id
                             AND (l.seller_user_id = (SELECT auth.uid()) OR public.caller_manages_player(l.player_id::text))));
      CREATE POLICY "transfer_inquiries_write_076" ON public.transfer_inquiries
        FOR ALL TO authenticated
        USING (buyer_user_id = (SELECT auth.uid())
               OR EXISTS (SELECT 1 FROM public.transfer_listings l
                           WHERE l.id = transfer_inquiries.listing_id
                             AND (l.seller_user_id = (SELECT auth.uid()) OR public.caller_manages_player(l.player_id::text))))
        WITH CHECK (buyer_user_id = (SELECT auth.uid())
                    OR EXISTS (SELECT 1 FROM public.transfer_listings l
                                WHERE l.id = transfer_inquiries.listing_id
                                  AND (l.seller_user_id = (SELECT auth.uid()) OR public.caller_manages_player(l.player_id::text))));
    END IF;
  ELSE
    RAISE NOTICE '076: transfer_listings no existe (049 no aplicada): se salta con transfer_inquiries';
  END IF;

  -- ── Tácticas: tactical_phases / phase_heatmaps / tactical_insights ─────
  --    match_id == analyses.id. Se retiran las de 048 (abiertas a CUALQUIER
  --    usuario con sesión) y las de 055 (por tenant), estén las que estén.
  IF to_regclass('public.analyses') IS NOT NULL THEN
    IF to_regclass('public.tactical_phases') IS NOT NULL THEN
      ALTER TABLE public.tactical_phases ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "tactical_phases_auth_read" ON public.tactical_phases;
      DROP POLICY IF EXISTS "tactical_phases_auth_write" ON public.tactical_phases;
      DROP POLICY IF EXISTS "tactical_phases_owner_read" ON public.tactical_phases;
      DROP POLICY IF EXISTS "tactical_phases_owner_write" ON public.tactical_phases;
      DROP POLICY IF EXISTS "tactical_phases_select_owner_076" ON public.tactical_phases;
      DROP POLICY IF EXISTS "tactical_phases_write_owner_076" ON public.tactical_phases;
      CREATE POLICY "tactical_phases_select_owner_076" ON public.tactical_phases
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = tactical_phases.match_id
                          AND (a.user_id = (SELECT auth.uid()) OR public.caller_manages_player(a.player_id::text))));
      CREATE POLICY "tactical_phases_write_owner_076" ON public.tactical_phases
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = tactical_phases.match_id AND public.caller_manages_player(a.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.analyses a
                             WHERE a.id = tactical_phases.match_id AND public.caller_manages_player(a.player_id::text)));
    END IF;

    IF to_regclass('public.phase_heatmaps') IS NOT NULL THEN
      ALTER TABLE public.phase_heatmaps ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "phase_heatmaps_auth_read" ON public.phase_heatmaps;
      DROP POLICY IF EXISTS "phase_heatmaps_auth_write" ON public.phase_heatmaps;
      DROP POLICY IF EXISTS "phase_heatmaps_owner_read" ON public.phase_heatmaps;
      DROP POLICY IF EXISTS "phase_heatmaps_owner_write" ON public.phase_heatmaps;
      DROP POLICY IF EXISTS "phase_heatmaps_select_owner_076" ON public.phase_heatmaps;
      DROP POLICY IF EXISTS "phase_heatmaps_write_owner_076" ON public.phase_heatmaps;
      CREATE POLICY "phase_heatmaps_select_owner_076" ON public.phase_heatmaps
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = phase_heatmaps.match_id
                          AND (a.user_id = (SELECT auth.uid()) OR public.caller_manages_player(a.player_id::text))));
      CREATE POLICY "phase_heatmaps_write_owner_076" ON public.phase_heatmaps
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = phase_heatmaps.match_id AND public.caller_manages_player(a.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.analyses a
                             WHERE a.id = phase_heatmaps.match_id AND public.caller_manages_player(a.player_id::text)));
    END IF;

    IF to_regclass('public.tactical_insights') IS NOT NULL THEN
      ALTER TABLE public.tactical_insights ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "tactical_insights_auth_read" ON public.tactical_insights;
      DROP POLICY IF EXISTS "tactical_insights_auth_write" ON public.tactical_insights;
      DROP POLICY IF EXISTS "tactical_insights_owner_read" ON public.tactical_insights;
      DROP POLICY IF EXISTS "tactical_insights_owner_write" ON public.tactical_insights;
      DROP POLICY IF EXISTS "tactical_insights_select_owner_076" ON public.tactical_insights;
      DROP POLICY IF EXISTS "tactical_insights_write_owner_076" ON public.tactical_insights;
      CREATE POLICY "tactical_insights_select_owner_076" ON public.tactical_insights
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = tactical_insights.match_id
                          AND (a.user_id = (SELECT auth.uid()) OR public.caller_manages_player(a.player_id::text))));
      CREATE POLICY "tactical_insights_write_owner_076" ON public.tactical_insights
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.analyses a
                        WHERE a.id = tactical_insights.match_id AND public.caller_manages_player(a.player_id::text)))
        WITH CHECK (EXISTS (SELECT 1 FROM public.analyses a
                             WHERE a.id = tactical_insights.match_id AND public.caller_manages_player(a.player_id::text)));
    END IF;
  ELSE
    RAISE NOTICE '076: analyses no existe: se saltan las tablas tácticas';
  END IF;

  -- ── match_analyses (067 match_analyses_select_owner) ───────────────────
  --    Job de equipo (no atado a un jugador): solo quien lo creó. Sigue sin
  --    ninguna escritura de cliente (067 revocó INSERT/UPDATE/DELETE).
  IF to_regclass('public.match_analyses') IS NOT NULL THEN
    ALTER TABLE public.match_analyses ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "match_analyses_select_owner" ON public.match_analyses;
    DROP POLICY IF EXISTS "match_analyses_select_owner_076" ON public.match_analyses;
    CREATE POLICY "match_analyses_select_owner_076" ON public.match_analyses
      FOR SELECT TO authenticated
      USING (user_id = (SELECT auth.uid()));
  ELSE
    RAISE NOTICE '076: match_analyses no existe (067 no aplicada): se salta';
  END IF;
END $pol$;

-- =====================================================================
-- 4) Guarda final (aborta TODO si algo sigue dando acceso por tenant en lo que
--    esta migración gestiona). La comprobación previa lo lista antes.
-- =====================================================================
DO $final$
DECLARE
  r record;
  v_bad text := '';
BEGIN
  FOR r IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('players', 'videos', 'analyses', 'reports', 'parental_consents',
                         'player_anthropometrics', 'development_plans', 'idp_goals',
                         'idp_milestones', 'idp_checkins', 'transfer_listings',
                         'transfer_inquiries', 'tactical_phases', 'phase_heatmaps',
                         'tactical_insights', 'match_analyses')
       AND lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')) LIKE '%tenant%'
     ORDER BY tablename, policyname
  LOOP
    v_bad := v_bad || ' ' || r.tablename || '.' || r.policyname;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '076: siguen políticas que usan tenant en tablas de jugador:% (no se aplica nada; mándalo)', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('caller_manages_player', 'dsar_caller_manages_player')
                AND lower(prosrc) LIKE '%tenant%') THEN
    RAISE EXCEPTION '076: un helper de dueño sigue mencionando tenant (no se aplica nada; mándalo)';
  END IF;

  RAISE NOTICE '076: comprobación final OK: ninguna política ni helper de jugador usa tenant';
END $final$;

COMMIT;
