/**
 * VITAS Scout — Insight Generation Endpoint
 * POST /api/scout/generate
 *
 * Generates AI-powered scout insights for one or all players.
 * Enriches each insight with RAG context (drills, benchmarks, methodology).
 * Persists results to scout_insights table in Supabase.
 */
import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { MODELS } from "../_lib/models";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import type { MaturityAssessment, MaturityTiming } from "../../src/lib/phv/maturity";
import { gatedMaturity } from "../../src/lib/phv/phvGate";
import { withRegisteredSex } from "../../src/lib/shared/registeredSex";
import { normalizeLocale, languageDirective, localeSchema } from "../../src/lib/shared/locale";
import { computeVsiDelta, type VsiDelta } from "../../src/lib/scoring/vsiDelta";

export const config = { runtime: "edge" };

const GenerateSchema = z.object({
  playerId: z.string().optional(),
  // Idioma de SALIDA del insight (registro de idiomas soportados, ver
  // src/lib/shared/locale.ts). Opcional: sin él, normalizeLocale cae al idioma
  // por defecto — los callers server-side (auto-generate cron) no lo envían.
  locale: localeSchema.optional(),
});

interface PlayerRow {
  id: string;
  name: string;
  age: number;
  position: string;
  /** VSI de ficha actual (columna). null ⇒ sin evaluar. Solo para MOSTRAR el valor actual. */
  vsi: number | null;
  phv_category: string;
  phv_offset: number;
  // NOTA: `players` NO tiene columna `metrics` (024 solo crea metric_*, con 0 por
  // defecto en el trigger). Las 6 barras reales del entrenador se leen del blob
  // `data.metrics` (ver `data` abajo); ausente ⇒ sin evaluar, nunca 0.
  /** LEGACY sin fechas ni origen (con 57.5 fabricados antes de #146): NUNCA para variaciones. */
  vsi_history: number[] | null;
  minutes_played: number;
  updated_at: string;
  /**
   * Blob `data` original: fuente ÚNICA de los inputs de maduración (igual que
   * api/rankings/_list.ts). Se lee de aquí y NO de las columnas normalizadas de
   * la migración 024 porque `gender` tiene DEFAULT 'M' a nivel de columna: leer
   * el sexo de la columna trataría a una jugadora (o a un sexo no registrado)
   * como varón y rompería la abstención del invariante #5. El blob solo trae el
   * dato si una persona lo introdujo.
   */
  data?: {
    gender?: string | null;
    birthDate?: string | null;
    age?: number | null;
    height?: number | null;
    weight?: number | null;
    sittingHeight?: number | null;
    legLength?: number | null;
    motherHeightCm?: number | null;
    fatherHeightCm?: number | null;
    /** Las 6 barras del entrenador (solo si evaluó; ausente ⇒ sin evaluar). */
    metrics?: Record<string, number> | null;
    /** VSI de ficha del blob (mismo escritor que vsiEvaluations). */
    vsi?: number | null;
    /** LEGACY sin fechas ni origen: solo explica por qué una variación está bloqueada. */
    vsiHistory?: unknown;
    /** Evaluaciones con fecha y origen (src/lib/scoring/vsiDelta.ts). Sin validar: jsonb. */
    vsiEvaluations?: unknown;
  } | null;
}

/**
 * Maduración canónica del jugador vía el GATE ÚNICO de PHV (src/lib/phv/phvGate.ts)
 * — la MISMA decisión, con los MISMOS inputs, que la ficha, la impresión, el equipo,
 * el comparador y Rankings (invariante #7). Regla del owner (28-sep): sin TODAS las
 * entradas introducidas (talla, peso, talla sentado, pierna, fecha de nacimiento →
 * edad DECIMAL, sexo registrado) no hay PHV. Antes se llamaba al motor directamente
 * con la edad ENTERA como respaldo y pierna/sentado ESTIMADOS, así que el ScoutFeed
 * podía afirmar un estado que la ficha ocultaba. Los inputs salen del blob `data`
 * (no de las columnas 024: `gender` tenía DEFAULT 'M', invariante #5).
 *
 * Gate cerrado ⇒ abstención (timing/estado "unknown"): NO se afirma nada de
 * maduración al LLM (invariante #2: nunca el valor naive persistido).
 */
