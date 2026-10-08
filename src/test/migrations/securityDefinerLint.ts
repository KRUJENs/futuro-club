/**
 * Lint estático de regresión sobre supabase/migrations/*.sql (en orden de nombre):
 * funciones SECURITY DEFINER y vistas con permisos del dueño.
 *
 * Por qué existe (clase de defecto, ver migración 072):
 *   - En Supabase los default privileges del esquema public conceden EXECUTE sobre
 *     cada función nueva y ALL sobre cada vista/tabla nueva EXPLÍCITAMENTE a anon y
 *     authenticated. `REVOKE ... FROM PUBLIC` no los quita. (Deducido de la
 *     documentación de Supabase y del repo; no comprobado contra producción.)
 *   - Una función SECURITY DEFINER o una vista sin security_invoker se ejecutan con
 *     los permisos del dueño y saltan la RLS (lints de Supabase 0010/0011/0028/0029).
 *
 * Reglas (sobre el estado FINAL tras aplicar todas las migraciones en orden):
 *   1. Toda función cuya última definición es SECURITY DEFINER fija search_path.
 *   2. Toda función SECURITY DEFINER queda revocada a anon Y a authenticated (y a
 *      PUBLIC, del que ambos heredan), salvo que esté en ALLOWLIST con justificación:
 *        - "client-callable": la llama el navegador con sesión → revocada a anon; su
 *          cuerpo debe contener auth.uid() (comprobación de dueño).
 *        - "rls-helper": la evalúan políticas RLS sin cláusula TO (también para anon)
 *          → no se revoca; su cuerpo debe contener auth.uid().
 *        - "trigger": RETURNS trigger → no invocable por /rest/v1/rpc.
 *   3. Toda vista es security_invoker o está revocada a anon (y a PUBLIC).
 *
 * Modelo de permisos que simula (deducido, no verificado en producción):
 *   - CREATE de un objeto NUEVO ⇒ default privileges: función → PUBLIC, anon,
 *     authenticated, service_role; vista → anon, authenticated, service_role.
 *   - CREATE OR REPLACE de uno existente conserva el ACL (PostgreSQL).
 *   - CREATE OR REPLACE VIEW sustituye las opciones de la vista por las de su WITH
 *     (sin WITH ⇒ security_invoker se pierde). Comprobado en simulación PGlite.
 *   - DROP + CREATE vuelve a los default privileges.
 * Limitación declarada: el SQL dinámico (EXECUTE '...') NO se interpreta. Las
 * sentencias estáticas dentro de bloques DO sí (p. ej. REVOKE bajo un IF
 * to_regprocedure(...)), y se consideran ejecutadas.
 */

export type Role = "PUBLIC" | "anon" | "authenticated" | "service_role";
const ROLES: Role[] = ["PUBLIC", "anon", "authenticated", "service_role"];

export interface MigrationFile {
  name: string;
  sql: string;
}

export type AllowCategory = "client-callable" | "rls-helper" | "trigger";
export interface AllowEntry {
  category: AllowCategory;
  justification: string;
}
export type Allowlist = Record<string, AllowEntry>;

export interface FunctionState {
  key: string;
  name: string;
  definer: boolean;
  searchPathSet: boolean;
  returnsTrigger: boolean;
  body: string;
  acl: Record<Role, boolean>;
  definedIn: string;
}

export interface ViewState {
  key: string;
  invoker: boolean;
  acl: Record<Role, boolean>;
  definedIn: string;
}

export interface Violation {
  object: string;
  kind: "function" | "view" | "allowlist";
  rule: string;
  detail: string;
  file: string;
}

export interface LintState {
  functions: Map<string, FunctionState>;
  views: Map<string, ViewState>;
}

// ─── Lexer ────────────────────────────────────────────────────────────────────

export interface Stmt {
  /** Texto original de la sentencia. */
  text: string;
  /** Mismo largo que `text`; comentarios y contenido de literales ('...' y $tag$...$tag$) en blanco. */
  masked: string;
}

