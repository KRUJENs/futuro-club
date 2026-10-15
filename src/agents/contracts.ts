/**
 * VITAS Agent Contracts
 * Cada agente tiene un contrato estricto: input tipado → output tipado.
 * Claude SIEMPRE responde JSON válido según el contrato.
 */

import { z } from "zod";
import { localeSchema } from "../lib/shared/locale";

// ─────────────────────────────────────────
// CONTRATO 1: PHV Calculator Agent
// Calcula maduración biológica usando fórmula Mirwald
// ─────────────────────────────────────────
export const PHVInputSchema = z.object({
  playerId: z.string(),
  chronologicalAge: z.number().min(8).max(21),
  height: z.number().min(100).max(220),       // cm
  weight: z.number().min(20).max(120),         // kg
  sittingHeight: z.number().optional(),        // cm (si disponible)
  legLength: z.number().optional(),            // cm
  // Sexo SIN default: sexo-específico (invariante #5). Ausente ⇒ el consumidor
  // debe bloquear, no asumir masculino.
  gender: z.enum(["M", "F"]).optional(),
  // Fecha de nacimiento del JUGADOR (ISO): fuente de la edad DECIMAL de Mirwald
  // (regla del owner 28-sep). Sin ella el endpoint bloquea (422).
  birthDate: z.string().optional(),
  // VSI real del jugador: sin él no hay «VSI ajustado» (antes: base fija 70).
  currentVSI: z.number().min(0).max(100).optional(),
});

export const PHVOutputSchema = z.object({
  playerId: z.string(),
  chronologicalAge: z.number(),
  // Mirwald maturity offset (años respecto al PHV). La magnitud válida derivada
  // es ageAtPHV = chronologicalAge − offset (motor en src/lib/phv/maturity.ts).
  offset: z.number(),
  category: z.enum(["early", "ontme", "late"]),
  phvStatus: z.enum(["pre_phv", "during_phv", "post_phv"]),
  developmentWindow: z.enum(["critical", "active", "stable"]),
  // VSI corregido con el factor CANÓNICO (maturity.ts). null sin VSI real del
  // jugador (antes se inventaba desde una base fija 70).
  adjustedVSI: z.number().min(0).max(100).nullable(),
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
});

export type PHVInput = z.infer<typeof PHVInputSchema>;
export type PHVOutput = z.infer<typeof PHVOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 2: Scout Insight Agent
// Genera insights en español para ScoutFeed
// ─────────────────────────────────────────
export const ScoutInsightInputSchema = z.object({
  player: z.object({
    id: z.string(),
    name: z.string(),
    age: z.number(),
    position: z.string(),
    vsi: z.number(),
    vsiTrend: z.enum(["up", "down", "stable"]),
    phvCategory: z.enum(["early", "ontme", "late"]),
    recentMetrics: z.object({
      speed: z.number(),
      technique: z.number(),
      vision: z.number(),
      stamina: z.number(),
      shooting: z.number(),
      defending: z.number(),
    }),
    lastDrills: z.array(z.string()).optional(),
  }),
  context: z.enum(["breakout", "comparison", "phv_alert", "drill_record", "regression", "milestone", "general", "wellbeing_alert"]),
  // Idioma de redacción de la prosa (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
});

export const ScoutInsightOutputSchema = z.object({
  playerId: z.string(),
  type: z.enum(["breakout", "comparison", "phv_alert", "drill_record", "regression", "milestone", "general", "wellbeing_alert"]),
  headline: z.string().max(80),
  body: z.string().max(400),
  metric: z.string(),
  metricValue: z.string(),
  urgency: z.enum(["high", "medium", "low"]),
  tags: z.array(z.string()).max(4),
  timestamp: z.string(),
  recommendedDrills: z.array(z.object({
    name: z.string(),
    reason: z.string(),
  })).max(3).optional(),
  actionItems: z.array(z.string()).max(3).optional(),
  benchmark: z.string().optional(),
});

