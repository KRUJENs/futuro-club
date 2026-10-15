/**
 * VITAS · Respuestas de agente de EJEMPLO para el DEMO (piso piloto)
 *
 * En el demo no hay claves de IA (Anthropic/Gemini) ni sesión → las llamadas a
 * los agentes (`/api/agents/*`) no deben salir a la red (fallarían con 401 y
 * costarían). Este módulo devuelve respuestas DETERMINISTAS de ejemplo, sin
 * red y sin coste, derivadas de los datos que ya trae la petición. `agentService`
 * las usa cuando `IS_DEMO`. La UI las muestra bajo el banner «Datos de ejemplo».
 *
 * MULTI-IDIOMA (sin ternarios es/en): los textos se eligen con `pickLocale` desde
 * mapas por idioma → añadir un idioma = añadir su clave (si falta, cae al idioma
 * por defecto). `agentService` inyecta `locale`; si faltara, se usa i18n.
 *
 * Sólo se rellenan las superficies visibles del demo (scout-insight, role-profile).
 * Para el resto se devuelve un fallo elegante → el consumidor muestra su estado
 * honesto de «no disponible» (sin error ni llamada real).
 */

import type { AgentResponse } from "@/agents/contracts";
import i18n from "@/i18n";
import { normalizeLocale, pickLocale, type ReportLocale } from "@/lib/shared/locale";

const METRIC_LABELS: Partial<Record<ReportLocale, Record<string, string>>> = {
  es: {
    speed: "velocidad", technique: "técnica", vision: "visión de juego",
    stamina: "resistencia", shooting: "definición", defending: "trabajo defensivo",
  },
  en: {
    speed: "speed", technique: "technique", vision: "game vision",
    stamina: "stamina", shooting: "finishing", defending: "defensive work",
  },
  it: {
    speed: "velocità", technique: "tecnica", vision: "visione di gioco",
    stamina: "resistenza", shooting: "finalizzazione", defending: "lavoro difensivo",
  },
  de: {
    speed: "Geschwindigkeit", technique: "Technik", vision: "Spielübersicht",
    stamina: "Ausdauer", shooting: "Torabschluss", defending: "Defensivarbeit",
  },
  fr: {
    speed: "vitesse", technique: "technique", vision: "vision de jeu",
    stamina: "endurance", shooting: "finition", defending: "travail défensif",
  },
  nl: {
    speed: "snelheid", technique: "techniek", vision: "spelinzicht",
    stamina: "uithoudingsvermogen", shooting: "afwerking", defending: "verdedigend werk",
  },
  "es-419": {
    speed: "velocidad", technique: "técnica", vision: "visión de juego",
    stamina: "resistencia", shooting: "definición", defending: "trabajo defensivo",
  },
};

/** Etiqueta de identidad dominante para MOSTRAR (el valor enum no se traduce). */
const IDENTITY_LABELS: Partial<Record<ReportLocale, Record<string, string>>> = {
  es: { ofensivo: "ofensiva", defensivo: "defensiva", tecnico: "técnica", fisico: "física", mixto: "mixta" },
  en: { ofensivo: "attacking", defensivo: "defensive", tecnico: "technical", fisico: "physical", mixto: "mixed" },
  it: { ofensivo: "offensiva", defensivo: "difensiva", tecnico: "tecnica", fisico: "fisica", mixto: "mista" },
  de: { ofensivo: "offensiv", defensivo: "defensiv", tecnico: "technisch", fisico: "physisch", mixto: "gemischt" },
  fr: { ofensivo: "offensive", defensivo: "défensive", tecnico: "technique", fisico: "physique", mixto: "mixte" },
  nl: { ofensivo: "aanvallend", defensivo: "verdedigend", tecnico: "technisch", fisico: "fysiek", mixto: "gemengd" },
  "es-419": { ofensivo: "ofensiva", defensivo: "defensiva", tecnico: "técnica", fisico: "física", mixto: "mixta" },
};

function metricLabels(locale: ReportLocale): Record<string, string> {
  return pickLocale(locale, METRIC_LABELS);
}

function topMetric(
  metrics: Record<string, number> | undefined,
  locale: ReportLocale,
): { key: string; label: string; value: number } {
  const labels = metricLabels(locale);
  const m = metrics ?? {};
  const entries = Object.keys(labels).map((k) => ({ key: k, label: labels[k], value: m[k] ?? 0 }));
  return entries.sort((a, b) => b.value - a.value)[0] ?? { key: "technique", label: labels.technique, value: 60 };
}

