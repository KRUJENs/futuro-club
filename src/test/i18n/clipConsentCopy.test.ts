/**
 * i18n · copy del gate de consentimiento de clips (decisión del owner, 30 sep) en los 7
 * idiomas: namespace `clipConsent` y el texto de la declaración (el del job de partido
 * completo).
 *
 * P1 bloque 3: /admin/consent ya NO anota nada a mano (antes «Autorizar» ponía un rótulo que el
 * gate no contaba, y avisaba de que esa anotación «NO desbloquea»): ahora pide la firma al tutor
 * por correo de verdad y el estado sale del servidor. Los textos de ese formulario se retiraron;
 * el del nuevo flujo (guardianConsent) dice que el TUTOR confirma desde el enlace.
 */
import { describe, it, expect } from "vitest";
import es from "@/i18n/es.json";
import es419 from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import itJson from "@/i18n/it.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import nl from "@/i18n/nl.json";

type Dict = Record<string, unknown>;
const LOCALES: Record<string, Dict> = { es, "es-419": es419, en, it: itJson, fr, de, nl };
const CLIP_KEYS = ["blockedTitle", "uploadNeedsAttestation", "analysisNeedsAttestation", "minorNote", "liveVideoOmittedTitle"] as const;

const get = (d: Dict, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Dict | undefined)?.[k], d);

describe("clipConsent · 7 idiomas", () => {
  it.each(Object.entries(LOCALES))("%s: claves presentes y no vacías", (_loc, dict) => {
    for (const k of CLIP_KEYS) {
      const v = get(dict, `clipConsent.${k}`);
      expect(typeof v).toBe("string");
      expect((v as string).trim().length).toBeGreaterThan(3);
    }
    // El texto versionado de la declaración existe (lo reutiliza la UI de clips).
    expect(typeof get(dict, "matchJob.attestation.text_2026_09_28_v1")).toBe("string");
  });

  it("no hay copia sin traducir: en/it/fr/de/nl difieren del español", () => {
    for (const loc of ["en", "it", "fr", "de", "nl"]) {
      for (const k of CLIP_KEYS) {
        expect(get(LOCALES[loc], `clipConsent.${k}`)).not.toBe(get(es, `clipConsent.${k}`));
      }
    }
  });

  it("P1 bloque 3: sin textos de anotación manual; el nuevo flujo dice que confirma el TUTOR (7 idiomas)", () => {
    for (const [, dict] of Object.entries(LOCALES)) {
      expect(get(dict, "parentalConsentPage.form.clipGateNotice")).toBeUndefined();
      expect(get(dict, "parentalConsentPage.form.authorizeAI")).toBeUndefined();
      expect(typeof get(dict, "guardianConsent.form.explainer")).toBe("string");
      expect(typeof get(dict, "verifyConsentPage.confirm")).toBe("string");
    }
    expect(get(es, "guardianConsent.form.explainer")).toMatch(/enlace/);
    expect(get(es, "guardianConsent.form.explainer")).toMatch(/DNI/);
  });
});