export type ScoutInsightInput = z.infer<typeof ScoutInsightInputSchema>;
export type ScoutInsightOutput = z.infer<typeof ScoutInsightOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 3: Role Profile Agent
// Construye perfil de rol táctico completo
// ─────────────────────────────────────────
export const RoleProfileInputSchema = z.object({
  player: z.object({
    id: z.string(),
    name: z.string(),
    age: z.number(),
    foot: z.enum(["right", "left", "both"]).optional(), // sin pie registrado ⇒ se omite
    position: z.string(),
    secondaryPositions: z.array(z.string()).optional(),         // multi-posición
    minutesPlayed: z.number(),
    competitiveLevel: z.string().optional(), // sin nivel registrado ⇒ se omite
    // Solo las 6 métricas del entrenador. pressing/positioning se quitaron del contrato
    // (P1 bloque 2): nadie los mide y se rellenaban con stamina/vision.
    metrics: z.object({
      speed: z.number().min(0).max(100),
      technique: z.number().min(0).max(100),
      vision: z.number().min(0).max(100),
      stamina: z.number().min(0).max(100),
      shooting: z.number().min(0).max(100),
      defending: z.number().min(0).max(100),
    }),
    // Solo con PHV gateado (src/lib/phv/phvGate.ts): ausentes ⇒ PHV no disponible.
    // Nunca un «ontme»/0 por defecto (invariante #2).
    phvCategory: z.enum(["early", "ontme", "late"]).optional(),
    phvOffset: z.number().optional(),
    videoAnalysisSummary: z.unknown().optional(),               // estructura libre · datos del video
  }).passthrough(),
  videoContext: z.object({                                       // contexto del video específico
    playedPosition: z.string().optional(),
    videoId:        z.string().nullable().optional(),
    analyzedAt:     z.string().nullable().optional(),
  }).optional(),
  // Idioma de redacción de la prosa (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
}).passthrough();

