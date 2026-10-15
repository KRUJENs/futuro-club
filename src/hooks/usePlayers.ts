/**
 * usePlayers — Hooks para operaciones sobre jugadores
 * Conecta PlayerService (local) + API server (Supabase) con React Query.
 *
 * Cuando SUPABASE_CONFIGURED es true, usa la API /api/players/crud
 * para operaciones CRUD reales en servidor.
 * Cuando es false, usa localStorage via PlayerService.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PlayerService, type Player, type CreatePlayerInput } from "@/services/real/playerService";
import { adaptPlayerForUI } from "@/services/real/adapters";
import { sanitizePlayerPhv } from "@/lib/phv/phvGate";
import { useAuth } from "@/context/AuthContext";
import { SUPABASE_CONFIGURED, supabase } from "@/lib/supabase";
import { OrganizationService } from "@/services/real/organizationService";

// ── API helper ──────────────────────────────────────────────────────────────

async function getAuthHeader(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session?.access_token) {
      return `Bearer ${data.session.access_token}`;
    }
  } catch { /* fallback */ }
  return "";
}

async function apiRequest<T>(
  method: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL("/api/players/crud", window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  // Inyectar org_id en las queries para aislamiento por organización
  const orgId = OrganizationService.getOrgId();
  if (orgId) url.searchParams.set("org_id", orgId);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: await getAuthHeader(),
  };

  const init: RequestInit = { method, headers };
  if (body && method !== "GET") {
    // Inyectar org_id en el body de mutaciones
    const enrichedBody = orgId && typeof body === "object" && body !== null
      ? { ...body, org_id: orgId }
      : body;
    init.body = JSON.stringify(enrichedBody);
  }

  const res = await fetch(url.toString(), init);
  const json = await res.json();

  if (!json.ok) {
    throw new Error(json.error ?? `API error: ${res.status}`);
  }

  return json.data as T;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface PlayersListResponse {
  players: Player[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Hook: Un jugador por ID ──────────────────────────────────────────────────
export function usePlayerById(id: string | undefined) {
  return useQuery({
    queryKey: ["player", id],
    queryFn: async () => {
      if (!id) return null;

      if (SUPABASE_CONFIGURED) {
        try {
          const player = await apiRequest<Player>("GET", undefined, { id });
          return adaptPlayerForUI(player);
        } catch {
          // Fallback to local
        }
      }

      const player = PlayerService.getById(id);
      if (!player) return null;
      return adaptPlayerForUI(player);
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}

// ─── Hook: Jugador raw (sin adaptar) — para formularios y agentes ─────────────
export function useRawPlayerById(id: string | undefined) {
  return useQuery({
    queryKey: ["player-raw", id],
    queryFn: async () => {
      if (!id) return null;

      if (SUPABASE_CONFIGURED) {
        try {
          // Blob crudo del API: su phvCategory/phvOffset persistido solo cuenta si
          // el gate único de PHV lo recalcula (igual que PlayerService.getAll).
          const apiPlayer = await apiRequest<Player>("GET", undefined, { id });
          return apiPlayer ? sanitizePlayerPhv(apiPlayer) : apiPlayer;
        } catch {
          // Fallback to local
        }
      }

      return PlayerService.getById(id);
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}

// ─── Hook: Todos los jugadores adaptados para UI ──────────────────────────────
export function useAllPlayers() {
  return useQuery({
    queryKey: ["players-all"],
    queryFn: async () => {
      if (SUPABASE_CONFIGURED) {
        try {
          const data = await apiRequest<PlayersListResponse>("GET");
          return data.players.map(adaptPlayerForUI);
        } catch {
          // Fallback to local on API error
        }
      }

      return PlayerService.getAll().map(adaptPlayerForUI);
    },
    staleTime: 1000 * 60 * 2,
  });
}

// ─── Mutation: Crear jugador ──────────────────────────────────────────────────
export function useCreatePlayer() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: CreatePlayerInput) => {
      if (user && SUPABASE_CONFIGURED) {
        return apiRequest<Player>("POST", input);
      }
      return PlayerService.create(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["players-all"] });
      queryClient.invalidateQueries({ queryKey: ["ranked-players"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

// ─── Mutation: Actualizar métricas ────────────────────────────────────────────
export function useUpdateMetrics() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ id, metrics }: { id: string; metrics: NonNullable<CreatePlayerInput["metrics"]> }) => {
      if (user && SUPABASE_CONFIGURED) {
        return apiRequest<Player>("PATCH", { id, metrics });
      }
      return await PlayerService.updateMetrics(id, metrics);
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["player", id] });
      queryClient.invalidateQueries({ queryKey: ["player-raw", id] });
      queryClient.invalidateQueries({ queryKey: ["players-all"] });
      queryClient.invalidateQueries({ queryKey: ["ranked-players"] });
    },
  });
}

// ─── Mutation: Eliminar jugador ───────────────────────────────────────────────
export function useDeletePlayer() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      if (user && SUPABASE_CONFIGURED) {
        await apiRequest("DELETE", { id });
      } else {
        PlayerService.delete(id);
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.removeQueries({ queryKey: ["player", id] });
      queryClient.removeQueries({ queryKey: ["player-raw", id] });
      queryClient.invalidateQueries({ queryKey: ["players-all"] });
      queryClient.invalidateQueries({ queryKey: ["ranked-players"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
