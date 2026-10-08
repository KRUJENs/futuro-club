/**
 * VITAS · Lint: ningún código de api/ da acceso a datos de jugador por TENANT (076)
 *
 * Decisión del 30 sep 2026 (ver supabase/migrations/076_owner_only_player_access.sql y
 * docs/pendientes-metricas.md): los datos de un jugador los ve y cambia SOLO su dueño
 * (players.user_id) o service_role. El tenant_id compartido de producción (los 3 jugadores
 * tienen el mismo valor, que no es ni un usuario ni una organización) no identifica a nadie.
 *
 * Aquí se fija que ninguna ruta del backend vuelva a comparar ni filtrar por tenant para
 * autorizar. Se permite ESCRIBIR tenant_id como etiqueta de la fila (p. ej.
 * analyses.tenant_id es NOT NULL) y la lista de nombres a QUITAR del texto del job de
 * partido (identityGuard.rosterRedactionFilter), que no da acceso a nada.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const API = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Código sin comentarios de línea ni de bloque (las cabeceras explican el cambio). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** Patrones de AUTORIZACIÓN por tenant (comparar o filtrar por él). */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["compara tenant_id con el tenant del JWT", /tenant_id\s*===\s*tenantId|tenantId\s*===\s*[\w.?]*tenant_id/],
  ["filtra supabase-js por tenant_id", /\.eq\(\s*["'`]tenant_id["'`]/],
  ["filtra PostgREST por tenant_id=eq.", /tenant_id=eq\./],
  ["cláusula or() por tenant_id.eq.", /tenant_id\.eq\./],
  ["helper con respaldo por tenant", /ownsPlayerOrTenant|ownedPlayersOrFilter/],
];
/** Única excepción: lista de nombres a descartar del texto (no es acceso). */
const ALLOW: Record<string, string[]> = {
  "_lib/matchJob/identityGuard.ts": ["cláusula or() por tenant_id.eq."],
};

const files = walk(API);

describe("api/ · sin acceso por tenant (076, solo el dueño)", () => {
  it("control positivo: el recorrido encuentra los ficheros y los patrones SÍ casan donde deben", () => {
    const rel = files.map((f) => relative(API, f).replace(/\\/g, "/"));
    expect(rel).toContain("_lib/ownership.ts");
    expect(rel).toContain("crons/data-retention.ts");
    expect(rel.length).toBeGreaterThan(100);
    // Cada patrón casa con el código que ESTE PR retiró (fragmentos literales de main 0c3a438:
    // _lib/ownership.ts, crons/data-retention.ts, tactical/_list-matches.ts, _lib/ownership.ts,
    // analyses/reports.ts).
    const removed = [
      "(!!p.tenant_id && !!tenantId && p.tenant_id === tenantId)",
      '.eq("tenant_id", req.tenant_id);',
      "/rest/v1/analyses?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id",
      "if (tenantId && OWN_UUID_RE.test(tenantId)) clauses.push(`tenant_id.eq.${tenantId}`);",
      "(await ownsPlayerOrTenant(a.player_id ?? null, userId, tenantId))",
    ];
    FORBIDDEN.forEach(([, re], i) => expect(re.test(removed[i])).toBe(true));
    // La excepción permitida sigue existiendo (si desaparece, se retira del ALLOW).
    const guard = readFileSync(join(API, "_lib/matchJob/identityGuard.ts"), "utf8");
    expect(guard).toMatch(/tenant_id\.eq\./);
  });

  it("ningún fichero de api/ (salvo la excepción documentada) autoriza por tenant", () => {
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(API, f).replace(/\\/g, "/");
      const src = code(readFileSync(f, "utf8"));
      for (const [label, re] of FORBIDDEN) {
        if ((ALLOW[rel] ?? []).includes(label)) continue;
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${rel}:${i + 1} · ${label} · ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