function scoutInsight(input: unknown, locale: ReportLocale): Record<string, unknown> {
  const p = (input as { player?: Record<string, unknown> })?.player ?? {};
  const name = (p.name as string) ?? pickLocale(locale, {
    es: "Jugador", en: "Player", it: "Giocatore", de: "Spieler", fr: "Joueur", nl: "Speler", "es-419": "Jugador",
  });
  const first = name.split(" ")[0];
  const metrics = p.recentMetrics as Record<string, number> | undefined;
  const top = topMetric(metrics, locale);
  const headline = pickLocale(locale, {
    es: `${first} destaca en ${top.label}`,
    en: `${first} stands out in ${top.label}`,
    it: `${first} spicca in ${top.label}`,
    de: `${first} sticht in ${top.label} hervor`,
    fr: `${first} se distingue en ${top.label}`,
    nl: `${first} valt op in ${top.label}`,
    "es-419": `${first} destaca en ${top.label}`,
  });
  const body = pickLocale(locale, {
    es: `Rendimiento de ejemplo: ${name} muestra un nivel destacado en ${top.label}. Insight orientativo generado con datos de ejemplo del demo.`,
    en: `Example performance: ${name} shows a strong level in ${top.label}. Indicative insight generated with the demo's example data.`,
    it: `Prestazione di esempio: ${name} mostra un livello notevole in ${top.label}. Insight orientativo generato con i dati di esempio della demo.`,
    de: `Beispiel-Leistung: ${name} zeigt ein starkes Niveau in ${top.label}. Orientierender Insight, erstellt mit den Beispieldaten der Demo.`,
    fr: `Performance d'exemple : ${name} montre un niveau élevé en ${top.label}. Insight indicatif généré à partir des données d'exemple de la démo.`,
    nl: `Voorbeeldprestatie: ${name} toont een sterk niveau in ${top.label}. Indicatief inzicht gegenereerd met de voorbeeldgegevens van de demo.`,
    "es-419": `Rendimiento de ejemplo: ${name} muestra un nivel destacado en ${top.label}. Insight orientativo generado con datos de ejemplo del demo.`,
  });
  return {
    playerId: (p.id as string) ?? "demo",
    type: "general",
    headline: headline.slice(0, 80),
    body: body.slice(0, 400),
    metric: top.label,
    metricValue: `${Math.round(top.value)}`,
    urgency: "low",
    tags: [pickLocale(locale, {
      es: "ejemplo", en: "example", it: "esempio", de: "Beispiel", fr: "exemple", nl: "voorbeeld", "es-419": "ejemplo",
    }), top.key],
    timestamp: "2026-09-01T10:00:00.000Z",
    actionItems: pickLocale(locale, {
      es: ["Dar continuidad de minutos", "Trabajar el punto débil identificado"],
      en: ["Maintain playing time", "Work on the identified weak point"],
      it: ["Dare continuità di minutaggio", "Lavorare sul punto debole individuato"],
      de: ["Für Spielzeit sorgen", "Am identifizierten Schwachpunkt arbeiten"],
      fr: ["Assurer une continuité de temps de jeu", "Travailler le point faible identifié"],
      nl: ["Zorgen voor speelminuten", "Werken aan het geïdentificeerde zwakke punt"],
      "es-419": ["Dar continuidad de minutos", "Trabajar el punto débil identificado"],
    }),
    benchmark: pickLocale(locale, {
      es: "Referencia de ejemplo para su categoría",
      en: "Example benchmark for their age group",
      it: "Riferimento di esempio per la sua categoria",
      de: "Beispiel-Referenz für seine Altersklasse",
      fr: "Référence d'exemple pour sa catégorie",
      nl: "Voorbeeldreferentie voor zijn leeftijdscategorie",
      "es-419": "Referencia de ejemplo para su categoría",
    }),
  };
}

