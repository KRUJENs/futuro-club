/**
 * VITAS · Player Anthropometrics API
 *
 *   POST   /api/players/anthropometrics                 → nueva medida + calc PHV
 *   PATCH  /api/players/anthropometrics?id=<rowId>      → actualizar medida + recalc PHV
 *   DELETE /api/players/anthropometrics?id=<rowId>      → borrar medida
 *   GET    /api/players/anthropometrics?playerId=<id>   → última medida o histórico
 *
 * Cada POST inserta una nueva fila (histórico, no sobreescribe).
 * PATCH/DELETE operan sobre una fila concreta por su id.
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { ownsPlayer } from "../_lib/ownership";
import { createClient } from "@supabase/supabase-js";
import {
  phvGate,
  trustAnthropometricsRow,
  AGE_SOURCE_BIRTH_DATE,
  AGE_SOURCE_INTEGER,
  type PhvGate,
} from "../../src/lib/phv/phvGate";
import { decimalAgeYears } from "../../src/lib/shared/age";
import { registeredSex } from "../../src/lib/shared/registeredSex";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ── Schemas ─────────────────────────────────────────────────────────
const postSchema = z.object({
  playerId: z.string().min(1).max(120),
  heightCm: z.number().min(80).max(230),
  weightKg: z.number().min(15).max(150),
  sittingHeightCm: z.number().min(40).max(130).optional(),
  legLengthCm: z.number().min(30).max(130).optional(),
  // Edad ENTERA del jugador: SOLO rellena la columna NOT NULL cuando no hay fecha de
  // nacimiento (y entonces el PHV queda BLOQUEADO). Nunca entra en Mirwald: la regla
  // del owner (28-sep) exige la edad decimal exacta desde la fecha de nacimiento.
  chronologicalAge: z.number().min(5).max(25),
  // Fecha de nacimiento del JUGADOR (ISO). Fuente de la edad decimal de Mirwald. Si
  // no viene, se usa la registrada en el jugador; si tampoco existe ⇒ PHV bloqueado.
  birthDate: z.string().max(40).optional(),
  // Sexo SIN default: el PHV es sexo-específico (invariante #5). Ausente ⇒ no se
  // calcula PHV (queda null), NUNCA se asume masculino ni cae a femenino.
  gender: z.enum(["M", "F"]).optional(),
  notes: z.string().max(500).optional(),
});

const patchSchema = postSchema.partial({ playerId: true });

const getSchema = z.object({
  playerId: z.string().min(1),
  history: z.enum(["true", "false"]).default("false"),
});

// ── Helper · fórmula Mirwald (idéntica a _phv-calculator.ts) ─────────
// sittingHeight y legLength son REQUERIDOS: NO estimamos (height*0.52). Estimar
// fabrica una categoría PHV a partir de solo altura+peso+edad, saltándose el gate
// del cliente (usePHVProduct exige sitting+leg reales o alturas de ambos padres).
// El caller solo debe invocar computePhv cuando hay medidas reales; si no, PHV=null.
function computePhv(input: {
  age: number;
  height: number;
  weight: number;
  sittingHeight: number;
  legLength: number;
  gender: "M" | "F";
}) {
  const sh = input.sittingHeight;
  const ll = input.legLength;

  let offset: number;
  if (input.gender === "M") {
    offset =
      -9.236 +
      0.0002708 * (ll * sh) -
      0.001663 * (input.age * ll) +
      0.007216 * (input.age * sh) +
      0.02292 * ((input.weight / input.height) * 100);
  } else {
    offset =
      -9.376 +
      0.0001882 * (ll * sh) +
      0.0022 * (input.age * ll) +
      0.005841 * (input.age * sh) -
      0.002658 * (input.age * input.weight) +
      0.07693 * ((input.weight / input.height) * 100);
  }

  offset = Number(offset.toFixed(2));

  let category: "early" | "ontime" | "late";
  let phv_status: "pre_phv" | "during_phv" | "post_phv";
  let development_window: "critical" | "active" | "stable";

  if (offset < -1.0) { category = "early"; phv_status = "pre_phv"; }
  else if (offset > 1.0) { category = "late"; phv_status = "post_phv"; }
  else { category = "ontime"; phv_status = "during_phv"; }

  if (phv_status === "during_phv") development_window = "critical";
  else if ((offset >= -2 && offset < -1) || (offset > 1 && offset <= 2)) development_window = "active";
  else development_window = "stable";

  // NOTA: NO emitimos "biological_age = age + offset" — es un concepto inválido
  // (el maturity offset de Mirwald son años respecto al PHV, no un delta de edad;
  // sumarlo no tiene sentido). El cliente ya lo retiró (ver src/lib/phv/mirwald.ts
  // y playerMaturity.ts). La maduración se representa con offset + category; el
  // APHV válido (age − offset) se deriva donde se necesita.
  return {
    offset,
    category,
    phv_status,
    development_window,
  };
}

// ── Gate de entradas (regla del owner 28-sep · G6: qué entra, no la fórmula) ──
// El PHV solo se calcula con TODAS las entradas introducidas: talla, peso, talla
// sentado, pierna (o talla − sentado), EDAD DECIMAL desde la fecha de nacimiento
// del jugador en la fecha de la medida y sexo registrado. La decisión la toma el
// gate ÚNICO (src/lib/phv/phvGate.ts, inv #7); computePhv no cambia (inv #4).
// El entero `chronologicalAge` del cliente NUNCA entra en Mirwald: solo rellena la
// columna NOT NULL cuando falta la fecha de nacimiento (y el PHV queda bloqueado).

interface PlayerIdentity {
  birthDate: string | null;
  gender: "M" | "F" | null;
}

// Sexo que entra al PHV: regla única (un «M» sin confirmar = posible valor por defecto
// antiguo ⇒ null; P1 bloque 7, src/lib/shared/registeredSex.ts).
function sexOf(blob: Record<string, unknown>): "M" | "F" | null {
  return registeredSex(blob);
}

/** Fecha de nacimiento + sexo registrados del jugador (columna o blob `data`). */
async function loadIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  playerId: string,
): Promise<PlayerIdentity & { tenantId: string | null; found: boolean }> {
  const { data } = await supabase
    .from("players")
    .select("tenant_id, birth_date, data")
    .eq("id", playerId)
    .single();
  const blob = (data?.data ?? {}) as Record<string, unknown>;
  const birth =
    (typeof data?.birth_date === "string" && data.birth_date) ||
    (typeof blob.birthDate === "string" && blob.birthDate) ||
    null;
  return {
    found: !!data,
    tenantId: data?.tenant_id ?? null,
    birthDate: birth,
    // Sexo del blob (lo introducido por una persona); la columna pudo arrastrar
    // un 'M' asumido antes de 058 (inv #5).
    gender: sexOf(blob),
  };
}

