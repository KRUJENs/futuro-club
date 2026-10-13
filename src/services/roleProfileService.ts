import { z } from "zod";
import { type RoleProfileData, type PositionFit, type ArchetypeFit, type EvidenceIndicator, type GapItem } from "@/lib/roleProfileData";
import type { Player } from "@/services/real/playerService";
import { supabase, SUPABASE_CONFIGURED } from "@/lib/supabase";

// ─── Zod Schemas for validation ──────────────────────────────────────────

const CapabilityScoresSchema = z.object({
  tactical: z.number().min(0).max(100),
  technical: z.number().min(0).max(100),
  physical: z.number().min(0).max(100),
});

const PositionFitSchema = z.object({
  code: z.string(),
  prob: z.number().min(0).max(1),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const ArchetypeFitSchema = z.object({
  code: z.string(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  stability: z.enum(["emergente", "en_desarrollo", "estable", "consolidado"]),
  positions: z.array(z.string()).optional(),
});

const EvidenceSchema = z.object({
  indicator: z.string(),
  label: z.string(),
  raw_value: z.number(),
  normalized: z.number(),
  reliability: z.number().min(0).max(1),
  phase_of_play: z.enum(["in_possession", "out_of_possession", "transition"]),
  impact: z.enum(["positivo", "neutro", "negativo"]),
  contribution: z.number(),
  positions_impacted: z.array(z.string()),
  archetypes_impacted: z.array(z.string()),
  explanation: z.string(),
});

const RoleProfileSchema = z.object({
  run_id: z.string(),
  player_id: z.string(),
  player_name: z.string(),
  player_age: z.number().int().positive(),
  // Opcionales: el alta rápida no los pide y nunca se rellenan por defecto (P1 bloque 2).
  // Requeridos, un jugador sin pie o sin nivel hacía fallar el perfil entero (y se
  // volvía a pagar el LLM en cada visita, porque no llegaba a la caché).
  dominant_foot: z.enum(["derecho", "izquierdo", "ambidiestro"]).optional(),
  minutes_played: z.number().int().min(0),
  competitive_level: z.string().optional(),
  sample_tier: z.enum(["bronze", "silver", "gold", "platinum"]),
  overall_confidence: z.number().min(0).max(1),
  current: CapabilityScoresSchema,
  identity: z.object({
    dominant: z.enum(["ofensivo", "defensivo", "tecnico", "fisico", "mixto"]),
    distribution: z.record(z.number()),
    explanation: z.string(),
  }),
  positions: z.array(PositionFitSchema),
  archetypes: z.array(ArchetypeFitSchema),
  projections: z.object({
    "0_6m": CapabilityScoresSchema,
    "6_18m": CapabilityScoresSchema,
    "18_36m": CapabilityScoresSchema,
  }),
  strengths: z.array(z.object({
    label: z.string(),
    evidence: z.string(),
    confidence: z.number(),
  })),
  risks: z.array(z.object({
    code: z.string(),
    label: z.string(),
    description: z.string(),
  })),
  gaps: z.array(z.object({
    label: z.string(),
    priority: z.enum(["alta", "media", "baja"]),
    relatedPositions: z.array(z.string()),
  })),
  consolidation_notes: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  /** Alternativas de posición · multi-posición · descubrimientos del agente */
  positionAlternatives: z.array(z.object({
    code:            z.string(),
    fit:             z.number().min(0).max(100),
    alreadyDeclared: z.boolean(),
    reason:          z.string(),
    confidence:      z.number().min(0).max(1),
  })).optional(),
  /** Videos fuente del informe · cita explícita */
  source_videos: z.array(z.object({
    video_id:    z.string(),
    analyzed_at: z.string(),
    duration_min: z.number().optional(),
  })).optional(),
});

// ─── Caché persistente del perfil (localStorage) ─────────────────────────
//
// El perfil se genera con un agente LLM (AgentService.buildRoleProfile), que
// tarda varios segundos. Sin persistencia se regeneraba en CADA apertura de la
// pestaña "Rol" (react-query solo cachea 5 min en memoria; un reload o una
// sesión nueva volvían a llamar al LLM) → "Generando perfil de rol..." SIEMPRE.
//
// Ahora se cachea el resultado en localStorage con una clave = hash de la ENTRADA
// del agente (jugador + resumen de vídeos). Mientras la entrada no cambie, se
// devuelve al instante; si cambia (nuevo vídeo analizado, métricas editadas), la
// clave cambia y se regenera una sola vez. Solo se cachea el resultado del agente
// (el caro), no el fallback determinista.
const ROLE_PROFILE_CACHE_PREFIX = "vitas_roleprofile_";
// Súbelo si cambia la forma del perfil o la lógica del agente, para invalidar
// las cachés viejas (la clave incluye la versión → un bump provoca cache-miss).
const ROLE_PROFILE_CACHE_VERSION = "v2"; // v2: sin los proxies pressing/positioning

/** Pie dominante para el perfil; sin pie registrado ⇒ undefined (nunca «ambidiestro» por defecto). */
function footLabel(foot: "right" | "left" | "both" | undefined): "derecho" | "izquierdo" | "ambidiestro" | undefined {
  return foot === "right" ? "derecho" : foot === "left" ? "izquierdo" : foot === "both" ? "ambidiestro" : undefined;
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readRoleProfileCache(key: string): RoleProfileData | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = RoleProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as RoleProfileData) : null;
  } catch {
    return null;
  }
}

function writeRoleProfileCache(playerId: string, key: string, data: RoleProfileData): void {
  try {
    // Poda: mantener una sola entrada por jugador (la de la última entrada válida).
    const stale: string[] = [];
    const playerPrefix = ROLE_PROFILE_CACHE_PREFIX + playerId + "_";
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(playerPrefix) && k !== key) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // localStorage lleno o deshabilitado — el perfil sigue funcionando sin caché.
  }
}

