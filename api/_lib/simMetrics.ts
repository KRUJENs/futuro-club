/**
 * VITAS · Derivación de las métricas de similarity a partir de OBSERVACIONES REALES
 * del vídeo (docx #14 · P3).
 *
 * Antes, 4 de las 6 dimensiones del "comparable profesional" eran constantes
 * hardcoded (technique:65, mental:60, tactical:55) pasadas como si fueran medidas
 * → violaba el invariante #1 (CONSTANTE haciéndose pasar por MEDIDA/DERIVADA) y
 * hacía que los comparables salieran genéricos.
 *
 * Enfoque HÍBRIDO honesto:
 *   - Si el análisis trae eventos observados (eventosContados de Gemini o
 *     eventSummary del cliente) → se DERIVAN las dims de esos eventos. Se usan
 *     RATIOS reales autonormalizados donde existen (precisión de pase, % de disparos
 *     a puerta). Sin duelos (P1 bloque 6: sin criterio validado, src/lib/tracking/duels.ts).
 *     Las dims sin ratio (visión, volumen defensivo) usan normalizaciones por volumen marcadas "pendiente de validar"
 *     → el caller reduce la confianza.
 *   - Si NO hay eventos → devuelve null: el caller SE ABSTIENE (no genera comparable,
 *     no fabrica un 6-D con constantes). Abstención = resultado válido (invariante #3).
 *
 * Nota: estas métricas alimentan SOLO al motor de similarity (comparable pro), NO
 * al VSI compuesto — no mueven el VSI global de la app.
 */

import { stripDuelOutcomes } from "../../src/lib/tracking/duels";

export interface SimMetrics {
  speed: number;
  shooting: number;
  vision: number;
  technique: number;
  defending: number;
  stamina: number;
}

