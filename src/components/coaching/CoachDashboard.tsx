/**
 * VITAS · CoachDashboard (panel del entrenador, /coach)
 *
 * P1 bloque 5c (decisión del dueño, 15 oct 2026): el panel queda OCULTO hasta que se
 * conecte con las sesiones reales del entrenador (P2). Todo lo que pintaba era de
 * ejemplo:
 *  - Sesión: segmentos, balance y participación generados con Math.random, «278 AU»,
 *    «68 %» y métricas fijas;
 *  - Progresión: series con Math.random y tarjetas fijas «72 / 285 / 61 / 8»;
 *  - Informes: un informe para padres de «Lucas García» inventado;
 *  - Planificación: recomendador y plan semanal fijos («−10 % técnica», duraciones) y
 *    el informe IA recibía como análisis de sesión `{ mock: true }` (las peticiones
 *    de análisis/recomendación salían sin Authorization ⇒ 401 ⇒ datos de ejemplo).
 * Ninguna cifra de un menor ni de su equipo puede salir de ahí, ni con banner. Aquí
 * solo se explica por qué no hay panel todavía. Conectar los datos reales (y las
 * peticiones con autenticación) es P2: ver docs/pendientes-metricas.md.
 */
import { useTranslation } from "react-i18next";
import { ClipboardList } from "lucide-react";

interface Props {
  teamId: string;
  teamName?: string;
}

// teamId/teamName se conservan en la firma para la conexión con sesiones reales (P2).
export default function CoachDashboard(_props: Props) {
  const { t } = useTranslation();
  return (
    <div className="glass rounded-2xl p-6 flex flex-col items-center text-center gap-3" data-testid="coach-panel-not-connected">
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
        <ClipboardList size={20} className="text-primary" />
      </div>
      <h2 className="font-display font-bold text-base text-foreground">{t("coachDash.notConnected.title")}</h2>
      <p className="text-sm text-muted-foreground max-w-md leading-relaxed">{t("coachDash.notConnected.desc")}</p>
    </div>
  );
}
