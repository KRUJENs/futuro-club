-- VITAS · Comprobación SOLO LECTURA antes de desplegar el gate de consentimiento de clips
-- (PR feat/clip-consent-gate · api/_lib/analysisConsentGate.ts).
--
-- Devuelve UNA fila; no falla si falta algún objeto (to_regclass / query_to_xml).
-- Probada en PGlite (simulación, NO la base real) con: base vacía, todas las migraciones
-- del repo, todas + datos de ejemplo, y migraciones hasta la 071 (sin 072) como control.
--
-- Qué hacer con el resultado:
--   - audit_table_exists=false o audit_columns<>8  → el gate fallaría cerrado (500) en TODA
--     subida y todo análisis: NO desplegar hasta crear public.gdpr_audit_log (migración 003).
--   - audit_open_insert_policy<>0 o auth_can_insert_audit/auth_can_update_audit=true → un
--     usuario podría falsificar declaraciones: aplicar antes la 072.
--   - service_can_select_audit/service_can_insert_audit=false → el gate (que SOLO usa
--     service_role) no podría leer ni guardar declaraciones: fallaría cerrado (500) en toda
--     subida y análisis. NO desplegar: falta el privilegio de service_role sobre la tabla.
--     (Añadido en la ronda 3 de la review del PR #308: ningún otro código de api/ o src/ usa
--     esta tabla, así que producción no da ninguna prueba de que el privilegio exista.)
--   - players_birth_date_exists=false → la regla de menores no puede aplicarse (el gate trata
--     la fecha como desconocida y basta la declaración): aplicar la 036.
--   - minors_blocked_without_consent>0 → ese número de jugadores (menores de 14 con fecha de
--     nacimiento) quedará SIN análisis hasta que su tutor firme y confirme el consentimiento.
--   - videos_bunny_id_not_uuid>0 o videos_id_unsafe>0 → esos vídeos ya NO se pueden analizar
--     (400 invalid_video_reference, ronda 3 · B4): el servidor solo mete en una URL un GUID
--     de Bunny con forma de UUID y una referencia sin `/`, `.`, `%`, espacios ni comillas.
--     Esperado 0 (la app genera GUID de Bunny, `vid-<hex>` y `local-<ts>-<rand>`). Si sale
--     >0, NO desplegar sin revisar esas filas: o son de prueba, o la forma del GUID de Bunny
--     no es la que asume el código (no verificado contra la documentación de Bunny, que solo
--     dice «The GUID of the video», string).
--   - auth_can_update_consents=true → informativo: ver docs/pendientes-metricas.md §E
--     (un authenticated con claim tenant_id puede cambiar filas de parental_consents de su
--     tenant; simulación PGlite). La ronda 4 registró true en la previa del dueño del 9 oct.
--     Desde la ronda 5 (B6) el código no acepta nada que salga de esas filas: ni una marcada
--     como verificada, ni un hash de token reescrito, ni un jugador o email reapuntado (el
--     token, el jugador y el email salen de la EMISIÓN que escribe sign-consent con
--     service_role). La ronda 4 decía lo mismo y era FALSO para el token reescrito y la fila
--     reapuntada (simulación PGlite del revisor). La migración 075 retira además esos
--     permisos (supabase/checks/075_previa.sql / 075_posterior.sql).
--   - minors_blocked_without_consent cuenta, desde la ronda 5, con la regla del código nuevo:
--     consentimiento verificado CON la emisión del enlace ('consent_token_issued') y la
--     verificación del tutor ('consent_email_verified') del MISMO token y jugador, y sin
--     retirada auditada.
select
  to_regclass('public.gdpr_audit_log') is not null                                   as audit_table_exists,          -- esperado: true
  (select count(*)::int from information_schema.columns
     where table_schema = 'public' and table_name = 'gdpr_audit_log'
       and column_name in ('user_id','tenant_id','action','resource_type','resource_id','metadata','ip','created_at'))
                                                                                     as audit_columns,               -- esperado: 8
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'gdpr_audit_log' and policyname = 'audit_insert_authenticated')
                                                                                     as audit_open_insert_policy,    -- esperado: 0
  case when to_regclass('public.gdpr_audit_log') is null then null
       else has_table_privilege('authenticated', 'public.gdpr_audit_log', 'INSERT') end as auth_can_insert_audit,     -- esperado: false
  case when to_regclass('public.gdpr_audit_log') is null then null
       else has_table_privilege('authenticated', 'public.gdpr_audit_log', 'UPDATE') end as auth_can_update_audit,     -- esperado: false
  case when to_regclass('public.gdpr_audit_log') is null then null
       else has_table_privilege('service_role', 'public.gdpr_audit_log', 'SELECT') end as service_can_select_audit,   -- esperado: true
  case when to_regclass('public.gdpr_audit_log') is null then null
       else has_table_privilege('service_role', 'public.gdpr_audit_log', 'INSERT') end as service_can_insert_audit,   -- esperado: true
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'players' and column_name = 'birth_date')
                                                                                     as players_birth_date_exists,   -- esperado: true
  (select count(*)::int from information_schema.columns
     where table_schema = 'public' and table_name = 'parental_consents'
       and column_name in ('player_id','email_verified','withdrawn_at'))             as consent_columns,             -- esperado: 3
  case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'players' and column_name = 'birth_date')
       then (xpath('/row/c/text()', query_to_xml(
              'select count(*)::int as c from public.players
                 where birth_date is not null and extract(year from age(now(), birth_date)) < 14',
              false, true, '')))[1]::text::int
  end                                                                                as known_minors_under_14,       -- informativo
  case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'players' and column_name = 'birth_date')
        and (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'parental_consents'
                 and column_name in ('id','player_id','email_verified','withdrawn_at')) = 4
        and (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'gdpr_audit_log'
                 and column_name in ('action','resource_type','resource_id','metadata')) = 4
       -- B6 (ronda 5): cuenta solo un consentimiento verificado CON la emisión del enlace y la
       -- verificación del tutor del MISMO token y jugador, y sin retirada auditada
       -- (api/_lib/parentalConsent.ts); nada que salga de la fila mutable cuenta.
       then (xpath('/row/c/text()', query_to_xml(
              'select count(*)::int as c from public.players p
                 where p.birth_date is not null and extract(year from age(now(), p.birth_date)) < 14
                   and not exists (select 1 from public.parental_consents c
                                    where c.player_id::text = p.id::text and c.email_verified = true and c.withdrawn_at is null
                                      and exists (select 1 from public.gdpr_audit_log i
                                                   join public.gdpr_audit_log v
                                                     on v.action = ''consent_email_verified''
                                                    and v.resource_type = ''parental_consents''
                                                    and v.resource_id = i.resource_id
                                                    and v.metadata ->> ''player_id'' = c.player_id::text
                                                    and v.metadata ->> ''token_hash'' = i.metadata ->> ''token_hash''
                                                   where i.action = ''consent_token_issued''
                                                     and i.resource_type = ''parental_consents''
                                                     and i.resource_id = c.id::text
                                                     and i.metadata ->> ''player_id'' = c.player_id::text
                                                     and i.metadata ->> ''token_hash'' like ''sha256:%'')
                                      and not exists (select 1 from public.gdpr_audit_log a
                                                       where a.action = ''consent_withdrawn''
                                                         and a.resource_type = ''parental_consents''
                                                         and a.resource_id = c.id::text))',
              false, true, '')))[1]::text::int
  end                                                                                as minors_blocked_without_consent, -- informativo: se bloquearían
  case when to_regclass('public.parental_consents') is null then null
       else has_table_privilege('authenticated', 'public.parental_consents', 'UPDATE') end as auth_can_update_consents, -- informativo (riesgo de forja)
  case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'videos' and column_name = 'bunny_video_id')
       then (xpath('/row/c/text()', query_to_xml(
              'select count(*)::int as c from public.videos
                 where bunny_video_id is not null
                   and bunny_video_id !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''',
              false, true, '')))[1]::text::int
  end                                                                                as videos_bunny_id_not_uuid,    -- esperado: 0 (B4)
  case when to_regclass('public.videos') is null then null
       else (xpath('/row/c/text()', query_to_xml(
              'select count(*)::int as c from public.videos
                 where id !~ ''^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$''',
              false, true, '')))[1]::text::int
  end                                                                                as videos_id_unsafe;            -- esperado: 0 (B4)
