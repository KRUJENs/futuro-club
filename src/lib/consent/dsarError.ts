/**
 * VITAS · DSAR (RGPD art. 15 / 17) — qué mensaje mostrar en /admin/consent.
 *
 * Tras la migración 072, dsar_export_player_data / dsar_request_deletion solo
 * aceptan al dueño del jugador (players.user_id = auth.uid()); la 072 aceptaba
 * también su tenant del JWT, rama que la 076 retira (solo el dueño, 30 sep 2026).
 * En cualquier otro caso responden SQLSTATE 42501 («jugador no encontrado o sin
 * permiso»; mismo error para «no existe» y «no es tuyo»). PostgREST devuelve ese
 * SQLSTATE en `error.code` de supabase-js.
 *
 * Antes de aplicar 072, las funciones de 036 fallan siempre con otros códigos
 * (22P02 / 42883 por la firma UUID, o PGRST202 si el cliente ya no envía
 * p_requested_by): se muestra el mensaje genérico de siempre. Así el mismo
 * código funciona antes y después de la migración.
 */
export type DsarAction = "export" | "deletion";

export const DSAR_NOT_ALLOWED_CODE = "42501";

export function dsarErrorToastKey(error: unknown, action: DsarAction): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === DSAR_NOT_ALLOWED_CODE) return "parentalConsentPage.toast.dsarNotAllowed";
  return action === "export" ? "parentalConsentPage.toast.exportError" : "parentalConsentPage.toast.deletionError";
}
