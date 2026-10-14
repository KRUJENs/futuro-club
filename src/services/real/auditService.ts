/**
 * VITAS Audit Service — DETERMINISTA
 * Audita el estado real del frontend: servicios, hooks, agentes y almacenamiento.
 * No usa IA. Lógica pura de diagnóstico en tiempo de ejecución.
 */

import { StorageService } from "./storageService";
import { PlayerService } from "./playerService";
import { MetricsService } from "./metricsService";
import { peerPercentile } from "@/lib/metrics/percentile";

// ─── Tipos de resultado ───────────────────────────────────────────────────────

export type AuditStatus = "ok" | "warning" | "error";

export interface AuditCheck {
  name: string;
  status: AuditStatus;
  message: string;
  detail?: string | number | boolean | null;
}

export interface AuditSection {
  section: string;
  status: AuditStatus; // el peor estado de los checks
  checks: AuditCheck[];
}

export interface AuditReport {
  timestamp: string;
  overall: AuditStatus;
  sections: AuditSection[];
  summary: {
    total: number;
    ok: number;
    warnings: number;
    errors: number;
  };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function worstStatus(checks: AuditCheck[]): AuditStatus {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "ok";
}

function check(
  name: string,
  fn: () => { status: AuditStatus; message: string; detail?: AuditCheck["detail"] }
): AuditCheck {
  try {
    const result = fn();
    return { name, ...result };
  } catch (err) {
    return {
      name,
      status: "error",
      message: "Excepción inesperada al auditar",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Sección 1: Storage / Persistencia ───────────────────────────────────────

function auditStorage(): AuditSection {
  const checks: AuditCheck[] = [];

  // ¿localStorage disponible?
  checks.push(
    check("localStorage disponible", () => {
      const available = typeof window !== "undefined" && !!window.localStorage;
      return {
        status: available ? "ok" : "error",
        message: available
          ? "localStorage accesible"
          : "localStorage no disponible (SSR o bloqueado)",
        detail: available,
      };
    })
  );

  // ¿Cuántas claves VITAS existen?
  checks.push(
    check("Claves vitas_ en storage", () => {
      // StorageService.keys() already strips the "vitas_" prefix, so no filter needed
      const keys = StorageService.keys();
      return {
        status: keys.length > 0 ? "ok" : "warning",
        message:
          keys.length > 0
            ? `${keys.length} clave(s) VITAS encontradas`
            : "No hay datos VITAS en storage — crea un jugador para comenzar",
        detail: keys.join(", ") || "ninguna",
      };
    })
  );

  // ¿Hay jugadores guardados?
  checks.push(
    check("Jugadores en storage", () => {
      const raw = StorageService.get<unknown[]>("players", []);
      const count = Array.isArray(raw) ? raw.length : 0;
      return {
        status: count > 0 ? "ok" : "warning",
        message:
          count > 0
            ? `${count} jugador(es) en localStorage`
            : "Sin jugadores — crea uno desde el formulario o la app",
        detail: count,
      };
    })
  );

  return {
    section: "💾 Storage / Persistencia",
    status: worstStatus(checks),
    checks,
  };
}

// ─── Sección 2: PlayerService ─────────────────────────────────────────────────

function auditPlayerService(): AuditSection {
  const checks: AuditCheck[] = [];

  // ¿Se puede leer la lista de jugadores?
  checks.push(
    check("PlayerService.getAll()", () => {
      const players = PlayerService.getAll();
      return {
        status: Array.isArray(players) ? "ok" : "error",
        message: Array.isArray(players)
          ? `${players.length} jugador(es) cargados correctamente`
          : "getAll() no retornó un array",
        detail: Array.isArray(players) ? players.length : null,
      };
    })
  );

  // ¿Tienen VSI calculado?
  checks.push(
    check("Jugadores con VSI calculado", () => {
      const players = PlayerService.getAll();
      const withVSI = players.filter(
        (p) => typeof p.vsi === "number" && p.vsi > 0
      );
      const pct = players.length > 0 ? (withVSI.length / players.length) * 100 : 0;
      return {
        status: pct === 100 ? "ok" : pct > 50 ? "warning" : "error",
        message: `${withVSI.length}/${players.length} jugadores tienen VSI calculado`,
        detail: `${pct.toFixed(0)}%`,
      };
    })
  );

  // ¿Cuántos tienen PHV calculado?
  checks.push(
    check("Jugadores con PHV del agente", () => {
      const players = PlayerService.getAll();
      const withPHV = players.filter((p) => !!p.phvCategory);
      return {
        status:
          withPHV.length === players.length
            ? "ok"
            : withPHV.length > 0
            ? "warning"
            : "warning",
        message:
          withPHV.length === players.length
            ? "Todos los jugadores tienen PHV calculado"
            : `${withPHV.length}/${players.length} tienen PHV — requieren llamada al agente`,
        detail: withPHV.length,
      };
    })
  );

  // ¿Jugadores registrados?
  checks.push(
    check("Jugadores registrados", () => {
      const players = PlayerService.getAll();
      return {
        status: players.length > 0 ? "ok" : "warning",
        message:
          players.length > 0
            ? `${players.length} jugador(es) registrados`
            : "Sin jugadores — crea uno para empezar",
        detail: players.length,
      };
    })
  );

  return {
    section: "👥 PlayerService",
    status: worstStatus(checks),
    checks,
  };
}

// ─── Sección 3: MetricsService ────────────────────────────────────────────────

function auditMetricsService(): AuditSection {
  const checks: AuditCheck[] = [];

  // ¿Los pesos del VSI producen valores coherentes? (verificación indirecta)
  checks.push(
    check("Pesos VSI — coherencia interna", () => {
      // Métricas uniformes de 100 deben dar VSI <= 100
      const allMax = MetricsService.calculateVSI({
        speed: 100, technique: 100, vision: 100,
        stamina: 100, shooting: 100, defending: 100,
      });
      const allMin = MetricsService.calculateVSI({
        speed: 0, technique: 0, vision: 0,
        stamina: 0, shooting: 0, defending: 0,
      });
      const valid = allMax <= 100 && allMin >= 0;
      return {
        status: valid ? "ok" : "error",
        message: valid
          ? `Pesos VSI correctos: rango [${allMin}, ${allMax}]`
          : `Pesos incorrectos: rango [${allMin}, ${allMax}] fuera de [0, 100]`,
        detail: `min=${allMin}, max=${allMax}`,
      };
    })
  );

  // ¿calculateVSI retorna valor válido?
  checks.push(
    check("calculateVSI con métricas de prueba", () => {
      const testMetrics = {
        speed: 80,
        technique: 75,
        vision: 70,
        stamina: 65,
        shooting: 60,
        defending: 55,
      };
      const vsi = MetricsService.calculateVSI(testMetrics);
      const valid = typeof vsi === "number" && vsi >= 0 && vsi <= 100;
      return {
        status: valid ? "ok" : "error",
        message: valid
          ? `calculateVSI retornó ${vsi} (rango válido 0-100)`
          : `calculateVSI retornó valor inválido: ${vsi}`,
        detail: vsi,
      };
    })
  );

  // ¿classifyVSI funciona?
  checks.push(
    check("classifyVSI cubre todos los rangos", () => {
      const cases = [
        { vsi: 85, expected: "elite" },
        { vsi: 70, expected: "high" },
        { vsi: 55, expected: "medium" },
        { vsi: 40, expected: "developing" },
      ];
      const failures = cases.filter(
        (c) => MetricsService.classifyVSI(c.vsi) !== c.expected
      );
      return {
        status: failures.length === 0 ? "ok" : "error",
        message:
          failures.length === 0
            ? "classifyVSI cubre todos los rangos correctamente"
            : `Fallo en: ${failures.map((f) => f.vsi).join(", ")}`,
        detail: failures.length === 0 ? "ok" : failures.length + " fallos",
      };
    })
  );

  // ¿El percentil entre pares (implementación única) se calcula y se bloquea bien?
  checks.push(
    check("peerPercentile correcto", () => {
      const tenPeers = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const pct = peerPercentile(55, tenPeers).result.value; // 5 de 10 debajo → 50
      const fewPeers = peerPercentile(80, [50, 60, 70]).result.value; // < 10 pares → null
      const unrated = peerPercentile(null, tenPeers).result.value; // sin evaluar → null
      const valid = pct === 50 && fewPeers === null && unrated === null;
      return {
        status: valid ? "ok" : "warning",
        message: valid
          ? `peerPercentile correcto: ${pct}%; bloqueado con menos de 10 pares y sin evaluar`
          : `Resultado inesperado: ${pct} / ${fewPeers} / ${unrated} (esperado 50 / null / null)`,
        detail: pct,
      };
    })
  );

  return {
    section: "📊 MetricsService",
    status: worstStatus(checks),
    checks,
  };
}

// ─── Sección 4: Agentes (conectividad API) ────────────────────────────────────

async function auditAgents(): Promise<AuditSection> {
  const checks: AuditCheck[] = [];

  const endpoints = [
    { name: "PHV Calculator", path: "/api/agents/phv-calculator", method: "POST" },
    { name: "Scout Insight", path: "/api/agents/scout-insight", method: "POST" },
    { name: "Role Profile", path: "/api/agents/role-profile", method: "POST" },
    { name: "Tactical Label", path: "/api/agents/tactical-label", method: "POST" },
  ];

  for (const ep of endpoints) {
    // Enviamos payload vacío — esperamos 400/422 (validación), no 404/500 de ruta
    const result = await new Promise<AuditCheck>((resolve) => {
      fetch(ep.path, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
        .then((res) => {
          // 400/422 = ruta existe, rechaza input inválido → OK para auditoría
          // 200 = respondió correctamente
          // 404 = ruta no existe → ERROR
          // 500 = error interno → WARNING (puede ser falta de API key)
          const isReachable = res.status !== 404;
          const hasApiKey = res.status !== 500;
          resolve({
            name: `${ep.name} (${ep.path})`,
            status: !isReachable ? "error" : !hasApiKey ? "warning" : "ok",
            message: !isReachable
              ? "Ruta no encontrada (404) — verificar api/agents/"
              : res.status === 500
              ? "Endpoint activo pero error interno — verificar ANTHROPIC_API_KEY"
              : res.status === 400 || res.status === 422
              ? "Endpoint activo y validando input correctamente"
              : `Endpoint activo — status ${res.status}`,
            detail: res.status,
          });
        })
        .catch(() => {
          resolve({
            name: `${ep.name} (${ep.path})`,
            status: "warning",
            message: "No se pudo conectar — app en local sin servidor API",
            detail: "fetch error (modo dev sin Vercel)",
          });
        });
    });

    checks.push(result);
  }

  return {
    section: "🤖 Agentes Claude (API)",
    status: worstStatus(checks),
    checks,
  };
}

// ─── Sección 5: Variables de entorno ─────────────────────────────────────────

function auditEnvironment(): AuditSection {
  const checks: AuditCheck[] = [];

  checks.push(
    check("ANTHROPIC_API_KEY configurada", () => {
      // En frontend solo sabemos si está en Vercel — no la exponemos
      const isVercel =
        typeof window !== "undefined" &&
        window.location.hostname.includes("vercel.app");
      const isLocal = !isVercel;
      return {
        status: "ok",
        message: isVercel
          ? "Producción Vercel detectada — API key debe estar en env vars"
          : "Entorno local — API key en Vercel, no en frontend (correcto)",
        detail: isVercel ? "vercel" : "localhost",
      };
    })
  );

  checks.push(
    check("Modo de desarrollo", () => {
      const isDev = import.meta.env.DEV;
      return {
        status: isDev ? "warning" : "ok",
        message: isDev
          ? "Modo DEV — agentes pueden fallar sin servidor Vercel activo"
          : "Modo PROD — agentes conectados a Vercel Edge Functions",
        detail: isDev ? "development" : "production",
      };
    })
  );

  checks.push(
    check("URL base de la app", () => {
      const url =
        typeof window !== "undefined" ? window.location.origin : "desconocida";
      return {
        status: "ok",
        message: `App corriendo en: ${url}`,
        detail: url,
      };
    })
  );

  return {
    section: "🔧 Entorno y Variables",
    status: worstStatus(checks),
    checks,
  };
}

// ─── Auditoría completa ───────────────────────────────────────────────────────

export const AuditService = {
  /**
   * Ejecuta todas las verificaciones síncronas (storage, servicios, métricas).
   * Uso: AuditService.runSync() — sin await
   */
  runSync(): AuditReport {
    const sections: AuditSection[] = [
      auditStorage(),
      auditPlayerService(),
      auditMetricsService(),
      auditEnvironment(),
    ];
    return buildReport(sections);
  },

  /**
   * Ejecuta auditoría completa incluyendo conectividad de agentes (async).
   * Uso: await AuditService.runFull()
   */
  async runFull(): Promise<AuditReport> {
    const [agentsSection] = await Promise.all([auditAgents()]);
    const sections: AuditSection[] = [
      auditStorage(),
      auditPlayerService(),
      auditMetricsService(),
      auditEnvironment(),
      agentsSection,
    ];
    return buildReport(sections);
  },

  /**
   * Retorna solo el estado general sin detalle.
   */
  async quickStatus(): Promise<AuditStatus> {
    const report = await AuditService.runFull();
    return report.overall;
  },
};

function buildReport(sections: AuditSection[]): AuditReport {
  const allChecks = sections.flatMap((s) => s.checks);
  const ok = allChecks.filter((c) => c.status === "ok").length;
  const warnings = allChecks.filter((c) => c.status === "warning").length;
  const errors = allChecks.filter((c) => c.status === "error").length;

  return {
    timestamp: new Date().toISOString(),
    overall: worstStatus(allChecks),
    sections,
    summary: { total: allChecks.length, ok, warnings, errors },
  };
}
