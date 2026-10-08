/**
 * Tests · src/lib/shared/videoConsent — regla ÚNICA (inv #7) del consentimiento para
 * analizar un clip (decisión del owner, 30 sep 2026). La usan los gates del servidor
 * (api/_lib/analysisConsentGate.ts) y la UI.
 */
import { describe, it, expect } from "vitest";
import {
  CLIP_ATTESTATION_VERSION,
  CLIP_ATTESTATION_TEXT_ES,
  CLIP_CONSENT_CODES,
  CLIP_CONSENT_GATE_REASONS_FOR_TEST,
  CLIP_CONSENT_HTTP_STATUS,
  CLIP_RESOLUTION_MESSAGE_KEYS,
  CLIP_RESOLUTION_REASONS_FOR_TEST,
  ClipConsentBlockedError,
  clipResolutionReason,
  PARENTAL_CONSENT_AGE_YEARS,
  buildClipAttestation,
  clipConsentCodeFromResponse,
  clipConsentErrorFromResponse,
  clipConsentGateReason,
  completedYearsAt,
  evaluateClipConsent,
  minorStatusFromBirthDate,
  parseClipAttestation,
} from "@/lib/shared/videoConsent";
import { MATCH_ATTESTATION_TEXT_ES, MATCH_ATTESTATION_VERSION } from "@/lib/shared/matchJob/contract";
import { LANGUAGE_REGISTRY } from "@/lib/shared/locale";

const at = (iso: string) => new Date(iso);
const OK = { accepted: true, version: CLIP_ATTESTATION_VERSION } as const;

describe("declaración versionada", () => {
  it("misma versión y texto que la declaración del partido completo (una sola vigente)", () => {
    expect(CLIP_ATTESTATION_VERSION).toBe(MATCH_ATTESTATION_VERSION);
    expect(CLIP_ATTESTATION_TEXT_ES).toBe(MATCH_ATTESTATION_TEXT_ES);
    expect(CLIP_ATTESTATION_TEXT_ES).toBe("Declaro que tengo el consentimiento y los derechos para analizar este vídeo");
  });

  it("solo { accepted: true, version vigente } cuenta; nunca se fabrica sin marcar", () => {
    expect(parseClipAttestation(OK)).toEqual(OK);
    expect(parseClipAttestation({ accepted: false, version: CLIP_ATTESTATION_VERSION })).toBeNull();
    expect(parseClipAttestation({ accepted: true, version: "2020-01-01.v0" })).toBeNull();
    expect(parseClipAttestation({ ...OK, extra: 1 })).toBeNull(); // strict
    expect(parseClipAttestation(true)).toBeNull();
    expect(buildClipAttestation(false)).toBeNull();
    expect(buildClipAttestation(true)).toEqual(OK);
  });
});

describe("edad: espejo de EXTRACT(YEAR FROM AGE(now, birth_date)) (migración 036)", () => {
  it.each([
    ["2012-09-30", "2026-09-30T00:00:00Z", 14], // cumple hoy
    ["2012-10-01", "2026-09-30T23:59:59Z", 13], // víspera
    ["2012-10-01", "2026-10-01T00:00:00Z", 14],
    ["2012-02-29", "2026-02-28T12:00:00Z", 13], // bisiesto: en año no bisiesto cumple el 1 de marzo
    ["2012-02-29", "2026-03-01T00:00:00Z", 14],
    ["2012-02-29", "2028-02-29T00:00:00Z", 16],
    ["2012-12-31", "2026-12-30T00:00:00Z", 13],
    ["2012-12-31", "2026-12-31T00:00:00Z", 14],
  ])("nacido %s a %s → %i años cumplidos", (birth, now, years) => {
    expect(completedYearsAt(birth, at(now))).toBe(years);
  });

  it("fechas que no son de calendario → null (no se adivina)", () => {
    for (const bad of ["2014-02-30", "2014-13-01", "2014-00-10", "14-01-2014", "2014-1-1", "", "ayer"]) {
      expect(completedYearsAt(bad, at("2026-09-30T00:00:00Z"))).toBeNull();
    }
  });

  it("menor = años cumplidos < 14 (RGPD art. 8 + LOPDGDD art. 7)", () => {
    expect(PARENTAL_CONSENT_AGE_YEARS).toBe(14);
    expect(minorStatusFromBirthDate("2013-05-01", at("2026-09-30T00:00:00Z"))).toBe("minor");
    expect(minorStatusFromBirthDate("2012-09-30", at("2026-09-30T00:00:00Z"))).toBe("not_minor");
    expect(minorStatusFromBirthDate(null)).toBe("unknown");
    expect(minorStatusFromBirthDate(undefined)).toBe("unknown");
    expect(minorStatusFromBirthDate("")).toBe("unknown");
    expect(minorStatusFromBirthDate("2014-02-30")).toBe("invalid");
  });
});

