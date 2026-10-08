/**
 * Helper de tests (no es un test): simula la parte de Supabase REST que usa
 * api/_lib/analysisConsentGate — gdpr_audit_log (declaraciones), players.birth_date,
 * parental_consents y videos — y deja pasar el resto a `fallback`.
 */
import { vi } from "vitest";

export interface ConsentDbState {
  /** Declaraciones guardadas (filas de gdpr_audit_log) que el GET debe encontrar. */
  storedAttestations: Array<{ resource_type: string; resource_id: string | null; user_id?: string; version?: string }>;
  /** players.birth_date por id. undefined = el jugador no existe. */
  birthDates: Record<string, string | null>;
  /** player_id con consentimiento parental activo (email_verified + no retirado). */
  activeConsents: string[];
  /** Filas de videos (por id y bunny_video_id). */
  videos: Array<{ id: string; user_id: string | null; tenant_id: string | null; player_id: string | null; bunny_video_id: string | null }>;
  /**
   * players.user_id por id (dueño, 076). Lo usa ownership.ownsPlayer
   * (`players?id=eq.X&user_id=eq.U&select=id`): sin entrada → el jugador no es de nadie.
   */
  playerOwners: Record<string, string>;
  /** Errores forzados por tabla ("gdpr_audit_log", "players", "parental_consents", "videos", "gdpr_insert"). */
  failures: Record<string, { status: number; body: string }>;
}

export function emptyConsentDb(): ConsentDbState {
  return { storedAttestations: [], birthDates: {}, activeConsents: [], videos: [], playerOwners: {}, failures: {} };
}

export type Call = { url: string; init: RequestInit };

function param(u: URL, name: string): string | null {
  const v = u.searchParams.get(name);
  if (v === null) return null;
  const dot = v.indexOf(".");
  return dot >= 0 ? v.slice(dot + 1) : v;
}

/**
 * Valores de un filtro PostgREST `eq.x` o `in.("a","b")` (comillas con escapes \" y \\,
 * como los escribe api/_lib/analysisConsentGate). null = el filtro no viene.
 */
function filterValues(u: URL, name: string): string[] | null {
  const v = u.searchParams.get(name);
  if (v === null) return null;
  if (v.startsWith("eq.")) return [v.slice(3)];
  if (v.startsWith("in.(") && v.endsWith(")")) {
    const inner = v.slice(4, -1);
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner))) {
      out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
    }
    return out;
  }
  throw new Error(`filtro no soportado por el mock: ${name}=${v}`);
}

/**
 * Crea el mock de fetch. Las llamadas a `${sbUrl}/rest/v1/{gdpr_audit_log,players,
 * parental_consents,videos}` se resuelven contra `db`; el resto va a `fallback`.
 */
export function consentFetch(
  db: ConsentDbState,
  opts: {
    sbUrl?: string;
    /** Solo se simulan las llamadas con ESTA service key (las del JWT de usuario van a fallback). */
    serviceKey?: string;
    fallback?: (url: string, init: RequestInit) => Promise<Response> | Response;
  } = {},
) {
  const sbUrl = opts.sbUrl ?? "https://sb.test";
  const serviceAuth = `Bearer ${opts.serviceKey ?? "svc-key"}`;
  const calls: Call[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (url.startsWith(`${sbUrl}/rest/v1/`) && auth === serviceAuth) {
      const u = new URL(url);
      const table = u.pathname.replace("/rest/v1/", "");
      const method = (init.method ?? "GET").toUpperCase();
      if (table === "gdpr_audit_log" && method === "POST") {
        const f = db.failures.gdpr_insert;
        if (f) return new Response(f.body, { status: f.status });
        const row = JSON.parse(String(init.body)) as Record<string, unknown>;
        inserts.push(row);
        return new Response("", { status: 201 });
      }
      const fail = db.failures[table];
      if (fail) return new Response(fail.body, { status: fail.status });
      if (table === "gdpr_audit_log") {
        const type = param(u, "resource_type");
        const idRaw = u.searchParams.get("resource_id");
        const id = idRaw === "is.null" ? null : param(u, "resource_id");
        const version = param(u, "metadata->>version");
        const user = param(u, "user_id");
        const hits = [...db.storedAttestations, ...inserts.map((r) => ({
          resource_type: String(r.resource_type),
          resource_id: (r.resource_id as string | null) ?? null,
          user_id: String(r.user_id),
          version: String((r.metadata as { version?: string })?.version),
        }))].filter(
          (a) =>
            a.resource_type === type &&
            a.resource_id === id &&
            (a.version ?? "2026-09-28.v1") === version &&
            (user === null || a.user_id === user),
        );
        return new Response(JSON.stringify(hits.map((_, i) => ({ id: i + 1 }))), { status: 200 });
      }
      if (table === "players") {
        const id = param(u, "id") ?? "";
        const owner = param(u, "user_id");
        if (owner !== null) {
          // Consulta de propiedad (ownership.ownsPlayer): solo el id, y solo si es SU dueño.
          return new Response(JSON.stringify(db.playerOwners[id] === owner ? [{ id }] : []), { status: 200 });
        }
        if (!(id in db.birthDates)) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify([{ birth_date: db.birthDates[id] }]), { status: 200 });
      }
      if (table === "parental_consents") {
        const pid = param(u, "player_id") ?? "";
        const ok = u.searchParams.get("email_verified") === "is.true" && u.searchParams.get("withdrawn_at") === "is.null";
        return new Response(JSON.stringify(ok && db.activeConsents.includes(pid) ? [{ id: "c1" }] : []), { status: 200 });
      }
      if (table === "videos") {
        // TODAS las filas que casan (no solo la primera): bunny_video_id no es UNIQUE (060).
        const ids = filterValues(u, "id");
        const guids = filterValues(u, "bunny_video_id");
        const rows = db.videos.filter(
          (v) => (ids !== null && ids.includes(v.id)) || (guids !== null && v.bunny_video_id !== null && guids.includes(v.bunny_video_id)),
        );
        return new Response(JSON.stringify(rows), { status: 200 });
      }
    }
    if (opts.fallback) return opts.fallback(url, init);
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fn, calls, inserts };
}

export const ATTESTATION = { accepted: true, version: "2026-09-28.v1" } as const;

/**
 * Fecha de nacimiento de un menor de 14 respecto al reloj REAL (los endpoints usan
 * `new Date()`): 1 de enero de hace 10 años ⇒ 9-10 años cumplidos, nunca caduca el test.
 */
export const MINOR_BIRTH_DATE = `${new Date().getUTCFullYear() - 10}-01-01`;