export const RoleProfileOutputSchema = z.object({
  playerId: z.string().optional(),
  dominantIdentity: z.enum(["ofensivo", "defensivo", "tecnico", "fisico", "mixto"]),
  identityDistribution: z.object({
    ofensivo: z.number(),
    defensivo: z.number(),
    tecnico: z.number(),
    fisico: z.number(),
    mixto: z.number(),
  }),
  topPositions: z.array(z.object({
    code: z.string(),
    fit: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
  })).max(5),
  /** Alternativas de posición con info de polivalencia · jugadores polivalentes */
  positionAlternatives: z.array(z.object({
    code: z.string(),
    fit: z.number().min(0).max(100),
    alreadyDeclared: z.boolean(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
  })).optional(),
  topArchetypes: z.array(z.object({
    code: z.string(),
    fit: z.number().min(0).max(100),
    stability: z.enum(["emergente", "en_desarrollo", "estable", "consolidado"]),
  })).max(5),
  // Solo el nivel ACTUAL estimado. Sin p6m/p18m (P1 bloque 5c): eran una regla fija del
  // prompt («current + 2-3 %», «× 2,5»), no una proyección con base; bloqueadas.
  capabilities: z.object({
    tactical: z.object({ current: z.number() }),
    technical: z.object({ current: z.number() }),
    physical: z.object({ current: z.number() }),
  }),
  strengths: z.array(z.string()).max(4),
  risks: z.array(z.string()).max(3),
  gaps: z.array(z.string()).max(3),
  overallConfidence: z.number().min(0).max(1),
  // FASE 3: opcionales — si Haiku omite uno, no queremos que safeParse tumbe
  // TODA la salida al fallback de vídeo. La UI de confianza (FASE 4) los trata
  // como ausentes con degradación elegante.
  confidence_score: z.number().min(0).max(100).optional().describe("How confident we are in this evaluation (depends on data quality and quantity)"),
  data_completeness: z.number().min(0).max(100).optional().describe("Percentage of evaluation dimensions with actual data"),
  not_evaluated: z.array(z.string()).optional().describe("List of dimensions we could NOT evaluate and why"),
  summary: z.string().max(400).optional(),
});

export type RoleProfileInput = z.infer<typeof RoleProfileInputSchema>;
export type RoleProfileOutput = z.infer<typeof RoleProfileOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 4: Tactical Label Agent (Fase 2 - Video)
// Recibe detección de Roboflow → asigna etiquetas PHV/táctica
// ─────────────────────────────────────────
export const TacticalLabelInputSchema = z.object({
  frameId: z.string(),
  videoId: z.string(),
  detections: z.array(z.object({
    trackId: z.number(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    zone: z.number().min(1).max(9),
    hasBall: z.boolean(),
    speedKmh: z.number(),
    jerseyNumber: z.number().optional(),
    playerData: z.object({
      age: z.number().optional(),
      height: z.number().optional(),
      weight: z.number().optional(),
      knownPosition: z.string().optional(),
    }).optional(),
  })),
  matchContext: z.object({
    minute: z.number(),
    teamPossession: z.enum(["home", "away", "disputed"]),
    fieldZone: z.enum(["defensive", "middle", "offensive"]),
  }),
});

export const TacticalLabelOutputSchema = z.object({
  frameId: z.string(),
  labels: z.array(z.object({
    trackId: z.number(),
    positionCode: z.string(),
    phvCategory: z.enum(["early", "ontme", "late", "unknown"]),
    action: z.enum(["sprint", "pass", "shot", "press", "dribble", "tackle", "off_ball_run", "static"]),
    vsiContribution: z.number().min(0).max(1),
    labelConfidence: z.number().min(0).max(1),
  })),
});

export type TacticalLabelInput = z.infer<typeof TacticalLabelInputSchema>;
export type TacticalLabelOutput = z.infer<typeof TacticalLabelOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 5: Video Intelligence Agent
// Análisis automático de video → informe completo VITAS
// ─────────────────────────────────────────
export const VideoIntelligenceInputSchema = z.object({
  playerId:       z.string(),
  videoId:        z.string(),
  playerContext:  z.object({
    name:            z.string(),
    age:             z.number().min(8).max(21),
    position:        z.string(),
    foot:            z.enum(["right", "left", "both"]).optional(), // sin pie registrado ⇒ se omite
    height:          z.number().optional(),
    weight:          z.number().optional(),
    currentVSI:      z.number().optional(),
    phvCategory:     z.enum(["early", "ontme", "late"]).optional(),
    phvOffset:       z.number().optional(),
    competitiveLevel: z.string().optional(),
  }),
  keyframes:      z.array(z.string()).max(12), // URLs de keyframes del video
  videoDuration:  z.number().optional(),       // segundos
});

export const VideoIntelligenceOutputSchema = z.object({
  playerId:       z.string(),
  videoId:        z.string(),
  generatedAt:    z.string(),

  // Sección 1: Estado Actual
  estadoActual: z.object({
    resumenEjecutivo:    z.string().max(400),
    nivelActual:         z.enum(["elite", "alto", "medio_alto", "medio", "desarrollo"]),
    fortalezasPrimarias: z.array(z.string()).max(4),
    areasDesarrollo:     z.array(z.string()).max(3),
    // 6 dimensiones observadas en video (complementan VSI, no reemplazan PHV)
    dimensiones: z.object({
      velocidadDecision:  z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
      tecnicaConBalon:    z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
      inteligenciaTactica: z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
      capacidadFisica:    z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
      liderazgoPresencia: z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
      eficaciaCompetitiva: z.object({ score: z.number().min(0).max(10), observacion: z.string() }),
    }),
    ajusteVSIVideoScore: z.number().min(-15).max(15), // delta sugerido al VSI existente
  }),

  /** @deprecated Use BehavioralProfileInputSchema (Contract 10, Sprint 17) instead.
   *  Kept for backward compatibility with existing reports. */
  evaluacionPsicologica: z.object({
    resiliencia:        z.object({ nivel: z.enum(["alto", "medio", "bajo"]), evidencia: z.string() }),
    comunicacion:       z.object({ nivel: z.enum(["alto", "medio", "bajo"]), evidencia: z.string() }),
    toleranciaRiesgo:   z.object({ nivel: z.enum(["alto", "medio", "bajo"]), evidencia: z.string() }),
    hambreCompetitiva:  z.object({ nivel: z.enum(["alto", "medio", "bajo"]), evidencia: z.string() }),
    lenguajeCorporal:   z.object({ nivel: z.enum(["alto", "medio", "bajo"]), evidencia: z.string() }),
  }).optional(),

  // Sección 2: ADN Futbolístico
  adnFutbolistico: z.object({
    estiloJuego:       z.string().max(200),
    arquetipoTactico:  z.string().max(100), // "Box-to-box", "Delantero de referencia", etc.
    patrones: z.array(z.object({
      patron:      z.string(),
      frecuencia:  z.enum(["alto", "medio", "bajo"]),
      descripcion: z.string().max(150),
    })).max(5),
    mentalidad:        z.string().max(200),
  }),

  // Sección 3: Jugador Referencia (Clon)
  jugadorReferencia: z.object({
    top5: z.array(z.object({
      proPlayerId:   z.string(),
      nombre:        z.string(),
      posicion:      z.string(),
      club:          z.string(),
      score:         z.number(),  // 0-100
      razonamiento:  z.string().max(200),
    })).max(5),
    bestMatch: z.object({
      proPlayerId:   z.string(),
      nombre:        z.string(),
      posicion:      z.string(),
      club:          z.string(),
      score:         z.number(),
      narrativa:     z.string().max(300),
    }),
  }),

  // Sección 4: Proyección de Carrera
  proyeccionCarrera: z.object({
    escenarioOptimista: z.object({
      descripcion:   z.string().max(300),
      nivelProyecto: z.string(),   // "Primera División", "Segunda División", etc.
      clubTipo:      z.string(),
      edadPeak:      z.number().optional(),
    }),
    escenarioRealista: z.object({
      descripcion:   z.string().max(300),
      nivelProyecto: z.string(),
      clubTipo:      z.string(),
    }),
    factoresClave:    z.array(z.string()).max(4),
    riesgos:          z.array(z.string()).max(3),
  }),

  // Sección 5: Plan de Desarrollo
  planDesarrollo: z.object({
    objetivo6meses:   z.string().max(200),
    objetivo18meses:  z.string().max(200),
    pilaresTrabajo: z.array(z.object({
      pilar:          z.string(),
      acciones:       z.array(z.string()).max(3),
      prioridad:      z.enum(["crítica", "alta", "media"]),
    })).max(4),
    recomendacionEntrenador: z.string().max(300),
  }),

  // Sección 5.5: Proyección Competitiva (ligas juveniles españolas)
  proyeccionCompetitiva: z.object({
    nivelActualRecomendado: z.string(),
    justificacionNivel: z.string().max(300),
    tipoJugadorProyectado: z.string().max(200),
    roadmapPorCategoria: z.array(z.object({
      categoria: z.enum(["prebenjamin", "benjamin", "alevin", "infantil", "cadete", "juvenil"]),
      edadRango: z.string(),
      nivelRecomendado: z.string(),
      tipoJugadorEnEstaEtapa: z.string().max(150),
      capacidadesClave: z.array(z.string()).max(4),
      enfoqueDesarrollo: z.string().max(150),
      probabilidadAlcanzar: z.number().min(0).max(1),
    })).min(1).max(6),
    techoCompetitivo: z.object({
      nivel: z.string(),
      probabilidad: z.number().min(0).max(1),
      edadEstimada: z.number(),
      requisitosParaAlcanzarlo: z.array(z.string()).max(4),
    }),
    factoresAscenso: z.array(z.string()).max(4),
    factoresRiesgo: z.array(z.string()).max(3),
    recomendacionFinal: z.string().max(400),
  }).optional(),

  // Sección 6: Métricas Cuantitativas (opcionales — dependen de fuente de datos)
  metricasCuantitativas: z.object({
    fisicas: z.object({
      velocidadMaxKmh:   z.number(),
      velocidadPromKmh:  z.number(),
      distanciaM:        z.number(),
      sprints:           z.number(),
      zonasIntensidad:   z.object({
        caminar: z.number(),
        trotar:  z.number(),
        correr:  z.number(),
        sprint:  z.number(),
      }),
    }).optional(),
    eventos: z.object({
      pasesCompletados: z.number(),
      pasesFallados:    z.number(),
      precisionPases:   z.number(),
      recuperaciones:   z.number(),
      // Desglose de recuperaciones (opcional — retrocompatible con reportes previos)
      robos:            z.number().optional(),  // tackles: ganar balón por contacto/entrada
      anticipaciones:   z.number().optional(),  // interceptaciones: cortar línea de pase
      duelosGanados:    z.number(),
      duelosPerdidos:   z.number(),
      disparosAlArco:   z.number(),
      disparosFuera:    z.number(),
      // Pérdidas de balón (opcional): fallo técnico que da posesión al rival
      perdidas:         z.number().optional(),
    }).optional(),
    fuente:    z.enum(["yolo+gemini", "gemini_only", "yolo_only"]),
    confianza: z.number().min(0).max(1),
    heatmapPositions: z.array(z.object({
      fx: z.number(),
      fy: z.number(),
    })).optional(),
  }).optional(),

  // Meta
  confianza:          z.number().min(0).max(1),
  tokensUsados:       z.number().optional(),
  modeloUsado:        z.string().optional(),
});

export type VideoIntelligenceInput  = z.infer<typeof VideoIntelligenceInputSchema>;
export type VideoIntelligenceOutput = z.infer<typeof VideoIntelligenceOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 6: Team Observation Agent (Gemini)
// Observación táctica del equipo completo
// ─────────────────────────────────────────

// Team level only (identidad.md): no per-player list, no dorsal. The old
// `jugadoresObservados[]` (LLM-guessed dorsalEstimado + per-player counts) was
// removed; src/lib/shared/teamReportIdentity.ts strips it if a model still emits it.
export const TeamObservationOutputSchema = z.object({
  formacionDetectada: z.string(),
  // null = el modelo no pudo estimarla (no se inventa 55/45; P1 bloque 2).
  posesionEstimada:   z.object({
    equipo: z.number().nullable(),
    rival:  z.number().nullable(),
  }),
  fasesJuego: z.object({
    pressing: z.object({
      tipo:           z.string(),
      alturaLinea:    z.string(),
      intensidad:     z.number().min(1).max(10),
      observaciones:  z.array(z.string()).max(3),
    }),
    transicionOfensiva: z.object({
      velocidad: z.string(),
      patrones:  z.array(z.string()).max(3),
    }),
    transicionDefensiva: z.object({
      velocidad: z.string(),
      patrones:  z.array(z.string()).max(3),
    }),
    posesion: z.object({
      estilo:   z.string(),
      patrones: z.array(z.string()).max(3),
    }),
  }),
  momentosColectivos: z.array(z.object({
    timestamp:   z.string(),
    tipo:        z.enum(["positivo", "negativo"]),
    descripcion: z.string(),
  })).max(6),
  resumenGeneral: z.string(),
});

export type TeamObservationOutput = z.infer<typeof TeamObservationOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 7: Team Intelligence Agent (Claude)
// Informe táctico completo del equipo
// ─────────────────────────────────────────

export const TeamIntelligenceOutputSchema = z.object({
  videoId:      z.string(),
  generatedAt:  z.string(),

  equipoAnalizado: z.object({
    colorUniforme:       z.string(),
    jugadoresDetectados: z.number(),
  }),

  resumenEjecutivo: z.string().max(500),

  formacion: z.object({
    sistema:   z.string(),
    variantes: z.array(z.string()).max(3),
    rigidez:   z.number().min(1).max(10),
  }),

  posesion: z.object({
    // null = no observada (nunca un 0 ni el 55 del ejemplo del prompt).
    porcentaje:         z.number().nullable(),
    estiloCirculacion:  z.string().max(200),
    zonasDominadas:     z.array(z.string()).max(4),
  }),

  fasesJuego: z.object({
    pressing: z.object({
      tipo:        z.string(),
      alturaLinea: z.enum(["alta", "media", "baja"]),
      intensidad:  z.number().min(1).max(10),
      descripcion: z.string().max(200),
    }),
    transiciones: z.object({
      ofensiva: z.object({
        velocidad:   z.string(),
        patron:      z.string(),
        descripcion: z.string().max(200),
      }),
      defensiva: z.object({
        velocidad:   z.string(),
        patron:      z.string(),
        descripcion: z.string().max(200),
      }),
    }),
  }),

  metricasColectivas: z.object({
    compacidad:            z.number().min(1).max(10),
    alturaLineaDefensiva:  z.enum(["alta", "media", "baja"]),
    amplitud:              z.number().min(1).max(10),
    sincronizacion:        z.number().min(1).max(10),
    descripcion:           z.string().max(300),
  }),

  // Team level only (identidad.md): the old `jugadores[]` (LLM-guessed dorsalEstimado
  // + per-player passes/duels/recoveries/speed/heatmap) was removed. Reports saved
  // before still hold it: src/lib/shared/teamReportIdentity.ts strips it on read.

  evaluacionGeneral: z.object({
    fortalezasEquipo:  z.array(z.string()).max(4),
    areasTrabajar:     z.array(z.string()).max(3),
    recomendaciones:   z.array(z.string()).max(3),
  }),

  confianza: z.number().min(0).max(1),

  /** What the identity guard withheld (per-player rows / texts naming an individual). */
  identityWithheld: z.object({
    perPlayerRows: z.number().int().min(0),
    texts:         z.number().int().min(0),
  }).optional(),
});

export type TeamIntelligenceOutput = z.infer<typeof TeamIntelligenceOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 8: Coaching Assistant Agent (Sprint 15)
// Genera reporte narrativo de sesión de entrenamiento
// ─────────────────────────────────────────
export const CoachingAssistantInputSchema = z.object({
  teamId: z.string(),
  teamName: z.string().optional(),
  sessionAnalysis: z.record(z.unknown()),
  recentSessions: z.array(z.record(z.unknown())).optional(),
  recommendation: z.record(z.unknown()).optional(),
  phvDistribution: z.object({
    prePhv: z.number().optional(),
    circaPhv: z.number().optional(),
    postPhv: z.number().optional(),
  }).optional(),
  teamAvgAge: z.number().optional(),
  playerHighlights: z.array(z.record(z.unknown())).optional(),
  engagementSnapshots: z.array(z.record(z.unknown())).optional(),
});

export const CoachingAssistantOutputSchema = z.object({
  sessionSummary: z.string(),
  whatWorkedWell: z.array(z.string()).max(3),
  whatToImprove: z.array(z.string()).max(3),
  nextSessionPlan: z.object({
    focus: z.string(),
    drills: z.array(z.string()),
    duration: z.string(),
  }),
  playerSpotlight: z.array(z.object({
    playerId: z.string(),
    reason: z.string(),
    action: z.string(),
  })).max(3),
  weeklyPlan: z.string(),
  phvAlerts: z.array(z.string()).nullable(),
});

export type CoachingAssistantInput = z.infer<typeof CoachingAssistantInputSchema>;
export type CoachingAssistantOutput = z.infer<typeof CoachingAssistantOutputSchema>;

// ─────────────────────────────────────────
// CONTRATO 9: Parent Report Schema (Sprint 15)
// Reporte mensual para padres
// ─────────────────────────────────────────
export const ParentReportSchema = z.object({
  playerId: z.string(),
  playerName: z.string(),
  reportMonth: z.string(),
  summary: z.object({
    sessionsAttended: z.number(),
    totalTrainingMinutes: z.number(),
    avgParticipationScore: z.number(),
    avgEngagementScore: z.number(),
  }),
  trends: z.object({
    participation: z.enum(["improving", "stable", "declining"]),
    technique: z.enum(["improving", "stable", "declining"]),
    physical: z.enum(["improving", "stable", "declining"]),
    social: z.enum(["improving", "stable", "declining"]),
  }),
  growthContext: z.string().nullable(),
  positives: z.array(z.string()).max(4),
  developmentAreas: z.array(z.string()).max(2),
  coachNote: z.string(),
});

export type ParentReportOutput = z.infer<typeof ParentReportSchema>;

// ─────────────────────────────────────────
// CONTRATO 10: Behavioral Profile (Sprint 17)
// Perfil conductual — 7 dimensiones numéricas 0-100
// REEMPLAZA evaluacionPsicologica textual (marcada @deprecated)
// ─────────────────────────────────────────
export const BehavioralProfileInputSchema = z.object({
  playerId: z.string(),
  playerName: z.string().optional(),
  playerAge: z.number(),
  /** IDs of videos analyzed to compute this profile */
  videoIds: z.array(z.string()),
  /** Pre-computed behavioral scores */
  scores: z.object({
    decisionSpeed: z.number().min(0).max(100),
    scanningIntelligence: z.number().min(0).max(100),
    resilience: z.number().min(0).max(100),
    clutchFactor: z.number().min(0).max(100),
    leadership: z.number().min(0).max(100),
    mentalFatigue: z.number().min(0).max(100),
    unpredictability: z.number().min(0).max(100),
    mentalComposite: z.number().min(0).max(100),
    archetype: z.string(),
  }),
  /** Player position for context */
  position: z.string().optional(),
  /** Recent match context */
  recentMatchContext: z.string().optional(),
});

export const BehavioralProfileOutputSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  archetypeExplanation: z.string(),
  strengths: z.array(z.string()).max(3),
  developmentAreas: z.array(z.string()).max(3),
  comparisonWithPeers: z.string(),
  coachingTips: z.array(z.string()).max(3),
});

