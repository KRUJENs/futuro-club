/**
 * PeerBenchmark (comparación con los propios jugadores) — nunca un «P0» fabricado
 * (P1 bloque 5). Lo ven las familias en ParentDashboardPage.
 *
 * Antes: /api/benchmark/peer contaba como 0 el valor ausente del jugador y el componente
 * pintaba «P0» en grande; además rotulaba la comparación como «cross-club»/«red VITAS».
 * Ahora: sin percentil se muestra el MOTIVO (sin evaluar / menos de 10 pares).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));
vi.mock("@/lib/apiAuth", () => ({ getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer t" })) }));

import PeerBenchmark from "@/components/PeerBenchmark";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const gatedMetric = (code: string, peers: number) => ({
  player: null,
  percentile: { value: null, provenance: "DERIVADA", confidence: 0, units: null, calibrated: false, gate_reason: "x" },
  gate: { code, peers, min: 10 },
  distribution: null,
});

function respond(data: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: true, data }), { status: 200 }),
  );
}

const STRATUM = { position: "RW", ageMin: 10, ageMax: 12, phvCategory: null };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("PeerBenchmark · percentil bloqueado con motivo", () => {
  it("jugador sin evaluar ⇒ el motivo «sin evaluación», nunca «P0»", async () => {
    respond({ stratum: STRATUM, minPeers: 10, vsi: gatedMetric("not_evaluated", 12), byMetric: {} });
    render(<PeerBenchmark playerId="leo" />);
    await waitFor(() => expect(screen.getByText(/percentile\.gate\.not_evaluated/)).toBeDefined());
    expect(screen.queryByText(/^P\d+$/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/cross-club|crossClub|\bred VITAS\b/i);
  });

  it("menos de 10 pares ⇒ «faltan jugadores evaluados comparables (N de 10)»", async () => {
    respond({ stratum: STRATUM, minPeers: 10, vsi: gatedMetric("insufficient_peers", 3), byMetric: {} });
    render(<PeerBenchmark playerId="leo" />);
    await waitFor(() => expect(screen.getByText(/percentile\.gate\.insufficient_peers/)).toBeDefined());
    expect(screen.getByText(/"count":3/)).toBeDefined();
    expect(screen.queryByText(/^P\d+$/)).toBeNull();
  });

  it("con percentil real ⇒ «P{n}» y las barras sin percentil dicen su motivo", async () => {
    respond({
      stratum: STRATUM,
      minPeers: 10,
      vsi: {
        player: 61.4,
        percentile: { value: 80, provenance: "DERIVADA", confidence: 0.4, units: null, calibrated: false, gate_reason: null },
        gate: null,
        distribution: { mean: 55, p25: 52, p50: 55, p75: 57, p90: 59 },
      },
      byMetric: { defending: gatedMetric("not_evaluated", 10) },
    });
    render(<PeerBenchmark playerId="leo" />);
    await waitFor(() => expect(screen.getByText("P80")).toBeDefined());
    expect(screen.getByText("peerBenchmark.title")).toBeDefined();
    expect(screen.getByText(/percentile\.gate\.not_evaluated/)).toBeDefined();
  });
});

// Decisión del dueño (14 oct 2026): solo los jugadores propios hasta que exista el acceso
// de clubes. Ningún texto (app ni landing) puede prometer una comparación entre clubes.
describe("textos · sin «benchmark entre clubes»", () => {
  it.each([["es", es], ["es-419", esLA], ["en", en], ["fr", fr], ["de", de], ["it", it_], ["nl", nl]])(
    "%s no promete cross-club ni «red VITAS»",
    (_l, j) => {
      // \b: sin él, «red VITAS» con /i casaba dentro de «Powered VITAS», «monitored VITAS»…
      expect(JSON.stringify(j)).not.toMatch(/cross[- ]club|\bred VITAS\b|VITAS network|réseau VITAS|VITAS-Netzwerk|rete VITAS|VITAS-netwerk/i);
    },
  );
});
