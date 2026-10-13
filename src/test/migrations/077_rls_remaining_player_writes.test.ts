/**
 * Migración 077 — las escrituras de cliente que quedaban sin mirar al DUEÑO del jugador
 * (P1 bloque 1): match_events y player_session_metrics con guardas RESTRICTIVE (mismo patrón
 * y mismo helper que la 074), tracking_jobs solo del servidor (como la 075) y anon sin
 * escritura en las tablas de datos de jugador.
 *
 * No hay Postgres en CI: se fija el CONTRATO de forma estática. El comportamiento (antes: otra
 * cuenta escribe eventos y métricas de un jugador ajeno e inserta tracking_jobs; después:
 * 42501; el dueño igual; service_role igual) se comprobó en una SIMULACIÓN PGlite fuera del
 * repo (PostgreSQL 18.3 y 16.4), descrita en el PR.
 */
import { describe, it, expect } from "vitest";
import { buildPolicyState, tablesWithColumn, unguardedPlayerWrites } from "./rlsPolicyLint";
import type { MigrationFile } from "./securityDefinerLint";

const FILE = "077_rls_remaining_player_writes.sql";
const raw = import.meta.glob("/supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const checks = import.meta.glob("/supabase/checks/077_*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sql = raw[`/supabase/migrations/${FILE}`] ?? "";
const strip = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const code = strip(sql);

const ALL: MigrationFile[] = Object.entries(raw)
  .map(([path, s]) => ({ name: path.split("/").pop() ?? path, sql: s }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
const WITHOUT_077 = ALL.filter((f) => f.name !== FILE);
const playerTables = (files: MigrationFile[]) => new Set([...tablesWithColumn(files, "player_id"), ...tablesWithColumn(files, "plan_id")]);
const gaps = (files: MigrationFile[]) => unguardedPlayerWrites(files, playerTables(files)).map((g) => `${g.table}|${g.cmd}|${g.policy}`);

/** Las 15 tablas de datos de jugador sin escritura de anon (12 de la 074 + 3). */
const ANON_TABLES = [
  "fatigue_sessions", "development_plans", "idp_goals", "idp_milestones", "idp_checkins",
  "tracking_sessions", "player_analyses", "videos", "live_events", "scout_insights",
  "evaluation_history", "player_knowledge",
  "match_events", "player_session_metrics", "training_sessions",
];

describe("077 · lint del repositorio (control positivo y negativo)", () => {
  it("es la única 077 y es transaccional", () => {
    expect(ALL.filter((f) => f.name.startsWith("077_")).map((f) => f.name)).toEqual([FILE]);
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("ROJO sin la 077: quedan justo las 5 escrituras que la 074 dejó fuera — control positivo", () => {
    expect(gaps(WITHOUT_077)).toEqual([
      "public.match_events|INSERT|Users manage their own events",
      "public.match_events|UPDATE|Users manage their own events",
      "public.player_session_metrics|INSERT|Access via session ownership",
      "public.player_session_metrics|UPDATE|Access via session ownership",
      "public.tracking_jobs|INSERT|tracking_jobs_insert",
    ]);
  });

  it("VERDE con la 077: ninguna escritura de cliente sobre datos de un jugador sin exigir ser su dueño", () => {
    expect(gaps(ALL)).toEqual([]);
  });

  it("las 4 guardas: RESTRICTIVE, TO authenticated, solo WITH CHECK con el helper solo-dueño", () => {
    const mine = [...buildPolicyState(ALL).values()].filter((p) => p.definedIn === FILE);
    expect(mine.map((p) => `${p.table}|${p.name}`).sort()).toEqual([
      "public.match_events|match_events_insert_requires_owner_077",
      "public.match_events|match_events_update_requires_owner_077",
      "public.player_session_metrics|player_session_metrics_insert_requires_owner_077",
      "public.player_session_metrics|player_session_metrics_update_requires_owner_077",
    ]);
    for (const p of mine) {
      expect(p.permissive, p.name).toBe(false);
      expect(p.roles, p.name).toEqual(["authenticated"]);
      expect(p.using, p.name).toBeNull();
      expect(p.cmd, p.name).toBe(/_insert_/.test(p.name) ? "INSERT" : "UPDATE");
      expect(p.check, p.name).toMatch(/^player_id IS NULL OR public\.caller_manages_player\(player_id::text\)$/);
    }
  });

  it("tracking_jobs: sin políticas de cliente tras la 077", () => {
    const state = buildPolicyState(ALL);
    expect([...state.values()].filter((p) => p.table === "public.tracking_jobs").map((p) => p.name)).toEqual([]);
  });
});

describe("077 · contrato del SQL", () => {
  it("documenta el dato verificado, quién escribe hoy, el orden y lo que no toca", () => {
    expect(sql).toMatch(/13 oct, paso34/);
    expect(sql).toMatch(/0 filas/);
    expect(sql).toMatch(/api\/coaching\/_analyze-session\.ts/);
    expect(sql).toMatch(/coachingSessionService\.saveMetric\) no tiene llamadores/);
    expect(sql).toMatch(/077_previa\.sql/);
    expect(sql).toMatch(/077_posterior\.sql/);
    expect(sql).toMatch(/Qué NO toca/);
  });

  it("guardas previas: roles, auth.uid, helper solo-dueño, RLS y columnas; cualquiera aborta", () => {
    const g = code.match(/DO \$guard\$([\s\S]*?)\$guard\$;/)?.[1] ?? "";
    expect(g).toMatch(/RAISE EXCEPTION '077: faltan roles/);
    expect(g).toMatch(/RAISE EXCEPTION '077: auth\.uid\(\) no existe/);
    expect(g).toMatch(/RAISE EXCEPTION '077: falta public\.caller_manages_player/);
    expect(g).toMatch(/v_src ~\* '\(tenant\|org\|team_member\)'/);
    expect(g).toMatch(/RAISE EXCEPTION '077: tablas SIN RLS activada/);
    expect(g).toMatch(/RAISE EXCEPTION '077: faltan columnas/);
    // La 077 NO redefine el helper ni activa/desactiva RLS.
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(code).not.toMatch(/(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it("tracking_jobs: fuera las 2 políticas de la 052 y cualquier otra; REVOKE de tabla y por columna; GRANT solo a service_role", () => {
    const b = code.match(/DO \$jobs\$([\s\S]*?)\$jobs\$;/)?.[1] ?? "";
    expect(b).toMatch(/DROP POLICY IF EXISTS "tracking_jobs_insert" ON public\.tracking_jobs;/);
    expect(b).toMatch(/DROP POLICY IF EXISTS "tracking_jobs_select" ON public\.tracking_jobs;/);
    expect(b).toMatch(/EXECUTE format\('DROP POLICY %I ON public\.tracking_jobs'/);
    expect(b).toMatch(/REVOKE ALL ON TABLE public\.tracking_jobs FROM PUBLIC, anon, authenticated;/);
    expect(b).toMatch(/EXECUTE format\('REVOKE ALL \(%I\) ON public\.tracking_jobs FROM PUBLIC, anon, authenticated'/);
    expect(b).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.tracking_jobs TO service_role;/);
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  });

  it("anon: REVOKE de escritura (tabla y columnas) en las 15 tablas; las lecturas no se tocan", () => {
    const b = code.match(/DO \$anon\$([\s\S]*?)\$anon\$;/)?.[1] ?? "";
    expect([...b.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual(ANON_TABLES);
    expect(b).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.%I FROM anon/);
    expect(b).toMatch(/REVOKE INSERT \(%I\), UPDATE \(%I\) ON public\.%I FROM anon/);
    expect(b).not.toMatch(/REVOKE[^;']*SELECT/i);
  });

  it("guarda final: comprueba las 4 guardas, tracking_jobs cerrada (tabla y columnas) con service_role, y anon sin escritura", () => {
    const f = code.match(/DO \$final\$([\s\S]*?)\$final\$;/)?.[1] ?? "";
    expect(f).toMatch(/_requires_owner_077/);
    expect(f).toMatch(/p\.permissive = 'RESTRICTIVE'/);
    expect(f).toMatch(/has_any_column_privilege\('authenticated', 'public\.tracking_jobs', 'SELECT'\)/);
    expect(f).toMatch(/RAISE EXCEPTION '077: quedan políticas o permisos de cliente en tracking_jobs/);
    expect(f).toMatch(/RAISE EXCEPTION '077: service_role perdió permisos en tracking_jobs/);
    expect(f).toMatch(/RAISE EXCEPTION '077: anon sigue pudiendo escribir/);
    const list = f.slice(f.lastIndexOf("unnest(ARRAY["), f.lastIndexOf("]) t"));
    expect([...list.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual(ANON_TABLES);
  });

  it("no toca datos, PHV ni triggers", () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+public\.\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\b(CREATE|DROP)\s+(TRIGGER|TABLE|VIEW)\b/i);
    expect(code).not.toMatch(/phv|mirwald|bio_band|anthropometr/i);
  });
});

describe("077 · comprobaciones previa/posterior (solo lectura, nunca fallan por objetos ausentes)", () => {
  const files = ["/supabase/checks/077_previa.sql", "/supabase/checks/077_posterior.sql"];
  const noStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''");

  it("existen las dos", () => {
    expect(Object.keys(checks).sort()).toEqual([...files].sort());
  });

  it.each(files)("%s: una sola consulta de lectura (WITH … SELECT), sin escrituras ni DDL", (f) => {
    const c = strip(checks[f]);
    expect(c.trim()).toMatch(/^WITH\b/);
    expect(noStrings(c).split(";").filter((s) => s.trim() !== "")).toHaveLength(1);
    expect(noStrings(c)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COMMIT|BEGIN)\b/i);
    expect(c).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[\w.]+\s+SET|DELETE\s+FROM)\b/i);
    expect(c).not.toMatch(/'public\.\w+'::regclass/);
    expect(c).toMatch(/to_regclass\('public\.tracking_jobs'\)/);
    expect(c).toMatch(/to_regrole\('authenticated'\)/);
  });

  it("previa: 5 filas BLOQUEA (roles, auth.uid, helper, RLS, columnas)", () => {
    const c = strip(checks["/supabase/checks/077_previa.sql"]);
    expect([...c.matchAll(/'BLOQUEA · /g)]).toHaveLength(5);
  });

  it("las listas de tablas de anon coinciden en la migración y en la previa/posterior", () => {
    for (const f of files) {
      const c = strip(checks[f]);
      const start = c.indexOf("anon_t(t) AS (");
      const list = c.slice(start, c.indexOf("\n),", start));
      expect([...list.matchAll(/'(\w+)'/g)].map((m) => m[1]), f).toEqual(ANON_TABLES);
    }
  });
});
