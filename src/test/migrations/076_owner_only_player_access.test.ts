/**
 * Migración 076 — solo el DUEÑO accede a los datos de un jugador (sin rama por tenant).
 *
 * No hay Postgres en CI: se fija el CONTRATO del SQL de forma estática. El
 * comportamiento (antes = acceso cruzado entre cuentas del mismo tenant, después =
 * ninguno; los dueños conservan lo suyo; service_role igual) se comprobó en una
 * SIMULACIÓN PGlite fuera del repo, descrita en el PR.
 *
 *  - transaccional, con guardas al principio y una guarda final que aborta;
 *  - los dos helpers (caller_manages_player, dsar_caller_manages_player) son solo-dueño;
 *  - ninguna política que crea menciona tenant, todas son TO authenticated y van
 *    precedidas de DROP POLICY IF EXISTS (idempotente);
 *  - TODA política por tenant de las migraciones anteriores sobre tablas de jugador
 *    se retira aquí (lint sobre el repositorio, con control positivo);
 *  - no toca datos, PHV (invariante #4) ni permisos de tabla.
 */
import { describe, it, expect } from "vitest";

const FILE = "/supabase/migrations/076_owner_only_player_access.sql";
const all = import.meta.glob("/supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const checks = import.meta.glob("/supabase/checks/076_*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sql = all[FILE] ?? "";

/** Sin comentarios de línea SQL (la cabecera habla de tenant a propósito). */
const strip = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
const code = strip(sql);

const PLAYER_TABLES = [
  "players", "videos", "analyses", "reports", "parental_consents", "player_anthropometrics",
  "development_plans", "idp_goals", "idp_milestones", "idp_checkins", "transfer_listings",
  "transfer_inquiries", "tactical_phases", "phase_heatmaps", "tactical_insights", "match_analyses",
];

type Pol = { file: string; name: string; table: string; body: string };
const POLICY_RE = /CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi;
function policiesIn(file: string, src: string): Pol[] {
  return [...strip(src).matchAll(POLICY_RE)].map((m) => ({ file, name: m[1], table: m[2], body: m[3] }));
}
const created076 = policiesIn(FILE, sql);
const dropped076 = new Set(
  [...code.matchAll(/DROP\s+POLICY\s+IF\s+EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi)].map((m) => `${m[2]}.${m[1]}`),
);

describe("076 · solo el dueño", () => {
  it("es la única migración 076 y es transaccional", () => {
    expect(Object.keys(all).filter((k) => /\/076_/.test(k))).toEqual([FILE]);
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("documenta la decisión: quién, cuándo, por qué y cómo revisarla", () => {
    expect(sql).toMatch(/30 sep 2026/);
    expect(sql).toMatch(/SOLO EL DUEÑO/);
    expect(sql).toMatch(/Por qué/);
    expect(sql).toMatch(/Cómo revisarla/);
    expect(sql).toMatch(/docs\/pendientes-metricas\.md/);
  });

  it("guardas al principio: sin players(id, user_id) o sin auth.uid() aborta", () => {
    expect(code).toMatch(/RAISE EXCEPTION '076: public\.players no existe/);
    expect(code).toMatch(/RAISE EXCEPTION '076: public\.players no tiene user_id/);
    expect(code).toMatch(/RAISE EXCEPTION '076: auth\.uid\(\) no existe/);
  });

  it("guarda final: aborta si queda una política o un helper con tenant", () => {
    expect(code).toMatch(/LIKE '%tenant%'[\s\S]*RAISE EXCEPTION '076: siguen políticas que usan tenant/);
    expect(code).toMatch(/lower\(prosrc\) LIKE '%tenant%'[\s\S]*RAISE EXCEPTION '076: un helper de dueño sigue mencionando tenant/);
  });

  it("caller_manages_player: SECURITY INVOKER, solo players.user_id = auth.uid(), sin tenant", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.caller_manages_player\(p_player_id text\)([\s\S]*?)\$fn\$;/);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).toMatch(/SECURITY INVOKER/);
    expect(body).toMatch(/SET search_path = public, pg_temp/);
    expect(body).toMatch(/p\.user_id = \(SELECT auth\.uid\(\)\)/);
    expect(body).not.toMatch(/tenant/i);
    expect(body).not.toMatch(/user_org_ids|user_in_org|org_id/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.caller_manages_player\(text\) FROM PUBLIC, anon;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.caller_manages_player\(text\) TO authenticated, service_role;/);
  });

  it("dsar_caller_manages_player (072): misma firma, sin tenant, service_role sigue pasando", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.dsar_caller_manages_player\(p_player_id text\)([\s\S]*?)\$\$;/);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).not.toMatch(/tenant/i);
    expect(body).toMatch(/IF v_role = 'service_role' THEN\s+RETURN true;/);
    expect(body).toMatch(/p\.user_id = v_uid/);
    expect(body).not.toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.dsar_caller_manages_player\(text\) FROM PUBLIC, anon, authenticated;/);
  });

  it("cada política nueva: *_076, TO authenticated, sin tenant, precedida de DROP IF EXISTS", () => {
    // 25 políticas distintas (reports_select_owner_076 aparece en las dos ramas de un IF).
    expect(new Set(created076.map((p) => `${p.table}.${p.name}`)).size).toBe(25);
    for (const p of created076) {
      expect(p.name).toMatch(/_076$/);
      expect(PLAYER_TABLES).toContain(p.table);
      expect(p.body).toMatch(/TO authenticated/);
      expect(p.body).not.toMatch(/tenant/i);
      expect(p.body).not.toMatch(/user_org_ids|user_in_org/);
      expect(dropped076.has(`${p.table}.${p.name}`)).toBe(true);
    }
  });

  it("las escrituras de datos de jugador exigen ser el DUEÑO del jugador (WITH CHECK)", () => {
    const writes = created076.filter((p) => /FOR ALL/.test(p.body) && p.table !== "players" && p.table !== "transfer_inquiries");
    expect(writes.length).toBeGreaterThanOrEqual(10);
    for (const p of writes) expect(p.body).toMatch(/WITH CHECK[\s\S]*caller_manages_player/);
    const players = created076.find((p) => p.name === "players_owner_076")!;
    expect(players.body).toMatch(/USING \(user_id = \(SELECT auth\.uid\(\)\)\)\s+WITH CHECK \(user_id = \(SELECT auth\.uid\(\)\)\)/);
  });

  it("lint del repositorio: retira TODA política anterior por tenant sobre tablas de jugador", () => {
    const earlier = Object.entries(all).filter(([k]) => /\/0[0-7]\d_/.test(k) && k < FILE);
    const tenantPolicies = earlier.flatMap(([k, src]) => policiesIn(k, src)).filter(
      (p) => PLAYER_TABLES.includes(p.table) && /tenant/i.test(p.body),
    );
    // Las de 003 se crean con format() dentro de un DO (players/videos/analyses/reports).
    const dynamic003 = ["players", "videos", "analyses", "reports"].map((t) => `${t}.${t}_tenant_isolation`);
    const expected = [...new Set([...tenantPolicies.map((p) => `${p.table}.${p.name}`), ...dynamic003])].sort();
    // Control positivo: el lint encuentra las que se sabe que existen.
    expect(expected).toEqual(expect.arrayContaining([
      "analyses.analyses_tenant_isolation", "match_analyses.match_analyses_select_owner",
      "development_plans.idp_plans_coach_write", "transfer_listings.listings_owner_write",
      "tactical_phases.tactical_phases_owner_read", "parental_consents.consent_tenant_isolation",
      "player_anthropometrics.anthro_tenant_isolation",
    ]));
    expect(expected.length).toBeGreaterThanOrEqual(22);
    for (const key of expected) expect(dropped076.has(key), key).toBe(true);
    // Las de 048, abiertas a CUALQUIER usuario con sesión, también se retiran.
    for (const t of ["tactical_phases", "phase_heatmaps", "tactical_insights"]) {
      expect(dropped076.has(`${t}.${t}_auth_read`)).toBe(true);
      expect(dropped076.has(`${t}.${t}_auth_write`)).toBe(true);
    }
  });

  it("ninguna migración POSTERIOR vuelve a abrir tablas de jugador por tenant", () => {
    const later = Object.entries(all).filter(([k]) => k > FILE);
    const bad = later.flatMap(([k, src]) => policiesIn(k, src)).filter(
      (p) => PLAYER_TABLES.includes(p.table) && /tenant/i.test(p.body),
    );
    expect(bad).toEqual([]);
  });

  it("no toca datos, PHV (inv #4), vistas ni permisos de tabla", () => {
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+VIEW|CREATE\s+(OR\s+REPLACE\s+)?VIEW/i);
    expect(code).not.toMatch(/mirwald|maturity_offset|phv_|pah|khamis/i);
    expect(code).not.toMatch(/(GRANT|REVOKE)\s+[\w,\s]+\s+ON\s+(TABLE\s+)?public\.\w+\s+(TO|FROM)/i);
    expect(code).not.toMatch(/user_org_ids|user_in_org/);
  });

  it("existen la comprobación previa y la posterior, de solo lectura (un SELECT)", () => {
    const pre = checks["/supabase/checks/076_previa.sql"] ?? "";
    const post = checks["/supabase/checks/076_posterior.sql"] ?? "";
    for (const s of [pre, post]) {
      const c = strip(s).trim();
      expect(c.length).toBeGreaterThan(0);
      expect(c).toMatch(/^WITH\b/);
      expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b\s+(INTO|public|TABLE|POLICY|FUNCTION|ON|FROM)/i);
      expect(c.split(";").filter((x) => x.trim()).length).toBe(1);
    }
    // Misma resolución del tenant que public.tenant_id() + hook 057 (app_metadata.tenant_id).
    expect(pre).toMatch(/raw_app_meta_data ->> ''tenant_id''/);
    expect(pre).toMatch(/URGENTE · bajas pendientes/);
  });
});
