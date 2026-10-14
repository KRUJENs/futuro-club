/**
 * VITAS · Pipeline Orchestrator (refactor v2 · Sprint 3 día 4)
 * POST /api/agents/pipeline-orchestrator
 *
 * Llamado por modal-callback cuando Modal termina de procesar el vídeo.
 *
 * Body: { analysisId: string }
 *
 * Flujo:
 *   1. Lee analysis (con biomechanics + keypoints) desde BBDD
 *   2. Lee player + última anthropometrics (para PHV)
 *   3. Calcula deterministas: VSI + similarity (PHV ya está cacheado en anthro)
 *   4. Dispara los 6 reportes Claude en PARALELO
 *   5. Persiste cada reporte en `reports` table con prompt_version
 *   6. Marca analysis status='completed'
 *   7. Envía email "Análisis listo" via Resend
 */

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { successResponse, errorResponse } from "../_lib/apiResponse";
import { createClient } from "@supabase/supabase-js";
import { RESEND_FROM } from "../_lib/email";
import { findActiveParentalConsent } from "../_lib/parentalConsent";
import { deriveSimMetrics } from "../_lib/simMetrics";
import { normalizeLocale, localeSchema, pickLocale, type ReportLocale } from "../../src/lib/shared/locale";
import { resolveCategory } from "../../src/lib/shared/category";
import { gateAnthropometricsRow } from "../../src/lib/phv/phvGate";
import { maturationKnown } from "../../src/lib/fatigue/phvFatigueAdjuster";
import { fatigueRowForAgents } from "../../src/lib/fatigue/fatigueRowGate";
import { injuryRiskValue, type InjuryRiskReport } from "../../src/lib/injury/injuryRiskTypes";
import {
  buildVsiSubscores,
  gateVsiComposite,
  vsiMeasuredFraction,
  fatigueIsReliable,
} from "../_lib/metricsProvenance";
import {
  VSI_WEIGHTS as VIDEO_VSI_WEIGHTS,
  VSI_TIERS as VIDEO_VSI_TIERS,
  determineTier as videoVsiTier,
} from "./_vsi-calculator";

export const config = { runtime: "edge" };

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL)!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL =
  process.env.VITAS_PUBLIC_URL ??
  process.env.VITAS_API_BASE_URL ??
  `https://${process.env.VERCEL_URL ?? "futuro-club.vercel.app"}`;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? process.env.CRON_SECRET ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

const orchestratorSchema = z.object({
  analysisId: z.string().uuid(),
  /** Sprint 8: analysis mode — determines which report agents to invoke */
  mode: z.enum(["player", "team", "rival"]).optional().default("player"),
  /** Sprint 8: team/rival analysis data (only present in team/rival modes) */
  teamAnalysis: z.record(z.unknown()).optional(),
  /** FASE 5 · idioma de los reportes (default es); se propaga a todos los agentes */
  locale: localeSchema.optional(),
  /** C1 multi-categoría · override explícito; si falta se deriva de la edad */
  category: z.enum(["youth", "senior"]).optional(),
});

/** Default report agents for individual player analysis */
const PLAYER_REPORT_AGENTS = [
  { name: "player-report", endpoint: "/api/agents/player-report", model: "sonnet" },
  { name: "lab-biomechanics", endpoint: "/api/agents/lab-biomechanics-report", model: "sonnet" },
  { name: "dna-profile", endpoint: "/api/agents/dna-profile", model: "haiku" },
  { name: "best-match", endpoint: "/api/agents/best-match-narrator", model: "haiku" },
  { name: "projection", endpoint: "/api/agents/projection-report", model: "haiku" },
  { name: "development-plan", endpoint: "/api/agents/development-plan", model: "haiku" },
  { name: "fatigue-report", endpoint: "/api/agents/fatigue-report", model: "haiku" },
  { name: "injury-risk-report", endpoint: "/api/agents/injury-risk-report", model: "haiku" },
  { name: "valuation-report", endpoint: "/api/agents/valuation-report", model: "sonnet" },
] as const;

/** Team-mode report agents (Sprint 8) */
const TEAM_REPORT_AGENTS = [
  { name: "team-report", endpoint: "/api/agents/team-report", model: "haiku" },
] as const;

/** Rival-mode report agents (Sprint 8) */
const RIVAL_REPORT_AGENTS = [
  { name: "rival-scout-report", endpoint: "/api/agents/rival-scout-report", model: "haiku" },
] as const;

const REPORT_AGENTS = PLAYER_REPORT_AGENTS;

type ReportName = (typeof REPORT_AGENTS)[number]["name"];

