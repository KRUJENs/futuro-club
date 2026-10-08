/**
 * SupabaseVideoService.pushOne — compatibilidad con la fila que siembra video-init.
 * El upsert del cliente NO debe pisar con defaults lo que puso el servidor:
 *   - métricas desconocidas (stub a 0) no se envían (invariante #2: ausencia ≠ 0)
 *   - player_id no se borra si el check de jugador falla en el cliente
 *   - nunca envía columnas del servidor (bunny_video_id, tenant_id, duration_sec)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertSpy = vi.fn();
/** found: la fila existe y la RLS la deja ver · ownerId: su players.user_id. */
const playerLookup: { found: boolean; ownerId: string } = { found: true, ownerId: "u1" };
const playerFilters: Array<[string, unknown]> = [];

vi.mock("@/lib/supabase", () => ({
  SUPABASE_CONFIGURED: true,
  supabase: {
    from: (table: string) => {
      if (table === "players") {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            playerFilters.push([col, val]);
            return builder;
          },
          maybeSingle: async () => {
            const byOwner = filters.find(([c]) => c === "user_id");
            const ownerOk = !byOwner || byOwner[1] === playerLookup.ownerId;
            return { data: playerLookup.found && ownerOk ? { id: "p1" } : null };
          },
        };
        return { select: () => builder };
      }
      return {
        upsert: async (row: unknown, opts: unknown) => {
          upsertSpy(row, opts);
          return { error: null };
        },
      };
    },
  },
}));
vi.mock("@/services/real/organizationService", () => ({ OrganizationService: { getOrgId: () => null } }));
vi.mock("@/services/real/syncQueueService", () => ({ SyncQueueService: { enqueue: vi.fn(), pendingCount: () => 0, getQueue: () => [] } }));

import { SupabaseVideoService, videoToColumns } from "@/services/real/supabaseVideoService";
import type { VideoRecord } from "@/services/real/videoService";

const stub: VideoRecord = {
  id: "guid-1",
  title: "Partido",
  playerId: "p1",
  status: "created",
  statusCode: 0,
  encodeProgress: 0,
  duration: 0,
  width: 0,
  height: 0,
  fps: 0,
  storageSize: 0,
  thumbnailUrl: null,
  embedUrl: "",
  streamUrl: null,
  dateUploaded: "2026-09-28T00:00:00Z",
  analysisResult: null,
};

describe("videoToColumns", () => {
  it("omite métricas desconocidas (0 del stub) en vez de enviar 0", () => {
    const cols = videoToColumns(stub);
    for (const k of ["duration", "vid_width", "vid_height", "fps", "storage_size"]) {
      expect(cols).not.toHaveProperty(k);
    }
  });

  it("envía las métricas cuando se conocen (tras el poll de Bunny)", () => {
    const cols = videoToColumns({ ...stub, duration: 5400, width: 1920, height: 1080, fps: 25, storageSize: 9e9 });
    expect(cols).toMatchObject({ duration: 5400, vid_width: 1920, vid_height: 1080, fps: 25, storage_size: 9e9 });
  });

  it("nunca incluye columnas que siembra el servidor", () => {
    const cols = videoToColumns(stub);
    expect(cols).not.toHaveProperty("bunny_video_id");
    expect(cols).not.toHaveProperty("tenant_id");
    expect(cols).not.toHaveProperty("duration_sec");
  });
});

describe("pushOne · player_id", () => {
  beforeEach(() => {
    upsertSpy.mockReset();
    playerLookup.found = true;
    playerLookup.ownerId = "u1";
    playerFilters.length = 0;
  });

  it("jugador DEL usuario → lo envía; upsert por id", async () => {
    await SupabaseVideoService.pushOne("u1", stub);
    const [row, opts] = upsertSpy.mock.calls[0];
    expect(row).toMatchObject({ id: "guid-1", user_id: "u1", player_id: "p1" });
    expect(opts).toEqual({ onConflict: "id" });
    // La comprobación filtra por dueño (076), no solo por lo que deje ver la RLS.
    expect(playerFilters).toContainEqual(["user_id", "u1"]);
  });

  it("jugador visible bajo RLS pero de OTRA cuenta (p. ej. mismo tenant) → NO envía player_id", async () => {
    playerLookup.ownerId = "otra-cuenta";
    await SupabaseVideoService.pushOne("u1", stub);
    expect(upsertSpy.mock.calls[0][0]).not.toHaveProperty("player_id");
  });

  it("jugador NO encontrado en el cliente → NO envía player_id (no borra el del servidor)", async () => {
    playerLookup.found = false;
    await SupabaseVideoService.pushOne("u1", stub);
    expect(upsertSpy.mock.calls[0][0]).not.toHaveProperty("player_id");
  });

  it("vídeo sin jugador → player_id null explícito (desasignar es legítimo)", async () => {
    await SupabaseVideoService.pushOne("u1", { ...stub, playerId: null });
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ player_id: null });
  });
});