/**
 * Divide un script SQL en sentencias por ';' de nivel superior, respetando
 * comentarios (-- y /* *\/), literales '...' / E'...', identificadores "..." y
 * cuerpos $tag$...$tag$.
 */
export function splitStatements(sql: string): Stmt[] {
  const out: Stmt[] = [];
  let text = "";
  let masked = "";
  let i = 0;
  const n = sql.length;
  const push = (orig: string, mask: string) => {
    text += orig;
    masked += mask;
  };
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    // -- comentario de línea
    if (c === "-" && next === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      push(sql.slice(i, j), blank(sql.slice(i, j)));
      i = j;
      continue;
    }
    // /* comentario de bloque */
    if (c === "/" && next === "*") {
      let j = sql.indexOf("*/", i + 2);
      j = j === -1 ? n : j + 2;
      push(sql.slice(i, j), blank(sql.slice(i, j)));
      i = j;
      continue;
    }
    // 'literal' (E'...' admite \')
    if (c === "'") {
      const prev = sql[i - 1];
      const isE = (prev === "E" || prev === "e") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < n) {
        if (isE && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(j + 1, n);
      const seg = sql.slice(i, end);
      push(seg, seg.length > 1 ? seg[0] + blank(seg.slice(1, -1)) + seg[seg.length - 1] : seg);
      i = end;
      continue;
    }
    // "identificador"
    if (c === '"') {
      let j = sql.indexOf('"', i + 1);
      j = j === -1 ? n : j + 1;
      push(sql.slice(i, j), sql.slice(i, j));
      i = j;
      continue;
    }
    // $tag$ ... $tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        const inner = sql.slice(i + tag.length, close === -1 ? n : close);
        push(sql.slice(i, end), tag + blank(inner) + (close === -1 ? "" : tag));
        i = end;
        continue;
      }
    }
    if (c === ";") {
      if (text.trim()) out.push({ text, masked });
      text = "";
      masked = "";
      i++;
      continue;
    }
    push(c, c);
    i++;
  }
  if (text.trim()) out.push({ text, masked });
  return out;
}

/** Primer cuerpo $tag$...$tag$ de una sentencia (texto original, sin delimitadores). */
export function firstDollarBody(stmt: Stmt): string | null {
  const m = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(stmt.masked);
  if (!m) return null;
  const tag = m[0];
  const start = m.index + tag.length;
  const close = stmt.text.indexOf(tag, start);
  return stmt.text.slice(start, close === -1 ? undefined : close);
}

const STMT_KEYWORD =
  /\b(REVOKE|GRANT|ALTER\s+FUNCTION|ALTER\s+VIEW|DROP\s+FUNCTION|DROP\s+(?:MATERIALIZED\s+)?VIEW|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|(?:MATERIALIZED\s+|TEMP(?:ORARY)?\s+|RECURSIVE\s+)*VIEW))\b/i;

/**
 * Sentencias ejecutables de un script: las de nivel superior y, dentro de los
 * bloques DO, las sentencias estáticas relevantes (se recorta el prefijo de
 * control plpgsql: BEGIN / IF ... THEN / ELSE ...). Los cuerpos de CREATE
 * FUNCTION no se recorren (no se ejecutan al migrar).
 */
export function executableStatements(sql: string): Stmt[] {
  const res: Stmt[] = [];
  for (const st of splitStatements(sql)) {
    if (/^\s*DO\b/i.test(st.masked)) {
      const body = firstDollarBody(st);
      if (body) {
        for (const inner of splitStatements(body)) {
          const k = STMT_KEYWORD.exec(inner.masked);
          if (!k) continue;
          res.push({ text: inner.text.slice(k.index), masked: inner.masked.slice(k.index) });
        }
      }
      continue;
    }
    res.push(st);
  }
  return res;
}

// ─── Normalización de nombres y firmas ────────────────────────────────────────

export function normIdent(raw: string): string {
  const parts = raw
    .trim()
    .split(".")
    .map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
  return parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
}