// ─── Service functions ───────────────────────────────────────────────────

/**
 * GET /api/player/:id/role-profile
 * Lee los análisis de video del jugador (Supabase) y genera el Role Profile
 * alimentado con datos reales de video. Si no hay videos analizados, retorna null.
 */
export async function fetchRoleProfile(playerId: string): Promise<RoleProfileData | null> {
  const { PlayerService } = await import("@/services/real/playerService");
  const player = PlayerService.getById(playerId);
  if (!player) return null;

  // 1. Buscar análisis de video guardados en Supabase
  let videoAnalyses: Array<{ report: Record<string, unknown>; created_at: string; video_id?: string; played_position?: string | null }> = [];
  if (SUPABASE_CONFIGURED) {
    try {
      const { data } = await supabase
        .from("player_analyses")
        .select("report, created_at, video_id, played_position")
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(5);
      if (data && data.length > 0) videoAnalyses = data;
    } catch {
      // Supabase no disponible
    }
  }

  // Sin análisis de video → NO generar perfil ficticio.
  // Filosofía VITAS: ningún informe sin video real que lo respalde.
  // El UI muestra empty state con CTA "Analizar en Lab".
  if (videoAnalyses.length === 0) {
    console.info("[roleProfileService] No video analyses for", playerId, "· returning null (UI debe mostrar empty state)");
    return null;
  }

  // 2. Extraer datos consolidados de los análisis de video
  const latestReport = videoAnalyses[0].report as Record<string, unknown>;
  const estadoActual = latestReport.estadoActual as Record<string, unknown> | undefined;
  // Los `dim.score` son una CONSTANTE fabricada si el pipeline no mide dimensiones
  // (dimensionesMedidas=false, el caso de hoy). No se meten en el prompt del agente ni en
  // el fallback (inv #2): {} cuando no son reales; el resto del perfil usa señales reales.
  const dimensionesMedidas = estadoActual?.dimensionesMedidas === true;
  const dimensiones = (dimensionesMedidas ? (estadoActual?.dimensiones ?? {}) : {}) as Record<string, { score: number; observacion: string }>;
  const adnFutbolistico = latestReport.adnFutbolistico as Record<string, unknown> | undefined;
  const planDesarrollo = latestReport.planDesarrollo as Record<string, unknown> | undefined;
  const jugadorReferencia = latestReport.jugadorReferencia as Record<string, unknown> | undefined;
  const proyeccionCarrera = latestReport.proyeccionCarrera as Record<string, unknown> | undefined;

  // 3. Entrada del agente (y firma para la caché: si no cambia, no se re-llama al LLM).
  const agentInput = {
    player: {
      id: player.id,
      name: player.name,
      age: player.age,
      foot: player.foot,
      position: player.position,
      secondaryPositions: player.secondaryPositions ?? [],   // multi-posición
      minutesPlayed: player.minutesPlayed,
      competitiveLevel: player.competitiveLevel,
      // Solo las 6 métricas reales del entrenador. «pressing = stamina» y
      // «positioning = vision» eran aproximaciones falsas (P1 bloque 2, inv #2).
      metrics: { ...player.metrics },
      // PHV solo si el gate único lo produjo (PlayerService ya retira el persistido
      // no recalculable). Sin él se OMITE: nunca «ontme»/0 por defecto (inv #2).
      ...(player.phvCategory && typeof player.phvOffset === "number"
        ? { phvCategory: player.phvCategory, phvOffset: player.phvOffset }
        : {}),
      phvDataAvailable: !!(player.phvCategory && typeof player.phvOffset === "number"),
      // Inyectar resumen de análisis de video para que el agente lo use
      videoAnalysisSummary: {
        totalAnalyses: videoAnalyses.length,
        latestDimensions: dimensiones,
        strengths: (estadoActual?.fortalezasPrimarias as string[]) ?? [],
        areasDesarrollo: (estadoActual?.areasDesarrollo as string[]) ?? [],
        // Sin nivel del informe ⇒ null (no se inventa «desarrollo», inv #2).
        nivelActual: (estadoActual?.nivelActual as string) ?? null,
        arquetipoTactico: (adnFutbolistico?.arquetipoTactico as string) ?? "",
        estiloJuego: (adnFutbolistico?.estiloJuego as string) ?? "",
      },
    },
    videoContext: {
      playedPosition: videoAnalyses[0]?.played_position ?? player.position,
      videoId:        videoAnalyses[0]?.video_id ?? null,
      analyzedAt:     videoAnalyses[0]?.created_at ?? null,
    },
  };

  // Caché persistente: mientras la entrada no cambie, se devuelve el perfil ya
  // generado al instante (sin volver a llamar al LLM). Es lo que elimina el
  // "Generando perfil de rol..." en cada apertura de la pestaña.
  const cacheKey = ROLE_PROFILE_CACHE_PREFIX + playerId + "_" + ROLE_PROFILE_CACHE_VERSION + "_" + hashStr(JSON.stringify(agentInput));
  const cached = readRoleProfileCache(cacheKey);
  if (cached) return cached;

  // 4. Intentar generar Role Profile con el agente AI + datos de video
  try {
    const { AgentService } = await import("@/services/real/agentService");

    const res = await AgentService.buildRoleProfile(agentInput);

    if (res.success && res.data) {
      const d = res.data;

      // Construir evidencia desde dimensiones del video (no métricas manuales).
      // Solo con dimensiones REALES: sin ellas, cada indicador saldría de `dim?.score ?? 5`
      // (constante fabricada) con raw_value:5/reliability:0.8 → evidencia falsa presentada
      // como fiable, y además se cachea/renderiza (IndicatorsAuditTable). Se abstiene (inv #2).
      const buildVideoEvidence = (): EvidenceIndicator[] => {
        if (!dimensionesMedidas) return [];
        const dimMap: Array<{ key: string; label: string; phase: EvidenceIndicator["phase_of_play"] }> = [
          { key: "inteligenciaTactica", label: "Inteligencia táctica",  phase: "in_possession" },
          { key: "tecnicaConBalon",     label: "Técnica con balón",     phase: "in_possession" },
          { key: "velocidadDecision",   label: "Velocidad de decisión", phase: "in_possession" },
          { key: "capacidadFisica",     label: "Capacidad física",      phase: "transition" },
          { key: "liderazgoPresencia",  label: "Liderazgo y presencia", phase: "out_of_possession" },
          { key: "eficaciaCompetitiva", label: "Eficacia competitiva",  phase: "in_possession" },
        ];
        return dimMap.map((m) => {
          const dim = dimensiones[m.key];
          const score = dim?.score ?? 5;
          const norm = score / 10;
          return {
            indicator: m.key,
            label: m.label,
            raw_value: score,
            normalized: Math.round(norm * 100),
            reliability: 0.8,
            phase_of_play: m.phase,
            impact: norm >= 0.7 ? "positivo" as const : norm >= 0.45 ? "neutro" as const : "negativo" as const,
            contribution: Math.round(norm * 10) / 10,
            positions_impacted: d.topPositions.slice(0, 2).map(p => p.code),
            archetypes_impacted: d.topArchetypes.slice(0, 1).map(a => a.code),
            explanation: dim?.observacion ?? `${m.label}: ${score}/10`,
          };
        });
      };

      const sampleTier: RoleProfileData["sample_tier"] =
        videoAnalyses.length >= 4 ? "platinum" :
        videoAnalyses.length >= 3 ? "gold"     :
        videoAnalyses.length >= 2 ? "silver"   : "bronze";

      const agentProfile: RoleProfileData = {
        run_id:             `run_${Date.now()}`,
        player_id:          playerId,
        player_name:        player.name,
        player_age:         player.age,
        dominant_foot:      footLabel(player.foot),
        minutes_played:     player.minutesPlayed,
        competitive_level:  player.competitiveLevel || undefined,
        sample_tier:        sampleTier,
        overall_confidence: d.overallConfidence,
        // FASE 3: el agente emite positionAlternatives (contracts.ts:137) pero
        // el adaptador nunca lo copiaba → PositionDiscoveryBanner quedaba vacío.
        positionAlternatives: d.positionAlternatives,
        current: {
          tactical:  d.capabilities.tactical.current,
          technical: d.capabilities.technical.current,
          physical:  d.capabilities.physical.current,
        },
        projections: {
          "0_6m":   { tactical: Math.min(100, d.capabilities.tactical.p6m),      technical: Math.min(100, d.capabilities.technical.p6m),      physical: Math.min(100, d.capabilities.physical.p6m) },
          "6_18m":  { tactical: Math.min(100, d.capabilities.tactical.p18m),     technical: Math.min(100, d.capabilities.technical.p18m),     physical: Math.min(100, d.capabilities.physical.p18m) },
          "18_36m": { tactical: Math.min(100, d.capabilities.tactical.p18m + 3), technical: Math.min(100, d.capabilities.technical.p18m + 3), physical: Math.min(100, d.capabilities.physical.p18m + 2) },
        },
        identity: {
          dominant:     d.dominantIdentity,
          distribution: d.identityDistribution,
          explanation:  `Perfil dominante: ${d.dominantIdentity}`,
        },
        positions: d.topPositions.map((p, i) => ({
          code:       p.code as RoleProfileData["positions"][0]["code"],
          prob:       p.fit / 100,
          score:      p.fit,
          confidence: p.confidence,
          reason:     i === 0 ? `Posición principal con ${p.fit}% de ajuste` : `Posición alternativa viable`,
        })),
        archetypes: d.topArchetypes.map((a) => ({
          code:       a.code as RoleProfileData["archetypes"][0]["code"],
          score:      a.fit,
          confidence: a.fit / 100,
          stability:  a.stability,
          positions:  [],
        })),
        strengths: d.strengths.map((s) => ({
          label:      s,
          evidence:   `Detectado en análisis de ${videoAnalyses.length} video(s)`,
          confidence: d.overallConfidence,
        })),
        risks: d.risks.map((r, i) => ({
          code:        `RSK_${i}`,
          label:       r,
          description: r,
        })),
        gaps: d.gaps.map((g, i) => ({
          label:            g,
          priority:         (i === 0 ? "alta" : i === 1 ? "media" : "baja") as GapItem["priority"],
          relatedPositions: d.topPositions.slice(0, 2).map(p => p.code as RoleProfileData["positions"][0]["code"]),
        })),
        consolidation_notes: d.strengths.slice(0, 2),
        evidence:            buildVideoEvidence(),
        source_videos:       videoAnalyses.map((v) => ({
          video_id:    v.video_id ?? "unknown",
          analyzed_at: v.created_at,
        })),
      };

      const parsed = RoleProfileSchema.safeParse(agentProfile);
      if (parsed.success) {
        const profile = parsed.data as RoleProfileData;
        // Persistir el resultado del agente (el caro) para no re-llamar al LLM
        // mientras la entrada no cambie.
        writeRoleProfileCache(playerId, cacheKey, profile);
        return profile;
      }
    }
  } catch (err) {
    console.error("[roleProfileService] Agent error:", err);
  }

  // Agente falló. El fallback "desde vídeo" derivaba tactical/technical/physical + evidence
  // + overall_confidence 0.65 de los `dim.score`, que son la CONSTANTE fabricada si el
  // pipeline no mide dimensiones. Sin dimensiones REALES no hay base honesta para un perfil
  // de rol con esos números → se abstiene (null, el caller ya lo maneja), no se fabrica
  // (inv #2/#3). Cuando dimensionesMedidas sea true, este fallback sí es legítimo.
  if (!dimensionesMedidas) return null;

  // Agente falló pero hay datos de video → construir perfil básico desde video
  const dim = dimensiones;
  const tacticalScore = (dim.inteligenciaTactica?.score ?? 5) * 10;
  const technicalScore = (dim.tecnicaConBalon?.score ?? 5) * 10;
  const physicalScore = (dim.capacidadFisica?.score ?? 5) * 10;

  const videoBasedProfile: RoleProfileData = {
    run_id: `run_video_${Date.now()}`,
    player_id: playerId,
    player_name: player.name,
    player_age: player.age,
    dominant_foot: footLabel(player.foot),
    minutes_played: player.minutesPlayed,
    competitive_level: player.competitiveLevel || undefined,
    sample_tier: videoAnalyses.length >= 3 ? "gold" : videoAnalyses.length >= 2 ? "silver" : "bronze",
    overall_confidence: 0.65,
    current: { tactical: tacticalScore, technical: technicalScore, physical: physicalScore },
    projections: {
      "0_6m":   { tactical: Math.min(100, tacticalScore + 2),  technical: Math.min(100, technicalScore + 2),  physical: Math.min(100, physicalScore + 3) },
      "6_18m":  { tactical: Math.min(100, tacticalScore + 5),  technical: Math.min(100, technicalScore + 5),  physical: Math.min(100, physicalScore + 7) },
      "18_36m": { tactical: Math.min(100, tacticalScore + 8),  technical: Math.min(100, technicalScore + 7),  physical: Math.min(100, physicalScore + 10) },
    },
    identity: {
      dominant: technicalScore >= tacticalScore && technicalScore >= physicalScore ? "tecnico"
        : tacticalScore >= physicalScore ? "defensivo" : "fisico",
      distribution: {
        tecnico: technicalScore / 100,
        ofensivo: (dim.eficaciaCompetitiva?.score ?? 5) / 10,
        defensivo: (dim.inteligenciaTactica?.score ?? 5) / 10,
        fisico: physicalScore / 100,
        mixto: 0,
      },
      explanation: `Perfil generado desde ${videoAnalyses.length} análisis de video.`,
    },
    positions: [
      { code: mapPositionToCode(player.position, player.foot) as RoleProfileData["positions"][0]["code"],
        prob: 0.5, score: Math.max(tacticalScore, technicalScore), confidence: 0.65, reason: "Posición registrada — pendiente análisis completo con agente AI" },
    ],
    archetypes: [],
    strengths: ((estadoActual?.fortalezasPrimarias as string[]) ?? []).map(s => ({
      label: s, evidence: "Observado en análisis de video", confidence: 0.7,
    })),
    risks: [{ code: "AGENT_UNAVAILABLE", label: "Perfil parcial", description: "El agente AI no pudo procesar los datos. Este perfil se basa únicamente en las dimensiones del análisis de video." }],
    gaps: ((estadoActual?.areasDesarrollo as string[]) ?? []).map((g, i) => ({
      label: g,
      priority: (i === 0 ? "alta" : "media") as GapItem["priority"],
      relatedPositions: [],
    })),
    consolidation_notes: [`Perfil basado en ${videoAnalyses.length} análisis de video. Para mayor precisión, el agente AI debe estar disponible.`],
    evidence: Object.entries(dimensiones).map(([key, dim]) => ({
      indicator: key,
      label: dim.observacion?.slice(0, 50) ?? key,
      raw_value: dim.score,
      normalized: Math.round((dim.score / 10) * 100),
      reliability: 0.75,
      phase_of_play: "in_possession" as const,
      impact: dim.score >= 7 ? "positivo" as const : dim.score >= 4.5 ? "neutro" as const : "negativo" as const,
      contribution: Math.round(dim.score) / 10,
      positions_impacted: [],
      archetypes_impacted: [],
      explanation: dim.observacion ?? `${key}: ${dim.score}/10`,
    })),
    source_videos: videoAnalyses.map((v) => ({
      video_id:    v.video_id ?? "unknown",
      analyzed_at: v.created_at,
    })),
  };

  const parsed = RoleProfileSchema.safeParse(videoBasedProfile);
  if (parsed.success) return parsed.data as RoleProfileData;

  console.warn("[roleProfileService] Could not build profile from video data");
  return null;
}

