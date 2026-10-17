/**
 * MatchStatsPanel — Tests
 * Verifica renderizado con diferentes combinaciones de datos.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import MatchStatsPanel from "@/components/MatchStatsPanel";
import type { VideoIntelligenceOutput } from "@/agents/contracts";

// Mock framer-motion para evitar animaciones en tests
vi.mock("framer-motion", () => {
  const motion = new Proxy({}, {
    get: (_t, prop: string) => {
      return ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
        const Tag = prop as keyof JSX.IntrinsicElements;
        return <Tag {...(props as Record<string, unknown>)}>{children}</Tag>;
      };
    },
  });
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

// MatchStatsPanel migró a react-i18next: ahora todos los textos de UI se
// resuelven vía t("matchStatsPanel.*"). Mockeamos react-i18next con un t()
// que devuelve la clave (y anexa los valores de interpolación) — mismo patrón
// que src/test/components/VideoUpload.test.tsx. Así las aserciones verifican
// que el componente cablea la clave i18n correcta para cada dato, de forma
// determinista y sin depender de las traducciones. Los ratings cualitativos
// ("Bueno", "Competitivo", …) NO usan i18n: vienen de constantes del servicio.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(" ")}` : key,
    i18n: { language: "es", changeLanguage: vi.fn() },
  }),
}));

type MC = NonNullable<VideoIntelligenceOutput["metricasCuantitativas"]>;

const eventosData: MC = {
  eventos: {
    pasesCompletados: 40,
    pasesFallados: 10,
    precisionPases: 80,
    recuperaciones: 5,
    disparosAlArco: 3,
    disparosFuera: 2,
  },
  fuente: "gemini_only",
  confianza: 0.7,
};

const fisicasData: MC = {
  fisicas: {
    velocidadMaxKmh: 28.5,
    velocidadPromKmh: 9.2,
    distanciaM: 4250,
    sprints: 12,
    zonasIntensidad: { caminar: 1800, trotar: 1200, correr: 950, sprint: 300 },
  },
  fuente: "yolo_only",
  confianza: 0.6,
};

const fullData: MC = {
  ...eventosData,
  ...fisicasData,
  fuente: "yolo+gemini",
  confianza: 0.85,
};

describe("MatchStatsPanel", () => {
  describe("con solo eventos", () => {
    it("renderiza título principal", () => {
      render(<MatchStatsPanel data={eventosData} />);
      // El título por defecto ahora es la clave i18n matchStatsPanel.title
      expect(screen.getByText("matchStatsPanel.title")).toBeInTheDocument();
    });

    it("muestra rating compuesto", () => {
      render(<MatchStatsPanel data={eventosData} />);
      // Rating tendrá un número entre 0 y 10 con un decimal
      const ratings = screen.getAllByText(/^\d+\.\d$/);
      expect(ratings.length).toBeGreaterThan(0);
    });

    it("muestra KPI Pases con precisión", () => {
      render(<MatchStatsPanel data={eventosData} />);
      // Título vía clave i18n; el valor de precisión (80%) sigue siendo texto crudo
      expect(screen.getByText("matchStatsPanel.passes")).toBeInTheDocument();
      expect(screen.getByText("80%")).toBeInTheDocument();
    });

    it("Duelos: hueco con su motivo, sin cifra, aunque un informe antiguo traiga duelos (P1 bloque 6)", () => {
      const legacy = { ...eventosData, eventos: { ...eventosData.eventos!, duelosGanados: 6, duelosPerdidos: 4 } } as MC;
      render(<MatchStatsPanel data={legacy} />);
      const card = screen.getByTestId("duels-gated");
      expect(within(card).getByText("matchStatsPanel.duels")).toBeInTheDocument();
      expect(within(card).getByText("duelsGate.value")).toBeInTheDocument();
      expect(within(card).getByText("duelsGate.reason")).toBeInTheDocument();
      expect(card.textContent).not.toMatch(/\d/);
    });

    it("muestra recuperaciones", () => {
      render(<MatchStatsPanel data={eventosData} />);
      expect(screen.getByText("matchStatsPanel.recoveries")).toBeInTheDocument();
      expect(screen.getByText("matchStatsPanel.recoveriesSub")).toBeInTheDocument();
    });

    it("muestra disparos con sub-label al arco/fuera", () => {
      render(<MatchStatsPanel data={eventosData} />);
      // El sub-label interpola alArco=3 y fuera=2 en la clave shotsSub
      expect(screen.getByText("matchStatsPanel.shots")).toBeInTheDocument();
      expect(screen.getByText("matchStatsPanel.shotsSub 3 2")).toBeInTheDocument();
    });

    it("no muestra sección físicas", () => {
      render(<MatchStatsPanel data={eventosData} />);
      expect(screen.queryByText("matchStatsPanel.physicalPerformance")).not.toBeInTheDocument();
    });

    it("muestra totales agregados", () => {
      render(<MatchStatsPanel data={eventosData} />);
      expect(screen.getByText("matchStatsPanel.offensive")).toBeInTheDocument();
      expect(screen.getByText("matchStatsPanel.defensive")).toBeInTheDocument();
    });

    it("muestra fuente correcta", () => {
      render(<MatchStatsPanel data={eventosData} />);
      // fuente "gemini_only" → clave sourceGeminiOnly (dentro de un <p> con más texto)
      expect(screen.getByText(/matchStatsPanel\.sourceGeminiOnly/)).toBeInTheDocument();
    });
  });

  describe("con solo físicas", () => {
    it("muestra sección rendimiento físico", () => {
      render(<MatchStatsPanel data={fisicasData} />);
      expect(screen.getByText("matchStatsPanel.physicalPerformance")).toBeInTheDocument();
    });

    it("muestra velocidad máxima", () => {
      render(<MatchStatsPanel data={fisicasData} />);
      // Etiqueta vía clave i18n; el valor 28.5 km/h sigue siendo texto crudo
      expect(screen.getByText("matchStatsPanel.maxSpeed")).toBeInTheDocument();
      expect(screen.getByText("28.5")).toBeInTheDocument();
    });

    it("muestra zonas de intensidad", () => {
      render(<MatchStatsPanel data={fisicasData} />);
      expect(screen.getByText("matchStatsPanel.intensityZones")).toBeInTheDocument();
    });

    it("no muestra KPIs de eventos", () => {
      render(<MatchStatsPanel data={fisicasData} />);
      // No debe haber card comparativa de pases (busca el "80%" que solo existe en eventos)
      expect(screen.queryByText("80%")).not.toBeInTheDocument();
    });

    it("muestra fuente correcta", () => {
      render(<MatchStatsPanel data={fisicasData} />);
      // fuente "yolo_only" → clave sourceYoloOnly (dentro de un <p> con más texto)
      expect(screen.getByText(/matchStatsPanel\.sourceYoloOnly/)).toBeInTheDocument();
    });
  });

  describe("con ambas secciones (full)", () => {
    it("muestra eventos Y físicas", () => {
      render(<MatchStatsPanel data={fullData} />);
      expect(screen.getByText("matchStatsPanel.passes")).toBeInTheDocument();
      expect(screen.getByText("matchStatsPanel.physicalPerformance")).toBeInTheDocument();
    });

    it("fuente es Tracking + IA", () => {
      render(<MatchStatsPanel data={fullData} />);
      // fuente "yolo+gemini" → clave sourceYoloGemini (dentro de un <p> con más texto)
      expect(screen.getByText(/matchStatsPanel\.sourceYoloGemini/)).toBeInTheDocument();
    });
  });

  describe("título custom", () => {
    it("acepta prop title", () => {
      render(<MatchStatsPanel data={eventosData} title="Mi Partido" />);
      expect(screen.getByText(/mi partido/i)).toBeInTheDocument();
    });
  });

  describe("sin datos válidos", () => {
    it("no renderiza nada si metricas es null/undefined via computeMatchStats", () => {
      // @ts-expect-error — testing null case
      const { container } = render(<MatchStatsPanel data={null} />);
      expect(container.firstChild).toBeNull();
    });
  });
});
