/**
 * VITAS · Sexo registrado — regla ÚNICA de qué sexo entra al cálculo de maduración
 * (P1 bloque 7, punto 11; invariantes #5 y #7).
 *
 * La migración 024 y el cliente/API anteriores al 20 ago metían «M» POR DEFECTO, y
 * la edición del jugador prellenaba ese valor: un «M» guardado sin más no prueba que
 * alguien lo eligiera. Por eso:
 *  - «F» cuenta siempre (nunca fue valor por defecto);
 *  - «M» solo cuenta con la marca `sexConfirmedAt` (fecha ISO), que escriben ÚNICAMENTE
 *    los selectores donde una persona elige el sexo (alta, edición, asistente, onboarding
 *    y «Confirmar sexo» de la ficha). Decisión del dueño 18 oct (D1): TODO «M» sin marca
 *    queda «por confirmar» y su PHV bloqueado hasta confirmarlo.
 * Se marca lo confirmado, no lo antiguo: una copia rancia que se vuelva a subir (cola de
 * sincronización, PWA en caché) sigue contando como pendiente.
 *
 * No toca el módulo PHV (inv #4): solo decide QUÉ entra (excepción G6). Edge-safe: sin
 * alias `@/`, importable desde api/ y src/.
 */

export type RegisteredSex = "M" | "F";

interface SexFields {
  gender?: unknown;
  sexConfirmedAt?: unknown;
}

function validConfirmation(v: unknown): boolean {
  return typeof v === "string" && v.length >= 10 && Number.isFinite(Date.parse(v));
}

/** Sexo que puede entrar al cálculo; null = ausente o «M» sin confirmar. */
export function registeredSex(p: SexFields | null | undefined): RegisteredSex | null {
  if (!p) return null;
  if (p.gender === "F") return "F";
  if (p.gender === "M" && validConfirmation(p.sexConfirmedAt)) return "M";
  return null;
}

/** «M» guardado sin confirmar (valor por defecto antiguo posible). */
export function sexPendingConfirmation(p: SexFields | null | undefined): boolean {
  return !!p && p.gender === "M" && !validConfirmation(p.sexConfirmedAt);
}

/**
 * Vista del jugador para el cálculo: `gender` = sexo registrado (sin definir si falta o
 * está por confirmar) y `sexPendingConfirmation: true` cuando es un «M» sin confirmar.
 * No muta la entrada.
 */
export function withRegisteredSex<T extends SexFields>(p: T): T & { sexPendingConfirmation?: true } {
  const sex = registeredSex(p);
  if (sex === (p.gender ?? null)) return p;
  const out = { ...p } as T & { sexPendingConfirmation?: true };
  delete (out as SexFields).gender;
  if (sexPendingConfirmation(p)) out.sexPendingConfirmation = true;
  return out;
}

/**
 * Marca para el blob al guardar desde un selector humano: conserva la fecha si el sexo
 * ya estaba confirmado y no cambia; si no, la fecha de ahora. Sin sexo elegido ⇒ undefined.
 */
export function sexConfirmationFor(
  chosen: RegisteredSex | null | undefined,
  previous?: SexFields | null,
  now: Date = new Date(),
): string | undefined {
  if (chosen !== "M" && chosen !== "F") return undefined;
  if (previous && registeredSex(previous) === chosen && validConfirmation(previous.sexConfirmedAt)) {
    return previous.sexConfirmedAt as string;
  }
  return now.toISOString();
}