// ─── Metrics-only profile (DEPRECATED) ────────────────────────────────────
//
// VITAS no genera informes sin un video real que los respalde.
// La función se conserva temporalmente porque su tipo está referenciado en
// tests legacy · pero no se llama desde producción. Cuando un jugador no
// tiene video, getRoleProfile() devuelve null y el UI muestra empty state.

 
function buildMetricsOnlyProfile(player: Player): RoleProfileData | null {
  const m = player.metrics;
  const tacticalScore = m.vision;
  const technicalScore = Math.round((m.technique + m.shooting) / 2);
  const physicalScore = Math.round((m.speed + m.stamina) / 2);

  const posCode = mapPositionToCode(player.position, player.foot);
  const dominantType: RoleProfileData["identity"]["dominant"] =
    technicalScore >= tacticalScore && technicalScore >= physicalScore ? "tecnico"
    : tacticalScore >= physicalScore ? "defensivo" : "fisico";

  const profile: RoleProfileData = {
    run_id: `run_metrics_${Date.now()}`,
    player_id: player.id,
    player_name: player.name,
    player_age: player.age,
    dominant_foot: footLabel(player.foot),
    minutes_played: player.minutesPlayed,
    competitive_level: player.competitiveLevel || undefined,
    sample_tier: "bronze",
    overall_confidence: 0.35,
    current: { tactical: tacticalScore, technical: technicalScore, physical: physicalScore },
    projections: {
      "0_6m":   { tactical: Math.min(100, tacticalScore + 1), technical: Math.min(100, technicalScore + 1), physical: Math.min(100, physicalScore + 2) },
      "6_18m":  { tactical: Math.min(100, tacticalScore + 3), technical: Math.min(100, technicalScore + 3), physical: Math.min(100, physicalScore + 5) },
      "18_36m": { tactical: Math.min(100, tacticalScore + 5), technical: Math.min(100, technicalScore + 5), physical: Math.min(100, physicalScore + 8) },
    },
    identity: {
      dominant: dominantType,
      distribution: {
        tecnico: technicalScore / 100,
        ofensivo: m.shooting / 100,
        defensivo: m.defending / 100,
        fisico: physicalScore / 100,
        mixto: 0,
      },
      explanation: "Perfil estimado a partir de métricas manuales. Sube un video para un análisis más preciso.",
    },
    positions: [
      {
        code: posCode as RoleProfileData["positions"][0]["code"],
        prob: 0.4,
        score: Math.max(tacticalScore, technicalScore, physicalScore),
        confidence: 0.35,
        reason: "Posición registrada — sin análisis de video disponible",
      },
    ],
    archetypes: [],
    strengths: buildStrengthsFromMetrics(m),
    risks: [
      {
        code: "NO_VIDEO_ANALYSIS",
        label: "Sin análisis de video",
        description: "Este perfil se basa solo en métricas manuales. Genera un informe VITAS Intelligence para mayor precisión.",
      },
    ],
    gaps: buildGapsFromMetrics(m),
    consolidation_notes: [
      "Perfil basado en métricas manuales, sin análisis de video.",
      "Confianza: Bronce (35%). Sube un video para subir a Plata o superior.",
    ],
    evidence: [],
  };

  const parsed = RoleProfileSchema.safeParse(profile);
  if (parsed.success) return parsed.data as RoleProfileData;

  console.warn("[roleProfileService] Metrics-only profile validation failed");
  return null;
}

