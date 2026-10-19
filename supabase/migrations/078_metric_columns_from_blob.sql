-- =====================================================================
-- 078 · Columnas metric_* y vsi de players = proyección del blob, sin 0 inventado
-- (P1 bloque 7b · invariante #2)
--
-- Esquema REAL de producción leído el 19 oct (paso38, T2-A): el disparador
-- trg_sync_player_columns → sync_player_columns_from_jsonb() hacía
--   metric_* := COALESCE(NEW.metric_*, (data->'metrics'->>'x')::numeric, 0)
--   vsi      := COALESCE(NEW.vsi, (data->>'vsi')::numeric)
-- y las columnas metric_* tienen DEFAULT 0. Dos defectos:
--   (a) un jugador NO evaluado queda con 0 en las seis columnas (no medido ≠ 0);
--   (b) en un UPDATE que no manda la columna, NEW.<col> = valor viejo ⇒ la columna se
--       queda rancia aunque cambie el blob (la causa del desfase columna/blob).
-- Desde el P1 bloque 5a las barras se leen del blob; la columna `vsi` aún la leen
-- peer.ts, el análisis base y los informes de equipo (null ya se maneja desde la 059):
-- que sea copia exacta del blob es lo correcto para todos. Arreglo: la columna es SIEMPRE la proyección
-- del blob (null si falta o no es un número) y sin DEFAULT 0.
--
-- Conteos en producción (paso39, T2-B, 19 oct): 0 jugadores con columna ≠ blob, así que
-- NO se reescribe ninguna fila (los existentes ya coinciden); el cambio protege lo que
-- se guarde a partir de ahora.
--
-- Todo lo demás del cuerpo es IDÉNTICO al de producción: protección de phv_category /
-- phv_offset (069), sexo sin 'M' (058), resto de columnas. La 078 NO toca PHV,
-- Mirwald, %PAH ni bio-banding (invariante #4). Fuera de alcance (P2): competitive_level
-- 'Regional' y minutes_played 0 por defecto; la RPC get_ranked_players sin uso.
-- =====================================================================
BEGIN;
-- El DROP DEFAULT toma un bloqueo exclusivo breve sobre players: no esperar detrás de
-- una transacción larga bloqueando a todos.
SET LOCAL lock_timeout = '5s';

-- Guarda: el cuerpo actual debe ser el de producción leído en T2-A (si alguien lo
-- cambió después, no se pisa a ciegas) y la función sigue siendo SECURITY INVOKER sin
-- SET de configuración (CREATE OR REPLACE los restablecería).
DO $guarda$
DECLARE
  cuerpo text;
BEGIN
  SELECT p.prosrc INTO cuerpo
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'sync_player_columns_from_jsonb'
     AND NOT p.prosecdef AND p.proconfig IS NULL;
  IF cuerpo IS NULL THEN
    RAISE EXCEPTION '078: no existe public.sync_player_columns_from_jsonb() como SECURITY INVOKER sin SET (no es el esperado)';
  END IF;
  IF cuerpo !~ 'NEW\.metric_speed\s*:=\s*COALESCE\(NEW\.metric_speed,\s*\(NEW\.data->''metrics''->>''speed''\)::numeric,\s*0\)'
     OR cuerpo !~ 'NEW\.vsi\s*:=\s*COALESCE\(NEW\.vsi,\s*\(NEW\.data->>''vsi''\)::numeric\)'
     OR cuerpo !~ 'NEW\.phv_category\s*:=\s*OLD\.phv_category' THEN
    RAISE EXCEPTION '078: el cuerpo de sync_player_columns_from_jsonb() no es el esperado (T2-A, 19 oct). No se aplica.';
  END IF;
END
$guarda$;

CREATE OR REPLACE FUNCTION public.sync_player_columns_from_jsonb()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
BEGIN
  IF jwt_role IS DISTINCT FROM 'service_role' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.phv_category := OLD.phv_category;
      NEW.phv_offset   := OLD.phv_offset;
    ELSE
      NEW.phv_category := NULL;
      NEW.phv_offset   := NULL;
    END IF;
  END IF;

  IF NEW.data IS NOT NULL THEN
    NEW.name              := COALESCE(NEW.name, NEW.data->>'name');
    NEW.age               := COALESCE(NEW.age, (NEW.data->>'age')::int);
    NEW.position          := COALESCE(NEW.position, NEW.data->>'position');
    NEW.foot              := COALESCE(NEW.foot, NEW.data->>'foot');
    NEW.height_cm         := COALESCE(NEW.height_cm, (NEW.data->>'height')::numeric);
    NEW.weight_kg         := COALESCE(NEW.weight_kg, (NEW.data->>'weight')::numeric);
    NEW.sitting_height    := COALESCE(NEW.sitting_height, (NEW.data->>'sittingHeight')::numeric);
    NEW.leg_length        := COALESCE(NEW.leg_length, (NEW.data->>'legLength')::numeric);
    NEW.competitive_level := COALESCE(NEW.competitive_level, NEW.data->>'competitiveLevel', 'Regional');
    NEW.minutes_played    := COALESCE(NEW.minutes_played, (NEW.data->>'minutesPlayed')::int, 0);
    -- invariante #5: sin fallback 'M' (058)
    NEW.gender            := COALESCE(NEW.gender, NEW.data->>'gender');
    -- 078 (invariante #2): las barras y el VSI de ficha son la PROYECCIÓN del blob: null si
    -- faltan o no son un número (nunca 0) y sin conservar un valor viejo de la columna.
    NEW.metric_speed      := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'speed') = 'number' THEN (NEW.data->'metrics'->>'speed')::numeric END;
    NEW.metric_technique  := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'technique') = 'number' THEN (NEW.data->'metrics'->>'technique')::numeric END;
    NEW.metric_vision     := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'vision') = 'number' THEN (NEW.data->'metrics'->>'vision')::numeric END;
    NEW.metric_stamina    := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'stamina') = 'number' THEN (NEW.data->'metrics'->>'stamina')::numeric END;
    NEW.metric_shooting   := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'shooting') = 'number' THEN (NEW.data->'metrics'->>'shooting')::numeric END;
    NEW.metric_defending  := CASE WHEN jsonb_typeof(NEW.data->'metrics'->'defending') = 'number' THEN (NEW.data->'metrics'->>'defending')::numeric END;
    NEW.vsi               := CASE WHEN jsonb_typeof(NEW.data->'vsi') = 'number' THEN (NEW.data->>'vsi')::numeric END;
    -- 069: phv_category / phv_offset YA NO se copian del blob. Son propiedad del
    -- endpoint gateado de antropometría (fila completa + edad por fecha + sexo).
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE public.players
  ALTER COLUMN metric_speed     DROP DEFAULT,
  ALTER COLUMN metric_technique DROP DEFAULT,
  ALTER COLUMN metric_vision    DROP DEFAULT,
  ALTER COLUMN metric_stamina   DROP DEFAULT,
  ALTER COLUMN metric_shooting  DROP DEFAULT,
  ALTER COLUMN metric_defending DROP DEFAULT;

COMMENT ON FUNCTION public.sync_player_columns_from_jsonb() IS
  'Copia el blob players.data a las columnas. phv_category/phv_offset: solo service_role (069). metric_* y vsi: proyección exacta del blob, null si faltan o no son número (078, invariante #2). Sexo sin fallback M (058).';

COMMIT;
