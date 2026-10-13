/**
 * Lint (invariante #7 · hallazgo B6 del PR #308): el consentimiento parental de un menor se
 * decide en UN solo sitio, api/_lib/parentalConsent.ts (fila verificada + evidencia de
 * verify-consent + sin retirada). Ningún otro código del servidor puede decidirlo leyendo
 * parental_consents.email_verified por su cuenta (así fue como el orquestador lo leía sin
 * `withdrawn_at IS NULL` ni evidencia), y NINGÚN código del servidor usa
 * players.parental_consent_status (lo pone el entrenador sin verificación del tutor y lo puede
 * volver a cambiar: no sirve ni para conceder ni para retirar; la retirada se guarda en el
 * consentimiento, api/auth/_withdraw-consent.ts).
 * Con controles positivos: el detector SÍ encuentra los casos que existen.
 *
 * Run: npx vitest run --config vitest.api.config.ts api/__tests__/parental-consent-single-source.test.ts
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const API = path.join(ROOT, "api");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
/** Sin comentarios (los docs hablan de estas columnas a propósito); `https://` no es comentario. */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
const files = walk(API).map((p) => ({ file: rel(p), src: stripComments(fs.readFileSync(p, "utf8")) }));

/** ¿Decide el consentimiento leyendo parental_consents.email_verified? */
const decidesConsent = (src: string) => /parental_consents/.test(src) && /email_verified/.test(src);

describe("consentimiento parental · una sola fuente en el servidor", () => {
  it("control positivo: el recorrido ve api/ y el detector encuentra el lector canónico", () => {
    expect(files.length).toBeGreaterThan(100);
    const canon = files.find((f) => f.file === "api/_lib/parentalConsent.ts");
    expect(canon).toBeDefined();
    expect(decidesConsent(canon!.src)).toBe(true);
  });

  it("solo parentalConsent.ts (lector) y auth/verify-consent.ts (quien marca email_verified) tocan email_verified de parental_consents", () => {
    const offenders = files.filter((f) => decidesConsent(f.src)).map((f) => f.file).sort();
    expect(offenders).toEqual(["api/_lib/parentalConsent.ts", "api/auth/verify-consent.ts"]);
  });

  it("el orquestador (flywheel + email al tutor) usa la fuente canónica", () => {
    const orch = files.find((f) => f.file === "api/agents/_pipeline-orchestrator.ts")!;
    expect(orch.src).toMatch(/findActiveParentalConsent\(/);
    expect(orch.src).not.toMatch(/from\("parental_consents"\)/);
  });

  it("ningún código del servidor usa players.parental_consent_status (control positivo: la migración que crea la columna)", () => {
    const offenders = files.filter((f) => /parental_consent_status/.test(f.src)).map((f) => f.file);
    expect(offenders).toEqual([]);
    // Control positivo: el detector SÍ ve la columna donde existe. (Hasta el P1 bloque 3 el
    // control era src/pages/ParentalConsentPage.tsx; ahora esa pantalla tampoco la usa.)
    const mig = fs.readFileSync(path.join(ROOT, "supabase/migrations/036_minor_consent_rgpd.sql"), "utf8");
    expect(/parental_consent_status/.test(mig)).toBe(true);
  });

  it("P1 bloque 3: el navegador tampoco lee ni escribe ya ese rótulo (estado real del servidor)", () => {
    const srcFiles: string[] = [];
    const walkSrc = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "test", "i18n"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkSrc(p);
        else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p);
      }
    };
    walkSrc(path.join(ROOT, "src"));
    expect(srcFiles.length).toBeGreaterThan(100);
    const offenders = srcFiles
      .filter((p) => /parental_consent_(status|granted_at|guardian_name|guardian_email)/.test(stripComments(fs.readFileSync(p, "utf8"))))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
