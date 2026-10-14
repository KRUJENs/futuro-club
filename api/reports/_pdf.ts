/**
 * VITAS · Server-Side PDF Report Generator
 * POST /api/reports/pdf
 *
 * Generates a player report PDF using HTML rendering.
 * Uses Vercel's Edge runtime with structured HTML output.
 * Returns PDF-ready HTML with print styles that the client
 * can convert via window.print() or receive as downloadable HTML.
 */
export const config = { runtime: "edge" };

import { z } from "zod";
import { withHandler } from "../_lib/withHandler";
import { errorResponse } from "../_lib/apiResponse";
import { phvGate, phvLabelEs, type PhvGateInput } from "../../src/lib/phv/phvGate";
import { realVsiEvaluations } from "../../src/lib/scoring/vsiDelta";
import { completeCoachMetrics, fichaVsiFromBlob, type PlayerMetrics } from "../../src/services/real/metricsService";

const PdfRequestSchema = z.object({
  playerId: z.string(),
  type: z.enum(["player-report", "analysis-report", "evolution-report"]).default("player-report"),
});

export default withHandler(
  { schema: PdfRequestSchema, requireAuth: true, maxRequests: 10, allowServiceToken: true, requiredPlan: "pro,club" },
  async ({ body, userId }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse("Supabase not configured", 503);
    }

    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    };

    // 1. Fetch player data
    const playerRes = await fetch(
      `${supabaseUrl}/rest/v1/players?id=eq.${body.playerId}&user_id=eq.${userId}&select=data`,
      { headers }
    );

    if (!playerRes.ok) {
      return errorResponse("Failed to fetch player", 500);
    }

    const playerRows = await playerRes.json() as Array<{ data: Record<string, unknown> }>;
    if (playerRows.length === 0) {
      return errorResponse("Player not found", 404);
    }

    const player = playerRows[0].data as Record<string, unknown>;
    // Las 6 barras del entrenador solo si están COMPLETAS (regla única completeCoachMetrics,
    // como el informe impreso): antes se pintaban tal cual, también parciales, con la clave
    // en inglés y bajo «Métricas de Rendimiento», como si fueran medidas del sistema.
    const coachMetrics = completeCoachMetrics(player.metrics);
    const name = (player.name as string) ?? "Jugador";
    // Sin dato ⇒ «sin registrar»/«sin evaluar», nunca 0 ni «Ambidiestro» por defecto
    // (P1 bloque 5b, invariante #2). El VSI de ficha es la EVALUACIÓN DEL ENTRENADOR.
    const NOT_RECORDED = "sin registrar";
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const age = num(player.age);
    const position = (player.position as string) ?? "";
    const vsi = fichaVsiFromBlob(player); // VSI de ficha GUARDADO (regla única de «evaluado»)
    const vsiText = vsi !== null ? vsi.toFixed(1) : "sin evaluar";
    const foot = (player.foot as string) ?? "";
    const footText = foot === "right" ? "Diestro" : foot === "left" ? "Zurdo" : foot === "both" ? "Ambidiestro" : null;
    const height = num(player.height);
    const weight = num(player.weight);
    // Maduración desde el GATE ÚNICO (regla del owner 28-sep): solo con TODAS las
    // entradas introducidas del blob. Antes se leía el phvCategory persistido y se
    // rotulaba "early" (= pre-PHV, un ESTADO) como «Tardía» y, sin categoría,
    // «Precoz» — a cualquier menor sin medidas se le imprimía una maduración.
    // (Texto fijo del gate: sin datos de usuario que escapar.)
    const maturityLabel = phvLabelEs(phvGate(player as PhvGateInput));

    // 2. Fetch latest analysis (always, for richer report)
    let analysis: Record<string, unknown> | null = null;
    const analysisRes = await fetch(
      `${supabaseUrl}/rest/v1/player_analyses?player_id=eq.${body.playerId}&user_id=eq.${userId}&select=report,created_at&order=created_at.desc&limit=1`,
      { headers }
    );
    if (analysisRes.ok) {
      const analysisRows = await analysisRes.json() as Array<{ report: Record<string, unknown>; created_at: string }>;
      if (analysisRows.length > 0) {
        analysis = analysisRows[0].report;
      }
    }

    // 3. Generate HTML report
    const COACH_BAR_LABEL_ES: Record<keyof PlayerMetrics, string> = {
      speed: "Velocidad", technique: "Técnica", vision: "Visión",
      stamina: "Resistencia", shooting: "Tiro", defending: "Defensa",
    };
    const metricEntries = coachMetrics
      ? (Object.keys(COACH_BAR_LABEL_ES) as Array<keyof PlayerMetrics>).map(
          (k) => `<div class="metric"><span class="metric-label">${COACH_BAR_LABEL_ES[k]}</span><div class="metric-bar"><div class="metric-fill" style="width:${coachMetrics[k]}%"></div></div><span class="metric-value">${coachMetrics[k]}</span></div>`
        ).join("")
      : `<p>Sin evaluación completa del entrenador: no se muestran barras.</p>`;

    // 3b. Build analysis sections
    const estadoActual = (analysis as Record<string, Record<string, unknown>> | null)?.estadoActual;
    // Solo si son dimensiones REALES: el `score` por dimensión es una constante fabricada
    // si el pipeline no las mide (dimensionesMedidas=false). No pintar barras falsas (inv #2).
    const dimensionesMedidas = estadoActual?.dimensionesMedidas === true;
    const dimensiones = dimensionesMedidas
      ? (estadoActual?.dimensiones as Record<string, { score: number; observacion: string }> | undefined)
      : undefined;
    const fortalezas = (estadoActual?.fortalezasPrimarias ?? []) as string[];
    const areasDesarrollo = (estadoActual?.areasDesarrollo ?? []) as string[];
    const proyeccion = (analysis as Record<string, Record<string, unknown>> | null)?.proyeccionCarrera as Record<string, Record<string, string>> | undefined;
    const planDesarrollo = (analysis as Record<string, Record<string, unknown>> | null)?.planDesarrollo as Record<string, unknown> | undefined;
    // Evolución SOLO desde evaluaciones del entrenador con fecha y origen (fuente única:
    // src/lib/scoring/vsiDelta.ts). Antes se graficaba `vsiHistory` —legacy SIN fechas,
    // con el 57.5 fabricado antes de #146— como «Evolución VSI» (invariante #7).
    const datedEvaluations = realVsiEvaluations(player.vsiEvaluations);
    const fmtEvalDate = (iso: string) =>
      new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });

    const dimLabels: Record<string, string> = {
      velocidadDecision: "Vel. Decisión", tecnicaConBalon: "Técnica",
      inteligenciaTactica: "Int. Táctica", capacidadFisica: "Capacidad Física",
      liderazgoPresencia: "Liderazgo", eficaciaCompetitiva: "Eficacia",
    };

    const dimensionSection = dimensiones ? `
      <div class="section">
        <h2>Dimensiones de Rendimiento</h2>
        ${Object.entries(dimensiones).map(([k, d]) => `
          <div class="metric">
            <span class="metric-label">${dimLabels[k] ?? k}</span>
            <div class="metric-bar"><div class="metric-fill" style="width:${d.score * 10}%"></div></div>
            <span class="metric-value">${d.score}/10</span>
          </div>
        `).join("")}
      </div>
    ` : "";

    const analysisSection = estadoActual ? `
      <div class="section">
        <h2>Resumen Ejecutivo</h2>
        <p>${estadoActual.resumenEjecutivo ?? "Sin análisis disponible"}</p>
        <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
          ${fortalezas.map(f => `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px">${f}</span>`).join("")}
          ${areasDesarrollo.map(a => `<span style="background:#ffedd5;color:#9a3412;padding:2px 8px;border-radius:4px;font-size:11px">${a}</span>`).join("")}
        </div>
      </div>
    ` : "";

    const evolutionSection = datedEvaluations.length > 1 ? `
      <div class="section">
        <h2>Evolución de la evaluación del entrenador · evaluaciones con fecha</h2>
        <div style="display:flex;align-items:end;gap:4px;height:60px">
          ${datedEvaluations.map((e, i) => {
            const v = e.value;
            const pct = Math.max(5, v);
            const isLast = i === datedEvaluations.length - 1;
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center">
              <span style="font-size:9px;color:#6b7280">${Math.round(v)}</span>
              <div style="width:100%;height:${pct * 0.5}px;background:${isLast ? "#7c3aed" : "#c4b5fd"};border-radius:4px;min-height:4px"></div>
              <span style="font-size:8px;color:#9ca3af">${fmtEvalDate(e.at)}</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    const projectionSection = proyeccion ? `
      <div class="section">
        <h2>Proyección de Carrera</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="background:#f0fdf4;padding:12px;border-radius:8px">
            <div style="font-size:10px;color:#16a34a;font-weight:700;text-transform:uppercase">Optimista</div>
            <div style="font-size:12px;font-weight:600;margin-top:4px">${proyeccion.escenarioOptimista?.nivelProyecto ?? ""}</div>
            <p style="font-size:11px;color:#666;margin-top:4px">${proyeccion.escenarioOptimista?.descripcion ?? ""}</p>
          </div>
          <div style="background:#eff6ff;padding:12px;border-radius:8px">
            <div style="font-size:10px;color:#2563eb;font-weight:700;text-transform:uppercase">Realista</div>
            <div style="font-size:12px;font-weight:600;margin-top:4px">${proyeccion.escenarioRealista?.nivelProyecto ?? ""}</div>
            <p style="font-size:11px;color:#666;margin-top:4px">${proyeccion.escenarioRealista?.descripcion ?? ""}</p>
          </div>
        </div>
      </div>
    ` : "";

    const planSection = planDesarrollo ? `
      <div class="section">
        <h2>Plan de Desarrollo</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div style="background:#f8f9fa;padding:10px;border-radius:8px">
            <div style="font-size:10px;color:#999;text-transform:uppercase">Objetivo 6 meses</div>
            <div style="font-size:12px;font-weight:600">${planDesarrollo.objetivo6meses ?? ""}</div>
          </div>
          <div style="background:#f8f9fa;padding:10px;border-radius:8px">
            <div style="font-size:10px;color:#999;text-transform:uppercase">Objetivo 18 meses</div>
            <div style="font-size:12px;font-weight:600">${planDesarrollo.objetivo18meses ?? ""}</div>
          </div>
        </div>
      </div>
    ` : "";

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>VITAS Report — ${name}</title>
  <style>
    @page { size: A4; margin: 15mm; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.5; background: #fff; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 28px; font-weight: 700; }
    .header .vsi { font-size: 48px; font-weight: 800; }
    .header .vsi-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.8; }
    .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .info-card { background: #f8f9fa; border-radius: 8px; padding: 12px 16px; }
    .info-card .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-card .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #eee; }
    .metric { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .metric-label { width: 100px; font-size: 13px; font-weight: 500; text-transform: capitalize; }
    .metric-bar { flex: 1; height: 20px; background: #e9ecef; border-radius: 10px; overflow: hidden; }
    .metric-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); border-radius: 10px; transition: width 0.3s; }
    .metric-value { width: 40px; text-align: right; font-weight: 600; font-size: 14px; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; display: flex; justify-content: space-between; font-size: 11px; color: #999; }
    @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${name}</h1>
      <p>${position} · ${age !== null ? `${age} años` : `edad ${NOT_RECORDED}`}${footText ? ` · ${footText}` : ""}</p>
    </div>
    <div style="text-align:right">
      <div class="vsi-label">Evaluación del entrenador</div>
      <div class="vsi">${vsiText}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-card"><div class="label">Altura</div><div class="value">${height !== null ? `${height} cm` : NOT_RECORDED}</div></div>
    <div class="info-card"><div class="label">Peso</div><div class="value">${weight !== null ? `${weight} kg` : NOT_RECORDED}</div></div>
    <div class="info-card"><div class="label">Maduración</div><div class="value">${maturityLabel}</div></div>
    <div class="info-card"><div class="label">Evaluación del entrenador (subjetiva)</div><div class="value">${vsiText}</div></div>
  </div>

  <div class="section">
    <h2>Evaluación del entrenador · 6 barras (valoración subjetiva, 0-100)</h2>
    ${metricEntries}
  </div>

  ${evolutionSection}
  ${analysisSection}
  ${dimensionSection}
  ${projectionSection}
  ${planSection}

  <div class="footer">
    <span>VITAS · Football Intelligence</span>
    <span>Generado: ${new Date().toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })}</span>
  </div>
</body>
</html>`;

    // Return HTML with Content-Disposition for download
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="VITAS-Report-${name.replace(/\s+/g, "-")}.html"`,
        "Cache-Control": "no-cache",
      },
    });
  }
);