async function callInternal(endpoint: string, payload: unknown) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${PUBLIC_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return { success: res.ok, data, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "fetch_failed",
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Copy del email «análisis listo» por idioma (7 idiomas del LANGUAGE_REGISTRY).
 * Es texto PLANTILLADO (no LLM), así que se traduce aquí; `pickLocale` degrada a
 * "es" si faltara un idioma. Los nombres de producto (Player Report, LAB
 * Biomechanics, Best-Match, VSI) se mantienen tal cual. Antes el email iba SIEMPRE
 * en español, también a familias con la UI en otro idioma.
 */
interface EmailCopy {
  title: string;
  ready: (name: string) => string;
  vsiNa: string;
  /** Abreviatura para el número gigante del VSI cuando está bloqueado (null). */
  vsiNaShort: string;
  vsiPartial: string;
  vsiFull: string;
  receivedPartial: (n: number, total: number) => string;
  receivedFull: (n: number) => string;
  itemPlayer: string;
  itemLab: string;
  itemDna: string;
  /** Nombre localizado del informe de ADN (la UI lo traduce: Football DNA, etc.). */
  itemDnaName: string;
  itemBest: string;
  itemProjection: string;
  itemPlan: string;
  cta: string;
  subject: (name: string, vsi: number | null) => string;
}

const EMAIL_ES: EmailCopy = {
  title: "Tu análisis está listo",
  ready: (n) => `El análisis biomecánico de <strong>${n}</strong> ya está disponible.`,
  vsiNa: "no disponible en este análisis",
  vsiNaShort: "N/D",
  vsiPartial: "parcialmente estimado · algunas dimensiones son estimaciones",
  vsiFull: "/100 · sobre todos los reportes",
  receivedPartial: (n, t) => `Has recibido <strong>${n} de ${t} reportes</strong> (algunos no se pudieron generar o usan datos de respaldo):`,
  receivedFull: (n) => `Has recibido <strong>${n} reportes profesionales</strong>:`,
  itemPlayer: "resumen ejecutivo",
  itemLab: "análisis técnico",
  itemDna: "perfil de juego",
  itemDnaName: "ADN Futbolístico",
  itemBest: "comparable profesional",
  itemProjection: "Proyección 3 años · curva PHV",
  itemPlan: "Plan de desarrollo · 12 semanas",
  cta: "Ver reportes →",
  subject: (n, v) => `VITAS · Análisis de ${n} listo${v != null ? ` · VSI ${v}` : ""}`,
};

const EMAIL_COPY: Partial<Record<ReportLocale, EmailCopy>> = {
  es: EMAIL_ES,
  "es-419": EMAIL_ES,
  en: {
    title: "Your analysis is ready",
    ready: (n) => `The biomechanical analysis of <strong>${n}</strong> is now available.`,
    vsiNa: "not available in this analysis",
    vsiNaShort: "N/A",
    vsiPartial: "partially estimated · some dimensions are estimates",
    vsiFull: "/100 · across all reports",
    receivedPartial: (n, t) => `You received <strong>${n} of ${t} reports</strong> (some could not be generated or use fallback data):`,
    receivedFull: (n) => `You received <strong>${n} professional reports</strong>:`,
    itemPlayer: "executive summary",
    itemLab: "technical analysis",
    itemDna: "playing profile",
    itemDnaName: "Football DNA",
    itemBest: "professional comparable",
    itemProjection: "3-year projection · PHV curve",
    itemPlan: "Development plan · 12 weeks",
    cta: "View reports →",
    subject: (n, v) => `VITAS · ${n}'s analysis is ready${v != null ? ` · VSI ${v}` : ""}`,
  },
  it: {
    title: "La tua analisi è pronta",
    ready: (n) => `L'analisi biomeccanica di <strong>${n}</strong> è ora disponibile.`,
    vsiNa: "non disponibile in questa analisi",
    vsiNaShort: "N/D",
    vsiPartial: "parzialmente stimato · alcune dimensioni sono stime",
    vsiFull: "/100 · su tutti i report",
    receivedPartial: (n, t) => `Hai ricevuto <strong>${n} di ${t} report</strong> (alcuni non sono stati generati o usano dati di riserva):`,
    receivedFull: (n) => `Hai ricevuto <strong>${n} report professionali</strong>:`,
    itemPlayer: "riepilogo esecutivo",
    itemLab: "analisi tecnica",
    itemDna: "profilo di gioco",
    itemDnaName: "DNA calcistico",
    itemBest: "comparabile professionale",
    itemProjection: "Proiezione a 3 anni · curva PHV",
    itemPlan: "Piano di sviluppo · 12 settimane",
    cta: "Vedi i report →",
    subject: (n, v) => `VITAS · Analisi di ${n} pronta${v != null ? ` · VSI ${v}` : ""}`,
  },
  de: {
    title: "Deine Analyse ist fertig",
    ready: (n) => `Die biomechanische Analyse von <strong>${n}</strong> ist jetzt verfügbar.`,
    vsiNa: "in dieser Analyse nicht verfügbar",
    vsiNaShort: "k. A.",
    vsiPartial: "teilweise geschätzt · einige Dimensionen sind Schätzungen",
    vsiFull: "/100 · über alle Berichte",
    receivedPartial: (n, t) => `Du hast <strong>${n} von ${t} Berichten</strong> erhalten (einige konnten nicht erstellt werden oder nutzen Ersatzdaten):`,
    receivedFull: (n) => `Du hast <strong>${n} professionelle Berichte</strong> erhalten:`,
    itemPlayer: "Zusammenfassung",
    itemLab: "technische Analyse",
    itemDna: "Spielprofil",
    itemDnaName: "Fußball-DNA",
    itemBest: "professioneller Vergleich",
    itemProjection: "3-Jahres-Prognose · PHV-Kurve",
    itemPlan: "Entwicklungsplan · 12 Wochen",
    cta: "Berichte ansehen →",
    subject: (n, v) => `VITAS · Analyse von ${n} fertig${v != null ? ` · VSI ${v}` : ""}`,
  },
  fr: {
    title: "Ton analyse est prête",
    ready: (n) => `L'analyse biomécanique de <strong>${n}</strong> est maintenant disponible.`,
    vsiNa: "non disponible dans cette analyse",
    vsiNaShort: "N/D",
    vsiPartial: "partiellement estimé · certaines dimensions sont des estimations",
    vsiFull: "/100 · sur l'ensemble des rapports",
    receivedPartial: (n, t) => `Tu as reçu <strong>${n} rapports sur ${t}</strong> (certains n'ont pas pu être générés ou utilisent des données de secours) :`,
    receivedFull: (n) => `Tu as reçu <strong>${n} rapports professionnels</strong> :`,
    itemPlayer: "résumé exécutif",
    itemLab: "analyse technique",
    itemDna: "profil de jeu",
    itemDnaName: "ADN footballistique",
    itemBest: "comparable professionnel",
    itemProjection: "Projection à 3 ans · courbe PHV",
    itemPlan: "Plan de développement · 12 semaines",
    cta: "Voir les rapports →",
    subject: (n, v) => `VITAS · Analyse de ${n} prête${v != null ? ` · VSI ${v}` : ""}`,
  },
  nl: {
    title: "Je analyse is klaar",
    ready: (n) => `De biomechanische analyse van <strong>${n}</strong> is nu beschikbaar.`,
    vsiNa: "niet beschikbaar in deze analyse",
    vsiNaShort: "n.v.t.",
    vsiPartial: "deels geschat · sommige dimensies zijn schattingen",
    vsiFull: "/100 · over alle rapporten",
    receivedPartial: (n, t) => `Je hebt <strong>${n} van ${t} rapporten</strong> ontvangen (sommige konden niet worden gegenereerd of gebruiken reservegegevens):`,
    receivedFull: (n) => `Je hebt <strong>${n} professionele rapporten</strong> ontvangen:`,
    itemPlayer: "samenvatting",
    itemLab: "technische analyse",
    itemDna: "speelprofiel",
    itemDnaName: "Voetbal-DNA",
    itemBest: "professionele vergelijking",
    itemProjection: "3-jaarsprojectie · PHV-curve",
    itemPlan: "Ontwikkelplan · 12 weken",
    cta: "Rapporten bekijken →",
    subject: (n, v) => `VITAS · Analyse van ${n} klaar${v != null ? ` · VSI ${v}` : ""}`,
  },
};

async function sendCompletionEmail(
  to: string,
  playerName: string,
  vsi: number | null,
  analysisLink: string,
  opts: { reportsGenerated: number; reportsTotal: number; partiallyEstimated: boolean; locale?: ReportLocale } = {
    reportsGenerated: 6,
    reportsTotal: 6,
    partiallyEstimated: false,
  },
) {
  if (!RESEND_API_KEY) return false;

  // Idioma del destinatario (el de los informes). `pickLocale` degrada a "es".
  const c = pickLocale(opts.locale ?? "es", EMAIL_COPY);

  // Honesto: nunca "VSI 0" cuando no hay VSI; y reflejar reportes parciales.
  const vsiDisplay = vsi != null ? String(vsi) : c.vsiNaShort;
  const vsiNote = vsi == null ? c.vsiNa : opts.partiallyEstimated ? c.vsiPartial : c.vsiFull;
  const partial = opts.reportsGenerated < opts.reportsTotal;
  const reportsLine = partial
    ? c.receivedPartial(opts.reportsGenerated, opts.reportsTotal)
    : c.receivedFull(opts.reportsGenerated);

  const html = `
<!DOCTYPE html>
<html><body style="font-family:system-ui;color:#0F172A;background:#F4F7FB;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #E2E8F0;">
    <h1 style="font-size:22px;color:#0066CC;margin:0 0 16px;">VITAS · ${c.title}</h1>
    <p>${c.ready(playerName)}</p>
    <div style="background:linear-gradient(135deg,#0066CC,#B82BD9);color:#fff;padding:24px;border-radius:14px;text-align:center;margin:24px 0;">
      <div style="font-size:14px;opacity:0.9;letter-spacing:0.1em;text-transform:uppercase;">VSI Score</div>
      <div style="font-size:56px;font-weight:700;line-height:1;margin:8px 0;">${vsiDisplay}</div>
      <div style="font-size:13px;opacity:0.9;">${vsiNote}</div>
    </div>
    <p>${reportsLine}</p>
    <ul style="line-height:1.8;color:#475569;">
      <li>📊 <strong>Player Report</strong> · ${c.itemPlayer}</li>
      <li>🦴 <strong>LAB Biomechanics</strong> · ${c.itemLab}</li>
      <li>🧬 <strong>${c.itemDnaName}</strong> · ${c.itemDna}</li>
      <li>🎯 <strong>Best-Match</strong> · ${c.itemBest}</li>
      ${vsi != null ? `<li>📈 <strong>${c.itemProjection}</strong></li>` : ""}
      <li>📋 <strong>${c.itemPlan}</strong></li>
    </ul>
    <p style="text-align:center;margin:32px 0;">
      <a href="${analysisLink}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#0066CC,#B82BD9);color:#fff;text-decoration:none;border-radius:100px;font-weight:600;">
        ${c.cta}
      </a>
    </p>
    <p style="font-size:12px;color:#94a3b8;text-align:center;">VITAS · Football Intelligence</p>
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: c.subject(playerName, vsi),
      html,
    }),
  });
  return res.ok;
}

/**
 * Mensaje de estado «análisis parcial» por idioma. Se guarda en
 * `analyses.status_message` y la UI (VideoUploader) lo muestra VERBATIM, así que
 * debe ir en el idioma del usuario (mismo `reportLocale` que los informes) — antes
 * salía siempre en español tras informes ya localizados. `pickLocale` degrada a es.
 */
const PARTIAL_STATUS: Partial<Record<ReportLocale, (ok: number, total: number) => string>> = {
  es: (ok, t) => `Parcial: ${ok} de ${t} informes generados`,
  "es-419": (ok, t) => `Parcial: ${ok} de ${t} informes generados`,
  en: (ok, t) => `Partial: ${ok} of ${t} reports generated`,
  it: (ok, t) => `Parziale: ${ok} di ${t} report generati`,
  de: (ok, t) => `Teilweise: ${ok} von ${t} Berichten erstellt`,
  fr: (ok, t) => `Partiel : ${ok} rapports sur ${t} générés`,
  nl: (ok, t) => `Gedeeltelijk: ${ok} van ${t} rapporten gegenereerd`,
};

export default withHandler(
  // serviceOnly: orquesta ~14 agentes Claude/Gemini + email a la familia. Lo
  // disparan cron/modal-callback/generate-reports con INTERNAL_TOKEN; nunca
  // anónimo (era abuso de coste + procesar/sobrescribir análisis de otro tenant).
  { schema: orchestratorSchema, serviceOnly: true, maxRequests: 50 },
  async ({ body }) => {
    const { analysisId, mode = "player", teamAnalysis, locale, category } = body as z.infer<typeof orchestratorSchema>;
    const startedAt = Date.now();

    // Sprint 8: select report agents based on mode
    let activeAgents: { name: string; endpoint: string; model: string }[] = mode === "team"
      ? [...PLAYER_REPORT_AGENTS, ...TEAM_REPORT_AGENTS]
      : mode === "rival"
        ? [...PLAYER_REPORT_AGENTS, ...RIVAL_REPORT_AGENTS]
        : [...PLAYER_REPORT_AGENTS];

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // ── 1. Cargar analysis + player + anthropometrics ───────────────
    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .select("*")
      .eq("id", analysisId)
      .single();

    if (aErr || !analysis) {
      return errorResponse({ code: "analysis_not_found", message: "Analysis not in DB", status: 404 });
    }

    // Idioma de los informes (registry-driven, 7 idiomas). Prioridad:
    //   1) `locale` del body — lo manda generate-reports (ruta cliente);
    //   2) `analyses.locale` (mig 064) — lo guardó finalize/webhook al encolar. Es lo
    //      ÚNICO que tienen cron y modal-callback, que solo mandan { analysisId };
    //   3) "es" (comportamiento previo).
    // Antes se ignoraba la fila y TODOS los informes asíncronos salían en español para
    // usuarios no hispanos aunque la UI estuviera en su idioma. La columna puede no
    // existir aún (pre-064): entonces es undefined → "es", sin romper nada.
    const reportLocale = normalizeLocale(
      locale ?? (analysis as { locale?: string | null }).locale ?? undefined,
    );

    // FASE 3: reportes premium gateados por plan. El orchestrator corre con service
    // token → withHandler NO lo gatea (allowServiceToken), así que lo gateamos aquí
    // para NO generar (ni pagar) features de pago a usuarios que no las tienen.
    // Dueño = analyses.user_id (mig 004).
    //   - valuation-report  → solo Club (Sonnet, la más cara)
    //   - injury-risk-report → Pro o Club (feature Pro · usageGuard injuryPrediction)
    const planGatedNames = new Set(["valuation-report", "injury-risk-report"]);
    if (activeAgents.some((a) => planGatedNames.has(a.name))) {
      let plan = "free";
      if (analysis.user_id) {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("plan,status")
          .eq("user_id", analysis.user_id)
          .maybeSingle();
        if (sub && (sub.status === "active" || sub.status === "trialing")) plan = sub.plan as string;
      }
      if (plan !== "club") {
        activeAgents = activeAgents.filter((a) => a.name !== "valuation-report");
        console.log(`[orchestrator] valuation-report omitido (plan=${plan}, requiere club)`);
      }
      if (plan !== "pro" && plan !== "club") {
        activeAgents = activeAgents.filter((a) => a.name !== "injury-risk-report");
        console.log(`[orchestrator] injury-risk-report omitido (plan=${plan}, requiere pro/club)`);
      }
    }

    const { data: player } = await supabase
      .from("players")
      .select("id, name, position, secondary_positions, foot, tenant_id")
      .eq("id", analysis.player_id)
      .single();

    // Gate único de PHV (regla del owner 28-sep): el maturity_offset/phv_category
    // de la fila solo pasan a agentes/VSI/analyses.phv si la fila es COMPLETA y su
    // edad salió de la fecha de nacimiento (age_source, migración 069). Una fila
    // antigua (edad entera) conserva sus medidas pero su PHV queda null + motivo.
    const { data: anthroRaw } = await supabase
      .from("player_latest_anthropometrics")
      .select("*")
      .eq("player_id", analysis.player_id)
      .maybeSingle();
    const anthro = gateAnthropometricsRow(anthroRaw);

    // ── 2. Calcular VSI (servicio determinista) ─────────────────────
    // Solo `physical` (biomecánica: frecuencia de zancada + asimetría) y
    // `projection` (PHV/anthro) se derivan de señales REALES del análisis.
    // technique/mental/tactical AÚN NO los mide el pipeline de visión → son
    // ESTIMACIONES placeholder, no valores medidos. Por tanto el VSI de vídeo es
    // PARCIALMENTE ESTIMADO; no debe tratarse como plenamente medido.
    // TODO(F3b): sustituir por señales reales (p.ej. scan-rate → mental) cuando
    // haya un clip de validación. Cambiar estos valores mueve el VSI en toda la
    // app (rankings/reportes/valoración) → requiere validación antes de tocarlos.
    const bm = (analysis.biomechanics ?? {}) as Record<string, number>;
    const bmPresent = bm.stride_frequency_hz != null || bm.asymmetry_pct != null;
    const sprintNorm = Math.min(100, (bm.stride_frequency_hz ?? 0) * 25);
    const asymmetryPen = 100 - Math.min(100, (bm.asymmetry_pct ?? 0) * 5);
    const physicalValue = bmPresent ? Math.round((sprintNorm + asymmetryPen) / 2) : null;
    const projectionValue = anthro?.adjusted_vsi ?? null;

    // Sub-scores como MetricResult (G4-1) + gate del compuesto (G4-2). Las 3 dims que
    // el pipeline no mide son CONSTANTE (value:null); el compuesto queda BLOQUEADO si
    // no hay ≥4/5 dimensiones reales. Ver api/_lib/metricsProvenance.ts.
    const vsiSubscores = buildVsiSubscores({ physicalValue, projectionValue });
    const vsiComposite = gateVsiComposite(vsiSubscores, VIDEO_VSI_WEIGHTS);
    const measuredFraction = vsiMeasuredFraction(vsiSubscores);
    const vsiValue = vsiComposite.value;

    const vsiWithProvenance = {
      vsi: vsiValue, // null cuando el compuesto está bloqueado (<4/5 dimensiones reales)
      blocked: vsiValue === null,
      gate_reason: vsiComposite.gate_reason,
      confidence: vsiComposite.confidence,
      tier: vsiValue != null ? videoVsiTier(vsiValue) : null,
      tierLabel: vsiValue != null ? VIDEO_VSI_TIERS[videoVsiTier(vsiValue)].label : null,
      measuredFraction,
      partiallyEstimated: measuredFraction < 1,
      subscores: vsiSubscores, // los 5 MetricResult (criterio G4-1)
    };

    // G4: sin un VSI de vídeo compuesto (bloqueado por <4/5 dimensiones reales) NO se
    // puede proyectar su curva → se OMITE el reporte de proyección, en vez de dejarlo
    // fallar con 400 en cada análisis y marcar todo run como completed_partial. Mismo
    // patrón de omisión honesta que valuation-report arriba.
    if (vsiWithProvenance.blocked) {
      activeAgents = activeAgents.filter((a) => a.name !== "projection");
    }

    // docx #14 · Observaciones DIRECTAS del vídeo (extraídas UNA vez: las usan la
    // derivación del comparable Y el sharedContext de los agentes). Gated en ORIGEN
    // (P1). Gemini: biomechanics.gemini_observation; cliente: analysis.client_metrics.
    const geminiObs =
      (analysis.biomechanics as { gemini_observation?: Record<string, unknown> } | null)
        ?.gemini_observation ?? null;
    const clientMetrics =
      (analysis as { client_metrics?: { eventSummary?: unknown; physicalMetrics?: unknown } | null })
        .client_metrics ?? null;
    const videoObservations =
      geminiObs || clientMetrics?.eventSummary || clientMetrics?.physicalMetrics
        ? {
            source: geminiObs ? "gemini" : "client",
            gemini: geminiObs,
            eventSummary: clientMetrics?.eventSummary ?? null,
            physicalMetrics: clientMetrics?.physicalMetrics ?? null,
          }
        : null;

    // docx #14 · P3 · Comparable profesional DERIVADO de eventos observados (antes
    // eran constantes 65/60/55 → violaba invariante #1). Si no hay eventos → null →
    // abstención (no se fabrica un match). Solo alimenta similarity, NO el VSI compuesto.
    const simDerived = deriveSimMetrics(videoObservations, physicalValue);

    // Sin comparable derivable → se omite también el narrador best-match (no tiene
    // nada que narrar honestamente), igual que projection cuando el VSI está bloqueado.
    if (!simDerived) {
      activeAgents = activeAgents.filter((a) => a.name !== "best-match");
    }

    // ── 3a. Scan rate detection (NUEVO Sprint 4) ────────────────────
    // Si Modal devolvió keypoints, calcular scan rate del jugador
    let scanResult: unknown = null;
    const keypointsRaw = (analysis as { keypoints?: unknown[] }).keypoints;
    if (Array.isArray(keypointsRaw) && keypointsRaw.length >= 10) {
      const ageGroup = anthro?.chronological_age
        ? `sub-${Math.floor(anthro.chronological_age / 2) * 2}`
        : "default";
      const scanRes = await callInternal("/api/agents/scan-detector", {
        playerId: analysis.player_id,
        frames: keypointsRaw,
        ageGroup,
      });
      if (scanRes.success) {
        scanResult = scanRes.data?.data ?? scanRes.data;
      }
    }

    // ── 3b. Comparable profesional (best-match) ──────────────────────
    // P3: si simDerived es null (sin eventos observados) → NO se llama a similarity y
    // se ABSTIENE (no se fabrica un match de 6 dims con constantes). Si hay eventos, se
    // llama con las métricas DERIVADAS y el comparable se marca derivado + baja confianza.
    let similarityRes: Awaited<ReturnType<typeof callInternal>> = {
      success: false,
      error: "abstained_no_observations",
      latencyMs: 0,
    };
    let similarity: unknown;
    if (simDerived) {
      similarityRes = await callInternal("/api/agents/player-similarity", {
        metrics: simDerived.metrics,
        position: player?.position ?? "MID",
        youthAge: anthro?.chronological_age,
        phvOffset: anthro?.maturity_offset,
      });
      const rawSimilarity = similarityRes.success ? similarityRes.data?.data ?? similarityRes.data : null;
      similarity =
        rawSimilarity && typeof rawSimilarity === "object"
          ? {
              ...(rawSimilarity as Record<string, unknown>),
              // Comparable DERIVADO de eventos observados, NO medición validada de
              // técnica/mental/táctica → baja confianza (más baja si <3 dims salen de
              // un ratio real observado).
              provenance: "derived_from_observed_events",
              lowConfidence: measuredFraction < 0.5 || simDerived.ratioDerivedDims < 3,
            }
          : rawSimilarity;
    } else {
      similarity = {
        abstained: true,
        gate_reason:
          "sin eventos observados en el vídeo → no se genera comparable (el pipeline no mide técnica/mental/táctica de forma validada; inv #1/#3)",
      };
    }

    // ── 4. Persistir resultados deterministas en analysis ───────────

    await supabase
      .from("analyses")
      .update({
        vsi: vsiWithProvenance,
        phv: anthro
          ? {
              chronological_age: anthro.chronological_age,
              offset: anthro.maturity_offset,
              category: anthro.phv_category,
              ...(anthro.phv_trusted ? {} : { gate_reason: anthro.phv_gate_reason }),
            }
          : null,
        similarity,
      })
      .eq("id", analysis.id);

    // ── 4b. Lookup fatigue session for fatigue-report agent (Sprint 7) ──
    let fatigueReport: unknown = null;
    // Fila CRUDA (solo para decidir aquí); a los agentes va fatigueRowForAgents (P1 bloque 4b).
    let fatigueRow: Record<string, unknown> | null = null;
    let fatigueHistory: unknown[] = [];
    try {
      const { data: fatigueSessions } = await supabase
        .from("fatigue_sessions")
        .select("*")
        .eq("player_id", analysis.player_id)
        .order("session_date", { ascending: false })
        .limit(10);

      if (fatigueSessions && fatigueSessions.length > 0) {
        fatigueRow = fatigueSessions[0] as Record<string, unknown>;
        fatigueReport = fatigueRowForAgents(fatigueRow);
        // P1 bloque 4 (revisión del PR #315): el ÍNDICE de una sesión sin maduración
        // registrada no viaja (dependía de umbrales que no corresponden); la sesión sí
        // cuenta y su carga también. Mismo predicado que dropoutAssessment (inv #7).
        fatigueHistory = fatigueSessions.map((s: Record<string, unknown>) => ({
          date: s.session_date,
          load: s.total_load,
          fatigueIndex: maturationKnown(s.maturation_band, s.phv_offset) ? s.fatigue_index : null,
          acwrValue: s.acwr_value,
        }));
      }
    } catch {
      // Fatigue data is optional — pipeline continues without it
    }

    // ── 4b-bis. Historial de lesiones + snapshots de VSI ──────────────
    // Alimentan al injury calculator (historial) y al valuation model (VSI trend).
    let injuryHistory: Array<{ type: string; severity: string; daysOut: number | null; date: string; bodyPart?: string }> = [];
    let daysSinceLastInjury: number | null = null;
    let vsiHistory: Array<{ date: string; vsi: number }> = [];
    try {
      const { data: injuries } = await supabase
        .from("player_injuries")
        .select("injury_type, severity, days_out, injury_date, body_part")
        .eq("player_id", analysis.player_id)
        .order("injury_date", { ascending: false })
        .limit(20);
      if (injuries && injuries.length > 0) {
        injuryHistory = injuries.map((i: Record<string, unknown>) => ({
          type: String(i.injury_type ?? "other"),
          severity: String(i.severity ?? "minor"),
          daysOut: typeof i.days_out === "number" ? i.days_out : null,
          date: String(i.injury_date ?? ""),
          bodyPart: i.body_part ? String(i.body_part) : undefined,
        }));
        const lastDate = injuries[0]?.injury_date as string | undefined;
        if (lastDate) {
          daysSinceLastInjury = Math.max(
            0,
            Math.round((Date.now() - new Date(lastDate).getTime()) / 86_400_000),
          );
        }
      }
    } catch {
      // Historial de lesiones opcional — la pipeline continúa
    }
    try {
      const { data: snapshots } = await supabase
        .from("player_metric_snapshots")
        .select("snapshot_date, vsi")
        .eq("player_id", analysis.player_id)
        .not("vsi", "is", null)
        .order("snapshot_date", { ascending: false })
        .limit(12);
      if (snapshots && snapshots.length > 0) {
        vsiHistory = snapshots
          .filter((s: Record<string, unknown>) => typeof s.vsi === "number")
          .map((s: Record<string, unknown>) => ({
            date: String(s.snapshot_date ?? ""),
            vsi: s.vsi as number,
          }));
      }
    } catch {
      // Snapshots de VSI opcionales — la pipeline continúa
    }

    // ── 4c. Injury risk calculator (deterministic, Sprint 10) ─────────
    // Gate de fiabilidad: ACWR necesita ~4 semanas de carga. Con menos sesiones,
    // pasar acwr/fatiga crudos produciría un riesgo de lesión "sólido" con datos
    // insuficientes → se pasan como null y el calculador marca "datos insuficientes".
    // P1 bloque 4b: zona e índice solo con historial suficiente Y la maduración de esa
    // sesión registrada (la zona dependía de umbrales por maduración). La biomecánica
    // llega del cliente en camelCase (antes se leía en snake_case: siempre null).
    const fatigueReliable = fatigueIsReliable(fatigueHistory.length);
    const fr = fatigueRow;
    const fatigueUsable = fatigueReliable && !!fr && maturationKnown(fr.maturation_band, fr.phv_offset);
    const bmRaw = (analysis.biomechanics ?? {}) as Record<string, unknown>;
    const bmNum = (...keys: string[]): number | null => {
      for (const k of keys) {
        const v = bmRaw[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return null;
    };
    let injuryRiskResult: InjuryRiskReport | null = null;
    try {
      const injuryCalcRes = await callInternal("/api/agents/injury-risk-calculator", {
        playerId: analysis.player_id,
        age: anthro?.chronological_age ?? null,
        // Offset de la PUERTA (gateAnthropometricsRow): null si el PHV está bloqueado.
        phvOffset: anthro?.maturity_offset ?? null,
        acwrValue: fatigueUsable ? (fr?.acwr_value ?? null) : null,
        acwrZone: fatigueUsable ? (fr?.acwr_zone ?? null) : null,
        fatigueIndex: fatigueUsable ? (fr?.fatigue_index ?? null) : null,
        biomechanicsInjuryRisk: bmNum("injuryRisk", "injury_risk"),
        asymmetryPct: bmNum("asymmetryPct", "asymmetry_pct"),
        biomechanicsFrames: bmNum("framesAnalyzed", "frames_analyzed"),
        biomechanicsConfidence: bmNum("confidence"),
        injuryHistory,
        daysSinceLastInjury,
        sessionsLast28Days: fatigueHistory.length,
      });
      if (injuryCalcRes.success) {
        injuryRiskResult = (injuryCalcRes.data?.data?.report ?? null) as InjuryRiskReport | null;
      }
    } catch {
      // Injury risk is non-blocking — pipeline continues
    }

    // ── 4d. Valuation model (deterministic, Sprint 12) ────────────────
    let valuationResult: unknown = null;
    try {
      const valuationRes = await callInternal("/api/agents/valuation-model", {
        playerId: analysis.player_id,
        age: anthro?.chronological_age ?? null,
        position: player?.position ?? null,
        currentVsi: vsiValue,
        vsiHistory,
        phvOffset: anthro?.maturity_offset ?? null,
        phvCategory: anthro?.phv_category ?? null,
        // Riesgo COMPUESTO real o null (antes overallRisk, que siempre traía un número).
        injuryRisk: injuryRiskValue(injuryRiskResult),
        injuryCategory: injuryRiskResult?.category ?? null,
        positionFitScores: [],
        sessionCount: fatigueHistory.length,
        analysisCount: 1, // Single analysis context
        competitiveLevel: "academy",
      });
      if (valuationRes.success) {
        valuationResult = valuationRes.data?.data?.report ?? valuationRes.data?.data ?? null;
      }
    } catch {
      // Valuation is non-blocking — pipeline continues
    }

    // ── 5. Disparar 9 reportes LLM EN PARALELO ──────────────────────
    // Posición jugada en este video específico · default a la principal
    const playedPosition =
      (analysis as { played_position?: string | null }).played_position
      ?? player?.position
      ?? null;

    // docx #14 · videoObservations + simDerived ya se calcularon arriba (junto a la
    // derivación del comparable) para no duplicar la extracción (invariante #7).

    const sharedContext = {
      playerId: analysis.player_id,
      videoId: analysis.video_id,
      analysisId: analysis.id,
      biomechanics: analysis.biomechanics,
      videoObservations, // docx #14 · observaciones directas del vídeo (gated en origen)
      vsiHistory, // tendencia VSI histórica → los narradores pueden citar evolución
      scanning: scanResult, // NUEVO Sprint 4 · scan rate detection
      phv: anthro,
      vsi: vsiWithProvenance, // objeto honesto: vsi:null si bloqueado + subscores MetricResult
      // Similarity ETIQUETADA (provenance:"derived_from_observed_events" + lowConfidence,
      // o {abstained,gate_reason}) para que el narrador/UI puedan matizar que el
      // comparable no es una medición validada (revisión #178). No la cruda.
      similarity,
      playerContext: {
        chronologicalAge: anthro?.chronological_age ?? 12,
        position: player?.position,
        secondaryPositions: (player as { secondary_positions?: string[] } | null)?.secondary_positions ?? [],
        foot: (player as { foot?: string } | null)?.foot,
      },
      // Contexto del video específico · agentes lo usan para análisis polivalente
      videoContext: {
        videoId: analysis.video_id,
        playedPosition,
        analyzedAt: (analysis as { completed_at?: string }).completed_at ?? new Date().toISOString(),
      },
      // Sprint 7: fatigue data for fatigue-report agent
      fatigueReport,
      fatigueHistory,
      // Sprint 10: injury risk calculator result (deterministic)
      injuryRisk: injuryRiskResult,
      // Sprint 12: valuation model result (deterministic)
      valuationModel: valuationResult,
      // Sprint 8: team/rival analysis data (if mode is team or rival)
      teamAnalysis: teamAnalysis ?? null,
      analysisMode: mode,
      // FASE 5 · idioma propagado a todos los agentes de reporte
      locale: reportLocale,
      // C1 multi-categoría · override explícito o derivada de la edad real del
      // jugador (anthro). Default youth (framing más protegido) si no hay datos.
      category: resolveCategory({ age: anthro?.chronological_age, category }),
    };

    const reportPromises = activeAgents.map((agent) =>
      callInternal(agent.endpoint, sharedContext).then((r) => ({
        name: agent.name,
        model: agent.model,
        ...r,
      }))
    );

    const reports = await Promise.all(reportPromises);
    const successfulReports = reports.filter((r) => r.success);

    // ── 6. Persistir cada reporte exitoso en `reports` table ────────
    // Si el agente respondió con fallback/mock, propagar el flag DENTRO del
    // content — antes se despojaba el envelope (source/fallback/model:"mock")
    // y la UI mostraba datos ficticios como reales.
    const reportInserts = successfulReports.map((r) => {
      const envelope = (r.data?.data ?? {}) as Record<string, unknown>;
      let content = (envelope.report ?? r.data ?? {}) as Record<string, unknown>;
      const isFallback =
        envelope.fallback === true ||
        envelope.model === "mock" ||
        (typeof envelope.source === "string" && envelope.source.startsWith("fallback"));
      if (isFallback && content && typeof content === "object") {
        content = { ...content, _fallback: true, _source: (envelope.source as string) ?? "fallback" };
      }
      return {
        tenant_id: analysis.tenant_id,
        analysis_id: analysis.id,
        player_id: analysis.player_id,
        report_type: r.name,
        content,
        prompt_version: r.data?.data?.promptVersion ?? "v1.0.0",
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        cost_eur: 0,
        is_latest: true,
      };
    });

    if (reportInserts.length > 0) {
      await supabase.from("reports").insert(reportInserts);
    }

    // ── 6a. Flywheel: muestra etiquetada del dataset propietario (Sprint 5.3) ──
    // Base legal: ≥14 años (not_required) o consent parental verificado. No bloqueante.
    try {
      const dsAge = typeof anthro?.chronological_age === "number" ? anthro.chronological_age : null;
      let consentBasis: "not_required" | "parental_verified" | null =
        dsAge != null && dsAge >= 14 ? "not_required" : null;
      if (!consentBasis) {
        // Fuente canónica ÚNICA del consentimiento parental (inv #7, B6 del PR #308):
        // verificado por el tutor con el token de su email, no retirado. Antes se leía
        // aquí sin `withdrawn_at IS NULL` y sin la evidencia del servidor. Un fallo de la
        // base lanza → el catch de abajo no escribe la muestra (falla cerrado).
        if (await findActiveParentalConsent(String(analysis.player_id))) consentBasis = "parental_verified";
      }
      if (consentBasis) {
        await supabase.from("labeled_datasets").upsert(
          {
            tenant_id: analysis.tenant_id,
            analysis_id: analysis.id,
            player_id: analysis.player_id,
            chronological_age: dsAge,
            biological_age: anthro?.biological_age ?? null,
            phv_offset: anthro?.maturity_offset ?? null,
            phv_category: anthro?.phv_category ?? null,
            position: player?.position ?? null,
            features: {
              biomechanics: analysis.biomechanics ?? null,
              scanning: scanResult ?? null,
              similarity: similarityRes.success ? (similarityRes.data?.data ?? similarityRes.data) : null,
              subscores: simDerived?.metrics ?? null, // derivadas de eventos (o null si abstención)
            },
            labels: {
              vsi: vsiValue,
              injuryRisk: injuryRiskValue(injuryRiskResult),
              valuation: valuationResult ?? null,
              reportTypes: successfulReports.map((r) => r.name),
            },
            consent_basis: consentBasis,
          },
          { onConflict: "analysis_id" },
        );
      }
    } catch {
      // Flywheel es no bloqueante — la pipeline continúa
    }

    // ── 6b. Save metric snapshot for progression tracking (Sprint 9) ──
    try {
      const fatigueData = fatigueReport as Record<string, unknown> | null;
      // P1 bloque 4b: el seguimiento ya no recibe PHV (su historia vive en
      // player_anthropometrics, tras la puerta) y el riesgo es SOLO el compuesto
      // (antes caía a la biomecánica: dos conceptos en la misma columna).
      await callInternal("/api/agents/progression-tracker", {
        playerId: analysis.player_id,
        analysisId: analysis.id,
        vsi: vsiValue,
        injuryRisk: injuryRiskValue(injuryRiskResult),
        fatigueIndex: fatigueData?.fatigue_index ?? null,
        acwr: fatigueData?.acwr_value ?? null,
        xgAccumulated: null, // xG comes from client-side accumulator
        source: "video_analysis",
      });
    } catch {
      // Progression tracking is non-blocking — pipeline continues
    }

    // ── 7. Marcar analysis completed ───────────────────────────────
    const totalLatencyMs = Date.now() - startedAt;
    // CRÍTICO: el status DEBE estar en el CHECK constraint (mig 041): queued/processing/
    // processing_reports/completed/failed/cancelled. 'completed_partial' NO está →
    // el UPDATE lanzaba check_violation (23514), el error se TRAGABA (no se capturaba) y
    // la fila QUEDABA en 'processing_reports' con candidates sin limpiar y completed_at
    // NULL → el reaper (staleHours) la marcaba 'failed' aunque los N informes buenos ya
    // estaban en la tabla reports. El análisis SÍ completó su run: se marca 'completed' y
    // la parcialidad se registra en status_message (honesto y visible vía analyses/by-video).
    // Mismo motivo documentado en api/players/baseline-analysis.ts:489.
    const reportsOk = successfulReports.length;
    const reportsTotal = activeAgents.length;
    const isPartial = reportsOk !== reportsTotal;
    const { error: finalizeErr } = await supabase
      .from("analyses")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        candidates: null, // limpiamos los crops · ya no se necesitan
        ...(isPartial
          ? { status_message: pickLocale(reportLocale, PARTIAL_STATUS)(reportsOk, reportsTotal) }
          : {}),
      })
      .eq("id", analysis.id);
    if (finalizeErr) {
      // No silenciar: si el marcado final falla, la fila se colgaría y el reaper la
      // pasaría a 'failed'. Al menos deja traza.
      console.error("[orchestrator] fallo al marcar 'completed':", finalizeErr.message);
    }

    // ── 8. Email Resend ────────────────────────────────────────────
    let emailSent = false;
    try {
      // Misma fuente canónica que el gate (inv #7, B6): el email del tutor que verificó y
      // no ha retirado el consentimiento; nunca el de una fila marcada por el cliente.
      const activeConsent = await findActiveParentalConsent(String(analysis.player_id));

      if (activeConsent?.parentEmail && player) {
        const vsiScore = vsiValue; // null (bloqueado) → email muestra "N/D", nunca "VSI 0"
        emailSent = await sendCompletionEmail(
          activeConsent.parentEmail,
          player.name,
          vsiScore,
          `${PUBLIC_URL}/player/${analysis.player_id}/analysis/${analysis.id}`,
          {
            reportsGenerated: successfulReports.length,
            reportsTotal: activeAgents.length,
            partiallyEstimated: measuredFraction < 1,
            // Email a la familia en el mismo idioma que los informes (antes siempre es).
            locale: reportLocale,
          },
        );
      }
    } catch {
      /* email opcional, no bloqueante */
    }

    return successResponse({
      analysisId: analysis.id,
      // Refleja lo que se PERSISTIÓ de verdad: siempre 'completed' (el status DB válido);
      // la parcialidad va en `partial` + reportsGenerated/Failed, no en un status inválido.
      status: "completed",
      partial: isPartial,
      reportsGenerated: reportsOk,
      reportsFailed: reportsTotal - reportsOk,
      vsi: vsiValue,
      totalLatencyMs,
      emailSent,
    });
  }
);
