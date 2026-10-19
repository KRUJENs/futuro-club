/**
 * P1 bloque 7b · D3 — lector único de vsi_history_reviews: pendientes ⇒ no evaluados.
 * Error de lectura ⇒ lanza (nunca «nadie pendiente»); tabla inexistente ⇒ nadie marcado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingVsiReviewIds, pendingVsiReviewIdsRest } from "../_lib/vsiPendingReview";

function client(result: { data: unknown; error: unknown }) {
  const filters: Array<[string, unknown]> = [];
  const b = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return Promise.resolve(result);
    },
  };
  return { supabase: { from: () => b }, filters };
}

afterEach(() => vi.restoreAllMocks());

describe("pendingVsiReviewIds", () => {
  it("solo filas pending, ids de texto", async () => {
    const { supabase, filters } = client({ data: [{ player_id: "a" }, { player_id: null }, { player_id: "b" }], error: null });
    expect([...(await pendingVsiReviewIds(supabase))]).toEqual(["a", "b"]);
    expect(filters).toEqual([["status", "pending"]]);
  });
  it("tabla inexistente (base sin la 070) ⇒ nadie marcado", async () => {
    const { supabase } = client({ data: null, error: { code: "PGRST205", message: "not found" } });
    expect((await pendingVsiReviewIds(supabase)).size).toBe(0);
  });
  it("cualquier otro error ⇒ lanza", async () => {
    const { supabase } = client({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(pendingVsiReviewIds(supabase)).rejects.toThrow(/timeout/);
  });
});

describe("pendingVsiReviewIdsRest", () => {
  it("lee status=eq.pending y devuelve los ids", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{ player_id: "p1" }])));
    expect([...(await pendingVsiReviewIdsRest("https://x.supabase.co", {}))]).toEqual(["p1"]);
    expect(String(spy.mock.calls[0][0])).toContain("/rest/v1/vsi_history_reviews?status=eq.pending");
  });
  it("tabla inexistente ⇒ vacío; 500 ⇒ lanza", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 }));
    expect((await pendingVsiReviewIdsRest("https://x.supabase.co", {})).size).toBe(0);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(pendingVsiReviewIdsRest("https://x.supabase.co", {})).rejects.toThrow(/HTTP 500/);
  });
});
