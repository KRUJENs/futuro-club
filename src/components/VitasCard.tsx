/**
 * VITAS Card — Tarjeta exportable del jugador
 * Muestra: identidad, VSI, PHV, clon más cercano, proyección
 * Exporta como PNG con html2canvas
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Download, Share2, Loader2, Zap, Star, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PUBLIC_HOST } from "@/lib/publicUrl";
import { toast } from "sonner";
import { shareToWhatsApp, shareNative } from "@/lib/share";
import type { Player } from "@/services/real/playerService";
import type { PlayerMetrics } from "@/services/real/metricsService";
import { maturityTimingKey, maturityTone, type PlayerMaturityInput } from "@/lib/phv/playerMaturity";
import { gatedMaturity } from "@/lib/phv/phvGate";
import type { SimilarityMatch } from "@/services/real/similarityService";

/** Comparable tal y como lo guarda el informe (mapDbRowToLegacy). */
interface ReportBestMatch {
  nombre?:   string;
  posicion?: string;
  club?:     string;
  score?:    number;
}

/**
 * El comparable llega de dos fuentes: la similitud en vivo (SimilarityMatch, `player.*`)
 * o el informe guardado (`nombre/club/posicion`). Antes se leía siempre
 * `bestMatch.player.short_name` → TypeError al abrir la tarjeta desde la ficha cuando el
 * informe tenía un comparable. Sin nombre o sin % ⇒ null (no se pinta).
 */
export function cloneFromMatch(m: SimilarityMatch | ReportBestMatch | null | undefined) {
  if (!m) return null;
  const sim = m as SimilarityMatch;
  const rep = m as ReportBestMatch;
  const name = sim.player?.short_name ?? rep.nombre ?? null;
  const score = typeof m.score === "number" && Number.isFinite(m.score) ? m.score : null;
  if (!name || score === null) return null;
  return {
    name,
    club: (sim.player ? sim.player.club : rep.club) || null,
    position: (sim.player ? sim.player.position : rep.posicion) || null,
    score,
  };
}

interface VitasCardProps {
  player:    Player;
  bestMatch: SimilarityMatch | ReportBestMatch | null;
  onClose?:  () => void;
}

// La maduración se toma SIEMPRE del motor gateado (playerMaturity, fuente única):
// sin datos suficientes ⇒ timing "unknown" y NO se afirma "precoz/tardío". Antes se
// leía el phvCategory crudo, con mapeos CONTRADICTORIOS entre tarjetas (esta decía
// early=tardío; ShareablePlayerCard decía early=precoz) y un "A tiempo" por defecto
// para quien no tenía datos — invariantes #2 (no fabricar) y #7 (una fuente).
const MATURITY_TONE_COLOR: Record<string, string> = {
  boost:    "#3B82F6", // madurador tardío = talento (posible) infravalorado
  discount: "#F59E0B", // madurador precoz
  neutral:  "#22C55E",
};

const METRIC_LABEL_KEYS: Record<string, string> = {
  speed:     "vitasCard.metricSpeed",
  shooting:  "vitasCard.metricShooting",
  vision:    "vitasCard.metricVision",
  technique: "vitasCard.metricTechnique",
  defending: "vitasCard.metricDefending",
  stamina:   "vitasCard.metricStamina",
};

function RadarHex({ metrics }: { metrics: Player["metrics"] }) {
  const { t } = useTranslation();
  const keys: (keyof PlayerMetrics)[] = ["speed", "shooting", "vision", "technique", "defending", "stamina"];
  const cx = 80, cy = 80, r = 60;
  const angles = keys.map((_, i) => (i * Math.PI * 2) / keys.length - Math.PI / 2);

  const toPoint = (angle: number, val: number) => ({
    x: cx + r * (val / 100) * Math.cos(angle),
    y: cy + r * (val / 100) * Math.sin(angle),
  });

  const gridPoly = (scale: number) =>
    angles.map(a => `${cx + r * scale * Math.cos(a)},${cy + r * scale * Math.sin(a)}`).join(" ");

  const dataPoints = keys.map((k, i) =>
    toPoint(angles[i], metrics?.[k] ?? 0)
  );
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";

  return (
    <svg width="160" height="160" viewBox="0 0 160 160">
      {[0.25, 0.5, 0.75, 1].map(s => (
        <polygon key={s} points={gridPoly(s)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}
      {angles.map((a, i) => (
        <line key={i} x1={cx} y1={cy}
          x2={cx + r * Math.cos(a)} y2={cy + r * Math.sin(a)}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1"
        />
      ))}
      <path d={dataPath} fill="rgba(99,102,241,0.3)" stroke="rgb(99,102,241)" strokeWidth="2" />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="rgb(99,102,241)" />
      ))}
      {angles.map((a, i) => {
        const lx = cx + (r + 14) * Math.cos(a);
        const ly = cy + (r + 14) * Math.sin(a);
        return (
          <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
            fontSize="7" fill="rgba(255,255,255,0.5)" fontFamily="Rajdhani" fontWeight="600">
            {t(METRIC_LABEL_KEYS[keys[i]])}
          </text>
        );
      })}
    </svg>
  );
}

