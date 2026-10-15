/**
 * P1 bloque 5c — proyecciones del perfil de rol BLOQUEADAS (decisión del dueño, 15 oct).
 *
 * Antes: CapabilityCards pintaba filas 0-6m / 6-18m / 18-36m (= nivel actual + un % fijo:
 * +2/+5/+8 en el respaldo, «p18m + 3» a 36 meses con la salida del agente, regla fija del
 * prompt «current + 2-3 %», «× 2,5»), una «confianza» FIJA por dimensión (0,78/0,80/0,55)
 * con un margen «± n» derivado de esa constante; ProjectionComparator calculaba la «mejor
 * posición a 18 meses» con pesos fijos y un «insight» de texto fijo; y la página
 * /role-profile/compare comparaba esos horizontes. Ahora: solo el nivel actual con su
 * procedencia (Estimado por IA) y la proyección dice «sin base para proyectar».
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: "es" },
  }),
}));

import CapabilityCards from "@/components/role-profile/CapabilityCards";
import ProjectionGateCard from "@/components/role-profile/ProjectionGateCard";
import RoleProfileCompare from "@/pages/RoleProfileCompare";
import { RoleProfileOutputSchema } from "@/agents/contracts";
import type { RoleProfileData } from "@/lib/roleProfileData";
import capabilityCardsSrc from "@/components/role-profile/CapabilityCards.tsx?raw";
import hubPageSrc from "@/pages/PlayerHubPage.tsx?raw";
import roleProfilePageSrc from "@/pages/RoleProfile.tsx?raw";
import filterBarSrc from "@/components/role-profile/RoleProfileFilterBar.tsx?raw";
import roleProfileServiceSrc from "@/services/roleProfileService.ts?raw";
import demoAgentsSrc from "@/lib/demo/demoAgents.ts?raw";
import serverPromptSrc from "../../../api/agents/_role-profile.ts?raw";
import serverFallbackSrc from "../../../api/_lib/agentFallbacks.ts?raw";
import es from "@/i18n/es.json";
import esLA from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ["es", es], ["es-419", esLA], ["en", en], ["fr", fr], ["de", de], ["it", it_], ["nl", nl],
];
const get = (o: Record<string, unknown>, k: string): unknown =>
  k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as Record<string, unknown>)[p] : undefined), o);
/** Quita comentarios para no confundir la explicación con el código. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

const PROFILE = {
  run_id: "run_1", player_id: "p1", player_name: "Samu", player_age: 12,
  minutes_played: 300, sample_tier: "bronze", overall_confidence: 0.7,
  current: { tactical: 72.4, technical: 80, physical: 61.5 },
  identity: { dominant: "tecnico", distribution: { tecnico: 1, ofensivo: 0, defensivo: 0, fisico: 0, mixto: 0 }, explanation: "x" },
  positions: [{ code: "RCM", prob: 0.8, score: 80, confidence: 0.8, reason: "x" }],
  archetypes: [], strengths: [], risks: [], gaps: [], consolidation_notes: [], evidence: [],
} as unknown as RoleProfileData;

describe("CapabilityCards · solo el nivel actual, con su procedencia", () => {
  it("muestra el valor actual y «Estimado por IA»; ninguna fila de proyección ni margen ±", () => {
    const { container } = render(<CapabilityCards data={PROFILE} />);
    expect(screen.getByText("72.4")).toBeDefined();
    expect(screen.getByText("80.0")).toBeDefined();
    expect(screen.getAllByText("Estimado por IA")).toHaveLength(3);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/0[–-]6m|6[–-]18m|18[–-]36m/);
    expect(text).not.toContain("±");
    expect(text).not.toContain("capabilityCards.projectionTitle");
  });

  it("sin confianza fija por dimensión ni intervalo derivado de ella", () => {
    expect(code(capabilityCardsSrc)).not.toMatch(/0\.78|0\.80|0\.55|dimConfidence|MetricWithInterval|projections/);
  });
});

describe("proyección bloqueada con su motivo, nunca una cifra", () => {
  it("ProjectionGateCard dice «sin base para proyectar» y no pinta números", () => {
    const { container } = render(<ProjectionGateCard />);
    expect(screen.getByText("roleProjection.gateReason")).toBeDefined();
    expect(container.textContent ?? "").not.toMatch(/\d/);
  });

  it("el Hub y la página del perfil de rol usan la tarjeta bloqueada y no enlazan a /compare", () => {
    for (const src of [hubPageSrc, roleProfilePageSrc]) {
      expect(code(src)).toContain("<ProjectionGateCard />");
      expect(code(src)).not.toMatch(/ProjectionComparator|role-profile\/compare/);
    }
  });

  it("la barra de filtros ya no ofrece horizonte ni «Proyectado»", () => {
    expect(code(filterBarSrc)).not.toMatch(/horizon|showProjected/);
  });

  it("/players/:id/role-profile/compare redirige al perfil de rol (enlaces guardados)", () => {
    render(
      <MemoryRouter initialEntries={["/players/p1/role-profile/compare"]}>
        <Routes>
          <Route path="/players/:id/role-profile/compare" element={<RoleProfileCompare />} />
          <Route path="/players/:id/role-profile" element={<p>perfil de rol</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("perfil de rol")).toBeDefined();
  });
});

describe("origen: ni el agente, ni el respaldo del servidor, ni el demo proyectan", () => {
  it("el prompt del servidor ya no pide p6m/p18m y prohíbe proyectar", () => {
    expect(serverPromptSrc).not.toMatch(/p6m|p18m|× 2\.5/);
    expect(serverPromptSrc).toContain("NO proyectes capacidades a futuro");
  });

  it("el contrato del agente descarta p6m/p18m si el modelo aún los manda", () => {
    const parsed = RoleProfileOutputSchema.shape.capabilities.parse({
      tactical: { current: 70, p6m: 72, p18m: 75 },
      technical: { current: 71, p6m: 73, p18m: 76 },
      physical: { current: 60, p6m: 62, p18m: 65 },
    });
    expect(parsed.tactical).toEqual({ current: 70 });
  });

  it("ni el respaldo del servidor ni el demo ni el servicio fabrican proyecciones", () => {
    expect(code(serverFallbackSrc)).not.toMatch(/p6m|p18m|phvFactor/);
    expect(code(demoAgentsSrc)).not.toMatch(/p6m|p18m/);
    expect(code(roleProfileServiceSrc)).not.toMatch(/projections|p6m|p18m|buildMetricsOnlyProfile/);
  });
});

describe("textos (7 idiomas)", () => {
  it.each(LOCALES)("%s: motivo de la proyección presente; sin textos de proyección ni margen ±", (_l, j) => {
    expect(typeof get(j, "roleProjection.title")).toBe("string");
    expect(typeof get(j, "roleProjection.gateReason")).toBe("string");
    for (const gone of ["projectionComparator", "roleProfileCompare", "metricWithInterval", "capabilityCards.projectionTitle", "roleProfileFilterBar.horizon"]) {
      expect(get(j, gone), gone).toBeUndefined();
    }
    const legend = String(get(j, "capabilityCards.legend"));
    expect(legend).not.toMatch(/±|0[–-]6|18[–-]36/);
  });

  // Revisión del #319: la guía y el subtítulo aún anunciaban la proyección.
  it.each(LOCALES)("%s: la guía ya no promete «estimación a 6 y 18 meses»; subtítulo sin «Proyección»", (_l, j) => {
    const list = JSON.stringify(get(j, "userGuide.roleProfile.list"));
    expect(list).not.toMatch(/\b6\b.{0,12}\b18\b/);
    expect(String(get(j, "roleProfile.subtitle"))).not.toMatch(/Proyecci|Projecti|Prognose|Proiezion|projectie/i);
    expect(typeof get(j, "playerHubPage.roleProfileUnavailable")).toBe("string");
  });
});

describe("Hub · sin perfil de rol se dice por qué (revisión del #319)", () => {
  it("«Generando…» solo mientras carga; si el perfil se abstiene o falla, el motivo", () => {
    const src = code(hubPageSrc);
    expect(src).toMatch(/roleLoading \? \(/);
    expect(src).toContain('t("playerHubPage.roleProfileUnavailable")');
  });
});
