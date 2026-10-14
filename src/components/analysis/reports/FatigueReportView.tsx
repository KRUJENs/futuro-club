/**
 * VITAS · Fatigue Report View
 *
 * Renderiza el reporte del agente `api/agents/_fatigue-report.ts`
 * (report_type = "fatigue-report", namespace i18n = "fatigueReport").
 *
 * Estructura obligatoria del agente (ver prompt, JSON):
 *   estadoActual:          { indice, severidad, indicadores[], señalesPosturales[] }
 *   cargaACWR:             { valor, zona, tendencia, recomendacionProximaSesion }
 *   riesgoLesion:          { nivel, factores[], zonasExpuestas[] }
 *   ajustesPHV:            { banda, umbralesModificados[], recomendaciones[] }   ← moat
 *   protocoloRecuperacion: { plan48h[], indicadoresRetorno[], ejerciciosComplementarios[] }
 *   resumenEjecutivo:      string
 *
 * TODO opcional: el reporte puede venir parcial o de fallback → todo con ?? y condicionales.
 * Las etiquetas fijas van por i18n; los VALORES del reporte se pintan tal cual (ya en español).
 */

import { useTranslation } from "react-i18next";
import { DEFAULT_FATIGUE_CONFIG } from "@/lib/fatigue/types";
import {
  HeartPulse, Gauge, ShieldAlert, Dna, Activity,
  TrendingUp, TrendingDown, Minus,
  type LucideIcon,
} from "lucide-react";

// ─── helpers de color semántico ─────────────────────────────────────────────

type Tone = { text: string; bg: string; border: string };