export default function VitasCard({ player, bestMatch, onClose }: VitasCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  // Maduración honesta: timing gateado (unknown si faltan datos → "Timing por
  // determinar", no un "precoz/tardío" inventado ni un "A tiempo" por defecto).
  const maturity = gatedMaturity(player as PlayerMaturityInput);
  const phvLabel = t(maturityTimingKey(maturity.timing));
  const phvColor = maturity.timing === "unknown" ? "#94A3B8" : MATURITY_TONE_COLOR[maturityTone(maturity)];
  const clone = cloneFromMatch(bestMatch);
  const cloneScore = clone?.score ?? null;
  const cloneName = clone?.name ?? null;
  const cloneClub = clone?.club ?? null;
  const clonePos = clone?.position ?? null;

  const topMetrics = player.metrics
    ? Object.entries(player.metrics)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([k, v]) => ({ label: METRIC_LABEL_KEYS[k] ? t(METRIC_LABEL_KEYS[k]) : k, value: v }))
    : [];

  const handleExport = async () => {
    if (!cardRef.current) return;
    setExporting(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: null,
        scale: 3,
        useCORS: true,
        logging: false,
      });
      const link = document.createElement("a");
      link.download = `VITAS_${player.name.replace(/\s+/g, "_")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast.success(t("vitasCard.exportSuccess"));
    } catch {
      toast.error(t("vitasCard.exportError"));
    } finally {
      setExporting(false);
    }
  };

  // «Evaluación del entrenador», no «VSI»; sin evaluar se dice, nunca «—» (P1 bloque 5b).
  const shareText = `⚡ ${player.name} | ${t("coachEval.label")} ${player.vsi ?? t("common.notEvaluated")} | PHV ${phvLabel}${cloneName ? t("vitasCard.playsLike", { name: cloneName, score: cloneScore?.toFixed(0) }) : ""}${t("vitasCard.discoverWithVitas")}`;

  const handleShare = async () => {
    const r = await shareNative({ title: t("vitasCard.shareTitle"), text: shareText, ref: "vitas-card" });
    if (r === "copied") toast.success(t("vitasCard.copiedSuccess"));
    else if (r === "failed") toast.error(t("vitasCard.shareFailed"));
  };

  const handleWhatsApp = () => shareToWhatsApp(shareText, "vitas-card");

  return (
    <div className="space-y-4">
      {/* Acciones */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="gap-2 flex-1" onClick={handleExport} disabled={exporting}>
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          PNG
        </Button>
        <Button variant="outline" size="sm" className="gap-2 flex-1" onClick={handleWhatsApp}>
          <MessageCircle size={14} className="text-emerald-500" /> WhatsApp
        </Button>
        <Button variant="outline" size="sm" className="gap-2 flex-1" onClick={handleShare}>
          <Share2 size={14} /> {t("vitasCard.share")}
        </Button>
      </div>

      {/* Card */}
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative rounded-2xl overflow-hidden select-none"
        style={{
          background: "linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #0d0d1f 100%)",
          border: "1px solid rgba(99,102,241,0.3)",
          minHeight: 420,
        }}
      >
        {/* Glow de fondo */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 right-0 w-64 h-64 rounded-full opacity-10"
            style={{ background: "radial-gradient(circle, #6366f1, transparent 70%)" }} />
          <div className="absolute bottom-0 left-0 w-48 h-48 rounded-full opacity-10"
            style={{ background: "radial-gradient(circle, #8b5cf6, transparent 70%)" }} />
        </div>

        {/* Header VITAS */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-indigo-400" />
            <span className="text-[10px] font-bold tracking-[0.2em] text-indigo-400 uppercase">
              VITAS Intelligence
            </span>
          </div>
          <span className="text-[9px] text-white/30 font-mono">2026</span>
        </div>

        <div className="p-5 grid grid-cols-[1fr_auto] gap-4">
          {/* Columna izquierda */}
          <div className="space-y-4">
            {/* Identidad */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] font-bold tracking-[0.15em] text-white/40 uppercase">
                  {player.position} · {t("vitasCard.years", { count: player.age })}
                </span>
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                  style={{ color: phvColor, backgroundColor: `${phvColor}20`, border: `1px solid ${phvColor}40` }}>
                  PHV {phvLabel}
                </span>
              </div>
              <h2 className="text-2xl font-black text-white tracking-tight leading-tight">
                {player.name}
              </h2>
              {player.competitiveLevel && (
                <p className="text-[10px] text-white/40 mt-0.5">{player.competitiveLevel}</p>
              )}
            </div>

            {/* VSI */}
            <div className="flex items-end gap-3">
              <div>
                <p className="text-[9px] font-bold tracking-widest text-white/40 uppercase mb-0.5">{t("coachEval.label")}</p>
                {player.vsi != null ? (
                  <div className="text-5xl font-black text-white leading-none">{player.vsi}</div>
                ) : (
                  <div className="text-lg font-bold text-white/60 leading-none">{t("common.notEvaluated")}</div>
                )}
                {player.vsi != null && (
                  <div className="mt-1.5 h-1.5 w-24 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${player.vsi}%` }} />
                  </div>
                )}
              </div>
              {player.phvOffset !== undefined && (
                <div className="mb-1">
                  <p className="text-[9px] text-white/40 uppercase tracking-widest">{t("vitasCard.bioOffset")}</p>
                  <p className="text-lg font-bold" style={{ color: phvColor }}>
                    {player.phvOffset > 0 ? "+" : ""}{player.phvOffset?.toFixed(1)}
                  </p>
                </div>
              )}
            </div>

            {/* Top métricas */}
            <div>
              <p className="text-[9px] font-bold tracking-widest text-white/40 uppercase mb-2">{t("vitasCard.strengths")}</p>
              <div className="space-y-1.5">
                {topMetrics.map(m => (
                  <div key={m.label} className="flex items-center gap-2">
                    <span className="text-[9px] text-white/50 w-14">{m.label}</span>
                    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${m.value}%` }} />
                    </div>
                    <span className="text-[9px] font-mono text-white/70">{m.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Proyección */}
          </div>

          {/* Columna derecha */}
          <div className="flex flex-col items-center gap-4">
            {/* Radar — solo si el jugador está evaluado; si no, un hexágono a 0
                presentaría al jugador como 0 en las 6 (invariante #2). */}
            {player.metrics && <RadarHex metrics={player.metrics} />}

            {/* Clon */}
            {clone && (
              <div className="text-center rounded-xl px-4 py-3 border border-indigo-500/30 bg-indigo-500/10 w-full">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Star size={10} className="text-yellow-400" />
                  <span className="text-[8px] font-bold tracking-widest text-white/50 uppercase">
                    {t("vitasCard.resembles")}
                  </span>
                </div>
                <p className="text-sm font-black text-white">{cloneName}</p>
                {(clonePos || cloneClub) && (
                  <p className="text-[9px] text-white/50">{[clonePos, cloneClub].filter(Boolean).join(" · ")}</p>
                )}
                <div className="mt-1.5 text-xl font-black text-indigo-400">
                  {cloneScore?.toFixed(0)}%
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-4 flex items-center justify-between">
          <span className="text-[8px] font-mono text-white/20">
            VITAS · {new Date().toLocaleDateString("es-ES")}
          </span>
          <span className="text-[9px] font-mono font-bold text-indigo-400">
            ⚡ {t("vitasCard.discoverYours")} → {PUBLIC_HOST}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