interface MeasurementPhv {
  phv: ReturnType<typeof computePhv> | null;
  gate: PhvGate;
  chronologicalAge: number;
  ageSource: typeof AGE_SOURCE_BIRTH_DATE | typeof AGE_SOURCE_INTEGER;
}

function phvForMeasurement(
  input: {
    heightCm: number;
    weightKg: number;
    sittingHeightCm?: number;
    legLengthCm?: number;
    chronologicalAge: number;
  },
  identity: PlayerIdentity,
  at: string,
): MeasurementPhv {
  const gate = phvGate(
    {
      height: input.heightCm,
      weight: input.weightKg,
      sittingHeight: input.sittingHeightCm,
      legLength: input.legLengthCm,
      birthDate: identity.birthDate,
      gender: identity.gender,
    },
    at,
  );
  const decimalAge = decimalAgeYears(identity.birthDate, at);
  const phv = gate.ok
    ? computePhv({
        age: gate.ageYears,
        height: input.heightCm,
        weight: input.weightKg,
        sittingHeight: input.sittingHeightCm as number,
        legLength: gate.legLengthCm,
        gender: identity.gender as "M" | "F",
      })
    : null;
  return {
    phv,
    gate,
    chronologicalAge: decimalAge ?? input.chronologicalAge,
    ageSource: decimalAge !== null ? AGE_SOURCE_BIRTH_DATE : AGE_SOURCE_INTEGER,
  };
}

/** Edad decimal fuera del CHECK de la tabla (5–25) ⇒ la fecha de nacimiento es errónea. */
function invalidAge(m: MeasurementPhv): boolean {
  return m.chronologicalAge < 5 || m.chronologicalAge > 25;
}

function gateSummary(m: MeasurementPhv) {
  return { ok: m.gate.ok, gate_reason: m.gate.gate_reason, missing: m.gate.missing };
}

