/**
 * VITAS Knowledge Base — Desarrollo Juvenil
 *
 * Documentos sobre LTAD, períodos sensibles, gestión de carga,
 * impacto del PHV, desarrollo psicológico y efecto de edad relativa.
 */

import type { KnowledgeDocument } from "./types";

export const YOUTH_DEVELOPMENT_DOCS: KnowledgeDocument[] = [
  {
    id: "dev-ltad-model",
    title: "Modelo LTAD para fútbol — 6 fases de desarrollo",
    category: "methodology",
    content: `[METHODOLOGY] Modelo LTAD (Long-Term Athlete Development) Aplicado al Fútbol

FASE 1 — FUNdamentals (6-9 años): Desarrollo de alfabetización física general. El fútbol es un JUEGO, no un entrenamiento. Prioridades: coordinación, agilidad, equilibrio, velocidad (ABC+S). Ratio juego libre / estructurado: 80/20. NO especializar posiciones. Todos juegan todas las posiciones. Sesiones: 2-3 por semana, 45-60 min. El objetivo es que el niño DISFRUTE y desarrolle amor por el deporte.

FASE 2 — Learning to Train (9-12 años): Ventana ÓPTIMA para desarrollo técnico. Las habilidades motoras finas se consolidan mejor en esta fase. Prioridades: técnica individual con ambos pies, primer toque, conducción, pase corto/medio, 1v1 básico. Ratio técnico/táctico: 70/30. Inicio de comprensión táctica básica (espacios, amplitud, profundidad). Sesiones: 3-4 por semana, 60-75 min.

FASE 3 — Training to Train (12-15 años): Consolidación técnica bajo presión + inicio de desarrollo físico. Coincide con PHV en la mayoría de jugadores varones. Prioridades: técnica bajo oposición real, táctica colectiva básica (pressing, transiciones, posesión), inicio de trabajo aeróbico. La velocidad y potencia tienen su ventana sensible aquí (PHV a PHV+12 meses). Sesiones: 4-5 por semana, 75-90 min.

FASE 4 — Training to Compete (15-18 años): Especialización posicional y competitiva. El jugador debe consolidar un perfil táctico claro. Prioridades: rendimiento bajo presión competitiva, adaptabilidad a diferentes sistemas, desarrollo de fuerza funcional, preparación psicológica para competición. Ratio: 40% técnico-táctico, 30% competitivo, 30% físico.

FASE 5 — Training to Win (18-21 años): Optimización de rendimiento. El jugador busca el máximo nivel competitivo posible. Prioridades: rendimiento consistente en partidos de alta presión, capacidad de influir en resultados, liderazgo, gestión de carrera. Individualización total del plan de desarrollo.

FASE 6 — Excellence (21+ años): Mantenimiento del pico rendimiento y extensión de carrera. Prioridades: prevención de lesiones, gestión de carga, adaptación a cambios de rol/posición con la edad.`,
    metadata: { ageRange: "6-35", tags: ["ltad", "desarrollo", "fases", "planificacion"] },
  },
  {
    id: "dev-sensitive-periods",
    title: "Períodos sensibles de entrenamiento en fútbol",
    category: "methodology",
    content: `[METHODOLOGY] Períodos Sensibles de Entrenamiento — Cuándo Desarrollar Cada Capacidad

COORDINACIÓN Y AGILIDAD: Ventana 6-10 años. La neuroplasticidad máxima permite desarrollar patrones motores complejos que se mantienen toda la vida. Ejercicios: circuitos de coordinación, juegos de cambio de dirección, equilibrio dinámico. Si se pierde esta ventana, el atleta PUEDE mejorar pero nunca alcanzará el potencial que tendría con estimulación temprana.

TÉCNICA INDIVIDUAL: Ventana 10-14 años. El período dorado para la adquisición técnica. La capacidad de aprender y automatizar gestos técnicos (control, pase, regate, disparo) es máxima. Después de los 14, las mejoras técnicas son posibles pero más lentas y difíciles. Es la razón por la que las academias de élite priorizan 70% técnica en estas edades.

VELOCIDAD: Ventana 1: 7-9 años (velocidad de reacción y frecuencia). Ventana 2: PHV a PHV+12 meses (velocidad máxima y aceleración). La velocidad lineal máxima mejora ~0.36 m/s por año entre los 13-17 (PMC9663653). Después de los 18, las mejoras son marginales — la velocidad es la capacidad más difícil de desarrollar tarde.

POTENCIA Y FUERZA: Ventana: PHV a PHV+24 meses. La testosterona durante y después del PHV permite ganancias de fuerza significativas. Aumento de +120% en potencia de los 11 a 17 años (pubmed/40407452). Antes del PHV: solo fuerza relativa (peso corporal). Durante/después PHV: inicio de trabajo con carga externa progresiva.

RESISTENCIA AERÓBICA: Ventana: PHV a PHV+12 meses. El corazón crece significativamente durante el PHV, creando condiciones ideales para desarrollo aeróbico. Antes de PHV: la resistencia se desarrolla mediante juegos y partidos reducidos, no carreras continuas. Después de PHV: entrenamiento aeróbico específico (intervalos, fartlek).

INTELIGENCIA TÁCTICA: Ventana continua pero con aceleración entre 11-15 años. La comprensión táctica mejora con la madurez cognitiva. Estudios muestran ganancias significativas U11→U15 (PMC10135667). Después de 15: las mejoras dependen más de la experiencia competitiva que de la madurez cognitiva.

IMPLICACIÓN PARA VITAS: Al evaluar un jugador, considerar en qué ventana se encuentra. Un jugador de 13 con mala técnica tiene menos margen que uno de 10. Un jugador de 16 sin velocidad tiene limitación real (ventana cerrada).`,
    metadata: { ageRange: "6-21", tags: ["periodos-sensibles", "ventanas", "entrenamiento", "desarrollo"] },
  },
  {
    id: "dev-load-management",
    title: "Gestión de carga de entrenamiento en juveniles",
    category: "methodology",
    content: `[METHODOLOGY] Gestión de Carga en Jugadores Juveniles

PRINCIPIO FUNDAMENTAL: La carga de entrenamiento en juveniles debe ser progresiva y adaptada al estado de maduración, no a la edad cronológica. Un jugador de 13 años en pleno PHV necesita diferente carga que uno de 13 pre-PHV.

VOLUMEN RECOMENDADO POR FASE:
- Sub-10: 4-6 horas/semana (incluye partido). Máximo 2 partidos por semana.
- Sub-12: 6-8 horas/semana. Máximo 2 partidos + 3-4 entrenamientos.
- Sub-14: 8-10 horas/semana. Máximo 2 partidos + 4 entrenamientos.
- Sub-16: 10-12 horas/semana. Máximo 2 partidos + 4-5 entrenamientos.
- Sub-18: 12-14 horas/semana. Profesionalización progresiva del volumen.

REGLA DEL PHV (CRÍTICA):
- Durante el PHV (offset -1 a +1): REDUCIR carga de impacto un 20-30%. El crecimiento rápido hace vulnerables las placas de crecimiento (Osgood-Schlatter en rodilla, Sever en talón).
- Mantener trabajo técnico (bajo impacto).
- Reducir sprints máximos y saltos repetidos.
- Monitorear dolor articular después de sesiones — no es "normal" sino señal de sobrecarga.
- Reintroducir carga de impacto gradualmente 6-12 meses post-pico PHV.

RATIO DE INCREMENTO: La regla del 10% — no aumentar carga total más de 10% por semana. Incrementos bruscos son la primera causa de lesión en juveniles.

DESCANSO: Mínimo 1 día completo de descanso por semana. Los sub-14 necesitan 2 días sin actividad estructurada. El sueño es el factor de recuperación más importante — 9-10 horas para sub-16, 8-9 para sub-18.

IMPLICACIÓN PARA VITAS: Si un jugador muestra descenso en métricas físicas (velocidad, resistencia) pero mantiene técnica/visión, puede ser señal de sobrecarga, no de falta de talento. El tracking de métricas físicas en VITAS puede detectar patrones de fatiga.`,
    metadata: { ageRange: "8-21", tags: ["carga", "volumen", "recuperacion", "lesiones", "phv"] },
  },
  {
    id: "dev-phv-impact",
    title: "Impacto del PHV en el rendimiento futbolístico",
    category: "methodology",
    content: `[METHODOLOGY] Impacto del Peak Height Velocity (PHV) en el Rendimiento

QUÉ ES EL PHV: El pico de velocidad de crecimiento en estatura. En varones ocurre típicamente entre los 12-15 años (media 13.8). Durante este período el jugador puede crecer 8-12 cm en un año. Este crecimiento afecta DIRECTAMENTE el rendimiento futbolístico.

EFECTOS DURANTE EL PHV:
1. DESCOORDINACIÓN TEMPORAL: El crecimiento rápido cambia las proporciones corporales (piernas más largas, centro de gravedad más alto). El cerebro necesita recalibrar el control motor. RESULTADO: el jugador puede parecer que "retrocede" técnicamente. Esto NO es pérdida de talento — es adaptación al nuevo cuerpo.

2. DOLOR EN PLACAS DE CRECIMIENTO: Osgood-Schlatter (rodilla) afecta al 20-30% de jugadores en PHV. Sever (talón) afecta al 10-15%. Son condiciones de crecimiento, no lesiones graves, pero requieren gestión de carga.

3. CAMBIO DE PERFIL FÍSICO: La velocidad puede estancarse temporalmente (las piernas más largas cambian la mecánica de carrera). La fuerza relativa puede bajar (más peso corporal con misma masa muscular). La resistencia puede mejorar (corazón más grande).

4. CAMBIO EMOCIONAL: Fluctuaciones hormonales afectan el estado de ánimo, la concentración y la motivación. Los jugadores en PHV pueden parecer "menos comprometidos" cuando en realidad están procesando cambios fisiológicos y emocionales.

EARLY MATURERS (offset > +0.5): Ventajas: más altos, más fuertes, más rápidos que pares. Riesgos: seleccionados por físico no por talento, pueden estancarse cuando pares maduren, riesgo de sobreentrenamiento por ser "los mejores" prematuramente.

LATE MATURERS (offset < -0.5): Desventajas: más pequeños, más lentos, pierden selecciones por tamaño. Ventajas: si sobreviven el proceso, suelen tener mejor técnica (compensaron con inteligencia), mayor motivación (tuvieron que esforzarse más), y al madurar igualan o superan a los early. Ejemplos: Messi (late), Modric (late), Xavi (late), Iniesta (late).

IMPLICACIÓN PARA VITAS: Tener en cuenta la maduración es CRÍTICO: sin ella se sobrevalora a los early maturers y se descarta a los late maturers. Lo que VITAS hace hoy: calcula la maduración (PHV) solo cuando el jugador tiene todas sus medidas (talla, peso, talla sentado, longitud de pierna, fecha de nacimiento y sexo), y el VSI ajustado por maduración solo se muestra en la tarjeta de maduración del jugador y en la alerta de talento oculto. Los rankings y la comparación de jugadores usan la evaluación SIN ajustar: ahí el scout debe tener en cuenta la maduración por su cuenta.`,
    metadata: { ageRange: "10-18", tags: ["phv", "maduracion", "crecimiento", "sesgo"] },
  },
  {
    id: "dev-psychological",
    title: "Desarrollo psicológico del futbolista juvenil",
    category: "methodology",
    content: `[METHODOLOGY] Desarrollo Psicológico del Futbolista Juvenil

ETAPAS PSICOLÓGICAS:
8-10 años: Motivación puramente intrínseca (juega porque es divertido). Atención corta (15-20 min máximo en una tarea). Pensamiento concreto (instrucciones simples y visuales). NO entiende conceptos tácticos abstractos. Aprendizaje por imitación y juego.

10-12 años: Inicio de comparación social (se compara con compañeros). Puede sentir presión por primera vez. Comienza a desarrollar identidad deportiva. Aún necesita diversión como motivador principal. Capacidad de atención aumenta (20-30 min). Puede entender instrucciones tácticas básicas.

12-14 años: PERÍODO CRÍTICO PSICOLÓGICO. Coincide con pubertad y PHV. Fluctuaciones emocionales, búsqueda de identidad, presión social. Los que maduran tarde pueden sufrir baja autoestima por comparación con pares más grandes. Los que maduran temprano pueden desarrollar exceso de confianza. La relación con el entrenador es FUNDAMENTAL.

14-16 años: Consolidación de identidad deportiva. El jugador empieza a verse como "futbolista" o abandona. La resiliencia se puede desarrollar activamente. Capacidad de pensamiento abstracto permite comprensión táctica profunda. La motivación se vuelve más extrínseca (resultados, selección, becas).

16-18 años: Pre-profesionalización. Presión real de rendimiento. Estrés competitivo, ansiedad pre-partido, gestión de expectativas. Los que no desarrollan habilidades de afrontamiento aquí tendrán problemas en el salto a profesional.

INDICADORES PSICOLÓGICOS OBSERVABLES EN VIDEO:
- RESILIENCIA: ¿Cómo reacciona 10 segundos después de un error? (Recupera concentración / Baja cabeza / Se frustra verbalmente)
- LIDERAZGO: ¿Organiza a compañeros? ¿Señala posiciones? ¿Anima después de un gol en contra?
- HAMBRE COMPETITIVA: ¿Busca el balón cuando van perdiendo? ¿Presiona con intensidad en minutos finales?
- GESTIÓN DE PRESIÓN: ¿Rinde igual en 0-0 que en 2-0 abajo? ¿Ejecuta bajo presión del rival?
- COMUNICACIÓN: ¿Habla con compañeros? ¿Da instrucciones? ¿Reclama o anima?

IMPLICACIÓN PARA VITAS: La evaluación psicológica es el 30-40% de la predicción de talento en scouting profesional. Los agentes de análisis DEBEN observar y reportar indicadores psicológicos visibles en el video, no solo métricas técnico-tácticas.`,
    metadata: { ageRange: "8-21", tags: ["psicologia", "mentalidad", "resiliencia", "desarrollo"] },
  },
  {
    id: "dev-rae-bias",
    title: "Efecto de edad relativa (RAE) — Sesgo y mitigación",
    category: "methodology",
    content: `[METHODOLOGY] Efecto de Edad Relativa (RAE) — El Sesgo Más Documentado en Fútbol Juvenil

QUÉ ES: Los jugadores nacidos en los primeros meses del año competitivo (Q1: enero-marzo) tienen hasta 11 meses más de desarrollo que los nacidos al final (Q4: octubre-diciembre). A los 12 años, 11 meses representa ~8% más de vida — una ventaja significativa en desarrollo físico, cognitivo y emocional.

MAGNITUD DEL SESGO: Estudios (Helsen et al., 2005) muestran que en academias de élite europeas, los jugadores Q1 están sobrerrepresentados 2:1 respecto a Q4. En selecciones nacionales juveniles, el sesgo es aún mayor (hasta 3:1). Esto significa que el 50% de los jugadores Q4 con talento real están siendo DESCARTADOS por un sesgo de selección.

POR QUÉ PERSISTE: Los entrenadores y scouts seleccionan inconscientemente a jugadores que son más grandes, más rápidos y más fuertes para su categoría. Un jugador nacido en enero de 2012 compitiendo contra uno de diciembre de 2012 tiene casi un año más de desarrollo — parece "mejor" pero simplemente es "mayor".

QUÉ HACE HOY VITAS: todavía NO calcula ni muestra el trimestre de nacimiento del jugador (llegará con su confianza y con el corte de cada competición, que depende de la federación). VITAS NO corrige ninguna evaluación por edad relativa: no hay una corrección validada (en puntos o en %) y no se aplica ninguna. Mientras tanto, el scout debe mirar la fecha de nacimiento por su cuenta; el trimestre será un dato, no un veredicto.

CÓMO DEBERÍA ACTUAR UN SCOUT:
- Siempre verificar fecha de nacimiento ANTES de evaluar.
- Si un jugador Q4 rinde "al nivel" de sus pares Q1, en realidad está rindiendo POR ENCIMA de su nivel de desarrollo.
- Un jugador Q4 con una evaluación más baja puede tener más potencial que un Q1 con una más alta: VITAS no lo corrige con una fórmula; es criterio del scout.
- En selecciones y academias, implementar políticas de cuota por cuartil de nacimiento.

DATO CLAVE: En el fútbol profesional adulto, el sesgo RAE DESAPARECE. Los jugadores Q4 que sobreviven el sistema juvenil tienen la misma probabilidad de éxito que los Q1. Esto confirma que el sesgo es de SELECCIÓN, no de talento real.`,
    metadata: { ageRange: "8-21", tags: ["rae", "edad-relativa", "sesgo", "seleccion", "cuartil"] },
  },
];