/**
 * Map Spanish position to position code.
 * Respeta la lateralidad declarada en el nombre de posición + el pie hábil.
 *
 * Ejemplos:
 *   "Lateral Izquierdo" + foot=any → LB
 *   "Lateral Derecho"   + foot=any → RB
 *   "Lateral"           + foot=left → LB (deduce por pie)
 *   "Lateral"           + foot=right → RB
 *   "Lateral"           + foot=both → RB (default)
 *   "Central Izquierdo" → LCB
 *   "Mediocentro"       → RCM
 *   "Extremo Izquierdo" → LW
 */
function mapPositionToCode(position: string, foot?: "right" | "left" | "both"): string {
  const lower = position.toLowerCase();

  // Detectar lateralidad explícita en el nombre
  const isLeft  = lower.includes("izquierd") || /\b(?:l|li|lb|lcb|lw|lm)\b/.test(lower);
  const isRight = lower.includes("derech")   || /\b(?:r|rd|rb|rcb|rw|rm)\b/.test(lower);

  // Si no hay lateralidad declarada, usar pie hábil como pista
  const sideHint: "L" | "R" =
    isLeft ? "L" :
    isRight ? "R" :
    foot === "left" ? "L" : "R";

  if (lower.includes("portero")) return "GK";
  if (lower.includes("central")) return sideHint === "L" ? "LCB" : "RCB";
  if (lower.includes("lateral")) return sideHint === "L" ? "LB"  : "RB";
  if (lower.includes("carrilero")) return sideHint === "L" ? "LWB" : "RWB";
  if (lower.includes("pivote")) return "DM";
  if (lower.includes("interior")) return sideHint === "L" ? "LCM" : "RCM";
  if (lower.includes("mediocent") || lower.includes("mc")) return sideHint === "L" ? "LCM" : "RCM";
  if (lower.includes("mediopunta") || lower.includes("cam") || lower.includes("enganche")) return "CAM";
  if (lower.includes("extremo") || lower.includes("banda")) return sideHint === "L" ? "LW" : "RW";
  if (lower.includes("delantero") || lower.includes("punta") || lower.includes("9")) return "ST";
  return "RCM";
}