function canonicalMaturity(player: PlayerRow): MaturityAssessment {
  return gatedMaturity(withRegisteredSex(player.data ?? {})); // «M» sin confirmar ⇒ sin sexo (P1 bloque 7)
}

/**
 * Descripción de maduración para el LLM derivada del MOTOR (no de las columnas
 * persistidas): así lo que se AFIRMA es lo mismo que gatea (cierra el hueco
 * gate-source ≠ emit-source, invariante #7). Términos vs pares ya resueltos
 * —"tardío" ↔ engine timing "late" (PHV después de la media), "precoz" ↔ "early"—
 * para que el LLM no reinvierta la etiqueta. `null` cuando el motor se abstiene.
 */
const TIMING_ES: Record<Exclude<MaturityTiming, "unknown">, string> = {
  early: "madurador precoz",
  on_time: "madurador en fase",
  late: "madurador tardío",
};
const STATUS_ES: Record<string, string> = {
  pre_phv: "pre-estirón",
  circa_phv: "en pleno estirón (ventana crítica de desarrollo)",
  post_phv: "post-estirón",
};
function phvForLLM(m: MaturityAssessment): {
  phvTiming?: string;
  phvEstado?: string;
  phvOffsetAnios?: number;
} | null {
  // El motor separa dos cosas y aquí se respeta esa separación:
  //  · ESTADO (pre/circa/post-estirón): DÓNDE está en SU propia curva. Se conoce
  //    en cuanto el motor computa (%PAH o Mirwald) y es una afirmación factual
  //    segura → se emite siempre que status !== "unknown".
  //  · TIMING (precoz/tardío vs pares): solo se AFIRMA con timing firme (blindaje
  //    anti-falso-positivo del motor) → phvTiming solo si timing !== "unknown".
  // Así el detonante de phv-alert (status === "circa_phv") NUNCA queda sin sustancia
  // (el estado acompaña), y no se afirma precoz/tardío sin confianza (inv #2/#3).
  const timingFirm = m.timing !== "unknown";
  const estado = m.status !== "unknown" ? STATUS_ES[m.status] : undefined;
  if (!timingFirm && !estado) return null;
  return {
    ...(timingFirm ? { phvTiming: TIMING_ES[m.timing as Exclude<MaturityTiming, "unknown">] } : {}),
    ...(estado ? { phvEstado: estado } : {}),
    // El offset solo con timing firme: ahí Mirwald está dentro de su ventana de
    // validez y el número es coherente con el estado; si no, se omite (no dar un
    // offset que el propio motor considera poco fiable).
    ...(timingFirm && typeof m.maturityOffset === "number"
      ? { phvOffsetAnios: Math.round(m.maturityOffset * 10) / 10 }
      : {}),
  };
}

interface AnalysisRow {
  id: string;
  player_id: string;
  created_at: string;
  // player_analyses.video_id es NULLABLE (000_full_schema.sql:100): el análisis
  // puede no tener vídeo asociado. select=* ya lo baja; lo declaramos para leerlo.
  video_id?: string | null;
  // La columna es `report` (000_full_schema.sql:101), no `report_data`: con el nombre
  // antiguo este contexto de análisis nunca llegaba (código muerto).
  report?: {
    estadoActual?: {
      dimensiones?: Record<string, { score: number }>;
      // false/ausente ⇒ los `score` de dimensiones son la CONSTANTE fabricada (el pipeline
      // no las mide) → NO se inyectan en el prompt del agente de scout (inv #2).
      dimensionesMedidas?: boolean;
      nivelActual?: string;
      fortalezasPrimarias?: string[];
      areasDesarrollo?: string[];
    };
    planDesarrollo?: {
      pilaresTrabajo?: Array<{ pilar: string; acciones: string[] }>;
    };
  } | null;
}

