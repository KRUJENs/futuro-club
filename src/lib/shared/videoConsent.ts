/**
 * VITAS · Consentimiento para ANALIZAR un clip — regla ÚNICA (invariante #7)
 *
 * Decisión del owner (30 sep 2026, final). Antes de CUALQUIER análisis de un clip
 * (clips cortos y vídeos de equipo; el job de partido completo ya tiene su propia
 * declaración en /api/match/start):
 *   1. SIEMPRE una declaración del entrenador, versionada y guardada con el vídeo
 *      (quién, cuándo, versión). El servidor rechaza el análisis sin ella.
 *   2. ADEMÁS, si el jugador del vídeo es CONOCIDO y menor de 14 años
 *      (players.birth_date presente y edad < 14, misma regla que
 *      is_minor_requiring_consent de la migración 036), hace falta un consentimiento
 *      parental CONCEDIDO. Fuente canónica: public.parental_consents con
 *      email_verified = true AND withdrawn_at IS NULL (predicado del índice
 *      idx_consents_active, migración 003). players.parental_consent_status NO cuenta:
 *      lo pone el propio entrenador desde /admin/consent sin verificación del tutor.
 *   3. Fecha de nacimiento desconocida ⇒ basta la declaración. La edad NUNCA se infiere
 *      de otro campo (ni de `age`, ni de la categoría) ni se rellena con un valor por
 *      defecto.
 *   4. Vídeo de EQUIPO (sin un jugador concreto): basta la declaración; la comprobación
 *      por jugador no aplica (decisión del owner).
 *
 * Este módulo es PURO (sin red, sin Supabase): lo usan los gates del servidor
 * (api/_lib/analysisConsentGate.ts) y la UI. La declaración reutiliza el MISMO texto y
 * versión que el job de partido completo (contract.ts §4): la redacción del owner es
 * idéntica, así que hay una sola versión vigente para las dos rutas. El catálogo de
 * motivos de bloqueo (7 idiomas) vive SOLO aquí: el servidor lo usa para su
 * `gate_reason` y la UI para su mensaje (no hay una segunda copia en src/i18n).
 *
 * Edge-safe: importable desde api/ y src/.
 */

import { z } from "zod";
import {
  MATCH_ATTESTATION_TEXT_ES,
  MATCH_ATTESTATION_VERSION,
  matchAttestationSchema,
} from "./matchJob/contract";
import { normalizeLocale, type ReportLocale } from "./locale";

// ─── Declaración del entrenador ──────────────────────────────────────────────

/** Versión vigente de la declaración (la misma del job de partido completo). */
export const CLIP_ATTESTATION_VERSION = MATCH_ATTESTATION_VERSION;
/** Texto canónico (referencia legal). La UI muestra la traducción de ESTA versión. */
export const CLIP_ATTESTATION_TEXT_ES = MATCH_ATTESTATION_TEXT_ES;
/** `{ accepted: true, version }` estricto: otra versión o `accepted:false` ⇒ no hay declaración. */
export const clipAttestationSchema = matchAttestationSchema;
export type ClipAttestation = z.infer<typeof clipAttestationSchema>;

/** Acción con la que el servidor guarda la declaración en public.gdpr_audit_log. */
export const VIDEO_ANALYSIS_ATTESTED_ACTION = "video_analysis_attested" as const;

/**
 * `resource_type` de la fila de auditoría:
 *   - "videos":    `resource_id` = id de una fila `public.videos` cuya propiedad comprobó
 *                  el servidor. Es la ÚNICA que cuentan las rutas automáticas (webhook de
 *                  Bunny, cola) cuando buscan una declaración guardada.
 *   - "video_ref": el vídeo no es (o no se ha podido ligar a) una fila `videos` propia:
 *                  fichero local, URL o id del cliente. Se guarda como constancia de la
 *                  declaración de ESA petición; nunca desbloquea otra petición.
 */
export const CLIP_ATTESTATION_RESOURCE_TYPES = ["videos", "video_ref"] as const;
export type ClipAttestationResourceType = (typeof CLIP_ATTESTATION_RESOURCE_TYPES)[number];

