/**
 * VITAS · Team Intelligence Agent v1.1 · REACTIVADO Sprint B1
 * POST /api/agents/team-intelligence
 *
 * Edge runtime + raw fetch a Anthropic API.
 * Recibe observaciones de Gemini sobre el equipo (o fotogramas).
 * Retorna SSE → TeamIntelligenceOutput completo, SOLO a nivel de equipo:
 * sin dorsales ni filas/cifras por jugador (identidad.md: no hay identificación
 * por dorsal validada). Lo que el modelo aún emita por jugador se retira antes
 * de enviar (src/lib/shared/teamReportIdentity.ts). `yoloTrackData` ya no se usa:
 * solo servía para asociar pistas a jugadores (atribución sin validar).
 *
 * Histórico: marcado @deprecated en Sprint 4 d4 (no era MVP).
 * Reactivado en Sprint B1 al añadir team analysis a la oferta core
 * — diferenciador vs Veo/Pixellot que solo hacen highlights.
 *
 * Consumido por:
 *   - src/hooks/useTeamIntelligence.ts
 *   - src/pages/TeamAnalysisPage.tsx
 *
 * Vía paralela: api/team/baseline-team-analysis (SIN vídeo) para
 * generar informes de equipo cuando aún no hay vídeo disponible.
 */

import { withHandler } from "../_lib/withHandler";
import { MODELS, modelParams } from "../_lib/models";
import { fetchMessages } from "../_lib/anthropic";
import { checkUsageQuota, incrementUsage, usageExceededResponse } from "../_lib/usageGuard";
import { checkTeamReportQuality } from "../_lib/reportQualityCheck";
import { NO_VISUAL_INPUT, hasGeminiObservations, hasVisualInput } from "../../src/lib/shared/teamVisualInput";
import { withholdIndividualData } from "../../src/lib/shared/teamReportIdentity";
import { gateClipAnalysis, clipGateErrorResponse } from "../_lib/analysisConsentGate";
import { ownsVideo } from "../_lib/ownership";
import { errorResponse } from "../_lib/apiResponse";
import {
  normalizeLocale,
  languageDirective,
  phvDistributionLine,
  phvConsideration,
} from "../../src/lib/shared/locale";

export const config = { runtime: "edge" };

