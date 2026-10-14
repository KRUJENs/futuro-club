/**
 * VITAS · Compuesto ponderado honesto (P1 bloque 4b)
 *
 * Una sola implementación (inv #7) de «combinar factores con pesos SIN rellenar
 * los que faltan»: se usa en el riesgo de lesión y la reutilizará la valoración
 * (bloque 5). Reglas (las mismas que el VSI de vídeo, G4):
 *   - un factor ausente (value null) NO entra como 0 ni como media: se excluye y
 *     los pesos se renormalizan sobre los presentes;
 *   - un factor que NO aplica (p. ej. ventana PHV en un adulto) sale del peso
 *     aplicable (no cuenta como ausente);
 *   - sin los factores OBLIGATORIOS (si aplican) o por debajo de la cobertura
 *     mínima del peso aplicable, el compuesto es null con su motivo.
 * Lógica pura, sin dependencias: corre en el navegador y en Edge.
 */

export interface CompositeFactor<K extends string = string> {
  key: K;
  weight: number;
  /** false ⇒ no aplica a este jugador: fuera del peso aplicable. */
  applicable: boolean;
  /** 0-100; null ⇒ ausente. */
  value: number | null;
}

export interface CompositeResult<K extends string = string> {
  /** 0-100 renormalizado sobre los presentes; null si no se puede componer. */
  value: number | null;
  /** Fracción del peso APLICABLE con dato (0-1). */
  coverage: number;
  present: K[];
  missing: K[];
  gate_reason: string | null;
}

export function weightedComposite<K extends string>(
  factors: readonly CompositeFactor<K>[],
  opts: { minCoverage: number; mandatory?: readonly K[]; label?: (k: K) => string },
): CompositeResult<K> {
  const label = opts.label ?? ((k: K) => k);
  const applicable = factors.filter((f) => f.applicable && f.weight > 0);
  const present = applicable.filter((f) => f.value !== null && Number.isFinite(f.value));
  const missing = applicable.filter((f) => !present.includes(f));
  const applicableWeight = applicable.reduce((s, f) => s + f.weight, 0);
  const presentWeight = present.reduce((s, f) => s + f.weight, 0);
  const coverage = applicableWeight > 0 ? presentWeight / applicableWeight : 0;
  const base = {
    coverage,
    present: present.map((f) => f.key),
    missing: missing.map((f) => f.key),
  };

  const missingMandatory = (opts.mandatory ?? []).filter((k) => missing.some((f) => f.key === k));
  if (missingMandatory.length > 0) {
    return {
      ...base,
      value: null,
      gate_reason: `Falta un dato imprescindible: ${missingMandatory.map(label).join(", ")}.`,
    };
  }
  if (present.length === 0 || coverage < opts.minCoverage) {
    return {
      ...base,
      value: null,
      gate_reason:
        `Datos insuficientes: solo hay dato para el ${Math.round(coverage * 100)} % del peso ` +
        `(mínimo ${Math.round(opts.minCoverage * 100)} %). Faltan: ${missing.map((f) => label(f.key)).join(", ")}.`,
    };
  }
  const raw = present.reduce((s, f) => s + (f.value as number) * f.weight, 0) / presentWeight;
  return { ...base, value: Math.max(0, Math.min(100, Math.round(raw))), gate_reason: null };
}
