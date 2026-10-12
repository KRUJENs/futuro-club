/**
 * Lint estático de regresión sobre las POLÍTICAS RLS de supabase/migrations/*.sql
 * (aplicadas en orden de nombre de fichero). Ver la migración 073.
 *
 * Clase de defecto que vigila: una política VIGENTE (su última definición tras
 * aplicar todas las migraciones) que compara una columna tenant_id (id de TENANT)
 * con auth.uid() (id de USUARIO). 044 y 050 lo hacían
 *   player_id IN (SELECT id FROM players WHERE tenant_id = auth.uid())
 * y en producción (dato verificado por el dueño, 29-30 sep 2026) ningún
 * players.tenant_id es un auth.users.id, así que esas políticas no daban acceso a
 * nadie. Comparar tenant con tenant (public.tenant_id(), claim del JWT) o usuario
 * con usuario (user_id = auth.uid()) es correcto y NO se marca.
 *
 * Estado que se simula por política (clave «esquema.tabla|nombre»):
 *   CREATE POLICY ⇒ define (o redefine) · ALTER POLICY ⇒ cambia TO/USING/WITH CHECK
 *   o renombra · DROP POLICY ⇒ la quita · DROP TABLE ⇒ quita las de esa tabla.
 * Se leen las sentencias de nivel superior y las ESTÁTICAS dentro de bloques DO
 * (p. ej. bajo IF to_regclass(...)); se consideran ejecutadas.
 * Limitación declarada: el SQL dinámico (EXECUTE format(...)) NO se interpreta; así
 * crea 003 sus políticas *_tenant_isolation (tenant contra tenant, no es la clase).
 */
import { splitStatements, firstDollarBody, normIdent, matchParen, type MigrationFile, type Stmt } from "./securityDefinerLint";
// (La segunda mitad del fichero, «Escrituras de cliente que no exigen ser el dueño
// del jugador», es el lint de la migración 074.)

export type PolicyCmd = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export interface PolicyState {
  /** esquema.tabla normalizado (public.x). */
  table: string;
  name: string;
  cmd: PolicyCmd;
  permissive: boolean;
  /** Roles en minúsculas; ["public"] si la política no tiene cláusula TO. */
  roles: string[];
  /** Texto original de USING (...) sin los paréntesis externos; null si no hay. */
  using: string | null;
  /** Texto original de WITH CHECK (...) sin los paréntesis externos; null si no hay. */
  check: string | null;
  definedIn: string;
}

export interface PolicyViolation {
  key: string;
  table: string;
  policy: string;
  clause: "USING" | "WITH CHECK";
  file: string;
  expr: string;
}

const POLICY_KEYWORD = /\b(CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|DROP\s+TABLE)\b/i;
const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const TABLE = String.raw`([\w."$]+)`;

/** Sentencias de política de un script: nivel superior + estáticas dentro de DO. */
export function policyStatements(sql: string): Stmt[] {
  const res: Stmt[] = [];
  for (const st of splitStatements(sql)) {
    if (/^\s*DO\b/i.test(st.masked)) {
      const body = firstDollarBody(st);
      if (!body) continue;
      for (const inner of splitStatements(body)) {
        const k = POLICY_KEYWORD.exec(inner.masked);
        if (!k) continue;
        res.push({ text: inner.text.slice(k.index), masked: inner.masked.slice(k.index) });
      }
      continue;
    }
    if (/^\s*(CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|DROP\s+TABLE)\b/i.test(st.masked)) res.push(st);
  }
  return res;
}

function normName(raw: string): string {
  const t = raw.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}

/** Primer `re` (anclado) a profundidad de paréntesis 0 en `masked`, desde `from`. */
function topLevel(masked: string, re: RegExp, from = 0): RegExpExecArray | null {
  let depth = 0;
  const sticky = new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y");
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      sticky.lastIndex = i;
      const m = sticky.exec(masked);
      if (m) return m;
    }
  }
  return null;
}

interface Clauses {
  cmd?: PolicyCmd;
  permissive?: boolean;
  roles?: string[];
  using?: string;
  check?: string;
}