describe("evaluateClipConsent (la regla)", () => {
  const NOW = at("2026-09-30T12:00:00Z");

  it("sin declaración → attestation_required (aunque sea vídeo de equipo)", () => {
    expect(evaluateClipConsent({ attestation: null, player: null, now: NOW })).toMatchObject({ allowed: false, code: "attestation_required" });
  });

  it("vídeo de equipo + declaración → permitido (la comprobación por jugador no aplica)", () => {
    expect(evaluateClipConsent({ attestation: OK, player: null, now: NOW })).toMatchObject({ allowed: true, minor: null });
  });

  it("fecha de nacimiento desconocida → basta la declaración (no se infiere la edad)", () => {
    expect(
      evaluateClipConsent({ attestation: OK, player: { birthDate: null, parentalConsentGranted: null }, now: NOW }),
    ).toMatchObject({ allowed: true, minor: "unknown" });
  });

  it("14 o más → basta la declaración", () => {
    expect(
      evaluateClipConsent({ attestation: OK, player: { birthDate: "2010-01-01", parentalConsentGranted: null }, now: NOW }),
    ).toMatchObject({ allowed: true, minor: "not_minor" });
  });

  it("menor de 14: con consentimiento verificado → permitido; sin él o sin consultar → parental_consent_required", () => {
    const minor = { birthDate: "2014-03-01" };
    expect(evaluateClipConsent({ attestation: OK, player: { ...minor, parentalConsentGranted: true }, now: NOW }).allowed).toBe(true);
    expect(evaluateClipConsent({ attestation: OK, player: { ...minor, parentalConsentGranted: false }, now: NOW })).toMatchObject({
      allowed: false,
      code: "parental_consent_required",
    });
    expect(evaluateClipConsent({ attestation: OK, player: { ...minor, parentalConsentGranted: null }, now: NOW })).toMatchObject({
      allowed: false,
      code: "parental_consent_required",
    });
  });

  it("fecha corrupta → consent_check_failed (falla cerrado)", () => {
    expect(
      evaluateClipConsent({ attestation: OK, player: { birthDate: "2014-02-30", parentalConsentGranted: null }, now: NOW }),
    ).toMatchObject({ allowed: false, code: "consent_check_failed" });
  });

  it("los HTTP de bloqueo nunca son 503 (el tracking lo leería como «inferencia apagada»)", () => {
    expect(CLIP_CONSENT_HTTP_STATUS).toEqual({ attestation_required: 400, parental_consent_required: 403, consent_check_failed: 500 });
  });
});

describe("motivos en los 7 idiomas del registro", () => {
  it("cada idioma del LANGUAGE_REGISTRY tiene los 3 motivos, no vacíos, con la versión", () => {
    const codes = Object.keys(LANGUAGE_REGISTRY);
    expect(codes.sort()).toEqual(Object.keys(CLIP_CONSENT_GATE_REASONS_FOR_TEST).sort());
    expect(codes).toHaveLength(7);
    for (const loc of codes) {
      for (const code of CLIP_CONSENT_CODES) {
        const msg = clipConsentGateReason(loc, code);
        expect(msg.length).toBeGreaterThan(20);
        expect(msg).not.toContain("{version}");
        if (code === "attestation_required") expect(msg).toContain(CLIP_ATTESTATION_VERSION);
      }
    }
  });

  it("los motivos no se repiten entre idiomas distintos del español (no es una copia sin traducir)", () => {
    expect(clipConsentGateReason("en", "parental_consent_required")).not.toBe(clipConsentGateReason("es", "parental_consent_required"));
    expect(clipConsentGateReason("de", "attestation_required")).not.toBe(clipConsentGateReason("fr", "attestation_required"));
  });
});

describe("motivos de RESOLUCIÓN del vídeo / propiedad (B4/B5) en los 7 idiomas", () => {
  it("cada idioma del registro tiene todos los textos, no vacíos", () => {
    const codes = Object.keys(LANGUAGE_REGISTRY);
    expect(codes.sort()).toEqual(Object.keys(CLIP_RESOLUTION_REASONS_FOR_TEST).sort());
    for (const loc of codes) {
      for (const key of CLIP_RESOLUTION_MESSAGE_KEYS) {
        expect(clipResolutionReason(loc, key).trim().length).toBeGreaterThan(10);
      }
    }
  });

  it("no hay copia sin traducir: en/it/fr/de/nl difieren del español en cada texto", () => {
    for (const loc of ["en", "it", "fr", "de", "nl"]) {
      for (const key of CLIP_RESOLUTION_MESSAGE_KEYS) {
        expect(clipResolutionReason(loc, key)).not.toBe(clipResolutionReason("es", key));
      }
    }
  });

  it("idioma desconocido o regional → normalizado (en-US → en; nada → es)", () => {
    expect(clipResolutionReason("en-US", "player_forbidden")).toBe(clipResolutionReason("en", "player_forbidden"));
    expect(clipResolutionReason(undefined, "player_forbidden")).toBe("No gestionas este jugador.");
  });

  it("un jugador ajeno y uno inexistente comparten texto (no se distingue uno de otro)", () => {
    // Solo hay UN texto para «jugador»: el gate no tiene forma de distinguirlos.
    expect(CLIP_RESOLUTION_MESSAGE_KEYS.filter((k) => k.startsWith("player_forbidden"))).toEqual(["player_forbidden"]);
  });
});

describe("cliente: leer el bloqueo de una respuesta de la API", () => {
  it("reconoce solo los códigos de consentimiento de errorDetail.code", () => {
    expect(clipConsentCodeFromResponse({ errorDetail: { code: "parental_consent_required" } })).toBe("parental_consent_required");
    expect(clipConsentCodeFromResponse({ errorDetail: { code: "forbidden" } })).toBeNull();
    expect(clipConsentCodeFromResponse(null)).toBeNull();
    expect(clipConsentCodeFromResponse("x")).toBeNull();
  });

  it("el error lleva el motivo traducido al idioma de la UI", () => {
    const err = clipConsentErrorFromResponse({ errorDetail: { code: "attestation_required" } }, "en");
    expect(err).toBeInstanceOf(ClipConsentBlockedError);
    expect(err!.code).toBe("attestation_required");
    expect(err!.message).toBe(clipConsentGateReason("en", "attestation_required"));
    expect(clipConsentErrorFromResponse({ errorDetail: { code: "other" } }, "en")).toBeNull();
  });
});
