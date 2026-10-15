/**
 * P1 bloque 6, punto 22 — «Índice UBI» / «TruthFilter» retirados de todas las superficies.
 * Antes: /compare pintaba un «Índice UBI» (edad relativa contada como 0 porque nadie
 * pasaba la fecha de nacimiento; pesos 0,55/0,45 sin fuente; rótulos «TALENTO REAL» /
 * «SESGO ALTO» invertidos), y la base de conocimiento del RAG afirmaba correcciones
 * («Q1 −2, Q4 +5», TruthFilter automático) que la app no hace.
 */
import { describe, expect, it } from "vitest";
import comparisonSrc from "@/pages/PlayerComparison.tsx?raw";
import { YOUTH_DEVELOPMENT_DOCS } from "@/data/knowledgeBase/youthDevelopment";
import { PERFORMANCE_BENCHMARKS_DOCS } from "@/data/knowledgeBase/performanceBenchmarks";
import es from "@/i18n/es.json";
import esLatam from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const LOCALES: Record<string, unknown> = { es, "es-419": esLatam, en, fr, de, it: it_, nl };

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("UBI / TruthFilter retirados (P1 bloque 6, punto 22)", () => {
  it("/compare no calcula ni pinta el «Índice UBI»", () => {
    expect(comparisonSrc).not.toMatch(/calculateAdvancedMetrics/);
    expect(comparisonSrc).not.toMatch(/\.ubi\b/);
    expect(comparisonSrc).not.toMatch(/compare\.(ubiIndex|ubiDesc|ubiNoData|realTalent|medBias|highBias)/);
  });

  it("las claves del UBI / TruthFilter no existen en ningún idioma", () => {
    const gone = [
      "compare.ubiIndex", "compare.ubiDesc", "compare.ubiNoData",
      "compare.realTalent", "compare.medBias", "compare.highBias",
      "players.profile.truthFilter", "players.profile.ubiBiasIndex",
      "playerProfile.adjustedVsiTruthFilter", "playerProfile.truthFilterPendingWarning",
      "playerProfile.ubiBiasIndexTitle", "playerProfile.ubiPendingWarning",
    ];
    for (const [locale, json] of Object.entries(LOCALES)) {
      for (const key of gone) expect(get(json, key), `${locale}: ${key}`).toBeUndefined();
    }
  });

  it("la base de conocimiento no atribuye a VITAS correcciones por edad relativa ni el TruthFilter", () => {
    const text = [...YOUTH_DEVELOPMENT_DOCS, ...PERFORMANCE_BENCHMARKS_DOCS].map((d) => d.content).join("\n");
    expect(text).not.toMatch(/TruthFilter/);
    expect(text).not.toMatch(/Unified Bias Index|\bUBI\b/);
    expect(text).not.toMatch(/Q4 recibe \+5|Q1 recibe -2/);
  });
});