/** Extract strengths from player metrics (top 2 metrics > 65) */
function buildStrengthsFromMetrics(m: Player["metrics"]) {
  const entries = [
    { key: "speed", label: "Velocidad", value: m.speed },
    { key: "technique", label: "Técnica", value: m.technique },
    { key: "vision", label: "Visión de juego", value: m.vision },
    { key: "stamina", label: "Resistencia", value: m.stamina },
    { key: "shooting", label: "Disparo", value: m.shooting },
    { key: "defending", label: "Defensa", value: m.defending },
  ];
  return entries
    .filter(e => e.value >= 65)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map(e => ({
      label: e.label,
      evidence: `Métrica manual: ${e.value}/100`,
      confidence: 0.4,
    }));
}

/** Extract gaps from player metrics (bottom 2 metrics < 45) */
function buildGapsFromMetrics(m: Player["metrics"]): GapItem[] {
  const entries = [
    { key: "speed", label: "Velocidad", value: m.speed },
    { key: "technique", label: "Técnica", value: m.technique },
    { key: "vision", label: "Visión de juego", value: m.vision },
    { key: "stamina", label: "Resistencia", value: m.stamina },
    { key: "shooting", label: "Disparo", value: m.shooting },
    { key: "defending", label: "Defensa", value: m.defending },
  ];
  return entries
    .filter(e => e.value < 45)
    .sort((a, b) => a.value - b.value)
    .slice(0, 2)
    .map((e, i) => ({
      label: e.label,
      priority: (i === 0 ? "alta" : "media") as GapItem["priority"],
      relatedPositions: [],
    }));
}