const TONE_RED: Tone = { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" };
const TONE_AMBER: Tone = { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" };
const TONE_GREEN: Tone = { text: "text-green-400", bg: "bg-green-500/10", border: "border-green-500/30" };
const TONE_ELECTRIC: Tone = { text: "text-electric", bg: "bg-electric/10", border: "border-electric/30" };

/** Normaliza (minúsculas, sin acentos) para matchear valores en español de forma robusta. */
function norm(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Deriva el tono de un valor cualitativo (severidad / zona / nivel de riesgo). */
function toneForLevel(value?: string): Tone {
  const v = norm(value);
  if (!v) return TONE_ELECTRIC;
  if (/(muy alto|alto|severo|critico|peligro|elevado|grave)/.test(v)) return TONE_RED;
  if (/(moderado|medio|precaucion|atencion|desentrenado)/.test(v)) return TONE_AMBER;
  if (/(bajo|leve|optimo|normal|estable|minimo)/.test(v)) return TONE_GREEN;
  return TONE_ELECTRIC;
}

/** Tono del índice de fatiga 0-100 (más alto = peor). Cortes = los del índice
 *  (DEFAULT_FATIGUE_CONFIG): una sola definición (P1 bloque 4; antes 60/30). */
function toneForIndex(n?: number): Tone {
  if (typeof n !== "number") return TONE_ELECTRIC;
  if (n >= DEFAULT_FATIGUE_CONFIG.severityThresholds.high) return TONE_RED;
  if (n >= DEFAULT_FATIGUE_CONFIG.severityThresholds.moderate) return TONE_AMBER;
  return TONE_GREEN;
}

/** Icono de tendencia según texto (creciente / decreciente / estable). */
function trendIcon(value?: string) {
  const v = norm(value);
  if (/(crecient|subiend|aument|al alza|ascend)/.test(v)) return TrendingUp;
  if (/(decrecient|bajand|disminuy|a la baja|descend)/.test(v)) return TrendingDown;
  return Minus;
}

// ─── mini componentes ───────────────────────────────────────────────────────

function Chip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-display font-bold ${tone.text} ${tone.bg} border ${tone.border}`}
    >
      {label}
    </span>
  );
}

function Section({
  heading,
  Icon,
  color,
  children,
}: {
  heading: string;
  Icon: LucideIcon;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-secondary/30 border border-border p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Icon size={13} className={color} />
        <h4 className={`font-display font-bold text-xs uppercase tracking-wider ${color}`}>{heading}</h4>
      </div>
      {children}
    </section>
  );
}

/** Lista con viñetas · devuelve null si el array viene vacío/ausente. */
function BulletList({
  heading,
  items,
  color = "text-muted-foreground",
}: {
  heading?: string;
  items?: unknown;
  color?: string;
}) {
  const list = Array.isArray(items) ? (items as unknown[]).filter((x) => x != null && String(x).trim() !== "") : [];
  if (list.length === 0) return null;
  return (
    <div>
      {heading && (
        <div className={`text-[10px] uppercase tracking-wider font-bold mb-1 ${color}`}>{heading}</div>
      )}
      <ul className="list-disc list-inside space-y-1 text-xs text-foreground">
        {list.map((s, i) => (
          <li key={i}>{String(s)}</li>
        ))}
      </ul>
    </div>
  );
}

/** Fila de chips neutros · devuelve null si el array viene vacío/ausente. */
function ChipRow({ heading, items }: { heading?: string; items?: unknown }) {
  const list = Array.isArray(items) ? (items as unknown[]).filter((x) => x != null && String(x).trim() !== "") : [];
  if (list.length === 0) return null;
  return (
    <div>
      {heading && (
        <div className="text-[10px] uppercase tracking-wider font-bold mb-1.5 text-muted-foreground">{heading}</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {list.map((s, i) => (
          <span
            key={i}
            className="inline-flex items-center rounded-lg px-2 py-1 text-[11px] font-medium text-foreground bg-secondary/60 border border-border"
          >
            {String(s)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── tipos laxos del reporte ────────────────────────────────────────────────

interface EstadoActual {
  indice?: number;
  severidad?: string;
  indicadores?: unknown;
  ["señalesPosturales"]?: unknown;
  senalesPosturales?: unknown;
}
interface CargaACWR {
  valor?: number | null;
  zona?: string;
  tendencia?: string;
  recomendacionProximaSesion?: string;
}
interface RiesgoLesion {
  nivel?: string;
  factores?: unknown;
  zonasExpuestas?: unknown;
}
interface AjustesPHV {
  banda?: string;
  umbralesModificados?: unknown;
  recomendaciones?: unknown;
}
interface ProtocoloRecuperacion {
  plan48h?: unknown;
  indicadoresRetorno?: unknown;
  ejerciciosComplementarios?: unknown;
}

// ─── componente principal ───────────────────────────────────────────────────

export default function FatigueReportView({ report }: { report: Record<string, unknown> }) {
  const { t } = useTranslation();

  const estado = (report.estadoActual as EstadoActual | undefined) ?? {};
  const carga = (report.cargaACWR as CargaACWR | undefined) ?? {};
  const riesgo = (report.riesgoLesion as RiesgoLesion | undefined) ?? {};
  const phv = (report.ajustesPHV as AjustesPHV | undefined) ?? {};
  const recup = (report.protocoloRecuperacion as ProtocoloRecuperacion | undefined) ?? {};
  const resumen = report.resumenEjecutivo as string | undefined;

  const indice = typeof estado.indice === "number" ? estado.indice : undefined;
  const indexTone = toneForIndex(indice);
  const barPct = typeof indice === "number" ? Math.max(0, Math.min(100, indice)) : 0;

  const senales = estado["señalesPosturales"] ?? estado.senalesPosturales;
  const acwrValor = carga.valor ?? null;
  const TrendIcon = trendIcon(carga.tendencia);

  const hasAny =
    indice !== undefined ||
    estado.severidad ||
    (Array.isArray(estado.indicadores) && estado.indicadores.length > 0) ||
    carga.zona ||
    riesgo.nivel ||
    phv.banda ||
    resumen;

  if (!hasAny) {
    return <p className="text-xs text-muted-foreground italic">{t("fatigueReport.noData")}</p>;
  }

  return (
    <div className="space-y-4">
      {/* Resumen ejecutivo */}
      {resumen && (
        <div className="rounded-xl bg-primary/10 border border-primary/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-primary font-bold mb-1">
            {t("fatigueReport.executiveSummary")}
          </div>
          <p className="text-xs text-foreground leading-relaxed">{resumen}</p>
        </div>
      )}

      {/* 1 · Estado actual de fatiga */}
      <Section heading={t("fatigueReport.currentState")} Icon={HeartPulse} color="text-primary">
        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
              {t("fatigueReport.fatigueIndex")}
            </div>
            {/* Sin índice se dice «no calculado» (el motivo va en «no evaluado»); nunca un guion. */}
            {indice !== null && indice !== undefined ? (
              <div className={`font-display font-bold text-4xl leading-none ${indexTone.text}`}>
                {indice}
                <span className="text-sm text-muted-foreground font-normal">/100</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic">{t("fatigueReport.notCalculated")}</div>
            )}
          </div>
          {estado.severidad && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                {t("fatigueReport.severity")}
              </div>
              <Chip label={estado.severidad} tone={toneForLevel(estado.severidad)} />
            </div>
          )}
        </div>
        {indice !== undefined && (
          <div className="h-2 w-full rounded-full bg-secondary/60 overflow-hidden mb-3">
            <div
              className={`h-full rounded-full ${indexTone.bg} ${indexTone.border} border`}
              style={{ width: `${barPct}%` }}
            />
          </div>
        )}
        <div className="space-y-3">
          <BulletList heading={t("fatigueReport.indicators")} items={estado.indicadores} color="text-foreground/70" />
          <BulletList heading={t("fatigueReport.posturalSigns")} items={senales} color="text-foreground/70" />
        </div>
      </Section>

      {/* 2 · Carga (ACWR) */}
      <Section heading={t("fatigueReport.workload")} Icon={Gauge} color="text-electric">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
              {t("fatigueReport.acwrValue")}
            </div>
            <div className="font-display font-bold text-2xl text-foreground leading-none">
              {acwrValor !== null && acwrValor !== undefined ? acwrValor : <span className="text-sm text-muted-foreground italic font-normal">{t("fatigueReport.notCalculated")}</span>}
            </div>
          </div>
          {carga.zona && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                {t("fatigueReport.zone")}
              </div>
              <Chip label={carga.zona} tone={toneForLevel(carga.zona)} />
            </div>
          )}
          {carga.tendencia && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                {t("fatigueReport.trend")}
              </div>
              <div className="inline-flex items-center gap-1 text-xs text-foreground font-semibold">
                <TrendIcon size={14} className="text-muted-foreground" />
                {carga.tendencia}
              </div>
            </div>
          )}
        </div>
        {carga.recomendacionProximaSesion && (
          <div className="rounded-lg bg-secondary/50 border-l-2 border-electric p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-electric font-bold mb-0.5">
              {t("fatigueReport.nextSessionRecommendation")}
            </div>
            <p className="text-xs text-foreground leading-relaxed">{carga.recomendacionProximaSesion}</p>
          </div>
        )}
      </Section>

      {/* 3 · Riesgo de lesión */}
      <Section heading={t("fatigueReport.injuryRisk")} Icon={ShieldAlert} color="text-amber-400">
        {riesgo.nivel && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
              {t("fatigueReport.riskLevel")}
            </div>
            <Chip label={riesgo.nivel} tone={toneForLevel(riesgo.nivel)} />
          </div>
        )}
        <div className="space-y-3">
          <BulletList heading={t("fatigueReport.riskFactors")} items={riesgo.factores} color="text-foreground/70" />
          <ChipRow heading={t("fatigueReport.exposedZones")} items={riesgo.zonasExpuestas} />
        </div>
      </Section>

      {/* 4 · Ajustes PHV · moat (maduración biológica) */}
      <Section heading={t("fatigueReport.phvAdjustments")} Icon={Dna} color="text-green-400">
        {phv.banda && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
              {t("fatigueReport.maturityBand")}
            </div>
            {/* La banda de maduración NO es un nivel de riesgo: tono neutro. Antes estaba
                fijo en verde → "unknown"/"sin datos" (informe bloqueado) se leía como "OK". */}
            <Chip label={phv.banda} tone={toneForLevel(phv.banda)} />
          </div>
        )}
        <div className="space-y-3">
          <BulletList heading={t("fatigueReport.modifiedThresholds")} items={phv.umbralesModificados} color="text-green-400/80" />
          <BulletList heading={t("fatigueReport.recommendations")} items={phv.recomendaciones} color="text-green-400/80" />
        </div>
      </Section>

      {/* 5 · Protocolo de recuperación */}
      <Section heading={t("fatigueReport.recoveryProtocol")} Icon={Activity} color="text-primary">
        <div className="space-y-3">
          <BulletList heading={t("fatigueReport.plan48h")} items={recup.plan48h} color="text-foreground/70" />
          <BulletList heading={t("fatigueReport.returnIndicators")} items={recup.indicadoresRetorno} color="text-foreground/70" />
          <ChipRow heading={t("fatigueReport.complementaryExercises")} items={recup.ejerciciosComplementarios} />
        </div>
      </Section>
    </div>
  );
}
