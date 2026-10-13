/**
 * i18n · copy del gate de consentimiento de clips (decisión del owner, 30 sep) en los 7
 * idiomas: namespace `clipConsent`, el aviso de /admin/consent de que su anotación NO
 * desbloquea el análisis de un menor de 14, y que ese formulario ya no promete un correo
 * de confirmación que no se envía (ParentalConsentPage solo actualiza players +
 * consent_audit_log). El texto de la declaración es el del job de partido completo.
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
    expect(typeof get(dict, "parentalConsentPage.form.clipGateNotice")).toBe("string");
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

  it("el formulario de /admin/consent ya no promete un correo que no se envía", () => {
    expect(get(es, "parentalConsentPage.form.emailNotice")).not.toMatch(/Se enviará/);
    expect(get(en, "parentalConsentPage.form.emailNotice")).not.toMatch(/will be sent/);
    expect(get(es, "parentalConsentPage.form.clipGateNotice")).toMatch(/NO desbloquea/);
  });
});
