/**
 * VITAS · Jugadores con revisión VSI PENDIENTE (migración 070, decisión del dueño D3,
 * P1 bloque 7b): su historial legacy contiene el 57,5 fabricado (y a veces el VSI o las 6
 * barras actuales son los valores por defecto). Hasta que una persona lo revise
 * (`status = 'reviewed'`), ese jugador NO cuenta como evaluado: fuera de los pares y los
 * percentiles, y sin análisis base. Lector ÚNICO de `vsi_history_reviews` (inv #7).
 *
 * Se leen todas las filas pendientes (tabla pequeña: solo jugadores marcados por la 070)
 * y se filtra en memoria. Error de lectura ⇒ lanza (no se sabe quién está pendiente:
 * nunca se trata como «ninguno»). Excepción: la tabla no existe (base sin la 070) ⇒ nadie
 * pudo quedar marcado.
 */

const TABLE = "vsi_history_reviews";
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

interface DbError {
  code?: string;
  message?: string;
}

function idsFrom(rows: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const id = (r as { player_id?: unknown } | null)?.player_id;
    if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

function fail(err: DbError): never {
  throw new Error(`vsi_history_reviews: ${err.message ?? err.code ?? "error de lectura"}`);
}

/** Ids pendientes de revisión, con el cliente de Supabase (service role). */
export async function pendingVsiReviewIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<Set<string>> {
  const { data, error } = await supabase.from(TABLE).select("player_id").eq("status", "pending");
  if (error) {
    if (MISSING_TABLE_CODES.has((error as DbError).code ?? "")) return new Set();
    fail(error as DbError);
  }
  return idsFrom(data);
}

/** Lo mismo por PostgREST directo (rutas que no usan el cliente, p. ej. Rankings). */
export async function pendingVsiReviewIdsRest(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${TABLE}?status=eq.pending&select=player_id`, { headers });
  if (!res.ok) {
    let err: DbError = { message: `HTTP ${res.status}` };
    try {
      err = { ...err, ...((await res.json()) as DbError) };
    } catch {
      /* cuerpo no JSON */
    }
    if (MISSING_TABLE_CODES.has(err.code ?? "")) return new Set();
    fail(err);
  }
  return idsFrom(await res.json());
}