interface RAGResult {
  content: string;
  category: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

type InsightContext = "breakout" | "comparison" | "phv-alert" | "drill-record" | "regression" | "milestone";

async function fetchPlayerHistory(
  supabaseUrl: string,
  supabaseKey: string,
  playerId: string,
  userId: string,
): Promise<Array<{ report: Record<string, unknown>; created_at: string }> | null> {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const res = await fetch(
    `${supabaseUrl}/rest/v1/player_analyses?player_id=eq.${playerId}&user_id=eq.${userId}&select=report,created_at&order=created_at.desc&limit=2`,
    { headers },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ report: Record<string, unknown>; created_at: string }>;
  return rows;
}

/**
 * Urgencia por contexto, decidida en el SERVIDOR (antes la elegía el LLM y el tipo
 * también: podía etiquetar "breakout/high" sin ninguna variación real).
 */
const URGENCY_BY_CONTEXT: Record<InsightContext, "high" | "medium" | "low"> = {
  breakout: "high",
  regression: "high",
  milestone: "high",
  "phv-alert": "medium",
  "drill-record": "medium",
  comparison: "low",
};

/** Etiquetas de la consulta RAG (la base de conocimiento está en español). */
const RAG_METRIC_ES = { speed: "velocidad", technique: "técnica", vision: "visión" } as const;

/**
 * El benchmark es texto del LLM: sin datos de población no puede llevar percentiles
 * ni porcentajes (antes el prompt los pedía y el modelo los inventaba, p.ej.
 * "Percentil 72 … Sub-10"). Si aun así los trae, se descarta (null), no se muestra.
 */
const INVENTED_STAT_RE = /percentil|perzentil|percentiel|centile|\d+(?:[.,]\d+)?\s*%/i;
function sanitizeBenchmark(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return INVENTED_STAT_RE.test(raw) ? null : raw;
}

/** Las 6 barras reales del entrenador (blob `data.metrics`); null si no evaluó. */
function coachMetrics(player: PlayerRow): Record<string, number> | null {
  const m = player.data?.metrics;
  if (!m || typeof m !== "object") return null;
  const vals = Object.entries(m).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  return vals.length > 0 ? Object.fromEntries(vals) : null;
}

/**
 * Variación del VSI de ficha entre las dos últimas evaluaciones REALES con fecha y
 * origen (fuente única: src/lib/scoring/vsiDelta.ts). El historial legacy
 * `vsi_history` (sin fechas, con 57.5 fabricados) NUNCA entra en la cuenta.
 */
function playerVsiDelta(player: PlayerRow): VsiDelta {
  const d = player.data ?? {};
  // VSI actual: el del blob (lo escriben los mismos caminos que las evaluaciones);
  // la columna solo si el blob no lo trae (fila legacy).
  const current = typeof d.vsi === "number" ? d.vsi : player.vsi;
  const legacy = Array.isArray(player.vsi_history) && player.vsi_history.length > 0
    ? player.vsi_history
    : d.vsiHistory;
  return computeVsiDelta({
    evaluations: d.vsiEvaluations,
    legacyHistory: legacy,
    currentVsi: current ?? null,
  });
}

/**
 * Contexto del insight, SOLO desde señales reales. Sin señal ⇒ null: el endpoint se
 * ABSTIENE de generar (invariante #3) en vez de etiquetar "breakout" por defecto.
 */
function detectContext(
  player: PlayerRow,
  latestAnalysis: AnalysisRow | null,
  previousAnalysis: AnalysisRow | null,
  maturity: MaturityAssessment,
  vsiDelta: VsiDelta,
): InsightContext | null {
  // Check metric deltas if analyses exist — SOLO con dimensiones reales (si no, el delta
  // sale de la constante fabricada; hoy es 0, pero no se computa desde datos falsos, inv #2).
  let maxMetricDelta = 0;
  const latestEA = latestAnalysis?.report?.estadoActual;
  const prevEA = previousAnalysis?.report?.estadoActual;
  if (latestEA?.dimensionesMedidas === true && prevEA?.dimensionesMedidas === true &&
      latestEA.dimensiones && prevEA.dimensiones) {
    const latest = latestEA.dimensiones;
    const prev = prevEA.dimensiones;
    for (const key of Object.keys(latest)) {
      const curr = latest[key]?.score;
      const before = prev[key]?.score;
      if (typeof curr !== "number" || typeof before !== "number") continue; // hueco ≠ 0
      const delta = curr - before;
      if (Math.abs(delta) > maxMetricDelta) maxMetricDelta = delta;
    }
  }

  // Tendencias de VSI SOLO con una variación calculada entre dos evaluaciones reales.
  if (vsiDelta.value !== null && vsiDelta.from_value !== null && vsiDelta.to_value !== null) {
    const d = vsiDelta.value;
    const before = vsiDelta.from_value;
    const now = vsiDelta.to_value;

    // Regression: VSI dropped > 5 points
    if (d < -5) return "regression";

    // Milestone: crossed VSI threshold
    if ((now >= 80 && before < 80) || (now >= 90 && before < 90)) return "milestone";

    // Breakout: VSI up >5
    if (d > 5) return "breakout";
  }

  // Breakout por dimensión de vídeo REAL (>1.5 en escala 0-10 = >15 en 0-100)
  if (maxMetricDelta > 1.5) return "breakout";

  // PHV Alert: ventana crítica de desarrollo = el jugador está EN pleno estirón,
  // según el ESTADO que calcula el motor canónico (circa_phv), no la columna
  // phv_category persistida (naive/estancada). Un estado circa_phv solo lo produce
  // el motor con antropometría real cerca del PHV, así que un menor sin datos —o un
  // pre-púber— nunca dispara esta alerta sobre un hueco (invariantes #2/#7).
  if (maturity.status === "circa_phv") return "phv-alert";

  // Drill record / comparison: SOLO con las barras reales del entrenador (blob).
  const vals = Object.values(coachMetrics(player) ?? {});

  // Drill record: any metric above 85
  if (vals.some(v => v > 85)) return "drill-record";

  // Comparison: balanced profile (all metrics 55-75)
  if (vals.length > 0 && vals.every(v => v >= 55 && v <= 75)) return "comparison";

  // Sin señal real ⇒ abstención (antes: "breakout" por defecto, sin ninguna subida).
  return null;
}

export default withHandler(
  { schema: GenerateSchema, requireAuth: true, maxRequests: 10, windowMs: 120_000 },
  async ({ body, req, userId }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse("Supabase not configured", 503, "CONFIG_ERROR");
    }
    if (!anthropicKey) {
      return errorResponse("Anthropic API not configured", 503, "CONFIG_ERROR");
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const baseUrl = new URL(req.url).origin;

    // Idioma de salida de TODOS los insights del lote (una decisión por request).
    // El prompt inyecta `languageDirective(reportLocale)` en lugar de un idioma
    // hardcodeado, así el ScoutFeed habla el idioma de la UI del usuario.
    const reportLocale = normalizeLocale(body.locale);

    // 1. Fetch players
    let playersUrl = `${supabaseUrl}/rest/v1/players?select=*&user_id=eq.${userId}`;
    if (body.playerId) {
      playersUrl += `&id=eq.${body.playerId}`;
    }
    playersUrl += "&order=updated_at.desc&limit=50";

    const playersRes = await fetch(playersUrl, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });

    if (!playersRes.ok) {
      return errorResponse("Failed to fetch players", 500);
    }

    const players: PlayerRow[] = await playersRes.json();
    if (players.length === 0) {
      return successResponse({ insights: [], message: "No players found" });
    }

    // 2. Fetch latest analyses for each player
    const playerIds = players.map(p => p.id);
    const analysesUrl = `${supabaseUrl}/rest/v1/player_analyses?select=*&player_id=in.(${playerIds.join(",")})&order=created_at.desc&limit=100`;
    const analysesRes = await fetch(analysesUrl, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });

    const analyses: AnalysisRow[] = analysesRes.ok ? await analysesRes.json() : [];

    // Group analyses by player
    const analysesByPlayer = new Map<string, AnalysisRow[]>();
    for (const a of analyses) {
      const list = analysesByPlayer.get(a.player_id) ?? [];
      list.push(a);
      analysesByPlayer.set(a.player_id, list);
    }

    // 3. Generate insights for each player
    const generatedInsights: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const skipped: string[] = [];
    const skippedNoSignal: string[] = [];

    // Tripwire de presupuesto (054): este endpoint llama a Claude una vez por jugador
    // (hasta 50) sin contabilizar → agujero en el tope de gasto. Pre-chequeo antes del
    // lote; dentro del bucle se corta si se cruza el tope, y se registra cada llamada OK.
    if (await isOverBudget()) return budgetExceededResponse();

    for (const player of players) {
      try {
        const playerAnalyses = analysesByPlayer.get(player.id) ?? [];
        const latestAnalysis = playerAnalyses[0] ?? null;
        const previousAnalysis = playerAnalyses[1] ?? null;

        // Sin datos reales (0 minutos jugados Y sin análisis completado) → NO
        // fabricamos una narrativa de scouting. El jugador entra al feed cuando
        // tenga minutos jugados o un análisis de vídeo. (Evita insights inventados
        // sobre cero datos, p.ej. "sugiere capacidad para acelerar desarrollo".)
        const hasRealData = (player.minutes_played ?? 0) > 0 || playerAnalyses.length > 0;
        if (!hasRealData) {
          skipped.push(player.name);
          continue;
        }

        // Maduración canónica (una sola vez por jugador). El motor decide qué se
        // afirma: si se abstiene (timing "unknown") no se manda nada de PHV al LLM.
        const maturity = canonicalMaturity(player);
        const phv = phvForLLM(maturity);
        // Variación del VSI calculada AQUÍ (servidor), como MetricResult DERIVADA, solo
        // entre dos evaluaciones reales con fecha y origen. El LLM no escribe cifras.
        const vsiDelta = playerVsiDelta(player);
        const metrics = coachMetrics(player);
        const context = detectContext(player, latestAnalysis, previousAnalysis, maturity, vsiDelta);

        // Sin señal real (ninguna variación calculable, ni estirón, ni barras que lo
        // justifiquen) ⇒ se abstiene. Antes caía a "breakout" por defecto (inv #3).
        if (context === null) {
          skippedNoSignal.push(player.name);
          continue;
        }

        // Query RAG for enrichment
        let ragContext = "";
        let ragDrills: RAGResult[] = [];
        try {
          // Solo barras REALES del entrenador; sin evaluación no se inventa "velocidad 0" (inv #2).
          const metricsPart = metrics
            ? ` métricas: ${(["speed", "technique", "vision"] as const)
                .filter((k) => typeof metrics[k] === "number")
                .map((k) => `${RAG_METRIC_ES[k]} ${metrics[k]}`)
                .join(" ")}`
            : "";
          const ragQuery = `${player.position} ${context} ${player.age} años${metricsPart}`;
          const ragRes = await fetch(`${baseUrl}/api/rag/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({ query: ragQuery, limit: 5 }),
          });
          if (ragRes.ok) {
            const ragData = await ragRes.json() as { data?: { context?: string; results?: RAGResult[] } };
            ragContext = ragData.data?.context ?? "";
            ragDrills = ragData.data?.results ?? [];
          }
        } catch {
          // RAG failure is non-blocking
        }

        // Build analysis context for Claude
        let analysisContext = "";
        if (latestAnalysis?.report?.estadoActual) {
          const ea = latestAnalysis.report.estadoActual;
          analysisContext += `\nÚltimo análisis (${latestAnalysis.created_at}):`;
          analysisContext += `\n- Nivel: ${ea.nivelActual ?? "N/A"}`;
          if (ea.fortalezasPrimarias) analysisContext += `\n- Fortalezas: ${ea.fortalezasPrimarias.join(", ")}`;
          if (ea.areasDesarrollo) analysisContext += `\n- Áreas desarrollo: ${ea.areasDesarrollo.join(", ")}`;
          // Solo dimensiones REALES: no inyectar "k: 5/10" fabricado en el prompt (inv #2).
          if (ea.dimensiones && ea.dimensionesMedidas === true) {
            analysisContext += `\n- Dimensiones: ${Object.entries(ea.dimensiones).map(([k, v]) => `${k}: ${v.score}/10`).join(", ")}`;
          }
        }
        if (previousAnalysis?.report?.estadoActual) {
          const ea = previousAnalysis.report.estadoActual;
          analysisContext += `\nAnálisis anterior (${previousAnalysis.created_at}):`;
          analysisContext += `\n- Nivel: ${ea.nivelActual ?? "N/A"}`;
          if (ea.dimensiones && ea.dimensionesMedidas === true) {
            analysisContext += `\n- Dimensiones: ${Object.entries(ea.dimensiones).map(([k, v]) => `${k}: ${v.score}/10`).join(", ")}`;
          }
        }

        // Historical comparison: fetch last 2 player_analyses and compute dimension deltas
        let historicalContext = "";
        try {
          const history = await fetchPlayerHistory(supabaseUrl, supabaseKey!, player.id, userId!);
          if (history && history.length >= 2) {
            type ReportShape = {
              estadoActual?: {
                vsi?: number;
                dimensiones?: Record<string, { score?: number }>;
                dimensionesMedidas?: boolean;
              };
            };
            const latest = (history[0].report ?? {}) as ReportShape;
            const previous = (history[1].report ?? {}) as ReportShape;
            // Dims reales solo si AMBOS informes las declaran medidas; si no, sus deltas y
            // la "DETECCIÓN: Breakout" saldrían de la constante fabricada (inv #2). El
            // contexto de VSI de vídeo se emite solo si AMBOS informes lo traen.
            const dimsReales = latest?.estadoActual?.dimensionesMedidas === true
              && previous?.estadoActual?.dimensionesMedidas === true;
            const latestDims = latest?.estadoActual?.dimensiones;
            const prevDims = previous?.estadoActual?.dimensiones;
            // VSI de VÍDEO de cada informe, SOLO si ambos lo traen. Antes se rellenaba
            // con el VSI de ficha / vsi_history legacy / `?? 0`: mezclaba dos índices
            // distintos y un hueco se convertía en "VSI previo: 0" (inv #2/#7).
            const latestVSI = typeof latest?.estadoActual?.vsi === "number" ? latest.estadoActual.vsi : null;
            const prevVSI = typeof previous?.estadoActual?.vsi === "number" ? previous.estadoActual.vsi : null;
            const videoVsiDelta = latestVSI !== null && prevVSI !== null ? latestVSI - prevVSI : null;

            // Pares de dimensión con AMBOS scores reales (un hueco no es un 0).
            const dimPairs = (dimsReales && latestDims && prevDims)
              ? Object.keys(latestDims)
                  .map((d) => ({ d, curr: latestDims[d]?.score, prev: prevDims[d]?.score }))
                  .filter((p): p is { d: string; curr: number; prev: number } =>
                    typeof p.curr === "number" && typeof p.prev === "number")
              : [];

            historicalContext = `\n\nHISTORIAL DE EVOLUCIÓN (comparación últimos 2 análisis de vídeo, ${history[1].created_at} → ${history[0].created_at}):`;
            // Deltas por dimensión: SOLO con dimensiones reales.
            if (dimPairs.length > 0) {
              const deltas = dimPairs.map(({ d, curr, prev }) => {
                const delta = curr - prev;
                return `${d}: ${prev}→${curr} (${delta > 0 ? "+" : ""}${delta})`;
              });
              historicalContext += `\n${deltas.join("\n")}`;
            }
            if (latestVSI !== null && prevVSI !== null && videoVsiDelta !== null) {
              historicalContext += `\nVSI de vídeo previo: ${prevVSI} → VSI de vídeo actual: ${latestVSI} (${videoVsiDelta > 0 ? "+" : ""}${videoVsiDelta})`;
            }

            // Detección: Breakout SOLO con dims reales; Regresión/Milestone por VSI de vídeo real.
            const maxDelta = dimPairs.length > 0
              ? Math.max(...dimPairs.map(({ curr, prev }) => curr - prev))
              : -Infinity;
            if (maxDelta > 1.5) {
              historicalContext += `\n→ DETECCIÓN: Breakout (dimensión subió ${(maxDelta * 10).toFixed(0)}+ puntos)`;
            } else if (latestVSI !== null && prevVSI !== null && videoVsiDelta !== null) {
              if (videoVsiDelta < -5) {
                historicalContext += `\n→ DETECCIÓN: Regresión (VSI de vídeo cayó ${Math.abs(videoVsiDelta)} puntos)`;
              } else if ((latestVSI >= 80 && prevVSI < 80) || (latestVSI >= 90 && prevVSI < 90)) {
                historicalContext += `\n→ DETECCIÓN: Milestone (VSI de vídeo cruzó umbral ${latestVSI >= 90 ? 90 : 80})`;
              }
            }
          }
        } catch {
          // Historical query is non-blocking
        }

        // Prompt for Claude
        const systemPrompt = `Eres el generador de insights de scouting de VITAS Football Intelligence.
Analiza datos de un jugador juvenil y genera un insight accionable.

${languageDirective(reportLocale)}

CONTEXTO DETECTADO: ${context}
${ragContext ? `\nCONTEXTO RAG (base de conocimiento):\n${ragContext.slice(0, 1500)}` : ""}
${analysisContext ? `\nHISTORIAL DE ANÁLISIS:${analysisContext}` : ""}${historicalContext}

REGLAS:
- CIFRAS: NO calcules ni inventes números (variaciones, porcentajes, percentiles, medias, "+X puntos"). Solo puedes citar una cifra si aparece LITERALMENTE en los datos del jugador (vsiFicha, vsiVariacion, barrasEntrenador, minutesPlayed) o en el historial de arriba. Si NO viene vsiVariacion, NO afirmes que el VSI subió, bajó ni "progresó": no hay dos evaluaciones con fecha que lo respalden.
- headline: máximo 80 caracteres, directo, sin emojis
- body: máximo 400 caracteres, concreto; compara con el análisis anterior solo si viene en el historial
- tags: máximo 4
- recommendedDrills: array de máximo 3 objetos {name, reason} basados en el contexto RAG
- actionItems: array de máximo 3 acciones concretas para el entrenador
- benchmark: una frase de referencia CUALITATIVA para su categoría, SIN percentiles ni cifras (no hay datos de población con los que calcularlos)
- barrasEntrenador son valoraciones SUBJETIVAS del entrenador (0-100), no mediciones: no las presentes como medidas
- MADURACIÓN: usa ÚNICAMENTE los campos phvTiming / phvEstado / phvOffsetAnios del jugador si vienen. Si NINGUNO viene, NO menciones maduración, PHV, estirón ni offset: no hay dato fiable e inventarlo es un error. phvEstado (p.ej. "en pleno estirón (ventana crítica de desarrollo)") describe DÓNDE está en SU propia curva y puedes mencionarlo cuando venga. phvTiming es la comparación vs pares y solo existe cuando es fiable: úsalo TAL CUAL, sin invertirlo — "madurador tardío" = su estirón llega más tarde que la media (nivel físico aún por llegar; talento a menudo infravalorado), "madurador precoz" = estirón antes que la media (ventaja física temporal que sus pares igualarán), "madurador en fase" = a la par. Si viene phvEstado pero NO phvTiming, describe el estado SIN afirmar precoz/tardío. phvOffsetAnios = años respecto al pico de crecimiento (negativo = antes del estirón).

RESPONDE ÚNICAMENTE JSON:
{"headline":"string","body":"string","tags":["string"],"recommendedDrills":[{"name":"string","reason":"string"}],"actionItems":["string"],"benchmark":"string"}`;

        const playerData = JSON.stringify({
          id: player.id,
          name: player.name,
          age: player.age,
          position: player.position,
          // VSI de ficha ACTUAL (evaluación subjetiva del entrenador). null ⇒ sin evaluar.
          vsiFicha: player.vsi,
          // Variación SOLO si el servidor la calculó entre dos evaluaciones con fecha.
          // El historial legacy (sin fechas, con valores fabricados) ya NO se envía:
          // con él el LLM "calculaba" progresiones como el +9.9 (inv #1/#2).
          ...(vsiDelta.value !== null
            ? {
                vsiVariacion: {
                  puntos: vsiDelta.value,
                  desde: vsiDelta.from_at,
                  hasta: vsiDelta.to_at,
                  valorAnterior: vsiDelta.from_value,
                  valorActual: vsiDelta.to_value,
                },
              }
            : {}),
          // Maduración = lo que AFIRMA el motor canónico (mismos datos y misma
          // decisión que la ficha), ya traducido a términos vs pares. Si el motor
          // se abstiene, `phv` es null y el spread no añade campos: el LLM no ve
          // categoría ni offset persistidos que pudiera citar como hecho (inv #2/#7).
          ...(phv ?? {}),
          // Barras reales del blob; sin evaluación no se envían (antes: `player.metrics`,
          // una columna inexistente → undefined).
          ...(metrics ? { barrasEntrenador: metrics } : {}),
          minutesPlayed: player.minutes_played,
        });

        // Corta el lote si cruzamos el tope a mitad (protege las llamadas restantes).
        if (await isOverBudget()) break;

        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODELS.fast,
            max_tokens: 1024,
            temperature: 0.3,
            system: systemPrompt,
            messages: [{ role: "user", content: playerData }],
          }),
        });

        if (!claudeRes.ok) {
          errors.push(`Claude error for ${player.name}: ${claudeRes.status}`);
          continue;
        }
        await recordSpendUsd("claude-haiku"); // llamada Claude (MODELS.fast) OK → contabilizada

        const claudeData = await claudeRes.json() as {
          content: Array<{ type: string; text?: string }>;
        };

        let fullText = "";
        for (const block of claudeData.content) {
          if (block.type === "text" && block.text) fullText += block.text;
        }

        const match = fullText.match(/\{[\s\S]*\}/);
        if (!match) {
          errors.push(`No JSON for ${player.name}`);
          continue;
        }

        const parsed = JSON.parse(match[0]);

        const insightRow = {
          user_id: userId,
          player_id: player.id,
          player_name: player.name,
          // Tipo y urgencia los decide el SERVIDOR desde señales reales: el LLM ya no
          // puede etiquetar "breakout/high" por su cuenta.
          insight_type: context,
          title: parsed.headline ?? "Insight generado",
          description: parsed.body ?? "",
          // Ninguna cifra escrita por el LLM (inv #1): metricValue/metric del modelo se
          // IGNORAN. La cifra del insight es la variación calculada en el servidor
          // (context_data.vsi_delta), que la UI pinta con su procedencia.
          metric: null,
          metric_value: null,
          urgency: URGENCY_BY_CONTEXT[context],
          tags: parsed.tags ?? [],
          context_data: {
            vsi: player.vsi,
            // MetricResult DERIVADA (o bloqueada con gate_reason) + fechas y valores
            // de las dos evaluaciones comparadas. Fuente: src/lib/scoring/vsiDelta.ts.
            vsi_delta: vsiDelta,
            position: player.position,
            age: player.age,
            detectedContext: context,
            // Origen del insight (docx-13b): permite enlazar al vídeo/análisis desde
            // el Histórico del PlayerHub. NULL explícito cuando el insight nace de
            // minutos jugados sin análisis (latestAnalysis === null) → nunca inventado.
            source_video_id: latestAnalysis?.video_id ?? null,
            source_analysis_id: latestAnalysis?.id ?? null,
          },
          rag_drills: parsed.recommendedDrills ?? [],
          action_items: parsed.actionItems ?? [],
          benchmark: sanitizeBenchmark(parsed.benchmark),
        };

        // Save to Supabase
        const insertRes = await fetch(`${supabaseUrl}/rest/v1/scout_insights`, {
          method: "POST",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(insightRow),
        });

        if (insertRes.ok) {
          const [saved] = await insertRes.json() as Array<Record<string, unknown>>;
          generatedInsights.push(saved);
        } else {
          const errText = await insertRes.text();
          errors.push(`Save error for ${player.name}: ${errText.slice(0, 200)}`);
        }
      } catch (err) {
        errors.push(`Exception for ${player.name}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    return successResponse({
      generated: generatedInsights.length,
      insights: generatedInsights,
      skippedNoData: skipped.length,
      skipped: skipped.length > 0 ? skipped : undefined,
      // Jugadores con datos pero SIN señal real (ninguna variación calculable, etc.):
      // abstención honesta, no un insight "breakout" por defecto.
      skippedNoSignal: skippedNoSignal.length,
      errors: errors.length > 0 ? errors : undefined,
      totalPlayers: players.length,
    });
  },
);