// ─── Position Override ──────────────────────────────────────────────────

/**
 * Position-to-capability weight map.
 * Each position emphasizes different capability dimensions.
 * Weights sum to ~1.0 and modulate the profile when a user overrides the position.
 */
const POSITION_CAPABILITY_WEIGHTS: Record<string, { tactical: number; technical: number; physical: number }> = {
  GK:  { tactical: 0.30, technical: 0.30, physical: 0.40 },
  RB:  { tactical: 0.25, technical: 0.25, physical: 0.50 },
  RCB: { tactical: 0.35, technical: 0.20, physical: 0.45 },
  LCB: { tactical: 0.35, technical: 0.20, physical: 0.45 },
  LB:  { tactical: 0.25, technical: 0.25, physical: 0.50 },
  DM:  { tactical: 0.45, technical: 0.25, physical: 0.30 },
  RCM: { tactical: 0.35, technical: 0.35, physical: 0.30 },
  LCM: { tactical: 0.35, technical: 0.35, physical: 0.30 },
  CAM: { tactical: 0.30, technical: 0.45, physical: 0.25 },
  RW:  { tactical: 0.20, technical: 0.40, physical: 0.40 },
  LW:  { tactical: 0.20, technical: 0.40, physical: 0.40 },
  ST:  { tactical: 0.25, technical: 0.35, physical: 0.40 },
};

