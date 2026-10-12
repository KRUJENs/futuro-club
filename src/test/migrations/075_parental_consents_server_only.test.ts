/**
 * Migración 075 — parental_consents solo la lee y la escribe el servidor (hallazgo B6 del
 * PR #308; VERIFICADO en producción el 9 oct: auth_can_update_consents = true).
 *
 * No hay Postgres en CI: se fija el CONTRATO del SQL de forma estática. El comportamiento
 * (antes: un `authenticated` con el tenant de la fila marca verificada una pendiente, lee
 * el token y los datos del tutor de otra cuenta, reapunta una verificada; después: 42501
 * en todo, service_role igual) se comprobó en una SIMULACIÓN PGlite fuera del repo,
 * descrita en el PR (base vacía, forma de producción sin 073/076, todas las migraciones,
 * idempotencia y controles positivos).
 */
import { describe, it, expect } from "vitest";

const FILE = "/supabase/migrations/075_parental_consents_server_only.sql";
const all = import.meta.glob("/supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const checks = import.meta.glob("/supabase/checks/075_*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sql = all[FILE] ?? "";

/** Sin comentarios de línea SQL (la cabecera explica a propósito lo que NO hace). */
const strip = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
const code = strip(sql);

describe("075 · parental_consents solo service_role", () => {
  it("es la única 075 y es transaccional", () => {
    expect(Object.keys(all).filter((k) => /\/075_/.test(k))).toEqual([FILE]);
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("documenta el porqué (B6, dato verificado), la regla, el orden de despliegue y lo que no toca", () => {
    expect(sql).toMatch(/B6/);
    expect(sql).toMatch(/auth_can_update_consents = true/);
    expect(sql).toMatch(/9 oct 2026/);
    expect(sql).toMatch(/NUNCA\s+--\s+players\.parental_consent_status|NUNCA[\s\S]{0,40}players\.parental_consent_status/);
    expect(sql).toMatch(/api\/_lib\/parentalConsent\.ts/);
    expect(sql).toMatch(/ORDEN DE DESPLIEGUE/);
    expect(sql).toMatch(/el código NO depende de esta migración/);
    expect(sql).toMatch(/075_previa\.sql/);
    expect(sql).toMatch(/075_posterior\.sql/);
    expect(sql).toMatch(/SIMULACIÓN PGlite/);
    expect(sql).toMatch(/QUÉ NO TOCA/);
  });

  it("guarda previa: sin los roles de Supabase aborta", () => {
    expect(code).toMatch(/to_regrole\('anon'\) IS NULL OR to_regrole\('authenticated'\) IS NULL OR to_regrole\('service_role'\) IS NULL[\s\S]*?RAISE EXCEPTION '075: faltan roles/);
  });

  it("parental_consents: RLS, retira TODA política, REVOKE de tabla y POR COLUMNA a PUBLIC/anon/authenticated, GRANT a service_role", () => {
    const block = code.match(/DO \$pc\$([\s\S]*?)\$pc\$;/)?.[1] ?? "";
    expect(block).toMatch(/IF to_regclass\('public\.parental_consents'\) IS NULL THEN[\s\S]*?RETURN;/);
    expect(block).toMatch(/ALTER TABLE public\.parental_consents ENABLE ROW LEVEL SECURITY;/);
    expect(block).toMatch(/DROP POLICY IF EXISTS "consent_tenant_isolation" ON public\.parental_consents;/);
    expect(block).toMatch(/FROM pg_policies[\s\S]*?tablename = 'parental_consents'[\s\S]*?EXECUTE format\('DROP POLICY %I ON public\.parental_consents'/);
    expect(block).toMatch(/REVOKE ALL ON TABLE public\.parental_consents FROM PUBLIC, anon, authenticated;/);
    expect(block).toMatch(/EXECUTE format\('REVOKE ALL \(%I\) ON public\.parental_consents FROM PUBLIC, anon, authenticated'/);
    expect(block).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.parental_consents TO service_role;/);
    // Nunca concede nada a un rol de cliente.
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  });

  it("gdpr_audit_log (evidencia): reafirma la 072 sin abrir nada", () => {
    const block = code.match(/DO \$audit\$([\s\S]*?)\$audit\$;/)?.[1] ?? "";
    expect(block).toMatch(/IF to_regclass\('public\.gdpr_audit_log'\) IS NULL THEN[\s\S]*?RETURN;/);
    expect(block).toMatch(/DROP POLICY IF EXISTS "audit_insert_authenticated" ON public\.gdpr_audit_log;/);
    expect(block).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.gdpr_audit_log FROM PUBLIC, authenticated;/);
    expect(block).toMatch(/REVOKE INSERT \(%I\), UPDATE \(%I\) ON public\.gdpr_audit_log FROM PUBLIC, anon, authenticated/);
    expect(block).toMatch(/GRANT SELECT, INSERT ON TABLE public\.gdpr_audit_log TO service_role;/);
  });

  it("guarda final: aborta si queda un permiso/política de cliente o le falta algo a service_role", () => {
    const block = code.match(/DO \$final\$([\s\S]*?)\$final\$;/)?.[1] ?? "";
    expect(block).toMatch(/has_table_privilege\(rl, 'public\.parental_consents', p\)/);
    expect(block).toMatch(/has_any_column_privilege\(rl, 'public\.parental_consents', p\)/);
    expect(block).toMatch(/NOT has_table_privilege\('service_role', 'public\.parental_consents', p\)/);
    expect(block).toMatch(/has_table_privilege\(rl, 'public\.gdpr_audit_log', p\)/);
    expect(block).toMatch(/RAISE EXCEPTION '075: quedan permisos de cliente/);
  });

  it("no toca datos, PHV, funciones, triggers ni crea políticas", () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+public\.\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|POLICY|VIEW)\b/i);
    expect(code).not.toMatch(/\bDROP\s+(FUNCTION|TRIGGER|TABLE|VIEW)\b/i);
    expect(code).not.toMatch(/phv|mirwald|bio_band|anthropometr/i);
  });
});

describe("075 · comprobaciones previa/posterior (solo lectura, nunca fallan por objetos ausentes)", () => {
  const files = ["/supabase/checks/075_previa.sql", "/supabase/checks/075_posterior.sql"];

  it("existen las dos", () => {
    expect(Object.keys(checks).sort()).toEqual([...files].sort());
  });

  /** Sin literales de texto ('…'): los nombres de privilegio ('TRUNCATE') no son sentencias. */
  const noStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''");

  it.each(files)("%s: una sola consulta de lectura (WITH … SELECT), sin escrituras ni DDL", (f) => {
    const c = strip(checks[f]);
    expect(c.trim()).toMatch(/^WITH\b/);
    expect(c.trim().endsWith(";")).toBe(true);
    expect(noStrings(c).split(";").filter((s) => s.trim() !== "")).toHaveLength(1);
    expect(noStrings(c)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COMMIT|BEGIN)\b/i);
    // Tampoco dentro de las consultas de query_to_xml (texto entre comillas).
    expect(c).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[\w.]+\s+SET|DELETE\s+FROM)\b/i);
  });

  it.each(files)("%s: protege cada objeto con to_regclass / to_regrole antes de usarlo", (f) => {
    const c = strip(checks[f]);
    expect(c).toMatch(/to_regclass\('public\.parental_consents'\)/);
    expect(c).toMatch(/to_regclass\('public\.gdpr_audit_log'\)/);
    expect(c).toMatch(/to_regrole\('authenticated'\)/);
    // Nunca un cast ::regclass de un literal (fallaría si la tabla no existe).
    expect(c).not.toMatch(/'public\.\w+'::regclass/);
  });

  it("previa: cuenta lo que el código nuevo deja de aceptar (sin evidencia, token en claro) sin devolver datos personales", () => {
    const c = strip(checks["/supabase/checks/075_previa.sql"]);
    expect(c).toMatch(/consent_email_verified/);
    expect(c).toMatch(/consent_withdrawn/);
    expect(c).toMatch(/not like ''sha256:%''/);
    expect(c).not.toMatch(/select[^;]*\bparent_email\b[^;]*from/i);
    expect(c).not.toMatch(/parent_dni_hash/);
  });
});