/** Cláusulas AS / FOR / TO / USING (...) / WITH CHECK (...) de la cola de CREATE/ALTER POLICY. */
function parseClauses(text: string, masked: string): Clauses {
  const out: Clauses = {};
  const exprAt = (m: RegExpExecArray | null): string | undefined => {
    if (!m) return undefined;
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    return text.slice(open + 1, close === -1 ? undefined : close).trim();
  };
  const u = topLevel(masked, /\bUSING\s*\(/i);
  const c = topLevel(masked, /\bWITH\s+CHECK\s*\(/i);
  out.using = exprAt(u);
  out.check = exprAt(c);
  const headEnd = Math.min(u ? u.index : masked.length, c ? c.index : masked.length);
  const head = masked.slice(0, headEnd);
  const as = /\bAS\s+(PERMISSIVE|RESTRICTIVE)\b/i.exec(head);
  if (as) out.permissive = as[1].toUpperCase() === "PERMISSIVE";
  const f = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(head);
  if (f) out.cmd = f[1].toUpperCase() as PolicyCmd;
  const to = /\bTO\s+([\s\S]+)$/i.exec(head);
  if (to) {
    out.roles = to[1]
      .split(",")
      .map((r) => normName(r))
      .filter(Boolean);
  }
  return out;
}

function applyPolicyStatement(state: Map<string, PolicyState>, st: Stmt, file: string): void {
  const m = st.masked;
  let r: RegExpExecArray | null;

  if ((r = new RegExp(String.raw`^\s*CREATE\s+POLICY\s+${IDENT}\s+ON\s+(?:TABLE\s+)?${TABLE}`, "i").exec(m))) {
    const name = normName(r[1]);
    const table = normIdent(r[2]);
    const cl = parseClauses(st.text.slice(r[0].length), m.slice(r[0].length));
    state.set(`${table}|${name}`, {
      table,
      name,
      cmd: cl.cmd ?? "ALL",
      permissive: cl.permissive ?? true,
      roles: cl.roles ?? ["public"],
      using: cl.using ?? null,
      check: cl.check ?? null,
      definedIn: file,
    });
    return;
  }

  if ((r = new RegExp(String.raw`^\s*ALTER\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+${TABLE}\s*`, "i").exec(m))) {
    const key = `${normIdent(r[2])}|${normName(r[1])}`;
    const cur = state.get(key);
    if (!cur) return;
    const tailM = m.slice(r[0].length);
    const rename = new RegExp(String.raw`^RENAME\s+TO\s+${IDENT}`, "i").exec(tailM);
    if (rename) {
      state.delete(key);
      const name = normName(rename[1]);
      state.set(`${cur.table}|${name}`, { ...cur, name, definedIn: file });
      return;
    }
    const cl = parseClauses(st.text.slice(r[0].length), tailM);
    state.set(key, {
      ...cur,
      roles: cl.roles ?? cur.roles,
      using: cl.using ?? cur.using,
      check: cl.check ?? cur.check,
      definedIn: file,
    });
    return;
  }

  if ((r = new RegExp(String.raw`^\s*DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+${TABLE}`, "i").exec(m))) {
    state.delete(`${normIdent(r[2])}|${normName(r[1])}`);
    return;
  }

  if ((r = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(m))) {
    const list = r[1].replace(/\b(CASCADE|RESTRICT)\s*$/i, "");
    for (const part of list.split(",")) {
      if (!part.trim()) continue;
      const table = normIdent(part.trim());
      for (const k of [...state.keys()]) if (k.startsWith(`${table}|`)) state.delete(k);
    }
  }
}

/** Aplica las migraciones en orden de nombre y devuelve las políticas VIGENTES. */
export function buildPolicyState(files: MigrationFile[]): Map<string, PolicyState> {
  const state = new Map<string, PolicyState>();
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of ordered) for (const st of policyStatements(f.sql)) applyPolicyStatement(state, st, f.name);
  return state;
}

// ─── Detección tenant_id vs auth.uid() ────────────────────────────────────────

/**
 * Quita comentarios del texto original conservando los literales (usa la máscara
 * de splitStatements: en ella los comentarios quedan en blanco y los literales
 * conservan sus comillas). Admite varias sentencias; el ';' se conserva.
 */
function stripComments(text: string): string {
  return splitStatements(text + "\n")
    .map(({ text: t, masked: m }) => {
      let out = "";
      let inLit = false;
      for (let i = 0; i < t.length; i++) {
        if (m[i] === "'") {
          inLit = !inLit;
          out += t[i];
        } else if (inLit) out += t[i];
        else if (m[i] === " " && !/\s/.test(t[i])) out += " "; // carácter de comentario
        else out += t[i];
      }
      return out;
    })
    .join(" ; ");
}

const TOKEN_RE = /'(?:[^']|'')*'|"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*|::|->>|->|<>|!=|>=|<=|[=(),.]|\S/g;