/**
 * Recalculates a role profile with a user-selected position override.
 * - Moves the chosen position to #1 with boosted score
 * - Adjusts position fit scores relative to capability alignment
 * - Recalculates identity distribution based on position weights
 * - Returns a new profile object (does NOT mutate the original)
 */
export function recalculateWithPosition(
  profile: RoleProfileData,
  positionCode: string,
): RoleProfileData {
  const weights = POSITION_CAPABILITY_WEIGHTS[positionCode] ?? POSITION_CAPABILITY_WEIGHTS.RCM;
  const { tactical, technical, physical } = profile.current;

  // Weighted fit score for the overridden position
  const fitScore = Math.round(
    tactical * weights.tactical +
    technical * weights.technical +
    physical * weights.physical
  );

  // Build new positions array: forced position first, then existing (excluding the forced one)
  const existingOther = profile.positions.filter(p => p.code !== positionCode);
  const forcedPosition: PositionFit = {
    code: positionCode as PositionFit["code"],
    prob: Math.min(1, fitScore / 100 + 0.1),
    score: Math.min(100, fitScore + 5),
    confidence: Math.max(profile.overall_confidence, 0.5),
    reason: `Posición seleccionada manualmente por el usuario`,
  };

  // Recalculate identity distribution emphasizing chosen position's weights
  const newDistribution: Record<string, number> = {
    tecnico: technical / 100 * (1 + weights.technical),
    ofensivo: (technical * 0.5 + physical * 0.5) / 100 * (1 + weights.physical * 0.5),
    defensivo: tactical / 100 * (1 + weights.tactical),
    fisico: physical / 100 * (1 + weights.physical),
    mixto: 0,
  };
  // Normalize to sum=1
  const distSum = Object.values(newDistribution).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(newDistribution)) {
    newDistribution[k] = Math.round((newDistribution[k] / distSum) * 100) / 100;
  }
  const dominant = Object.entries(newDistribution).sort((a, b) => b[1] - a[1])[0][0] as RoleProfileData["identity"]["dominant"];

  return {
    ...profile,
    run_id: `${profile.run_id}_pos_${positionCode}`,
    positions: [forcedPosition, ...existingOther.slice(0, 4)],
    identity: {
      dominant,
      distribution: newDistribution as RoleProfileData["identity"]["distribution"],
      explanation: `${profile.identity.explanation} (posición manual: ${positionCode})`,
    },
    consolidation_notes: [
      ...profile.consolidation_notes,
      `Perfil recalculado con posición forzada: ${positionCode}`,
    ],
  };
}

/**
 * GET /api/player/:id/position-fit
 */
export async function fetchPositionFit(playerId: string): Promise<PositionFit[]> {
  const profile = await fetchRoleProfile(playerId);
  return profile?.positions ?? [];
}

/**
 * GET /api/player/:id/archetypes
 */
export async function fetchArchetypes(playerId: string): Promise<ArchetypeFit[]> {
  const profile = await fetchRoleProfile(playerId);
  return profile?.archetypes ?? [];
}

/**
 * GET /api/player/:id/role-profile/audit/:run_id
 */
export async function fetchAuditIndicators(playerId: string, _runId?: string): Promise<EvidenceIndicator[]> {
  const profile = await fetchRoleProfile(playerId);
  return profile?.evidence ?? [];
}
