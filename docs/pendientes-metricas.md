# Pendientes de métricas — bloqueada ≠ resuelta

> Tracker canónico que exige la **invariante #8** de `CLAUDE.md` ("Bloqueada ≠ resuelta"):
> una métrica bloqueada con `gate_reason` honesto es un estado de entrega aceptable, pero
> **no** es lo mismo que resuelta. Este fichero distingue las dos y se mantiene al día.
>
> **Última actualización:** 2026-10-12 (§B y §C10, 074 amplía a evaluation_history / player_knowledge: rama por organización) · 2026-10-09 (§B y §C10, migración 074: escribir datos de un jugador exige ser su dueño) · 2026-10-01 (§5-D, migración 073 solo dueño) · 2026-09-30 (digest del director sin hash, P0) · **Rama de creación:** `docs/pendientes-metricas`
>
> Estado del arnés a fecha de hoy: el **GATE real** (pre-commit → `audit_metrics.py
> --baseline`) sale **exit 0** (deuda baselined). El audit CRUDO `audit_metrics.py` →
> **exit 1** (559 errores + 58 avisos), que es el estado **G0 esperado por diseño** — el registro
> `config/metrics.json` documenta que el audit DEBE salir 1 hasta ejecutar la
> remediación G1–G10 (marca las mentiras existentes). `config/metrics.json` tiene
> **26 métricas** declaradas y **0 con `provenance: MEDIDA`** (nada en la plataforma
> califica hoy como medido/calibrado — es un hecho honesto, no un bug del arnés).

---

## Plan de cierre — qué se puede dejar al 100% HOY (y qué no)

"100% funcional" tiene **dos mitades** que no se cierran igual:

- **🟢 SEGURO + DESPLEGADO (cerrable HOY):** todo el **§C** son toggles/claves en dashboards
  (Supabase, Vercel, Modal, Anthropic) — acción del usuario, sin código, ejecutable desde el
  móvil. Cerrar §C entero deja la plataforma **segura y operativa al 100%**. Empezar por **C9**
  (solo el dueño, 076: con un tenant compartido la regla antigua «dueño o su tenant» abría los
  datos de todos los menores a todas las cuentas de ese tenant). C1 (hook JWT) ya no protege
  datos de jugador tras la 076: la RLS de jugador es solo por dueño (`players.user_id`).
- **🔴 CIFRAS VALIDADAS (NO cerrable "hoy" ejecutando pasos):** el **§A** exige **datos humanos**:
  clips anotados a mano (identidad), calibración medida y golden (físicas/duelos), datos reales
  introducidos (bienestar). Es trabajo humano/físico, no un toggle. **Hasta que existan esos
  datos, las cifras siguen orientativas o bloqueadas** — por honestidad NO se marca "100%
  validado". Máximo apalancamiento: **un solo clip anotado** desbloquea identidad+físicas+duelos.
- **CÓDIGO (§B):** lo finalizable de #184–#188 está hecho; quedan las casillas **abiertas** de §B (p. ej. el hash del id en el Radar de `/director` y en el mock de cliente de bienestar, y los factores sin señal del riesgo de abandono).

**Conclusión honesta:** hoy puedes dejar la herramienta **segura, desplegada y operativa al 100%
(§C)**. El "100% de talento detectado con cifras validadas" depende de §A (datos), que no se
fabrica en un día. Este doc es el recopilatorio único de todo lo pendiente.

---

## Leyenda de estado

| Estado | Significado |
|---|---|
| 🔴 **BLOQUEADA** | `value: null` + `gate_reason`; no se muestra cifra. Correcta pero **no** resuelta. |
| 🟡 **ORIENTATIVA** | Se muestra con `calibrated: false` / `confidence` baja; **no** es `MEDIDA`. |
| 🟠 **MOCK+banner** | Dato de ejemplo tras banner visible; real solo cuando entre dato humano. |
| 🟢 **RESUELTA** | Procedencia correcta declarada; honesta y presentable. |

Tipo de desbloqueo: **CÓDIGO** (implementable) · **DATOS_HUMANOS** (antropometría/anotación) ·
**VALIDACIÓN** (clip/ground truth) · **OPERATIVO** (acción de deploy del usuario).

---

## 1. Métricas 🔴 BLOQUEADAS — qué falta para desbloquear