const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int4: "integer",
  integer: "integer",
  int8: "bigint",
  bigint: "bigint",
  int2: "smallint",
  smallint: "smallint",
  float: "double precision",
  float8: "double precision",
  "double precision": "double precision",
  float4: "real",
  real: "real",
  bool: "boolean",
  boolean: "boolean",
  varchar: "character varying",
  "character varying": "character varying",
  char: "character",
  character: "character",
  decimal: "numeric",
  numeric: "numeric",
  timestamptz: "timestamp with time zone",
  "timestamp with time zone": "timestamp with time zone",
  timestamp: "timestamp without time zone",
  "timestamp without time zone": "timestamp without time zone",
};

const MULTIWORD_TYPE_START = new Set(["double", "character", "timestamp", "time", "bit"]);
const ARG_MODES = new Set(["in", "out", "inout", "variadic"]);

/** Divide por comas de nivel 0 (fuera de paréntesis). */
function splitTopLevel(s: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function normType(raw: string): string {
  let t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const isArray = /\[\]$/.test(t);
  t = t.replace(/\[\]$/, "").replace(/\s*\([^)]*\)/g, "").trim();
  t = t.replace(/^[a-z_][a-z0-9_]*\.(?=[a-z_])/, ""); // quita esquema (extensions.vector → vector)
  t = TYPE_ALIASES[t] ?? t;
  return isArray ? `${t}[]` : t;
}

