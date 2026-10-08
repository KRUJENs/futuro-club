/**
 * Presupuesto con reserva (budgetGuard, fail-open documentado) y borrado RGPD de jobs de
 * partido (retention.ts): el fichero en Gemini se borra ANTES que las filas (la cascada
 * de la FK no lo alcanza) y un fallo nunca rompe el borrado del resto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeReservationsUsd,
  recordSpendAmountUsd,
  wouldExceedBudget,
  wouldExceedBudgetAmount,
} from "../../budgetGuard";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc", GLOBAL_MONTHLY_BUDGET_USD: "20" };
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of [...Object.keys(ENV), "GEMINI_API_KEY"]) delete process.env[k];
});

describe("budget reservation", () => {
  it("pure core: spent + reserved + extra ≥ budget; budget ≤ 0 disables the tripwire", () => {
    expect(wouldExceedBudgetAmount(19, 0.5, 0.4, 20)).toBe(false);
    expect(wouldExceedBudgetAmount(19, 0.5, 0.5, 20)).toBe(true);
    expect(wouldExceedBudgetAmount(100, 100, 100, 0)).toBe(false);
    expect(wouldExceedBudgetAmount(100, 100, 100, Number.NaN)).toBe(false);
  });
  it("reads the month spend and the active reservations (excluding the caller's own job)", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/rpc/get_ai_spend_month")) return new Response("18.5");
      if (url.endsWith("/rpc/match_active_reservations_usd")) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_exclude_job: "job-1" });
        return new Response("1.2");
      }
      throw new Error(url);
    });
    vi.stubGlobal("fetch", f);
    const r = await wouldExceedBudget(0.4, { excludeJobId: "job-1" });
    expect(r).toEqual({ exceeded: true, spentUsd: 18.5, reservedUsd: 1.2, extraUsd: 0.4, budgetUsd: 20 });
  });
  it("FAIL-OPEN: ledger / reservations unreadable → count 0 and do not block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    expect(await activeReservationsUsd()).toBe(0);
    expect((await wouldExceedBudget(5)).exceeded).toBe(false);
  });
  it("records REAL amounts per service; non-positive amounts are ignored", async () => {
    const f = vi.fn(async () => new Response("null"));
    vi.stubGlobal("fetch", f);
    await recordSpendAmountUsd("gemini", 0.0421);
    await recordSpendAmountUsd("claude", 0);
    await recordSpendAmountUsd("modal", Number.NaN);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sb.test/rest/v1/rpc/record_ai_spend");
    expect(JSON.parse(String(init.body))).toEqual({ p_service: "gemini", p_amount: 0.0421 });
  });
});

describe("RGPD purge of match jobs", () => {
  it("deletes each job's Gemini file before deleting the rows; keeps going when one delete fails", async () => {
    process.env.GEMINI_API_KEY = "gk";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(`${method} ${url}`);
        if (url.startsWith("https://sb.test/rest/v1/match_analyses?user_id=eq.") && method === "GET") {
          return new Response(
            JSON.stringify([
              { id: "a", user_id: "u", gemini_file_name: "files/one", gemini_file_deleted_at: null, spend_usd: 0, reservation_usd: 0, estimate_usd: 0 },
              { id: "b", user_id: "u", gemini_file_name: "files/two", gemini_file_deleted_at: null, spend_usd: 0, reservation_usd: 0, estimate_usd: 0 },
              { id: "c", user_id: "u", gemini_file_name: null, gemini_file_deleted_at: null, spend_usd: 0, reservation_usd: 0, estimate_usd: 0 },
            ]),
          );
        }
        if (url.includes("generativelanguage.googleapis.com/v1beta/files/one")) return new Response("{}");
        if (url.includes("generativelanguage.googleapis.com/v1beta/files/two")) return new Response("boom", { status: 500 });
        if (url.startsWith("https://sb.test/rest/v1/match_analyses?id=eq.") && method === "PATCH") return new Response("[]");
        if (url.startsWith("https://sb.test/rest/v1/match_analyses?id=in.") && method === "DELETE") return new Response(JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]));
        throw new Error(`unexpected ${method} ${url}`);
      }),
    );
    const { purgeMatchAnalysesForOwner } = await import("../retention");
    const r = await purgeMatchAnalysesForOwner("11111111-1111-4111-8111-111111111111");
    expect(r).toEqual({ match_analyses_deleted: 3, gemini_files_deleted: 1, gemini_delete_errors: 1 });
    const firstRowDelete = calls.findIndex((c) => c.startsWith("DELETE https://sb.test"));
    const lastGeminiDelete = Math.max(...calls.map((c, i) => (c.includes("generativelanguage") ? i : -1)));
    expect(lastGeminiDelete).toBeLessThan(firstRowDelete);
    // 076: solo los jobs que CREÓ el usuario; nunca por tenant.
    expect(calls.some((c) => c.includes("match_analyses?user_id=eq.11111111-1111-4111-8111-111111111111"))).toBe(true);
    expect(calls.some((c) => c.includes("tenant_id"))).toBe(false);
  });
  it("without Supabase configured it is a no-op (never throws into the account deletion)", async () => {
    delete process.env.SUPABASE_URL;
    const { purgeMatchAnalysesForOwner, purgeMatchAnalysesForVideos } = await import("../retention");
    expect(await purgeMatchAnalysesForOwner("u")).toEqual({ match_analyses_deleted: 0, gemini_files_deleted: 0, gemini_delete_errors: 0 });
    expect(await purgeMatchAnalysesForVideos(["v1"])).toEqual({ match_analyses_deleted: 0, gemini_files_deleted: 0, gemini_delete_errors: 0 });
  });
});
