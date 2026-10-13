// ─── Types ───────────────────────────────────────────────────────────────

export type SampleTier = "bronze" | "silver" | "gold" | "platinum";
export type IdentityType = "ofensivo" | "defensivo" | "tecnico" | "fisico" | "mixto";
export type StabilityLevel = "emergente" | "en_desarrollo" | "estable" | "consolidado";
export type PhaseOfPlay = "in_possession" | "out_of_possession" | "transition";
export type RiskCode = string;

export const POSITION_CODES = ["GK","RB","RCB","LCB","LB","DM","RCM","LCM","RW","LW","ST"] as const;
export type PositionCode = typeof POSITION_CODES[number];

export const POSITION_LABELS: Record<PositionCode, string> = {
  GK: "Portero", RB: "Lateral Derecho", RCB: "Central Derecho", LCB: "Central Izquierdo",
  LB: "Lateral Izquierdo", DM: "Mediocentro Defensivo", RCM: "Interior Derecho",
  LCM: "Interior Izquierdo", RW: "Extremo Derecho", LW: "Extremo Izquierdo", ST: "Delantero Centro",
};

export const ARCHETYPE_CODES = [
  "recuperador","interceptor","corrector","organizador","filtrador","lanzador",
  "progresor_pase","progresor_conduccion","desbordador","llegador","box_to_box",
  "carrilero","pivote_posicional","interior_creativo","extremo_1v1","extremo_espacio",
  "finalizador","9_fijador","segundo_punta","presionante",
] as const;
export type ArchetypeCode = typeof ARCHETYPE_CODES[number];

export const ARCHETYPE_LABELS: Record<ArchetypeCode, string> = {
  recuperador: "Recuperador", interceptor: "Interceptor", corrector: "Corrector",
  organizador: "Organizador", filtrador: "Filtrador", lanzador: "Lanzador",
  progresor_pase: "Progresor por pase", progresor_conduccion: "Progresor por conducción",
  desbordador: "Desbordador", llegador: "Llegador", box_to_box: "Box-to-Box",
  carrilero: "Carrilero", pivote_posicional: "Pivote posicional",
  interior_creativo: "Interior creativo", extremo_1v1: "Extremo 1v1",
  extremo_espacio: "Extremo al espacio", finalizador: "Finalizador",
  "9_fijador": "9 Fijador", segundo_punta: "Segundo punta", presionante: "Presionante",
};

export interface CapabilityScores {
  tactical: number;
  technical: number;
  physical: number;
}

export interface PositionFit {
  code: PositionCode;
  prob: number;
  score: number;
  confidence: number;
  reason: string;
}

export interface ArchetypeFit {
  code: ArchetypeCode;
  score: number;
  confidence: number;
  stability: StabilityLevel;
  positions?: PositionCode[];
}

export interface EvidenceIndicator {
  indicator: string;
  label: string;
  raw_value: number;
  normalized: number;
  reliability: number;
  phase_of_play: PhaseOfPlay;
  impact: "positivo" | "neutro" | "negativo";
  contribution: number;
  positions_impacted: PositionCode[];
  archetypes_impacted: ArchetypeCode[];
  explanation: string;
}

export interface StrengthItem {
  label: string;
  evidence: string;
  confidence: number;
}

export interface GapItem {
  label: string;
  priority: "alta" | "media" | "baja";
  relatedPositions: PositionCode[];
}

export interface RoleProfileData {
  run_id: string;
  player_id: string;
  player_name: string;
  player_age: number;
  /** Sin pie registrado ⇒ ausente (no se asume diestro). */
  dominant_foot?: "derecho" | "izquierdo" | "ambidiestro";
  minutes_played: number;
  /** Sin nivel elegido ⇒ ausente (no se asume «Regional»). */
  competitive_level?: string;
  sample_tier: SampleTier;
  overall_confidence: number;
  current: CapabilityScores;
  identity: {
    dominant: IdentityType;
    distribution: Record<IdentityType, number>;
    explanation: string;
  };
  positions: PositionFit[];
  archetypes: ArchetypeFit[];
  projections: {
    "0_6m": CapabilityScores;
    "6_18m": CapabilityScores;
    "18_36m": CapabilityScores;
  };
  strengths: StrengthItem[];
  risks: { code: RiskCode; label: string; description: string }[];
  gaps: GapItem[];
  consolidation_notes: string[];
  evidence: EvidenceIndicator[];
  /** Videos fuente del informe · TODO informe DEBE tener al menos uno · vacío = informe inválido */
  source_videos?: Array<{
    video_id: string;
    analyzed_at: string; // ISO
    duration_min?: number;
  }>;
}

// ─── Mock data REMOVED ──────────────────────────────────────────────────
// mockRoleProfile with fake "Lucas Moreno" data has been removed.
// The app must only show real player data from video analyses or return null.
// Mock data for tests lives in src/test/ files only.

// ─── Helpers ─────────────────────────────────────────────────────────────

export function getConfidenceLabel(c: number): string {
  if (c >= 0.85) return "Alta";
  if (c >= 0.70) return "Media-Alta";
  if (c >= 0.55) return "Media";
  if (c >= 0.40) return "Media-Baja";
  return "Baja";
}

export function getConfidenceColor(c: number): string {
  if (c >= 0.85) return "text-primary";
  if (c >= 0.70) return "text-electric";
  if (c >= 0.55) return "text-gold";
  if (c >= 0.40) return "text-orange-400";
  return "text-danger";
}

export function getSampleTierLabel(t: SampleTier): string {
  const map: Record<SampleTier, string> = {
    bronze: "Bronce — muestra limitada",
    silver: "Plata — muestra moderada",
    gold: "Oro — muestra sólida",
    platinum: "Platino — muestra robusta",
  };
  return map[t];
}

export function getSampleTierColor(t: SampleTier): string {
  const map: Record<SampleTier, string> = {
    bronze: "text-orange-400",
    silver: "text-muted-foreground",
    gold: "text-gold",
    platinum: "text-primary",
  };
  return map[t];
}

export function getStabilityLabel(s: StabilityLevel): string {
  const map: Record<StabilityLevel, string> = {
    emergente: "Emergente",
    en_desarrollo: "En desarrollo",
    estable: "Estable",
    consolidado: "Consolidado",
  };
  return map[s];
}

export function getPhaseLabel(p: PhaseOfPlay): string {
  const map: Record<PhaseOfPlay, string> = {
    in_possession: "En posesión",
    out_of_possession: "Sin posesión",
    transition: "Transición",
  };
  return map[p];
}