/** Declaración válida y vigente, o null (ausente, falsa, versión antigua o forma rara). */
export function parseClipAttestation(raw: unknown): ClipAttestation | null {
  const parsed = clipAttestationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Fragmento de body para las peticiones de subida/análisis (null mientras no se marque). */
export function buildClipAttestation(checked: boolean): ClipAttestation | null {
  return checked ? { accepted: true, version: CLIP_ATTESTATION_VERSION } : null;
}

// ─── Edad: espejo EXACTO de is_minor_requiring_consent (migración 036) ───────

/**
 * Años cumplidos bajo los que el tratamiento de datos de un menor exige el
 * consentimiento de su tutor: RGPD art. 8 + LOPDGDD art. 7 (España: 14 años).
 * Es el mismo 14 de la migración 036 (is_minor_requiring_consent). No es un umbral de
 * métrica: es un límite legal y no se ajusta.
 */
export const PARENTAL_CONSENT_AGE_YEARS = 14;

const BIRTH_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/**
 * Años cumplidos a fecha de `now`, igual que `EXTRACT(YEAR FROM AGE(NOW(), birth_date))`
 * en Postgres: años naturales completos, restando uno si (mes, día) de hoy va antes que
 * (mes, día) del nacimiento. Un nacido el 29 de febrero cumple el 1 de marzo en años no
 * bisiestos (AGE toma prestados los 29 días del febrero de nacimiento).
 *
 * `now` se lee en UTC. INFERIDO (no verificado): el NOW() de la base corre en UTC (zona
 * por defecto de Supabase); si no fuera así, la frontera podría diferir unas horas.
 *
 * NO se reutiliza decimalAgeYears (src/lib/shared/age.ts): divide por 365.2425 días y
 * redondea a 2 decimales, así que puede dar 14 la víspera del cumpleaños; además es la
 * ruta del PHV (invariante #4). Tampoco resolveChronologicalAge (cae a la edad guardada,
 * y el owner prohíbe inferir la edad).
 *
 * Devuelve null si `birthDate` no es una fecha de calendario YYYY-MM-DD real.
 */
export function completedYearsAt(birthDate: string, now: Date): number | null {
  const m = BIRTH_DATE_RE.exec(birthDate);
  if (!m) return null;
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const bd = Number(m[3]);
  if (bm < 1 || bm > 12 || bd < 1) return null;
  // Fecha de calendario real (nada de 2014-02-30): Date.UTC normaliza los desbordes.
  const probe = new Date(Date.UTC(by, bm - 1, bd));
  if (probe.getUTCFullYear() !== by || probe.getUTCMonth() !== bm - 1 || probe.getUTCDate() !== bd) return null;
  if (!Number.isFinite(now.getTime())) return null;
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  let years = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) years -= 1;
  return years;
}

/** "unknown" = sin fecha de nacimiento; "invalid" = la base devolvió algo que no es una fecha. */
export type MinorStatus = "minor" | "not_minor" | "unknown" | "invalid";

/**
 * ¿Es un menor que necesita consentimiento parental? Misma regla que 036:
 * birth_date NULL ⇒ desconocido (no se infiere); si no, años cumplidos < 14.
 */
export function minorStatusFromBirthDate(birthDate: string | null | undefined, now: Date = new Date()): MinorStatus {
  if (birthDate === null || birthDate === undefined || birthDate === "") return "unknown";
  const years = completedYearsAt(birthDate, now);
  if (years === null) return "invalid";
  return years < PARENTAL_CONSENT_AGE_YEARS ? "minor" : "not_minor";
}

// ─── La regla ────────────────────────────────────────────────────────────────

export const CLIP_CONSENT_CODES = [
  "attestation_required", //       400 · falta la declaración (o no es la versión vigente)
  "parental_consent_required", //  403 · menor de 14 conocido sin consentimiento parental verificado
  "consent_check_failed", //       500 · no se pudo comprobar/registrar (falla cerrado; nunca 503)
] as const;
export type ClipConsentCode = (typeof CLIP_CONSENT_CODES)[number];

/**
 * HTTP de cada bloqueo. Nunca 503: los clientes de tracking tratan 503 como «inferencia
 * apagada → datos de ejemplo» (videoTrackingService), y un bloqueo de consentimiento no
 * puede convertirse en un fallback silencioso.
 */
