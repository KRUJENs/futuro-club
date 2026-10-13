/**
 * VITAS - Video Observation Agent (Gemini)
 * POST /api/agents/video-observation
 *
 * Node runtime (no Edge) — video puede ser grande.
 * Envía el video completo a Gemini para observación detallada.
 * Retorna JSON con timeline, dimensiones, momentos y patrones.
 *
 * Consentimiento (decisión del owner, 30 sep · api/_lib/analysisConsentGate):
 *   - llamadas con JWT de USUARIO (TeamBaselinePage, CompareRivalPage): deben traer
 *     `videoId` de una fila `videos` que gestione el usuario, la `videoUrl` de ESE vídeo
 *     y la declaración (`attestation`, o una ya guardada con el vídeo); si el vídeo tiene
 *     un jugador menor de 14 conocido, además su consentimiento parental verificado. Sin
 *     fichero en base64. Todo ANTES del tripwire de gasto y de Gemini.
 *   - llamadas de SERVICIO (cola → gemini-analyze / inline, live/aggregate): el gate va
 *     en el llamador, antes de despachar; aquí no se repite.
 */

import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { isOverBudget, recordSpendUsd, budgetExceededResponse } from "../_lib/budgetGuard";
import { normalizeLocale, languageDirective } from "../../src/lib/shared/locale";
import { GEMINI_MODEL } from "../../src/lib/shared/geminiModel";
import { assertAllowedVideoUrl, fetchAllowedVideo, VideoUrlError } from "../_lib/videoUrlGuard";
import { enforceUserVideoObservationConsent } from "../_lib/analysisConsentGate";
import { ownsPlayer, ownsVideo } from "../_lib/ownership";

export const config = { runtime: "nodejs", maxDuration: 120 };

interface GeminiObservation {
  timeline: Array<{
    timestamp: string;
    tipo: string;
    descripcion: string;
  }>;
  dimensiones: Record<string, {
    observaciones: string[];
    score_estimado: number | null; // null = no observable / jugador no identificado
  }>;
  momentosDestacados: Array<{
    timestamp: string;
    tipo: "positivo" | "negativo";
    descripcion: string;
  }>;
  patronesJuego: string[];
  resumenGeneral: string;
  // Cómo se identificó al jugador (identidad.md: SOLO dorsal + equipación, nunca cara).
  identificacion?: {
    estado: "identificado" | "unico_jugador" | "no_identificado";
    metodo: "dorsal_y_color" | "unico_jugador_en_plano" | null;
    dorsalObservado: string | null;
    colorObservado: string | null;
    confianza: "alta" | "media" | "baja";
    motivo: string;
  };
  // El prompt pide null cuando un evento no se pudo contar (o el jugador no fue
  // identificado); el adaptador api/_lib/geminiBiomechanics.ts los trata como number|null.
  eventosContados: {
    pasesCompletados: number;
    pasesFallados: number;
    pasesProgresivos: number;
    regatesConVentaja: number;
    regatesSinVentaja: number;
    pressingEfectivo: number;
    pressingInefectivo: number;
    escaneos: number;
    recuperaciones: number;
    robos: number;              // tackles: recuperación POR CONTACTO (entrada al cuerpo/balón)
    anticipaciones: number;     // intercepciones: cortar línea de pase ANTES de que el rival reciba
    perdidas: number;           // turnovers: errores no forzados que entregan posesión
    duelosGanados: number;
    duelosPerdidos: number;
    disparosAlArco: number;
    disparosFuera: number;
    centros: number;
    faltas: number;
  };
}