function roleProfile(input: unknown, locale: ReportLocale): Record<string, unknown> {
  const p = (input as { player?: Record<string, unknown> })?.player ?? {};
  const m = (p.metrics as Record<string, number>) ?? {};
  const position = (p.position as string) ?? "Mediocentro";
  const off = ((m.shooting ?? 0) + (m.vision ?? 0)) / 2;
  const def = m.defending ?? 0;
  const tec = m.technique ?? 0;
  const fis = ((m.speed ?? 0) + (m.stamina ?? 0)) / 2;
  const raw = { ofensivo: off, defensivo: def, tecnico: tec, fisico: fis, mixto: (off + def + tec + fis) / 4 };
  const total = Object.values(raw).reduce((s, v) => s + v, 0) || 1;
  const dist = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round((v / total) * 100)]));
  const dominant = (Object.entries(raw).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "mixto") as
    "ofensivo" | "defensivo" | "tecnico" | "fisico" | "mixto";
  const avg = Math.round((off + def + tec + fis) / 4);
  // Sin proyecciones (P1 bloque 5c): tampoco en el demo.
  const cap = (base: number) => ({ current: base });
  const top = topMetric(m, locale);
  const secondary = (p.secondaryPositions as string[]) ?? [];
  const dominantLabel = pickLocale(locale, IDENTITY_LABELS)[dominant] ?? dominant;

  return {
    playerId: (p.id as string) ?? "demo",
    dominantIdentity: dominant,
    identityDistribution: dist,
    topPositions: [
      { code: position.slice(0, 3).toUpperCase(), fit: 85, confidence: 0.72 },
      ...secondary.slice(0, 2).map((s) => ({ code: s.slice(0, 3).toUpperCase(), fit: 70, confidence: 0.6 })),
    ].slice(0, 5),
    topArchetypes: [
      { code: dominant, fit: 82, stability: "en_desarrollo" as const },
    ],
    capabilities: {
      tactical: cap(Math.round((m.vision ?? 55))),
      technical: cap(Math.round(tec || 55)),
      physical: cap(Math.round(fis || 55)),
    },
    strengths: pickLocale(locale, {
      es: [`${top.label} por encima de la media`, "Buena lectura para su edad"],
      en: [`${top.label} above average`, "Good game reading for their age"],
      it: [`${top.label} sopra la media`, "Buona lettura di gioco per la sua età"],
      de: [`${top.label} über dem Durchschnitt`, "Gutes Spielverständnis für sein Alter"],
      fr: [`${top.label} au-dessus de la moyenne`, "Bonne lecture du jeu pour son âge"],
      nl: [`${top.label} boven het gemiddelde`, "Goed spelinzicht voor zijn leeftijd"],
      "es-419": [`${top.label} por encima de la media`, "Buena lectura para su edad"],
    }),
    risks: pickLocale(locale, {
      es: ["Consolidar bajo presión competitiva"],
      en: ["Consolidate under competitive pressure"],
      it: ["Consolidare sotto pressione competitiva"],
      de: ["Unter Wettkampfdruck festigen"],
      fr: ["Consolider sous pression compétitive"],
      nl: ["Consolideren onder competitieve druk"],
      "es-419": ["Consolidar bajo presión competitiva"],
    }),
    gaps: pickLocale(locale, {
      es: ["Datos de vídeo pendientes (demo)"],
      en: ["Video data pending (demo)"],
      it: ["Dati video in sospeso (demo)"],
      de: ["Videodaten ausstehend (Demo)"],
      fr: ["Données vidéo en attente (démo)"],
      nl: ["Videogegevens in afwachting (demo)"],
      "es-419": ["Datos de video pendientes (demo)"],
    }),
    overallConfidence: 0.68,
    summary: pickLocale(locale, {
      es: `Perfil de rol de ejemplo (${position}) con identidad ${dominantLabel}. Nivel base ~${avg}. Datos de ejemplo del demo.`,
      en: `Example role profile (${position}) with ${dominantLabel} identity. Base level ~${avg}. Demo example data.`,
      it: `Profilo di ruolo di esempio (${position}) con identità ${dominantLabel}. Livello base ~${avg}. Dati di esempio della demo.`,
      de: `Beispiel-Rollenprofil (${position}) mit Identität ${dominantLabel}. Basisniveau ~${avg}. Beispieldaten der Demo.`,
      fr: `Profil de rôle d'exemple (${position}) avec identité ${dominantLabel}. Niveau de base ~${avg}. Données d'exemple de la démo.`,
      nl: `Voorbeeld-rolprofiel (${position}) met identiteit ${dominantLabel}. Basisniveau ~${avg}. Voorbeeldgegevens van de demo.`,
      "es-419": `Perfil de rol de ejemplo (${position}) con identidad ${dominantLabel}. Nivel base ~${avg}. Datos de ejemplo del demo.`,
    }).slice(0, 400),
  };
}

/** Respuesta de agente de ejemplo para el demo, sin red. */
export function demoAgentResponse(endpoint: string, input: unknown): AgentResponse<unknown> {
  const locale = normalizeLocale((input as { locale?: unknown })?.locale ?? i18n.language);
  switch (endpoint) {
    case "scout-insight":
      return { success: true, data: scoutInsight(input, locale), agentName: endpoint };
    case "role-profile":
      return { success: true, data: roleProfile(input, locale), agentName: endpoint };
    default:
      // Superficie no cubierta por el demo: fallo elegante (el consumidor muestra
      // su estado honesto de «no disponible», sin llamada real ni error de red).
      return {
        success: false,
        error: pickLocale(locale, {
          es: "No disponible en la demo", en: "Not available in the demo",
          it: "Non disponibile nella demo", de: "In der Demo nicht verfügbar",
          fr: "Non disponible dans la démo", nl: "Niet beschikbaar in de demo",
          "es-419": "No disponible en la demo",
        }),
        agentName: endpoint,
      };
  }
}
