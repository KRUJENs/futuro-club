/**
 * P1 bloque 7, punto 11 — en el servidor, todo lo que entra al PHV pasa por el sexo
 * REGISTRADO (src/lib/shared/registeredSex.ts): un «M» sin confirmar no abre el gate ni
 * deja pasar un PHV cacheado a agentes, informes, rankings, planes o anuncios.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const code = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function apiFiles(dir = join(ROOT, "api")): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : apiFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [relative(ROOT, p).replace(/\\/g, "/")] : [];
  });
}

// Sitios que ya reciben el sexo registrado por otra vía (documentado en cada uno).
const GATE_ALLOWED = new Set([
  "api/players/anthropometrics.ts", // identity.gender = registeredSex(blob) (loadIdentity)
  "api/agents/_phv-calculator.ts", // sin llamador en la UI (usePHVCalculator/useRecalculatePHV sin uso)
]);
const ROW_TRUST_ALLOWED = new Set(["api/players/anthropometrics.ts"]);

describe("servidor: el sexo que entra al PHV es el registrado", () => {
  const files = apiFiles();

  it("el barrido encuentra el código (control)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("api/rankings/_list.ts");
  });

  it("toda llamada a phvGate/gatedMaturity/pahGate recibe withRegisteredSex(…)", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (GATE_ALLOWED.has(f)) continue;
      code(f).split("\n").forEach((line) => {
        if (/\b(phvGate|gatedMaturity|pahGate)\(/.test(line) && !/withRegisteredSex\(/.test(line)) bad.push(`${f}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("el PHV cacheado de una fila solo se lee con el sexo del jugador (trust/gateAnthroForPlayer)", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (ROW_TRUST_ALLOWED.has(f)) continue;
      code(f).split("\n").forEach((line) => {
        if (/\b(trustAnthropometricsRow|gateAnthropometricsRow)\(/.test(line)) bad.push(`${f}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
    for (const f of ["api/agents/_pipeline-orchestrator.ts", "api/players/baseline-analysis.ts", "api/players/phv-window-plan.ts", "api/transfer/_create-listing.ts"]) {
      expect(code(f)).toMatch(/(trust|gate)AnthroForPlayer\(/);
    }
  });

  it("antropometría: el cuerpo de la petición nunca confirma el sexo; el sexo sale de registeredSex", () => {
    const a = code("api/players/anthropometrics.ts");
    expect(a).not.toMatch(/input\.gender \?\?/);
    expect(a).toMatch(/return registeredSex\(blob\)/);
  });

  it("alta (POST /api/players/crud): la marca solo se guarda junto a un sexo elegido; el servidor no la inventa", () => {
    const c = code("api/players/_crud.ts");
    expect(c).toMatch(/sexConfirmedAt: input\.gender \? input\.sexConfirmedAt : undefined/);
    expect(c).not.toMatch(/sexConfirmedAt: new Date/);
  });
});
