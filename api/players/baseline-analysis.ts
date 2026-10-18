/**
 * VITAS · Baseline Analysis (sin vídeo)
 * POST /api/players/baseline-analysis
 *
 * Genera los 6 reportes Claude usando ÚNICAMENTE el perfil del jugador
 * (evaluación subjetiva del entrenador + PHV + antropometría). Sin biomecánica
 * ni similarity de vídeo.
 *
 * P1 bloque 5: SIN la evaluación del entrenador (VSI de ficha guardado + las 6 barras
 * del blob `data.metrics`) no se genera nada (422 coach_evaluation_missing, decisión del
 * dueño 15 oct 2026). Antes las barras ausentes valían 0 (`Number(metric_*) || 0`, y la
 * columna la rellena con 0 el trigger de la 069) y el modelo recibía «Velocidad: 0 … VSI
 * cacheado: 0/100» de un niño sin evaluar. El VSI es el de ficha GUARDADO (regla única de
 * «evaluado», el que enseña la app), no una media simple de las barras; y ya no se guarda
 * un percentil (lo daba contra jugadores de TODAS las cuentas, con los no evaluados como
 * 0): la comparación con pares es /api/benchmark/peer (implementación única, solo
 * jugadores propios).
 *
 * Útil cuando todavía no hay análisis de vídeo (Bunny no pagado, MVP, etc.)
 * y queremos llenar el dashboard de reportes con una valoración inicial.
 *
 * Body: { playerId: string }
 * Returns: { analysisId: string, reportsGenerated: number, vsi: number }
 *          422 { code: "coach_evaluation_missing" } si falta la evaluación del entrenador
 *          (VSI de ficha guardado o alguna de las 6 barras)
 *
 * Cost: ~€0.13 por jugador (1× Sonnet + 5× Haiku con prompt caching)
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { toVsi } from "../_lib/vsiStats";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages, responseText } from "../_lib/anthropic";
import { localeSchema, normalizeLocale, languageDirective } from "../../src/lib/shared/locale";
import { PHV_STATUS_LABEL_ES, type PhvCategory } from "../../src/lib/phv/phvGate";
import { trustAnthroForPlayer } from "../../src/lib/shared/sexGatedAnthro";
import { completeCoachMetrics, coachEvalTier, type CoachEvalTier, type PlayerMetrics } from "../../src/services/real/metricsService";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

// v1.1 = sin proyección de carrera (P1 bloque 7, D2); v1.0 = análisis base original.
const PIPELINE_VERSION = "baseline-v1.1";

const bodySchema = z.object({
  playerId: z.string().min(1),
  locale: localeSchema.optional(),
});

// ── Player profile shape ────────────────────────────────────────────
interface PlayerProfile {
  id: string;
  name: string | null;
  age: number | null;
  position: string | null;
  foot: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  competitive_level: string | null;
  /** Las 6 barras de la evaluación del entrenador (completas: sin ellas no se llega aquí). */
  metrics: PlayerMetrics;
  /**
   * PHV SOLO desde una fila COMPLETA y fiable de player_anthropometrics (gate
   * único · regla del owner 28-sep: 4 medidas introducidas + edad decimal desde la
   * fecha de nacimiento + sexo). Si no, category/offset null + gate_reason.
   */
  phv: {
    category: string | null;
    offset: number | null;
    /** Edad DECIMAL de la medición (la usada en Mirwald). */
    chronologicalAge: number | null;
    gate_reason: string | null;
  };
  vsi: number;
  tenant_id: string;
}

// ── Claude SDK helpers ──────────────────────────────────────────────