export default withHandler(
  // allowServiceToken: la cola (crons/process-analyses-queue), pipeline/gemini-analyze
  // y live/aggregate llaman server-to-server con INTERNAL_API_TOKEN / CRON_SECRET.
  // Las llamadas directas desde la UI siguen exigiendo JWT de usuario.
  { requireAuth: true, allowServiceToken: true, rawBody: true },
  async ({ rawBody, userId, tenantId, isServiceCall, ip }) => {
    try {
      // withHandler ya leyó el cuerpo (rawBody: true) → usar ctx.rawBody, nunca
      // req.json() (antes fallaba SIEMPRE y se devolvía como 413 falso).
      // Un cuerpo > ~4.5MB lo corta Vercel antes de llegar aquí.
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody ?? "");
        if (!parsed || typeof parsed !== "object") throw new Error("body no es un objeto JSON");
        body = parsed as Record<string, unknown>;
      } catch (parseErr) {
        console.error("[Gemini] Body parse error:", parseErr);
        return errorResponse("Body JSON inválido", 400, "PARSE_ERROR");
      }
      const { videoUrl, videoBase64: videoBase64FromBody, mediaType: mediaTypeFromBody, playerContext } = body;
      const locale = normalizeLocale(body.locale);
      // Ámbito de la observación. "player" (por defecto, el estricto): informe de UN
      // jugador → exige identificarlo por dorsal + color o abstenerse (identidad.md).
      // "team": baseline de equipo, rival y live aggregate → se observa al equipo y no
      // se identifica ni se atribuye nada a un jugador, así que no aplica esa abstención.
      const analysisScope: "player" | "team" = body.analysisScope === "team" ? "team" : "player";

      if (!playerContext) {
        return errorResponse("Faltan datos requeridos (playerContext)", 400);
      }
      if (!videoUrl && !videoBase64FromBody) {
        return errorResponse("Faltan datos requeridos (videoUrl o videoBase64)", 400);
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return errorResponse("GEMINI_API_KEY no configurada", 503, "GEMINI_NOT_CONFIGURED");
      }

      // Allowlist de videoUrl ANTES del tripwire: una URL rechazada no cuenta como
      // gasto Gemini (si no, peticiones inválidas en bucle inflarían el ledger global).
      // La descarga re-valida cada salto de redirección (fetchAllowedVideo).
      if (videoUrl && typeof videoUrl === "string") {
        try {
          assertAllowedVideoUrl(videoUrl);
        } catch (urlErr) {
          if (!(urlErr instanceof VideoUrlError)) throw urlErr;
          console.warn(`[Gemini] videoUrl rechazada (${urlErr.code}): ${urlErr.message}`);
          return errorResponse(urlErr.message, urlErr.status, urlErr.code);
        }
      }

      // Consentimiento de las llamadas de USUARIO (antes de gastar): vídeo guardado propio,
      // URL de ese vídeo, declaración y, si es un menor de 14 conocido, consentimiento parental.
      if (!isServiceCall) {
        const gate = await enforceUserVideoObservationConsent({
          videoId: body.videoId,
          videoUrl,
          hasBase64: Boolean(videoBase64FromBody),
          attestation: body.attestation,
          scope: analysisScope,
          actor: { userId, tenantId, ip },
          locale,
          ownsVideo: (video, uid) => ownsVideo(video, uid),
          ownsPlayer: (pid, uid) => ownsPlayer(pid, uid),
        });
        if (!gate.allowed) return gate.response;
      }

      // Tripwire de presupuesto (054): Gemini vídeo es de las llamadas más caras.
      if (await isOverBudget()) return budgetExceededResponse();
      await recordSpendUsd("gemini-video");

      // Obtener video como base64 — desde URL (descarga server-side) o directo
      let videoBase64: string;
      let mediaType: string;

      if (videoUrl && typeof videoUrl === "string") {
        // Descarga server-side SOLO desde nuestros hosts Bunny (api/_lib/videoUrlGuard):
        // https + allowlist por env (falla cerrado sin BUNNY_CDN_HOSTNAME), redirecciones
        // manuales re-validadas, content-type video/* y techo de tamaño antes y durante
        // la lectura. Antes: fetch a cualquier URL (SSRF) y sin límite (coste/memoria).
        try {
          const video = await fetchAllowedVideo(videoUrl);
          // Node.js Buffer para base64 (btoa no existe en Node) — vista sin copia.
          videoBase64 = Buffer.from(video.bytes.buffer, video.bytes.byteOffset, video.bytes.byteLength).toString("base64");
          mediaType = video.contentType;
          const sizeMB = (video.bytes.byteLength / 1024 / 1024).toFixed(1);
          console.log(`[Gemini] Video descargado: ${sizeMB}MB, tipo: ${mediaType}, host: ${new URL(video.finalUrl).hostname}`);
        } catch (dlErr) {
          if (dlErr instanceof VideoUrlError) {
            console.warn(`[Gemini] videoUrl rechazada (${dlErr.code}): ${dlErr.message}`);
            return errorResponse(dlErr.message, dlErr.status, dlErr.code);
          }
          console.error("[Gemini] Error descargando video:", dlErr);
          return errorResponse(`Error descargando video: ${dlErr instanceof Error ? dlErr.message : "unknown"}`, 502, "VIDEO_DOWNLOAD_ERROR");
        }
      } else {
        videoBase64 = videoBase64FromBody as string;
        mediaType = (mediaTypeFromBody as string) || "video/mp4";
      }

      const ctx = playerContext as {
        age: number;
        position: string;
        name?: string;
        foot?: string;
        height?: number;
        weight?: number;
        jerseyNumber?: number | string;
        teamColor?: string;
        competitiveLevel?: string;
      };

      // Calibración de exigencia por edad y nivel competitivo.
      // Edad desconocida (null/ausente) ⇒ NO se calibra por edad ni se deja que el
      // modelo la estime por el aspecto (antes el pipeline mandaba 12 por defecto, y
      // además `null <= 12` caía en la rama sub-12).
      const ageKnown = typeof ctx.age === "number" && Number.isFinite(ctx.age);
      const ageCalibration = !ageKnown
        ? `EDAD NO REGISTRADA: no conoces la edad del jugador. NO la estimes ni la deduzcas por su aspecto físico. No apliques calibración por edad y di en resumenGeneral que la evaluación no está calibrada por edad.`
        : ctx.age <= 12
        ? `CALIBRACIÓN POR EDAD (sub-12): A esta edad prioriza la relación con el balón, la capacidad de tomar decisiones simples y la disposición a participar. NO penalices errores técnicos bajo presión — es normal. Valora especialmente: primer toque, orientación corporal al recibir, disposición a pedir el balón, alegría y desparpajo con balón. La capacidad física es IRRELEVANTE a esta edad para predecir talento.`
        : ctx.age <= 15
        ? `CALIBRACIÓN POR EDAD (sub-15): Etapa de formación técnico-táctica. Valora: capacidad de ejecutar bajo presión, lectura de espacios, timing de pase, desmarques inteligentes, y primeros signos de toma de decisiones en velocidad. La diferencia física entre "early" y "late maturers" puede ser enorme — un jugador más pequeño que lee bien el juego puede tener más potencial que uno grande y rápido que solo usa el físico.`
        : ctx.age <= 18
        ? `CALIBRACIÓN POR EDAD (sub-18): Etapa de especialización. Aquí ya se puede evaluar rendimiento competitivo real. Valora: consistencia, capacidad de rendir bajo presión, contribución táctica al equipo, eficacia en acciones decisivas, y madurez competitiva. Los jugadores deben demostrar que pueden combinar técnica + inteligencia + físico.`
        : `CALIBRACIÓN POR EDAD (adulto/profesional): Evaluación de rendimiento completo. Se espera dominio técnico, inteligencia táctica avanzada, consistencia física, y capacidad de impactar partidos en momentos clave.`;

      const positionFocusMap: Record<string, string> = {
        GK: "FOCO POSICIONAL (Portero): Observa posicionamiento en el arco, decisión de salir o quedarse, juego con los pies, distribución, comunicación con la defensa, valentía en 1v1, reflejos.",
        RB: "FOCO POSICIONAL (Lateral derecho): Observa incorporaciones al ataque, centros, 1v1 defensivo, posicionamiento en repliegue, amplitud que da al equipo, timing de subida.",
        LB: "FOCO POSICIONAL (Lateral izquierdo): Observa incorporaciones al ataque, centros, 1v1 defensivo, posicionamiento en repliegue, amplitud que da al equipo, timing de subida.",
        RCB: "FOCO POSICIONAL (Central derecho): Observa anticipación, lectura de línea de pase, juego aéreo, salida con balón, coberturas, duelos 1v1, comunicación con la línea defensiva.",
        LCB: "FOCO POSICIONAL (Central izquierdo): Observa anticipación, lectura de línea de pase, juego aéreo, salida con balón, coberturas, duelos 1v1, comunicación con la línea defensiva.",
        DM: "FOCO POSICIONAL (Pivote/Mediocentro defensivo): Observa posicionamiento entre líneas, interceptaciones, distribución de juego, orientación corporal al recibir, capacidad de filtrar pases verticales, cobertura de espacios, pressing.",
        RCM: "FOCO POSICIONAL (Interior derecho): Observa llegada al área, asociaciones en corto, cambios de ritmo, pases entre líneas, equilibrio ataque-defensa, transiciones.",
        LCM: "FOCO POSICIONAL (Interior izquierdo): Observa llegada al área, asociaciones en corto, cambios de ritmo, pases entre líneas, equilibrio ataque-defensa, transiciones.",
        RW: "FOCO POSICIONAL (Extremo derecho): Observa 1v1, desborde, centros, regates, movimiento sin balón al espacio, repliegue defensivo, combinaciones con lateral.",
        LW: "FOCO POSICIONAL (Extremo izquierdo): Observa 1v1, desborde, centros, regates, movimiento sin balón al espacio, repliegue defensivo, combinaciones con lateral.",
        ST: "FOCO POSICIONAL (Delantero centro): Observa movimientos de desmarque, disparo, juego de espaldas, pressing al rival, inteligencia en el área, timing de carrera.",
      };
      const positionFocus = positionFocusMap[ctx.position] || "Observa todas las acciones del jugador con atención al contexto táctico.";

      // Identidad (.claude/rules/identidad.md): el jugador se busca SOLO por dorsal +
      // color de equipación. Sin ambos de referencia no puede darse por "identificado"
      // (antes el prompt decía "dorsal ? y uniforme color ?" y el modelo adivinaba).
      const refJersey =
        ctx.jerseyNumber !== undefined && ctx.jerseyNumber !== null && String(ctx.jerseyNumber).trim() !== ""
          ? String(ctx.jerseyNumber).trim()
          : null;
      const refKitColor = typeof ctx.teamColor === "string" && ctx.teamColor.trim() !== "" ? ctx.teamColor.trim() : null;
      const identityInstruction = refJersey && refKitColor
        ? `Busca al jugador con dorsal ${refJersey} y uniforme color ${refKitColor}. Identifícalo SOLO por ese dorsal y ese color de equipación.`
        : `No hay dorsal Y color de equipación de referencia para este jugador${refJersey ? ` (solo dorsal: ${refJersey})` : refKitColor ? ` (solo color: ${refKitColor})` : ""}: NO puedes marcarlo como "identificado".`;

      const playerIdentityBlock = `IDENTIFICACIÓN DEL JUGADOR (obligatorio, ANTES de observar nada):
${identityInstruction}
- Identifica al jugador ÚNICAMENTE por el dorsal y el color de la equipación. NUNCA por la cara, rasgos faciales, pelo, color de piel, estatura, complexión ni ningún otro rasgo físico o biométrico: son menores de edad.
- estado "identificado": SOLO si has visto con claridad el dorsal de referencia en una equipación del color de referencia.
- estado "unico_jugador": no hay dorsal + color de referencia (o no se ven), pero en TODO el vídeo aparece UN ÚNICO jugador (p. ej. un ejercicio individual).
- estado "no_identificado": en cualquier otro caso (varios jugadores y no puedes confirmar dorsal + color). NO elijas "el jugador más probable" ni adivines.
- confianza: "alta", "media" o "baja". Si sería "baja", usa estado "no_identificado".
- Si el estado es "no_identificado", ABSTENTE de evaluar al jugador: "timeline": [], "momentosDestacados": [], cada dimensión con "observaciones": [] y "score_estimado": null, y TODOS los valores de "eventosContados" a null. "resumenGeneral" empieza por "Jugador no identificado:" seguido del motivo. "patronesJuego" solo puede describir el partido en general, nunca al jugador.

DATOS DEL JUGADOR:
- Nombre: ${ctx.name || "no registrado"}
- Edad: ${ageKnown ? `${ctx.age} años` : "no registrada"}
- Posición: ${ctx.position || "no registrada"}
- Pie: ${ctx.foot || "no especificado"}
- Estatura: ${ctx.height ? `${ctx.height} cm` : "no registrada"} | Peso: ${ctx.weight ? `${ctx.weight} kg` : "no registrado"}
- Nivel competitivo: ${ctx.competitiveLevel || "no especificado"}

${ageCalibration}

${positionFocus}`;

      const teamScopeBlock = `ÁMBITO: análisis del EQUIPO${refKitColor ? ` que viste de color ${refKitColor}` : ""} (${ctx.name || "equipo sin nombre"}), NO de un jugador concreto.
- Aplica las pasadas y las dimensiones al equipo en su conjunto: donde el método dice "el jugador", entiende "el equipo".
- NO identifiques, nombres, numeres ni evalúes a jugadores individuales, y NUNCA uses la cara ni rasgos físicos o biométricos: son menores de edad.
- No conoces la categoría de edad: no la estimes por el aspecto físico.
- Nivel competitivo: ${ctx.competitiveLevel || "no especificado"}.
- Omite el campo "identificacion".`;

      const prompt = `Eres un scout profesional de fútbol formado en metodologías de scouting europeas (La Masia, Ajax Academy, Clairefontaine). Tienes experiencia evaluando jugadores desde categorías sub-10 hasta profesional. Observa este video completo con la mentalidad de un ojeador que debe decidir si este jugador merece seguimiento.

${analysisScope === "team" ? teamScopeBlock : playerIdentityBlock}

METODOLOGÍA DE OBSERVACIÓN (sigue este orden):

1. PRIMERA PASADA — Contexto general:
   - ¿Qué tipo de partido es? (intensidad, nivel de los equipos, espacio disponible)
   - ¿Dónde se posiciona el jugador cuando su equipo tiene/no tiene el balón?
   - ¿Cuánto participa? (¿pide el balón? ¿se esconde? ¿busca el juego?)

2. SEGUNDA PASADA — Acciones con balón:
   - Primer toque: ¿orienta el control hacia donde quiere jugar o para y piensa?
   - Pases: ¿son seguros/cortos o arriesga con pases verticales/entre líneas?
   - Conducción: ¿usa el regate como recurso táctico o por inercia?
   - Disparo: ¿busca gol cuando tiene oportunidad o evita la responsabilidad?
   - Centros/asistencias: ¿tiene capacidad de generar peligro para los compañeros?

3. TERCERA PASADA — Acciones sin balón (CLAVE para detectar talento):
   - Escaneo visual: ¿gira la cabeza antes de recibir? (el mejor indicador de inteligencia)
   - Desmarques: ¿se mueve al espacio o se queda estático esperando?
   - Pressing: ¿presiona con intención de recuperar o solo "corre hacia"?
   - Posicionamiento defensivo: ¿ajusta su posición según el balón?
   - Transiciones: ¿reacciona rápido al cambio de posesión?

4. CUARTA PASADA — Indicadores de mentalidad y psicología:
   - RESILIENCIA: ¿Cómo reacciona después de un error? ¿Pide el balón o se esconde?
   - COMUNICACIÓN: ¿Señala? ¿Organiza? ¿Grita instrucciones a compañeros?
   - TOLERANCIA AL RIESGO: ¿Intenta pases difíciles o siempre elige lo seguro?
   - HAMBRE COMPETITIVA: ¿Presiona cada balón? ¿Se frustra con errores propios? ¿Quiere ganar cada duelo?
   - LENGUAJE CORPORAL: Postura erguida vs hombros caídos, cabeza arriba vs baja
   Clasifica cada indicador como: alto, medio, bajo — con evidencia del video

5. QUINTA PASADA — Contexto del rival:
   - ¿El rival presiona organizadamente o solo corre?
   - ¿Los defensas rivales anticipan o solo reaccionan?
   - ¿El nivel técnico del rival es comparable, superior o inferior?
   - Categoría: fuerte (peso ×1.15), medio (×1.0), débil (×0.85)
   - Las acciones contra rival fuerte valen más. Un regate 1v1 contra defensor que anticipa vale más que contra uno que solo corre

6. CONTEO DE EVENTOS — Cuenta cada acción individualmente:
   - Pases completados y fallados
   - Pases PROGRESIVOS (superan línea de presión) vs simples (laterales/atrás)
   - Regates CON VENTAJA (generan superioridad) vs sin ventaja
   - Pressing EFECTIVO (genera recuperación o error) vs inefectivo
   - Escaneos visuales (giros de cabeza antes de recibir)
   - Recuperaciones (CUALQUIER balón ganado sin importar método — suma de robos + anticipaciones + otros)
   - Robos (tackles): SUBTIPO de recuperación — ganar balón POR CONTACTO físico (entrada al pie/cuerpo). Requiere duelo físico
   - Anticipaciones (intercepciones): SUBTIPO de recuperación — cortar línea de pase ANTES que el rival reciba. NO hay contacto con el rival
   - Pérdidas (turnovers): errores NO FORZADOS que entregan posesión (mal control, pase imposible, regate temerario en zona propia). NO cuentan si el rival forzó la pérdida con una gran acción defensiva
   - Duelos ganados y perdidos (1v1 ofensivo y defensivo)
   - Disparos al arco y fuera
   - Centros intentados
   - Faltas cometidas y recibidas

Genera un análisis detallado con esta estructura JSON exacta (sin markdown, sin backticks):

{${analysisScope === "player" ? `
  "identificacion": {"estado": "identificado", "metodo": "dorsal_y_color", "dorsalObservado": "10", "colorObservado": "rojo", "confianza": "alta", "motivo": "Dorsal 10 legible en la espalda en varios planos, camiseta roja"},` : ""}
  "timeline": [
    {"timestamp": "0:15", "tipo": "accion_con_balon", "descripcion": "Recibe de espaldas al juego, gira sobre pie derecho y filtra pase entre líneas al mediapunta — buen escaneo previo"},
    {"timestamp": "0:32", "tipo": "sin_balon", "descripcion": "Desmarcaje diagonal al half-space derecho creando línea de pase progresiva"}
  ],
  "dimensiones": {
    "velocidadDecision": {"observaciones": ["Decide rápido en espacios reducidos, elige pase vertical sobre opción segura", "Tiempo de decisión corto tras control orientado"], "score_estimado": 7},
    "tecnicaConBalon": {"observaciones": ["Primer toque orientado limpio bajo presión de 2 rivales", "Conducción con cambio de ritmo en zona 14"], "score_estimado": 6},
    "inteligenciaTactica": {"observaciones": ["Se posiciona en el half-space entre líneas de presión rival", "Escanea 2 veces antes de recibir — lee el juego"], "score_estimado": 7},
    "capacidadFisica": {"observaciones": ["Buena aceleración en los primeros 5 metros", "Aguanta contacto físico en duelo pero pierde en duelo aéreo"], "score_estimado": 5},
    "liderazgoPresencia": {"observaciones": ["Pide el balón en situaciones de presión — no se esconde", "Comunica con central para solicitar pase en profundidad"], "score_estimado": 6},
    "eficaciaCompetitiva": {"observaciones": ["2 de 3 pases progresivos completados — buena ratio", "1 disparo al arco desde fuera del área, colocado"], "score_estimado": 6}
  },
  "momentosDestacados": [
    {"timestamp": "2:30", "tipo": "positivo", "descripcion": "Regate en velocidad superando a 2 rivales con cambio de dirección al half-space — muestra capacidad de desequilibrio individual"},
    {"timestamp": "5:10", "tipo": "negativo", "descripcion": "Pierde balón por exceso de confianza en zona de construcción propia — error de decisión, no técnico"}
  ],
  "patronesJuego": ["Tiende a asociarse por banda derecha buscando combinaciones con el lateral", "Busca el 1v1 en velocidad cuando recibe de cara — prefiere atacar espacio a jugar de espaldas", "Se ofrece como pivote de descarga para la salida de balón"],
  "resumenGeneral": "Jugador con buen pie y visión de juego para su edad. Destaca en la toma de decisiones bajo presión y en la lectura de espacios entre líneas. Su escaneo visual antes de recibir indica madurez táctica superior a la media. Necesita mejorar la intensidad defensiva en las transiciones y la presencia física en duelos aéreos — esto último puede ser cuestión de maduración biológica.",
  "eventosContados": {
    "pasesCompletados": 12,
    "pasesFallados": 3,
    "pasesProgresivos": 5,
    "regatesConVentaja": 2,
    "regatesSinVentaja": 1,
    "pressingEfectivo": 3,
    "pressingInefectivo": 2,
    "escaneos": 8,
    "recuperaciones": 2,
    "robos": 1,
    "anticipaciones": 1,
    "perdidas": 2,
    "duelosGanados": 3,
    "duelosPerdidos": 1,
    "disparosAlArco": 1,
    "disparosFuera": 0,
    "centros": 2,
    "faltas": 0
  }
}

REGLAS:
${analysisScope === "player"
  ? `- "identificacion" es OBLIGATORIO. estado: "identificado" | "unico_jugador" | "no_identificado"; metodo: "dorsal_y_color" | "unico_jugador_en_plano" | null; dorsalObservado/colorObservado: lo que VISTE (null si no lo viste). El ejemplo de arriba es de formato: no copies sus valores`
  : `- Análisis de EQUIPO: no incluyas "identificacion" ni atribuyas acciones a jugadores concretos (ni por nombre ni por dorsal). El ejemplo de arriba es de formato: no copies sus valores`}
- Un conteo o score es null SOLO si no pudiste observarlo; 0 significa que lo observaste y no ocurrió. Nunca pongas 0 para decir "no lo sé"
- Tipos de timeline: "accion_con_balon", "sin_balon", "defensiva", "tactica", "transicion"
- Tipos de momentos: "positivo" o "negativo"
- Scores: 1-10, calibrados para la edad y nivel competitivo del jugador. Un 7 en un sub-12 formativo NO es lo mismo que un 7 en un sub-18 de liga nacional
- Mínimo 10 entradas en timeline, 3 momentos destacados (salvo estado "no_identificado", que exige listas vacías)
- Describe lo que VES con vocabulario táctico preciso: usa términos como "half-space", "entre líneas", "pase progresivo", "control orientado", "pressing tras pérdida", "transición defensiva", "línea de pase", "desmarque de ruptura"
- Las observaciones por dimensión deben ser ESPECÍFICAS del video, no genéricas. Mal: "Buena técnica". Bien: "Control con exterior del pie derecho bajo presión del central, girando hacia el espacio libre"
- eventosContados: cuenta CADA evento individualmente mirando el video. Si no puedes confirmar un evento, no lo cuentes. Es mejor sub-contar que inventar
- pasesProgresivos: pases que superan al menos una línea de presión rival (vertical u oblicuo hacia adelante, NO lateral ni atrás)
- regatesConVentaja: regates exitosos que generaron espacio, superioridad o oportunidad real (no solo "pasó al rival y perdió luego")
- pressingEfectivo: presión que resultó en recuperación directa o error forzado del rival
- escaneos: giros de cabeza observables ANTES de recibir el balón. Es la métrica más predictiva de inteligencia de juego
- IMPORTANTE: robos + anticipaciones DEBEN sumar ≤ recuperaciones (son subcategorías). Si el total es 2 recuperaciones (1 robo + 1 anticipación), OK. Si sobran recuperaciones sin subcategoría específica, está bien dejar robos/anticipaciones menores — preferible sub-contar que inventar
- perdidas: NO incluyas pases fallados (esos ya están en pasesFallados). Una pérdida es cuando pierdes la posesión sin que haya habido un intento de pase — ej: mal control en área propia, regate temerario fallido, pase hacia atrás que intercepta el rival
- ${languageDirective(locale)}
- Solo JSON válido, sin markdown ni backticks`;

      // Llamar a Gemini API directamente via REST
      // Modelo Gemini central — única fuente de verdad (src/lib/shared/geminiModel.ts)
      const model = GEMINI_MODEL;

      // Determinar si usamos File API (>15MB) o inlineData (<15MB)
      const videoSizeBytes = Buffer.from(videoBase64, "base64").length;
      const videoSizeMB = videoSizeBytes / (1024 * 1024);
      const useFileApi = videoSizeMB > 15;

      let videoPart: Record<string, unknown>;

      if (useFileApi) {
        // Gemini File API para videos grandes (hasta 2GB)
        console.log(`[Gemini] Video grande (${videoSizeMB.toFixed(1)}MB) — usando File API`);
        const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
        const videoBuffer = Buffer.from(videoBase64, "base64");

        const uploadRes = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": mediaType || "video/mp4",
            "X-Goog-Upload-Protocol": "raw",
            "X-Goog-Upload-Command": "upload, finalize",
          },
          body: videoBuffer,
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text().catch(() => "");
          console.error("[Gemini] File upload error:", uploadRes.status, errText);
          return errorResponse(`Gemini File API upload error: ${uploadRes.status}`, 502, "GEMINI_UPLOAD_ERROR");
        }

        const uploadData = await uploadRes.json() as { file?: { uri?: string; name?: string; state?: string } };
        const fileUri = uploadData.file?.uri;
        const fileName = uploadData.file?.name;

        if (!fileUri) {
          return errorResponse("Gemini File API no retornó URI", 502, "GEMINI_UPLOAD_NO_URI");
        }

        // Esperar a que el archivo esté procesado (ACTIVE)
        let fileState = uploadData.file?.state || "PROCESSING";
        let attempts = 0;
        while (fileState === "PROCESSING" && attempts < 30) {
          await new Promise(r => setTimeout(r, 2000));
          const statusRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
          );
          if (statusRes.ok) {
            const statusData = await statusRes.json() as { state?: string };
            fileState = statusData.state || "PROCESSING";
          }
          attempts++;
        }

        if (fileState !== "ACTIVE") {
          return errorResponse(`Video no procesado por Gemini (state: ${fileState})`, 502, "GEMINI_FILE_NOT_READY");
        }

        console.log(`[Gemini] Archivo listo: ${fileUri}`);
        videoPart = { fileData: { mimeType: mediaType || "video/mp4", fileUri } };
      } else {
        // InlineData para videos pequeños (<15MB)
        console.log(`[Gemini] Video pequeño (${videoSizeMB.toFixed(1)}MB) — usando inlineData`);
        videoPart = { inlineData: { mimeType: mediaType || "video/mp4", data: videoBase64 } };
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const geminiBody = {
        contents: [
          {
            parts: [
              videoPart,
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
        },
      };

      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => "");
        console.error("[Gemini] API error:", geminiRes.status, errText);
        return errorResponse(`Gemini API error: ${geminiRes.status}`, 502, "GEMINI_API_ERROR");
      }

      const geminiData = await geminiRes.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };

      // Extraer texto de la respuesta
      let fullText = "";
      if (geminiData.candidates?.[0]?.content?.parts) {
        for (const part of geminiData.candidates[0].content.parts) {
          if (part.text) fullText += part.text;
        }
      }

      if (!fullText) {
        return errorResponse("Gemini no retornó respuesta", 502, "GEMINI_EMPTY_RESPONSE");
      }

      // Parsear JSON de la respuesta
      let observations: GeminiObservation;
      try {
        // Gemini con responseMimeType: "application/json" debería retornar JSON limpio
        // pero por seguridad intentamos extraer si viene envuelto
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          observations = JSON.parse(jsonMatch[0]) as GeminiObservation;
        } else {
          throw new Error("No se encontró JSON en la respuesta");
        }
      } catch (e) {
        console.error("[Gemini] JSON parse error:", e, "Raw:", fullText.substring(0, 300));
        return errorResponse("No se pudo parsear la respuesta de Gemini", 502, "GEMINI_PARSE_ERROR");
      }

      return successResponse({ observations });
    } catch (error: unknown) {
      console.error("[Gemini] Handler error:", error);
      return errorResponse(
        error instanceof Error ? error.message : "Error interno",
        500,
        "INTERNAL_ERROR"
      );
    }
  }
);
