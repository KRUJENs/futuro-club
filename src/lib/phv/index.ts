/**
 * VITAS · PHV como producto (Sprint 2) — public API
 */
export { computeMirwald, canComputeMirwald } from "./mirwald";
export type { MirwaldInput, MirwaldResult } from "./mirwald";

export { projectToMaturity } from "./projection";
export type { MaturityProjection, ProjectionPoint } from "./projection";

// Bio-banding por % de talla adulta (Khamis-Roche + bandas Cumming 2017; P2 bloque 9, D10).
// El viejo bioBanding.ts (edad + offset) se retiró.
export { squadBioBands, BIO_BAND_ORDER, BIO_BAND_THRESHOLDS } from "./squadBioBanding";
export type { BioBandKey, BandedPlayer, UnbandedPlayer, SquadBioBands } from "./squadBioBanding";

export { assessGrowthSpurtShield } from "./growthSpurtShield";
export type { GrowthSpurtShield, ShieldLevel } from "./growthSpurtShield";