async function callClaude(opts: {
  model: typeof MODELS[keyof typeof MODELS];
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<Record<string, unknown>> {
  const res = await fetchMessages({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      ...modelParams(opts.model, opts.maxTokens ?? 1500),
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = responseText(data) || "{}";
  // Strip markdown fences if any
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { _raw: raw, _parseError: true }; }
}

// ── Shared player context for the prompts ───────────────────────────

/**
 * Bloque PHV del prompt desde el GATE ÚNICO. Con PHV fiable: estado por fase
 * (la categoría persistida es de ESTADO — early = pre-PHV —, no un timing vs
 * pares), offset y APHV con la edad DECIMAL de la medición. Sin PHV fiable: se
 * dice qué falta y se PROHÍBE al LLM afirmar maduración (antes recibía la
 * categoría cruda persistida y la citaba en los 6 reportes).
 */
export function phvBlock(p: Pick<PlayerProfile, "phv">): string {
  const { category, offset, chronologicalAge, gate_reason } = p.phv;
  if (category === null || offset === null) {
    return `PHV (maduración biológica · Mirwald): NO DISPONIBLE — ${gate_reason ?? "sin medición antropométrica completa"}.
El PHV solo se calcula con TODAS las medidas introducidas (talla, peso, talla sentado,
pierna, fecha de nacimiento del jugador y sexo). NO afirmes categoría, offset, estirón
ni estado de maduración en ningún reporte; en "phv_summary" explica qué medidas faltan.`;
  }
  const phase = PHV_STATUS_LABEL_ES[(category === "ontime" ? "ontme" : category) as PhvCategory] ?? category;
  const aphv = chronologicalAge !== null ? `${(chronologicalAge - offset).toFixed(2)}a` : "—";
  return `PHV (maduración biológica · Mirwald, medidas introducidas + edad decimal)
- Fase (estado en SU curva, NO timing vs pares): ${phase}
- Offset: ${offset > 0 ? "+" : ""}${offset} años
- APHV estimado: ${aphv}`;
}

function profileBlock(p: PlayerProfile): string {
  const m = p.metrics;
  return `JUGADOR
- Nombre: ${p.name ?? "—"}
- Edad cronológica: ${p.age ?? "?"} años
- Posición: ${p.position ?? "?"}
- Pie dominante: ${p.foot ?? "?"}
- Altura: ${p.height_cm ?? "?"} cm · Peso: ${p.weight_kg ?? "?"} kg
- Nivel competitivo: ${p.competitive_level ?? "no registrado (no lo supongas)"}

EVALUACIÓN DEL ENTRENADOR (6 barras 0-100, subjetiva; no es una medida)
- Velocidad: ${m.speed}    · Resistencia: ${m.stamina}
- Técnica: ${m.technique}  · Visión: ${m.vision}
- Tiro: ${m.shooting}      · Defensa: ${m.defending}
- VSI de ficha (evaluación del entrenador guardada, índice ponderado 0-100): ${p.vsi}/100

${phvBlock(p)}

LIMITACIÓN: Esta es una valoración baseline SIN ANÁLISIS DE VÍDEO. No hay
métricas biomecánicas, scanning rate, ni similarity con jugadores pro.
Basa el reporte en el perfil del jugador y la valoración subjetiva del coach.
Sé honesto sobre las limitaciones del análisis sin vídeo.`;
}

// (Sin «tendencia VSI» aquí: el antiguo computeVsiTrend —pendiente/momentum/delta—
//  corría sobre players.vsi_history, legacy SIN fechas ni origen, ver el handler.)

// ── VSI de ficha + tramo ─────────────────────────────────────────────

// (completeCoachMetrics vive en src/services/real/metricsService.ts: regla única de
//  «evaluación completa» de las 6 barras del blob `data.metrics`.)

const TIER_LABEL_ES: Record<CoachEvalTier, string> = {
  elite: "Élite",
  pro: "Pro",
  talent: "Talento",
  develop: "En desarrollo",
};

/**
 * VSI de ficha del jugador (el GUARDADO, el que muestra la app) y su tramo. Aquí se lee
 * de la columna `players.vsi` con toVsi (api/_lib/vsiStats.ts), como peer/Telegram/equipo;
 * Rankings y el informe impreso lo leen del blob `data.vsi` con fichaVsiFromBlob. Los
 * escritores (PlayerService, /api/players/crud) guardan ambos a la vez. Antes era una
 * MEDIA SIMPLE de las barras: un tercer VSI distinto del de la ficha para el mismo niño.
 */
export function computeVsi(p: { storedVsi: number }): { vsi: number; tier: CoachEvalTier; tierLabel: string } {
  const vsi = p.storedVsi;

  // SIN ajuste PHV ±5 (retirado · regla del owner 28-sep, inv #7): leía la
  // categoría PERSISTIDA —de ESTADO, early = pre-PHV— como si fuera timing
  // («precoz penaliza, tardío bonifica»: invertido) y se aplicaba sin medidas.
  // La corrección por maduración vive SOLO en el factor canónico gateado
  // (src/lib/phv/maturity.ts vía phvGate); este VSI baseline es el crudo.

  // Tramo con los cortes ÚNICOS de la evaluación del entrenador (coachEvalTier, P1 bloque
  // 5b; antes 85/70/55 aquí y 85/70/50 en la ficha). La UI traduce `tier`; `tierLabel`
  // (español) queda para filas y lectores antiguos.
  const tier = coachEvalTier(vsi);
  return { vsi, tier, tierLabel: TIER_LABEL_ES[tier] };
}

// ── Prompts (compactos · sin biomecánica) ──────────────────────────

const PROMPTS = {
  "player-report": {
    model: MODELS.reasoning,
    system: `Eres el motor del Player Report VITAS · baseline mode (sin vídeo).
Genera un reporte ancla para padre/madre del jugador. Lenguaje claro, motivador, honesto.
Output JSON estricto:
{
  "title": "Análisis VITAS · [Nombre]",
  "executive_summary": "string max 280 chars · resumen para padres",
  "phv_summary": "string max 200 chars · explicación PHV",
  "strengths": [{"title":"string","evidence":"string max 120 chars"}],
  "areas_to_improve": [{"title":"string","evidence":"string max 120 chars","priority":"high|medium|low"}],
  "next_4_weeks_focus": "string max 220 chars",
  "honesty_note": "string max 180 chars · matiz realista sobre análisis baseline"
}
2-3 fortalezas, 2-3 áreas de mejora. No escribas puntuaciones, índices ni tramos: la
evaluación del entrenador y su tramo los calcula la app. Sin markdown, solo JSON.`,
  },
  "lab-biomechanics": {
    model: MODELS.reasoning,
    system: `Eres el motor de LAB Biomecánica VITAS · baseline mode.
SIN vídeo, no hay métricas reales. Output un JSON con tabla de PROYECCIÓN basada en perfil.
{
  "title": "Proyección biomecánica · baseline",
  "summary": "string max 240 chars · qué se podría medir cuando haya vídeo",
  "metrics_table": [
    {"metric":"string","value":"≈ valor estimado","interpretation":"string"}
  ],
  "next_focus": "string max 200 chars · pendiente subir vídeo para análisis real"
}
4-6 métricas estimadas (sprint, ratio fuerza/peso, simetría, etc.) basadas en posición + edad + métricas coach.
Indica claramente que son ESTIMACIONES, no medidas reales. Sin markdown.`,
  },
  "dna-profile": {
    model: MODELS.fast,
    system: `Eres el motor del ADN Futbolístico VITAS · baseline.
Output JSON:
{
  "playing_style": "string max 100 chars",
  "archetype": "string max 80 chars · arquetipo táctico",
  "mentality": "string max 120 chars",
  "patrones": [{"patron":"string","frecuencia":"alta|media|baja","descripcion":"string"}]
}
2-3 patrones inferidos del perfil. Sin markdown.`,
  },
  "best-match": {
    model: MODELS.fast,
    system: `Eres el motor de Best-Match VITAS · baseline.
Sugiere TRES jugadores profesionales referentes diferenciados por LENS distinto:
  1. lens "tecnico" → match por estilo de juego y técnica
  2. lens "fisico"  → match por perfil físico, velocidad o resistencia
  3. lens "lider"   → match por mentalidad, liderazgo y juego sin balón

Cada match con su narrativa propia y un timeline (qué hacía el pro a la edad del jugador).

Output JSON estricto:
{
  "top3": [
    {
      "lens": "tecnico|fisico|lider",
      "nombre": "string · jugador profesional",
      "posicion": "string",
      "club": "string · último club conocido",
      "score": number 0-100 · similitud en este lens,
      "narrativa": "string max 180 chars · por qué se parecen en este lens",
      "timeline_at_age": "string max 140 chars · qué hacía el pro a la misma edad cronológica"
    }
  ],
  "primary": {
    "nombre": "string · el match con mayor score global",
    "posicion": "string",
    "club": "string",
    "score": number,
    "narrativa": "string max 180 chars"
  }
}

3 matches obligatorios, uno por cada lens. Sin markdown.`,
  },
  // Sin «projection» (P1 bloque 7, decisión del dueño D2): no hay un modelo validado que
  // prediga el nivel futuro de un menor («Top semipro», «Amateur alto»); se dejó de
  // generar con el mismo criterio que las proyecciones del perfil de rol (5c).
  "development-plan": {
    model: MODELS.fast,
    system: `Eres el motor del Plan de Desarrollo VITAS · baseline.
Output JSON:
{
  "goal_6months":  "string max 140 chars",
  "goal_18months": "string max 140 chars",
  "pillars": [
    {"pilar":"string","prioridad":"alta|media|baja","acciones":["string","string"]}
  ]
}
3-4 pilares, cada uno con 2-3 acciones concretas. Sin markdown.`,
  },
} as const;

type ReportType = keyof typeof PROMPTS;

// ── Handler ────────────────────────────────────────────────────────

export default withHandler(
  { schema: bodySchema, requireAuth: true, allowServiceToken: true, maxRequests: 10 },
  async ({ body, userId, isServiceCall }) => {
    if (!ANTHROPIC_API_KEY) {
      return errorResponse({ code: "no_api_key", message: "ANTHROPIC_API_KEY missing", status: 500 });
    }
    const input = body as z.infer<typeof bodySchema>;
    const reportLocale = normalizeLocale(input.locale);
    const startedAt = Date.now();

    // Perfil de jugador (PII de menores) + generación LLM de pago → ownership obligatorio.
    if (!isServiceCall && !(await ownsPlayer(input.playerId, userId))) {
      return errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar player ───────────────────────────────────────────
    const { data: playerRow, error: pErr } = await supabase
      .from("players")
      // Nivel desde el BLOB (`data`): la columna competitive_level la rellena el trigger
      // de players (024, redefinido en la 069:178) con 'Regional' cuando no hay nivel
      // (residuo P2) ⇒ no es un dato.
      // Barras del entrenador también del BLOB: las columnas metric_* valen 0 para quien no
      // está evaluado (trigger 069 + DEFAULT 0 de la 024; corregirlas es del bloque 7).
      .select("id, tenant_id, name, age, position, foot, height_cm, weight_kg, nivel_registrado:data->>competitiveLevel, metrics:data->metrics, vsi, gender:data->>gender, sexConfirmedAt:data->>sexConfirmedAt")
      .eq("id", input.playerId)
      .single();

    if (pErr || !playerRow) {
      return errorResponse({ code: "player_not_found", message: pErr?.message ?? "Jugador no existe", status: 404 });
    }

    // PHV SOLO desde la última fila COMPLETA y fiable (gate único): 4 medidas +
    // edad decimal por fecha de nacimiento (age_source, migración 069). Las
    // filas antiguas (edad entera) y el players.phv_category persistido NO cuentan.
    const { data: anthroRaw } = await supabase
      .from("player_latest_anthropometrics")
      .select("*")
      .eq("player_id", input.playerId)
      .maybeSingle();
    const anthroTrust = trustAnthroForPlayer(anthroRaw, playerRow); // + sexo registrado (P1 bloque 7)

    // Sin la evaluación del entrenador no se genera nada (invariante #2): hace falta el
    // VSI de ficha GUARDADO (regla única de «evaluado») y las 6 barras completas (van al
    // prompt). Ni ceros en el prompt ni un VSI recalculado distinto del de la ficha.
    const coachMetrics = completeCoachMetrics(playerRow.metrics);
    const storedVsi = toVsi(playerRow.vsi);
    if (!coachMetrics || storedVsi === null) {
      return errorResponse({
        code: "coach_evaluation_missing",
        message: "Falta la evaluación del entrenador: sin ella no se generan informes.",
        status: 422,
      });
    }
    const vsiBase = computeVsi({ storedVsi });

    const profile: PlayerProfile = {
      id: playerRow.id,
      tenant_id: playerRow.tenant_id,
      name: playerRow.name,
      age: playerRow.age,
      position: playerRow.position,
      foot: playerRow.foot,
      height_cm: playerRow.height_cm,
      weight_kg: playerRow.weight_kg,
      competitive_level:
        typeof playerRow.nivel_registrado === "string" && playerRow.nivel_registrado ? playerRow.nivel_registrado : null,
      metrics: coachMetrics,
      phv: {
        category:         anthroTrust.category,
        offset:           anthroTrust.offset,
        chronologicalAge: anthroTrust.chronologicalAge,
        gate_reason:      anthroTrust.gate_reason,
      },
      vsi: vsiBase.vsi,
    };

    // Ni `trend` ni `history` en analyses.vsi. Antes se calculaban (pendiente, momentum,
    // «delta») sobre players.vsi_history —legacy SIN fechas ni origen, con el 57.5
    // fabricado antes de #146— con este VSI de OTRA fórmula añadido al final: para
    // [57.5, 67.4] el panel de análisis pintaba «↗» y «+9.x pts». La única variación
    // válida del VSI de ficha es computeVsiDelta (src/lib/scoring/vsiDelta.ts), solo
    // entre dos evaluaciones con fecha; aquí no se inventa otra (invariante #7). Las
    // filas ya guardadas se limpian al leer (withoutUndatedVsiSeries).
    // Tampoco `peer` (percentil): ver la cabecera; las filas viejas lo pierden al leer.
    const vsiData = { ...vsiBase };

    // ── 2. Insertar analysis row (placeholder video_id sentinel) ───
    const sentinelVideoId = `baseline-${profile.id}-${Date.now()}`;
    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .insert({
        tenant_id: profile.tenant_id,
        player_id: profile.id,
        video_id: sentinelVideoId,
        user_id: userId,
        status: "processing",
        started_at: new Date().toISOString(),
        pipeline_version: PIPELINE_VERSION,
        biomechanics: null,
        phv: profile.phv.category ? { ...profile.phv } : null,
        vsi: vsiData,
        similarity: null,
      })
      .select()
      .single();

    if (aErr || !analysis) {
      return errorResponse({ code: "analysis_create_failed", message: aErr?.message ?? "no analysis", status: 500 });
    }

    // ── 3. Generar 6 reportes Claude en paralelo ───────────────────
    // La directiva de idioma va en el mensaje de usuario (compartido por los 6
    // reportes) → los system prompts quedan agnósticos de idioma y conservan el
    // cache ephemeral entre idiomas; el idioma de SALIDA lo fija reportLocale.
    const userMessage = `${languageDirective(reportLocale)}\n\n${profileBlock(profile)}`;

    const reportPromises = (Object.keys(PROMPTS) as ReportType[]).map(async (reportType) => {
      const cfg = PROMPTS[reportType];
      try {
        const content = await callClaude({
          model: cfg.model,
          system: cfg.system,
          user: userMessage,
          maxTokens: reportType === "player-report" ? 2500 : 1500,
        });
        return { reportType, content, model: cfg.model, ok: true as const };
      } catch (err) {
        return {
          reportType,
          content: null,
          model: cfg.model,
          ok: false as const,
          error: err instanceof Error ? err.message : "unknown",
        };
      }
    });

    const results = await Promise.all(reportPromises);
    const successful = results.filter((r) => r.ok);

    // ── 4. Persistir reportes ──────────────────────────────────────
    if (successful.length > 0) {
      const inserts = successful.map((r) => ({
        tenant_id: profile.tenant_id,
        analysis_id: analysis.id,
        player_id: profile.id,
        report_type: r.reportType,
        content: r.content,
        prompt_version: PIPELINE_VERSION,
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        cost_eur: 0,
        is_latest: true,
      }));
      const { error: rErr } = await supabase.from("reports").insert(inserts);
      if (rErr) {
        console.error("[baseline] reports insert failed:", rErr.message);
      }
    }

    // ── 5. Marcar analysis completed ───────────────────────────────
    const finalStatus = successful.length === 6 ? "completed" : "completed";
    // (no usamos completed_partial porque el CHECK constraint no lo permite)

    await supabase
      .from("analyses")
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        total_latency_ms: Date.now() - startedAt,
      })
      .eq("id", analysis.id);

    return successResponse({
      analysisId: analysis.id,
      status: finalStatus,
      reportsGenerated: successful.length,
      reportsFailed: 6 - successful.length,
      vsi: vsiData.vsi,
      tier: vsiData.tier,
      tierLabel: vsiData.tierLabel,
      totalLatencyMs: Date.now() - startedAt,
      failedReports: results.filter((r) => !r.ok).map((r) => ({
        type: r.reportType,
        error: "error" in r ? r.error : undefined,
      })),
    });
  }
);