export interface SimDerivation {
  metrics: SimMetrics;
  source: "gemini" | "client";
  /** Dims derivadas de un RATIO real observado (autonormalizado). Las demás usan
   *  proxies de volumen "pendiente de validar" o la base física. Cuanto mayor,
   *  más fiable el comparable. */
  ratioDerivedDims: number;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Conteo observado o null. Gemini: 0 = "lo vio y no ocurrió"; null = "no pudo
 *  observarlo" → nunca se convierte en 0 (invariante #2). */
const obsNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Suma de los componentes observados; null si no se observó ninguno. */
const sumObserved = (...vs: Array<number | null>): number | null => {
  const seen = vs.filter((v): v is number => v !== null);
  return seen.length > 0 ? seen.reduce((a, b) => a + b, 0) : null;
};

// Normalizaciones por VOLUMEN — "pendiente de validar" (no hay literatura/umbral
// medido detrás). Cuántos eventos ≈ "100" en una escala 0-100 por vídeo. Deliberadamente
// conservadoras; el caller marca la similarity como derivada + baja confianza.
const SCAN_FULL = 25;   // escaneos por vídeo para saturar "visión"
const PROG_FULL = 12;   // pases progresivos para saturar
const DEFVOL_FULL = 12; // recuperaciones+robos+anticipaciones para saturar "volumen defensivo"
const REC_FULL = 12;    // recoveries (path cliente)
// Muestra mínima para que un ratio (%) se use y cuente como fiable: evita que un
// n=1 (1 disparo → 100%) se trate como un ratio real (revisión #178).
const MIN_SAMPLE = 3;

/**
 * Deriva las 6 métricas de similarity. `physicalValue` es la señal física real
 * (biomecánica) si existe; si no, las dims físicas quedan neutras (50) y NO cuentan
 * como ratio-derivadas. Devuelve null si no hay eventos observados (→ abstención).
 */
export function deriveSimMetrics(
  videoObservations: unknown,
  physicalValue: number | null,
): SimDerivation | null {
  const obs = videoObservations as
    | { gemini?: { eventosContados?: Record<string, unknown> } | null; eventSummary?: Record<string, unknown> | null }
    | null;
  // Sin duelos (P1 bloque 6): ni cuentan como dim ni como «hay eventos» (un análisis
  // antiguo con solo duelos no fabrica un comparable de 50s).
  const ecRaw = stripDuelOutcomes(obs?.gemini?.eventosContados ?? null);
  const es = stripDuelOutcomes(obs?.eventSummary ?? null);
  // Abstención por CONTENIDO, no solo por presencia: un {} o un todo-ceros NO es señal
  // (evita fabricar un comparable "neutro" de 50s desde un objeto vacío — revisión #178).
  const ecHasEvents = ecRaw ? Object.values(ecRaw).some((v) => num(v) > 0) : false;
  const esHasEvents = es
    ? ["totalEvents", "passesAttempted", "passesCompleted", "recoveries", "shots"].some(
        (k) => num((es as Record<string, unknown>)[k]) > 0,
      )
    : false;
  if (!ecHasEvents && !esHasEvents) return null;
  const ec = ecHasEvents ? ecRaw : null;

  const physBase = physicalValue != null ? clamp(physicalValue) : 50;
  let ratioDerivedDims = physicalValue != null ? 1 : 0; // la física cuenta si es real

  let technique: number, vision: number, defending: number, shooting: number;
  let source: "gemini" | "client";

  if (ec) {
    source = "gemini";
    // Cada ratio exige que sus DOS componentes se hayan observado; un volumen usa solo
    // lo observado. Si falta, la dim cae al fallback neutro de este módulo y NO cuenta
    // como ratio-derivada (antes null→0 hundía la dim como si se hubiera observado 0).
    const ratio = (hit: number | null, miss: number | null): { tot: number; pct: number } | null =>
      hit !== null && miss !== null && hit + miss >= MIN_SAMPLE ? { tot: hit + miss, pct: (hit / (hit + miss)) * 100 } : null;
    // technique ← precisión de pase (ratio real) + éxito en regate (ratio real)
    const passR = ratio(obsNum(ec.pasesCompletados), obsNum(ec.pasesFallados));
    const dribR = ratio(obsNum(ec.regatesConVentaja), obsNum(ec.regatesSinVentaja));
    const techParts = [passR?.pct ?? null, dribR?.pct ?? null].filter((v): v is number => v != null);
    technique = techParts.length > 0 ? clamp(techParts.reduce((a, b) => a + b, 0) / techParts.length) : 50;
    if (techParts.length > 0) ratioDerivedDims++;
    // defending ← volumen de acciones defensivas (sin ratio → no cuenta como ratio-derivada).
    // Antes: % de duelos ganados (60 %) — sin criterio validado de duelo (P1 bloque 6).
    const defRaw = sumObserved(obsNum(ec.recuperaciones), obsNum(ec.robos), obsNum(ec.anticipaciones));
    const defVol = defRaw !== null ? Math.min(100, (defRaw / DEFVOL_FULL) * 100) : null;
    defending = defVol !== null ? clamp(defVol) : 50;
    // shooting ← % disparos a puerta (ratio real)
    const shotR = ratio(obsNum(ec.disparosAlArco), obsNum(ec.disparosFuera));
    shooting = shotR ? clamp(shotR.pct) : clamp(technique * 0.7);
    if (shotR) ratioDerivedDims++;
    // vision ← volumen de escaneo + pases progresivos (proxies, sin ratio → pendiente de validar)
    const scans = obsNum(ec.escaneos);
    const prog = obsNum(ec.pasesProgresivos);
    const scanScore = scans !== null ? Math.min(100, (scans / SCAN_FULL) * 100) : null;
    const progScore = prog !== null ? Math.min(100, (prog / PROG_FULL) * 100) : null;
    vision = scanScore !== null && progScore !== null
      ? clamp(scanScore * 0.6 + progScore * 0.4)
      : scanScore !== null ? clamp(scanScore)
      : progScore !== null ? clamp(progScore)
      : clamp(technique * 0.8); // mismo fallback que la ruta cliente sin señal de visión
  } else {
    source = "client";
    // technique ← passCompletionPct (ratio real, ya 0-100)
    const passPct = es!.passCompletionPct;
    technique = typeof passPct === "number" ? clamp(passPct) : 50;
    if (typeof passPct === "number") ratioDerivedDims++;
    // defending ← recoveries (volumen). Sin % de duelos (P1 bloque 6): el ganador nunca se
    // resolvía en el cliente (siempre 0/0) y no hay criterio validado.
    const recVol = Math.min(100, (num(es!.recoveries) / REC_FULL) * 100);
    defending = clamp(recVol);
    // shooting ← xG por disparo (proxy) — pendiente de validar
    const shots = num(es!.shots);
    shooting = shots > 0 ? clamp(Math.min(100, 40 + num(es!.xgContributions) * 60)) : clamp(technique * 0.7);
    // vision ← vaepApprox (proxy value-added) — pendiente de validar
    const vaep = es!.vaepApprox;
    vision = typeof vaep === "number" ? clamp(Math.max(0, Math.min(100, 50 + vaep * 10))) : clamp(technique * 0.8);
  }

  return {
    metrics: { speed: physBase, stamina: physBase, shooting, vision, technique, defending },
    source,
    ratioDerivedDims,
  };
}
