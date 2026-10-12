/**
 * Migración 074 — ESCRIBIR datos de un jugador exige ser su DUEÑO.
 *
 * No hay Postgres en CI: se fija el CONTRATO de forma estática. El comportamiento
 * (antes = otra cuenta escribe filas de un jugador ajeno; después = 42501; el
 * dueño hace lo mismo que antes; service_role igual) se comprobó en una SIMULACIÓN
 * PGlite fuera del repo (PostgreSQL 18.3 y 16.4), descrita en el PR.
 *
 *  - lint del repositorio (rlsPolicyLint · unguardedPlayerWrites) con control
 *    positivo: SIN la 074 encuentra las 12 tablas; CON ella solo quedan las
 *    EXCLUIDAS documentadas (otra regla o de otro PR). «Exige ser el dueño» se
 *    decide por la estructura de la regla (en un OR, todas las ramas): así cae la
 *    rama por organización del RAG (039), que antes se daba por buena;
 *  - las guardas son RESTRICTIVE, TO authenticated, solo WITH CHECK con el helper
 *    solo-dueño de la 073/076 (que la 074 NO redefine);
 *  - transaccional, guardas que abortan, idempotente, sin tocar datos, PHV,
 *    funciones, permisos de tabla, RLS ni tracking_jobs (PR #308);
 *  - comprobaciones previa/posterior: una sola consulta de solo lectura.
 */
import { describe, it, expect } from "vitest";
import { buildPolicyState, tablesWithColumn, unguardedPlayerWrites, requiresPlayerOwnership, serviceRoleOnly } from "./rlsPolicyLint";
import { buildState, splitStatements, type MigrationFile } from "./securityDefinerLint";