export const CLIP_CONSENT_HTTP_STATUS: Readonly<Record<ClipConsentCode, 400 | 403 | 500>> = {
  attestation_required: 400,
  parental_consent_required: 403,
  consent_check_failed: 500,
};

export function isClipConsentCode(v: unknown): v is ClipConsentCode {
  return typeof v === "string" && (CLIP_CONSENT_CODES as readonly string[]).includes(v);
}

/** Jugador del vídeo (null = vídeo de equipo, sin un jugador concreto). */
export interface ClipConsentPlayer {
  /** players.birth_date (YYYY-MM-DD) o null si no consta. */
  birthDate: string | null;
  /**
   * ¿Hay un parental_consents con email_verified = true y withdrawn_at IS NULL?
   * null = no se consultó (solo hace falta si el jugador es menor de 14 conocido).
   */
  parentalConsentGranted: boolean | null;
}

export type ClipConsentDecision =
  | { allowed: true; code: null; gate_reason: null; minor: MinorStatus | null }
  | { allowed: false; code: ClipConsentCode; gate_reason: string; minor: MinorStatus | null };

/**
 * Decide si se puede analizar el clip.
 *   - sin declaración vigente              → attestation_required
 *   - vídeo de equipo (player null)        → permitido (la comprobación por jugador no aplica)
 *   - fecha de nacimiento desconocida      → permitido (basta la declaración)
 *   - fecha que no es una fecha            → consent_check_failed (falla cerrado)
 *   - 14 años o más                        → permitido
 *   - menor de 14 con consentimiento       → permitido
 *   - menor de 14 sin consentimiento (o sin consultar) → parental_consent_required
 */
export function evaluateClipConsent(input: {
  attestation: unknown;
  player: ClipConsentPlayer | null;
  now?: Date;
  locale?: unknown;
}): ClipConsentDecision {
  const locale = normalizeLocale(input.locale);
  if (!parseClipAttestation(input.attestation)) {
    return blocked(locale, "attestation_required", null);
  }
  if (!input.player) return { allowed: true, code: null, gate_reason: null, minor: null };
  const minor = minorStatusFromBirthDate(input.player.birthDate, input.now ?? new Date());
  if (minor === "invalid") return blocked(locale, "consent_check_failed", minor);
  if (minor !== "minor") return { allowed: true, code: null, gate_reason: null, minor };
  if (input.player.parentalConsentGranted === true) {
    return { allowed: true, code: null, gate_reason: null, minor };
  }
  return blocked(locale, "parental_consent_required", minor);
}

function blocked(locale: ReportLocale, code: ClipConsentCode, minor: MinorStatus | null): ClipConsentDecision {
  return { allowed: false, code, gate_reason: clipConsentGateReason(locale, code), minor };
}

// ─── Motivo del bloqueo en el idioma pedido (los 7 idiomas del registro) ─────
// Record COMPLETO por idioma: si se añade un idioma al LANGUAGE_REGISTRY sin su entrada
// aquí, falla el typecheck (no hay fallback silencioso a español en este catálogo).

