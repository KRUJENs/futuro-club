/**
 * VITAS Agent API — Role Profile Builder
 * POST /api/agents/role-profile
 *
 * Edge runtime + raw fetch a Anthropic API (sin SDK pesado).
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { checkUsageQuota, incrementUsage, usageExceededResponse } from "../_lib/usageGuard";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { hashInput, getCached, setCached, incrementHitCount } from "../_lib/agentCache";
import { roleProfileFallback } from "../_lib/agentFallbacks";
import { MODELS } from "../_lib/models";
import { normalizeLocale, languageDirective, localeSchema, type ReportLocale } from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

const roleSchema = z.object({
  player: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
  }).passthrough(),
  // Idioma de redacción (default "es"). Lo inyecta AgentService desde i18n.
  locale: localeSchema.optional(),
}).passthrough();

function buildRoleProfilePrompt(locale: ReportLocale): string {
  return `
Eres el motor de perfilado táctico de VITAS Football Intelligence.
Tu función es construir un perfil de rol completo y preciso para un jugador juvenil de fútbol.

POSICIONES VÁLIDAS: GK, RB, RCB, LCB, LB, DM, RCM, LCM, RW, LW, ST

POLIVALENCIA · cuando recibes player.secondaryPositions[] o videoContext.playedPosition:
- player.position: posición principal declarada por el coach
- player.secondaryPositions[]: posiciones que el coach declaró que también puede jugar
- videoContext.playedPosition: posición específica que el jugador jugó en ESTE video
- Si playedPosition está presente, evalúa el rendimiento DESDE LA PERSPECTIVA DE ESA POSICIÓN
- Devuelve positionAlternatives[]: ranking de posiciones donde podría rendir bien con score 0-100
  · Para cada alternativa, marca alreadyDeclared:true si ya está en {position, ...secondaryPositions}
  · Para alternativas NO declaradas con score >75 → es un descubrimiento, sugiere añadirla
  · Nunca recomiendes cambiar a una posición que YA está declarada (sería redundante)

ARQUETIPOS VÁLIDOS:
recuperador, interceptor, organizador, distribuidor, finalizador,
rematador, regateador, asociativo, pressing, desequilibrante,
salvador, ancla, constructor, carrilero, mediapunta,
extremo_puro, delantero_centro, falso_9, interior, box_to_box

REGLAS DE IDENTIDAD DOMINANTE:
- Si speed + stamina son las 2 métricas más altas → "fisico"
- Si technique + vision son las 2 más altas → "tecnico"
- Si shooting + speed son las 2 más altas → "ofensivo"
- Si defending + stamina son las 2 más altas → "defensivo"
- Si diferencia entre top 4 métricas < 10 puntos → "mixto"
La distribución de identidad debe sumar exactamente 1.0.

REGLAS DE CAPABILITIES:
- current: promedio ponderado de métricas relevantes por dimensión
- NO proyectes capacidades a futuro (ni a 6, 18 o 36 meses): no hay base validada
  para una proyección. Devuelve SOLO el nivel actual.
- Si player.phvCategory NO viene (phvDataAvailable=false: el PHV no se calcula sin
  TODAS las medidas introducidas — talla, peso, talla sentado, pierna, fecha de
  nacimiento y sexo), NO menciones PHV, estirón, maduración ni offset en ningún
  campo: no hay dato.

REGLAS DE CONFIANZA:
- minutesPlayed > 500: overallConfidence = 0.85
- minutesPlayed 200-500: overallConfidence = 0.70
- minutesPlayed < 200: overallConfidence = 0.55

REGLAS ABSOLUTAS DE DATOS:
1. Si no tienes un dato concreto, di "No disponible" o "Sin datos suficientes". NUNCA inventes valores.
2. NUNCA uses "aproximadamente", "más o menos", "alrededor de", "cercano a" para fabricar datos.
3. NUNCA compares con jugadores famosos ("el próximo Messi", "recuerda a Iniesta").
4. Si faltan >30% de las dimensiones de evaluación, penaliza el score explícitamente y menciona: "Evaluación parcial — datos insuficientes en: [dimensiones faltantes]".
5. Separa siempre observación directa (visto en video) de inferencia (estimado por modelo).
6. NUNCA menciones decisiones contractuales, económicas o de transferencias — no es nuestro dominio.
7. Banderas rojas (lesiones recurrentes, edad fuera de target, datos contradictorios) → mencionarlas SIEMPRE.

CAMPOS OBLIGATORIOS ADICIONALES:
- confidence_score (0-100): qué tan seguro estás de esta evaluación. Depende de: número de videos analizados, calidad del video, completitud de datos.
- data_completeness (0-100): porcentaje de dimensiones de evaluación que tienen datos reales.
- not_evaluated: array de strings listando las dimensiones que NO pudiste evaluar y por qué (ej. "velocidad máxima: sin tracking data disponible").

ESTRUCTURA JSON EXACTA — usa EXACTAMENTE estos nombres de campo (el cliente los valida; cualquier otra forma se rechaza):
{
  "dominantIdentity": "ofensivo|defensivo|tecnico|fisico|mixto",
  "identityDistribution": { "ofensivo": 0.20, "defensivo": 0.20, "tecnico": 0.20, "fisico": 0.20, "mixto": 0.20 },
  "topPositions": [ { "code": "RW", "fit": 0-100, "confidence": 0-1 } ],
  "positionAlternatives": [ { "code": "ST", "fit": 0-100, "alreadyDeclared": false, "reason": "…", "confidence": 0-1 } ],
  "topArchetypes": [ { "code": "regateador", "fit": 0-100, "stability": "emergente|en_desarrollo|estable|consolidado" } ],
  "capabilities": {
    "tactical":  { "current": 0-100 },
    "technical": { "current": 0-100 },
    "physical":  { "current": 0-100 }
  },
  "strengths": ["…"],
  "risks": ["…"],
  "gaps": ["…"],
  "overallConfidence": 0-1,
  "confidence_score": 0-100,
  "data_completeness": 0-100,
  "not_evaluated": ["…"],
  "summary": "≤400 caracteres"
}
RESTRICCIONES: identityDistribution suma exactamente 1.0 · topPositions y topArchetypes ≤5 · strengths ≤4 · risks ≤3 · gaps ≤3 · code de posición ∈ {GK,RB,RCB,LCB,LB,DM,RCM,LCM,RW,LW,ST} · stability y dominantIdentity solo los enums de arriba · fit 0-100, confidence/overallConfidence 0-1.

RESPONDE ÚNICAMENTE con JSON válido.
No incluyas texto, explicaciones ni markdown fuera del JSON.
Todos los números con 2 decimales máximo. El summary máximo 400 caracteres.

${languageDirective(locale)}
`;
}

export default withHandler(
  { schema: roleSchema, requireAuth: true, maxRequests: 30 },
  async ({ body, userId }) => {
    const locale = normalizeLocale(body.locale);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return successResponse(roleProfileFallback(body, "no_api_key"));
    }

    // ── Usage quota check ───────────────────────────────────────
    if (userId) {
      const usage = await checkUsageQuota(userId);
      if (!usage.allowed) return usageExceededResponse(usage);
    }

    // ── Cache check ─────────────────────────────────────────────
    const sbUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const playerId = body?.player?.id ?? null;

    if (sbUrl && sbKey && userId) {
      try {
        const cacheKey = await hashInput("role-profile", userId, body);
        const cached = await getCached(cacheKey, sbUrl, sbKey);
        if (cached) {
          incrementHitCount(cacheKey, sbUrl, sbKey).catch(() => {});
          return successResponse({ ...cached.response, _cached: true });
        }
      } catch { /* cache miss — proceed to Claude */ }
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       MODELS.fast,
        max_tokens:  1024,
        temperature: 0,
        system:      buildRoleProfilePrompt(locale),
        messages:    [{ role: "user", content: JSON.stringify(body) }],
      }),
    });

    if (!claudeRes.ok) {
      console.warn(`[RoleProfile] Claude API ${claudeRes.status}, using fallback`);
      return successResponse(roleProfileFallback(body, "claude_error"));
    }

    const claudeData = await claudeRes.json() as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    let fullText = "";
    for (const block of claudeData.content) {
      if (block.type === "text" && block.text) fullText += block.text;
    }

    const m = fullText.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn("[RoleProfile] No JSON in Claude response, using fallback");
      return successResponse(roleProfileFallback(body, "parse_error"));
    }

    const parsed = JSON.parse(m[0]);
    if (body?.player?.id) {
      parsed.playerId = body.player.id;
    }

    const tokensUsed = claudeData.usage
      ? claudeData.usage.input_tokens + claudeData.usage.output_tokens
      : 0;

    const result = { ...parsed, tokensUsed, agentName: "RoleProfileAgent" };

    // ── Cache store ─────────────────────────────────────────────
    if (sbUrl && sbKey && userId) {
      hashInput("role-profile", userId, body).then(cacheKey =>
        setCached(cacheKey, "role-profile", userId, playerId, null, result, tokensUsed, sbUrl, sbKey)
      ).catch(() => {});
    }

    // ── Usage log ───────────────────────────────────────────────
    // AWAIT: en edge una promesa sin await se descarta al devolver la respuesta →
    // la cuota no se contaría. incrementUsage captura sus errores (Promise<void>).
    if (userId) await incrementUsage(userId, "role-profile");

    return successResponse(result);
  },
);