export type BehavioralProfileInput = z.infer<typeof BehavioralProfileInputSchema>;
export type BehavioralProfileOutput = z.infer<typeof BehavioralProfileOutputSchema>;

// ─────────────────────────────────────────
// CONTRACT 11: IDP ARCHITECT (Sprint IDP - 2026)
// ─────────────────────────────────────────
// AI-proposed monthly Individual Development Plan. Hybrid workflow:
// agent proposes 1-5 goals, only in the dimensions with data (one per dimension),
// coach edits + approves.

const IDPDimensionEnum = z.enum([
  "technical",
  "tactical",
  "physical",
  "mental",
  "maturation",
]);

const IDPMetricRefSchema = z.object({
  metric: z.string(),
  value: z.number(),
  label: z.string().optional(),
  unit: z.string().optional(),
});

export const IDPArchitectInputSchema = z.object({
  player: z.object({
    id: z.string(),
    name: z.string(),
    // Sin dato ⇒ ausente/null (P1 bloque 5d): antes el cliente mandaba «MID» y 14 años
    // por defecto, y el plan se ajustaba a una posición y una edad inventadas.
    position: z.string().optional(),
    chronologicalAge: z.number().min(6).max(50).nullable(),
    foot: z.string().optional(),
  }),
  // Cada dimensión con su dato o null (P1 bloque 5d): antes, sin vídeo, el cliente
  // copiaba la evaluación del entrenador a las 4 dimensiones y ponía 60 de «overall».
  vsi: z.object({
    overall: z.number().nullable(),
    technical: z.number().nullable(),
    tactical: z.number().nullable(),
    physical: z.number().nullable(),
    mental: z.number().nullable(),
  }).optional(),
  phv: z.object({
    offset: z.number(),
    category: z.string(),
  }).nullable().optional(),
  behavioralProfile: z.object({
    decisionSpeed: z.number().optional(),
    scanning: z.number().optional(),
    resilience: z.number().optional(),
    leadership: z.number().optional(),
    mentalComposite: z.number().optional(),
    archetype: z.string().optional(),
  }).optional(),
  recentFatigue: z.object({
    acwr: z.number().optional(),
    fatigueIndex: z.number().optional(),
    injuryRisk: z.number().optional(),
  }).optional(),
  wellbeing: z.object({
    engagementTrend: z.enum(["rising", "stable", "declining"]).optional(),
    dropoutRisk: z.number().optional(),
  }).optional(),
  teamContext: z.object({
    avgVsi: z.number().optional(),
    teamLevel: z.enum(["weak", "average", "strong", "elite"]).optional(),
    upcomingFixtures: z.number().optional(),
  }).optional(),
  previousPlanSummary: z.object({
    achievedDimensions: z.array(IDPDimensionEnum),
    missedDimensions: z.array(IDPDimensionEnum),
    coachNotes: z.string().optional(),
  }).optional(),
  // Idioma de redacción (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
});