const GATE_REASONS: Readonly<Record<ReportLocale, Readonly<Record<ClipConsentCode, string>>>> = {
  es: {
    attestation_required:
      "Falta la declaración del entrenador de que tiene el consentimiento y los derechos para analizar este vídeo (versión {version}). Sin ella el vídeo no se analiza.",
    parental_consent_required:
      "Según su fecha de nacimiento, el jugador tiene menos de 14 años y no consta un consentimiento parental verificado (firmado por su tutor y confirmado por email). El vídeo no se analiza hasta que exista.",
    consent_check_failed:
      "No se pudo comprobar la declaración o el consentimiento parental; por seguridad el vídeo no se analiza. Inténtalo de nuevo más tarde.",
  },
  "es-419": {
    attestation_required:
      "Falta la declaración del entrenador de que tiene el consentimiento y los derechos para analizar este video (versión {version}). Sin ella el video no se analiza.",
    parental_consent_required:
      "Según su fecha de nacimiento, el jugador tiene menos de 14 años y no consta un consentimiento parental verificado (firmado por su tutor y confirmado por correo). El video no se analiza hasta que exista.",
    consent_check_failed:
      "No se pudo comprobar la declaración o el consentimiento parental; por seguridad el video no se analiza. Inténtalo de nuevo más tarde.",
  },
  en: {
    attestation_required:
      "The coach's declaration that they have the consent and the rights to analyse this video is missing (version {version}). Without it the video is not analysed.",
    parental_consent_required:
      "According to their date of birth the player is under 14, and there is no verified parental consent (signed by their guardian and confirmed by email). The video is not analysed until it exists.",
    consent_check_failed:
      "The declaration or the parental consent could not be checked; to be safe the video is not analysed. Please try again later.",
  },
  it: {
    attestation_required:
      "Manca la dichiarazione dell'allenatore di avere il consenso e i diritti per analizzare questo video (versione {version}). Senza di essa il video non viene analizzato.",
    parental_consent_required:
      "Secondo la data di nascita il giocatore ha meno di 14 anni e non risulta un consenso dei genitori verificato (firmato dal tutore e confermato via email). Il video non viene analizzato finché non esiste.",
    consent_check_failed:
      "Non è stato possibile verificare la dichiarazione o il consenso dei genitori; per sicurezza il video non viene analizzato. Riprova più tardi.",
  },
  fr: {
    attestation_required:
      "La déclaration de l'entraîneur attestant qu'il dispose du consentement et des droits pour analyser cette vidéo est manquante (version {version}). Sans elle, la vidéo n'est pas analysée.",
    parental_consent_required:
      "D'après sa date de naissance, le joueur a moins de 14 ans et aucun consentement parental vérifié n'existe (signé par son tuteur et confirmé par e-mail). La vidéo n'est pas analysée tant qu'il n'existe pas.",
    consent_check_failed:
      "La déclaration ou le consentement parental n'a pas pu être vérifié ; par sécurité, la vidéo n'est pas analysée. Réessayez plus tard.",
  },
  de: {
    attestation_required:
      "Die Erklärung des Trainers, dass er die Einwilligung und die Rechte zur Analyse dieses Videos hat, fehlt (Version {version}). Ohne sie wird das Video nicht analysiert.",
    parental_consent_required:
      "Laut Geburtsdatum ist der Spieler unter 14 Jahre alt, und es liegt keine verifizierte Einwilligung der Eltern vor (vom Erziehungsberechtigten unterschrieben und per E-Mail bestätigt). Das Video wird erst analysiert, wenn sie vorliegt.",
    consent_check_failed:
      "Die Erklärung oder die Einwilligung der Eltern konnte nicht geprüft werden; sicherheitshalber wird das Video nicht analysiert. Bitte später erneut versuchen.",
  },
  nl: {
    attestation_required:
      "De verklaring van de trainer dat hij de toestemming en de rechten heeft om deze video te analyseren ontbreekt (versie {version}). Zonder die verklaring wordt de video niet geanalyseerd.",
    parental_consent_required:
      "Volgens de geboortedatum is de speler jonger dan 14 en er is geen geverifieerde ouderlijke toestemming (ondertekend door de voogd en per e-mail bevestigd). De video wordt pas geanalyseerd als die er is.",
    consent_check_failed:
      "De verklaring of de ouderlijke toestemming kon niet worden gecontroleerd; voor de zekerheid wordt de video niet geanalyseerd. Probeer het later opnieuw.",
  },
};

/** Motivo del bloqueo en el idioma pedido (normalizado; desconocido ⇒ español). */
export function clipConsentGateReason(locale: unknown, code: ClipConsentCode): string {
  return GATE_REASONS[normalizeLocale(locale)][code].replace("{version}", CLIP_ATTESTATION_VERSION);
}

/** Para tests de paridad: catálogo por idioma. */
export const CLIP_CONSENT_GATE_REASONS_FOR_TEST = GATE_REASONS;

// ─── Motivo de un rechazo al RESOLVER el vídeo / la propiedad (7 idiomas) ────
// Los usa api/_lib/analysisConsentGate.ts cuando no llega a evaluar el consentimiento:
// la referencia del vídeo no vale, el vídeo no existe o no es de quien pide el análisis,
// o un jugador del análisis no es suyo. El código HTTP (`errorDetail.code`) lo pone el
// gate; aquí solo el texto. "forbidden" tiene dos textos (vídeo / jugador) con el MISMO
// código: un jugador ajeno y uno inexistente dan exactamente la misma respuesta.

