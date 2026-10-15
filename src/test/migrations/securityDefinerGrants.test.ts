/**
 * Regresión: funciones SECURITY DEFINER y vistas con permisos del dueño en
 * supabase/migrations/*.sql (ver securityDefinerLint.ts y la migración 072).
 *
 * No hay Postgres en CI: el lint es ESTÁTICO y simula los default privileges de
 * Supabase (deducidos, no comprobados contra producción). La validez del SQL y el
 * comportamiento real de los permisos se comprobaron aparte en una simulación
 * PGlite (ver el PR de 072); este test solo fija el contrato para que ninguna
 * migración futura vuelva a abrir la clase de exposición.
 */
import { describe, it, expect } from "vitest";
import {
  argTypes,
  buildState,
  executableStatements,
  lintMigrations,
  splitStatements,
  type MigrationFile,
  type Violation,
} from "./securityDefinerLint";
import { SECURITY_DEFINER_ALLOWLIST } from "./securityDefinerAllowlist";

const raw = import.meta.glob("/supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALL: MigrationFile[] = Object.entries(raw)
  .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const FILE_072 = "072_revoke_definer_rpc_execute.sql";
const WITHOUT_072 = ALL.filter((f) => f.name !== FILE_072);
const sql072 = raw[`/supabase/migrations/${FILE_072}`] ?? "";

const fmt = (vs: Violation[]) => vs.map((v) => `${v.rule} · ${v.object} · ${v.detail} (${v.file})`).join("\n");
const lint = (files: MigrationFile[], allow = {}) => lintMigrations(files, allow);
const one = (sql: string, name = "900_x.sql"): MigrationFile[] => [{ name, sql }];

// ─── Motor: casos sintéticos ──────────────────────────────────────────────────

describe("securityDefinerLint · motor", () => {
  it("normaliza firmas (nombres de parámetro, DEFAULT, alias, typmods, OUT)", () => {
    expect(argTypes("p_user_id uuid, p_limit int default 50, p_q text DEFAULT null")).toEqual(["uuid", "integer", "text"]);
    expect(argTypes("query_embedding vector(1024), match_threshold float default 0.6")).toEqual(["vector", "double precision"]);
    expect(argTypes("double precision, character varying(20), OUT x int, timestamptz")).toEqual([
      "double precision",
      "character varying",
      "timestamp with time zone",
    ]);
  });

  it("separa sentencias respetando comentarios, literales y cuerpos $tag$", () => {
    const sts = splitStatements("-- a; b\nSELECT 'x;y'; CREATE FUNCTION f() RETURNS int AS $f$ SELECT 1; $f$ LANGUAGE sql; /* ; */");
    expect(sts.map((s) => s.text.trim().split(/\s+/)[0])).toEqual(["--", "CREATE", "/*"]);
  });

  it("recorre sentencias estáticas dentro de DO y NO el SQL dinámico", () => {
    const sts = executableStatements(`
      DO $$ BEGIN
        IF to_regprocedure('public.f(uuid)') IS NOT NULL THEN
          REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC, anon, authenticated;
        END IF;
        EXECUTE format('REVOKE ALL ON %s FROM anon', 'x');
      END $$;`);
    expect(sts.map((s) => s.text.trim().slice(0, 30))).toEqual(["REVOKE EXECUTE ON FUNCTION pub"]);
  });

  it("DEFINER nueva sin REVOKE ⇒ falla; REVOKE solo FROM PUBLIC (patrón 054) ⇒ sigue fallando", () => {
    const base = "CREATE FUNCTION f(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;";
    expect(lint(one(base)).map((v) => v.rule)).toEqual(["definer-revoke"]);
    expect(lint(one(base + "REVOKE ALL ON FUNCTION f(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION f(uuid) TO service_role;")).map((v) => v.rule)).toEqual([
      "definer-revoke",
    ]);
    expect(lint(one(base + "REVOKE EXECUTE ON FUNCTION f(uuid) FROM anon, authenticated;")).map((v) => v.rule)).toEqual(["definer-revoke"]);
    expect(lint(one(base + "REVOKE EXECUTE ON FUNCTION public.f(p uuid) FROM PUBLIC, anon, authenticated;"))).toEqual([]);
  });

  it("DEFINER sin search_path ⇒ falla; ALTER FUNCTION ... SET search_path lo arregla", () => {
    const base = "CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$; REVOKE ALL ON FUNCTION f() FROM PUBLIC, anon, authenticated;";
    expect(lint(one(base)).map((v) => v.rule)).toEqual(["definer-search-path"]);
    expect(lint(one(base + "ALTER FUNCTION public.f() SET search_path = public, pg_temp;"))).toEqual([]);
  });

  it("CREATE OR REPLACE conserva el ACL; DROP + CREATE vuelve a los default privileges", () => {
    const f = "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;";
    const revoked = f + "REVOKE ALL ON FUNCTION f() FROM PUBLIC, anon, authenticated;";
    expect(lint([...one(revoked, "001.sql"), ...one(f, "002.sql")])).toEqual([]);
    expect(lint([...one(revoked, "001.sql"), ...one("DROP FUNCTION IF EXISTS f();" + f, "002.sql")]).map((v) => v.rule)).toEqual(["definer-revoke"]);
  });

  it("vistas: nueva ⇒ falla; security_invoker o REVOKE a anon+PUBLIC ⇒ pasa; CREATE OR REPLACE sin WITH pierde invoker", () => {
    const v = "CREATE OR REPLACE VIEW v AS SELECT 1;";
    expect(lint(one(v)).map((x) => x.rule)).toEqual(["view-owner-rights-anon"]);
    expect(lint(one("CREATE VIEW v WITH (security_invoker = true) AS SELECT 1;"))).toEqual([]);
    expect(lint(one(v + "ALTER VIEW public.v SET (security_invoker = true);"))).toEqual([]);
    expect(lint(one(v + "REVOKE ALL ON public.v FROM PUBLIC, anon;"))).toEqual([]);
    // 069-style re-create after hardening: invoker is lost, the ACL survives.
    expect(lint([...one(v + "ALTER VIEW v SET (security_invoker = true);", "001.sql"), ...one(v, "002.sql")]).map((x) => x.rule)).toEqual([
      "view-owner-rights-anon",
    ]);
    expect(lint([...one(v + "ALTER VIEW v SET (security_invoker = true); REVOKE ALL ON v FROM anon;", "001.sql"), ...one(v, "002.sql")])).toEqual([]);
  });

  it("ALLOWLIST: client-callable exige revocar anon y usar auth.uid(); entradas obsoletas fallan", () => {
    const f = (body: string) =>
      `CREATE FUNCTION public.c(p text) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN ${body} RETURN 1; END $$;`;
    const allow = { "public.c(text)": { category: "client-callable" as const, justification: "llamada desde el navegador con sesion" } };
    expect(lint(one(f("PERFORM auth.uid();")), allow).map((v) => v.rule)).toEqual(["client-callable-anon"]);
    expect(lint(one(f("PERFORM 1;") + "REVOKE ALL ON FUNCTION c(text) FROM PUBLIC, anon;"), allow).map((v) => v.rule)).toEqual([
      "client-callable-auth-uid",
    ]);
    expect(lint(one(f("PERFORM auth.uid();") + "REVOKE ALL ON FUNCTION c(text) FROM PUBLIC, anon;"), allow)).toEqual([]);
    expect(lint(one("SELECT 1;"), allow).map((v) => v.rule)).toEqual(["allowlist-stale"]);
  });
});

// ─── Migraciones reales ──────────────────────────────────────────────────────

describe("securityDefinerLint · supabase/migrations", () => {
  it("existe la migración 072 y es la única 072", () => {
    expect(ALL.filter((f) => f.name.startsWith("072_")).map((f) => f.name)).toEqual([FILE_072]);
    expect(sql072.length).toBeGreaterThan(0);
  });

  it("ROJO sin 072: el lint detecta la exposición en las migraciones de origin/main", () => {
    const vs = lint(WITHOUT_072, SECURITY_DEFINER_ALLOWLIST);
    const revoke = new Set(vs.filter((v) => v.rule === "definer-revoke").map((v) => v.object));
    for (const k of [
      "public.get_ranked_players(uuid,text,text,integer,integer,text,text,text,text,text)",
      "public.record_ai_spend(text,numeric)",
      "public.get_ai_spend_month()",
      "public.increment_analyses_used(uuid,text)",
      "public.match_knowledge(vector,double precision,integer,text,text)",
      "public.search_knowledge_text(text,integer,text,text)",
      "public.dsar_export_player_data(uuid)",
      "public.dsar_request_deletion(uuid,text)",
    ]) {
      expect(revoke, k).toContain(k);
    }
    const views = new Set(vs.filter((v) => v.rule === "view-owner-rights-anon").map((v) => v.object));
    for (const v of [
      "player_latest_analysis",
      "player_latest_anthropometrics",
      "user_active_subscription",
      "v_players_ai_blocked",
      "v_bias_by_position",
      "v_bias_by_age",
      "v_bias_by_visibility",
      "v_bias_by_recency",
      "v_bias_dashboard",
      "v_org_dashboard",
      "v_player_evolution",
      "v_rag_stats",
      "v_active_idp_summary",
      "v_active_listings_summary",
    ]) {
      expect(views, v).toContain(`public.${v}`);
    }
    const noPath = new Set(vs.filter((v) => v.rule === "definer-search-path").map((v) => v.object));
    for (const k of ["public.user_org_ids()", "public.user_in_org(uuid)", "public.handle_new_user()", "public.get_ranked_players(uuid,text,text,integer,integer,text,text,text,text,text)"]) {
      expect(noPath, k).toContain(k);
    }
  });

  it("VERDE con 072: ninguna función DEFINER ni vista queda expuesta", () => {
    const vs = lint(ALL, SECURITY_DEFINER_ALLOWLIST);
    expect(vs, fmt(vs)).toEqual([]);
  });

  it("072 mantiene las vistas de /admin/bias legibles para authenticated (con security_invoker) y el resto solo service_role", () => {
    const { views, functions } = buildState(ALL);
    for (const v of ["v_bias_by_position", "v_bias_by_age", "v_bias_by_visibility", "v_bias_by_recency", "v_bias_dashboard"]) {
      const s = views.get(`public.${v}`);
      expect(s?.invoker, v).toBe(true);
      expect(s?.acl.authenticated, v).toBe(true);
      expect(s?.acl.anon, v).toBe(false);
    }
    for (const v of ["player_latest_anthropometrics", "user_active_subscription", "v_players_ai_blocked", "player_latest_analysis"]) {
      const s = views.get(`public.${v}`);
      expect(s?.acl.anon || s?.acl.authenticated || s?.acl.PUBLIC, v).toBe(false);
      expect(s?.acl.service_role, v).toBe(true);
    }
    // DSAR: firma TEXT (players.id es text), ejecutable con sesión, nunca anon.
    expect(functions.has("public.dsar_export_player_data(uuid)")).toBe(false);
    expect(functions.has("public.dsar_request_deletion(uuid,text)")).toBe(false);
    for (const k of ["public.dsar_export_player_data(text)", "public.dsar_request_deletion(text,text)"]) {
      const f = functions.get(k);
      expect(f?.definer, k).toBe(true);
      expect(f?.acl.authenticated, k).toBe(true);
      expect(f?.acl.anon || f?.acl.PUBLIC, k).toBe(false);
    }
    // get_ranked_players sigue sin tope de p_limit (desde el P1 bloque 5a la app ya no la llama).
    const ranked = functions.get("public.get_ranked_players(uuid,text,text,integer,integer,text,text,text,text,text)");
    expect(ranked?.acl.service_role).toBe(true);
  });

  it("072 no cambia datos ni redefine vistas/fórmulas (invariante #4)", () => {
    const top = splitStatements(sql072).map((s) => s.masked.trim());
    expect(top[0]).toMatch(/^BEGIN$/i);
    expect(top[top.length - 1]).toMatch(/^COMMIT$/i);
    const executed = executableStatements(sql072).map((s) => s.masked);
    const topLevel = splitStatements(sql072).map((s) => s.masked);
    for (const st of [...executed, ...topLevel]) {
      expect(st).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
      expect(st).not.toMatch(/^\s*CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i);
      expect(st).not.toMatch(/^\s*DROP\s+(TABLE|VIEW)\b/i);
    }
    const code = sql072
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/mirwald|khamis|maturity_offset\s*=|phv_offset\s*=|phv_category\s*=/i);
    // p_limit de get_ranked_players NO se recorta (la función queda sin uso desde el P1 bloque 5a).
    expect(code).not.toMatch(/least\s*\(\s*p_limit/i);
  });
});
