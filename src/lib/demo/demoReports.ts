/**
 * VITAS · Informes de ejemplo del DEMO (piso piloto)
 *
 * En el demo NO hay pipeline de vídeo ni Supabase, así que los informes de IA
 * (que en producción genera y guarda ese pipeline) se PRE-HORNEAN aquí como
 * ejemplo. No son análisis reales; la UI los muestra bajo el banner
 * «Datos de ejemplo». Cada informe se DERIVA de los datos reales del jugador
 * (VSI de ficha, posición, métricas, maduración) → cada jugador tiene un
 * informe distinto y coherente con su perfil, sin inventar un número global.
 *
 * MULTI-IDIOMA (sin ternarios es/en): los textos se eligen con `pickLocale` desde
 * mapas por idioma → añadir un idioma = añadir su clave (si falta, cae al idioma
 * por defecto). Los tokens de enum (tier_label, prioridad, report_type) NO se
 * traducen — la capa de presentación los rotula. Solo se traduce la PROSA.
 *
 * Formato: se construye un `AnalysisDbRow` (el mismo shape que devuelve Supabase)
 * y se pasa por `mapDbRowToLegacy` en el hook → así el demo ejercita el MISMO
 * mapeo que producción, sin duplicar la lógica de presentación.
 */

import type { Player } from "@/services/real/playerService";
import type { AnalysisDbRow } from "@/hooks/usePlayerAnalysisV2";
import { gatedMaturity } from "@/lib/phv/phvGate";
import i18n from "@/i18n";
import { normalizeLocale, pickLocale, type ReportLocale } from "@/lib/shared/locale";

const METRIC_LABEL: Partial<Record<ReportLocale, Record<string, string>>> = {
  es: {
    speed: "Velocidad",
    technique: "Técnica con balón",
    vision: "Visión de juego",
    stamina: "Resistencia",
    shooting: "Definición",
    defending: "Trabajo defensivo",
  },
  en: {
    speed: "Speed",
    technique: "Ball technique",
    vision: "Game vision",
    stamina: "Stamina",
    shooting: "Finishing",
    defending: "Defensive work",
  },
  it: {
    speed: "Velocità",
    technique: "Tecnica con la palla",
    vision: "Visione di gioco",
    stamina: "Resistenza",
    shooting: "Finalizzazione",
    defending: "Lavoro difensivo",
  },
  de: {
    speed: "Geschwindigkeit",
    technique: "Balltechnik",
    vision: "Spielübersicht",
    stamina: "Ausdauer",
    shooting: "Torabschluss",
    defending: "Defensivarbeit",
  },
  fr: {
    speed: "Vitesse",
    technique: "Technique de balle",
    vision: "Vision de jeu",
    stamina: "Endurance",
    shooting: "Finition",
    defending: "Travail défensif",
  },
  nl: {
    speed: "Snelheid",
    technique: "Baltechniek",
    vision: "Spelinzicht",
    stamina: "Uithoudingsvermogen",
    shooting: "Afwerking",
    defending: "Verdedigend werk",
  },
  "es-419": {
    speed: "Velocidad",
    technique: "Técnica con balón",
    vision: "Visión de juego",
    stamina: "Resistencia",
    shooting: "Definición",
    defending: "Trabajo defensivo",
  },
};

// Comparables de ejemplo por familia de posición (SOLO demo — etiquetado como ejemplo).
const PRO_BY_POSITION: Array<{ match: RegExp; nombre: string; posicion: string; club: string }> = [
  { match: /portero/i,                 nombre: "Unai Simón",     posicion: "Portero",        club: "Athletic Club" },
  { match: /central|defensa/i,         nombre: "Pau Torres",     posicion: "Central",        club: "Aston Villa" },
  { match: /lateral/i,                 nombre: "Alejandro Balde",posicion: "Lateral",        club: "FC Barcelona" },
  { match: /pivote|mediocentro/i,      nombre: "Martín Zubimendi",posicion: "Pivote",        club: "Real Sociedad" },
  { match: /mediapunta|interior/i,     nombre: "Fabián Ruiz",    posicion: "Mediapunta",     club: "PSG" },
  { match: /extremo/i,                 nombre: "Nico Williams",  posicion: "Extremo",        club: "Athletic Club" },
  { match: /delantero|punta/i,         nombre: "Álvaro Morata",  posicion: "Delantero",      club: "Selección Española" },
];

function tierLabelFor(vsi: number): string {
  if (vsi >= 80) return "elite";
  if (vsi >= 70) return "alto";
  if (vsi >= 60) return "medio_alto";
  if (vsi >= 50) return "medio";
  return "desarrollo";
}