/** Tokens con los identificadores con punto unidos (a.b.c) y en minúsculas; conserva paréntesis. */
function joinedTokens(expr: string): string[] {
  const raw = stripComments(expr).match(TOKEN_RE) ?? [];
  const ident = (t: string) => (t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase());
  const joined: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (/^[A-Za-z_"]/.test(t)) {
      let name = ident(t);
      while (raw[i + 1] === "." && raw[i + 2] && /^[A-Za-z_"]/.test(raw[i + 2])) {
        name += "." + ident(raw[i + 2]);
        i += 2;
      }
      joined.push(name);
    } else joined.push(t.startsWith("'") ? t.toLowerCase() : t);
  }
  return joined;
}

/** Tokens simplificados: identificadores con punto unidos, sin paréntesis ni SELECT ni casts. */
export function simplifiedTokens(expr: string): string[] {
  // 1) une a.b.c
  const joined = joinedTokens(expr);
  // 2) quita paréntesis, SELECT, casts y el alias «AS uid» de (SELECT auth.uid() AS uid)
  const out: string[] = [];
  for (let i = 0; i < joined.length; i++) {
    const t = joined[i];
    if (t === "(" || t === ")" || t === "select") continue;
    if (t === "::") {
      const nt = joined[i + 1];
      i++;
      if ((nt === "double" && joined[i + 1] === "precision") || (nt === "character" && joined[i + 1] === "varying")) i++;
      continue;
    }
    if (t === "as" && out[out.length - 1] === "auth.uid") {
      i++;
      continue;
    }
    out.push(t);
  }
  // 3) equivalencias: auth.jwt() ->> 'sub' ≡ auth.uid() · IS NOT DISTINCT FROM ≡ =
  const res: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "auth.jwt" && out[i + 1] === "->>" && out[i + 2] === "'sub'") {
      res.push("auth.uid");
      i += 2;
    } else if (out[i] === "is" && out[i + 1] === "not" && out[i + 2] === "distinct" && out[i + 3] === "from") {
      res.push("=");
      i += 3;
    } else res.push(out[i]);
  }
  return res;
}

const isTenantRef = (t: string | undefined) => !!t && /(^|\.)tenant_id$/.test(t);

/** ¿La expresión compara tenant_id (columna o tenant_id()) con auth.uid()? */
export function comparesTenantWithUid(expr: string): boolean {
  const s = simplifiedTokens(expr);
  for (let i = 0; i + 2 < s.length; i++) {
    if (isTenantRef(s[i]) && (s[i + 1] === "=" || s[i + 1] === "in") && s[i + 2] === "auth.uid") return true;
    if (s[i] === "auth.uid" && s[i + 1] === "=" && isTenantRef(s[i + 2])) return true;
  }
  return false;
}

/** Políticas VIGENTES que comparan tenant_id con auth.uid(). */
export function tenantUidMixes(files: MigrationFile[]): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  for (const [key, p] of buildPolicyState(files)) {
    for (const [clause, expr] of [
      ["USING", p.using],
      ["WITH CHECK", p.check],
    ] as const) {
      if (expr && comparesTenantWithUid(expr)) v.push({ key, table: p.table, policy: p.name, clause, file: p.definedIn, expr });
    }
  }
  return v;
}