export const IDPArchitectOutputSchema = z.object({
  overallFocus: z.string().min(10).max(200),
  agentSummary: z.string().min(20),
  goals: z
    .array(
      z.object({
        dimension: IDPDimensionEnum,
        title: z.string().min(5).max(120),
        description: z.string().min(10),
        rationale: z.string().min(10),
        baselineMetric: IDPMetricRefSchema,
        targetMetric: IDPMetricRefSchema,
        suggestedDrills: z.array(z.string()),
        weight: z.number().int().min(1).max(5),
      }),
    )
    // 1-5 (antes 3-5): solo dimensiones con dato; con una o dos, no se rellena con metas
    // inventadas (P1 bloque 5d, revisión del #320).
    .min(1)
    .max(5),
});

export type IDPArchitectInput = z.infer<typeof IDPArchitectInputSchema>;
export type IDPArchitectOutput = z.infer<typeof IDPArchitectOutputSchema>;

// ─────────────────────────────────────────
// CONTRACT 12: TACTICAL PATTERN AGENT
// ─────────────────────────────────────────
// Interpreta heatmaps de 6 fases tácticas + zonas calientes + posesión y
// genera insights tácticos (qué pasa por fase, riesgos, sugerencias).

const GamePhaseEnum = z.enum([
  "build_up",
  "attacking",
  "defending",
  "defensive_transition",
  "offensive_transition",
  "set_piece",
]);

