/**
 * Lint de la migración 067 (revisión adversarial "IDOR + saltarse el presupuesto por RLS"):
 * el cliente SOLO puede leer sus jobs; ninguna política ni privilegio de escritura para
 * anon/authenticated; segmentos sin acceso de cliente; RPC solo para service_role; FK del
 * vídeo en cascada (las purgas RGPD no se rompen ni dejan informes huérfanos); y los
 * CHECK de estado idénticos a los del contrato (inv #7).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MATCH_JOB_STATUSES, SEGMENT_STATUSES } from "../../../../src/lib/shared/matchJob/contract";

const SQL = readFileSync(resolve(__dirname, "../../../../supabase/migrations/067_match_analyses.sql"), "utf8").replace(/\r\n/g, "\n");
/** Sin comentarios de línea: los comentarios hablan de INSERT/UPDATE a propósito. */
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const policies = [...CODE.matchAll(/CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)([\s\S]*?);/gi)].map((m) => ({ name: m[1], table: m[2], body: m[3] }));

function checkList(column: string): string[] {
  const m = new RegExp(`${column}[^\\n]*?CHECK \\(${column} IN \\(([\\s\\S]*?)\\)\\)`, "i").exec(CODE);
  if (!m) throw new Error(`no CHECK for ${column}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("migration 067 · RLS", () => {
  it("enables RLS on both tables", () => {
    expect(CODE).toMatch(/ALTER TABLE match_analyses ENABLE ROW LEVEL SECURITY/);
    expect(CODE).toMatch(/ALTER TABLE match_analysis_segments ENABLE ROW LEVEL SECURITY/);
  });
  // Fija el TEXTO histórico de 067 (ya aplicada). La rama por tenant la retira la 076
  // (match_analyses_select_owner_076, solo user_id): ver migration076 en src/test/migrations.
  it("has exactly one client policy: SELECT on match_analyses for the owner or the same tenant", () => {
    expect(policies).toHaveLength(1);
    const [p] = policies;
    expect(p.table).toBe("match_analyses");
    expect(p.body).toMatch(/FOR\s+SELECT/i);
    expect(p.body).toMatch(/user_id\s*=\s*auth\.uid\(\)/);
    expect(p.body).toMatch(/tenant_id\s*=\s*public\.tenant_id\(\)/);
    expect(p.body).not.toMatch(/WITH\s+CHECK/i);
  });
  it("no INSERT / UPDATE / DELETE / ALL policy anywhere, and no policy at all on segments", () => {
    for (const p of policies) expect(p.body).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(policies.filter((p) => p.table === "match_analysis_segments")).toEqual([]);
  });
  it("revokes client write privileges (defence in depth) and every privilege on segments", () => {
    expect(CODE).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON match_analyses FROM anon, authenticated/);
    expect(CODE).toMatch(/REVOKE ALL ON match_analysis_segments FROM anon, authenticated/);
    expect(CODE).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+(anon|authenticated)/i);
  });
  it("SECURITY DEFINER RPCs are executable only by service_role (EXECUTE revoked from PUBLIC, anon AND authenticated)", () => {
    const fns = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
    expect(fns).toEqual(["claim_next_match_segment", "add_match_spend", "match_active_reservations_usd"]);
    for (const fn of fns) {
      // Supabase's default privileges grant EXECUTE on every new public function to anon and
      // authenticated explicitly, so REVOKE ... FROM PUBLIC alone would leave /rest/v1/rpc/* open
      // (Supabase lints 0028/0029). Each client role must be named in the revoke.
      const revoke = new RegExp(`REVOKE (?:EXECUTE|ALL) ON FUNCTION ${fn}\\([^)]*\\) FROM ([^;]+);`).exec(CODE);
      expect(revoke, `missing REVOKE for ${fn}`).not.toBeNull();
      const roles = revoke![1].split(",").map((r) => r.trim().toLowerCase());
      expect(roles).toEqual(expect.arrayContaining(["public", "anon", "authenticated"]));
      expect(CODE).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO service_role;`));
      expect(CODE).not.toMatch(new RegExp(`GRANT (?:EXECUTE|ALL)[^;]*ON FUNCTION ${fn}\\([^)]*\\) TO [^;]*\\b(anon|authenticated|PUBLIC)\\b`, "i"));
    }
    expect((CODE.match(/SECURITY DEFINER/g) ?? []).length).toBe(3);
    expect((CODE.match(/SET search_path = public/g) ?? []).length).toBe(3);
  });
});

describe("migration 067 · integrity", () => {
  it("video FK cascades (retention purges never break, no orphan reports); segments cascade with the job", () => {
    expect(CODE).toMatch(/video_id\s+text NOT NULL REFERENCES videos\(id\) ON DELETE CASCADE/);
    expect(CODE).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    expect(CODE).toMatch(/match_analysis_id\s+uuid NOT NULL REFERENCES match_analyses\(id\) ON DELETE CASCADE/);
  });
  it("stores the coach attestation and the money columns", () => {
    for (const col of ["attested_by", "attested_at", "attestation_version", "dispatch_epoch", "reservation_usd", "spend_usd", "gemini_file_name", "gemini_file_display_name", "coverage", "observation", "report", "category", "locale", "org_id", "tenant_id"]) {
      expect(CODE).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
  });
  it("one ACTIVE job per user is enforced by a partial unique index", () => {
    expect(CODE).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS match_analyses_one_active_per_user\s+ON match_analyses\(user_id\)\s+WHERE status NOT IN \('completed','failed','cancelled'\)/);
  });
  it("the claim RPC is atomic (FOR UPDATE SKIP LOCKED + lease) and fenced by the current epoch", () => {
    expect(CODE).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(CODE).toMatch(/dispatch_epoch = p_epoch AND status = 'observing'/);
    expect(CODE).toMatch(/lease_until = now\(\) \+ make_interval\(secs => p_lease_sec\)/);
  });
  it("status CHECKs equal the contract enums (one definition, inv #7)", () => {
    expect(checkList("status").slice(0, MATCH_JOB_STATUSES.length).sort()).toEqual([...MATCH_JOB_STATUSES].sort());
    const segStatuses = /status\s+text NOT NULL DEFAULT 'pending' CHECK \(status IN \(([^)]*)\)\)/.exec(CODE);
    expect([...(segStatuses?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...SEGMENT_STATUSES].sort());
    expect(checkList("purpose")).toEqual(["match_ab", "team_baseline"]);
    expect(checkList("category")).toEqual(["youth", "senior"]);
  });
  it("does not touch any existing table", () => {
    expect(CODE).not.toMatch(/ALTER TABLE (?!match_analyses|match_analysis_segments)\w+/);
    expect(CODE).not.toMatch(/DROP TABLE/i);
  });
});
