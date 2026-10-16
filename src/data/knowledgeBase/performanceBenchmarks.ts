/**
 * VITAS Knowledge Base — Benchmarks de Rendimiento
 *
 * Documentos con benchmarks físicos, técnicos y tácticos por edad,
 * diferenciación élite vs promedio, y perfil del jugador proyectable.
 */

import type { KnowledgeDocument } from "./types";

export const PERFORMANCE_BENCHMARKS_DOCS: KnowledgeDocument[] = [
  {
    id: "bench-physical",
    title: "Benchmarks físicos por edad y posición",
    category: "scouting",
    content: `[SCOUTING] Benchmarks Físicos por Edad — Referencia para Evaluación

VELOCIDAD MÁXIMA (sprint 30m):
Sub-10: 18-21 km/h (no relevante para scouting). Sub-12: 21-24 km/h. Sub-14: 24-28 km/h (variación enorme por PHV). Sub-16: 27-31 km/h. Sub-18: 29-33 km/h. Profesional: 32-36 km/h (élite >34 km/h).
NOTA: La velocidad en línea recta es MENOS predictiva que la aceleración en 5-10m (la que realmente se usa en fútbol).

ACELERACIÓN (0-5 metros):
Sub-12: 1.2-1.5s. Sub-14: 1.0-1.3s. Sub-16: 0.9-1.1s. Sub-18: 0.85-1.0s. Profesional: 0.78-0.92s.
Más relevante que velocidad máxima para todas las posiciones excepto extremos puros.

DISTANCIA POR PARTIDO:
Sub-12 (7v7, 50min): 3-5 km. Sub-14 (11v11, 70min): 5-8 km. Sub-16 (11v11, 80min): 7-10 km. Sub-18 (11v11, 90min): 8-11 km. Profesional: 10-13 km (mediocampistas y laterales los que más corren).
POR POSICIÓN: Centrales: -15% del promedio. Laterales/carrileros: +10-15%. Mediocampistas: promedio o +5%. Delanteros: -10% pero con más sprints de alta intensidad.

SPRINTS DE ALTA INTENSIDAD (>20 km/h):
Sub-14: 8-15 por partido. Sub-16: 15-25. Sub-18: 25-40. Profesional: 30-60.
Extremos y laterales hacen más sprints. Pivotes hacen menos pero cubren más distancia a media intensidad.

RESISTENCIA (Yo-Yo IR1):
Sub-12: 320-720m. Sub-14: 640-1160m. Sub-16: 1040-1720m. Sub-18: 1400-2200m. Profesional: 1800-2800m.

IMPORTANTE: Estos benchmarks son REFERENCIALES. Un jugador por debajo del benchmark físico pero con inteligencia de juego y técnica superior puede ser más proyectable que uno físicamente superior. Los benchmarks físicos son más útiles en sub-16+ cuando la maduración está más avanzada.`,
    metadata: { ageRange: "10-21", tags: ["benchmarks", "fisico", "velocidad", "resistencia", "sprint"] },
  },
  {
    id: "bench-technical",
    title: "Benchmarks técnicos por edad",
    category: "scouting",
    content: `[SCOUTING] Benchmarks Técnicos por Edad — Indicadores de Nivel

PRECISIÓN DE PASE (en contexto de partido, no en ejercicio):
Sub-10: 55-65% (pases cortos simples). Sub-12: 65-75%. Sub-14: 70-82%. Sub-16: 75-87%. Sub-18: 80-90%. Profesional élite: 87-95%.
CLAVE: No es solo % sino TIPO de pase. Un jugador con 75% que intenta pases progresivos es mejor que uno con 90% que solo pasa lateral.

PASES PROGRESIVOS POR PARTIDO (pases que avanzan >10m hacia portería rival):
Sub-12: 2-5 por partido. Sub-14: 5-10. Sub-16: 8-15. Sub-18: 10-20. Profesional élite (mediocampista): 15-30.
Mediocentros y centrales constructores son los que más pases progresivos deben generar.

ÉXITO EN REGATE (1v1 ofensivo):
Sub-12: 40-55% (atreverse importa más que completar). Sub-14: 45-60%. Sub-16: 48-62%. Sub-18: 50-65%. Profesional: 48-68%.
Extremos deberían estar en el rango alto. Mediocampistas centrales no necesitan regatear frecuentemente.

PRECISIÓN DE CENTRO:
Sub-14: 20-30% (en movimiento). Sub-16: 25-40%. Sub-18: 30-45%. Profesional: 28-42%.
Los centros precisos son una habilidad difícil — un lateral/extremo sub-16 con >35% de precisión en centros es excepcional.

PRIMER TOQUE BAJO PRESIÓN (% de controles orientados exitosos con rival a <2m):
Sub-12: 40-55%. Sub-14: 50-65%. Sub-16: 60-75%. Sub-18: 65-82%. Profesional: 78-92%.
Este es uno de los mejores indicadores técnicos. El jugador que controla orientado bajo presión es técnicamente maduro.

FRECUENCIA DE ESCANEO (giros de cabeza por posesión propia, antes de recibir):
Sub-12: 0-1 (1+ es excepcional). Sub-14: 1-2. Sub-16: 2-3. Sub-18: 2-4. Profesional élite (mediocampista): 4-6.
Correlación directa con calidad de decisión. Un sub-14 que escanea 3+ veces está en el top 5%.`,
    metadata: { ageRange: "10-21", tags: ["benchmarks", "tecnico", "pase", "regate", "primer-toque"] },
  },
  {
    id: "bench-tactical",
    title: "Benchmarks tácticos por edad",
    category: "scouting",
    content: `[SCOUTING] Benchmarks Tácticos por Edad — Indicadores de Madurez Táctica

VELOCIDAD DE DECISIÓN (tiempo recepción → acción):
Sub-10: 3-4s (normal, no penalizar). Sub-12: 2-3s (bueno), <2s (excepcional). Sub-14: 1.5-2.5s (bueno), <1.5s (élite). Sub-16: 1-2s (bueno), <1s (élite). Sub-18: <1.5s (esperado), <1s (élite). Profesional: <1s (esperado), <0.5s (world class).

POSICIONAMIENTO EN FASE DEFENSIVA:
Sub-12: Se espera posición básica (entre balón y portería). Sub-14: Debe entender cuándo presionar y cuándo cubrir línea de pase. Sub-16: Debe ajustar posición según movimiento del balón (basculación individual). Sub-18: Debe coordinar con compañeros de línea (basculación colectiva).

PRESSING COORDINADO:
Sub-12: Pressing individual (uno corre, el resto espera). Sub-14: Pressing en pares (2 jugadores coordinan). Sub-16: Pressing en bloque (3-4 jugadores activan juntos). Sub-18: Pressing colectivo con triggers definidos.

MOVIMIENTO SIN BALÓN:
Sub-12: Desmarque básico (moverse al espacio libre). Sub-14: Desmarque con timing (moverse cuando el paseador está listo). Sub-16: Desmarque de ruptura (atacar espacio detrás de la defensa con timing). Sub-18: Movimiento coordinado (crear espacio para compañeros, arrastrar marcas).

COMPRENSIÓN TÁCTICA (lectura del juego):
Sub-12: Entiende "atacar cuando tenemos balón, defender cuando no". Sub-14: Entiende posiciones relativas (dónde debo estar según dónde está el balón). Sub-16: Entiende fases de juego (posesión, pressing, transición) y su rol en cada una. Sub-18: Adapta comportamiento según el estado del partido (resultado, minuto, rival).

ADAPTABILIDAD SISTÉMICA:
Sub-14: Puede jugar 1-2 posiciones. Sub-16: Puede adaptar comportamiento en 2-3 sistemas diferentes. Sub-18: Entiende su rol en cualquier formación y ajusta automáticamente.

NOTA: Los benchmarks tácticos tienen MAYOR variabilidad que los físicos o técnicos porque dependen enormemente de la calidad del entrenamiento recibido. Un jugador de 14 años con buen entrenador táctico puede superar a uno de 16 con mal entrenamiento.`,
    metadata: { ageRange: "10-21", tags: ["benchmarks", "tactico", "decision", "posicionamiento", "pressing"] },
  },
  {
    id: "bench-elite-vs-average",
    title: "Qué diferencia al jugador élite del promedio",
    category: "scouting",
    content: `[SCOUTING] Diferenciadores Clave: Jugador Élite vs Promedio

INVESTIGACIÓN (compilación de estudios de Huijgen 2009, Coelho e Silva 2010, Unnithan 2012, Till 2014):

1. VELOCIDAD DE PROCESAMIENTO (diferencia más consistente):
El jugador élite decide 30-40% más rápido que el promedio en las mismas situaciones. No es que tenga más tiempo — es que procesa la información más rápido. Esto se manifiesta en: primer toque ya orientado (decidió antes de recibir), pases que llegan al receptor en el momento justo, posicionamiento anticipativo.

2. TÉCNICA BAJO PRESIÓN (no en ejercicio):
En ejercicios sin oposición, la diferencia técnica entre élite y promedio es pequeña (10-15%). En partidos con presión real, la diferencia se amplía a 30-40%. El jugador élite MANTIENE su nivel técnico bajo presión. El promedio se degrada significativamente.

3. ESCANEO VISUAL (predictivo desde los 10 años):
Los jugadores que llegaron a profesional escaneaban 2x más frecuentemente a los 12-14 años que los que no llegaron. Es el indicador más temprano y estable de potencial élite.

4. AGILIDAD DE APRENDIZAJE:
El jugador élite mejora más rápido con la misma cantidad de entrenamiento. En un período de 6 meses: el élite mejora VSI 8-12 puntos, el promedio 3-5 puntos. La velocidad de mejora es más predictiva que el nivel absoluto.

5. MENTALIDAD COMPETITIVA:
El jugador élite busca el balón cuando van perdiendo, mantiene intensidad en los últimos minutos, se recupera de errores en <30 segundos, acepta correcciones y las aplica inmediatamente. La mentalidad no se mide en datos, se observa en video.

6. LO QUE NO DIFERENCIA (sorprendentemente):
Estatura (no predice a los 12-14). Velocidad pura (moderadamente predictiva, pero menos que técnica+visión). Fuerza (correlaciona con maduración, no con talento). Notas escolares (no hay correlación significativa).

IMPLICACIÓN PARA VITAS: La evaluación del entrenador, leída junto con el estado de maduración (PHV), intenta capturar los factores 1-4. Los agentes de video deben observar y reportar los factores 3 y 5 que solo se ven en video, no en métricas numéricas.`,
    metadata: { ageRange: "10-21", tags: ["elite", "diferenciacion", "talento", "prediccion"] },
  },
  {
    id: "bench-projectable-profile",
    title: "Perfil del jugador proyectable vs no proyectable",
    category: "scouting",
    content: `[SCOUTING] Perfil del Jugador Proyectable vs No Proyectable

JUGADOR PROYECTABLE (alta probabilidad de seguir mejorando):
- Técnica > Físico: Sus fortalezas principales son técnicas o tácticas, no físicas. La técnica y la inteligencia de juego no se pierden con la edad — de hecho, mejoran.
- Visión + Técnica combinadas: Un jugador con ambas por encima de 65 tiene base sólida para cualquier posición.
- Tendencia VSI ascendente sostenida: Si el VSI sube consistentemente durante 6+ meses, indica jugador que absorbe entrenamiento (agilidad de aprendizaje alta).
- Escaneo frecuente: Jugador que mira alrededor antes de recibir está procesando información — la señal más temprana de inteligencia de juego.
- Resiliencia observable: Se recupera rápido de errores, pide el balón en situaciones comprometidas.
- Late maturer con buena técnica: Al madurar físicamente, combinará inteligencia + técnica + físico.
- Versatilidad posicional: Puede jugar 2-3 posiciones con competencia — indica comprensión táctica alta.

JUGADOR NO PROYECTABLE (riesgo alto de estancamiento):
- Físico > Técnica + Visión: Si las principales fortalezas son velocidad y resistencia pero técnica y visión están bajas (<50), hay riesgo de que al igualar la maduración con pares, pierda la ventaja.
- Early maturer cuyo VSI está plano o bajando: Si con ventaja madurativa el VSI no sube, al perder esa ventaja puede bajar significativamente.
- Unidimensional: Solo sabe hacer una cosa bien (solo regatear, solo cabecear, solo correr). En niveles superiores los rivales se adaptan y neutralizan jugadores predecibles.
- No se adapta a instrucciones: Si después de correcciones tácticas sigue haciendo lo mismo, indica baja agilidad de aprendizaje.
- Desaparece bajo presión: Si en partidos fáciles rinde bien pero en competitivos se esconde, la mentalidad limita el techo.

ZONA GRIS (requiere más observación):
- Jugador con muy buena técnica pero que no compite: Tiene herramientas pero ¿tiene hambre?
- Early maturer con técnica Y físico: ¿Depende del físico para ganar o usa la técnica?
- Tendencia VSI plana: ¿Está en meseta de aprendizaje (normal) o realmente estancado?

REGLA PARA SCOUTS: Si tienes que elegir entre un jugador físicamente dominante con técnica media y un jugador técnicamente brillante con físico limitado — elige al técnico. El físico se puede mejorar, la técnica tiene ventana limitada.`,
    metadata: { ageRange: "10-21", tags: ["proyectable", "potencial", "estancamiento", "prediccion", "scouting"] },
  },
];
