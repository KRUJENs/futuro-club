/**
 * VITAS · QuantitativeMetricsPanel
 *
 * Panel de métricas cuantitativas del análisis de inteligencia.
 * Muestra: velocidad, pases, duelos, recuperaciones, distancia.
 * Fuentes: YOLO tracking (físicas) + Gemini event counting (eventos).
 */

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Zap, Activity, Target, Swords, ShieldCheck, Crosshair,
} from "lucide-react";
import type { VideoIntelligenceOutput } from "@/agents/contracts";
import CalibrationCaveat from "@/components/CalibrationCaveat";
import { duelsGateText } from "@/lib/metrics/duelsGate";

type MetricasCuantitativas = NonNullable<VideoIntelligenceOutput["metricasCuantitativas"]>;

interface Props {
  data: MetricasCuantitativas;
}

const SOURCE_LABELS: Record<string, string> = {
  "yolo+gemini": "Tracking + IA",
  "gemini_only":  "Observación IA",
  "yolo_only":    "Tracking YOLO",
};

export default function QuantitativeMetricsPanel({ data }: Props) {
  const { t } = useTranslation();
  const { fisicas, eventos, fuente, confianza } = data;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center">
            <Activity size={14} className="text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-display font-bold text-foreground">{t("quantitativeMetricsPanel.matchMetrics")}</h3>
            <p className="text-[9px] text-muted-foreground">{t("quantitativeMetricsPanel.measuredQuantitativeData")}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
            {SOURCE_LABELS[fuente] ?? fuente}
          </span>
          <span className="text-[8px] text-muted-foreground">
            · {Math.round(confianza * 100)}%
          </span>
        </div>
      </div>

      {/* Aviso honesto: las físicas dependen de calibración del campo */}
      {fisicas && <CalibrationCaveat />}

      {/* Cards de métricas físicas (YOLO) */}
      {fisicas && (
        <div className="grid grid-cols-2 gap-2">
          {/* Velocidad */}
          <div className="glass rounded-xl p-3">
            <div className="flex items-center gap-1 mb-1">
              <Zap size={11} className="text-yellow-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.maxSpeed")}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display font-bold text-lg text-foreground">
                {fisicas.velocidadMaxKmh.toFixed(1)}
              </span>
              <span className="text-[9px] text-muted-foreground">km/h</span>
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {t("quantitativeMetricsPanel.avg")} {fisicas.velocidadPromKmh.toFixed(1)} km/h
            </p>
          </div>

          {/* Distancia */}
          <div className="glass rounded-xl p-3">
            <div className="flex items-center gap-1 mb-1">
              <Activity size={11} className="text-blue-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.distance")}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display font-bold text-lg text-foreground">
                {fisicas.distanciaM.toFixed(0)}
              </span>
              <span className="text-[9px] text-muted-foreground">m</span>
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {t("quantitativeMetricsPanel.sprintsCount", { count: fisicas.sprints })}
            </p>
          </div>
        </div>
      )}

      {/* Zonas de intensidad (YOLO) */}
      {fisicas?.zonasIntensidad && (
        <div className="glass rounded-xl p-3">
          <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground mb-2 block">
            {t("quantitativeMetricsPanel.intensityZones")}
          </span>
          <IntensityBar zones={fisicas.zonasIntensidad} />
          <div className="flex justify-between mt-1.5">
            {[
              { label: t("quantitativeMetricsPanel.zoneWalk"), color: "bg-slate-400", value: fisicas.zonasIntensidad.caminar },
              { label: t("quantitativeMetricsPanel.zoneJog"),   color: "bg-blue-400",  value: fisicas.zonasIntensidad.trotar },
              { label: t("quantitativeMetricsPanel.zoneRun"), color: "bg-orange-400", value: fisicas.zonasIntensidad.correr },
              { label: t("quantitativeMetricsPanel.zoneSprint"),  color: "bg-red-400",   value: fisicas.zonasIntensidad.sprint },
            ].map(z => (
              <div key={z.label} className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${z.color}`} />
                <span className="text-[8px] text-muted-foreground">
                  {z.label} {z.value.toFixed(0)}m
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cards de eventos (Gemini) */}
      {eventos && (
        <div className="grid grid-cols-2 gap-2">
          {/* Pases */}
          <div className="glass rounded-xl p-3">
            <div className="flex items-center gap-1 mb-1">
              <Target size={11} className="text-green-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.passes")}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display font-bold text-lg text-foreground">
                {eventos.precisionPases}
              </span>
              <span className="text-[9px] text-muted-foreground">%</span>
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {eventos.pasesCompletados}✓ / {eventos.pasesFallados}✗
            </p>
          </div>

          {/* Duelos — SIEMPRE bloqueados (P1 bloque 6): antes «0 %» sin duelos y el
              conteo del modelo de vídeo sin criterio validado. Hueco con su motivo. */}
          <div className="glass rounded-xl p-3" data-testid="duels-gated">
            <div className="flex items-center gap-1 mb-1">
              <Swords size={11} className="text-red-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.duels")}
              </span>
            </div>
            <p className="font-display font-semibold text-xs text-foreground">{duelsGateText(t).value}</p>
            <p className="text-[9px] text-muted-foreground mt-0.5">{duelsGateText(t).hint}</p>
          </div>

          {/* Recuperaciones */}
          <div className="glass rounded-xl p-3">
            <div className="flex items-center gap-1 mb-1">
              <ShieldCheck size={11} className="text-emerald-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.recoveries")}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display font-bold text-lg text-foreground">
                {eventos.recuperaciones}
              </span>
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {t("quantitativeMetricsPanel.ballsRecovered")}
            </p>
          </div>

          {/* Disparos */}
          <div className="glass rounded-xl p-3">
            <div className="flex items-center gap-1 mb-1">
              <Crosshair size={11} className="text-amber-400" />
              <span className="text-[8px] font-display uppercase tracking-wider text-muted-foreground">
                {t("quantitativeMetricsPanel.shots")}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display font-bold text-lg text-foreground">
                {eventos.disparosAlArco + eventos.disparosFuera}
              </span>
            </div>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {t("quantitativeMetricsPanel.shotsOnOffTarget", { onTarget: eventos.disparosAlArco, offTarget: eventos.disparosFuera })}
            </p>
          </div>
        </div>
      )}

      {/* Sin datos disponibles */}
      {!fisicas && !eventos && (
        <div className="glass rounded-xl p-4 text-center">
          <p className="text-xs text-muted-foreground">
            {t("quantitativeMetricsPanel.noMetricsAvailable")}
          </p>
        </div>
      )}
    </motion.div>
  );
}

// ─── Sub-componente: barra de intensidad ────────────────────────────────────

function IntensityBar({ zones }: {
  zones: { caminar: number; trotar: number; correr: number; sprint: number };
}) {
  const total = zones.caminar + zones.trotar + zones.correr + zones.sprint || 1;
  return (
    <div className="flex h-3 rounded-full overflow-hidden gap-px">
      <div className="bg-slate-400"  style={{ width: `${(zones.caminar / total) * 100}%` }} />
      <div className="bg-blue-400"   style={{ width: `${(zones.trotar  / total) * 100}%` }} />
      <div className="bg-orange-400" style={{ width: `${(zones.correr  / total) * 100}%` }} />
      <div className="bg-red-400"    style={{ width: `${(zones.sprint  / total) * 100}%` }} />
    </div>
  );
}
