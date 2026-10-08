/**
 * VITAS · Match job — guarda de identidad (claves + TEXTO)
 *
 * identidad.md / CLAUDE.md inv #6: este camino es SOLO a nivel de equipo. Ningún
 * dorsal, nombre ni atribución por jugador en la observación ni en el informe.
 *   1. Claves: quita del JSON crudo del modelo cualquier clave de INDIVIDUAL_LEVEL_KEYS
 *      (contrato) y la cuenta. El objeto de evidencia que la llevaba se DESCARTA entero.
 *   2. Texto: `mentionsIndividual` (patrones de dorsal/número del contrato) + nombres
 *      de las notas del entrenador y de la plantilla del tenant. Un texto que casa se
 *      descarta (ítem o claim) y se cuenta. Sobre-filtrar es la dirección segura
 *      (identidad.md: abstenerse más, nunca atribuir).
 * Nunca cara. Puro, sin red.
 */
import { INDIVIDUAL_LEVEL_KEYS, mentionsIndividual } from "../../../src/lib/shared/matchJob/contract";

/** minúsculas + sin diacríticos (NFD) — comparación estable entre idiomas. */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

const INDIVIDUAL_KEY_SET = new Set(INDIVIDUAL_LEVEL_KEYS.map((k) => normalizeText(k)));

export interface KeyStripResult {
  value: unknown;
  stripped: number;
  strippedPaths: string[];
}

/** Quita recursivamente las claves de nivel individual. No muta la entrada. */
export function stripIndividualKeys(input: unknown, path = "$"): KeyStripResult {
  if (Array.isArray(input)) {
    let stripped = 0;
    const strippedPaths: string[] = [];
    const value = input.map((item, i) => {
      const r = stripIndividualKeys(item, `${path}[${i}]`);
      stripped += r.stripped;
      strippedPaths.push(...r.strippedPaths);
      return r.value;
    });
    return { value, stripped, strippedPaths };
  }
  if (input && typeof input === "object") {
    let stripped = 0;
    const strippedPaths: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (INDIVIDUAL_KEY_SET.has(normalizeText(k))) {
        stripped++;
        strippedPaths.push(`${path}.${k}`);
        continue;
      }
      const r = stripIndividualKeys(v, `${path}.${k}`);
      stripped += r.stripped;
      strippedPaths.push(...r.strippedPaths);
      out[k] = r.value;
    }
    return { value: out, stripped, strippedPaths };
  }
  return { value: input, stripped: 0, strippedPaths: [] };
}

// ── Nombres ──────────────────────────────────────────────────────────────────

/**
 * Palabras que NO se tratan como nombre aunque aparezcan en mayúscula: colores
 * (las camisetas se declaran por color y hay apellidos que son colores: Blanco,
 * Rojo…), rol de equipo y vocabulario de fútbol frecuente. Lista cerrada, 6 idiomas.
 */
const NOT_A_NAME = new Set(
  [
    // colores
    "blanco", "blanca", "negro", "negra", "rojo", "roja", "azul", "verde", "amarillo", "amarilla", "naranja",
    "morado", "morada", "violeta", "rosa", "gris", "granate", "celeste", "marino", "burdeos", "dorado", "plateado",
    "white", "black", "red", "blue", "green", "yellow", "orange", "purple", "pink", "grey", "gray", "maroon", "navy",
    "sky", "gold", "silver", "claret", "bianco", "bianca", "nero", "nera", "rosso", "rossa", "azzurro", "blu",
    "giallo", "gialla", "arancione", "viola", "grigio", "granata", "blanc", "blanche", "noir", "noire", "rouge",
    "bleu", "bleue", "vert", "verte", "jaune", "violet", "gris", "bordeaux", "weiss", "weiß", "schwarz", "rot",
    "blau", "grun", "grün", "gelb", "lila", "grau", "wit", "zwart", "rood", "blauw", "groen", "geel", "oranje",
    "paars", "roze", "grijs", "claro", "oscuro", "light", "dark",
    // rol de equipo y fútbol
    "local", "visitante", "home", "away", "rival", "equipo", "team", "squadra", "equipe", "équipe", "mannschaft",
    "ploeg", "portero", "goalkeeper", "keeper", "defensa", "delantero", "lateral", "extremo", "pivote", "mediocentro",
    "banda", "area", "área", "campo", "porteria", "portería", "balon", "balón", "presion", "presión", "bloque",
    "primera", "segunda", "parte", "tiempo", "partido", "match", "partita", "spiel", "wedstrijd", "entrenador",
    "coach", "juvenil", "cadete", "infantil", "alevin", "alevín", "senior", "sub",
  ].map(normalizeText),
);