/** Tipos de entrada (sin OUT) de una lista de parámetros `a int, b text DEFAULT null`. */
export function argTypes(params: string): string[] {
  const types: string[] = [];
  for (const rawParam of splitTopLevel(params)) {
    let p = rawParam.trim();
    if (!p) continue;
    p = p.replace(/\s+DEFAULT\s+[\s\S]*$/i, "").replace(/\s*=\s*[\s\S]*$/, "").trim();
    let tokens = p.split(/\s+/);
    if (ARG_MODES.has(tokens[0].toLowerCase())) {
      if (tokens[0].toLowerCase() === "out") continue;
      tokens = tokens.slice(1);
    }
    if (tokens.length >= 2 && !MULTIWORD_TYPE_START.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
    types.push(normType(tokens.join(" ")));
  }
  return types;
}

/** Posición del ')' que cierra el '(' en `open`. */
export function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface FnRef {
  name: string;
  /** null = sin lista de argumentos (aplica a todas las sobrecargas con ese nombre). */
  types: string[] | null;
}

/** Lista `f(a, b), g` → referencias de función. */
function parseFnRefs(s: string): FnRef[] {
  const refs: FnRef[] = [];
  for (const part of splitTopLevel(s)) {
    const m = /^\s*([\w."$]+)\s*(\()?/.exec(part);
    if (!m) continue;
    if (!m[2]) {
      refs.push({ name: normIdent(m[1]), types: null });
      continue;
    }
    const open = part.indexOf("(", m[0].length - 1);
    const close = matchParen(part, open);
    refs.push({ name: normIdent(m[1]), types: argTypes(part.slice(open + 1, close === -1 ? undefined : close)) });
  }
  return refs;
}

const fnKey = (name: string, types: string[]) => `${name}(${types.join(",")})`;

function parseRoles(s: string): Role[] {
  const roles: Role[] = [];
  const cleaned = s.replace(/\b(CASCADE|RESTRICT)\b/gi, "").replace(/\bWITH\s+GRANT\s+OPTION\b/gi, "");
  for (const raw of cleaned.split(",")) {
    const r = raw.trim().replace(/^"|"$/g, "");
    if (!r) continue;
    if (r.toUpperCase() === "PUBLIC") roles.push("PUBLIC");
    else if ((ROLES as string[]).includes(r)) roles.push(r as Role);
  }
  return roles;
}

// ─── Motor ───────────────────────────────────────────────────────────────────

const defaultFnAcl = (): Record<Role, boolean> => ({ PUBLIC: true, anon: true, authenticated: true, service_role: true });
const defaultViewAcl = (): Record<Role, boolean> => ({ PUBLIC: false, anon: true, authenticated: true, service_role: true });

function parseViewOptions(opts: string): { invoker?: boolean } {
  const m = /\bsecurity_invoker\s*(?:=\s*'?(\w+)'?)?/i.exec(opts);
  if (!m) return {};
  const v = (m[1] ?? "true").toLowerCase();
  return { invoker: ["true", "on", "1", "yes"].includes(v) };
}

function applyStatement(state: LintState, st: Stmt, file: string): void {
  const m = st.masked;
  let r: RegExpExecArray | null;

  // CREATE [OR REPLACE] FUNCTION
  if ((r = /^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+([\w."$]+)\s*\(/i.exec(m))) {
    const name = normIdent(r[2]);
    const open = m.indexOf("(", r[0].length - 1);
    const close = matchParen(m, open);
    const types = argTypes(m.slice(open + 1, close));
    const key = fnKey(name, types);
    const attrs = m.slice(close + 1);
    const prev = state.functions.get(key);
    state.functions.set(key, {
      key,
      name,
      definer: /\bSECURITY\s+DEFINER\b/i.test(attrs),
      searchPathSet: /\bSET\s+search_path\b/i.test(attrs),
      returnsTrigger: /\bRETURNS\s+(?:event_)?trigger\b/i.test(attrs),
      body: firstDollarBody(st) ?? "",
      acl: prev ? prev.acl : defaultFnAcl(),
      definedIn: file,
    });
    return;
  }

  // ALTER FUNCTION f(args) ...
  if ((r = /^\s*ALTER\s+FUNCTION\s+/i.exec(m))) {
    const rest = m.slice(r[0].length);
    const nm = /^([\w."$]+)\s*/.exec(rest);
    if (!nm) return;
    let after = rest.slice(nm[0].length);
    let types: string[] | null = null;
    if (after.startsWith("(")) {
      const close = matchParen(after, 0);
      types = argTypes(after.slice(1, close));
      after = after.slice(close + 1);
    }
    const name = normIdent(nm[1]);
    for (const f of state.functions.values()) {
      if (f.name !== name || (types && f.key !== fnKey(name, types))) continue;
      if (/\bSET\s+search_path\b/i.test(after)) f.searchPathSet = true;
      if (/\bRESET\s+(search_path|ALL)\b/i.test(after)) f.searchPathSet = false;
      if (/\bSECURITY\s+DEFINER\b/i.test(after)) f.definer = true;
      if (/\bSECURITY\s+INVOKER\b/i.test(after)) f.definer = false;
    }
    return;
  }

  // DROP FUNCTION [IF EXISTS] f(args), g(args) [CASCADE]
  if ((r = /^\s*DROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?/i.exec(m))) {
    const list = m.slice(r[0].length).replace(/\b(CASCADE|RESTRICT)\s*$/i, "");
    for (const ref of parseFnRefs(list)) {
      for (const f of [...state.functions.values()]) {
        if (f.name === ref.name && (!ref.types || f.key === fnKey(ref.name, ref.types))) state.functions.delete(f.key);
      }
    }
    return;
  }

  // CREATE [OR REPLACE] [MATERIALIZED|TEMP|RECURSIVE] VIEW name [(cols)] [WITH (opts)] AS
  if ((r = /^\s*CREATE\s+(OR\s+REPLACE\s+)?((?:MATERIALIZED\s+|TEMP(?:ORARY)?\s+|RECURSIVE\s+)*)VIEW\s+(IF\s+NOT\s+EXISTS\s+)?([\w."$]+)/i.exec(m))) {
    if (/TEMP/i.test(r[2])) return;
    const key = normIdent(r[4]);
    const head = m.slice(r[0].length).split(/\bAS\b/i)[0];
    const withM = /\bWITH\s*\(([^)]*)\)/i.exec(head);
    const withText = withM ? st.text.slice(r[0].length + withM.index, r[0].length + withM.index + withM[0].length) : "";
    const prev = state.views.get(key);
    const opts = parseViewOptions(withText);
    state.views.set(key, {
      key,
      invoker: /MATERIALIZED/i.test(r[2]) ? false : opts.invoker ?? false,
      acl: prev ? prev.acl : defaultViewAcl(),
      definedIn: file,
    });
    return;
  }

  // ALTER VIEW [IF EXISTS] name SET (...) | RESET (...)
  if ((r = /^\s*ALTER\s+VIEW\s+(IF\s+EXISTS\s+)?([\w."$]+)\s+(SET|RESET)\s*\(/i.exec(m))) {
    const v = state.views.get(normIdent(r[2]));
    if (!v) return;
    const open = r[0].length - 1;
    const close = matchParen(m, open);
    const inner = st.text.slice(open + 1, close);
    if (r[3].toUpperCase() === "SET") {
      const o = parseViewOptions(inner);
      if (o.invoker !== undefined) v.invoker = o.invoker;
    } else if (/\bsecurity_invoker\b/i.test(inner)) v.invoker = false;
    return;
  }

  // DROP [MATERIALIZED] VIEW [IF EXISTS] a, b [CASCADE]
  if ((r = /^\s*DROP\s+(MATERIALIZED\s+)?VIEW\s+(IF\s+EXISTS\s+)?/i.exec(m))) {
    const list = m.slice(r[0].length).replace(/\b(CASCADE|RESTRICT)\s*$/i, "");
    for (const part of list.split(",")) if (part.trim()) state.views.delete(normIdent(part.trim()));
    return;
  }

  // GRANT / REVOKE ... ON ... TO / FROM ...
  if ((r = /^\s*(GRANT|REVOKE)\s+/i.exec(m))) {
    const isGrant = r[1].toUpperCase() === "GRANT";
    const rest = m.slice(r[0].length);
    const on = /\bON\b/i.exec(rest);
    if (!on) return; // GRANT rol TO rol
    const privs = rest.slice(0, on.index).replace(/^\s*GRANT\s+OPTION\s+FOR\s+/i, "");
    const afterOn = rest.slice(on.index + on[0].length);
    // primer TO/FROM de nivel 0 tras ON
    let depth = 0;
    let cut = -1;
    const dir = isGrant ? /^\s+TO\s/i : /^\s+FROM\s/i;
    for (let i = 0; i < afterOn.length; i++) {
      const ch = afterOn[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && dir.test(afterOn.slice(i))) {
        cut = i;
        break;
      }
    }
    if (cut === -1) return;
    const objPart = afterOn.slice(0, cut).trim();
    const roles = parseRoles(afterOn.slice(cut).replace(dir, ""));
    const privList = privs.toUpperCase();
    const all = /\bALL\b/.test(privList);
    const setAcl = (acl: Record<Role, boolean>) => {
      for (const role of roles) acl[role] = isGrant;
    };

    let o: RegExpExecArray | null;
    if ((o = /^(?:FUNCTION|ROUTINE|PROCEDURE)\s+/i.exec(objPart))) {
      if (!all && !/\bEXECUTE\b/.test(privList)) return;
      for (const ref of parseFnRefs(objPart.slice(o[0].length))) {
        for (const f of state.functions.values()) {
          if (f.name === ref.name && (!ref.types || f.key === fnKey(ref.name, ref.types))) setAcl(f.acl);
        }
      }
      return;
    }
    if ((o = /^ALL\s+(FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+(.+)$/i.exec(objPart))) {
      if (!all && !/\bEXECUTE\b/.test(privList)) return;
      const schemas = o[2].split(",").map((s) => s.trim().toLowerCase());
      for (const f of state.functions.values()) if (schemas.includes(f.name.split(".")[0])) setAcl(f.acl);
      return;
    }
    if ((o = /^ALL\s+TABLES\s+IN\s+SCHEMA\s+(.+)$/i.exec(objPart))) {
      if (!all && !/\bSELECT\b/.test(privList)) return;
      const schemas = o[1].split(",").map((s) => s.trim().toLowerCase());
      for (const v of state.views.values()) if (schemas.includes(v.key.split(".")[0])) setAcl(v.acl);
      return;
    }
    if (/^(SCHEMA|SEQUENCE|DATABASE|TYPE|DOMAIN|LANGUAGE|TABLESPACE|FOREIGN|LARGE)\b/i.test(objPart)) return;
    if (!all && !/\bSELECT\b/.test(privList)) return;
    const tables = objPart.replace(/^TABLE\s+/i, "");
    for (const t of tables.split(",")) {
      const v = state.views.get(normIdent(t.trim()));
      if (v) setAcl(v.acl);
    }
  }
}

/** Aplica las migraciones en orden de nombre de fichero y devuelve el estado final. */
export function buildState(files: MigrationFile[]): LintState {
  const state: LintState = { functions: new Map(), views: new Map() };
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of ordered) for (const st of executableStatements(f.sql)) applyStatement(state, st, f.name);
  return state;
}

const can = (acl: Record<Role, boolean>, role: "anon" | "authenticated") => acl[role] || acl.PUBLIC;
const USES_AUTH_UID = /\bauth\s*\.\s*uid\s*\(\s*\)/i;

export function lintMigrations(files: MigrationFile[], allowlist: Allowlist): Violation[] {
  const state = buildState(files);
  const v: Violation[] = [];
  for (const f of state.functions.values()) {
    if (!f.definer) continue;
    const allow = allowlist[f.key];
    if (!f.searchPathSet) {
      v.push({ object: f.key, kind: "function", rule: "definer-search-path", detail: "SECURITY DEFINER sin SET search_path", file: f.definedIn });
    }
    if (!allow) {
      if (can(f.acl, "anon") || can(f.acl, "authenticated")) {
        v.push({
          object: f.key,
          kind: "function",
          rule: "definer-revoke",
          detail: `SECURITY DEFINER ejecutable por ${can(f.acl, "anon") ? "anon" : ""}${can(f.acl, "anon") && can(f.acl, "authenticated") ? " y " : ""}${can(f.acl, "authenticated") ? "authenticated" : ""} (falta REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated)`,
          file: f.definedIn,
        });
      }
      continue;
    }
    if (allow.category === "client-callable") {
      if (can(f.acl, "anon")) v.push({ object: f.key, kind: "function", rule: "client-callable-anon", detail: "función de cliente aún ejecutable por anon", file: f.definedIn });
      if (!USES_AUTH_UID.test(f.body)) v.push({ object: f.key, kind: "function", rule: "client-callable-auth-uid", detail: "función de cliente SIN auth.uid() en el cuerpo", file: f.definedIn });
    } else if (allow.category === "rls-helper") {
      if (!USES_AUTH_UID.test(f.body)) v.push({ object: f.key, kind: "function", rule: "rls-helper-auth-uid", detail: "helper de RLS SIN auth.uid() en el cuerpo", file: f.definedIn });
    } else if (allow.category === "trigger") {
      if (!f.returnsTrigger) v.push({ object: f.key, kind: "function", rule: "trigger-returns-trigger", detail: "en ALLOWLIST como trigger pero no RETURNS trigger", file: f.definedIn });
    }
  }
  for (const [key, entry] of Object.entries(allowlist)) {
    const f = state.functions.get(key);
    if (!f || !f.definer) {
      v.push({ object: key, kind: "allowlist", rule: "allowlist-stale", detail: `entrada de ALLOWLIST (${entry.category}) sin función SECURITY DEFINER con esa firma`, file: "-" });
    }
    if (!entry.justification || entry.justification.trim().length < 20) {
      v.push({ object: key, kind: "allowlist", rule: "allowlist-justification", detail: "justificación ausente o demasiado corta", file: "-" });
    }
  }
  for (const view of state.views.values()) {
    if (!view.invoker && can(view.acl, "anon")) {
      v.push({ object: view.key, kind: "view", rule: "view-owner-rights-anon", detail: "vista con permisos del dueño (sin security_invoker) legible por anon", file: view.definedIn });
    }
  }
  return v;
}