// ─── Escrituras de cliente que no exigen ser el dueño del jugador (074) ───────
//
// Clase de defecto (migración 074): una política PERMISSIVE de ESCRITURA de
// cliente (INSERT / UPDATE / ALL, no solo service_role) sobre una tabla con datos
// de un jugador cuya regla para la fila NUEVA (WITH CHECK, o USING si no hay) solo
// mira la columna del AUTOR (user_id = auth.uid(), coach_id = auth.uid()…) y deja
// libre player_id. Así 043 (fatiga) o 047 (planes IDP) dejaban a cualquier cuenta
// escribir filas de CUALQUIER jugador, que el servidor luego lee por player_id.
// Una ruta así queda CUBIERTA si una política RESTRICTIVE del mismo comando exige
// el helper solo-dueño (public.caller_manages_player, 073/076).
// «Exige propiedad» se decide sobre la ESTRUCTURA de la regla (requiresPlayerOwnership):
// en un OR, TODAS las ramas deben exigirla (o ser solo service_role, o
// «player_id IS NULL», fila sin jugador); en un AND, basta una. Así una rama por
// ORGANIZACIÓN en OR con la del dueño (039: evaluation_history / player_knowledge,
// «… OR org_id IN (SELECT user_org_ids())») NO cuenta como propiedad: cualquier
// cuenta crea su propia organización (026: org_owner_all) y escribe filas de
// cualquier jugador por esa rama. Antes (texto: «menciona players + user_id =
// auth.uid()») ese OR se daba por bueno; el test de la 074 fija el caso.
// Limitación declarada: no interpreta CASE, NOT ni funciones distintas del helper.

const TABLE_KEYWORD = /\b(CREATE\s+(?:UNLOGGED\s+)?TABLE|ALTER\s+TABLE)\b/i;

/** CREATE TABLE / ALTER TABLE de un script: nivel superior + estáticas dentro de DO. */
function tableStatements(sql: string): Stmt[] {
  const res: Stmt[] = [];
  for (const st of splitStatements(sql)) {
    if (/^\s*DO\b/i.test(st.masked)) {
      const body = firstDollarBody(st);
      if (!body) continue;
      for (const inner of splitStatements(body)) {
        const k = TABLE_KEYWORD.exec(inner.masked);
        if (k) res.push({ text: inner.text.slice(k.index), masked: inner.masked.slice(k.index) });
      }
      continue;
    }
    res.push(st);
  }
  return res;
}

/** Elementos de una lista separada por comas a profundidad de paréntesis 0. */
function topLevelItems(masked: string, text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Tablas (esquema.tabla normalizado) que tienen la columna `column` según
 * CREATE TABLE (…) y ALTER TABLE … ADD COLUMN de las migraciones.
 */
export function tablesWithColumn(files: MigrationFile[], column: string): Set<string> {
  const want = column.toLowerCase();
  const out = new Set<string>();
  for (const f of files) {
    for (const st of tableStatements(f.sql)) {
      const ct = /^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."$]+)\s*\(/i.exec(st.masked);
      if (ct) {
        const open = ct.index + ct[0].length - 1;
        const close = matchParen(st.masked, open);
        const items = topLevelItems(st.masked.slice(open + 1, close), st.text.slice(open + 1, close));
        if (items.some((it) => normName(it.split(/\s+/)[0] ?? "") === want)) out.add(normIdent(ct[1]));
        continue;
      }
      const at = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."$]+)\s+([\s\S]+)$/i.exec(st.masked);
      if (at) {
        const re = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/gi;
        for (const m of at[2].matchAll(re)) {
          if (/^(constraint|primary|unique|check|foreign|exclude)$/i.test(m[1])) continue;
          if (normName(m[1]) === want) out.add(normIdent(at[1]));
        }
      }
    }
  }
  return out;
}

/** ¿La regla solo deja pasar a service_role? (auth.role() / claim role del JWT) */
export function serviceRoleOnly(expr: string | null): boolean {
  if (!expr) return false;
  const s = simplifiedTokens(expr).join(" ");
  return /^(auth\.role = 'service_role'|auth\.jwt ->> 'role' = 'service_role')$/.test(s.trim());
}

/** Índice del ')' que cierra el '(' de `open` en una lista de tokens; -1 si no cierra. */
function closeOf(t: string[], open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Trozos de `t` separados por la palabra `kw` (or / and) a profundidad 0. */
function splitTopTokens(t: string[], kw: string): string[][] {
  const out: string[][] = [];
  let depth = 0;
  let cur: string[] = [];
  for (const x of t) {
    if (x === "(") depth++;
    else if (x === ")") depth--;
    if (depth === 0 && x === kw) {
      out.push(cur);
      cur = [];
    } else cur.push(x);
  }
  out.push(cur);
  return out;
}

const topIndexOf = (t: string[], kw: string): number => {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    else if (depth === 0 && t[i] === kw) return i;
  }
  return -1;
};

const isHelper = (x: string | undefined) => x === "caller_manages_player" || x === "public.caller_manages_player";

/**
 * ¿La regla (tokens) EXIGE que el llamador sea el dueño del jugador?
 *   · OR  → todas las ramas la exigen (o son solo service_role, o «player_id IS NULL»).
 *   · AND → basta una rama.
 *   · átomo → el helper solo-dueño; «player_id IS NULL» (fila sin jugador); dentro
 *     de una subconsulta a players, user_id = auth.uid(); o una subconsulta
 *     (IN / EXISTS) cuyo WHERE la exige (se analiza igual, recursivo).
 */
function ownerRule(tokens: string[], inPlayers: boolean): boolean {
  let t = tokens;
  while (t.length >= 2 && t[0] === "(" && closeOf(t, 0) === t.length - 1) t = t.slice(1, -1);
  if (t.length === 0) return false;
  const ors = splitTopTokens(t, "or");
  if (ors.length > 1) return ors.every((p) => ownerRule(p, inPlayers) || serviceRoleOnly(p.join(" ")));
  const ands = splitTopTokens(t, "and");
  if (ands.length > 1) return ands.some((p) => ownerRule(p, inPlayers));
  // átomo
  if (isHelper(t[0]) && t[1] === "(" && closeOf(t, 1) === t.length - 1) return true;
  if (t.length === 3 && /(^|\.)player_id$/.test(t[0]) && t[1] === "is" && t[2] === "null") return true;
  if (inPlayers) {
    const s = simplifiedTokens(t.join(" "));
    const uid = (x: string | undefined) => !!x && /(^|\.)user_id$/.test(x);
    if (s.length === 3 && s[1] === "=" && ((uid(s[0]) && s[2] === "auth.uid") || (s[0] === "auth.uid" && uid(s[2])))) return true;
  }
  // Subconsultas a profundidad 0 del átomo: x IN (SELECT … WHERE …) / EXISTS (SELECT … WHERE …)
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "(") continue;
    const end = closeOf(t, i);
    if (end === -1) break;
    const g = t.slice(i + 1, end);
    i = end;
    if (g[0] !== "select") continue;
    const from = topIndexOf(g, "from");
    const where = topIndexOf(g, "where");
    if (from === -1 || where === -1) continue;
    const table = g[from + 1];
    if (ownerRule(g.slice(where + 1), table === "players" || table === "public.players")) return true;
  }
  return false;
}