/** Ordena las 6 métricas para separar fortalezas (altas) de áreas (bajas). */
function rankedMetrics(player: Player, locale: ReportLocale): Array<{ key: string; label: string; value: number }> {
  const labels = pickLocale(locale, METRIC_LABEL);
  const m = player.metrics ?? ({} as Record<string, number>);
  return Object.keys(labels)
    .map((key) => ({ key, label: labels[key], value: (m as Record<string, number>)[key] ?? 0 }))
    .sort((a, b) => b.value - a.value);
}

function maturityBlurb(player: Player, locale: ReportLocale): string {
  const mat = gatedMaturity(player as unknown as Parameters<typeof gatedMaturity>[0]);
  const byTiming: Record<string, Partial<Record<ReportLocale, string>>> = {
    late: {
      es: "Madurador tardío: hoy compite físicamente por detrás de sus pares, pero su margen de crecimiento está por llegar. Talento a menudo infravalorado — no descartar por tamaño.",
      en: "Late maturer: today competes physically behind peers, but the growth margin is still to come. Often undervalued talent — don't rule out by size.",
      it: "Maturatore tardivo: oggi compete fisicamente dietro ai suoi pari, ma il suo margine di crescita deve ancora arrivare. Talento spesso sottovalutato — non scartare in base alla taglia.",
      de: "Spätentwickler: konkurriert körperlich derzeit hinter Gleichaltrigen, doch der Wachstumsspielraum steht noch bevor. Oft unterschätztes Talent — nicht nach Körpergröße aussortieren.",
      fr: "Maturateur tardif : aujourd'hui, il rivalise physiquement en retrait de ses pairs, mais sa marge de croissance reste à venir. Talent souvent sous-évalué — ne pas écarter selon la taille.",
      nl: "Laatrijpe speler: fysiek doet hij het vandaag onder zijn leeftijdsgenoten, maar zijn groeimarge moet nog komen. Vaak ondergewaardeerd talent — niet afschrijven op basis van lichaamsbouw.",
      "es-419": "Madurador tardío: hoy compite físicamente por detrás de sus pares, pero su margen de crecimiento está por llegar. Talento a menudo infravalorado — no descartar por tamaño.",
    },
    early: {
      es: "Madurador precoz: parte de su rendimiento actual se apoya en una ventaja física temporal que sus pares igualarán. Priorizar el desarrollo técnico-táctico sobre el físico.",
      en: "Early maturer: part of the current output leans on a temporary physical edge peers will catch up to. Prioritise technical-tactical development over physical.",
      it: "Maturatore precoce: parte del rendimento attuale poggia su un vantaggio fisico temporaneo che i suoi pari colmeranno. Dare priorità allo sviluppo tecnico-tattico rispetto a quello fisico.",
      de: "Frühentwickler: Ein Teil der aktuellen Leistung beruht auf einem vorübergehenden körperlichen Vorteil, den Gleichaltrige aufholen werden. Technisch-taktische Entwicklung vor der körperlichen priorisieren.",
      fr: "Maturateur précoce : une partie du rendement actuel repose sur un avantage physique temporaire que ses pairs combleront. Prioriser le développement technico-tactique sur le physique.",
      nl: "Vroegrijpe speler: een deel van de huidige prestaties steunt op een tijdelijk fysiek voordeel dat leeftijdsgenoten zullen inhalen. Geef prioriteit aan technisch-tactische ontwikkeling boven fysieke.",
      "es-419": "Madurador precoz: parte de su rendimiento actual se apoya en una ventaja física temporal que sus pares igualarán. Priorizar el desarrollo técnico-táctico sobre el físico.",
    },
    on_time: {
      es: "Maduración en fase con sus pares: la evaluación actual refleja bien su nivel relativo.",
      en: "Maturing in phase with peers: the current evaluation reflects their relative level well.",
      it: "Maturazione in fase con i suoi pari: la valutazione attuale riflette bene il suo livello relativo.",
      de: "Reifung im Gleichschritt mit Gleichaltrigen: Die aktuelle Bewertung spiegelt sein relatives Niveau gut wider.",
      fr: "Maturation en phase avec ses pairs : l'évaluation actuelle reflète bien son niveau relatif.",
      nl: "Rijping in fase met leeftijdsgenoten: de huidige beoordeling weerspiegelt zijn relatieve niveau goed.",
      "es-419": "Maduración en fase con sus pares: la evaluación actual refleja bien su nivel relativo.",
    },
  };
  const fallback = {
    es: "Timing de maduración por determinar (datos fuera de la ventana de fiabilidad); se evalúa el rendimiento observado.",
    en: "Maturation timing to be determined (data outside the reliability window); observed performance is evaluated.",
    it: "Timing di maturazione da determinare (dati al di fuori della finestra di affidabilità); si valuta il rendimento osservato.",
    de: "Reifungszeitpunkt noch zu bestimmen (Daten außerhalb des Zuverlässigkeitsfensters); die beobachtete Leistung wird bewertet.",
    fr: "Timing de maturation à déterminer (données hors de la fenêtre de fiabilité) ; on évalue la performance observée.",
    nl: "Rijpingstiming nog te bepalen (gegevens buiten het betrouwbaarheidsvenster); de waargenomen prestatie wordt beoordeeld.",
    "es-419": "Timing de maduración por determinar (datos fuera de la ventana de fiabilidad); se evalúa el rendimiento observado.",
  };
  return pickLocale(locale, byTiming[mat.timing] ?? fallback);
}