/**
 * Columnas nuevas de la migración 069. Si el operador aún no la aplicó, PostgREST
 * rechaza la escritura («Could not find the 'age_source' column») y la medida no se
 * guardaría. Se reintenta UNA vez sin ellas: la fila queda con age_source NULL ⇒
 * trustAnthropometricsRow la trata como NO fiable (falla cerrado: se guardan las
 * medidas, el PHV de esa fila no se muestra). La app nunca se rompe por la 069.
 */
const MIGRATION_069_COLUMNS = ["age_source", "phv_gate_reason"] as const;

function missing069Column(error: { message?: string } | null | undefined): boolean {
  const msg = error?.message ?? "";
  return MIGRATION_069_COLUMNS.some((c) => msg.includes(c));
}

function without069Columns<T extends Record<string, unknown>>(values: T): T {
  const copy = { ...values } as Record<string, unknown>;
  for (const c of MIGRATION_069_COLUMNS) delete copy[c];
  return copy as T;
}

export default withHandler(
  {
    method: ["GET", "POST", "PATCH", "DELETE"],
    requireAuth: true,
    maxRequests: 60,
  },
  async ({ req, body: postBody, userId, isServiceCall, method, query }) => {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Datos biométricos/maduración de MENORES: el check de propiedad
    // (players.user_id) es obligatorio — SERVICE_ROLE salta RLS.
    const forbidden = () =>
      errorResponse({ code: "forbidden", message: "No autorizado para este jugador", status: 403 });

    // GET/DELETE/PATCH resuelven el playerId de forma distinta (query vs fila);
    // cada rama comprueba ownership antes de leer/mutar.

    // ── GET · histórico o última medida ──────────────────────────
    if (method === "GET") {
      const params = getSchema.safeParse(query);
      if (!params.success) {
        return errorResponse({ code: "invalid_params", message: "playerId requerido", status: 400 });
      }

      if (!isServiceCall && !(await ownsPlayer(params.data.playerId, userId))) {
        return forbidden();
      }

      if (params.data.history === "true") {
        const { data, error } = await supabase
          .from("player_anthropometrics")
          .select("*")
          .eq("player_id", params.data.playerId)
          .order("measured_at", { ascending: false });

        if (error) return errorResponse({ code: "db_error", message: error.message, status: 500 });
        return successResponse({ history: data, count: data?.length ?? 0 });
      } else {
        const { data, error } = await supabase
          .from("player_latest_anthropometrics")
          .select("*")
          .eq("player_id", params.data.playerId)
          .maybeSingle();

        if (error) return errorResponse({ code: "db_error", message: error.message, status: 500 });
        return successResponse({ latest: data });
      }
    }

    // ── DELETE · borrar fila + revertir player record al anterior ─
    if (method === "DELETE") {
      const id = query.id;
      if (!id) return errorResponse({ code: "missing_id", message: "Falta id en query", status: 400 });

      // Leer la fila antes de borrar para saber el player_id
      const { data: rowToDelete } = await supabase
        .from("player_anthropometrics")
        .select("player_id")
        .eq("id", id)
        .single();

      if (!isServiceCall && !(await ownsPlayer(rowToDelete?.player_id, userId))) {
        return forbidden();
      }

      const { error } = await supabase
        .from("player_anthropometrics")
        .delete()
        .eq("id", id);

      if (error) return errorResponse({ code: "delete_failed", message: error.message, status: 500 });

      // Buscar la nueva última medición y resincronizar el player record
      if (rowToDelete?.player_id) {
        const { data: latest } = await supabase
          .from("player_anthropometrics")
          // select("*"): robusto aunque la 069 (age_source) aún no esté aplicada.
          .select("*")
          .eq("player_id", rowToDelete.player_id)
          .order("measured_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latest) {
          // El PHV de la nueva última fila solo se propaga si es fiable (fila completa
          // con edad por fecha de nacimiento, 069). Una fila antigua (edad entera) NO
          // re-contamina players.phv_category.
          // …y solo con sexo registrado (P1 bloque 7): la fila pudo calcularse con un
          // «M» por defecto antiguo.
          const identity = await loadIdentity(supabase, String(rowToDelete.player_id));
          const trusted = trustAnthropometricsRow(latest);
          const propagate = trusted.trusted && identity.gender !== null;
          await supabase.from("players").update({
            height_cm: latest.height_cm,
            weight_kg: latest.weight_kg,
            sitting_height: latest.sitting_height_cm,
            leg_length: latest.leg_length_cm,
            phv_category: propagate ? latest.phv_category : null,
            phv_offset: propagate ? trusted.offset : null,
          }).eq("id", rowToDelete.player_id);
        } else {
          // Sin mediciones: las medidas del perfil se conservan, pero el PHV no puede
          // sobrevivir a la fila que lo respaldaba (no hay fila fiable ⇒ sin PHV).
          await supabase.from("players").update({
            phv_category: null,
            phv_offset: null,
          }).eq("id", rowToDelete.player_id);
        }
      }

      return successResponse({ deleted: true, id });
    }

    // ── PATCH · actualizar fila + recalcular PHV ─────────────────
    if (method === "PATCH") {
      const id = query.id;
      if (!id) return errorResponse({ code: "missing_id", message: "Falta id en query", status: 400 });

      // Resolver ownership por la fila ANTES de mutar. measured_at: la edad decimal
      // se recalcula en la fecha ORIGINAL de la medida, no hoy.
      const { data: rowOwner } = await supabase
        .from("player_anthropometrics")
        .select("player_id, measured_at")
        .eq("id", id)
        .single();

      if (!isServiceCall && !(await ownsPlayer(rowOwner?.player_id, userId))) {
        return forbidden();
      }

      const body = (await req.json().catch(() => null)) as unknown;
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse({
          code: "invalid_body",
          message: parsed.error.errors[0]?.message ?? "Body inválido",
          status: 400,
        });
      }
      const input = parsed.data;

      // Recalcular PHV con los nuevos valores (todos requeridos para el cálculo)
      if (
        input.heightCm === undefined ||
        input.weightKg === undefined ||
        input.chronologicalAge === undefined
      ) {
        return errorResponse({
          code: "missing_fields",
          message: "PATCH requiere heightCm, weightKg, chronologicalAge",
          status: 400,
        });
      }

      // PHV solo con TODAS las entradas introducidas (gate único): 4 medidas, edad
      // decimal desde la fecha de nacimiento en la fecha de la medida y sexo
      // registrado. Si falta cualquiera → null + motivo (no fabricar, no asumir).
      const identity = await loadIdentity(supabase, String(rowOwner?.player_id ?? ""));
      const measuredAt =
        typeof rowOwner?.measured_at === "string" ? rowOwner.measured_at : new Date().toISOString();
      const m = phvForMeasurement(
        {
          heightCm: input.heightCm,
          weightKg: input.weightKg,
          sittingHeightCm: input.sittingHeightCm,
          legLengthCm: input.legLengthCm,
          chronologicalAge: input.chronologicalAge,
        },
        { birthDate: input.birthDate ?? identity.birthDate, gender: identity.gender }, // el cuerpo nunca confirma el sexo (P1 bloque 7)
        measuredAt,
      );
      if (invalidAge(m)) {
        return errorResponse({
          code: "invalid_birth_date",
          message: "La fecha de nacimiento da una edad fuera de 5–25 años en la fecha de la medida",
          status: 400,
        });
      }
      const phv = m.phv;

      const updateValues = {
        height_cm: input.heightCm,
        weight_kg: input.weightKg,
        sitting_height_cm: input.sittingHeightCm ?? null,
        leg_length_cm: input.legLengthCm ?? null,
        chronological_age: m.chronologicalAge,
        age_source: m.ageSource,
        maturity_offset: phv?.offset ?? null,
        phv_category: phv?.category ?? null,
        phv_status: phv?.phv_status ?? null,
        development_window: phv?.development_window ?? null,
        phv_gate_reason: m.gate.gate_reason,
        notes: input.notes,
      };
      let { data: row, error } = await supabase
        .from("player_anthropometrics")
        .update(updateValues)
        .eq("id", id)
        .select()
        .single();
      if (error && missing069Column(error)) {
        ({ data: row, error } = await supabase
          .from("player_anthropometrics")
          .update(without069Columns(updateValues))
          .eq("id", id)
          .select()
          .single());
      }

      if (error) return errorResponse({ code: "update_failed", message: error.message, status: 500 });

      // Si esta fila era la más reciente, sincronizar al player record
      if (row?.player_id) {
        const { data: latest } = await supabase
          .from("player_anthropometrics")
          .select("id")
          .eq("player_id", row.player_id)
          .order("measured_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latest?.id === id) {
          // PHV a la columna solo si la fila GUARDADA es fiable (sin 069 aplicada
          // la fila queda sin age_source ⇒ no fiable ⇒ la columna no lo recibe).
          const rowTrusted = trustAnthropometricsRow(row).trusted;
          await supabase.from("players").update({
            height_cm: input.heightCm,
            weight_kg: input.weightKg,
            sitting_height: input.sittingHeightCm ?? null,
            leg_length: input.legLengthCm ?? null,
            phv_category: rowTrusted ? phv?.category ?? null : null,
            phv_offset: rowTrusted ? phv?.offset ?? null : null,
          }).eq("id", row.player_id);
        }
      }

      return successResponse({ updated: true, record: row, phv, phvGate: gateSummary(m) });
    }

    // ── POST · nueva medida + calcular PHV ───────────────────────
    // withHandler YA leyó el cuerpo del POST (req.text() → ctx.body): releer
    // req.json() fallaba siempre («Body is unusable» → null → 400 invalid_body), así
    // que ninguna medición nueva llegaba a guardarse. Se usa el cuerpo ya parseado.
    const parsed = postSchema.safeParse(postBody);
    if (!parsed.success) {
      return errorResponse({
        code: "invalid_body",
        message: parsed.error.errors[0]?.message ?? "Body inválido",
        status: 400,
      });
    }
    const input = parsed.data;

    if (!isServiceCall && !(await ownsPlayer(input.playerId, userId))) {
      return forbidden();
    }

    const player = await loadIdentity(supabase, input.playerId);

    if (!player.found) {
      return errorResponse({ code: "player_not_found", message: "Jugador no existe", status: 404 });
    }

    // PHV solo con TODAS las entradas introducidas (gate único): 4 medidas, edad
    // decimal desde la fecha de nacimiento del jugador HOY (measured_at = now()) y
    // sexo registrado. Si falta cualquiera → null + motivo (no fabricar, no asumir).
    const measuredAt = new Date().toISOString();
    const m = phvForMeasurement(
      {
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        sittingHeightCm: input.sittingHeightCm,
        legLengthCm: input.legLengthCm,
        chronologicalAge: input.chronologicalAge,
      },
      { birthDate: input.birthDate ?? player.birthDate, gender: player.gender }, // el cuerpo nunca confirma el sexo (P1 bloque 7)
      measuredAt,
    );
    if (invalidAge(m)) {
      return errorResponse({
        code: "invalid_birth_date",
        message: "La fecha de nacimiento da una edad fuera de 5–25 años",
        status: 400,
      });
    }
    const phv = m.phv;

    const insertValues = {
      tenant_id: player.tenantId,
      player_id: input.playerId,
      height_cm: input.heightCm,
      weight_kg: input.weightKg,
      sitting_height_cm: input.sittingHeightCm,
      leg_length_cm: input.legLengthCm,
      chronological_age: m.chronologicalAge,
      age_source: m.ageSource,
      maturity_offset: phv?.offset ?? null,
      phv_category: phv?.category ?? null,
      phv_status: phv?.phv_status ?? null,
      development_window: phv?.development_window ?? null,
      phv_gate_reason: m.gate.gate_reason,
      measured_by_user: userId,
      measured_at: measuredAt,
      notes: input.notes,
    };
    let { data: row, error } = await supabase
      .from("player_anthropometrics")
      .insert(insertValues)
      .select()
      .single();
    if (error && missing069Column(error)) {
      ({ data: row, error } = await supabase
        .from("player_anthropometrics")
        .insert(without069Columns(insertValues))
        .select()
        .single());
    }

    if (error) {
      return errorResponse({ code: "save_failed", message: error.message, status: 500 });
    }

    // Sincronizar al player record · POST siempre es la nueva más reciente. El PHV
    // solo si la fila GUARDADA es fiable (ver PATCH): la columna nunca va por
    // delante de una fila que la respalde.
    const rowTrusted = trustAnthropometricsRow(row).trusted;
    await supabase.from("players").update({
      height_cm: input.heightCm,
      weight_kg: input.weightKg,
      sitting_height: input.sittingHeightCm ?? null,
      leg_length: input.legLengthCm ?? null,
      phv_category: rowTrusted ? phv?.category ?? null : null,
      phv_offset: rowTrusted ? phv?.offset ?? null : null,
    }).eq("id", input.playerId);

    return successResponse({ saved: true, record: row, phv, phvGate: gateSummary(m) });
  }
);