| Métrica | Dónde | Por qué está bloqueada | Desbloqueo |
|---|---|---|---|
| **Duelos G/P (ruta tracking)** | `src/hooks/useTracking.ts:714`, `src/lib/yolo/types.ts:129` | `winnerId` nunca se resuelve (`poseAnalyzer` deja `null`); G3 sin hacer. | CÓDIGO (unificar rutas + criterio de ganador) + VALIDACIÓN (`duelos_gt.csv`) |
| ~~**Espacio / Voronoi de sesión**~~ 🟢 | `src/hooks/useTracking.ts` | **RESUELTA (G7 · #187):** media de muestras Voronoi en instantes vivos del jugador enfocado; DERIVADA orientativa o gated (nunca 0). | — |
| **VSI-vídeo compuesto** | `api/agents/_pipeline-orchestrator.ts:261` (`gateVsiComposite`) | Bloqueado si <4/5 dims reales. Técnica/mental/táctica son `CONSTANTE(null)` → siempre 2/5 reales (physical+projection) → compuesto SIEMPRE bloqueado. Proyección y best-match se **omiten** en consecuencia. | Depende de que la VISIÓN mida técnica/mental/táctica (hueco permanente hoy) |
| **Variación del VSI de ficha** (`vsi_delta`) | `src/lib/scoring/vsiDelta.ts` (`computeVsiDelta`, `realVsiEvaluations`) | Solo se calcula entre dos evaluaciones del entrenador **con fecha y origen** (`data.vsiEvaluations`); el `vsiHistory` legacy no tiene fechas y contiene el 57.5 fabricado antes de #146 (migración 070 lo marca para revisión) ⇒ los jugadores existentes quedan bloqueados (`historial anterior sin fecha ni origen`) hasta su próxima evaluación. Ya usan la fuente única: ScoutFeed, panel de familia, informe `/report/:id` (variación + gráfica), PDF de servidor (gráfica), análisis baseline (sin `trend/history`; filas antiguas limpiadas al leer), bot de Telegram (`get_player` no envía el historial legacy al LLM), flechas ↑/↓ de `/rankings` y lista «Talentos en tendencia» de `/pulse` (`vsiTrendArrow`: signo de `computeVsiDelta`, banda ±2 pendiente de validar; bloqueada ⇒ sin flecha; solo los jugadores demo —MOCK con banner— conservan la flecha de su historial sembrado). | DATOS_HUMANOS (nuevas evaluaciones con fecha) |
| **VSI-vídeo sub-scores técnica/mental/táctica** | `_pipeline-orchestrator.ts:244-260` (`buildVsiSubscores`) | `CONSTANTE value:null` por diseño: el pipeline de visión no los mide. Bloqueo honesto. | VALIDACIÓN + modelo que los mida (largo plazo) |
| **Detección de balón parado desde vídeo** | `src/services/real/setPieceVideoDetector.ts` (`setPieceDetectionGate`) | No existe detector: antes se simulaba («YOLO + ByteTrack / pose») e inventaba jugadas sobre vídeos reales. Vídeo real ⇒ `gate_reason`; solo partidos demo generan ejemplos MOCK. | CÓDIGO (modelo que clasifique jugadas a balón parado) + VALIDACIÓN |
| **Detección de momentos para highlights** | `src/services/real/highlightsDetector.ts` (`highlightsDetectionGate`) | No existe detector. Vídeo real ⇒ `gate_reason` + reel vacío para clips manuales. | CÓDIGO (detector de eventos) + VALIDACIÓN |
| **Informe Gemini de jugador sin identificar** | `api/_lib/geminiBiomechanics.ts` (`resolvePlayerIdentity`) | Sin dorsal + color de referencia (el pipeline aún no los recibe), el informe solo se atribuye si el vídeo muestra UN único jugador (con advertencia); si no, el análisis se cierra `failed` con motivo y no se generan informes bajo el nombre del menor. Scores/conteos ausentes ⇒ `null` + `gate_reasons` (antes `?? 5` / `?? 0`). | CÓDIGO (llevar dorsal/color del UI → finalize → `analyses` → gemini-analyze; necesita migración) + VALIDACIÓN (identidad.md, ≥98%) |
| **Informe táctico de equipo con vídeo en la nube (Bunny)** | `src/hooks/useTeamIntelligence.ts` (gate cliente), `api/agents/_team-intelligence.ts` (gate servidor, `NO_VISUAL_INPUT`) | Sin entrada visual: el navegador no puede leer fotogramas de un vídeo de Bunny y no hay observación de Gemini → antes se generaba un informe "de 0 fotogramas" (inventado). Ahora se bloquea con motivo en `/team-analysis`. | CÓDIGO (extraer fotogramas u observación en servidor desde la URL de Bunny) |
| **Desglose por jugador del análisis de equipo heredado** (`/team-analysis`: dorsal, pases, duelos, recuperaciones, velocidad, distancia y mapa de calor por jugador) | `api/agents/team-observation.ts`, `api/agents/_team-intelligence.ts`, `src/lib/shared/teamReportIdentity.ts` (`withholdIndividualData`), `src/hooks/useTeamIntelligence.ts`, `src/pages/TeamAnalysisPage.tsx` | **Abstención de identidad (identidad.md, P0 menores).** El dorsal lo ADIVINABA el LLM (`dorsalEstimado`, con "7" de ejemplo en el prompt) y se pintaba junto a cifras por jugador. No existe capa de identidad por dorsal validada (Fase 2 de dorsal PAUSADA por el owner) ⇒ los prompts ya no piden dorsal ni filas por jugador, y servidor, hook y página retiran lo que llegue por jugador (incluidos los textos que nombran a un individuo, con el mismo predicado `mentionsIndividual` del job de partido). Los informes guardados antes se muestran sin esas filas y con un aviso. Solo nivel de equipo. | VALIDACIÓN (GT5 `fixtures/identidad/`, precisión ≥ 98% sobre convocatoria cerrada) + CÓDIGO (capa de dorsal: recorte de torso → distribución sobre la convocatoria → votación por pista → emparejamiento global). Hasta entonces, como mucho pistas anónimas «Pista #N» con procedencia, nunca bajo el nombre de un jugador. |
| **Análisis de partido completo por vídeo** (observación Gemini por tramos: `match_posesion_estimada_*`, `match_dominio_territorial_tramo`, descriptores por tramo, `match_eventos_citados`, informe A-vs-B) | `api/_lib/matchJob/*`, `api/match/[action].ts` (Fase 1, PR-A) | **APAGADO por decisión del owner (2026-09-29)**: el spike sobre un partido real (Veo follow-cam, sub-10 fútbol 8, tramo de 15 min) mostró que Gemini 2.5 Flash a 1 fps **fabrica** eventos de equipo (0 de 5 tiros citados existían en el segundo citado, verificado con fotogramas; eventos en pasos de ~10 s; posesión 50/50 a LOW; dorsales inexistentes, «#11» en un equipo sin números). `MATCH_VIDEO_ENABLED` ≠ `"true"` ⇒ `/start` 503 «en validación», la UI lo muestra deshabilitado y el protocolo step detiene cualquier job en vuelo. Toda la infraestructura está construida. Posesión con gate propio: baja confianza si no hay base visual confirmada o si todo sale 50/50 + «equilibrado». | VALIDACIÓN: clips anotados a mano en `fixtures/partido/` (GT10) que superen `scripts/validate-match-observation.mjs` (precisión/exhaustividad por categoría ≥ umbrales de `config/matchVideo.json`, «pendiente de validar») + decisión del owner. Nunca se relaja un umbral para activar. |

## 2. Métricas 🟡 ORIENTATIVAS (se muestran, pero NO son `MEDIDA`)

| Métrica | Dónde | Estado | Para ascender a `MEDIDA` |
|---|---|---|---|
| **Velocidad máx/media, distancia, sprints, accel** | `src/hooks/useTracking.ts:718-731` (`calibrated:false`, conf. 0.4) | Los bugs de cálculo YA arreglados (máx = p95 `:661`, sprints = `countSprintEvents` `:668`). Pero sin calibración de campo son **píxeles reescalados**, no metros/km-h fiables. | VALIDACIÓN: clip con calibración conocida (`fixtures/golden/calibracion.json`, hoy plantilla vacía) |
| **Escaneos (focus)** | `src/hooks/useTracking.ts:729` | Proxy sin validar; gated si el jugador no tiene frames cercanos. | VALIDACIÓN contra golden anotado |
| **Riesgo de abandono (servidor: Hub, `/wellbeing` y email mensual al director)** | `api/_lib/dropoutAssessment.ts` (única construcción de entradas, inv #7) → `src/lib/wellbeing/dropoutRiskScorer.ts`; lo usan `api/wellbeing/_dropout-risk.ts` y `api/crons/director-risk-digest.ts` | `DERIVADA`, `calibrated:false`, confianza `ORIENTATIVE_CONFIDENCE` (0.4; pesos y umbrales «pendiente de validar») vía `dropoutRiskMetric`. Solo se calcula con ≥1 señal REAL (asistencia; implicación con composite > 0; sesión de fatiga con `fatigue_index` no nulo); si no, `insufficient_data`. **Deuda:** vsiStagnation/injuryRecurrence/growthSpurtStress entran como 0 **sin redistribuir su peso** (25 %) → compuesto infravalorado; **«crítico» (≥ 75) es hoy inalcanzable**: cota superior 0.28·100 + 0.22·90 + 0.15·100 + 0.10·100 = 72.8 < 75 (pesos tras redistribuir resiliencia en `dropoutRiskScorer.ts:63-96`, máximo de motivación 90 = `amotivation` en `motivationClassifier.ts:48`; sin asistencia la cota es 0.34·100 + 0.26·90 + 0.15·100 = 72.4). Comprobado leyendo el código el 2026-09-30; no se ha medido el máximo real alcanzable (puede ser menor). También `resilience ?? 50` (CS-18). | CÓDIGO (cablear o excluir-y-renormalizar los 3 factores) + DATOS_HUMANOS (asistencia/implicación reales, GT8) + VALIDACIÓN de pesos |

## 3. Métricas 🟠 MOCK con banner

| Métrica | Dónde | Estado |
|---|---|---|
| **Set pieces (catálogo + «desde vídeo») y highlights de ejemplo** | `src/services/real/setPieceService.ts`, `setPieceVideoDetector.ts`, `highlightsDetector.ts` | MOCK+banner (`ProvenanceBadge` MOCK + `DemoDataBanner` en `/set-pieces`, carpetas, `/highlights`, detalle de reel). Registrados en `config/metrics.json` (`balon_parado_video_simulado`, `highlights_momentos_simulados`). |
| **Bienestar / Wellbeing** (`/family/:id`) | `src/hooks/useWellbeing.ts:140` | MOCK+banner. Inputs manuales YA cableados (cuestionario/asistencia/engagement, PRs #167/#170); falta **que alguien introduzca datos**. |
| **Radar de Retención** (tarjeta de `/director`) | `src/components/retention/RetentionRadarCard.tsx:33,66` | DemoDataBanner; **ROI en euros YA retirado** (`:113`, la cifra de mayor riesgo comercial). El riesgo de la TARJETA sigue siendo hash del id (`src/lib/retention/dropoutScore.ts:57-60`, `estimateDropoutRisk`) tras el banner y sin euros: `.claude/rules/metricas.md` lo prohíbe **incluso con banner** → abierto en §B. El **email mensual** ya NO usa este hash (ver §4). Real solo con señales reales. |

## 4. Métricas 🟢 RESUELTAS (honestas, no bloqueadas)

- **PHV / bio-banding** — `DERIVADA` gated; intactas (invariante #4, NO tocar).
- **Gate ÚNICO de PHV** (`src/lib/phv/phvGate.ts`, regla del owner 28-sep) — PHV (offset/APHV/fase) solo con TODAS las entradas introducidas: talla, peso, talla sentado, pierna (o talla − sentado), **edad decimal desde la fecha de nacimiento** y sexo; si falta cualquiera ⇒ `value: null` + «Falta: …» en TODAS las superficies (ficha, impresiones, PDF, equipo, comparador, Rankings cliente+API, ScoutFeed, baseline, orquestador, agente PHV). `players.phv_category/phv_offset` solo los escribe el endpoint de antropometría con fila completa (`age_source='birth_date'`, migración 069). %PAH es otra métrica (`pahGate`, «% talla adulta»). **Bloqueado por diseño** hasta que el coach re-guarde una medición completa con fecha de nacimiento: las filas antiguas (edad entera) NO cuentan. *Pendiente: textos LLM de informes/analyses antiguos generados con PHV no fiable (solo se archivaron los insights del ScoutFeed pre-#156).*
- **G6 Escudo de Estirón** — sexo obligatorio sin default `'M'` (`usePHVProduct.ts:60-73`, PRs #136-138); bloquea si faltan sitting/leg (más estricto que medido-sobre-estimado). *Falta: test explícito medido-vs-estimado + decisión sobre jugadores legacy guardados como `'M'`.*
- **VSI-ficha** — reetiquetado "evaluación del entrenador" (`metricsService.ts:61`), nullable (kill-58 #146); no evaluados excluidos de medias/percentiles/tiers (#150-152).
- **Pases / precisión / posesión** — reetiquetados `ESTIMADA_LLM` (`src/services/real/matchStatsService.ts:395`); ya no "datos cuantitativos medidos".
- **Contrato `MetricResult`** — fundación (`src/lib/metrics/MetricResult.ts`, factory con 5 invariantes que lanzan), migrada en tracking/matchStats/poseEligibility. **NO universal** (ver §5-B).
- **Email mensual al director «Radar de Retención»** (`api/crons/director-risk-digest.ts`, cron `0 8 1 * *` en `vercel.json`) — **P0 menores/legal corregido (2026-09-30, rama `fix/director-digest-no-hash-risk`)**. Antes derivaba el riesgo de un **hash del id** (`riskFor`, tercera copia del scorer) y enviaba **nombres de menores** «en riesgo alto/crítico» con un aviso de «Datos de ejemplo». Ahora: usa la evaluación real del servidor (`api/_lib/dropoutAssessment.ts`, la misma del panel); un jugador solo aparece si su evaluación es `computed` y alta/crítica; `insufficient_data`, sin id o jugador de ejemplo (`data.isDemo === true`, mismo marcador que `api/rankings/_list.ts`; ni se leen sus señales) ⇒ **no se nombra**; procedencia `MOCK`/`CONSTANTE` ⇒ tampoco (defensa en profundidad); si ningún jugador del director tiene evaluación real alta, **no se envía nada** (ni nombres ni resumen «sin datos»). El email declara procedencia (etiqueta canónica «Calculado» vía `src/lib/metrics/provenanceLabel.ts`), confianza orientativa, cobertura («evaluados con datos reales: N de M»), los factores sin señal y enlaza a `/wellbeing` (misma cifra), no a la tarjeta hash de `/director`. Solo lee los jugadores de cada director y no escribe nada. Tests: `api/crons/__tests__/director-risk-digest.test.ts` (control negativo ejecutado el 2026-09-30: con el `director-risk-digest.ts` de `origin/main` fallan 7 de 9 tests, y el de «solo datos mock/insuficientes» falla con `expected [ {…} ] to have a length of +0 but got 1`, es decir, salía 1 email con nombres; sin la guarda `isDemo` fallan los 2 tests de jugador de ejemplo). **Verificado (listado del owner, 29-30 sep):** en Vercel Production existen las variables `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `CRON_SECRET` y `SUPABASE_SERVICE_ROLE_KEY`. **No verificado:** si hay directores de pago en `subscriptions`, si el dominio del remitente está verificado en Resend, si el cron está registrado y llegó a ejecutarse, es decir, si el código anterior llegó a enviar correos.

---

## 4-bis. Ground truth humano requerido — índice único (el cuello de botella real)

> **Todo lo que sigue es dato HUMANO/FÍSICO, no un toggle ni código.** Ningún push
> lo resuelve; hasta que exista, las métricas afectadas siguen 🟡 orientativas, 🔴
> bloqueadas o 🟠 mock (nunca `MEDIDA`). Es deuda de **producto** (aparece en
> desarrollo/producción con vídeo real), **no de la demo** — la demo ni toca estos
> caminos (usa ejemplos pre-horneados). **Máximo apalancamiento: UN solo clip
> calibrado + anotado desbloquea identidad + físicas + duelos a la vez.**
>
> Reglas invariantes al recogerlo: las anotaciones son **humanas**, nunca sintéticas
> ni inferidas por un modelo (inv. identidad); `fixtures/` es **evaluación, no
> entrenamiento** (los umbrales NO se ajustan mirando esos clips); el % de frames
> legibles por un humano define el **techo físico** de cobertura y ninguna cifra de
> éxito puede superarlo.

| # | Qué falta (dato humano) | Fichero / destino | Cómo se recoge | Qué desbloquea | Estado hoy |
|---|---|---|---|---|---|
| GT1 | **Calibración de campo** — ≥4 puntos con coordenadas reales medidas del terreno | `fixtures/golden/calibracion.json` (plantilla vacía) | Marcar ≥4 puntos conocidos del campo (esquinas de área, círculo central…) con su posición en metros | Físicas 🟡→`MEDIDA`: velocidad/distancia/sprints/accel pasan de píxeles reescalados a metros/km-h fiables (valida homografía px→m) | 🔴 vacío |
| GT2 | **Distancia real (verdad medida)** | `fixtures/golden/distancia_gt` | GPS/EPTS por jugador, o cinta métrica sobre recorridos conocidos | Valida distancia/velocidad contra verdad (no solo autoconsistencia de la homografía) | 🔴 vacío |
| GT3 | **Ganador de duelos anotado** | `fixtures/golden/duelos_gt.csv` | Un humano marca por duelo quién gana/pierde | Duelos G/P 🔴→calculado: habilita el **criterio de ganador (G3)**, hoy prohibido inventar sin esta verdad | 🔴 vacío |
| GT4 | **VSI de referencia** | `fixtures/golden/vsi_gt` | Evaluación humana del compuesto para contrastar | Valida el VSI-vídeo compuesto | 🔴 vacío |
| GT5 | **Identidad por dorsal** — ≥3 clips ~60s anotados a mano | `fixtures/identidad/` (solo `_plantilla`) | Cámara fija + móvil + ≥1 en malas condiciones; fila por `(frame, track_id, dorsal, equipo, legible)` + convocatoria cerrada | Construir **y** validar la capa de identidad (≥98% precisión). Sin ella el sistema **abstiene** (pistas anónimas). Define el techo físico de cobertura | 🔴 solo plantilla |
| GT6 | **Umbral de cercanía (pose vs solo-posición)** — validar la frontera cercano/lejano del pipeline de recall | `fixtures/` (V6) + `poseEligibility.ts` | Anotar a mano en qué cajas los keypoints son fiables vs no | Fija el umbral hoy "pendiente de validar"; permite dar recall/FP reales del tracking a plano completo | 🟡 sin validar |
| GT7 | **Dataset para `vitas-pose-v1`** (modelo propio) | eval V6 + dataset etiquetado | Frames/bboxes de footage juvenil etiquetados a mano | Entrenar/validar el pose afinado (objetivo Fase 3); hoy producción usa pose de stock | 🔴 no existe |
| GT8 | **Datos reales de bienestar/retención** | input ya cableado (`useWellbeing.ts`, señales de retención) | Que personas introduzcan cuestionario/asistencia/engagement por jugador | Bienestar y Radar de Retención 🟠 mock→real (hoy tras banner; la tarjeta de `/director` aún = hash del id; el email mensual ya solo usa señales reales y sin ellas no se envía) | 🟠 mock, sin datos |
| GT9 | **Clip real (idealmente público)** para benchmark de tracking | — | Un vídeo de partido/entreno con URL pública | Benchmark BoT-SORT vs ByteTrack, pose n vs m, balón dedicado, homografía px→m | 🔴 falta |
| GT10 | **Eventos de equipo anotados a mano por partido** (varios partidos, tramos de 15 min) | `fixtures/partido/<clip_id>/{clip.meta.json, eventos.json}` (solo `_plantilla`) | Una persona ve el proxy y anota `[{t, team: home\|away, category}]` de todo lo que vea de cada categoría medida; declara los colores como el entrenador | Activar el análisis de partido completo (`MATCH_VIDEO_ENABLED`): `scripts/validate-match-observation.mjs` puntúa la observación contra esto; también fija fps/resolución/tramo de `config/matchVideo.json` | 🔴 solo plantilla |

> **Nota sobre técnica/mental/táctica del VSI-vídeo:** además de ground truth para
> validar, requieren un **modelo que las mida** (hoy el pipeline de visión no las
> mide → `CONSTANTE(null)`). Es hueco de capacidad a largo plazo, no solo de datos.

---

## 5. Trabajo pendiente por categoría

### A) DATOS / VALIDACIÓN HUMANA — el cuello de botella real (no lo arregla código)

> Resumen ejecutable del **índice §4-bis** (arriba, la lista completa con ficheros y estados).

- [ ] **Ground truth de identidad** — `fixtures/identidad/` (hoy solo `_plantilla`): ≥3 clips de ~60s anotados a mano (cámara fija + móvil + ≥1 en malas condiciones), fila por `(frame, track_id, dorsal, equipo, legible)` + convocatoria cerrada. Define el techo físico de cobertura; sin él la capa de identidad por dorsal **no se puede construir ni validar** (≥98% precisión) → el sistema seguirá abstiéndose (pistas anónimas).
- [ ] **Golden de físicas/duelos** — `fixtures/golden/` (vacío): `calibracion.json` (≥4 puntos medidos), `distancia_gt` (GPS/EPTS o cinta), `duelos_gt.csv`, `vsi_gt`. Sin verdad medida no se validan distancia/velocidad (homografía), duelos ni VSI.
- [ ] **Datos reales de bienestar/retención** — introducir cuestionario/asistencia/engagement por jugador (input ya cableado).
- [ ] **Clip real (idealmente público)** para benchmark de tracking (BoT-SORT vs ByteTrack, pose n vs m, balón, homografía px→m).

### B) CÓDIGO PENDIENTE (lo ejecuta el equipo dev)

> **Aclaración importante (verificada 28 ago):** el "audit a verde" **ya está hecho como GATE**.
> El pre-commit corre `python scripts/audit_metrics.py --baseline` → **exit 0**. El baseline
> (`config/metrics.baseline.json`, 88 keys) suprime la deuda conocida; la key es
> `code::metric::FICHERO` **sin nº de línea**, así que colapsa los 557 `LIT001` en ~20 keys. El
> "559 err / exit 1" es el audit **CRUDO** (estado G0 por diseño). Las 3 keys PHV
> (biobanding_pah, phv_aphv, phv_offset) están baselined → **las fórmulas NUNCA se tocan**
> (inv #4). Enumerar 290+ coeficientes en `allowed_literals` para vaciar el crudo sería
> busywork sin valor. **`ORPH001` es WARN, nunca ERROR → no bloquea nada.**

- [x] **Bug del audit (Windows)** — `ORPH001` comparaba `/` (registro) vs `\` (escáner) → 11 falsos positivos. Fix `.as_posix()`. **HECHO · #185.**
- [x] **Desconectar de la UI el `duelos_tracking` "0G/0P"** (`CONSTANTE`, winnerId siempre null) → ahora muestra el `gate_reason`, no un 0. **HECHO · #185.**
- [x] **Voronoi de sesión (G7)** — muestreo en instantes vivos + media del jugador enfocado; DERIVADA orientativa o gated (nunca 0). **HECHO · #187.**
- [x] **`npm audit fix`** — protobufjs 7.6.4→7.6.6, cierra el RCE crítico; runtime 10→2 vulns. **HECHO · #186.**
- [ ] **Unificar duelos** (`DUP001`: 3-4 rutas — tracking/eventengine/gemini, inv #7). La plomería (una sola ruta) es código, pero el **criterio de ganador (G3) está BLOQUEADO por datos** (prohibido inventarlo sin `duelos_gt.csv` anotado, ver §A).
- [ ] **`allowAsync` en la UI** (partidos largos): ruta async lista+testeada pero **sin caller**; cablearla = UI inerte **hasta que el usuario ponga `MODAL_TRACK_ASYNC_URL`** (§C). No hecho: prematuro.
- [ ] **~52 ficheros fuera del contrato** (`ORPH001`, WARN no-bloqueante): meterlos bajo el registro es **pura cobertura opcional** (no desbloquea nada). Baja prioridad.
- [ ] **`vitas-pose-v1`** (modelo propio): **BLOQUEADO por datos/validación** — depende de la eval V6 (ground truth) + dataset etiquetado con frames/bboxes.
- [ ] **Vaciar el audit CRUDO** (opcional, cosmético): declarar coeficientes en `allowed_literals` para los ~247 literales NO-PHV; los PHV se quedan baselined (inv #4). Sin impacto en el gate (ya verde).
- [ ] **Partido completo · duplicado temporal de la File API de Gemini** (inv #7, deuda conocida): `api/agents/video-observation.ts` conserva su propia subida/poll (con `?key=` en la URL) y el job usa la librería nueva `api/_lib/gemini/{files,generate}.ts` (key en cabecera `x-goog-api-key`). No se tocó en la Fase 1 para no chocar con ramas en vuelo; **migrar en la Fase 2** y borrar la copia.
- [ ] **Partido completo · posesión heredada** (inv #7): `posesion` (`tactico.posesion`, `api/agents/team-observation.ts`) solapa con `match_posesion_estimada_*` (`partido.posesion.*`). La ruta heredada se retira en la Fase 2.
- [x] **Análisis de equipo heredado sin dorsal adivinado ni cifras por jugador** (identidad.md, P0): los prompts de `team-observation` y `team-intelligence` ya no piden `dorsalEstimado` ni `jugadoresObservados[]`/`jugadores[]`; guarda compartida `withholdIndividualData` en servidor, hook (al guardar y al LEER el histórico: `useAllTeamAnalyses`/`useSavedTeamAnalyses` vía `teamLevelRows`) y página; retiradas de los 7 idiomas las cadenas de la tabla/ficha por jugador (incl. la plantilla de dorsal `Mapa de Calor — #{{number}}`); retirado del hook el emparejamiento por índice pista YOLO ↔ «jugador» del LLM (mapa de calor atribuido sin validar) y el bloque YOLO del prompt (duelos `0G/0P` fijos). **HECHO · rama `fix/team-analysis-no-llm-dorsal` (PR #305 abierto, sin fusionar).**
- [ ] **Residuales del análisis de equipo heredado** (no hechos en ese PR): (a) las filas antiguas de `team_analyses` siguen guardando `jugadores[]`/`dorsalEstimado` en la base: la UI las oculta al leer, pero limpiarlas es una decisión del owner (migración de datos, no escrita ni aplicada). Cuántas filas lo llevan en producción **no está verificado**; consulta de solo lectura para medirlo: `select count(*) filter (where report ? 'jugadores') as con_jugadores, count(*) as total from public.team_analyses;` (b) el export de cuenta (`api/account/_export.ts`) entrega esas filas tal como están guardadas (sin cambios a propósito: es el dato que se conserva; se resuelve con (a)); (c) ~~claves i18n sin uso tras retirar la tabla~~ — retiradas en el mismo PR; (d) siguen abiertos en esa pantalla la posesión `?? 0` sin rótulo (B4), `jugadoresDetectados ?? 0` y la confianza autoinformada `?? 0` (y su delta contra 0 en la comparativa).
- [ ] **Partido completo · acelerador del webhook de Bunny sin cablear**: el tick de Modal (cada 5 min) es el conductor durable y despacha los `awaiting_encode` ya codificados; el webhook (Status 3) podría llamar a `processAwaitingJob` para ahorrar hasta 5 min. No hecho en PR-A (opcional; el tick basta).
- [ ] **Partido completo · worker Modal (PR-B) e UI (PR-C)** — sin ellos el backend no recibe ops; la UI debe consultar `GET /api/match/availability` y mostrar «En validación» mientras esté apagado, dejando el informe con notas intacto.
- [x] **P0 · Digest mensual al director sin riesgo por hash** (`api/crons/director-risk-digest.ts`): quitado `riskFor`/`hash32`; usa `api/_lib/dropoutAssessment.ts` (única implementación de servidor, compartida con `/api/wellbeing/dropout-risk`); solo nombra evaluaciones `computed` altas/críticas con procedencia/confianza/cobertura; sin evaluación real no envía nada; jugadores `isDemo` excluidos. Búsqueda en todo `api/` (ripgrep, 2026-09-30) de `charCodeAt|Math\.imul|hash32|hashCode|seededFactors|riskFor|estimateDropoutRisk|retention/dropoutScore|generateMockRiskAssessment|seededRandom|mulberry|xorshift`: solo 4 aciertos y ninguno es un scorer (comparación en tiempo constante `api/_lib/demoAccess.ts:149`, `api/webhooks/stripe.ts:41`, `api/_lib/edgeCrypto.ts:38`; hex en `api/_lib/gemini/files.ts:170`). **Control positivo:** el mismo patrón sobre el digest de `origin/main` encuentra `hash32`/`riskFor` (`:34-43,132`) y sobre `src/` encuentra `dropoutScore.ts:49-92` y `useWellbeing.ts:506-507`. Ningún fichero de `api/` importa `src/lib/retention/*`. Emisores de servidor revisados (`sendEmail`, `api.resend.com`, `webpush`, `api.telegram.org`): `api/notifications/_cron.ts` (VSI/inactividad/límite de plan), `api/agents/_pipeline-orchestrator.ts` (VSI del informe), `api/telegram/webhook.ts`, leads/demo/auth/stripe/account. En todo `api/`, `dropout|abandono` solo aparece en `api/_lib/dropoutAssessment.ts`, `api/wellbeing/_dropout-risk.ts`, `api/wellbeing/[action].ts`, `api/agents/_burnout-report.ts`, el digest y sus tests (los aciertos de `retention` son retención de datos RGPD/vídeo, no abandono) → el digest es la única ruta de servidor que envía riesgo de abandono por email/push. Relacionado (no email/push): `api/agents/_burnout-report.ts` narra el riesgo que le manda el cliente, que puede ser el mock por hash (ver P1 siguiente). **HECHO · rama `fix/director-digest-no-hash-risk`.**
- [ ] **P1 · Mock por hash en el cliente de bienestar** — `src/hooks/useWellbeing.ts:506-510` (`generateMockRiskAssessment`: semilla = suma de `charCodeAt` del id), usado cuando el endpoint falla (`:138,141,149`). Prohibido incluso con banner (rules/metricas.md). Además, `WellbeingDashboard.tsx:223` muestra el botón del informe IA de burnout también con el mock (`buildBurnoutInput`, `useWellbeing.ts:342-361`), así que el LLM (`api/agents/_burnout-report.ts`) puede redactar un informe de riesgo de abandono sobre cifras por hash. No tocado en el P0 del digest.
- [ ] **Tarjeta Radar de Retención de `/director`** — sigue usando `estimateDropoutRisk` por hash (`src/components/retention/RetentionRadarCard.tsx:33` → `src/lib/retention/dropoutScore.ts:57-60`) tras banner. Sustituir por las evaluaciones reales del servidor o bloquear con motivo; después borrar `dropoutScore.ts` (tercera copia del modelo, inv #7).
- [ ] **Riesgo de abandono · 3 factores a 0 sin renormalizar** — `api/_lib/dropoutAssessment.ts` pasa `vsiStagnation/injuryRecurrence/growthSpurtStress = 0` con su peso intacto (25 %) → «crítico» inalcanzable (cota 72.8). Excluir y renormalizar (patrón de asistencia/resiliencia) o cablear las señales; con test.
- [ ] **P1 · Sin datos = riesgo 0 «bajo»** — `insufficientAssessment` (`api/_lib/dropoutAssessment.ts`, antes `_dropout-risk.ts:140-163`) devuelve `riskScore 0` / `"low"` con `source: "insufficient_data"`; el Hub lo pinta como riesgo 0 bajo el banner. Debe ser `value null` + motivo (inv #2). El digest no lo lista nunca.
- [ ] **Arnés · el patrón SYN001 no detecta `hash32(`** (`scripts/audit_metrics.py:46`; ya anotado en `docs/inventario-metricas-g0.md:61`). Por eso el hash del digest pasó el audit. Añadir `hash\d*\s*\(` / `seededFactors`: aflorará `src/lib/retention/dropoutScore.ts` como SYN001 nuevo → decidir baseline o retirarlo antes.
- [ ] **Partido completo · ruta HLS de Bunny y token auth del CDN** «pendiente de validar» (`hlsVariantPathTemplate` en `config/matchVideo.json`; spike (h)). Si el pull zone usa token auth, falta firmar `sourceUrl` en `api/_lib/matchJob/bunnySource.ts`.
- [x] **Seguridad CS-01 · `ADMIN_SECRET` deja de ser token de servicio** — HECHO en código (#304, rama `fix/retire-admin-secret-service-token`, 30 sep). Se filtró en bundles antiguos como `VITE_ADMIN_SECRET` y seguía aceptándose en `hasValidServiceToken` (`api/_lib/withHandler.ts`: `serviceOnly` + `allowServiceToken` → exportar datasets etiquetados de menores, informes de padres, saltarse propiedad y rate limit) y en `api/rag/_embed.ts` / `_ingest.ts` (comparación propia con `===`). Ahora solo valen `CRON_SECRET` / `INTERNAL_API_TOKEN` / `SUPABASE_SERVICE_ROLE_KEY`, en tiempo constante; embed/ingest delegan en `withHandler` (una sola implementación, inv #7); `env.adminSecret` y la línea de `.env.example` retirados; `scripts/seed-rag.sh` usa `INTERNAL_API_TOKEN`/`CRON_SECRET`. Tests: `api/_lib/__tests__/serviceToken.test.ts` (incluye guard de repo: nadie lee `ADMIN_SECRET`) y `api/rag/__tests__/serviceTokenAuth.test.ts`. El panel admin NO cambia: ya usaba el JWT del admin (`useAdminOrgs.ts` → `getAuthHeaders`, `adminOnly` + `ADMIN_EMAILS`). **Falta la parte del operador → C3.**
- [~] **Seguridad CS-12 · seed del RAG en CI** — HECHO: el job `rag-seed` sale de `ci.yml` (corría en cada push a main contra PRODUCCIÓN, borraba y reinsertaba la base de conocimiento y se tragaba los errores con `|| echo skipped`). Ahora es manual: `.github/workflows/rag-seed.yml` (solo `workflow_dispatch`, confirmación literal `BORRAR-Y-RESEMBRAR`, destino limitado a `https://futuro-club*.vercel.app`) y `scripts/seed-rag.sh` sale en rojo si una siembra no devuelve `success` con `indexed == total`. Ya no usa la `SUPABASE_SERVICE_ROLE_KEY` de GitHub como Bearer. Verificado en los logs de los runs de push a `main` 36730070797 (30 sep, cabeza `0c3a438`) y 35224355502 (17 sep): la cabecera salía como `Bearer ` VACÍA (ese secret no existe en el repo), los dos `curl` fallaron y el job imprimió «skipped» y terminó en verde; el código HTTP no quedó en el log (`curl -s`), así que «respondió 403» es deducido, no verificado. Es decir, en esos runs el job no resembró nada pero decía que todo iba bien; los runs anteriores no se revisaron. **PENDIENTE (no hecho):** seed idempotente por upsert SIN `DELETE` previo (`api/rag/_seed.ts`, `_seed-knowledge.ts`) y fallar si quedan filas sin embedding (`_ingest.ts` inserta la fila aunque el embedding sea `null`). Cuántas filas hay hoy sin embedding: **no verificado** (consulta de solo lectura: `select count(*) filter (where embedding is null) as sin_embedding, count(*) as total from knowledge_base;`).
- [ ] **Acceso solo del dueño · 076 (P0, acceso cruzado entre cuentas por un tenant compartido)** — código hecho en la rama `fix/owner-only-player-access-076` (PR #307; **fusionado** el 1 oct 2026 en `0eef846`, comprobado con `gh pr view 307` y `git log origin/main` el 9 oct. Que la 076 esté APLICADA en producción **no está verificado**: el dueño no ha mandado aún las salidas de su previa/posterior); migración `supabase/migrations/076_owner_only_player_access.sql` + `supabase/checks/076_previa.sql` / `076_posterior.sql` pendientes del operador (§C9).
  - **Decisión:** la tomó el asistente el **30 sep 2026** por delegación expresa del dueño («la que veas tú mejor»): **SOLO EL DUEÑO**. Los datos de un jugador los ven y cambian solo `players.user_id` y `service_role` (backend, Modal, crons). **Sin rama por tenant y sin rama nueva por organización.** Una fila atada a un jugador la LEE además quien la creó (su `user_id` / `coach_id` / `seller_user_id`); ESCRIBIR exige ser el dueño del jugador. Lo que no está atado a un jugador (vídeo de equipo, job de partido completo) es solo de quien lo creó.
  - **Por qué:** datos de menores; el único `players.tenant_id` de producción (los 3 jugadores tienen el MISMO valor) no es ni un usuario ni una organización (VERIFICADO 29-30 sep), así que no se sabe qué agrupa; la vía por organización ya está rota en producción (`user_org_ids`/`user_in_org` usan `team_members.org_owner_id`); invariante #3 (abstenerse es válido).
  - **Qué se cerró (código, sin depender de la migración):** `ownsPlayerOrTenant` y `ownedPlayersOrFilter` eliminados; `ownsVideo`, `ownsMatch`, `ownsMatchAnalysis` sin tenant; reports / share / generate-reports / sign-consent / create-upload / finalize / identify-player / candidates / match start-status-cancel / team baseline + compare-rival / transfer create-listing + list-inquiries / tactical ×5 / video-init / IDP generate-plan (no tenía NINGÚN check de propiedad y aceptaba `coachId`/`tenantId` del cuerpo). **Borrado RGPD**: el cron `data-retention` y `delete-me` borraban `players`, `videos`, `analyses`, `reports`, `subscriptions` y `parental_consents` **WHERE tenant_id = el del solicitante** → con un tenant compartido, la baja de UNA cuenta borraba los datos de TODAS; ahora una sola implementación (`api/_lib/accountErasure.ts`) borra solo lo del dueño. `transfer/create-listing`: si la consulta del dueño falla (no-ok) ahora responde 503 y no publica (antes se leía como «jugador local» y publicaba igual). Lint `api/__tests__/no-tenant-access.test.ts` (control negativo: 36 coincidencias en origin/main 8de81fb, 1 permitida en la rama). Tests por endpoint `api/__tests__/owner-only-endpoints.test.ts` (create-listing, list-inquiries, IDP generate-plan, generate-reports: otra cuenta del MISMO tenant → 403 sin escribir nada; control negativo: 9 de sus 11 tests fallan con los handlers anteriores).
  - **Cambio de comportamiento declarado:** `idp/generate-plan` exige ahora que el jugador exista en la base y sea del usuario (mismo criterio que ya tenía `idp/get-plan`); un jugador aún sin sincronizar (local / en cola) recibe 403 hasta que se sincronice. Antes no había ningún check.
  - **Qué se cerró (base de datos, 076):** `public.caller_manages_player(text)` solo-dueño (si la 073 del PR #303 la creó con tenant, la sustituye) y `public.dsar_caller_manages_player(text)` (072 APLICADA en producción — VERIFICADO; por su código, 072:254-296, acepta el tenant del JWT, también de `app_metadata`, con o sin hook → cualquier cuenta con ese mismo tenant puede exportar el expediente RGPD de un menor y pedir su borrado — DEDUCIDO del código y reproducido en simulación; si hoy alguna cuenta comparte ese tenant NO está verificado: lo cuenta la previa); se corrige también el texto de los comentarios de `dsar_export_player_data` / `dsar_request_deletion` (decían «dueño/tenant»; cuerpo y permisos sin cambios); políticas *_076 en 16 tablas (players, videos, analyses, reports, parental_consents, player_anthropometrics, development_plans + idp_goals/milestones/checkins, transfer_listings/inquiries, tactical_phases/phase_heatmaps/tactical_insights, match_analyses). También retira las tácticas de 048 abiertas a CUALQUIER usuario con sesión (si la 055 no se aplicó). Simulación PGlite (NO es la base real): 484 comprobaciones, antes = acceso cruzado, después = ninguno, dueños conservan lo suyo, service_role igual; la 076 no cambia el cuerpo de ninguna otra función.
  - **Cómo revisarla:** compartir con un club se reactivará más adelante, de forma EXPLÍCITA, con el diseño del alta de cuentas (directores + aprobación de acceso; ver `onboarding-account-flow-spec`). Ese cambio toca a la vez `api/_lib/ownership.ts` y `public.caller_manages_player` (migración nueva + simulación + comprobación previa que cuente quién entra).
  - **NO hecho / pendiente (fuera de este P0, con evidencia):** (1) **PR #303 (073)** define el mismo helper con rama por tenant y guarda de «no dueños que entrarían»: debe revisarse a solo-dueño (misma función que la 076); si se aplicara DESPUÉS de la 076 tal cual, volver a ejecutar la 076 (la posterior lo detecta). (2) **Ramas por ORGANIZACIÓN** que siguen vivas: RLS de 027/038/039/052 (`org_id IN (SELECT user_org_ids())` / `organizations.owner_id` en players, videos, player_analyses, tracking_sessions, consent_audit_log, player_knowledge, evaluation_history, tracking_jobs; → sus ESCRITURAS de filas de un jugador ajeno las cierran las guardas de la 074, incluido el INSERT por organización de player_knowledge / evaluation_history; quedan las LECTURAS y el UPDATE de players) y el roster por `team_members.org_owner_id` de `api/players/_crud.ts` (miembros aprobados por el director). La decisión del 30 sep dice «sin rama por organización»; esta PR NO las retira (su alcance es el tenant) → queda **pendiente y abierto**: la cabecera de la 073 da por verificado que `user_org_ids`/`user_in_org` de producción usan `team_members.org_owner_id` (un id de USUARIO), así que un MIEMBRO de club no casaría ningún `org_id`; el DUEÑO de una organización sí vería los jugadores con ese `org_id` (DEDUCIDO de esos cuerpos y de 027/038; NO verificado: ni los `players.org_id` ni las filas de `organizations` de producción se han consultado). Requiere migración propia + simulación + comprobación previa. (3) **IDOR nuevo (no por tenant):** `api/idp/_approve-plan.ts`, `_checkin.ts`, `_update-goal.ts`, `_update-milestone.ts` no comprueban propiedad del plan (cualquier cuenta pro/club modifica el plan IDP de cualquier menor por id). → **Cerrado en código en el PR de la 074** (ver «Escrituras solo del dueño · 074», abajo; sin fusionar). (4) `subscriptions_tenant_isolation` (003) sigue por tenant: no es dato de jugador. (5) Residuo de LECTURA por creador: filas de jugador creadas en el pasado por otra cuenta vía tenant (la previa fila 12 las cuenta). (6) Las políticas de dueño de 000/038 permiten crear una fila `videos` apuntando al jugador de otro (su dueño la vería): no es por tenant; el navegador ya solo adjunta jugadores propios (`supabaseVideoService`). → **La cubren las guardas de la 074** (abajo; pendiente de fusionar y aplicar). (7) `api/__tests__/rls-isolation.test.ts` (BD real) actualizado a la regla nueva pero NO ejecutado (sin credenciales).
- [ ] **Escrituras solo del dueño · 074 (P0, audit extras 10/11: cualquier cuenta con sesión escribía filas de CUALQUIER jugador)** — código hecho en la rama `fix/rls-player-write-ownership-074` (PR #309 «writes to fatigue sessions and IDPs require managing the player (074)», **abierto y SIN fusionar** — comprobado con `gh pr view 309` el 12 oct; NO resuelto en producción hasta fusionar y aplicar la 074). Migración `supabase/migrations/074_rls_player_write_ownership.sql` + `supabase/checks/074_previa.sql` / `074_posterior.sql` pendientes del operador (§C10).
  - **Decisión:** la MISMA de la 073 y la 076 (el dueño del producto la delegó el **30 sep 2026**, «la que veas tú mejor»; el asistente eligió **SOLO EL DUEÑO**): los datos de un jugador los escriben solo `players.user_id` y `service_role`; sin rama por tenant ni por organización. Por qué: datos de menores; el único `players.tenant_id` de producción no es ni un usuario ni una organización (VERIFICADO 29-30 sep); la vía por organización ya está rota (`team_members.org_owner_id`); invariante #3. Cómo revisarla: compartir con un club se reactivará de forma EXPLÍCITA con el alta de cuentas (directores + aprobación de acceso), cambiando a la vez `api/_lib/ownership.ts` y `public.caller_manages_player`; las guardas de la 074 usan ese helper, así que lo seguirán sin editarlas.
  - **Defecto (VERIFICADO leyendo el repositorio):** la política de ESCRITURA de cliente solo miraba la columna del AUTOR y dejaba libre `player_id`; el servidor luego lee por `player_id` con service_role. `fatigue_sessions` (`043:57-63`; lectores: `_pipeline-orchestrator.ts:580-586` → riesgo de lesión, `api/_lib/dropoutAssessment.ts:65` → riesgo de abandono y email al director; ningún escritor en el código: el navegador llama a `/api/tracking/fatigue-session`, ruta que no existe). `development_plans` + `idp_goals/milestones/checkins` (`047:168-195`; `/api/idp/get-plan` devuelve el plan más reciente por jugador y mes, `_get-plan.ts:200-215`; un plan plantado además bloquea el del dueño ese mes por `uq_idp_player_month_active`, `047:46-48`). Misma clase y mismo arreglo (búsqueda en todo el repo con lint y control positivo): `tracking_sessions` (`009:25-29`, `038:152-156`; historial del dueño y DSAR), `player_analyses` (`000:110-111`, `038:135-139`; `api/scout/generate.ts:353` y DSAR), `videos` (`000:35-36`, `001:69-72`, `038:112-122`; residuo (6) de la 076), `live_events` (`032:114-115`), `scout_insights` (UPDATE `016:46-48`). **Añadidas el 12 oct (rama por ORGANIZACIÓN, mismo arreglo):** `evaluation_history` y `player_knowledge` (RAG, `039:177-183` y `039:67-73`: INSERT con «jugador propio» **OR** `org_id IN (SELECT user_org_ids())`). La rama por organización no mira al jugador y cualquier cuenta puede crear SU propia organización (`org_owner_all`, FOR ALL USING `owner_id = auth.uid()` sin WITH CHECK, `026:27-28`; la primera rama de `user_org_ids()` devuelve las organizaciones de las que el llamador es dueño, `038:41-42`) → cualquier cuenta escribe historial de evaluación (VSI) y «notas» de CUALQUIER jugador, que su dueño lee por RLS (`039:59-65, 169-175`) y por `get_player_timeline` / `get_player_context` (SECURITY INVOKER). Hoy ningún código de la app los lee ni escribe: el único, `src/lib/rag/playerContextEngine.ts`, no lo importa nadie (VERIFICADO: búsqueda en el repo con control positivo); la vía es PostgREST directo. Lo encontró la revisión adversarial del PR (simulación) y el lint lo pasaba por alto porque daba por buena cualquier regla que MENCIONARA `players` + `user_id = auth.uid()` aunque fuera en un OR; ahora el lint decide por la estructura (en un OR, todas las ramas deben exigir ser el dueño).
  - **Qué hace (base de datos, 074):** 24 guardas **RESTRICTIVE** (INSERT y UPDATE, `TO authenticated`, solo `WITH CHECK`) en esas 12 tablas: `player_id IS NULL OR public.caller_manages_player(player_id::text)`; en `idp_*`, el jugador del plan. PostgreSQL las combina con AND con TODAS las PERMISSIVE (las de 043/047/000/038/039, las *_076, una creada a mano o re-creada por un script de `supabase/pending/`), así que se aplica en cualquier orden con la 073/076 y no duplica la 076. Reutiliza el helper de la 073/076 (no lo redefine; sin él, la 074 aborta). No toca LECTURA ni DELETE, datos, PHV, funciones, permisos de tabla, ni activa RLS (si una de las tablas existe sin RLS, aborta). El autor de una fila antigua de otro jugador aún puede desligarla (player_id NULL o un jugador suyo), no dejarla ni crearla en ese jugador.
  - **Qué hace (código, sin depender de la migración):** `/api/idp/approve-plan`, `checkin`, `update-goal` y `update-milestone` (escriben con service_role) exigen ahora ser el dueño del jugador del plan (`ownsIdpPlan` / `ownsIdpPlanItem` en `api/_lib/ownership.ts`); otra cuenta, un id que no existe o una comprobación que falla → 403 sin escribir nada; llamadas de servicio igual que antes. Tests `api/__tests__/idp-write-ownership.test.ts` (21; control negativo: con los handlers de `origin/main` fallan 17, pasan solo los 4 de llamada de servicio).
  - **Pruebas:** lint del repositorio `src/test/migrations/074_rls_player_write_ownership.test.ts` (sin la 074 y sin la 076 encuentra las 12 tablas; con la 076 y sin la 074, las 8 que no son de planes IDP; con la 074 solo quedan las excluidas de abajo; control negativo: con la 074 anterior de 10 tablas el lint queda en rojo por las 2 del RAG). **SIMULACIÓN** PGlite (NO es la base real), PostgreSQL 18.3 y 16.4, forma verificada de producción: 215 comprobaciones OK en cada versión (antes: otra cuenta del mismo tenant u otro escribe filas de un jugador ajeno, también RAG por SU organización, y el dueño lee por RLS la fila plantada; después: 42501 o 0 filas; el dueño hace las mismas 20 operaciones del navegador y de video-init con el mismo resultado; service_role igual; solo se añaden las 24 guardas; orden 073→076→074, 073→074→076 y cadena completa; dos veces = mismo estado; sin helper, con helper por tenant o con una tabla sin RLS: aborta sin cambiar nada). Control negativo de la simulación (guardas PERMISSIVE): 58 fallos. La fila «OTRAS tablas» de la previa (11) y la posterior (7) ya no se salta una regla que menciona `players` pero lleva rama por organización/tenant (simulado con una tabla sintética; la versión anterior no la veía).
  - **NO hecho / pendiente (con evidencia):** (a) **Misma clase, NO incluidas** (otra regla): `match_events` (`004:22-25`; el registro en directo manda eventos de los dos equipos, `team` home/away, `liveMatchService.ts:67-80, 207-219`, así que «dueño del jugador» no es obviamente la regla — DEDUCIDO, no verificado qué `playerId` pone la UI en los del rival; además, según el esquema del REPO, esa escritura del navegador no casa con la 004 — manda `match_id`, `kind`, `team`… que la 004 no tiene y no manda `user_id`, que es NOT NULL; ninguna otra migración toca `match_events` (grep) —; el esquema real de producción no está verificado), `player_session_metrics` (`044:99-106`, la propiedad es de la SESIÓN; `player_id` sin FK), `tracking_jobs` (`052:85-87`, lo arregla el PR #308). (b) **Filas antiguas** escritas por quien no es el dueño (residuo de antes): la 074 NO las borra; las cuenta la previa (filas 20-31; en `evaluation_history` / `player_knowledge`, sin columna de autor, cuenta las filas con una organización que no es del dueño del jugador). Limpiarlas es **decisión del dueño** (migración de datos no escrita). Mientras tanto los lectores de servidor (orquestador, riesgo de abandono, `idp/get-plan`, historial de tracking, insights) las siguen leyendo por `player_id` sin mirar el autor. (c) `approve-plan` / `checkin` siguen aceptando `coachId` / `reviewerId` del cuerpo como **atribución** (quién aprobó / revisó) dentro del plan propio; la UI no los manda hoy (`IDPPage` no pasa `coachId`). No es acceso a datos ajenos; no se cambió para no tocar comportamiento. (d) `checkin` no comprueba que `goalId` sea de ESE plan. (e) Las ramas por ORGANIZACIÓN que quedan son de LECTURA (SELECT de players, videos, player_analyses, tracking_sessions, consent_audit_log, evaluation_history, player_knowledge, tracking_jobs) y el UPDATE de la propia tabla `players` (`038:90-94`; es la raíz de la propiedad, no una tabla con `player_id`): siguen pendientes (punto (2) de la 076); las guardas de la 074 limitan las ESCRITURAS a jugadores del propio llamador en estas 12 tablas. (f) En producción **no verificado**: si la 073/076 están aplicadas, qué tablas de las 12 existen (también `organizations`, de la 026), si tienen RLS, y si `anon` tiene permiso de tabla de escritura en ellas (fila 10 de la previa; con RLS y sin `auth.uid()` no pasa las políticas de autor).

### C) OPERATIVO / DEPLOY — acción del USUARIO (dashboards/claves, sin código)

> **Todo esto se puede cerrar HOY desde el móvil/navegador** (paneles Supabase / Vercel /
> Modal / Anthropic). Cerrar C completo deja la herramienta **segura y desplegada al 100%**.
> Orden por prioridad:

- [ ] **C0 · URGENTE · Digest del director antes del 2026-10-01 08:00 UTC** — el cron `0 8 1 * *` (`vercel.json:46-47`) ejecuta el código que esté desplegado. Mientras no se despliegue la rama `fix/director-digest-no-hash-risk`, producción sigue con la versión que nombra menores con riesgo por hash. Antes de esa hora: o mergear y desplegar el fix, o desactivar el cron en Vercel (Settings → Cron Jobs). **No verificado** si el código anterior llegó a enviar correos: el cron existe desde el commit `4c3ae69` (2026-07-03), así que las ejecuciones posibles fueron el 2026-08-01 y el 2026-09-01 a las 08:00 UTC, siempre que estuviera desplegado y registrado. Además hacían falta directores de pago en `subscriptions` (no verificado) y el dominio del remitente verificado en Resend (C7, no verificado); `RESEND_API_KEY` **sí** existe en Vercel Production (verificado por el listado de variables del owner, 29-30 sep), así que ese requisito no lo impedía. Para comprobarlo sin enviar nada: en Vercel → Cron Jobs, si el job figura y cuándo corrió (la retención de logs depende del plan, tampoco verificado); y en el panel de Resend, los envíos con asunto «en riesgo de abandono».
- [x] **C1 · Activar `custom_access_token_hook` en Supabase** — ✅ **HECHO Y VERIFICADO (28 ago): hook `ENABLED` + diag `[OK]` (claim raíz `tenant_id` presente en el token, 8/8 usuarios con tenant). RLS multi-tenant de datos de menores OPERATIVA.** (Era ⚠ lo más crítico.) Pasos de referencia (verificados contra `supabase/migrations/057_custom_access_token_hook.sql`):
  1. **Paso 0 — ¿existe la función?** SQL Editor → `select proname from pg_proc where proname = 'custom_access_token_hook';`. Vacío → aplica antes la 057 (pega el fichero entero en el SQL Editor).
  2. **Paso 1 — activar:** Authentication → Hooks → *"Customize Access Token (JWT) Claims"* → función `public.custom_access_token_hook` → **Enable**.
  3. **Paso 2 — verificar** con el script recreado: `node --env-file=.env.production.local scripts/diag-jwt-tenant.mjs` (solo lectura; comprueba la precondición 8/8 usuarios). Para la confirmación DEFINITIVA del claim raíz añade `DIAG_TEST_EMAIL=… DIAG_TEST_PASSWORD=…` de una cuenta tuya → debe salir `[OK]`. Alternativa manual: re-loguear en la app y en consola `JSON.parse(atob((await window.supabase.auth.getSession()).data.session.access_token.split('.')[1])).tenant_id`.
  4. **Rollback:** desactivar el hook → RLS vuelve a fallar-cerrada (estado actual), sin romper la app.
  - **Nota 30 sep (076, solo el dueño):** la RLS de datos de jugador deja de usar el tenant; tras aplicar la 076 este hook ya no abre ni cierra nada de jugadores (sigue usándolo `subscriptions_tenant_isolation`, que no es dato de jugador). Que los 8 usuarios compartan o no el mismo `tenant_id` NO está verificado: lo cuenta `supabase/checks/076_previa.sql`.
  - ⚠ Al activarlo, un usuario real SIN `app_metadata.tenant_id` dejaría de ver sus datos por lectura directa (la migración dice 9/9 usuarios lo tienen, verificado 20 ago) → hazlo mirando la app justo después.
- [x] **C2 · Verificar/aplicar migraciones 052–059** — ✅ **HECHO (28 ago): las 8 aplicadas vía SQL consolidado en el SQL Editor** (054 ledger, 055 RLS táctica, 056/058 género sin default, 057 hook JWT, 059 VSI nullable).
- [ ] **C3 · Rotar 8 credenciales + retirar `ADMIN_SECRET`** (Anthropic, Voyage, Bunny, Supabase service_role, Modal AUTH, Bunny webhook secret, `CRON_SECRET`, `INTERNAL_API_TOKEN`) → regenerar en cada dashboard, actualizar env Vercel + secrets Modal, borrar `.env` locales. **Bloquea antes de:** firma de academia / demo con datos reales.
  - **`ADMIN_SECRET` (9.ª, CS-01):** se filtró en bundles antiguos como `VITE_ADMIN_SECRET`. Tras mergear #304 (CS-01) ningún código lo lee → **BORRARLO** en Vercel (Production + Preview; también en `vitas-demo` si existe allí) en vez de rotarlo, y confirmar que **no queda ninguna `VITE_ADMIN_SECRET`**. Si algo externo (p. ej. un webhook de Supabase configurado en el dashboard hacia `/api/auth/welcome`) mandaba `ADMIN_SECRET` como Bearer, cambiarlo a `INTERNAL_API_TOKEN` o `CRON_SECRET` — desde el repo **no se puede verificar** qué Bearer usa ese webhook. Comprobación (solo lectura): Vercel → Settings → Environment Variables, buscar `ADMIN_SECRET` → no debe aparecer.
  - **GitHub Actions (CS-12):** verificado el 30 sep con `gh secret list` (solo nombres): el repo tiene `NOTION_PAGE_ID`, `NOTION_TOKEN`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL` — **no** existe `SUPABASE_SERVICE_ROLE_KEY` (nada que borrar) ni `INTERNAL_API_TOKEN` / `CRON_SECRET`. Para lanzar a mano `rag-seed.yml` hay que **crear** el secret `INTERNAL_API_TOKEN` (o `CRON_SECRET`) con el MISMO valor que en Vercel; sin él el workflow falla en rojo con un mensaje claro. Al rotarlos en Vercel, actualizarlos también en GitHub.
- [x] **C4 · Hard-caps de gasto** — ✅ **HECHO (28 ago): `GLOBAL_MONTHLY_BUDGET_USD` en Vercel + Anthropic $30/mes (hard-cap) + Modal $1/mes (Starter free tier, SIN tarjeta → tope natural, no puede cobrar).** El tripwire del código es fail-open; estos topes de proveedor son el backstop real.
- [ ] **C5 · `MODAL_TRACK_URL` + `MODAL_API_KEY`** (+ `MODAL_TRACK_ASYNC_URL` + `MODAL_CALLBACK_SECRET`) en env Vercel; sin ellas el tracking de vídeo degrada a mock/cliente y `allowAsync` (§B) queda inerte.
- [ ] **C5-bis · Escalar Modal para PARTIDOS COMPLETOS (diferido)** — hoy NO hacen falta (no se procesan partidos de 90 min; el tracking en navegador maneja clips). Cuando lleguen esos vídeos: (1) subir el **Modal usage limit** — requiere **añadir tarjeta** (se sale del free tier de $1); (2) subir **`GLOBAL_MONTHLY_BUDGET_USD`** — el gasto de Modal cuenta en ese bote compartido con Claude/Gemini, y el tripwire corta Modal si se supera. Coste ~**$0.60/partido** (T4, timeout 60 min; real ~$0.20–0.30). Dimensionado (Modal limit / GLOBAL): 10 partidos/mes → **$15 / $25** · 30 → **$30 / $45** · 50 → **$45 / $65** · 100 → **$80 / $110**.
- [ ] **C6 · Stripe** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs), **VAPID** (push), **Telegram** (`TELEGRAM_BOT_TOKEN` + webhook) — hoy en modo demo/inertes. Activar el que necesites.
- [ ] **C7 · Resend (correo transaccional + leads)** — la migración **063** (tabla `leads`) YA está aplicada, así que `/api/leads` **ya captura en Supabase y devuelve 200**; el lead NO se pierde. Lo único pendiente es la **notificación por email** y el resto del correo transaccional, todo centralizado en `sendEmail` (`api/_lib/email.ts`, #234). Pasos:
  1. **Vercel (producción):** poner `RESEND_API_KEY`. Opcional `RESEND_FROM_EMAIL` (default `"VITAS <noreply@krujens.eu>"`). Sin la key, `sendEmail` degrada limpio (`console.warn` + `return false`, no rompe).
  2. **DNS de `krujens.eu`** (⚠ el paso que se olvida): verificar el dominio en Resend añadiendo **DKIM + SPF + MX de retorno** (este último sobre un **subdominio**, p. ej. `send.krujens.eu`). Aunque pongas la key, si el dominio no está verificado el envío falla igual (el `from` es `@krujens.eu`). Los registros van **donde vivan los nameservers de krujens.eu** (si es **Hostinger**, en su editor de zona DNS; si está delegado a Vercel/Cloudflare, allí). **No requiere contratar nada en Hostinger** ni cambia el MX principal → los buzones/emails actuales de krujens.eu siguen intactos.
  3. **Redesplegar** producción.
  - **Desbloquea de golpe** (misma key, todos usan `sendEmail`): aviso de leads (`api/leads.ts`), bienvenida/confirmación de signup (`api/auth/_welcome.ts`, #227), **consentimiento RGPD** (`api/auth/sign-consent.ts`), borrado de cuenta RGPD (`api/account/delete-me.ts`), invitaciones/solicitudes de club (`api/team/_invite.ts`, `_request.ts`), notificaciones cron (`api/notifications/_cron.ts`), resumen mensual al director (`api/crons/director-risk-digest.ts`; desde el P0 del 2026-09-30 solo sale si hay evaluaciones reales altas).

- [ ] **C8 · Partido completo por vídeo — activación (NO antes de validar)**: tras mergear PR-A/B/C, aplicar la migración **067** en Supabase; en Vercel `MODAL_MATCH_START_URL`, `GLOBAL_MONTHLY_BUDGET_USD=20`, clave Gemini de pago en `GEMINI_API_KEY`; Modal con tarjeta + límite de gasto $10/mes + `VITAS_MATCH_STEP_URL` en el secret `vitas-api-key`; rotar C3 antes de footage real; spike (a)–(i) en Modal con resultados literales aquí. **`MATCH_VIDEO_ENABLED=true` SOLO** cuando `scripts/validate-match-observation.mjs` apruebe varios partidos anotados (GT10) y el owner lo decida. En `vitas-demo`, sin definir.

- [ ] **C9 · Solo el dueño (076) — orden estricto, una consulta cada vez (runbook 12b):**
  1. **Primero, sin esperar a la 076:** ejecutar `supabase/checks/076_previa.sql` y mirar la fila **6 · URGENTE**. Si hay una baja pendiente cuyo tenant tiene jugadores de OTRAS cuentas, el cron desplegado hoy los borraría a las 03:00 UTC: cancelar la solicitud o desplegar el código del PR antes.
  2. Fusionar el PR (el código se despliega ANTES de la migración y no depende de ella: el dueño entra por `players.user_id` con service_role).
  3. Mandar el resultado COMPLETO de la previa. Filas **BLOQUEA** con `ok = false` → no aplicar. Las filas 20-32 dan, por recurso, cuántos usuarios NO dueños entran hoy por tenant (el dato que pidió el dueño).
  4. Solo después: `supabase/migrations/076_owner_only_player_access.sql` (aborta sola si queda algo por tenant en esas tablas).
  5. `supabase/checks/076_posterior.sql`: `resultado = esperado` y `ok = true` en todas.
  6. Si la 073 se aplica más tarde con rama por tenant, repetir 4-5.

- [ ] **C10 · Escrituras solo del dueño (074) — después de C9, una consulta cada vez:**
  1. Fusionar el PR de la 074 (el código de `/api/idp/*` se despliega al fusionar y no depende de la migración).
  2. Con la 076 (o la 073) ya aplicada y su posterior en verde: `supabase/checks/074_previa.sql` (solo lectura). Filas **BLOQUEA** con `ok = false` → no aplicar y mandar el resultado COMPLETO. Las filas 20-31 dicen, por tabla, cuántas filas escribió alguien que NO es el dueño del jugador (en las 2 del RAG, cuántas llevan una organización que no es del dueño del jugador) (decisión aparte, ver §B).
  3. `supabase/migrations/074_rls_player_write_ownership.sql` (aborta sola, sin cambiar nada, si falta el helper solo-dueño, si una de las tablas no tiene RLS o si faltan columnas: mandar el mensaje completo).
  4. `supabase/checks/074_posterior.sql`: `ok = true` en todas las filas con `ok`.
  5. Si después se volviera a aplicar una versión de la 073 con rama por tenant, la fila 1 de la posterior de la 074 lo detecta: repetir la 076.

> **Verificación automática:** `scripts/diag-jwt-tenant.mjs` (recreado) confirma la precondición
> (usuarios con `app_metadata.tenant_id`) y, con `DIAG_TEST_EMAIL/PASSWORD`, el claim raíz del token.
> Solo lectura, nunca imprime la key ni PII. Probado en prod: **8/8 usuarios con tenant_id**.

### D) SEGURIDAD / RLS — pendiente tras la 073 (verificado vs deducido)

> La 073 sustituye las 10 políticas que comparaban `players.tenant_id` con `auth.uid()`
> (044/050) por una regla única **solo dueño**, `public.caller_manages_player`
> (`players.user_id = auth.uid()`, espejo de `ownsPlayer`), en las 5 tablas de bienestar y
> perfil conductual. Lo de abajo NO lo resuelve la 073.

- [x] **Alcance de la 073: SOLO DUEÑO — DECIDIDO (registro de la decisión)**
  - **Qué:** por RLS y por funciones de base de datos, a los datos de un jugador solo accede su
    dueño (`players.user_id = auth.uid()`) y `service_role`. Sin rama por tenant y sin rama por
    organización / membresía de club.
  - **Quién y cuándo:** el dueño del producto delegó la elección el **30 sep 2026** («la que
    veas tú mejor») y el asistente (Claude) eligió **solo dueño**.
  - **Por qué:** (1) datos de menores; (2) **VERIFICADO** en producción (consultas de solo
    lectura del dueño, 29-30 sep): los 3 jugadores comparten un único `players.tenant_id` que no
    es un `auth.users.id` ni un `organizations.id`, y no se sabe qué representa; (3) la vía por
    organización ya está rota (ver «miembros de club» abajo); (4) invariante #3: abstenerse es
    un resultado válido. Coincide con las rutas de servidor de esas tablas, que usan `ownsPlayer`
    (`api/behavioral/[action].ts:59`, `api/wellbeing/[action].ts:73,132`,
    `api/wellbeing/_dropout-risk.ts:51`, `api/injuries/_list.ts:31`, `_save.ts:46`; VERIFICADO
    por grep).
  - **Cómo se revisa:** compartir con club/academia se reactivará de forma **explícita** en una
    migración posterior, junto con el diseño del alta de cuentas (directores + aprobación de
    acceso) y con su propia comprobación previa. No editando la 073.
  - **Lo evitado** se puede medir antes de aplicar: filas 13 y 17 de
    `supabase/checks/073_previa.sql` (usuarios no dueños y filas por tabla que una rama por
    tenant habría expuesto; resuelven el tenant como el hook 057 + `public.tenant_id()`, con
    comparación uuid). **SIMULADO** (PGlite, PostgreSQL 18.3 y 16.4): coinciden con lo que lee
    de verdad cada usuario con la versión anterior «dueño O tenant» en 11 escrituras del uuid y
    en un conjunto mixto.
- [ ] **Compartir con club/academia (reactivar, explícito)** — pendiente del diseño del alta de
  cuentas (directores + aprobación de acceso + acceso limitado al club; diferido). Requiere una
  migración nueva con su previa; hasta entonces, solo dueño.
- [ ] **Rama por tenant que la 073 NO cierra** — la cubre la **076**, en curso en el **PR #307**
  (`fix/owner-only-player-access-076`; abierto y **sin mergear** el 1 oct 2026, comprobado con
  `gh pr list --head` y `git branch -r`; su cabecera está leída, su contenido **no** está
  revisado aquí). La 073 y la 076 se pueden aplicar en cualquier orden (**SIMULADO**): las dos
  dejan el mismo helper solo dueño y la 073 conserva el de la 076 si ya está:
  (a) **DSAR de la 072**: `public.dsar_caller_manages_player` compara `players.tenant_id::text`
  con el tenant del JWT, del claim raíz o de `app_metadata` (`072:264,285`). **SIMULADO**: un
  usuario no dueño con el mismo `app_metadata.tenant_id` (texto igual) exporta los datos del
  menor y marca su borrado; en MAYÚSCULAS no. Fila 19 de la previa: cuántos usuarios no dueños
  pasan hoy (comparación de texto, la misma de la 072).
  (b) **RLS de `players`**: `players_tenant_isolation` (`003:239-247`, `FOR ALL TO authenticated`
  por tenant; en producción **no verificado**, filas 6 y 20 de la previa). **SIMULADO**: con el
  claim raíz `tenant_id`, un compañero de tenant hace `UPDATE players SET user_id = él mismo`
  (1 fila; sin el claim, 0) y desde ese momento es «dueño» para la 073 y para `ownsPlayer`.
  Ya pasaba antes de la 073.
  (c) **Servidor con `ownsPlayerOrTenant`** (VERIFICADO por grep): `api/auth/sign-consent.ts:100`,
  `api/analyses/reports.ts:73`, `api/videos/create-upload.ts:106`, `api/videos/finalize.ts:114` y
  `ownsVideo` (`api/_lib/ownership.ts:134`).
- [ ] **Lectura de `player_metric_snapshots` desde el navegador — RETENIDA en la 073** —
  **VERIFICADO leyendo el código**: su único lector (`useMetricSnapshots.ts:40-47` →
  `SnapshotHistoryChart.tsx:40,93`, montado en `PlayerEvolutionPage.tsx:517`) dibuja
  `phv_offset` tal cual, sin gate PHV ni procedencia; su escritor,
  `POST /api/agents/progression-tracker`, no comprueba propiedad (`_progression-tracker.ts:46`
  `requireAuth + allowServiceToken`; ningún `owns*`/`isServiceCall` en el fichero) y guarda el
  PHV que manda el cliente (`:64-65`) con la service key. **VERIFICADO en producción**: ningún
  jugador tiene fecha de nacimiento, así que ningún PHV de snapshot es fiable hoy. La 073 retira
  la política rota (`snapshots_read_own`) y **no crea otra**: el gráfico de evolución sigue
  vacío, como hoy. Para reabrirla: (1) progression-tracker con `ownsPlayer` en llamadas que no
  son de servicio y sin aceptar PHV del cliente; (2) el gráfico por el gate PHV y con la
  procedencia; (3) una migración con su previa. La fila 22 de la previa cuenta los snapshots con
  PHV que no respalda ninguna fila fiable de `player_anthropometrics` (criterio de `069:298-313`).
- [ ] **044 aplicada DESPUÉS de la 072** (hipótesis; si la 044 está aplicada en producción y
  cuándo: **no verificado**) — dejaría vivas `snapshots_insert_own` / `valuations_insert_own`
  (`WITH CHECK (true)` para todos, `044:85-86,121-122`) y los privilegios de cliente que la 072
  retira (`072:590-607`). La previa lo bloquea (filas 10 y 21) y la 073 aborta (su guarda).
  Remedio: re-ejecutar el bloque «044 · player_metric_snapshots / player_valuations» de la 072.
  **SIMULADO**: bloquea, aborta sin cambiar nada y, tras el remedio, aplica.
- [ ] **Acceso de miembros de club por organización (`team_members`)** — **VERIFICADO**
  (consulta de solo lectura del dueño, 29-30 sep): en producción `public.user_org_ids()` y
  `public.user_in_org(uuid)` **no son las del repo** (038:37-64): usan
  `team_members.org_owner_id`, que según el repo es el id del **usuario** dueño
  (`007_team_members.sql:5`, `references auth.users`), no el de la organización.
  **DEDUCIDO, no verificado con datos:** las políticas que hacen
  `org_id IN (SELECT user_org_ids())` comparan un id de organización con un id de usuario ⇒
  los miembros de un club que no son dueños probablemente **no** ven por esa vía los
  jugadores de su organización. La 073 **no usa ni toca** estas funciones. Pendiente:
  decidir el modelo de membresía, leer los cuerpos reales línea a línea (runbook #5) y una
  migración propia con su comprobación previa.
- [ ] **Escrituras del navegador que siguen fallando tras la 073 (no es RLS)** — **SIMULADO**
  (PGlite con el esquema del repo; columnas reales de producción **no verificadas**): por
  columna, `attendance_records.notes` (`wellbeingService.ts:154` cuando hay notas;
  `localStorageMigrationService.ts:209`), `wellbeing_questionnaires.date`
  (`localStorageMigrationService.ts:261`) y `dropout_risk_assessments.date/primary_factor`
  (`:291`, `:294`) → 42703; `source: 'auto_detected'` (`useWellbeing.ts:250`) viola el CHECK de
  `046:12` → 23514; una segunda asistencia del mismo jugador y día → 23505 (`046:15`
  `UNIQUE (player_id, date)`, y el upsert del navegador va por `onConflict: "id"` sin id,
  `wellbeingService.ts:147-157`). Además, **reportado por la revisión 2 del PR #303** (SIMULADO
  por el revisor con la forma de PostgREST; no re-simulado aquí): la subida única de la caché
  local pone `id: undefined` en ids que no son uuid (`localStorageMigrationService.ts:165,204,258,289`,
  VERIFICADO leyendo) y postgrest-js incluye `id` en `columns=` ⇒ NULL ⇒ 23502 para todo el lote;
  la marca de «ya migrado» se pone igual (`:372-373`). El fallo es silencioso y el dato queda en la
  caché local, como hoy.
- [ ] **Seguimientos del audit de la 073 (fuera de su alcance)** — **VERIFICADO leyendo el
  código**, no probado contra producción:
  (a) `POST /api/agents/progression-tracker` sin comprobación de propiedad (ver «lectura de
  snapshots retenida»): cualquier usuario con sesión puede escribir snapshots (incl.
  `phv_offset`/`phv_category`) de cualquier jugador cuyo id sea uuid (`zod` `:26`);
  (b) `api/injuries/_save.ts:62` guarda el id del usuario como `tenant_id` (`?? userId`; igual en
  `api/live/matches.ts:69` y `api/telegram/connect.ts:56`) y su insert usa columnas/valores que
  044 no tiene (`tenant_id`, `reported_by` `:76`, severidad `'mild'` `:18`);
  (c) respaldo a la clave anon en `api/injuries/_list.ts:18` y `_save.ts:36`;
  (d) `api/behavioral/_compute-profile.ts:45-53` devuelve puntuaciones `Math.random`
  (invariantes #1 y #2).

---

## Notas de estado (correcciones a documentación previa)

- **Spike del 2026-09-29 (partido real del owner, Veo follow-cam, sub-10 fútbol 8, tramo de 15 min, Gemini 2.5 Flash a 1 fps):** 0 de 5 tiros citados existían en el segundo citado (verificado con fotogramas); eventos en pasos plantilla de ~10 s; posesión 50/50 a resolución LOW; citó dorsales inexistentes («#11» en un equipo sin números). Consecuencias en PR-A: análisis APAGADO por defecto (`MATCH_VIDEO_ENABLED`), fps/tramo/resolución configurables (`config/matchVideo.json`, `geminiVideoFps` «pendiente de validar»), arnés `scripts/validate-match-observation.mjs` + `fixtures/partido/`, guarda de identidad que también descarta texto con números de camiseta o referencias a un solo jugador («el portero», «a player»), y gate de baja confianza de la posesión (sin base visual confirmada por `usageMetadata` / 50-50 + «equilibrado» uniforme). Un tramo cuya respuesta no trae tokens de vídeo se descarta entero (`no_visual_input`).

- **Modal ya NO está huérfano** (la nota de `CLAUDE.md` es obsoleta): desplegado (roadmap V1/V2 ✅) y cableado a UI (`useTacticalHeatmap.ts:187`, `videoTrackingService.ts:184`).
- **npm vulns bajaron** de ~35 → 10 → **2 moderate** en runtime (#186 cerró el RCE crítico de protobufjs). Restan `sharp`/`@vite-pwa/assets-generator` (build-time, CVEs libvips upstream sin fix).
- **Modelo de balón dedicado ya existe** (`ball-football.onnx`, `ballModelConfig.ts:107`) — cierra el hueco de FASE 2; falta hacerlo default (desktop usa aún `yolo11s-detect` COCO genérico).
- **`docs/demo-setup.md` está OBSOLETO** (describe el enfoque viejo #233 con Supabase separado + `seed-demo.mjs`). La demo VIGENTE (fases 1–4, #237–#243) corre **SIN Supabase**: `IS_DEMO = VITE_DEMO=1` **Y** Supabase NO configurado (doble guarda, `src/lib/demoMode.ts`); los datos viven en `localStorage`, sembrados por `DemoDataService.seed()` en la primera carga. La demo **no necesita** proyecto Supabase propio, migraciones ni `seed-demo.mjs`. **PENDIENTE:** actualizar o marcar como obsoleto ese doc para que nadie cablee Supabase a la demo (justo lo que la doble guarda evita).

> **Mantenimiento:** actualizar este fichero cuando una métrica cambie de estado
> (p. ej. al cerrar G3/G7, o cuando entre un golden anotado). No borrar las
> resueltas — el histórico de qué se desbloqueó y cómo es parte del valor.