/** Construye el/los análisis de ejemplo para un jugador del demo. */
/** Zona base en el campo (105×68, ataca izq→der) por posición, para el heatmap de ejemplo. */
function posZone(position: string): { x: number; y: number; sx: number; sy: number } {
  const p = position.toLowerCase();
  if (/portero|goalkeeper|gk/.test(p)) return { x: 9, y: 34, sx: 5, sy: 8 };
  if (/lateral.*(izq|left|i\b)|left.?back|lb/.test(p)) return { x: 34, y: 55, sx: 18, sy: 9 };
  if (/lateral|right.?back|rb|carrilero/.test(p)) return { x: 34, y: 13, sx: 18, sy: 9 };
  if (/central|defensa|centre.?back|cb|zaguero/.test(p)) return { x: 24, y: 34, sx: 12, sy: 13 };
  if (/pivote|mediocentro def|cdm|holding/.test(p)) return { x: 44, y: 34, sx: 14, sy: 14 };
  if (/interior|mediocentro|central mid|cm|box.?to.?box/.test(p)) return { x: 56, y: 34, sx: 16, sy: 15 };
  if (/mediapunta|enganche|cam|attacking mid|10\b/.test(p)) return { x: 68, y: 34, sx: 15, sy: 14 };
  if (/extremo.*(izq|left|i\b)|left.?wing|lw/.test(p)) return { x: 74, y: 55, sx: 16, sy: 9 };
  if (/extremo|winger|right.?wing|rw|banda/.test(p)) return { x: 74, y: 13, sx: 16, sy: 9 };
  if (/delantero|striker|forward|st|punta|9\b/.test(p)) return { x: 86, y: 34, sx: 11, sy: 14 };
  return { x: 55, y: 34, sx: 16, sy: 14 };
}

