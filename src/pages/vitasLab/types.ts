// Tipos del VitasLab extraídos del componente monolítico (paso 1 del split).
// Código puro, sin dependencias de runtime — mover aquí no cambia comportamiento.

export interface CalibrationPoint {
  id: number;
  x: number;
  y: number;
  label: string;
}

// ─── Report types ─────────────────────────────────────────────────────────────

export interface Dimension {
  score: number;
  observacion: string;
}

export interface AnalysisReport {
  estadoActual: {
    resumenEjecutivo: string;           // "" ⇒ el agente no dio resumen (no se pinta)
    nivelActual: string | null;         // null ⇒ sin nivel del agente (nunca «talent» por defecto)
    fortalezasPrimarias: string[];
    areasDesarrollo: string[];
    dimensiones: {
      velocidadDecision:   Dimension;
      tecnicaConBalon:     Dimension;
      inteligenciaTactica: Dimension;
      capacidadFisica:     Dimension;
      liderazgoPresencia:  Dimension;
      eficaciaCompetitiva: Dimension;
    };
    // false ⇒ los `score` de arriba NO son medidos ni estimados reales (el pipeline de
    // vídeo no puntúa técnica/táctica/mental por dimensión; el mapeo usaba una CONSTANTE
    // rotulada "Estimado por IA"). Los consumidores NO deben mostrar ni derivar de esos
    // números cuando es false. Ver .claude/rules/metricas.md (inv #1/#2).
    dimensionesMedidas: boolean;
    ajusteVSIVideoScore: number | null; // null ⇒ VSI-vídeo bloqueado (no se pinta badge, #40)
  };
  adnFutbolistico: {
    estiloJuego:     string;
    arquetipoTactico: string;
    patrones: Array<{ patron: string; frecuencia: string; descripcion: string }>;
    mentalidad: string;
  };
  jugadorReferencia: {
    bestMatch: {
      nombre:   string;
      posicion: string;
      club:     string;
      score:    number;
      narrativa: string;
    } | null; // null ⇒ el narrador no produjo comparable (nunca uno inventado)
  };
  proyeccionCarrera: {
    escenarioOptimista: { descripcion: string; nivelProyecto: string };
    escenarioRealista:  { descripcion: string; nivelProyecto: string };
    factoresClave:      string[];
    riesgos:            string[];
  } | null; // null ⇒ sin datos reales de proyección (no se fabrica "Semi-pro", #40 clase)
  planDesarrollo: {
    objetivo6meses:  string;
    objetivo18meses: string;
    pilaresTrabajo:  Array<{ pilar: string; acciones: string[]; prioridad: string }>;
  };
  metricasCuantitativas?: {
    fisicas?: {
      velocidadMaxKmh:  number;
      velocidadPromKmh: number;
      distanciaM:       number;
      sprints:          number;
      zonasIntensidad:  { caminar: number; trotar: number; correr: number; sprint: number };
    };
    eventos?: {
      pasesCompletados: number;
      pasesFallados:    number;
      precisionPases:   number;
      recuperaciones:   number;
      disparosAlArco:   number;
      disparosFuera:    number;
    };
    fuente:     string;
    confianza:  number;
    heatmapPositions?: Array<{ fx: number; fy: number }>;
  };
  confianza: number | null; // null ⇒ VSI-vídeo bloqueado (no se pinta badge de confianza, #40 clase)
}