export const CLIP_RESOLUTION_MESSAGE_KEYS = [
  "video_reference_required",
  "video_id_required",
  "saved_video_required",
  "video_not_found",
  "video_url_mismatch",
  "invalid_video_reference",
  "video_forbidden",
  "player_forbidden",
  "player_scope_requires_player_video",
] as const;
export type ClipResolutionMessageKey = (typeof CLIP_RESOLUTION_MESSAGE_KEYS)[number];

const RESOLUTION_REASONS: Readonly<Record<ReportLocale, Readonly<Record<ClipResolutionMessageKey, string>>>> = {
  es: {
    video_reference_required: "Falta la referencia del vídeo: el análisis debe referirse a un vídeo guardado.",
    video_id_required: "Falta videoId: el análisis debe referirse a un vídeo guardado.",
    saved_video_required: "Las llamadas de usuario deben analizar un vídeo guardado (videoId + videoUrl), no un fichero en el cuerpo de la petición.",
    video_not_found: "Vídeo no encontrado: el análisis debe referirse a un vídeo guardado.",
    video_url_mismatch: "La URL no corresponde a ese vídeo.",
    invalid_video_reference: "La referencia del vídeo no es válida.",
    video_forbidden: "No gestionas este vídeo.",
    player_forbidden: "No gestionas este jugador.",
    player_scope_requires_player_video: "El análisis por jugador solo se hace sobre un vídeo con jugador asignado.",
  },
  "es-419": {
    video_reference_required: "Falta la referencia del video: el análisis debe referirse a un video guardado.",
    video_id_required: "Falta videoId: el análisis debe referirse a un video guardado.",
    saved_video_required: "Las llamadas de usuario deben analizar un video guardado (videoId + videoUrl), no un archivo en el cuerpo de la solicitud.",
    video_not_found: "Video no encontrado: el análisis debe referirse a un video guardado.",
    video_url_mismatch: "La URL no corresponde a ese video.",
    invalid_video_reference: "La referencia del video no es válida.",
    video_forbidden: "No gestionas este video.",
    player_forbidden: "No gestionas este jugador.",
    player_scope_requires_player_video: "El análisis por jugador solo se hace sobre un video con jugador asignado.",
  },
  en: {
    video_reference_required: "The video reference is missing: the analysis must refer to a saved video.",
    video_id_required: "videoId is missing: the analysis must refer to a saved video.",
    saved_video_required: "User requests must analyse a saved video (videoId + videoUrl), not a file in the request body.",
    video_not_found: "Video not found: the analysis must refer to a saved video.",
    video_url_mismatch: "The URL does not belong to that video.",
    invalid_video_reference: "The video reference is not valid.",
    video_forbidden: "You do not manage this video.",
    player_forbidden: "You do not manage this player.",
    player_scope_requires_player_video: "A player analysis is only done on a video with an assigned player.",
  },
  it: {
    video_reference_required: "Manca il riferimento al video: l'analisi deve riferirsi a un video salvato.",
    video_id_required: "Manca videoId: l'analisi deve riferirsi a un video salvato.",
    saved_video_required: "Le richieste degli utenti devono analizzare un video salvato (videoId + videoUrl), non un file nel corpo della richiesta.",
    video_not_found: "Video non trovato: l'analisi deve riferirsi a un video salvato.",
    video_url_mismatch: "L'URL non corrisponde a quel video.",
    invalid_video_reference: "Il riferimento al video non è valido.",
    video_forbidden: "Non gestisci questo video.",
    player_forbidden: "Non gestisci questo giocatore.",
    player_scope_requires_player_video: "L'analisi di un giocatore si fa solo su un video con un giocatore assegnato.",
  },
  fr: {
    video_reference_required: "La référence de la vidéo est manquante : l'analyse doit porter sur une vidéo enregistrée.",
    video_id_required: "videoId est manquant : l'analyse doit porter sur une vidéo enregistrée.",
    saved_video_required: "Les requêtes des utilisateurs doivent analyser une vidéo enregistrée (videoId + videoUrl), pas un fichier dans le corps de la requête.",
    video_not_found: "Vidéo introuvable : l'analyse doit porter sur une vidéo enregistrée.",
    video_url_mismatch: "L'URL ne correspond pas à cette vidéo.",
    invalid_video_reference: "La référence de la vidéo n'est pas valide.",
    video_forbidden: "Vous ne gérez pas cette vidéo.",
    player_forbidden: "Vous ne gérez pas ce joueur.",
    player_scope_requires_player_video: "L'analyse d'un joueur ne se fait que sur une vidéo avec un joueur attribué.",
  },
  de: {
    video_reference_required: "Die Videoreferenz fehlt: Die Analyse muss sich auf ein gespeichertes Video beziehen.",
    video_id_required: "videoId fehlt: Die Analyse muss sich auf ein gespeichertes Video beziehen.",
    saved_video_required: "Anfragen von Nutzern müssen ein gespeichertes Video analysieren (videoId + videoUrl), keine Datei im Anfragetext.",
    video_not_found: "Video nicht gefunden: Die Analyse muss sich auf ein gespeichertes Video beziehen.",
    video_url_mismatch: "Die URL gehört nicht zu diesem Video.",
    invalid_video_reference: "Die Videoreferenz ist ungültig.",
    video_forbidden: "Du verwaltest dieses Video nicht.",
    player_forbidden: "Du verwaltest diesen Spieler nicht.",
    player_scope_requires_player_video: "Eine Spieleranalyse erfolgt nur bei einem Video mit zugewiesenem Spieler.",
  },
  nl: {
    video_reference_required: "De videoverwijzing ontbreekt: de analyse moet naar een opgeslagen video verwijzen.",
    video_id_required: "videoId ontbreekt: de analyse moet naar een opgeslagen video verwijzen.",
    saved_video_required: "Verzoeken van gebruikers moeten een opgeslagen video analyseren (videoId + videoUrl), geen bestand in de body van het verzoek.",
    video_not_found: "Video niet gevonden: de analyse moet naar een opgeslagen video verwijzen.",
    video_url_mismatch: "De URL hoort niet bij die video.",
    invalid_video_reference: "De videoverwijzing is ongeldig.",
    video_forbidden: "Je beheert deze video niet.",
    player_forbidden: "Je beheert deze speler niet.",
    player_scope_requires_player_video: "Een spelersanalyse gebeurt alleen op een video met een toegewezen speler.",
  },
};

