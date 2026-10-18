/**
 * VITAS · usePHVProduct — el PHV como producto por jugador (Sprint 2)
 *
 * Compone (client-side, sin IA, sin Supabase) desde los datos antropométricos
 * que el jugador ya tiene:
 *   - Mirwald offset + edad del estirón (APHV)
 *   - Estado de maduración vs pares (madurador tardío/precoz/en fase)
 *   - VSI ajustado por maduración + proyección a madurez
 *   - Escudo de Estirón (riesgo PHV × lesión)
 *
 * GATE ÚNICO (src/lib/phv/phvGate.ts · regla del owner 28-sep): el producto PHV
 * solo existe con TODAS las entradas introducidas — talla, peso, talla sentado,
 * pierna (o talla − sentado), edad DECIMAL desde la fecha de nacimiento y sexo
 * registrado. Si falta cualquiera, `usePHVProduct` devuelve null y `usePHVGate`
 * expone el motivo (qué falta) para que la ficha lo nombre en vez de callar.
 * Antes bastaban las alturas de los padres (Khamis-Roche) para mostrar un PHV con
 * pierna ESTIMADA (×0.48) y la edad ENTERA: eso ya no ocurre.
 */
import { useMemo } from "react";
import { useRawPlayerById } from "@/hooks/usePlayers";
import {
  projectToMaturity,
  assessGrowthSpurtShield,
  type MirwaldResult,
  type MaturityProjection,
  type GrowthSpurtShield,
} from "@/lib/phv";
import { phvGate, pahGate, type PhvGate, type PahGate, type PhvGateInput } from "@/lib/phv/phvGate";
import type { MaturityAssessment } from "@/lib/phv/maturity";

export interface PHVProduct {
  /** Evaluación canónica (fuente ÚNICA para la UI: fase de Mirwald/timing/APHV). */
  assessment: MaturityAssessment;
  /** %talla adulta (Khamis-Roche): métrica APARTE con su propio gate; no decide la fase. */
  pah: PahGate;
  mirwald: MirwaldResult;
  /** Proyección a madurez: null sin VSI real (no se proyecta desde un percentil inventado). */
  projection: MaturityProjection | null;
  shield: GrowthSpurtShield;
  /** VSI crudo del jugador (si existe). */
  rawVSI: number | null;
  /** VSI ajustado por maduración (factor gateado: 1 si el timing no es firme). */
  adjustedVSI: number | null;
  playerName: string;
}

export interface PHVGateState {
  /** null mientras el jugador no ha cargado. */
  gate: PhvGate | null;
  /** %talla adulta (Khamis-Roche): métrica aparte, con su propio gate. */
  pah: PahGate | null;
  product: PHVProduct | null;
  /** «M» guardado sin confirmar (P1 bloque 7): el gate lo trata como sexo ausente. */
  sexPending: boolean;
}

/** Convierte un VSI 0-100 a un percentil aproximado (proxy si no hay percentil real). */
function vsiToPercentile(vsi: number): number {
  return Math.max(1, Math.min(99, Math.round(vsi)));
}

export function usePHVGate(playerId: string | undefined): PHVGateState {
  const { data: player } = useRawPlayerById(playerId);

  return useMemo(() => {
    if (!player) return { gate: null, pah: null, product: null, sexPending: false };
    const p = player as unknown as Record<string, unknown> & PhvGateInput;
    const sexPending = p.sexPendingConfirmation === true;
    const gate = phvGate(p);
    const pah = pahGate(p);
    if (!gate.ok) return { gate, pah, product: null, sexPending };

    const assessment = gate.assessment;
    const mirwald = gate.mirwald; // 4 medidas introducidas ⇒ estimated === false

    const rawVSI = typeof p.vsi === "number" ? p.vsi : null;
    // Sin VSI real no hay percentil del que proyectar (antes se proyectaba desde 50).
    const projection = rawVSI != null ? projectToMaturity(vsiToPercentile(rawVSI), assessment, gate.ageYears) : null;
    // Escudo con el offset de Mirwald sobre medidas introducidas (nunca estimadas).
    const shield = assessGrowthSpurtShield(mirwald.offset, String(p.name ?? "el jugador"));

    // VSI ajustado con el factor CANÓNICO (1 cuando el timing no es firme →
    // no infla/penaliza sin base; blindaje anti-falso-positivo).
    const adjustedVSI =
      rawVSI != null
        ? Math.max(0, Math.min(100, Number((rawVSI * assessment.adjustmentFactor).toFixed(1))))
        : null;

    return {
      gate,
      pah,
      product: {
        assessment,
        pah,
        mirwald,
        projection,
        shield,
        rawVSI,
        adjustedVSI,
        playerName: String(p.name ?? "Jugador"),
      },
      sexPending,
    };
  }, [player]);
}

export function usePHVProduct(playerId: string | undefined): PHVProduct | null {
  return usePHVGate(playerId).product;
}
