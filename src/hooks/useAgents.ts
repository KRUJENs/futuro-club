/**
 * VITAS Agent Hooks
 * Conecta los agentes Claude con React Query.
 * Cachea resultados para no llamar la API en cada render.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AgentService } from "@/services/real/agentService";
import { PlayerService } from "@/services/real/playerService";
import { ragService } from "@/services/real/ragService";
import type { PHVInput } from "@/agents/contracts";
import i18n from "@/i18n";
import { normalizeLocale } from "@/lib/shared/locale";

// ─────────────────────────────────────────
// Hook: PHV Calculator
// Calcula maduración biológica. Cache 24h (no cambia seguido).
// ─────────────────────────────────────────
export function usePHVCalculator(input: PHVInput | null) {
  return useQuery({
    queryKey: ["phv", input?.playerId, input?.height, input?.weight],
    queryFn: async () => {
      if (!input) throw new Error(i18n.t("errors.phvNoData"));
      const res = await AgentService.calculatePHV(input);
      if (!res.success || !res.data) throw new Error(res.error ?? "Error en PHV Agent");

      // NO se persiste en el jugador: el antiguo PlayerService.updatePHV
      // sobrescribía el VSI con el «VSI ajustado» (sin historial ni procedencia).
      // La maduración visible la decide el gate único (src/lib/phv/phvGate.ts).
      return res.data;
    },
    enabled: !!input,
    staleTime: 1000 * 60 * 60 * 24, // 24 horas
    retry: false, // PHV ya tiene retries internos en agentResilience — no duplicar
  });
}

// NOTE: useScoutInsights lives in useScoutFeed.ts (single source of truth)
// Do NOT duplicate it here — ScoutFeed.tsx imports from useScoutFeed.ts

// useRoleProfileAgent se borró (P1 bloque 2): no tenía llamadores; todas las pantallas
// usan useRoleProfile → services/roleProfileService (una sola implementación, inv #7).

// ─────────────────────────────────────────
// Hook: RAG Drill Recommendations
// Busca ejercicios en la base de conocimiento RAG
// a partir de las áreas de desarrollo identificadas.
// Cache 1h (los drills no cambian seguido).
// ─────────────────────────────────────────
export function useRAGDrillRecommendations(areasDesarrollo: string[] | undefined) {
  return useQuery({
    queryKey: ["rag-drills", ...(areasDesarrollo ?? [])],
    queryFn: async () => {
      if (!areasDesarrollo || areasDesarrollo.length === 0) return [];

      // Para cada área de desarrollo, buscar drills relevantes en el RAG
      const traceId = `rag_drill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const results = await Promise.all(
        areasDesarrollo.map(async (area) => {
          const res = await ragService.query(area, {
            category: "drill",
            limit: 2,
          });
          return {
            area,
            traceId,
            drills: res.results.map((r) => ({
              id: r.id,
              content: r.content,
              similarity: r.similarity,
              metadata: r.metadata,
              traceId,
            })),
          };
        })
      );

      return results.filter((r) => r.drills.length > 0);
    },
    enabled: !!areasDesarrollo && areasDesarrollo.length > 0,
    staleTime: 1000 * 60 * 60, // 1 hora
    retry: 1,
  });
}

// ─────────────────────────────────────────
// Mutation: Recalcular PHV manualmente
// ─────────────────────────────────────────
export function useRecalculatePHV() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PHVInput) => AgentService.calculatePHV(input),
    onSuccess: async (_result, input) => {
      // Sin persistencia en el jugador (ver usePHVCalculator): no se sobrescribe
      // el VSI con el ajuste del agente.
      queryClient.invalidateQueries({ queryKey: ["phv", input.playerId] });
      queryClient.invalidateQueries({ queryKey: ["role-profile-agent", input.playerId] });
    },
  });
}