/** Motivo de un rechazo al resolver el vídeo / la propiedad, en el idioma pedido (desconocido ⇒ español). */
export function clipResolutionReason(locale: unknown, key: ClipResolutionMessageKey): string {
  return RESOLUTION_REASONS[normalizeLocale(locale)][key];
}

/** Para tests de paridad: catálogo por idioma. */
export const CLIP_RESOLUTION_REASONS_FOR_TEST = RESOLUTION_REASONS;

// ─── Cliente: leer el bloqueo de una respuesta de la API ─────────────────────

/**
 * Código de bloqueo de consentimiento de una respuesta JSON de la API
 * (`errorDetail.code` de errorResponse), o null si la respuesta no es un bloqueo.
 */
export function clipConsentCodeFromResponse(json: unknown): ClipConsentCode | null {
  if (!json || typeof json !== "object") return null;
  const detail = (json as { errorDetail?: { code?: unknown } }).errorDetail;
  return detail && isClipConsentCode(detail.code) ? detail.code : null;
}

/**
 * Error de cliente que transporta un bloqueo de consentimiento con su mensaje ya
 * traducido. Los hooks lo lanzan para que un bloqueo NUNCA caiga en un fallback
 * silencioso (fotogramas, pipeline alternativo, datos de ejemplo).
 */
export class ClipConsentBlockedError extends Error {
  readonly code: ClipConsentCode;
  constructor(code: ClipConsentCode, locale: unknown) {
    super(clipConsentGateReason(locale, code));
    this.name = "ClipConsentBlockedError";
    this.code = code;
  }
}

/** Si `json` es un bloqueo de consentimiento, el error listo para lanzar; si no, null. */
export function clipConsentErrorFromResponse(json: unknown, locale: unknown): ClipConsentBlockedError | null {
  const code = clipConsentCodeFromResponse(json);
  return code ? new ClipConsentBlockedError(code, locale) : null;
}