/** ¿La regla exige ser el DUEÑO del jugador de la fila? (ver ownerRule) */
export function requiresPlayerOwnership(expr: string | null): boolean {
  if (!expr) return false;
  return ownerRule(joinedTokens(expr), false);
}

export interface WriteGap {
  table: string;
  cmd: "INSERT" | "UPDATE";
  policy: string;
  file: string;
}

/**
 * Rutas de ESCRITURA de cliente (por comando) sobre `tables` que no exigen la
 * propiedad del jugador y que ninguna RESTRICTIVE con el helper cubre.
 */
export function unguardedPlayerWrites(files: MigrationFile[], tables: Set<string>): WriteGap[] {
  const state = buildPolicyState(files);
  const all = [...state.values()];
  const clientRole = (roles: string[]) => roles.some((r) => r === "public" || r === "authenticated");
  const gaps: WriteGap[] = [];
  for (const p of all) {
    if (!tables.has(p.table) || !p.permissive || !clientRole(p.roles)) continue;
    if (p.cmd !== "INSERT" && p.cmd !== "UPDATE" && p.cmd !== "ALL") continue;
    const rule = p.check ?? p.using; // regla de la fila NUEVA
    if (requiresPlayerOwnership(rule) || serviceRoleOnly(rule)) continue;
    for (const cmd of p.cmd === "ALL" ? (["INSERT", "UPDATE"] as const) : [p.cmd]) {
      const covered = all.some(
        (r) =>
          r.table === p.table &&
          !r.permissive &&
          (r.cmd === cmd || r.cmd === "ALL") &&
          clientRole(r.roles) &&
          (r.check ?? r.using ?? "").includes("caller_manages_player") &&
          requiresPlayerOwnership(r.check ?? r.using),
      );
      if (!covered) gaps.push({ table: p.table, cmd, policy: p.name, file: p.definedIn });
    }
  }
  return gaps.sort((a, b) => (`${a.table}|${a.cmd}|${a.policy}` < `${b.table}|${b.cmd}|${b.policy}` ? -1 : 1));
}
