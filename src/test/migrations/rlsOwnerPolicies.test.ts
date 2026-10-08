/**
 * Regresión: ninguna política RLS VIGENTE compara tenant_id con auth.uid()
 * (ver rlsPolicyLint.ts y la migración 073).
 *
 * No hay Postgres en CI: el lint es ESTÁTICO. El comportamiento real de las
 * políticas (quién lee y escribe qué) se comprobó aparte en una SIMULACIÓN PGlite
 * (ver el PR de 073); este test fija el contrato para que ninguna migración futura
 * vuelva a mezclar un id de tenant con un id de usuario, y para que la 073 conceda
 * exactamente lo que usa el navegador y nada más.
 */
import { describe, it, expect } from "vitest";
import { buildPolicyState, comparesTenantWithUid, policyStatements, tenantUidMixes, type PolicyState } from "./rlsPolicyLint";
import { buildState, executableStatements, splitStatements, type MigrationFile } from "./securityDefinerLint";

const raw = import.meta.glob("/supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALL: MigrationFile[] = Object.entries(raw)
  .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const FILE_073 = "073_rls_owner_policies.sql";
const WITHOUT_073 = ALL.filter((f) => f.name !== FILE_073);
const sql073 = raw[`/supabase/migrations/${FILE_073}`] ?? "";

const checks = import.meta.glob("/supabase/checks/073_*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const one = (sql: string, name = "900_x.sql"): MigrationFile[] => [{ name, sql }];
const keys = (files: MigrationFile[]) => tenantUidMixes(files).map((v) => `${v.key} · ${v.clause}`);

// ─── Motor: casos sintéticos ──────────────────────────────────────────────────

describe("rlsPolicyLint · detector tenant_id vs auth.uid()", () => {
  it("marca las formas que mezclan un id de tenant con un id de usuario", () => {
    for (const e of [
      "player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid())", // 044/050
      "tenant_id = auth.uid()",
      "auth.uid() = tenant_id",
      "p.tenant_id::text = (auth.uid())::text",
      "players.tenant_id = (SELECT auth.uid())",
      "players.tenant_id = ( SELECT auth.uid() AS uid)", // forma de pg_policies con initPlan
      '"players"."tenant_id" = auth.uid()',
      "created_by = auth.uid() OR player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid())",
      "tenant_id IS NOT DISTINCT FROM auth.uid()",
      "tenant_id = (auth.jwt() ->> 'sub')::uuid",
      "tenant_id IN (SELECT auth.uid())",
    ]) {
      expect(comparesTenantWithUid(e), e).toBe(true);
    }
  });

  it("NO marca tenant contra tenant, usuario contra usuario, comentarios ni literales", () => {
    for (const e of [
      "tenant_id = public.tenant_id()",
      "user_id = auth.uid()",
      "auth.uid() = user_id OR tenant_id = public.tenant_id()",
      "auth.uid() = user_id OR tenant_id = (auth.jwt() ->> 'tenant_id')::uuid",
      "p.tenant_id::text = coalesce(nullif(auth.jwt() ->> 'tenant_id', ''), '')",
      "public.caller_manages_player(player_id::text)",
      "user_id = auth.uid() -- antes: tenant_id = auth.uid()",
      "note = 'tenant_id = auth.uid()'",
      "subtenant_ids = auth.uid()",
    ]) {
      expect(comparesTenantWithUid(e), e).toBe(false);
    }
  });
});

describe("rlsPolicyLint · estado de políticas", () => {
  const bad = `CREATE POLICY "p" ON t FOR ALL USING (player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid()))
               WITH CHECK (player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid()));`;

  it("CREATE marca USING y WITH CHECK; DROP la quita; una definición posterior la sustituye", () => {
    expect(keys(one(bad))).toEqual(["public.t|p · USING", "public.t|p · WITH CHECK"]);
    expect(keys([...one(bad, "001.sql"), ...one('DROP POLICY IF EXISTS "p" ON public.t;', "002.sql")])).toEqual([]);
    expect(
      keys([...one(bad, "001.sql"), ...one('DROP POLICY "p" ON t; CREATE POLICY "p" ON t FOR SELECT USING (user_id = auth.uid());', "002.sql")]),
    ).toEqual([]);
    // El orden es el de NOMBRE de fichero, no el de la lista.
    expect(keys([...one('DROP POLICY "p" ON t;', "002.sql"), ...one(bad, "001.sql")])).toEqual([]);
  });

  it("lee sentencias estáticas dentro de DO (también bajo IF) y NO el SQL dinámico", () => {
    const inDo = `DO $$ BEGIN
      IF to_regclass('public.t') IS NOT NULL THEN
        CREATE POLICY p2 ON public.t FOR SELECT TO authenticated USING (tenant_id = auth.uid());
      END IF;
      EXECUTE format('CREATE POLICY p3 ON %I USING (tenant_id = auth.uid())', 't');
    END $$;`;
    expect(keys(one(inDo))).toEqual(["public.t|p2 · USING"]);
    expect(policyStatements(inDo).map((s) => s.masked.trim().slice(0, 18))).toEqual(["CREATE POLICY p2 O"]);
  });

  it("ALTER POLICY cambia la expresión o renombra; DROP TABLE quita sus políticas", () => {
    expect(keys([...one(bad, "001.sql"), ...one('ALTER POLICY "p" ON t USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());', "002.sql")])).toEqual([]);
    expect(keys([...one(bad, "001.sql"), ...one('ALTER POLICY "p" ON t RENAME TO q;', "002.sql")])).toEqual([
      "public.t|q · USING",
      "public.t|q · WITH CHECK",
    ]);
    expect(keys([...one(bad, "001.sql"), ...one("DROP TABLE IF EXISTS public.t CASCADE;", "002.sql")])).toEqual([]);
  });

  it("interpreta FOR / TO / AS y los valores por defecto (ALL, public, permissive)", () => {
    const s = buildPolicyState(
      one(`CREATE POLICY a ON t USING (true);
           CREATE POLICY "B b" ON public.t AS RESTRICTIVE FOR UPDATE TO authenticated, service_role USING (x) WITH CHECK (y);`),
    );
    expect(s.get("public.t|a")).toMatchObject({ cmd: "ALL", roles: ["public"], permissive: true, using: "true", check: null });
    expect(s.get("public.t|B b")).toMatchObject({ cmd: "UPDATE", roles: ["authenticated", "service_role"], permissive: false, using: "x", check: "y" });
  });
});

// ─── Migraciones reales ──────────────────────────────────────────────────────

const HELPER = /^\s*public\.caller_manages_player\s*\(\s*player_id(\s*::\s*text)?\s*\)\s*$/i;

/** Las 5 tablas de bienestar / perfil conductual que usa el navegador. */
const FIVE = ["behavioral_profiles", "attendance_records", "engagement_snapshots", "wellbeing_questionnaires", "dropout_risk_assessments"];
/** Las 15 políticas que crea la 073 (solo dueño): SELECT/INSERT/UPDATE × 5 tablas. */
const CREATED_073 = FIVE.flatMap((t) => ["insert", "select", "update"].map((c) => `${t}_${c}_owner`)).sort();

/** Resumen «nombre:cmd:roles» de las políticas vigentes de una tabla. */
function tablePolicies(state: Map<string, PolicyState>, table: string): PolicyState[] {
  return [...state.values()].filter((p) => p.table === `public.${table}`).sort((a, b) => (a.name < b.name ? -1 : 1));
}

describe("rlsPolicyLint · supabase/migrations", () => {
  it("existe la migración 073 y es la única 073", () => {
    expect(ALL.filter((f) => f.name.startsWith("073_")).map((f) => f.name)).toEqual([FILE_073]);
    expect(sql073.length).toBeGreaterThan(0);
  });

  it("ROJO sin 073: detecta EXACTAMENTE las 10 políticas rotas de 044/050 (las del audit)", () => {
    const tables = [...new Set(tenantUidMixes(WITHOUT_073).map((v) => v.key))].sort();
    expect(tables).toEqual(
      [
        "public.attendance_records|attendance_owner_all",
        "public.behavioral_profiles|behavioral_owner_all",
        "public.dropout_risk_assessments|dropout_owner_all",
        "public.engagement_snapshots|engagement_owner_all",
        "public.player_injuries|org_members_insert_injuries",
        "public.player_injuries|org_members_read_injuries",
        "public.player_injuries|org_members_update_injuries",
        "public.player_metric_snapshots|snapshots_read_own",
        "public.player_valuations|valuations_read_own",
        "public.wellbeing_questionnaires|questionnaires_owner_all",
      ].sort(),
    );
  });

  it("VERDE con 073: ninguna política vigente compara tenant_id con auth.uid()", () => {
    const vs = tenantUidMixes(ALL);
    expect(vs, vs.map((v) => `${v.key} · ${v.clause} (${v.file}): ${v.expr}`).join("\n")).toEqual([]);
  });

  it("073 deja en las 5 tablas del navegador SELECT + INSERT + UPDATE, TO authenticated, con el helper y WITH CHECK en escrituras", () => {
    const state = buildPolicyState(ALL);
    for (const t of FIVE) {
      const ps = tablePolicies(state, t);
      expect(ps.map((p) => `${p.name}:${p.cmd}:${p.roles.join(",")}`), t).toEqual([
        `${t}_insert_owner:INSERT:authenticated`,
        `${t}_select_owner:SELECT:authenticated`,
        `${t}_update_owner:UPDATE:authenticated`,
      ]);
      for (const p of ps) {
        expect(p.permissive, p.name).toBe(true);
        expect(p.definedIn, p.name).toBe(FILE_073);
        if (p.cmd === "SELECT") {
          expect(p.using, p.name).toMatch(HELPER);
          expect(p.check, p.name).toBeNull();
        }
        if (p.cmd === "INSERT") {
          expect(p.using, p.name).toBeNull();
          expect(p.check, p.name).toMatch(HELPER);
        }
        if (p.cmd === "UPDATE") {
          expect(p.using, p.name).toMatch(HELPER);
          expect(p.check, p.name).toMatch(HELPER);
        }
      }
    }
  });

  it("073: snapshots SIN lectura de cliente (retenida: PHV sin gate en el gráfico); lesiones y valoraciones sin políticas de cliente", () => {
    const state = buildPolicyState(ALL);
    // La lectura del navegador de player_metric_snapshots queda RETENIDA: solo la escritura
    // de service_role de la 072 (SnapshotHistoryChart dibuja phv_offset sin gate PHV y
    // progression-tracker no comprueba propiedad; ver cabecera de la 073).
    expect(tablePolicies(state, "player_metric_snapshots").map((p) => `${p.name}:${p.cmd}:${p.roles.join(",")}`)).toEqual([
      "snapshots_insert_service_role:INSERT:service_role", // 072, intacta
    ]);
    expect(tablePolicies(state, "player_injuries")).toEqual([]);
    expect(tablePolicies(state, "player_valuations").map((p) => `${p.name}:${p.cmd}:${p.roles.join(",")}`)).toEqual([
      "valuations_insert_service_role:INSERT:service_role", // 072, intacta
    ]);
    // Nunca anon ni public en las políticas que crea 073, y nunca FOR ALL / DELETE.
    const created073 = [...state.values()].filter((p) => p.definedIn === FILE_073);
    expect(created073.map((p) => p.name).sort()).toEqual(CREATED_073);
    for (const p of created073) {
      expect(p.roles, p.name).toEqual(["authenticated"]);
      expect(["SELECT", "INSERT", "UPDATE"], p.name).toContain(p.cmd);
    }
    // Ningún nombre vigente dice «or_tenant» (sería falso con la regla solo dueño).
    expect([...state.values()].filter((p) => /or_tenant/.test(p.name)).map((p) => `${p.table}|${p.name}`)).toEqual([]);
  });

  it("el helper es SECURITY INVOKER, fija search_path y queda revocado a anon/PUBLIC (ejecutable por authenticated)", () => {
    const f = buildState(ALL).functions.get("public.caller_manages_player(text)");
    expect(f, "public.caller_manages_player(text)").toBeDefined();
    expect(f?.definer).toBe(false);
    expect(f?.searchPathSet).toBe(true);
    expect(f?.acl.anon).toBe(false);
    expect(f?.acl.PUBLIC).toBe(false);
    expect(f?.acl.authenticated).toBe(true);
    // La última definición es la 073 o una posterior (la 076, PR #307, deja el mismo cuerpo solo dueño).
    expect((f?.definedIn ?? "") >= FILE_073, f?.definedIn).toBe(true);
    // COMMENT con el prefijo «073 ·»: la fila 3 de la comprobación previa depende de él.
    expect(sql073).toMatch(/COMMENT ON FUNCTION public\.caller_manages_player\(text\) IS\s*'073 ·/);
  });

  it("073 y 076 en cualquier orden: la 073 conserva el helper de la 076 y la previa no la cuenta como ajena", () => {
    const code = sql073.replace(/--.*$/gm, "");
    // Sección 1: si el helper ya lleva COMMENT «076 ·», no se recrea ni se le cambia el comentario.
    expect(code).toMatch(/obj_description\(to_regprocedure\('public\.caller_manages_player\(text\)'\), 'pg_proc'\), ''\) LIKE '076 ·%' THEN\s*RAISE NOTICE/);
    // Fila 3 de la previa: ni la 073 ni la 076 cuentan como «otra» función con ese nombre.
    const pre = checks["/supabase/checks/073_previa.sql"] ?? "";
    const row3 = pre.slice(pre.indexOf("SELECT 3,"), pre.indexOf("SELECT 4,"));
    expect(row3).toContain("NOT LIKE '073 ·%'");
    expect(row3).toContain("NOT LIKE '076 ·%'");
  });

  it("el helper es SOLO DUEÑO (decisión del 30 sep 2026): ninguna referencia a tenant ni a organización", () => {
    const body = buildState(ALL).functions.get("public.caller_manages_player(text)")?.body ?? "";
    expect(body).toMatch(/p\.user_id\s*=\s*\(SELECT auth\.uid\(\)\)/);
    // Negativo: sin tenant_id, sin public.tenant_id(), sin org / team_members.
    expect(body).not.toMatch(/tenant/i);
    expect(body).not.toMatch(/\borg|team_member/i);
    // Un solo cuerpo: la 073 crea el helper UNA vez (sin variante por entorno).
    expect(sql073.match(/CREATE OR REPLACE FUNCTION public\.caller_manages_player\(/g)?.length).toBe(1);
    // El código ejecutable (sin comentarios) no llama a public.tenant_id() ni lee players.tenant_id.
    const code = sql073.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/public\.tenant_id\(\)/i);
    expect(code).not.toMatch(/\bp\.tenant_id\b/i);
    expect(comparesTenantWithUid(code)).toBe(false);
    // La decisión queda registrada en la cabecera (quién, cuándo, por qué, cómo se revisa).
    expect(sql073).toMatch(/DECISIÓN DE ALCANCE \(registrada el 30 sep 2026\)/);
    for (const k of ["QUIÉN:", "POR QUÉ:", "CÓMO SE REVISA:", "LO QUE LA 073 NO CUBRE"]) expect(sql073).toContain(k);
  });

  it("la GUARDA de la 073 aborta (RAISE EXCEPTION) y su lista de políticas propias = las que crea", () => {
    const guard = sql073.slice(sql073.indexOf("-- 3) GUARDA"), sql073.indexOf("-- 4) Comprobación final"));
    expect(guard.length).toBeGreaterThan(0);
    expect(guard.replace(/--.*$/gm, "").match(/RAISE EXCEPTION/g)?.length).toBe(2); // (a) helper · (b) políticas ajenas
    const allow = [...guard.matchAll(/\('(\w+)'(?:::name)?,\s*'(\w+)'(?:::name)?\)/g)].map((m) => m[2]).sort();
    expect(allow).toEqual(CREATED_073);
  });

  it("073 es transaccional y no toca datos, permisos de tablas, PHV, DSAR ni user_org_ids/user_in_org", () => {
    const top = splitStatements(sql073).map((s) => s.masked.trim());
    expect(top[0]).toMatch(/^BEGIN$/i);
    expect(top[top.length - 1]).toMatch(/^COMMIT$/i);
    const executed = [...executableStatements(sql073), ...policyStatements(sql073), ...splitStatements(sql073)].map((s) => s.masked);
    for (const st of executed) {
      expect(st).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
      expect(st).not.toMatch(/^\s*(GRANT|REVOKE)\b(?![\s\S]*\bON\s+FUNCTION\s+public\.caller_manages_player\(text\))/i);
      expect(st).not.toMatch(/^\s*(CREATE|DROP)\s+(OR\s+REPLACE\s+)?(TABLE|VIEW)\b/i);
    }
    const code = sql073
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/mirwald|khamis|maturity_offset|phv_offset|phv_category|bio_?band/i);
    expect(code).not.toMatch(/\bdsar_|\buser_org_ids\b|\buser_in_org\b/i);
  });

  it("las comprobaciones de operador (073_previa / 073_comprobacion) son UNA consulta de solo lectura", () => {
    expect(Object.keys(checks).sort()).toEqual(["/supabase/checks/073_comprobacion.sql", "/supabase/checks/073_previa.sql"]);
    for (const [path, sql] of Object.entries(checks)) {
      const sts = splitStatements(sql).filter((s) => s.masked.trim());
      expect(sts.length, path).toBe(1);
      const m = sts[0].masked;
      expect(m.trim(), path).toMatch(/^WITH\b/i);
      expect(m, path).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|COPY|CALL|DO|SET|RESET|LOCK|VACUUM)\b/i);
    }
  });

  it("comprobaciones al día con la regla solo dueño: nombres nuevos, fila 13 informativa con cast uuid seguro, sin políticas abiertas de la 044 en «conocidas»", () => {
    const pre = checks["/supabase/checks/073_previa.sql"] ?? "";
    const post = checks["/supabase/checks/073_comprobacion.sql"] ?? "";
    const conocidas = pre.slice(pre.indexOf("conocidas(tabla, politica) AS ("), pre.indexOf("\npol AS ("));
    const names = [...conocidas.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => m[2]);
    for (const n of CREATED_073) expect(names, n).toContain(n);
    for (const t of FIVE) for (const c of ["select", "insert", "update"]) expect(names).toContain(`${t}_${c}_owner_or_tenant`); // versión anterior: la 073 las retira
    // snapshots_insert_own / valuations_insert_own (044, WITH CHECK (true) para todos) NO son «conocidas»: bloquean (fila 10).
    expect(names).not.toContain("snapshots_insert_own");
    expect(names).not.toContain("valuations_insert_own");
    // Fila 13: informativa (ok NULL), resuelve el tenant como public.tenant_id() (cast uuid tras regex, sin pg_input_is_valid).
    const row13 = pre.slice(pre.indexOf("SELECT 13,"), pre.indexOf("SELECT 14,"));
    expect(row13).toMatch(/'informativo', NULL::boolean/);
    expect(pre).toContain("'^([{][0-9a-f]{4}(-?[0-9a-f]{4}){7}[}]|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'");
    expect(pre).toMatch(/p\.tenant_id = \(case when m\.t ~\* %L then m\.t::uuid end\)/);
    expect(pre.replace(/--.*$/gm, "")).not.toMatch(/pg_input_is_valid/); // solo existe desde PostgreSQL 16
    // Fila 19: la comparación de TEXTO (la que usa hoy la DSAR de la 072) sigue, aparte e informativa.
    const row19 = pre.slice(pre.indexOf("SELECT 19,"), pre.indexOf("SELECT 20,"));
    expect(row19).toMatch(/p\.tenant_id::text = nullif\(u\.raw_app_meta_data ->> ''tenant_id'', ''''\)/);
    expect(row19).toMatch(/'informativo', NULL::boolean/);
    // Fila 2 (public.tenant_id()) ya no bloquea.
    expect(pre.slice(pre.indexOf("SELECT 2,"), pre.indexOf("SELECT 3,"))).toMatch(/'informativo', NULL::boolean/);
    // Posterior: nombres nuevos, ninguna lectura de cliente en snapshots y la fila que prueba «solo dueño».
    expect(post).not.toMatch(/owner_or_tenant/);
    expect(post).toContain("'snapshots_insert_service_role:INSERT:service_role'");
    expect(post).toMatch(/pg_get_functiondef\(h\.oid\) !~\* '\(tenant\|org\|team_member\)'/);
  });
});