export default withHandler(
  { requireAuth: true, rawBody: true },
  async ({ rawBody, userId, tenantId, ip }) => {
    // ── Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate) ──
    // ANTES del stream y de la cuota: los fotogramas/observaciones vienen del navegador,
    // pero el `videoId` del cliente se resuelve en el servidor (por id o bunny_video_id):
    // si es una fila `videos` tiene que ser del usuario y el `player_id` de cada fila de ese
    // vídeo se comprueba aunque el informe sea de equipo (B1). Sin fila → video_ref, la
    // declaración viene en ESTA petición y, al ser vídeo de equipo, por jugador no aplica.
    let preBody: { attestation?: unknown; videoId?: unknown; locale?: unknown; teamContext?: { locale?: unknown } };
    try {
      const parsed: unknown = JSON.parse(rawBody ?? "");
      if (!parsed || typeof parsed !== "object") throw new Error("body no es un objeto JSON");
      preBody = parsed as typeof preBody;
    } catch {
      return errorResponse("Body JSON inválido", 400, "PARSE_ERROR");
    }
    const consent = await gateClipAnalysis({
      videoId: preBody.videoId,
      requireVideoRow: false,
      attestation: preBody.attestation,
      playerId: null,
      actor: { userId, tenantId, ip },
      endpoint: "agents/team-intelligence",
      scope: "team",
      locale: preBody.locale ?? preBody.teamContext?.locale,
      ownsVideo: (video, uid) => ownsVideo(video, uid),
    });
    if (!consent.allowed) return clipGateErrorResponse(consent);

    // ── Usage quota check (before stream) ──────────────────────
    if (userId) {
      const usage = await checkUsageQuota(userId);
      if (!usage.allowed) return usageExceededResponse(usage);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          send("progress", { step: "Iniciando análisis de equipo...", percent: 5 });
          // withHandler ya leyó el cuerpo (rawBody: true) → ctx.rawBody, nunca req.json().
          const body = JSON.parse(rawBody ?? "");
          const { teamContext, keyframes, videoId, analysisFocus } = body;
          // Identidad (identidad.md): team level only. A per-player list (legacy
          // jugadoresObservados with an LLM-guessed dorsal) or a text naming an
          // individual never reaches the prompt, whoever sent it.
          const geminiObservations = withholdIndividualData(body.geminiObservations).value as typeof body.geminiObservations;

          // FASE 5 · idioma + maduración biológica del equipo (diferenciador VITAS)
          const locale = normalizeLocale(body.locale ?? teamContext?.locale);
          const phvLine = phvDistributionLine(teamContext?.phvDistribution ?? body.phvDistribution, locale);
          const phvNote = phvConsideration(teamContext?.phvDistribution ?? body.phvDistribution, locale);
          const phvBlock = phvLine ? `\n- ${phvLine}\n  ${phvNote}` : "";

          if (!teamContext) {
            send("error", { message: "Faltan datos requeridos (teamContext)" });
            controller.close();
            return;
          }

          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            send("error", { message: "ANTHROPIC_API_KEY no configurada en el servidor" });
            controller.close();
            return;
          }

          send("progress", { step: "Preparando análisis táctico...", percent: 15 });

          const ctx = teamContext;
          // Un objeto vacío ({}) no es una observación del vídeo.
          const hasGemini = hasGeminiObservations(geminiObservations);

          // Build image content blocks from keyframes (fallback mode)
          const imageBlocks: unknown[] = [];
          if (!hasGemini && Array.isArray(keyframes)) {
            // Claude API limit: max 20 images per request
            const maxFrames = 20;
            const allKf = keyframes.length <= maxFrames
              ? keyframes
              : keyframes.filter((_: unknown, i: number) => i % Math.ceil(keyframes.length / maxFrames) === 0).slice(0, maxFrames);
            for (const kf of allKf) {
              const url: string = typeof kf === "string" ? kf : kf?.url ?? "";
              if (url.startsWith("data:image/")) {
                const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
                if (match) {
                  imageBlocks.push({
                    type: "image",
                    source: { type: "base64", media_type: match[1], data: match[2] },
                  });
                }
              } else if (url.startsWith("http")) {
                imageBlocks.push({
                  type: "image",
                  source: { type: "url", url },
                });
              }
            }
          }

          // ── GATE · sin entrada visual no hay informe (invariantes 2-3) ──────
          // Ni observación de Gemini ni fotogramas utilizables → el modelo no ha
          // visto el partido; un informe "de 0 fotogramas" sería inventado.
          // Se rechaza con código + motivo; el finally cierra el stream.
          if (!hasVisualInput(geminiObservations, imageBlocks.length)) {
            const gateReason =
              "Sin entrada visual: no hay observación del vídeo ni fotogramas utilizables. " +
              "No se genera un informe de equipo sin ver el partido.";
            send("error", { message: gateReason, code: NO_VISUAL_INPUT, gate_reason: gateReason });
            return;
          }

          send("progress", { step: hasGemini ? "Generando informe táctico..." : `Analizando ${imageBlocks.length} fotogramas...`, percent: 30 });

          // Gemini observations block (team level only — see the guard above)
          const geminiBlock = hasGemini ? `
OBSERVACIONES TÁCTICAS DEL EQUIPO (generadas por IA que analizó el video completo):

FORMACIÓN DETECTADA: ${geminiObservations.formacionDetectada || "No identificada"}
POSESIÓN ESTIMADA: Equipo ${geminiObservations.posesionEstimada?.equipo ?? "?"}% — Rival ${geminiObservations.posesionEstimada?.rival ?? "?"}%

FASES DE JUEGO:
- Pressing: ${geminiObservations.fasesJuego?.pressing?.tipo ?? "?"} (intensidad: ${geminiObservations.fasesJuego?.pressing?.intensidad ?? "?"}/10, línea: ${geminiObservations.fasesJuego?.pressing?.alturaLinea ?? "?"})
  ${(geminiObservations.fasesJuego?.pressing?.observaciones ?? []).join("; ")}
- Trans. ofensiva: ${geminiObservations.fasesJuego?.transicionOfensiva?.velocidad ?? "?"} — ${(geminiObservations.fasesJuego?.transicionOfensiva?.patrones ?? []).join(", ")}
- Trans. defensiva: ${geminiObservations.fasesJuego?.transicionDefensiva?.velocidad ?? "?"} — ${(geminiObservations.fasesJuego?.transicionDefensiva?.patrones ?? []).join(", ")}
- Posesión: ${geminiObservations.fasesJuego?.posesion?.estilo ?? "?"} — ${(geminiObservations.fasesJuego?.posesion?.patrones ?? []).join(", ")}

MOMENTOS COLECTIVOS:
${(geminiObservations.momentosColectivos ?? []).map((m: { timestamp: string; tipo: string; descripcion: string }) => `- [${m.timestamp}] (${m.tipo}) ${m.descripcion}`).join("\n")}

RESUMEN: ${geminiObservations.resumenGeneral ?? ""}

Estas observaciones provienen del análisis del VIDEO COMPLETO. Úsalas como base principal.` : "";

          const introBlock = hasGemini
            ? `Eres VITAS, un sistema de análisis táctico de fútbol de nivel profesional. Combinas la visión de un analista de rendimiento de primer equipo con el conocimiento metodológico de un director de formación de cantera.

TU PERFIL COMO ANALISTA TÁCTICO:
- Formado en análisis de rendimiento con experiencia en departamentos técnicos de clubes profesionales
- Especialista en identificación de modelos de juego, principios tácticos y patrones colectivos
- Conocimiento profundo de sistemas de juego modernos: juego posicional (Guardiola), gegenpressing (Klopp), defensa zonal (Sacchi), juego directo estructurado (Ancelotti)
- Capacidad de adaptar la evaluación al nivel competitivo — lo que se exige a un equipo profesional es diferente a lo que se espera en categorías formativas

PRINCIPIOS DE TU ANÁLISIS:
1. MODELO DE JUEGO: Todo equipo (consciente o inconscientemente) tiene un modelo. Tu trabajo es identificar los PRINCIPIOS que guían su juego en cada fase
2. COHERENCIA SISTÉMICA: ¿Las decisiones individuales de los jugadores están alineadas con un plan colectivo? ¿O cada uno juega por su cuenta?
3. VULNERABILIDADES EXPLOTABLES: Identifica los momentos y zonas donde el equipo es vulnerable — esto es lo que más valora un entrenador rival
4. CONTEXTO FORMATIVO: En equipos juveniles, valora si se VEN principios en construcción. Un equipo de sub-14 que intenta salir jugando y pierde balones es MÁS prometedor que uno que solo despeja
5. RECOMENDACIONES ACCIONABLES: Cada recomendación debe ser algo que el entrenador pueda trabajar en el próximo entrenamiento

VOCABULARIO TÁCTICO (usa con precisión):
- Superioridad numérica: más jugadores en una zona que el rival
- Superioridad posicional: mejor posicionamiento que genera ventaja sin necesitar más jugadores
- Superioridad cualitativa: ventaja por calidad individual (ej: extremo rápido vs lateral lento)
- Pressing triggers: señales que activan la presión colectiva (pase atrás, mal control, pase lateral)
- Rest defense: jugadores que se quedan atrás durante el ataque para prevenir contraataques
- Tercer hombre: jugador que recibe el pase después de una combinación de 2, superando una línea
- Half-space: canales intermedios entre banda y centro — zonas de máxima creación en fútbol moderno
- Basculación: movimiento lateral colectivo de la defensa hacia el lado del balón
- Escalonamiento: organización vertical de la defensa con distancia entre líneas

ANCLAS DE SCORING COLECTIVO (escala 1-10):
- 9-10: Automatismos de equipo profesional. Principios claros en cada fase. Sincronización excepcional
- 7-8: Modelo de juego definido con buenos automatismos. Errores puntuales de ejecución pero principios claros
- 5-6: Principios básicos visibles pero ejecución inconsistente. Se ven intenciones pero falta trabajo
- 3-4: Desorganización frecuente. Acciones individuales predominan sobre el colectivo
- 1-2: Sin modelo de juego identificable. Cada jugador actúa por su cuenta

VELOCIDAD DE DECISIÓN COLECTIVA:
- Transición ofensiva: <4s de recuperación a primer pase progresivo = rápida. 4-7s = media. >7s = lenta
- Gegenpressing: <3s de pérdida a primera presión = alto. 3-5s = medio. >5s = bajo/repliegue
- Circulación en posesión: 1-2 toques promedio = rápida. 3+ toques = lenta (puede ser intencional en equipos posicionales)

CONTEXTO DEL RIVAL (obligatorio):
- Evalúa el nivel del rival: ¿presiona? ¿defiende con anticipación? ¿tiene talento individual?
- Rival fuerte (×1.15): El rendimiento del equipo gana más peso
- Rival medio (×1.0): Evaluación estándar
- Rival débil (×0.85): No sobrevaluar rendimiento ofensivo contra equipo pasivo
- SIEMPRE menciona la calidad estimada del rival en el resumenEjecutivo

CALIDAD DE ACCIONES COLECTIVAS:
- Circulación con cambio de orientación: alto valor táctico — indica equipo que busca desequilibrio posicional
- Pressing coordinado (3+ jugadores cerrando espacio simultáneamente): indica trabajo táctico del cuerpo técnico
- Salida de balón limpia desde atrás bajo presión: indica valentía y trabajo de posesión
- Contraataque con 3+ jugadores involucrados: indica transiciones trabajadas

PERSONALIDAD COLECTIVA (evaluar):
- ¿Cómo reacciona el equipo cuando va perdiendo? ¿Sube intensidad o se desmorona?
- ¿Mantienen el modelo de juego bajo presión o recurren a pelotazos?
- ¿Los jugadores se ayudan mutuamente tras errores o se culpan?
- ¿El equipo tiene una identidad clara (presión, posesión, directo) o juega sin personalidad?

Un sistema de observación ha analizado el video completo del equipo y te proporciona sus observaciones detalladas. Tu trabajo es interpretar estas observaciones con criterio de analista experto y generar el informe táctico estructurado.`
            : `Eres VITAS, un sistema de análisis táctico de fútbol de nivel profesional con experiencia en departamentos técnicos de clubes y academias. Analiza estos ${imageBlocks.length} fotogramas de un partido de fútbol:`;

          const frameInstructionBlock = !hasGemini
            ? `\nObserva cuidadosamente cada fotograma. Identifica al equipo con uniforme ${ctx.teamColor || "?"}.`
            : "";

          const prompt = `${introBlock}

DATOS DEL EQUIPO:
- Color uniforme: ${ctx.teamColor || "?"}
- Color rival: ${ctx.opponentColor || "no especificado"}
- Nivel competitivo: ${ctx.competitiveLevel || "formativo"}${phvBlock}
${geminiBlock}${frameInstructionBlock}
${analysisFocus ? `
ENFOQUE DEL ANÁLISIS: Concentra especialmente el análisis en: ${Array.isArray(analysisFocus) ? analysisFocus.join(", ") : analysisFocus}.
Dedica más detalle a estas acciones en el resumen ejecutivo, fases de juego y métricas colectivas. Si el enfoque es defensivo, profundiza en pressing, línea defensiva, recuperaciones. Si es ofensivo, profundiza en circulación, transiciones ofensivas, centros, disparos.` : ""}

REGLAS DE HONESTIDAD (docx #14):
- Distingue SIEMPRE la procedencia: lo del bloque "OBSERVACIONES TÁCTICAS" es OBSERVADO POR IA (análisis del vídeo), y si solo hay fotogramas es INFERIDO de imágenes. Marca lo inferido como tal; no presentes inferencia como observación.
- Si un dato no aparece en los bloques de entrada (formación, posesión, pressing, un contador de eventos), escribe "no observado" y NO lo inventes. Un contador en 0 sin evidencia no significa "0 eventos": es "no observado" — no infieras acciones que no estén en las observaciones.
- Con datos escasos, BAJA la confianza; deja listas vacías ([]) en vez de rellenar con patrones tácticos genéricos.

IDENTIDAD — SOLO NIVEL DE EQUIPO (son menores de edad; no existe identificación por dorsal validada):
- No identifiques a ningún jugador concreto. Nunca escribas dorsales, números de camiseta, nombres, ni una lista, valoración o cifra por jugador.
- Describe por líneas o grupos ("los laterales", "la línea defensiva", "los tres delanteros"), nunca por individuo.

Responde EXCLUSIVAMENTE con un JSON válido (sin markdown, sin backticks) con esta estructura exacta:

{
  "videoId": "${videoId || "unknown"}",
  "generatedAt": "${new Date().toISOString()}",
  "equipoAnalizado": {
    "colorUniforme": "${ctx.teamColor || "?"}",
    "jugadoresDetectados": number
  },
  "resumenEjecutivo": "string max 500 chars — evaluación global del equipo",
  "formacion": {
    "sistema": "4-3-3",
    "variantes": ["En ataque pasa a 3-4-3 con laterales altos"],
    "rigidez": 1-10
  },
  "posesion": {
    "porcentaje": 55,
    "estiloCirculacion": "string max 200",
    "zonasDominadas": ["banda derecha", "mediocampo"]
  },
  "fasesJuego": {
    "pressing": {
      "tipo": "pressing alto tras pérdida",
      "alturaLinea": "alta|media|baja",
      "intensidad": 1-10,
      "descripcion": "string max 200"
    },
    "transiciones": {
      "ofensiva": {"velocidad":"rápida|media|lenta","patron":"string","descripcion":"string max 200"},
      "defensiva": {"velocidad":"rápida|media|lenta","patron":"string","descripcion":"string max 200"}
    }
  },
  "metricasColectivas": {
    "compacidad": 1-10,
    "alturaLineaDefensiva": "alta|media|baja",
    "amplitud": 1-10,
    "sincronizacion": 1-10,
    "descripcion": "string max 300"
  },
  "evaluacionGeneral": {
    "fortalezasEquipo": ["max 4 strings"],
    "areasTrabajar": ["max 3 strings"],
    "recomendaciones": ["max 3 strings — acciones concretas para el entrenador"]
  },
  "confianza": 0-1
}

REGLAS CRÍTICAS:
- Solo nivel de equipo: el JSON no lleva ningún campo por jugador (ni "jugadores", ni dorsal, ni número, ni nombre)

EVALUACIÓN DE MÉTRICAS COLECTIVAS:
- compacidad (1-10): ¿Qué tan juntas están las líneas del equipo? Un equipo compacto tiene máximo 35m entre la última línea defensiva y la primera ofensiva. 8+ = bloque compacto que se mueve junto. 4- = equipo disperso con huecos entre líneas
- alturaLineaDefensiva: "alta" si la línea defensiva está en el centro del campo o más arriba, "media" si entre el centro y el borde del área, "baja" si cerca del área propia
- amplitud (1-10): ¿El equipo usa todo el ancho del campo? 8+ = laterales/extremos tocan la línea de banda, cambios de orientación frecuentes. 4- = juego concentrado solo por un lado o por el centro
- sincronizacion (1-10): ¿Los jugadores se mueven como unidad o hay desconexiones? En pressing: ¿presionan todos juntos? En ataque: ¿los movimientos son coordinados? 8+ = automatismos claros. 4- = cada jugador actúa por su cuenta

RECOMENDACIONES PARA EL ENTRENADOR:
- Deben ser ESPECÍFICAS y ACCIONABLES — no "mejorar las transiciones" sino "trabajar pressing inmediato tras pérdida con ejercicio de 6v6+2 en espacio reducido"
- Conecta cada recomendación con algo OBSERVADO en el video: "El espacio entre centrales y mediocampistas cuando el rival supera el pressing sugiere trabajar distancias entre líneas en ejercicios de 11v11 posicional"
- Máximo 3 recomendaciones — priorizadas por impacto
- En equipos formativos: incluye al menos una recomendación POSITIVA (qué reforzar/mantener) además de lo que mejorar
- Sé honesto y específico para el nivel competitivo
- ${languageDirective(locale)}`;

          const content: unknown[] = hasGemini
            ? [{ type: "text", text: prompt }]
            : [...imageBlocks, { type: "text", text: prompt }];

          send("progress", { step: "Procesando con IA...", percent: 45 });

          let fullText = "";
          try {
            const claudeRes = await fetchMessages({
              method: "POST",
              headers: {
                "Content-Type":      "application/json",
                "x-api-key":         apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                ...modelParams(MODELS.reasoning, 8000),
                messages:   [{ role: "user", content }],
              }),
            });

            if (!claudeRes.ok) {
              const errBody = await claudeRes.text().catch(() => "");
              console.error("Claude API error:", claudeRes.status, errBody);
              send("error", { message: `Error de Claude API: ${claudeRes.status}` });
              controller.close();
              return;
            }

            const data = await claudeRes.json() as {
              content: Array<{ type: string; text?: string }>;
            };
            for (const block of data.content) {
              if (block.type === "text" && block.text) fullText += block.text;
            }
          } catch (e: unknown) {
            console.error("Claude fetch error:", e instanceof Error ? e.message : e);
            send("error", { message: "Error conectando con Claude API" });
            controller.close();
            return;
          }

          send("progress", { step: "Procesando respuesta...", percent: 85 });

          let report = null;
          if (fullText) {
            try {
              const m = fullText.match(/\{[\s\S]*\}/);
              if (m) report = JSON.parse(m[0]);
            } catch (e) {
              console.error("JSON parse error:", e, "Raw text:", fullText.substring(0, 200));
            }
          }

          if (!report) {
            send("error", { message: "No se pudo parsear la respuesta de Claude" });
            controller.close();
            return;
          }

          // ── Semantic validation + retry (max 1) ──────────────────────────
          const quality = checkTeamReportQuality(report);
          if (!quality.valid && quality.qualityScore < 60 && quality.feedbackForAgent) {
            send("progress", { step: "Validando calidad... reintentando", percent: 88 });
            try {
              const retryPrompt = `${prompt}\n\n--- CORRECCIÓN REQUERIDA ---\n${quality.feedbackForAgent}\n\nEl JSON previo tenía estos problemas. Regenera el JSON completo corregido:`;
              const retryContent = hasGemini
                ? [{ type: "text", text: retryPrompt }]
                : [...imageBlocks, { type: "text", text: retryPrompt }];

              const retryRes = await fetchMessages({
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                  ...modelParams(MODELS.reasoning, 8000),
                  messages: [{ role: "user", content: retryContent }],
                }),
              });

              if (retryRes.ok) {
                const retryData = await retryRes.json() as { content: Array<{ type: string; text?: string }> };
                let retryText = "";
                for (const block of retryData.content) {
                  if (block.type === "text" && block.text) retryText += block.text;
                }
                if (retryText) {
                  const rm = retryText.match(/\{[\s\S]*\}/);
                  if (rm) {
                    const retryReport = JSON.parse(rm[0]);
                    const retryQuality = checkTeamReportQuality(retryReport);
                    if (retryQuality.qualityScore > quality.qualityScore) {
                      report = retryReport;
                    }
                  }
                }
              }
            } catch (retryErr) {
              console.error("[team-intelligence] retry failed:", retryErr);
            }
          }

          // Identidad (identidad.md): lo que el modelo aún emita por jugador (filas,
          // dorsal, textos que nombran a un individuo) se retira y se cuenta.
          report = withholdIndividualData(report).value;

          send("progress", { step: "Finalizando informe táctico...", percent: 95 });
          send("complete", { report, videoId, timestamp: new Date().toISOString() });

          // ── Usage log ────────────────────────────────────────
          // AWAIT antes de cerrar el stream: en edge una promesa sin await se
          // descarta al terminar el callback → la cuota no se contaría.
          if (userId) await incrementUsage(userId, "team-intelligence");
        } catch (error: unknown) {
          send("error", { message: error instanceof Error ? error.message : "Error interno" });
        } finally {
          // Las salidas tempranas ya cierran el stream; un segundo close() lanza
          // "Controller is already closed" y rechaza start() (evento de error perdido).
          try { controller.close(); } catch { /* ya cerrado */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  }
);
