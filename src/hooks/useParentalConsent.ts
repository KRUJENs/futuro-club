/**
 * VITAS · Hooks del consentimiento del TUTOR (P1 bloque 3).
 * El estado sale del servidor (/api/auth/consent-status), nunca de un rótulo del navegador.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConsentStatus,
  requestGuardianSignature,
  withdrawConsentOnServer,
  type GuardianConsentStatus,
} from "@/services/real/parentalConsentService";
import { IS_DEMO } from "@/lib/demoMode";

const KEY = "guardian-consent";

/** Estado del consentimiento del tutor de estos jugadores (solo los del usuario). */
export function useConsentStatus(playerIds: string[]) {
  const ids = Array.from(new Set(playerIds.filter(Boolean))).sort();
  return useQuery<Record<string, GuardianConsentStatus>>({
    queryKey: [KEY, ids],
    queryFn: () => fetchConsentStatus(ids),
    // En el demo no hay servidor (red interceptada): no se consulta.
    enabled: ids.length > 0 && !IS_DEMO,
    staleTime: 30_000,
  });
}

/** Pedir (o volver a pedir) la firma al tutor por correo. */
export function useRequestGuardianSignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: requestGuardianSignature,
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** El responsable retira el consentimiento (en el servidor). */
export function useWithdrawGuardianConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ playerId, reason }: { playerId: string; reason?: string }) => withdrawConsentOnServer(playerId, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
