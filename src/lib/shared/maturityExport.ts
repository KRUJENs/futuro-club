/**
 * VITAS · Salida del estado de maduración para FICHA/Grada (P2 bloque 10; decisión del
 * dueño D11, 20-21 oct 2026): SOLO estado de maduración + fecha estimada del PHV + su
 * confianza, con consentimiento del tutor y visible solo para el dueño del jugador.
 *
 * Contrato `vitas.maturity.v1` (docs/contrato-maduracion-ficha.md). Constructor PURO: la
 * ruta (api/players/_maturity-export.ts) comprueba el dueño y el consentimiento y le pasa
 * las filas. Nada se recalcula por otra vía (inv #7) y nada del módulo PHV cambia (inv #4):
 *  - la medida guardada pasa por `trustAnthroForPlayer` (la misma puerta que el servidor
 *    usa para agentes e informes: fila completa, edad desde la fecha de nacimiento, sexo
 *    REGISTRADO y calculada con ese sexo);
 *  - estado y edad del PHV salen de `phvGate` sobre esas mismas entradas (fase única de
 *    Mirwald y su confianza); si las dos puertas no coinciden, se bloquea;
 *  - fecha del PHV = fecha de nacimiento + edad del PHV (APHV).
 * Orden de las comprobaciones: sin consentimiento no se dice nada más (ni el motivo del PHV).
 * Edge-safe: sin alias `@/`.
 */

import { phvGate, type PhvPhase } from "../phv/phvGate";
import type { AnthropometricsRowLike } from "../phv/phvGate";
import { derived, type MetricResult } from "../metrics/MetricResult";
import { decimalAgeYears } from "./age";
import { toIsoBirthDate } from "./birthDate";
import { withRegisteredSex } from "./registeredSex";
import { trustAnthroForPlayer } from "./sexGatedAnthro";

export const MATURITY_EXPORT_SCHEMA = "vitas.maturity.v1";
export const MATURITY_EXPORT_SOURCE_REF = "src/lib/shared/maturityExport.ts";

/** Edad a partir de la cual no hace falta el tutor (mayoría de edad). */
export const ADULT_AGE_YEARS = 18;

export type MaturityExportCode = "consent_required" | "phv_unavailable";

export interface MaturityExportPayload {
  schema: typeof MATURITY_EXPORT_SCHEMA;
  player_id: string;
  /** Fase PHV única (Mirwald): pre_phv · circa_phv · post_phv. */
  status: MetricResult<PhvPhase>;
  /** Fecha estimada del pico de crecimiento (YYYY-MM-DD). */
  phv_date: MetricResult<string>;
  /** Fecha de la medición de la que sale (trazabilidad). */
  measured_at: string | null;
}

export type MaturityExportResult =
  | { ok: true; payload: MaturityExportPayload }
  | { ok: false; code: MaturityExportCode; gate_reason: string };

export const CONSENT_REQUIRED_REASON =
  "Hace falta el consentimiento activo del tutor para compartir la maduración de un menor.";
export const PHV_INCONSISTENT_REASON =
  "La medición guardada y el cálculo no coinciden: vuelve a guardar la medición.";

type Blob = Record<string, unknown>;

/** ¿Hace falta el tutor? Menor o edad desconocida (se pide de más, nunca de menos). */
export function requiresGuardianConsent(birthDate: string | null, now?: Date): boolean {
  const age = decimalAgeYears(birthDate, now);
  return age === null || age < ADULT_AGE_YEARS;
}

function addYearsIso(isoDate: string, years: number): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(base + years * 365.2425 * 86_400_000).toISOString().slice(0, 10);
}

export function buildMaturityExport(input: {
  playerId: string;
  birthDate: string | null;
  blob: Blob | null;
  row: (AnthropometricsRowLike & { measured_at?: string | null }) | null;
  hasConsent: boolean;
  now?: Date;
}): MaturityExportResult {
  const { playerId, blob, row } = input;
  const birthDate = toIsoBirthDate(input.birthDate, input.now);

  if (requiresGuardianConsent(birthDate, input.now) && !input.hasConsent) {
    return { ok: false, code: "consent_required", gate_reason: CONSENT_REQUIRED_REASON };
  }

  const player = withRegisteredSex(blob ?? {}) as Blob;
  const trust = trustAnthroForPlayer(row, player);
  if (!trust.trusted) {
    return { ok: false, code: "phv_unavailable", gate_reason: trust.gate_reason ?? "Sin PHV" };
  }
  const gate = phvGate(
    {
      height: row?.height_cm != null ? Number(row.height_cm) : null,
      weight: row?.weight_kg != null ? Number(row.weight_kg) : null,
      sittingHeight: row?.sitting_height_cm != null ? Number(row.sitting_height_cm) : null,
      legLength: row?.leg_length_cm != null ? Number(row.leg_length_cm) : null,
      birthDate,
      gender: typeof player.gender === "string" ? player.gender : null,
    },
    row?.measured_at ?? undefined,
  );
  if (!gate.ok) return { ok: false, code: "phv_unavailable", gate_reason: gate.gate_reason };
  if (gate.category !== trust.category || gate.aphv.value === null || birthDate === null) {
    return { ok: false, code: "phv_unavailable", gate_reason: PHV_INCONSISTENT_REASON };
  }

  const source_ref = `${MATURITY_EXPORT_SOURCE_REF} · ${gate.aphv.source_ref ?? "phvGate"}`;
  return {
    ok: true,
    payload: {
      schema: MATURITY_EXPORT_SCHEMA,
      player_id: playerId,
      status: derived<PhvPhase>(gate.status, { confidence: gate.offset.confidence, source_ref }),
      phv_date: derived<string>(addYearsIso(birthDate, gate.aphv.value), {
        confidence: gate.aphv.confidence,
        source_ref,
      }),
      measured_at: row?.measured_at ?? null,
    },
  };
}