const HotZoneSchema = z.object({
  centroidX: z.number().min(0).max(100),
  centroidY: z.number().min(0).max(100),
  radius: z.number().min(0),
  share: z.number().min(0).max(1),
  label: z.string().optional(),
});

export const TacticalPatternInputSchema = z.object({
  match: z.object({
    id: z.string(),
    matchDate: z.string().optional(),
    durationMin: z.number().optional(),
    score: z
      .object({ ours: z.number(), theirs: z.number() })
      .optional(),
  }),
  team: z.object({
    id: z.string().optional(),
    formation: z.string().optional(),
    averageAge: z.number().optional(),
    style: z
      .enum(["possession", "direct", "counter", "pressing"])
      .optional(),
  }),
  phaseDurations: z.object({
    build_up: z.number(),
    attacking: z.number(),
    defending: z.number(),
    defensive_transition: z.number(),
    offensive_transition: z.number(),
    set_piece: z.number(),
  }),
  possessionPct: z.number().min(0).max(100),
  teamHotZonesByPhase: z.array(
    z.object({
      phase: GamePhaseEnum,
      zones: z.array(HotZoneSchema),
    }),
  ),
  coverageGaps: z
    .array(
      z.object({
        phase: GamePhaseEnum,
        zone: z.object({ x: z.number(), y: z.number() }),
        label: z.string(),
      }),
    )
    .optional(),
  // FASE 5 · maduración biológica del equipo (diferenciador VITAS) e idioma
  phvDistribution: z
    .object({
      prePhv: z.number().optional(),
      circaPhv: z.number().optional(),
      postPhv: z.number().optional(),
    })
    .optional(),
  locale: localeSchema.optional(),
});

