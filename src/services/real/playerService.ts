/**
 * VITAS Player Service — DETERMINISTA
 * CRUD completo de jugadores con localStorage.
 * No usa IA. Lógica pura de base de datos local.
 */

import { z } from "zod";
import { honestPlayerView } from "@/lib/players/honestPlayerView";
import { StorageService } from "./storageService";
import { calculateFichaVsi, type PlayerMetrics } from "./metricsService";
import { appendVsiEvaluation, parseVsiEvaluations } from "@/lib/scoring/vsiDelta";

// ── Generador de IDs únicos (evita colisiones en llamadas rápidas) ──────────
let _idCounter = 0;
function uniquePlayerId(): string {
  return `p${Date.now()}_${++_idCounter}`;
}


// ─── Schema del jugador ───────────────────
export const PlayerSchema = z.object({
  id: z.string(),
  name: z.string().min(2).max(80),
  age: z.number().min(8).max(21),
  position: z.string(),                                  // posición primaria (backward-compat)
  secondaryPositions: z.array(z.string()).optional(),    // adicionales · jugadores polivalentes
  // Pie, talla, peso y nivel OPCIONALES (P1 bloque 2, inv #2): un alta sin medición
  // no los inventa. Antes el alta rápida guardaba pie derecho, 165 cm, 58 kg y nivel
  // «Regional» que nadie había medido ni elegido, y la talla y el peso entraban luego
  // en Mirwald como si fueran una medición. Las medidas reales llegan por
  // AnthropometricsForm (histórico) o PlayerForm.
  foot: z.enum(["right", "left", "both"]).optional(),
  height: z.number().min(100).max(220).optional(),
  weight: z.number().min(20).max(120).optional(),
  sittingHeight: z.number().min(30).max(130).optional(),
  legLength: z.number().min(30).max(130).optional(),
  competitiveLevel: z.string().optional(),
  minutesPlayed: z.number().default(0),
  // Métricas del entrenador (las 6 barras). OPCIONAL: un alta rápida
  // (onboarding/wizard) NO evalúa → el jugador nace sin métricas. Rellenar con
  // defaults (60/50) sería inventar una evaluación que no ocurrió (invariante #2).
  metrics: z
    .object({
      speed: z.number().min(0).max(100),
      technique: z.number().min(0).max(100),
      vision: z.number().min(0).max(100),
      stamina: z.number().min(0).max(100),
      shooting: z.number().min(0).max(100),
      defending: z.number().min(0).max(100),
    })
    .optional(),
  // VSI de FICHA = evaluación del entrenador. null ⇒ "sin evaluar" (no hay
  // métricas). Nunca un 0/58 fabricado para un jugador sin evaluación real.
  vsi: z.number().nullable(),
  // LEGACY: valores sin fecha ni origen (y con 57.5 fabricados antes de #146). Solo
  // para mostrar el valor actual / contar guardados; NUNCA para calcular variaciones.
  vsiHistory: z.array(z.number()).default([]),
  // Evaluaciones del entrenador con fecha y origen (fuente de toda variación del VSI:
  // src/lib/scoring/vsiDelta.ts). Opcional: los jugadores anteriores no la tienen.
  // Se sanea al validar (entradas inválidas fuera) en vez de rechazar al jugador entero
  // (p.ej. al restaurar una copia de seguridad con una entrada rota).
  vsiEvaluations: z.preprocess(
    (v) => (v === undefined ? undefined : parseVsiEvaluations(v)),
    z
      .array(z.object({
        value: z.number(),
        at: z.string(),
        source: z.enum(["coach_form", "players_api", "demo_seed"]),
      }))
      .optional(),
  ),
  // Sin default "M": un default silencioso aplicaría la fórmula PHV masculina a
  // una jugadora sin sexo registrado. Ausente ⇒ queda sin definir y el motor de
  // maduración (resolveMaturity) BLOQUEA pidiendo el dato, en vez de asumir.
  gender: z.enum(["M", "F"]).optional(),
  // Fecha en que una persona ELIGIÓ el sexo en un selector (P1 bloque 7): un «M» sin
  // ella puede ser el valor por defecto antiguo ⇒ «por confirmar» (registeredSex.ts).
  sexConfirmedAt: z.string().optional(),
  // Solo en la vista de lectura (honestPlayerView): «M» guardado sin confirmar. No se
  // persiste: los que escriben parten de getAllRaw().
  sexPendingConfirmation: z.boolean().optional(),
  phvCategory: z.enum(["early", "ontme", "late"]).optional(),
  phvOffset: z.number().optional(),
  // ── Inputs de maduración (para edad decimal exacta y %PAH Khamis-Roche) ──
  // Se persisten en el jsonb `data` de la tabla players (sin migración).
  birthDate: z.string().optional(),                        // ISO YYYY-MM-DD → edad decimal
  motherHeightCm: z.number().min(120).max(210).optional(), // para %PAH (Khamis-Roche)
  fatherHeightCm: z.number().min(120).max(230).optional(),
  // true ⇒ jugador de DEMO (cargado con "Cargar datos de ejemplo"), no real. La UI lo
  // rotula con un badge "Ejemplo" para no confundirlo con un jugador real. Persiste en
  // el jsonb `data` de players, así que sobrevive el round-trip a Supabase.
  isDemo: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// z.infer degrada el objeto anidado `metrics` a inner-opcional ({ speed?: number })
// porque el schema es grande y TS toca su límite de profundidad de instanciación.
// El runtime de zod SÍ exige las 6 barras cuando `metrics` está presente; solo el
// tipo inferido queda degradado. Fijamos `metrics?: PlayerMetrics` para que el
// invariante "presente ⇒ completo" se propague a todos los consumidores.
export type Player = Omit<z.infer<typeof PlayerSchema>, "metrics"> & {
  metrics?: PlayerMetrics;
};
export type CreatePlayerInput = Omit<Player, "id" | "vsi" | "vsiHistory" | "vsiEvaluations" | "createdAt" | "updatedAt">;

const STORAGE_KEY = "players";

/**
 * Simple write-lock para evitar race conditions entre
 * updateMetrics() y update() ejecutados concurrentemente.
 * Si el lock está ocupado, espera hasta 500ms y reintenta.
 */
let _writeLock = false;
async function acquireWriteLock(): Promise<void> {
  const start = Date.now();
  while (_writeLock) {
    if (Date.now() - start > 500) {
      console.warn("[PlayerService] Write lock timeout — proceeding anyway");
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  _writeLock = true;
}
function releaseWriteLock(): void {
  _writeLock = false;
}

export const PlayerService = {
  /**
   * Obtiene todos los jugadores
   */
  /**
   * Jugadores TAL CUAL están guardados, para quien ESCRIBE (P1 bloque 7): la vista
   * honesta de getAll() quita el «M» sin confirmar y el PHV no recalculable; si se
   * reescribiera, borraría el dato original y subiría la vista a Supabase.
   */
  getAllRaw(): Player[] {
    return StorageService.get<Player[]>(STORAGE_KEY, []);
  },

  getAll(): Player[] {
    // phvCategory/phvOffset persistidos solo cuentan si el gate ÚNICO de PHV los
    // puede recalcular desde entradas introducidas (talla, peso, sentado, pierna,
    // fecha de nacimiento, sexo — regla del owner 28-sep); si no, se retiran. Así
    // ningún consumidor lee una categoría naive/estancada como si fuera un hecho.
    return StorageService.get<Player[]>(STORAGE_KEY, []).map(honestPlayerView);
  },

  /**
   * Obtiene un jugador por ID
   */
  getById(id: string): Player | null {
    const players = PlayerService.getAll();
    return players.find((p) => p.id === id) ?? null;
  },

  /**
   * Crea un nuevo jugador. El VSI de ficha solo existe si el entrenador aportó
   * las métricas (evaluó). Sin métricas ⇒ vsi = null ("sin evaluar"): no se
   * fabrica un número para un jugador sin evaluación real (invariante #2).
   */
  create(input: CreatePlayerInput): Player {
    const players = PlayerService.getAllRaw();
    const vsi = input.metrics ? calculateFichaVsi(input.metrics) : null;
    const now = new Date().toISOString();

    const newPlayer: Player = {
      ...input,
      id: uniquePlayerId(),
      vsi,
      vsiHistory: vsi !== null ? [vsi] : [],
      // Evaluación con fecha y origen. Un jugador de ejemplo (demo) se marca como tal:
      // nunca cuenta como evaluación real de una persona.
      vsiEvaluations: vsi !== null
        ? appendVsiEvaluation([], vsi, input.isDemo ? "demo_seed" : "coach_form", now)
        : [],
      createdAt: now,
      updatedAt: now,
    };

    PlayerSchema.parse(newPlayer); // Valida antes de guardar
    StorageService.set(STORAGE_KEY, [...players, newPlayer]);
    return newPlayer;
  },

  /**
   * Actualiza métricas de un jugador y recalcula VSI.
   * Usa write-lock para evitar race condition con update().
   */
  async updateMetrics(id: string, metrics: PlayerMetrics): Promise<Player | null> {
    await acquireWriteLock();
    try {
      const players = PlayerService.getAllRaw();
      const idx = players.findIndex((p) => p.id === id);
      if (idx === -1) return null;

      const previous = players[idx];
      // El entrenador evaluó (aportó las 6 barras) ⇒ el VSI de ficha ya existe.
      const newVSI = calculateFichaVsi(metrics);
      const now = new Date().toISOString();

      const updated: Player = {
        ...previous,
        metrics,
        vsi: newVSI,
        vsiHistory: [...(previous.vsiHistory ?? []), newVSI].slice(-10),
        // Cada evaluación queda con su fecha y origen: es lo único con lo que se
        // puede calcular una variación honesta (src/lib/scoring/vsiDelta.ts).
        vsiEvaluations: appendVsiEvaluation(
          previous.vsiEvaluations,
          newVSI,
          previous.isDemo ? "demo_seed" : "coach_form",
          now,
        ),
        updatedAt: now,
      };

      players[idx] = updated;
      StorageService.set(STORAGE_KEY, players);
      return updated;
    } finally {
      releaseWriteLock();
    }
  },

  // updatePHV() RETIRADO: sobrescribía `vsi` con el «VSI ajustado» del agente PHV
  // (base fija 70 sin VSI real, ×1.12 al pre-PHV) sin pasar por el historial ni
  // declarar procedencia, y persistía una categoría calculada con la edad entera.
  // Sin llamadores de UI desde #54. La maduración ya no se persiste desde el
  // cliente: la calcula el gate único a partir de entradas introducidas.

  /**
   * Actualiza campos de identidad/antropometría del jugador (parcial).
   * Para datos que NO son métricas ni PHV calculado: fecha de nacimiento,
   * alturas parentales (Khamis-Roche), medidas base, sexo. Write-lock para no
   * pisar updateMetrics concurrentes.
   */
  async update(
    id: string,
    partial: Partial<
      Pick<
        Player,
        | "birthDate"
        | "motherHeightCm"
        | "fatherHeightCm"
        | "height"
        | "weight"
        | "sittingHeight"
        | "legLength"
        | "gender"
      >
    >,
  ): Promise<Player | null> {
    await acquireWriteLock();
    try {
      const players = PlayerService.getAllRaw();
      const idx = players.findIndex((p) => p.id === id);
      if (idx === -1) return null;

      players[idx] = {
        ...players[idx],
        ...partial,
        updatedAt: new Date().toISOString(),
      };

      StorageService.set(STORAGE_KEY, players);
      return players[idx];
    } finally {
      releaseWriteLock();
    }
  },

  /**
   * Elimina un jugador
   */
  delete(id: string): boolean {
    const players = PlayerService.getAllRaw();
    const filtered = players.filter((p) => p.id !== id);
    if (filtered.length === players.length) return false;
    StorageService.set(STORAGE_KEY, filtered);
    return true;
  },

  /**
   * Ordena jugadores por campo — DETERMINISTA puro
   */
  sort(players: Player[], by: "vsi" | "age" | "name", dir: "asc" | "desc"): Player[] {
    return [...players].sort((a, b) => {
      // Jugadores sin evaluar (vsi null) SIEMPRE al final, sin importar la
      // dirección: un hueco no compite con un número real (ni como 0).
      if (by === "vsi") {
        if (a.vsi === null && b.vsi === null) return 0;
        if (a.vsi === null) return 1;
        if (b.vsi === null) return -1;
        return dir === "asc" ? a.vsi - b.vsi : -(a.vsi - b.vsi);
      }
      let diff = 0;
      if (by === "age") diff = a.age - b.age;
      else diff = a.name.localeCompare(b.name);
      return dir === "asc" ? diff : -diff;
    });
  },

  /**
   * Obtiene todos los VSIs de ficha guardados (sin llamadores en la app; los percentiles
   * van por src/lib/metrics/percentile.ts, que también excluye a los de ejemplo).
   * Excluye jugadores sin evaluar (vsi null): un hueco no es un 0.
   */
  getAllVSIs(): number[] {
    return PlayerService.getAll()
      .map((p) => p.vsi)
      .filter((v): v is number => v !== null);
  },

  /**
   * @deprecated REMOVED — Mock seed function eliminated to prevent fake data contamination.
   * Players must only be created by the user through onboarding or the add player form.
   * Kept as no-op to avoid breaking callers until all references are cleaned up.
   */
  seedIfEmpty(): void {
    // No-op — fake players removed. Real players come from user input or Supabase.
  },

  /**
   * Purge known mock/fake player IDs from localStorage.
   * Called once on app init to ensure no fake data persists.
   */
  purgeMockPlayers(): { removed: number; purgedIds: string[] } {
    const FAKE_IDS = new Set(["p1", "p2", "p3", "p4", "p5", "p6"]);
    const FAKE_NAMES = new Set([
      "Lucas Moreno", "Alejandro Ruiz", "Daniel Torres",
      "Pablo García", "Mateo Fernández", "Iker Navarro",
    ]);
    const all = PlayerService.getAllRaw();
    const clean = all.filter(
      (p) => !FAKE_IDS.has(p.id) && !FAKE_NAMES.has(p.name)
    );
    const purged = all.filter(
      (p) => FAKE_IDS.has(p.id) || FAKE_NAMES.has(p.name)
    );
    if (purged.length > 0) {
      StorageService.set(STORAGE_KEY, clean);
      console.warn(`[PlayerService] Purged ${purged.length} mock player(s) from localStorage`);
    }
    return { removed: purged.length, purgedIds: purged.map(p => p.id) };
  },
};
