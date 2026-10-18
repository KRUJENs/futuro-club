/**
 * Planes IDP ANTIGUOS (P1 bloque 7): los generados antes del bloque 5d (#320, fusionado
 * 2026-10-15 10:09 UTC) podían traer 0 metas con un «foco del mes» inventado o la
 * evaluación del entrenador copiada como punto de partida de cada meta, y los ven los
 * padres. No se borran: se avisa. Un plan escrito por el entrenador (generated_by
 * 'coach') no lleva aviso.
 */

/** Primera versión del prompt sin defaults (5d) y fecha de fusión de #320 (procedencia). */
export const IDP_LEGACY_CUTOFF = {
  version: [1, 3, 0] as const,
  deterministicBefore: "2026-10-15T10:09:34Z",
};

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionBefore(a: number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export function isLegacyIdpPlan(p: {
  generatedBy?: string | null;
  agentVersion?: string | null;
  createdAt?: string | null;
}): boolean {
  if (p.generatedBy === "coach") return false;
  const v = p.agentVersion ?? "";
  const parsed = parseVersion(v);
  if (parsed) return versionBefore(parsed, IDP_LEGACY_CUTOFF.version);
  // Determinista (misma etiqueta antes y después del 5d) o sin versión: por fecha.
  const created = Date.parse(p.createdAt ?? "");
  if (!Number.isFinite(created)) return true; // sin fecha ni versión: avisa de más, nunca de menos
  return created < Date.parse(IDP_LEGACY_CUTOFF.deterministicBefore);
}
