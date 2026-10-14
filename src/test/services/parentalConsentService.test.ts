/**
 * fetchConsentStatus (P1 bloque 3, revisión del PR #314):
 *   - un jugador que el servidor no devuelve queda «unavailable» (antes: spinner eterno);
 *   - con más de 50 jugadores se pide por tandas de 50 (el máximo del servidor). Antes se cortaba
 *     en 50 y el resto quedaba «unavailable» para siempre en /admin/consent;
 *   - si una tanda falla, solo esa queda «unavailable» (nunca «verificado»).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apiAuth", () => ({
  getAuthHeaders: vi.fn(async () => ({ "Content-Type": "application/json", Authorization: "Bearer t" })),
}));

import { fetchConsentStatus } from "@/services/real/parentalConsentService";

let fetchMock: ReturnType<typeof vi.fn>;
let failBatchWith: string | null;

beforeEach(() => {
  failBatchWith = null;
  // El servidor devuelve «pending» para cada id pedido, salvo los que empiezan por «gone».
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { playerIds } = JSON.parse(String(init?.body)) as { playerIds: string[] };
    if (playerIds.length > 50) return Response.json({ success: false }, { status: 400 });
    if (failBatchWith && playerIds.includes(failBatchWith)) return Response.json({ success: false }, { status: 500 });
    const statuses = Object.fromEntries(playerIds.filter((id) => !id.startsWith("gone")).map((id) => [id, { state: "pending" }]));
    return Response.json({ success: true, data: { statuses } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe("fetchConsentStatus", () => {
  it("un jugador que el servidor no devuelve queda «unavailable»; vacíos y repetidos no se piden", async () => {
    const out = await fetchConsentStatus(["p1", "gone1", "p1", ""]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ playerIds: ["p1", "gone1"] });
    expect(out).toEqual({ p1: { state: "pending" }, gone1: { state: "unavailable" } });
  });

  it("sin jugadores no llama al servidor", async () => {
    expect(await fetchConsentStatus([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("más de 50 jugadores → tandas de 50; todos con su estado real", async () => {
    const out = await fetchConsentStatus(ids(120));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((c) => (JSON.parse(String((c as [string, RequestInit])[1].body)) as { playerIds: string[] }).playerIds.length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(Object.keys(out)).toHaveLength(120);
    expect(Object.values(out).every((s) => s.state === "pending")).toBe(true);
  });

  it("si una tanda falla, SOLO esa queda «unavailable» (nunca «verificado»)", async () => {
    failBatchWith = "p60";
    const out = await fetchConsentStatus(ids(120));
    expect(out.p0).toEqual({ state: "pending" });
    expect(out.p49).toEqual({ state: "pending" });
    expect(out.p50).toEqual({ state: "unavailable" });
    expect(out.p99).toEqual({ state: "unavailable" });
    expect(out.p100).toEqual({ state: "pending" });
  });
});
