# Migraciones pendientes — Sprint 0.1 (CORREGIDAS al esquema real)

> ⚠️ **Superado por la migración 073 (30 sep 2026).** `10_rls_behavioral_wellbeing.sql`
> y las políticas de `04_044_injury_valuation_tables.sql` comparan
> `players.tenant_id = auth.uid()` (un id de tenant contra un id de usuario): con los
> datos verificados de producción no dan acceso a nadie. **No los vuelvas a ejecutar
> después de la 073**: `10` re-crea las políticas rotas (la comprobación
> `supabase/checks/073_comprobacion.sql` lo detecta) y `04` re-crea las de lesiones.
> Si `04` (= 044) se aplica por PRIMERA vez después de la 072, deja además
> `snapshots_insert_own` / `valuations_insert_own` (`WITH CHECK (true)` para todos) y los
> privilegios de cliente que la 072 retira: vuelve a ejecutar el bloque «044 ·
> player_metric_snapshots / player_valuations» de la 072 y luego la comprobación previa
> de la 073 (filas 10 y 21 lo bloquean; la propia 073 aborta si siguen ahí).
> La 073 es **solo dueño** (decisión del 30 sep 2026, ver su cabecera).
> La fuente es `supabase/migrations/`.

Proyecto Supabase: **tloadypygzqyfefanrza**.

⚠️ **Corrección aplicada:** tu BD usa `players.id` y `videos.id` de tipo **`text`**
(la app usa IDs string tipo `p1783…`), pero las migraciones 043-049 asumían `uuid`.
Ya está arreglado: `player_id`/`video_id` → `text`, y se quitaron policies que
apuntaban a columnas inexistentes (`team_members.org_id/user_id`, `players.parent_user_id`).

## Orden de ejecución (una a una: pega → Run → verifica *Success* → siguiente)

| Orden | Fichero | Desbloquea | Estado |
|-------|---------|------------|--------|
| 01 | `01_033_telegram_coach.sql` | Vincular Telegram | ✅ listo |
| 02 | `02_043_fatigue_sessions.sql` | Fatiga / ACWR | ✅ **corregido** (re-ejecutar) |
| 03 | `03_044_coaching_sessions.sql` | Coaching | ✅ corregido (team_id soft, sin FK a teams; policies org-view quitadas) |
| 04 | `04_044_injury_valuation_tables.sql` | Lesión, valoración, progresión | ✅ corregido · **requiere 02 antes** (hace ALTER a fatigue_sessions) |
| 05 | `05_045_behavioral_profiles.sql` | **ADN Mental** | ✅ corregido |
| 06 | `06_046_wellbeing_burnout.sql` | **Retención** | ✅ corregido |
| 07 | `07_047_development_plans.sql` | **IDP** | ✅ corregido |
| 08 | `08_048_tactical_heatmaps.sql` | Heatmap táctico | ✅ listo (se crea OK; tipado de ids = Fase 2) |
| 09 | `09_049_transfer_market.sql` | Transfer market | ✅ corregido |
| 10 | `10_rls_behavioral_wellbeing.sql` | **Policies** ADN Mental + Retención (lectura cliente) | ✅ idempotente (re-ejecutable) |
| 11 | `11_051_labeled_datasets.sql` | **Flywheel** dataset etiquetado (Sprint 5.3) | ✅ idempotente (RLS solo service_role) |

**Ejecuta:** 01 → 09 en orden (todas listas ya). Re-ejecuta 02 y 03 (corregidos).

## Nota sobre coaching (03)
- `team_id` quedó como referencia blanda (no hay tabla `teams` en este esquema) y se
  quitaron las policies "org members" que usaban columnas inexistentes de `team_members`.
  El coach accede vía `coach_id`; `parent_reports` queda solo para `service_role`.
  Cuando se defina el modelo de equipo, se re-atan FK + policies de org.

## Notas
- `05` y `06` activan RLS **sin policies** → solo `service_role` accede (el servidor las
  usa así; el cliente cae a caché). Añadimos policies si hace falta lectura directa.
- Si alguna falla, pásame el error EXACTO y lo arreglo. Cada fichero es independiente.

## Al terminar
1. `supabase/verify-rls.sql` → confirma RLS + tablas sin policies.
2. `npx tsx scripts/smoke-test.ts` → confirma que la app responde.
