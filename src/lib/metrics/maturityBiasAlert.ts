/**
 * VITAS · Aviso de sesgo madurativo de la lista de jugadores del panel Master (`/master`).
 *
 * Sale SOLO de la maduración canónica con el gate abierto y confianza suficiente
 * (`gatedMaturity`, sin tocar el PHV — inv #4):
 *   - madurador tardío ⇒ "high" (talento que se puede estar infravalorando),
 *   - madurador precoz ⇒ "low",
 *   - a tiempo         ⇒ "med".
 * Sin maduración firme ⇒ `null`, y la UI pinta el motivo (inv #2). Antes caía a «MED BIAS
 * ALERT» por defecto, y con un percentil de la evaluación del entrenador > 70 a «LOW BIAS»:
 * ese corte no tenía fuente y el percentil no mide maduración (P1 bloque 6, revisión #322).
 */
import { gatedMaturity } from "@/lib/phv/phvGate";

export type MaturityBiasAlert = "low" | "med" | "high";

type GateInput = Parameters<typeof gatedMaturity>[0];

export function maturityBiasAlert(player: GateInput, at?: string | Date): MaturityBiasAlert | null {
  const mat = gatedMaturity(player, at);
  const firm = mat.confidence === "high" || mat.confidence === "moderate";
  if (!firm) return null;
  if (mat.timing === "late") return "high";
  if (mat.timing === "early") return "low";
  if (mat.timing === "on_time") return "med";
  return null;
}
