/**
 * P1 bloque 5c — panel del entrenador (/coach) OCULTO hasta P2 (decisión del dueño, 15 oct).
 *
 * Antes: las 4 pestañas pintaban datos de ejemplo sin banner — segmentos, balance y
 * participación con Math.random, «278 AU», «68 %», series de progresión aleatorias,
 * tarjetas fijas «72 / 285 / 61 / 8», un informe para padres de «Lucas García» inventado
 * y un plan semanal fijo; el informe IA recibía `{ mock: true }` como análisis de sesión.
 * Ahora el panel solo explica que se conectará con las sesiones reales.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock parcial: el resto del módulo (initReactI18next…) sigue disponible para cualquier
// import transitivo; solo `t` devuelve la clave.
vi.mock("react-i18next", async (orig) => ({
  ...(await orig<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "es" },
  }),
}));

import CoachDashboard from "@/components/coaching/CoachDashboard";
import coachDashboardSrc from "@/components/coaching/CoachDashboard.tsx?raw";
import pushSrc from "@/services/real/pushNotificationService.ts?raw";
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
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("panel del entrenador · oculto hasta conectarlo con sesiones reales", () => {
  it("solo muestra el aviso «se conectará con tus sesiones reales», sin ninguna cifra", () => {
    const { container } = render(<CoachDashboard teamId="t1" teamName="Equipo" />);
    expect(screen.getByTestId("coach-panel-not-connected")).toBeDefined();
    expect(screen.getByText("coachDash.notConnected.title")).toBeDefined();
    expect(screen.getByText("coachDash.notConnected.desc")).toBeDefined();
    expect(container.textContent ?? "").not.toMatch(/\d/);
  });

  it("no genera datos (sin Math.random, sin pestañas ni componentes de ejemplo)", () => {
    const src = code(coachDashboardSrc);
    expect(src).not.toMatch(/Math\.random|Tabs|SessionTimelineView|SessionBalanceChart|ParticipationHeatmap|ParentReportView|NextSessionRecommender|WeekPlannerView|CoachingReportView|mock/);
  });

  it("los componentes de ejemplo ya no existen", () => {
    const files = Object.keys(import.meta.glob("@/components/{coaching,analysis/reports}/*.tsx"));
    for (const gone of ["SessionTimelineView", "SessionBalanceChart", "ParticipationHeatmap", "ParentReportView", "NextSessionRecommender", "WeekPlannerView", "CoachingReportView"]) {
      expect(files.some((f) => f.endsWith(`/${gone}.tsx`)), gone).toBe(false);
    }
  });

  it("ningún aviso push lleva a la pestaña «Sesión» del panel oculto", () => {
    expect(code(pushSrc)).not.toMatch(/notifySessionAnalysisReady|\/coach\?tab=sesion/);
  });

  it.each(LOCALES)("%s: textos del aviso presentes", (_l, j) => {
    expect(typeof get(j, "coachDash.notConnected.title")).toBe("string");
    expect(typeof get(j, "coachDash.notConnected.desc")).toBe("string");
  });
});