const NAME_TOKEN_RE = /^\p{Lu}[\p{L}'’-]{2,}$/u;
const SENTENCE_SPLIT_RE = /[.!?;:\n\r]+/u;
const TOKEN_SPLIT_RE = /[\s,()[\]{}"'«»“”¡¿/]+/u;

function tokens(sentence: string): string[] {
  return sentence.split(TOKEN_SPLIT_RE).filter(Boolean);
}

/**
 * Candidatos a nombre propio en las notas del entrenador: palabras en mayúscula que NO
 * abren la frase (una palabra inicial siempre va en mayúscula) y no están en NOT_A_NAME.
 * Excepción: la palabra inicial SÍ cuenta si la sigue otro candidato ("Pablo Ruiz juega…"
 * → "Pablo Ruiz", "Pablo", "Ruiz"): sobre-filtrar es la dirección segura.
 * Devuelve tokens sueltos y frases de ≥2 tokens consecutivos ("Pablo Ruiz").
 */
export function extractNamesFromNotes(notes: string | null | undefined): string[] {
  if (!notes) return [];
  const out = new Set<string>();
  const looksLikeName = (t: string | undefined) => !!t && NAME_TOKEN_RE.test(t) && !NOT_A_NAME.has(normalizeText(t));
  for (const sentence of notes.split(SENTENCE_SPLIT_RE)) {
    const toks = tokens(sentence);
    let run: string[] = [];
    const flush = () => {
      if (run.length >= 2) out.add(run.join(" "));
      run = [];
    };
    toks.forEach((t, i) => {
      const isCandidate = looksLikeName(t) && (i > 0 || looksLikeName(toks[1]));
      if (isCandidate) {
        out.add(t);
        run.push(t);
      } else {
        flush();
      }
    });
    flush();
  }
  return [...out];
}

export interface NameGuard {
  /** Nombres de ≥2 tokens, normalizados: casan sin distinguir mayúsculas. */
  phrases: string[];
  /** Tokens sueltos normalizados: casan solo si en el texto van en mayúscula (evita "campo" ≠ "Campo"). */
  singles: Set<string>;
}

export const EMPTY_NAME_GUARD: NameGuard = { phrases: [], singles: new Set() };

const REDACTION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cláusula PostgREST `or=(...)` de los jugadores cuyos NOMBRES se quitan del texto
 * del job (plantilla del creador y de su tenant). NO es una regla de acceso: ningún
 * dato de esos jugadores llega al usuario; solo amplía la lista de nombres a
 * descartar (sobre-filtrar es la dirección segura, identidad.md). El acceso a datos
 * de jugadores es SOLO del dueño (api/_lib/ownership.ts, migración 076).
 * Solo interpola valores con forma de UUID (defensa ante inyección en el filtro);
 * sin ninguno válido → UUID nil, que no casa ningún jugador.
 */
export function rosterRedactionFilter(userId: string | null | undefined, tenantId: string | null | undefined): string {
  const clauses: string[] = [];
  if (userId && REDACTION_UUID_RE.test(userId)) clauses.push(`user_id.eq.${userId}`);
  if (tenantId && REDACTION_UUID_RE.test(tenantId)) clauses.push(`tenant_id.eq.${tenantId}`);
  return clauses.length > 0 ? clauses.join(",") : "user_id.eq.00000000-0000-0000-0000-000000000000";
}

/**
 * Lista dinámica de nombres a filtrar: notas del entrenador + plantilla del tenant.
 * `exclude` = palabras que no son nombres de persona en este job (nombres de equipo,
 * etiquetas de color declaradas).
 */
export function buildNameGuard(opts: {
  notes?: string | null;
  rosterNames?: readonly (string | null | undefined)[];
  exclude?: readonly (string | null | undefined)[];
}): NameGuard {
  const excluded = new Set<string>();
  for (const e of opts.exclude ?? []) {
    if (!e) continue;
    for (const t of tokens(e)) excluded.add(normalizeText(t));
  }
  const raw = [...extractNamesFromNotes(opts.notes), ...(opts.rosterNames ?? []).filter((n): n is string => !!n)];
  const phrases = new Set<string>();
  const singles = new Set<string>();
  for (const name of raw) {
    const toks = tokens(name).filter((t) => t.length >= 3);
    const norm = toks.map(normalizeText).filter((t) => !NOT_A_NAME.has(t) && !excluded.has(t));
    if (norm.length === 0) continue;
    if (toks.length >= 2) phrases.add(toks.map(normalizeText).join(" "));
    for (const t of norm) singles.add(t);
  }
  return { phrases: [...phrases], singles };
}

function mentionsName(text: string, guard: NameGuard): boolean {
  if (guard.phrases.length === 0 && guard.singles.size === 0) return false;
  const normText = ` ${tokens(normalizeText(text)).join(" ")} `;
  if (guard.phrases.some((p) => normText.includes(` ${p} `))) return true;
  for (const t of tokens(text)) {
    if (/^\p{Lu}/u.test(t) && guard.singles.has(normalizeText(t.replace(/[’'-]+$/u, "")))) return true;
  }
  return false;
}

/** ¿El texto menciona a un individuo (dorsal/número o nombre)? */
export function textMentionsIndividual(text: string, guard: NameGuard = EMPTY_NAME_GUARD): boolean {
  return mentionsIndividual(text) || mentionsName(text, guard);
}