export function buildDemoAnalysisRows(
  player: Player,
  locale: ReportLocale = normalizeLocale(i18n.language),
): AnalysisDbRow[] {
  const vsi = typeof player.vsi === "number" ? player.vsi : 60;
  const ranked = rankedMetrics(player, locale);
  const strengths = ranked.slice(0, 3).map((r) => ({ title: r.label }));
  const areas = ranked.slice(-2).map((r) => ({ title: r.label }));
  const first = player.name.split(" ")[0];
  const pos = player.position;
  const posLow = pos.toLowerCase();
  const pro = PRO_BY_POSITION.find((p) => p.match.test(player.position)) ?? PRO_BY_POSITION[4];
  const matBlurb = maturityBlurb(player, locale);
  const s0 = strengths[0].title.toLowerCase();
  const a0 = areas[0].title.toLowerCase();
  const joinSep = pickLocale(locale, { es: " y ", en: " and ", it: " e ", de: " und ", fr: " et ", nl: " en ", "es-419": " y " });
  const join = (arr: string[]) => arr.join(joinSep);

  // Estadísticas de partido de EJEMPLO derivadas de las métricas de ficha. Se
  // marcan fuente:"gemini_only" (sin YOLO/tracking físico) y confianza 0.6 → los
  // paneles aplican la procedencia (ESTIMADA_LLM). NO se emite bloque `fisicas`:
  // en demo no hay tracking real, así que no se implican metros/sprints medidos.
  const m = player.metrics;
  const seed = ([...player.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) || 7) % 97;
  const eventos = {
    pasesCompletados: 28 + Math.round(m.technique * 0.45),
    pasesFallados: 6 + Math.round((100 - m.technique) * 0.14),
    precisionPases: Math.min(95, 62 + Math.round(m.technique * 0.28)),
    recuperaciones: 3 + Math.round(m.defending * 0.09),
    // Sin duelos de ejemplo (P1 bloque 6): bloqueados también en el demo.
    disparosAlArco: Math.max(0, Math.round(m.shooting * 0.03)),
    disparosFuera: Math.max(1, Math.round((100 - m.shooting) * 0.02)),
  };
  const zone = posZone(player.position);
  // Nube de ~32 puntos determinista (sin Math.random → estable entre recargas).
  const heatmapPositions = Array.from({ length: 32 }, (_, i) => {
    const a = (seed + i * 41) * 0.13;
    return {
      fx: +Math.min(104, Math.max(1, zone.x + Math.sin(a) * zone.sx + ((i * 7) % 11) - 5)).toFixed(1),
      fy: +Math.min(67, Math.max(1, zone.y + Math.cos(a * 1.3) * zone.sy + ((i * 5) % 9) - 4)).toFixed(1),
    };
  });
  const metricasCuantitativas = { eventos, fuente: "gemini_only" as const, confianza: 0.6, heatmapPositions };

  const row: AnalysisDbRow = {
    id: `demo-analysis-${player.id}`,
    player_id: player.id,
    video_id: `demo-video-${player.id}`,
    created_at: "2026-09-01T10:00:00.000Z",
    vsi: { vsi, tierLabel: tierLabelFor(vsi), confidence: 0.78, history: [Math.max(0, Math.round(vsi - 6)), Math.round(vsi)] },
    metricasCuantitativas,
    reports: [
      {
        report_type: "player-report",
        content: {
          executive_summary: pickLocale(locale, {
            es: `${first} (${pos}, ${player.age} años) presenta un VSI de ficha de ${Math.round(vsi)}. ` +
              `Destaca en ${join(strengths.map((s) => s.title.toLowerCase()))}, con recorrido en ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            en: `${first} (${pos}, age ${player.age}) has a profile VSI of ${Math.round(vsi)}. ` +
              `Stands out in ${join(strengths.map((s) => s.title.toLowerCase()))}, with room to grow in ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            it: `${first} (${pos}, ${player.age} anni) presenta un VSI di scheda di ${Math.round(vsi)}. ` +
              `Spicca in ${join(strengths.map((s) => s.title.toLowerCase()))}, con margine di crescita in ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            de: `${first} (${pos}, ${player.age} Jahre) weist einen Profil-VSI von ${Math.round(vsi)} auf. ` +
              `Sticht in ${join(strengths.map((s) => s.title.toLowerCase()))} hervor, mit Entwicklungsspielraum in ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            fr: `${first} (${pos}, ${player.age} ans) présente un VSI de fiche de ${Math.round(vsi)}. ` +
              `Se distingue en ${join(strengths.map((s) => s.title.toLowerCase()))}, avec une marge de progression en ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            nl: `${first} (${pos}, ${player.age} jaar) heeft een profiel-VSI van ${Math.round(vsi)}. ` +
              `Valt op in ${join(strengths.map((s) => s.title.toLowerCase()))}, met groeiruimte in ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
            "es-419": `${first} (${pos}, ${player.age} años) presenta un VSI de ficha de ${Math.round(vsi)}. ` +
              `Destaca en ${join(strengths.map((s) => s.title.toLowerCase()))}, con recorrido en ${join(areas.map((a) => a.title.toLowerCase()))}. ${matBlurb}`,
          }),
          tier_label: tierLabelFor(vsi),
          strengths,
          areas_to_improve: areas,
        },
      },
      {
        report_type: "dna-profile",
        content: {
          primary_style: pickLocale(locale, {
            es: `${pos} con perfil ${ranked[0].label.toLowerCase()}`,
            en: `${pos} with a ${ranked[0].label.toLowerCase()} profile`,
            it: `${pos} con profilo ${ranked[0].label.toLowerCase()}`,
            de: `${pos} mit ${ranked[0].label.toLowerCase()}-Profil`,
            fr: `${pos} au profil ${ranked[0].label.toLowerCase()}`,
            nl: `${pos} met ${ranked[0].label.toLowerCase()}-profiel`,
            "es-419": `${pos} con perfil ${ranked[0].label.toLowerCase()}`,
          }),
          style_summary: pickLocale(locale, {
            es: `Juego apoyado en ${ranked[0].label.toLowerCase()} y ${ranked[1].label.toLowerCase()}. ` +
              `Toma de decisiones acorde a su ${posLow}.`,
            en: `Game built on ${ranked[0].label.toLowerCase()} and ${ranked[1].label.toLowerCase()}. ` +
              `Decision-making in line with their ${posLow} role.`,
            it: `Gioco basato su ${ranked[0].label.toLowerCase()} e ${ranked[1].label.toLowerCase()}. ` +
              `Presa di decisioni coerente con il suo ruolo di ${posLow}.`,
            de: `Spiel gestützt auf ${ranked[0].label.toLowerCase()} und ${ranked[1].label.toLowerCase()}. ` +
              `Entscheidungsfindung passend zu seiner Rolle als ${posLow}.`,
            fr: `Jeu appuyé sur ${ranked[0].label.toLowerCase()} et ${ranked[1].label.toLowerCase()}. ` +
              `Prise de décision en accord avec son rôle de ${posLow}.`,
            nl: `Spel gebaseerd op ${ranked[0].label.toLowerCase()} en ${ranked[1].label.toLowerCase()}. ` +
              `Besluitvorming in lijn met zijn rol als ${posLow}.`,
            "es-419": `Juego apoyado en ${ranked[0].label.toLowerCase()} y ${ranked[1].label.toLowerCase()}. ` +
              `Toma de decisiones acorde a su ${posLow}.`,
          }),
          natural_role: player.position,
          pressure_behavior: vsi >= 65
            ? pickLocale(locale, {
                es: "Competitivo bajo presión; mantiene criterio en zonas de decisión.",
                en: "Competitive under pressure; keeps good judgement in decision zones.",
                it: "Competitivo sotto pressione; mantiene lucidità nelle zone di decisione.",
                de: "Wettbewerbsstark unter Druck; behält die Übersicht in Entscheidungszonen.",
                fr: "Compétitif sous pression ; garde son discernement dans les zones de décision.",
                nl: "Competitief onder druk; behoudt het overzicht in beslissingszones.",
                "es-419": "Competitivo bajo presión; mantiene criterio en zonas de decisión.",
              })
            : pickLocale(locale, {
                es: "En desarrollo bajo presión; mejora con repetición de contextos exigentes.",
                en: "Developing under pressure; improves with repeated demanding contexts.",
                it: "In sviluppo sotto pressione; migliora con la ripetizione di contesti impegnativi.",
                de: "In Entwicklung unter Druck; verbessert sich durch Wiederholung anspruchsvoller Situationen.",
                fr: "En développement sous pression ; progresse avec la répétition de contextes exigeants.",
                nl: "In ontwikkeling onder druk; verbetert door herhaling van veeleisende situaties.",
                "es-419": "En desarrollo bajo presión; mejora con repetición de contextos exigentes.",
              }),
        },
      },
      {
        report_type: "best-match",
        content: {
          nombre: pro.nombre,
          posicion: pro.posicion,
          club: pro.club,
          score: Math.max(55, Math.min(88, Math.round(vsi + 8))),
          narrativa: pickLocale(locale, {
            es: `Comparable de ejemplo por familia de posición (${pro.posicion}). Referencia orientativa, no una equivalencia de nivel.`,
            en: `Example comparable by position family (${pro.posicion}). Indicative reference, not a level equivalence.`,
            it: `Confronto di esempio per famiglia di posizione (${pro.posicion}). Riferimento orientativo, non un'equivalenza di livello.`,
            de: `Beispielhafter Vergleich nach Positionsfamilie (${pro.posicion}). Orientierende Referenz, keine Niveaugleichsetzung.`,
            fr: `Comparable d'exemple par famille de poste (${pro.posicion}). Référence indicative, pas une équivalence de niveau.`,
            nl: `Voorbeeldvergelijking per positiefamilie (${pro.posicion}). Indicatieve referentie, geen niveaugelijkstelling.`,
            "es-419": `Comparable de ejemplo por familia de posición (${pro.posicion}). Referencia orientativa, no una equivalencia de nivel.`,
          }),
        },
      },
      {
        report_type: "projection",
        content: {
          optimistic: {
            description: pickLocale(locale, {
              es: `Con progresión sostenida, ${first} podría proyectarse por encima de su nivel actual.`,
              en: `With sustained progression, ${first} could project above their current level.`,
              it: `Con una progressione costante, ${first} potrebbe proiettarsi al di sopra del suo livello attuale.`,
              de: `Bei anhaltender Progression könnte sich ${first} über sein aktuelles Niveau hinaus entwickeln.`,
              fr: `Avec une progression soutenue, ${first} pourrait se projeter au-dessus de son niveau actuel.`,
              nl: `Bij aanhoudende progressie zou ${first} zich boven zijn huidige niveau kunnen ontwikkelen.`,
              "es-419": `Con progresión sostenida, ${first} podría proyectarse por encima de su nivel actual.`,
            }),
            level: vsi >= 70
              ? pickLocale(locale, { es: "Semi-pro", en: "Semi-pro", it: "Semi-pro", de: "Semi-pro", fr: "Semi-pro", nl: "Semi-prof", "es-419": "Semi-pro" })
              : pickLocale(locale, { es: "Amateur alto", en: "High amateur", it: "Amateur di alto livello", de: "Gehobener Amateur", fr: "Haut niveau amateur", nl: "Hoog amateurniveau", "es-419": "Amateur alto" }),
          },
          realistic: {
            description: pickLocale(locale, {
              es: `Desarrollo consistente dentro de su categoría manteniendo minutos y carga adecuada.`,
              en: `Consistent development within their age group, keeping suitable playing time and load.`,
              it: `Sviluppo costante all'interno della sua categoria mantenendo minutaggio e carico adeguati.`,
              de: `Konsequente Entwicklung innerhalb seiner Altersklasse bei angemessener Spielzeit und Belastung.`,
              fr: `Développement régulier au sein de sa catégorie en conservant temps de jeu et charge adaptés.`,
              nl: `Consistente ontwikkeling binnen zijn leeftijdscategorie met passende speelminuten en belasting.`,
              "es-419": `Desarrollo consistente dentro de su categoría manteniendo minutos y carga adecuada.`,
            }),
            level: vsi >= 60
              ? pickLocale(locale, { es: "Amateur alto", en: "High amateur", it: "Amateur di alto livello", de: "Gehobener Amateur", fr: "Haut niveau amateur", nl: "Hoog amateurniveau", "es-419": "Amateur alto" })
              : pickLocale(locale, { es: "Amateur", en: "Amateur", it: "Amateur", de: "Amateur", fr: "Amateur", nl: "Amateur", "es-419": "Amateur" }),
          },
          key_factors: pickLocale(locale, {
            es: [strengths[0].title, "Continuidad de minutos", "Acompañamiento de la maduración"],
            en: [strengths[0].title, "Consistent playing time", "Maturation monitoring"],
            it: [strengths[0].title, "Continuità di minutaggio", "Accompagnamento della maturazione"],
            de: [strengths[0].title, "Kontinuierliche Spielzeit", "Begleitung der Reifung"],
            fr: [strengths[0].title, "Continuité de temps de jeu", "Accompagnement de la maturation"],
            nl: [strengths[0].title, "Continuïteit van speelminuten", "Begeleiding van de rijping"],
            "es-419": [strengths[0].title, "Continuidad de minutos", "Acompañamiento de la maduración"],
          }),
          risks: pickLocale(locale, {
            es: ["Sobrecarga en ventana de crecimiento", areas[0].title],
            en: ["Overload during the growth window", areas[0].title],
            it: ["Sovraccarico nella finestra di crescita", areas[0].title],
            de: ["Überlastung im Wachstumsfenster", areas[0].title],
            fr: ["Surcharge pendant la fenêtre de croissance", areas[0].title],
            nl: ["Overbelasting tijdens het groeivenster", areas[0].title],
            "es-419": ["Sobrecarga en ventana de crecimiento", areas[0].title],
          }),
        },
      },
      {
        report_type: "development-plan",
        content: {
          goal_6months: pickLocale(locale, {
            es: `Consolidar ${s0} y reducir la brecha en ${a0}.`,
            en: `Consolidate ${s0} and close the gap in ${a0}.`,
            it: `Consolidare ${s0} e ridurre il divario in ${a0}.`,
            de: `${s0} festigen und den Rückstand in ${a0} verringern.`,
            fr: `Consolider ${s0} et réduire l'écart en ${a0}.`,
            nl: `${s0} consolideren en de achterstand in ${a0} verkleinen.`,
            "es-419": `Consolidar ${s0} y reducir la brecha en ${a0}.`,
          }),
          goal_18months: pickLocale(locale, {
            es: `Transición a un rol de mayor responsabilidad como ${posLow}.`,
            en: `Transition to a higher-responsibility role as ${posLow}.`,
            it: `Transizione verso un ruolo di maggiore responsabilità come ${posLow}.`,
            de: `Übergang zu einer verantwortungsvolleren Rolle als ${posLow}.`,
            fr: `Transition vers un rôle à plus grande responsabilité comme ${posLow}.`,
            nl: `Overgang naar een rol met meer verantwoordelijkheid als ${posLow}.`,
            "es-419": `Transición a un rol de mayor responsabilidad como ${posLow}.`,
          }),
          pillars: [
            {
              pilar: areas[0].title,
              acciones: pickLocale(locale, {
                es: ["Bloques específicos 2×/semana", "Vídeo-feedback quincenal"],
                en: ["Targeted blocks 2×/week", "Fortnightly video feedback"],
                it: ["Blocchi specifici 2×/settimana", "Video-feedback quindicinale"],
                de: ["Gezielte Blöcke 2×/Woche", "Zweiwöchentliches Video-Feedback"],
                fr: ["Blocs spécifiques 2×/semaine", "Retour vidéo bimensuel"],
                nl: ["Gerichte blokken 2×/week", "Tweewekelijkse videofeedback"],
                "es-419": ["Bloques específicos 2×/semana", "Video-feedback quincenal"],
              }),
              prioridad: "alta",
            },
            {
              pilar: strengths[0].title,
              acciones: pickLocale(locale, {
                es: ["Mantener con retos de dificultad creciente"],
                en: ["Maintain with progressively harder challenges"],
                it: ["Mantenere con sfide di difficoltà crescente"],
                de: ["Mit zunehmend schwierigeren Herausforderungen halten"],
                fr: ["Maintenir avec des défis de difficulté croissante"],
                nl: ["Behouden met steeds moeilijkere uitdagingen"],
                "es-419": ["Mantener con retos de dificultad creciente"],
              }),
              prioridad: "media",
            },
          ],
        },
      },
      {
        report_type: "lab-biomechanics",
        content: {
          title: pickLocale(locale, { es: "Biomecánica de laboratorio", en: "Lab biomechanics" }),
          summary: pickLocale(locale, {
            es: `Perfil biomecánico de ejemplo para ${first}. En la demo no hay captura de vídeo real: las cifras son ilustrativas y quedan sin validar por calibración.`,
            en: `Example biomechanical profile for ${first}. The demo has no real video capture: figures are illustrative and uncalibrated.`,
          }),
          metrics_table: [
            { metric: pickLocale(locale, { es: "Zancada", en: "Stride" }), value: `${(1.55 + m.speed * 0.006).toFixed(2)} m`, interpretation: pickLocale(locale, { es: "Estimado por IA", en: "AI-estimated" }) },
            { metric: pickLocale(locale, { es: "Cadencia", en: "Cadence" }), value: `${170 + Math.round(m.stamina * 0.2)} ppm`, interpretation: pickLocale(locale, { es: "Estimado por IA", en: "AI-estimated" }) },
            { metric: pickLocale(locale, { es: "Simetría", en: "Symmetry" }), value: `${88 + (seed % 8)} %`, interpretation: pickLocale(locale, { es: "Ejemplo", en: "Example" }) },
          ],
          next_focus: pickLocale(locale, { es: "Confirmar con captura de vídeo real en VITAS.LAB.", en: "Confirm with real video capture in VITAS.LAB." }),
        },
      },
      {
        report_type: "valuation-report",
        content: {
          // P1 bloque 5d: coherente con la valoración de ejemplo FIJA (demoHealth); antes el
          // tramo salía del VSI y el «techo» de tramo(VSI + 8), una proyección sin base.
          evaluacionGeneral: pickLocale(locale, {
            es: `${first}: valoración de EJEMPLO (demo): el tramo es fijo y no hay datos de mercado.`,
            en: `${first}: EXAMPLE valuation (demo): the band is fixed and there is no market data.`,
          }),
          tierAnalisis: matBlurb,
          comparablesProfesionales: [{ nombre: pro.nombre, equipo: pro.club, razon: pickLocale(locale, { es: "Perfil de rol similar", en: "Similar role profile" }) }],
          factoresClave: [
            { factor: strengths[0].title, impacto: "positivo", explicacion: pickLocale(locale, { es: "Fortaleza diferencial", en: "Standout strength" }) },
            { factor: areas[0].title, impacto: "neutro", explicacion: pickLocale(locale, { es: "Margen de mejora", en: "Room to grow" }) },
          ],
          proyeccion: {
            cortoPlaz: pickLocale(locale, { es: "No se proyecta: sin base validada.", en: "Not projected: no validated basis." }),
            medioPlaz: pickLocale(locale, { es: "No se proyecta: sin base validada.", en: "Not projected: no validated basis." }),
            techoEstimado: pickLocale(locale, { es: "No se estima.", en: "Not estimated." }),
          },
          recomendacionesDesarrollo: [strengths[0].title, areas[0].title],
          riesgosValoracion: [pickLocale(locale, { es: "Datos de ejemplo — no usar para decisiones reales.", en: "Example data — do not use for real decisions." })],
        },
      },
      {
        report_type: "injury-risk-report",
        content: {
          evaluacionGeneral: pickLocale(locale, {
            es: `Riesgo de lesión de ejemplo para ${first}, orientativo: en la demo no hay historial de carga ni de lesiones reales.`,
            en: `Example injury risk for ${first}, indicative only: the demo has no real load or injury history.`,
          }),
          nivelRiesgo: player.age <= 14 ? "moderado" : "bajo",
          factoresRiesgo: [
            { factor: pickLocale(locale, { es: "Ventana de maduración (PHV)", en: "Maturation window (PHV)" }), severidad: player.age <= 14 ? "media" : "baja", descripcion: matBlurb },
            { factor: pickLocale(locale, { es: "Carga acumulada", en: "Accumulated load" }), severidad: "baja", descripcion: pickLocale(locale, { es: "Sin datos reales en la demo.", en: "No real data in the demo." }) },
          ],
          recomendacionesCarga: [
            pickLocale(locale, { es: "Priorizar coordinación sobre fuerza máxima durante el estirón.", en: "Prioritise coordination over max strength during the growth spurt." }),
            pickLocale(locale, { es: "Monitorizar molestias en rodilla/talón (Osgood-Schlatter / Sever).", en: "Monitor knee/heel discomfort (Osgood-Schlatter / Sever)." }),
          ],
          alertaPHV: player.age <= 15 ? pickLocale(locale, { es: "En ventana de crecimiento: vigilar tendones y cartílagos de crecimiento.", en: "In growth window: watch tendons and growth plates." }) : null,
          protocoloPrevencion: [pickLocale(locale, { es: "Movilidad + fuerza excéntrica ligera 2×/semana.", en: "Mobility + light eccentric strength 2×/week." })],
          seguimiento: pickLocale(locale, { es: "Reevaluar tras registrar sesiones reales de tracking.", en: "Re-evaluate after logging real tracking sessions." }),
        },
      },
      {
        report_type: "fatigue-report",
        content: {
          resumenEjecutivo: pickLocale(locale, {
            es: `Estado de fatiga de ejemplo para ${first}. Sin señales reales de carga: valores orientativos bajo el banner de demostración.`,
            en: `Example fatigue state for ${first}. No real load signals: indicative values under the demo banner.`,
          }),
          estadoActual: {
            indice: 30 + (seed % 25),
            severidad: pickLocale(locale, { es: "Baja", en: "Low" }),
            indicadores: [pickLocale(locale, { es: "Percepción de esfuerzo estable", en: "Stable perceived exertion" })],
          },
          cargaACWR: {
            valor: null,
            zona: pickLocale(locale, { es: "Sin datos", en: "No data" }),
            tendencia: pickLocale(locale, { es: "Sin serie de carga en la demo", en: "No load series in the demo" }),
            recomendacionProximaSesion: pickLocale(locale, { es: "Registrar sesiones para calcular ACWR real.", en: "Log sessions to compute a real ACWR." }),
          },
          ajustesPHV: {
            banda: matBlurb,
            recomendaciones: [pickLocale(locale, { es: "Gestionar volumen en fases de mayor velocidad de crecimiento.", en: "Manage volume during peak growth-velocity phases." })],
          },
          protocoloRecuperacion: {
            plan48h: [pickLocale(locale, { es: "Sueño 9 h + hidratación + movilidad suave.", en: "9h sleep + hydration + gentle mobility." })],
            indicadoresRetorno: [pickLocale(locale, { es: "Ausencia de molestias + percepción de frescura", en: "No discomfort + feeling fresh" })],
          },
        },
      },
    ],
  };

  // Segundo análisis (anterior) para poblar Evolución/Histórico (necesitan ≥2) y el
  // delta de tendencia. Mismo perfil, fecha anterior y VSI algo menor → progresión.
  const earlierVsi = Math.max(30, Math.round(vsi - 4));
  const earlier: AnalysisDbRow = {
    ...row,
    id: `demo-analysis-${player.id}-prev`,
    video_id: `demo-video-${player.id}-prev`,
    created_at: "2026-06-02T10:00:00.000Z",
    vsi: { vsi: earlierVsi, tierLabel: tierLabelFor(earlierVsi), confidence: 0.72, history: [Math.max(0, earlierVsi - 5), earlierVsi] },
  };

  return [row, earlier];
}
