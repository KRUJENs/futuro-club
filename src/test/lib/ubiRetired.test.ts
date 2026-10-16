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
import { SCOUTING_METHODOLOGY_DOCS } from "@/data/knowledgeBase/scoutingMethodology";
import { TACTICAL_SYSTEMS_DOCS } from "@/data/knowledgeBase/tacticalSystems";
import { WEAKNESS_TO_DRILL_MAP } from "@/data/knowledgeBase/weaknessToDrillMap";
import seedKnowledgeSrc from "../../../api/rag/_seed-knowledge.ts?raw";
import es from "@/i18n/es.json";
import esLatam from "@/i18n/es-419.json";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import de from "@/i18n/de.json";
import it_ from "@/i18n/it.json";
import nl from "@/i18n/nl.json";

const LOCALES: Record<string, unknown> = { es, "es-419": esLatam, en, fr, de, it: it_, nl };

// Los 5 conjuntos que siembra api/rag/_seed-knowledge.ts (ALL_KNOWLEDGE_DOCS).
const SEEDED_DOCS = [
  ...SCOUTING_METHODOLOGY_DOCS,
  ...YOUTH_DEVELOPMENT_DOCS,
  ...TACTICAL_SYSTEMS_DOCS,
  ...PERFORMANCE_BENCHMARKS_DOCS,
  ...WEAKNESS_TO_DRILL_MAP,
];

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
      "players.profile.correctionFactor",
    ];
    for (const [locale, json] of Object.entries(LOCALES)) {
      // Control positivo: el lector de claves encuentra una clave vecina que SÍ existe.
      expect(get(json, "compare.sprintNoData"), `${locale}: control`).toBeDefined();
      expect(get(json, "players.profile.areasToDevelope"), `${locale}: control`).toBeDefined();
      for (const key of gone) expect(get(json, key), `${locale}: ${key}`).toBeUndefined();
    }
  });

  it("la prueba recorre los MISMOS conjuntos que siembra el RAG (los 5)", () => {
    for (const name of [
      "SCOUTING_METHODOLOGY_DOCS", "YOUTH_DEVELOPMENT_DOCS", "TACTICAL_SYSTEMS_DOCS",
      "PERFORMANCE_BENCHMARKS_DOCS", "WEAKNESS_TO_DRILL_MAP",
    ]) {
      expect(seedKnowledgeSrc).toContain(`...${name}`);
    }
    expect(seedKnowledgeSrc.match(/^\s*\.\.\.[A-Z_]+,$/gm)?.length).toBe(5);
  });

  it("la base de conocimiento no atribuye a VITAS correcciones por edad relativa ni el TruthFilter", () => {
    const text = SEEDED_DOCS.map((d) => d.content).join("\n");
    expect(text).not.toMatch(/TruthFilter/);
    expect(text).not.toMatch(/Unified Bias Index|\bUBI\b/);
    expect(text).not.toMatch(/Q4 recibe \+5|Q1 recibe -2/);
  });

  it("la base de conocimiento NO dice que VITAS calcule hoy el trimestre de nacimiento (birthQuarter no tiene llamadores)", () => {
    const text = SEEDED_DOCS.map((d) => d.content).join("\n");
    expect(text).not.toMatch(/VITAS[^.\n]{0,40}calcula el trimestre/i);
    expect(text).not.toMatch(/QUÉ HACE HOY VITAS: calcula/);
    expect(text).toMatch(/todavía NO calcula ni muestra el trimestre de nacimiento/);
  });

  it("la base de conocimiento no promete que el ajuste por maduración se aplique en todo el sistema", () => {
    const text = SEEDED_DOCS.map((d) => d.content).join("\n");
    expect(text).not.toMatch(/Sin este ajuste, el sistema sobrevaloraría/);
    expect(text).toMatch(/Los rankings y la comparación de jugadores usan la evaluación SIN ajustar/);
  });
});