export const TacticalPatternOutputSchema = z.object({
  headline: z.string().min(10).max(200),
  summary: z.string().min(20),
  byPhase: z
    .array(
      z.object({
        phase: GamePhaseEnum,
        observation: z.string().min(10),
        risk: z.enum(["low", "moderate", "high"]),
        suggestion: z.string().min(10),
      }),
    )
    .min(3)
    .max(6),
  strengths: z.array(z.string()).max(4),
  weaknesses: z.array(z.string()).max(4),
  coachingTips: z.array(z.string()).max(4),
});

export type TacticalPatternInput = z.infer<typeof TacticalPatternInputSchema>;
export type TacticalPatternOutput = z.infer<typeof TacticalPatternOutputSchema>;

// ─────────────────────────────────────────
// CONTRACT 13: TRANSFER MATCH AGENT
// ─────────────────────────────────────────
// Rankea listings del marketplace contra una necesidad del club comprador.

const TransferQuerySchema = z.object({
  positions: z.array(z.string()).optional(),
  minAge: z.number().int().optional(),
  maxAge: z.number().int().optional(),
  foot: z.enum(["left", "right", "both"]).optional(),
  minVSI: z.number().optional(),
  vsiMinByDimension: z
    .object({
      technical: z.number().optional(),
      tactical: z.number().optional(),
      physical: z.number().optional(),
      mental: z.number().optional(),
    })
    .optional(),
  phvCategory: z
    .array(z.enum(["early", "on-time", "late"]))
    .optional(),
  listingTypes: z.array(z.enum(["sale", "loan", "trial"])).optional(),
  maxPriceEur: z.number().optional(),
  tags: z.array(z.string()).optional(),
  text: z.string().optional(),
});