const raw = import.meta.glob("/supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const checks = import.meta.glob("/supabase/checks/074_*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const ALL: MigrationFile[] = Object.entries(raw)
  .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
const FILE = "074_rls_player_write_ownership.sql";
const sql = raw[`/supabase/migrations/${FILE}`] ?? "";
const code = sql.replace(/--.*$/gm, "");
const WITHOUT_074 = ALL.filter((f) => f.name !== FILE);
const BEFORE_076 = WITHOUT_074.filter((f) => f.name < "076_");

/** Las 12 tablas de la 074 (mismo orden que en la migración y las comprobaciones). */
const TABLES = [
  "fatigue_sessions", "development_plans", "idp_goals", "idp_milestones", "idp_checkins",
  "tracking_sessions", "player_analyses", "videos", "live_events", "scout_insights",
  "evaluation_history", "player_knowledge",
];
/**
 * MISMA CLASE, NO INCLUIDAS en la 074 (documentadas en su cabecera y en
 * docs/pendientes-metricas.md): otra regla (rivales / propiedad de la sesión) o
 * las arregla otro PR (tracking_jobs → #308).
 */
const EXCLUDED = [
  "public.match_events|INSERT|Users manage their own events",
  "public.match_events|UPDATE|Users manage their own events",
  "public.player_session_metrics|INSERT|Access via session ownership",
  "public.player_session_metrics|UPDATE|Access via session ownership",
  "public.tracking_jobs|INSERT|tracking_jobs_insert",
];

const playerTables = (files: MigrationFile[]) => new Set([...tablesWithColumn(files, "player_id"), ...tablesWithColumn(files, "plan_id")]);
const gaps = (files: MigrationFile[]) => unguardedPlayerWrites(files, playerTables(files)).map((g) => `${g.table}|${g.cmd}|${g.policy}`);
const gapTables = (files: MigrationFile[]) => [...new Set(unguardedPlayerWrites(files, playerTables(files)).map((g) => g.table.replace(/^public\./, "")))].sort();

// ─── Motor del lint: casos sintéticos ────────────────────────────────────────

describe("rlsPolicyLint · escrituras de cliente sin propiedad del jugador", () => {
  const one = (s: string, name = "900_x.sql"): MigrationFile[] => [{ name, sql: s }];
  const t = `CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY, user_id uuid NOT NULL, player_id text NOT NULL);`;

  it("tablesWithColumn: CREATE TABLE y ALTER TABLE … ADD COLUMN (también dentro de DO)", () => {
    const files = one(`${t}
      create table public.u (id int, "player_id" text);
      CREATE TABLE v (id int, CONSTRAINT x CHECK (player_id_x > 0), other text);
      ALTER TABLE v ADD COLUMN IF NOT EXISTS player_id text;
      DO $$ BEGIN CREATE TABLE w (player_id text); END $$;
      CREATE TABLE z (player text, player_ids text[]);`);
    expect([...tablesWithColumn(files, "player_id")].sort()).toEqual(["public.t", "public.u", "public.v", "public.w"]);
  });

  it("marca la regla de solo-autor y NO la de dueño, service_role ni la cubierta por una RESTRICTIVE", () => {
    const tables = new Set(["public.t"]);
    const base = `${t} CREATE POLICY own ON t FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;
    expect(unguardedPlayerWrites(one(base), tables).map((g) => `${g.cmd}:${g.policy}`)).toEqual(["INSERT:own", "UPDATE:own"]);
    // UPDATE sin WITH CHECK: la regla de la fila nueva es el USING
    expect(unguardedPlayerWrites(one(`${t} CREATE POLICY u ON t FOR UPDATE USING (user_id = auth.uid());`), tables).map((g) => g.cmd)).toEqual(["UPDATE"]);
    // Cubierta: RESTRICTIVE con el helper para cada comando
    const covered = `${base}
      CREATE POLICY gi ON t AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));
      CREATE POLICY gu ON t AS RESTRICTIVE FOR UPDATE TO authenticated WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));`;
    expect(unguardedPlayerWrites(one(covered), tables)).toEqual([]);
    // Solo INSERT cubierto → queda UPDATE
    const half = `${base} CREATE POLICY gi ON t AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.caller_manages_player(player_id::text));`;
    expect(unguardedPlayerWrites(one(half), tables).map((g) => g.cmd)).toEqual(["UPDATE"]);
    // Una PERMISSIVE con el helper no es una guarda (se combina con OR)
    const permissive = `${base} CREATE POLICY gp ON t FOR INSERT TO authenticated WITH CHECK (public.caller_manages_player(player_id::text));`;
    expect(unguardedPlayerWrites(one(permissive), tables).map((g) => `${g.cmd}:${g.policy}`)).toEqual(["INSERT:own", "UPDATE:own"]);
    // Reglas que ya exigen ser el dueño, o solo service_role / TO service_role: no se marcan
    for (const ok of [
      "CREATE POLICY a ON t FOR ALL TO authenticated USING (public.caller_manages_player(player_id::text)) WITH CHECK (public.caller_manages_player(player_id::text));",
      "CREATE POLICY b ON t FOR INSERT WITH CHECK (player_id IN (SELECT id FROM players WHERE user_id = auth.uid()));",
      "CREATE POLICY c ON t FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');",
      "CREATE POLICY d ON t FOR ALL TO service_role USING (true) WITH CHECK (true);",
      "CREATE POLICY e ON t FOR SELECT USING (auth.uid() = user_id);",
      "CREATE POLICY f ON t FOR DELETE USING (auth.uid() = user_id);",
    ]) {
      expect(unguardedPlayerWrites(one(`${t} ${ok}`), tables), ok).toEqual([]);
    }
    expect(requiresPlayerOwnership("coach_id = auth.uid() OR tenant_id = (auth.jwt() ->> 'tenant_id')::uuid")).toBe(false);
    expect(serviceRoleOnly("auth.uid() = user_id OR auth.role() = 'service_role'")).toBe(false);
  });

  it("requiresPlayerOwnership: en un OR TODAS las ramas; en un AND basta una (rama por organización = no es dueño)", () => {
    const own = "player_id IN (SELECT id FROM players WHERE user_id = auth.uid())";
    // Sí exige ser el dueño
    for (const ok of [
      own,
      `(${own})`,
      "public.caller_manages_player(player_id::text)",
      "player_id IS NULL OR public.caller_manages_player(player_id::text)",
      `user_id = auth.uid() AND ${own}`,
      "EXISTS (SELECT 1 FROM public.players p WHERE p.id = t.player_id AND p.user_id = (SELECT auth.uid()))",
      "EXISTS (SELECT 1 FROM public.development_plans d WHERE d.id = t.plan_id AND public.caller_manages_player(d.player_id::text))",
      `${own} OR auth.role() = 'service_role'`,
    ]) {
      expect(requiresPlayerOwnership(ok), ok).toBe(true);
    }
    // NO exige ser el dueño
    for (const bad of [
      // 039: evaluation_history / player_knowledge (la rama por organización no mira al jugador)
      `${own} OR org_id IN (SELECT user_org_ids())`,
      `(${own}) OR (org_id IN (SELECT user_org_ids()))`,
      // subconsulta a players con rama por organización DENTRO
      "player_id IN (SELECT id FROM players WHERE user_id = auth.uid() OR org_id IN (SELECT user_org_ids()))",
      // user_id = auth.uid() FUERA de players es el AUTOR, no el dueño del jugador
      "user_id = auth.uid()",
      "user_id = auth.uid() AND (org_id IS NULL OR user_in_org(org_id))",
      "EXISTS (SELECT 1 FROM development_plans p WHERE p.id = plan_id AND (p.coach_id = auth.uid() OR p.tenant_id = public.tenant_id()))",
      "player_id IS NULL OR org_id IN (SELECT user_org_ids())",
      "caller_manages_player(player_id::text) OR true",
      "auth.uid() IS NOT NULL",
    ]) {
      expect(requiresPlayerOwnership(bad), bad).toBe(false);
    }
    expect(requiresPlayerOwnership(null)).toBe(false);
    // Comentarios y mayúsculas no cambian nada
    expect(requiresPlayerOwnership(`-- dueño\n PLAYER_ID IN (SELECT id FROM public.players WHERE USER_ID = AUTH.UID()) /* o org */ OR ORG_ID IN (SELECT user_org_ids())`)).toBe(false);
  });

  it("marca la rama por organización en OR (039) y la cubre una RESTRICTIVE con el helper", () => {
    const tables = new Set(["public.t"]);
    const org = `${t} CREATE POLICY ins ON t FOR INSERT WITH CHECK (player_id IN (SELECT id FROM players WHERE user_id = auth.uid()) OR org_id IN (SELECT user_org_ids()));`;
    expect(unguardedPlayerWrites(one(org), tables).map((g) => `${g.cmd}:${g.policy}`)).toEqual(["INSERT:ins"]);
    const guarded = `${org} CREATE POLICY gi ON t AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (player_id IS NULL OR public.caller_manages_player(player_id::text));`;
    expect(unguardedPlayerWrites(one(guarded), tables)).toEqual([]);
    // Una RESTRICTIVE que menciona el helper pero no lo exige (OR true) no cubre nada
    const fake = `${org} CREATE POLICY gi ON t AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.caller_manages_player(player_id::text) OR true);`;
    expect(unguardedPlayerWrites(one(fake), tables).map((g) => g.policy)).toEqual(["ins"]);
  });
});

// ─── Migraciones reales ──────────────────────────────────────────────────────

describe("074 · lint del repositorio (control positivo y negativo)", () => {
  it("es la única 074", () => {
    expect(ALL.filter((f) => f.name.startsWith("074_")).map((f) => f.name)).toEqual([FILE]);
  });

  it("ROJO sin la 074: encuentra las 12 tablas del defecto (más las excluidas) — control positivo", () => {
    // Antes de la 076 también caen los planes IDP (047: coach_id = auth.uid() / tenant) y
    // las tablas cuya escritura iba por TENANT o por «cualquier usuario con sesión»
    // (003-005 / 048 / 049 / 055), que retira la 076 (otra clase, no de la 074).
    const TENANT_CLOSED_BY_076 = ["analyses", "parental_consents", "phase_heatmaps", "player_anthropometrics", "reports", "transfer_listings"];
    expect(gapTables(BEFORE_076)).toEqual(
      ["development_plans", "evaluation_history", "fatigue_sessions", "idp_checkins", "idp_goals", "idp_milestones",
       "live_events", "match_events", "player_analyses", "player_knowledge", "player_session_metrics", "scout_insights",
       "tracking_jobs", "tracking_sessions", "videos", ...TENANT_CLOSED_BY_076].sort(),
    );
    for (const g of unguardedPlayerWrites(BEFORE_076, playerTables(BEFORE_076))) {
      if (TENANT_CLOSED_BY_076.includes(g.table.replace(/^public\./, ""))) {
        expect(g.file, `${g.table}|${g.policy}`).toMatch(/^00[345]_|^048_|^049_|^055_/);
      }
    }
    // Con la 076 (solo dueño en el repositorio) siguen abiertas las demás.
    expect(gapTables(WITHOUT_074)).toEqual(
      ["evaluation_history", "fatigue_sessions", "live_events", "match_events", "player_analyses", "player_knowledge",
       "player_session_metrics", "scout_insights", "tracking_jobs", "tracking_sessions", "videos"].sort(),
    );
    // Las del audit, con su política y comando exactos.
    expect(gaps(BEFORE_076)).toEqual(expect.arrayContaining([
      "public.fatigue_sessions|INSERT|Users can insert own fatigue sessions",
      "public.fatigue_sessions|UPDATE|Users can update own fatigue sessions",
      "public.development_plans|INSERT|idp_plans_coach_write",
      "public.development_plans|UPDATE|idp_plans_coach_write",
      "public.idp_goals|INSERT|idp_goals_via_plan",
      "public.idp_milestones|UPDATE|idp_milestones_via_plan",
      "public.idp_checkins|INSERT|idp_checkins_via_plan",
      "public.scout_insights|UPDATE|Users update own insights",
    ]));
    // La rama por ORGANIZACIÓN del RAG (039): «jugador propio» OR org_id IN user_org_ids().
    expect(gaps(WITHOUT_074)).toEqual(expect.arrayContaining([
      "public.evaluation_history|INSERT|Users insert eval history",
      "public.player_knowledge|INSERT|Users insert knowledge",
    ]));
  });

  it("VERDE con la 074: solo quedan las EXCLUIDAS documentadas", () => {
    expect(gaps(ALL)).toEqual(EXCLUDED);
  });

  it("cada tabla de la 074 tiene sus 2 guardas: RESTRICTIVE, TO authenticated, solo WITH CHECK con el helper", () => {
    const state = buildPolicyState(ALL);
    const mine = [...state.values()].filter((p) => p.definedIn === FILE);
    expect(mine.map((p) => `${p.table}|${p.name}`).sort()).toEqual(
      TABLES.flatMap((t) => [`public.${t}|${t}_insert_requires_owner_074`, `public.${t}|${t}_update_requires_owner_074`]).sort(),
    );
    for (const p of mine) {
      expect(p.permissive, p.name).toBe(false);
      expect(p.roles, p.name).toEqual(["authenticated"]);
      expect(p.using, p.name).toBeNull();
      expect(p.cmd, p.name).toBe(/_insert_/.test(p.name) ? "INSERT" : "UPDATE");
      expect(p.check, p.name).toMatch(/public\.caller_manages_player\((d\.)?player_id::text\)/);
      if (/^idp_/.test(p.name)) {
        expect(p.check, p.name).toMatch(/EXISTS \(SELECT 1 FROM public\.development_plans d\s+WHERE d\.id = idp_\w+\.plan_id/);
      } else {
        expect(p.check, p.name).toMatch(/^player_id IS NULL OR public\.caller_manages_player\(player_id::text\)$/);
      }
    }
  });

  it("las listas de tablas coinciden en la migración, la previa y la posterior", () => {
    const pre = checks["/supabase/checks/074_previa.sql"] ?? "";
    const post = checks["/supabase/checks/074_posterior.sql"] ?? "";
    const arr = (s: string) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const guardList = code.slice(code.indexOf("unnest(ARRAY["), code.indexOf("]) t"));
    expect(arr(guardList)).toEqual(TABLES);
    const finalList = code.slice(code.lastIndexOf("unnest(ARRAY["), code.lastIndexOf("]) e(t)"));
    expect(arr(finalList)).toEqual(TABLES);
    const preList = pre.slice(pre.indexOf("tablas(n, tabla, autor, via) AS ("), pre.indexOf("necesarias(tabla, columna)"));
    expect([...preList.matchAll(/\(\d+, '(\w+)'/g)].map((m) => m[1])).toEqual(TABLES);
    const postList = post.slice(post.indexOf("tablas(tabla) AS ("), post.indexOf("cmds(cmd)"));
    expect(arr(postList)).toEqual(TABLES);
  });
});

describe("074 · contrato del SQL", () => {
  it("transaccional, con guardas que abortan (sin players, sin auth.uid, sin helper solo-dueño, sin RLS, sin columnas)", () => {
    const top = splitStatements(sql).map((s) => s.masked.trim());
    expect(top[0]).toMatch(/^BEGIN$/i);
    expect(top[top.length - 1]).toMatch(/^COMMIT$/i);
    for (const m of [
      /RAISE EXCEPTION '074: public\.players no existe/,
      /RAISE EXCEPTION '074: public\.players no tiene user_id/,
      /RAISE EXCEPTION '074: auth\.uid\(\) no existe/,
      /RAISE EXCEPTION '074: falta public\.caller_manages_player\(text\)/,
      /RAISE EXCEPTION '074: public\.caller_manages_player no es el helper SOLO DUEÑO/,
      /RAISE EXCEPTION '074: tablas SIN RLS activada/,
      /RAISE EXCEPTION '074: faltan columnas que usan las guardas/,
      /RAISE EXCEPTION '074: guardas que no quedaron como se espera/,
    ]) {
      expect(code).toMatch(m);
    }
    // El helper se comprueba (definer / tenant / org / team_member / user_id = auth.uid()).
    expect(code).toMatch(/v_def\s+OR v_src ~\* '\(tenant\|org\|team_member\)'/);
  });

  it("REUTILIZA el helper de la 073/076: no lo crea, no lo cambia, no toca sus permisos", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(code).not.toMatch(/(GRANT|REVOKE|COMMENT ON)\b[\s\S]{0,40}FUNCTION/i);
    const f = buildState(ALL).functions.get("public.caller_manages_player(text)");
    expect(f?.definer).toBe(false);
    expect(f?.definedIn).not.toBe(FILE);
    expect(f?.body ?? "").not.toMatch(/tenant|\borg|team_member/i);
  });

  it("solo crea/borra SUS políticas (*_074, precedidas de DROP IF EXISTS); no toca datos, PHV, RLS, permisos de tabla ni tracking_jobs", () => {
    const created = [...code.matchAll(/CREATE POLICY "(\w+)" ON public\.(\w+)/g)].map((m) => `${m[2]}.${m[1]}`);
    const dropped = [...code.matchAll(/DROP POLICY IF EXISTS "(\w+)" ON public\.(\w+)/g)].map((m) => `${m[2]}.${m[1]}`);
    expect(created).toHaveLength(24);
    expect(new Set(dropped)).toEqual(new Set(created));
    for (const c of created) expect(c).toMatch(/_074$/);
    expect(code.match(/AS RESTRICTIVE/g)?.length).toBe(24);
    expect(code).not.toMatch(/AS PERMISSIVE/i);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(code).not.toMatch(/ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/(GRANT|REVOKE)\s+[\w,\s]+\s+ON\s+(TABLE\s+)?public\.\w+\s+(TO|FROM)/i);
    expect(code).not.toMatch(/ALTER\s+VIEW|CREATE\s+(OR\s+REPLACE\s+)?VIEW|ALTER\s+TABLE/i);
    expect(code).not.toMatch(/mirwald|khamis|maturity_offset|phv_|bio_?band|pah/i);
    expect(code).not.toMatch(/tracking_jobs/);
    expect(code).not.toMatch(/user_org_ids|user_in_org|tenant_id/i);
    // Ninguna guarda menciona tenant ni organización (solo el helper solo-dueño).
    const state = buildPolicyState(ALL);
    for (const p of [...state.values()].filter((x) => x.definedIn === FILE)) {
      expect(`${p.using ?? ""} ${p.check ?? ""}`, p.name).not.toMatch(/tenant|org_id|team_member/i);
    }
  });

  it("documenta la decisión (quién, cuándo, por qué, cómo revisarla), la evidencia y lo NO incluido", () => {
    for (const s of ["30 sep 2026", "SOLO EL DUEÑO", "Por qué", "Cómo revisarla", "docs/pendientes-metricas.md",
      "VERIFICADO EN PRODUCCIÓN", "NO VERIFICADO", "SIMULACIÓN PGlite", "MISMA CLASE, NO INCLUIDAS",
      "tracking_jobs", "match_events", "player_session_metrics", "PR #308"]) {
      expect(sql, s).toContain(s);
    }
  });

  it("comprobaciones previa y posterior: una sola consulta de solo lectura, con columna «esperado»", () => {
    expect(Object.keys(checks).sort()).toEqual(["/supabase/checks/074_posterior.sql", "/supabase/checks/074_previa.sql"]);
    for (const [path, s] of Object.entries(checks)) {
      const sts = splitStatements(s).filter((x) => x.masked.trim());
      expect(sts.length, path).toBe(1);
      const m = sts[0].masked;
      expect(m.trim(), path).toMatch(/^WITH\b/i);
      expect(m, path).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|COPY|CALL|DO|SET|RESET|LOCK|VACUUM)\b/i);
      expect(s, path).toMatch(/SELECT n, comprobacion, resultado, esperado, ok/);
    }
    // La previa bloquea por las mismas causas por las que aborta la migración.
    const pre = checks["/supabase/checks/074_previa.sql"] ?? "";
    for (const r of ["BLOQUEA · players: columnas id / user_id", "BLOQUEA · auth.uid() existe",
      "BLOQUEA · public.caller_manages_player(text): existe · security invoker · solo dueño",
      "BLOQUEA · players: políticas SELECT/ALL de dueño", "BLOQUEA · tablas de la 074 que existen SIN RLS activada",
      "BLOQUEA · columnas que usan las guardas y que faltan"]) {
      expect(pre).toContain(r);
    }
  });
});
