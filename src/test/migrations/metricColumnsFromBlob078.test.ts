/**
 * Migración 078 (P1 bloque 7b): metric_* y vsi de players = proyección del blob, sin 0
 * inventado ni valor viejo de la columna; sin DEFAULT 0. No toca PHV (invariante #4).
 * El comportamiento se probó en PGlite con el cuerpo REAL de producción (T2-A, 19 oct).
 */
import { describe, expect, it } from "vitest";

const MIG = import.meta.glob("/supabase/migrations/078_metric_columns_from_blob.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const sql = MIG["/supabase/migrations/078_metric_columns_from_blob.sql"];
const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("078 · columnas desde el blob", () => {
  it("existe, va en una transacción y lleva guarda sobre el cuerpo de producción", () => {
    expect(sql).toBeTruthy();
    expect(code.trim()).toMatch(/^BEGIN;/);
    expect(code.trim()).toMatch(/COMMIT;$/);
    expect(code).toMatch(/RAISE EXCEPTION '078: el cuerpo de sync_player_columns_from_jsonb\(\) no es el esperado/);
  });

  it("metric_* y vsi sin «, 0» ni COALESCE con la columna; DEFAULT fuera", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION"));
    for (const k of ["speed", "technique", "vision", "stamina", "shooting", "defending"]) {
      expect(fn).toMatch(new RegExp(`NEW\\.metric_${k}\\s*:=\\s*CASE WHEN jsonb_typeof\\(NEW\\.data->'metrics'->'${k}'\\) = 'number'`));
      expect(code).toMatch(new RegExp(`ALTER COLUMN metric_${k}\\s+DROP DEFAULT`));
    }
    expect(fn).not.toMatch(/COALESCE\(NEW\.metric_/);
    expect(fn).toMatch(/NEW\.vsi\s*:=\s*CASE WHEN jsonb_typeof\(NEW\.data->'vsi'\) = 'number'/);
  });

  it("no toca PHV: protección de phv_category/phv_offset y sexo sin «M» iguales; sin fórmulas ni SECURITY DEFINER", () => {
    expect(code).toMatch(/NEW\.phv_category := OLD\.phv_category;/);
    expect(code).toMatch(/NEW\.gender\s*:=\s*COALESCE\(NEW\.gender, NEW\.data->>'gender'\);/);
    expect(code).not.toMatch(/mirwald|khamis|maturity_offset\s*=|SECURITY DEFINER/i);
    expect(code).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|TRUNCATE)\b/im);
  });
});