const ListingCandidateSchema = z.object({
  listingId: z.string(),
  listingType: z.enum(["sale", "loan", "trial"]),
  askingPriceEur: z.number().nullable(),
  player: z.object({
    name: z.string().optional(),
    age: z.number().optional(),
    position: z.string().optional(),
    foot: z.string().optional(),
    vsi: z.number().optional(),
    vsiBreakdown: z
      .object({
        technical: z.number(),
        tactical: z.number(),
        physical: z.number(),
        mental: z.number(),
      })
      .optional(),
    phvOffset: z.number().optional(),
    phvCategory: z.string().optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
});

export const TransferMatchInputSchema = z.object({
  buyerNeed: z.object({
    /** Free-text del comprador: "necesito un central zurdo sub-19 con liderazgo" */
    description: z.string().min(10).max(1000),
    /** Filtros estructurados (opcionales — pueden venir vacíos si solo hay texto) */
    query: TransferQuerySchema.optional(),
    /** Contexto opcional del club comprador para refinar match. */
    buyerContext: z
      .object({
        teamLevel: z.enum(["weak", "average", "strong", "elite"]).optional(),
        formation: z.string().optional(),
        currentRoster: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  candidates: z.array(ListingCandidateSchema).min(1).max(50),
  // Idioma de redacción (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
});

export const TransferMatchOutputSchema = z.object({
  topMatches: z
    .array(
      z.object({
        listingId: z.string(),
        score: z.number().min(0).max(100),
        reasoning: z.string().min(10).max(500),
        matchedCriteria: z.array(z.string()),
        missingCriteria: z.array(z.string()),
      }),
    )
    .min(0)
    .max(20),
  summary: z.string().min(10).max(500),
});

export type TransferMatchInput = z.infer<typeof TransferMatchInputSchema>;
export type TransferMatchOutput = z.infer<typeof TransferMatchOutputSchema>;

// ─────────────────────────────────────────
// TIPO GENÉRICO DE RESPUESTA DE AGENTE
// ─────────────────────────────────────────
export interface AgentResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  tokensUsed?: number;
  agentName: string;
}
