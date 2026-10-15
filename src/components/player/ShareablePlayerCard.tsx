/**
 * VITAS · ShareablePlayerCard — la card semanal compartible por WhatsApp.
 *
 * El loop de crecimiento orgánico: el coach comparte una card del jugador; el
 * receptor aterriza en la landing con ?ref (atribución vía src/lib/share.ts).
 *
 * HONESTIDAD: solo pinta lo que EXISTE de verdad. VSI 0 = sin calcular → no se
 * muestra. Sin PHV → no hay chip. Sin test de sprint → no hay marca. Nunca un
 * número inventado en algo que se comparte fuera de la app.
 *
 * Estética "marcador de estadio": fondo navy con motivo de líneas de campo,
 * número VSI en mono, acento por tier. La zona capturada usa HEX inline (no
 * clases Tailwind) porque html2canvas 1.4 no soporta oklch/color-mix.
 */
import { useRef, useState } from "react";
import { Share2, X, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Player } from "@/services/real/playerService";
import { maturityTimingKey, type PlayerMaturityInput } from "@/lib/phv/playerMaturity";
import { gatedMaturity } from "@/lib/phv/phvGate";
import { SprintTestService } from "@/services/real/sprintTestService";
import { shareNative, shareToWhatsApp } from "@/lib/share";
import { PUBLIC_HOST } from "@/lib/publicUrl";
import { IS_DEMO } from "@/lib/demoMode";
import { coachEvalTier, type CoachEvalTier } from "@/services/real/metricsService";

// Colores por tramo; los cortes son los ÚNICOS de coachEvalTier (P1 bloque 5b) y la
// etiqueta se traduce (antes «ÉLITE/PRO/TALENTO/DESARROLLO» fijos en español).
const TIER_HEX: Record<CoachEvalTier, string> = { elite: "#3b82f6", pro: "#a855f7", talent: "#f59e0b", develop: "#ef4444" };
// (La etiqueta de maduración se toma del motor gateado playerMaturity, no de un
//  mapa local — antes este decía early="precoz" y VitasCard early="tardío", inv #7.)

export default function ShareablePlayerCard({ player }: { player: Player }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const tierKey = player.vsi != null ? coachEvalTier(player.vsi) : null;
  const tier = tierKey ? { label: t(`coachEval.tier.${tierKey}`), color: TIER_HEX[tierKey] } : null;
  const bestSprint = SprintTestService.getByPlayer(player.id)[0]
    ? SprintTestService.getByPlayer(player.id).reduce((a, b) => (b.velocidad_ms > a.velocidad_ms ? b : a))
    : null;
  const hasVsi = player.vsi > 0;
  // Maduración por el motor gateado: solo se muestra con timing FIRME (datos
  // reales). Sin datos ⇒ null → no se afirma "precoz/tardío" (invariantes #2/#7).
  const maturity = gatedMaturity(player as PlayerMaturityInput);
  const phv = maturity.timing !== "unknown" ? t(maturityTimingKey(maturity.timing)) : null;
  // Datos de EJEMPLO (demo, o jugador marcado isDemo): el PNG se comparte fuera de
  // la app → debe llevar el sello dentro de la imagen y el texto de share debe
  // advertirlo, para no difundir una cifra fabricada como si fuera real (regla MOCK).
  const isSample = IS_DEMO || player.isDemo === true;
  const shareText =
    (isSample ? "⚠️ " + t("shareCard.sampleBadge", "Datos de ejemplo · no es una valoración real") + " · " : "") +
    t("shareCard.text", { name: player.name });

  async function doShare() {
    setBusy(true);
    try {
      const el = cardRef.current;
      if (!el) return;
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(el, { backgroundColor: "#0b1220", scale: 3, useCORS: true, logging: false });
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      const ref = `player_${player.id}`;

      const file = blob ? new File([blob], `vitas-${player.name}.png`, { type: "image/png" }) : null;
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
      if (file && typeof navigator.share === "function" && nav.canShare?.({ files: [file] })) {
        // Móvil: comparte la imagen directamente (WhatsApp, etc.)
        await navigator.share({ files: [file], title: "VITAS", text: shareText });
      } else {
        // Escritorio: descarga la imagen + abre WhatsApp con texto + enlace ref
        if (blob) {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `vitas-${player.name}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }
        shareToWhatsApp(shareText, ref);
      }
    } catch {
      // Último recurso: copia el texto + enlace al portapapeles
      await shareNative({ text: shareText, ref: `player_${player.id}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5 text-xs"
        title={t("shareCard.button")}
      >
        <Share2 size={12} /> <span className="hidden sm:inline">{t("shareCard.button")}</span>
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div className="relative flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setOpen(false)}
              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-foreground"
              aria-label="close"
            >
              <X size={16} />
            </button>

            {/* ── Zona capturada — HEX inline (html2canvas-safe) ── */}
            <div
              ref={cardRef}
              style={{
                width: 340,
                height: 460,
                position: "relative",
                overflow: "hidden",
                borderRadius: 20,
                background: "radial-gradient(120% 80% at 80% 0%, #16233b 0%, #0b1220 55%)",
                color: "#e8edf2",
                fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
                padding: 22,
                boxShadow: "0 20px 60px rgba(0,0,0,.5)",
              }}
            >
              {/* motivo de líneas de campo */}
              <svg width="220" height="460" viewBox="0 0 220 460" fill="none"
                style={{ position: "absolute", right: -40, top: 0, opacity: 0.08 }}
                stroke="#e8edf2" strokeWidth="2">
                <line x1="110" y1="-10" x2="110" y2="470" />
                <circle cx="110" cy="230" r="70" />
                <circle cx="110" cy="230" r="4" fill="#e8edf2" stroke="none" />
              </svg>

              {/* wordmark */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: "#0059B3", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 10, color: "#fff" }}>V.</div>
                <span style={{ fontWeight: 800, fontSize: 12, letterSpacing: 2 }}>VITAS</span>
                <span style={{ fontSize: 8, letterSpacing: 3, color: "#7f93a8", marginLeft: 2 }}>FOOTBALL INTELLIGENCE</span>
              </div>

              {/* nombre */}
              <div style={{ marginTop: 26 }}>
                <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.05 }}>{player.name}</div>
                <div style={{ fontSize: 12, color: "#9fb0bf", marginTop: 4, letterSpacing: 0.5 }}>
                  {player.position} · {player.age} {t("shareCard.years")}{player.foot === "left" ? " · " + t("shareCard.leftFooted") : ""}
                </div>
              </div>

              {/* Sello de EJEMPLO — DENTRO del cardRef → lo captura html2canvas en el
                  PNG; no se puede recortar y compartir una cifra fabricada como real. */}
              {isSample && (
                <div style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9, fontWeight: 800, letterSpacing: 0.3, color: "#fde68a", background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.4)", padding: "4px 9px", borderRadius: 8 }}>
                  ⚠️ {t("shareCard.sampleBadge", "Datos de ejemplo · no es una valoración real")}
                </div>
              )}

              {/* VSI protagonista */}
              {hasVsi && tier && (
                <div style={{ marginTop: 30, display: "flex", alignItems: "flex-end", gap: 12 }}>
                  <div>
                    {/* «Evaluación del entrenador», no «VSI»: el PNG sale de la app sin contexto (P1 bloque 5b). */}
                    <div style={{ fontSize: 9, letterSpacing: 2, color: "#7f93a8", fontWeight: 700, textTransform: "uppercase" }}>{t("coachEval.label")}</div>
                    <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 0.9, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{player.vsi}</div>
                  </div>
                  <div style={{ paddingBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: tier.color, background: tier.color + "22", padding: "3px 8px", borderRadius: 6, textTransform: "uppercase" }}>{tier.label}</span>
                  </div>
                </div>
              )}

              {/* chips: PHV + mejor sprint (solo si existen) */}
              <div style={{ position: "absolute", bottom: 58, left: 22, right: 22, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {phv && (
                  <span style={{ fontSize: 10, color: "#cfe", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", padding: "4px 9px", borderRadius: 8 }}>
                    🧬 {phv}
                  </span>
                )}
                {bestSprint && (
                  <span style={{ fontSize: 10, color: "#bef264", background: "rgba(190,242,100,.10)", border: "1px solid rgba(190,242,100,.25)", padding: "4px 9px", borderRadius: 8, fontVariantNumeric: "tabular-nums" }}>
                    ⚡ {bestSprint.velocidad_kmh.toFixed(1)} km/h · {bestSprint.distancia_m} m
                  </span>
                )}
                {!hasVsi && !phv && !bestSprint && (
                  <span style={{ fontSize: 10, color: "#9fb0bf" }}>{t("shareCard.pending")}</span>
                )}
              </div>

              {/* tagline + url */}
              <div style={{ position: "absolute", bottom: 18, left: 22, right: 22 }}>
                <div style={{ fontSize: 9, color: "#7f93a8" }}>{t("shareCard.tagline")}</div>
                <div style={{ fontSize: 9, color: "#5a6b7d", marginTop: 2 }}>{PUBLIC_HOST}</div>
              </div>
            </div>

            <Button onClick={doShare} disabled={busy} className="gap-2 font-display font-bold">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
              {t("shareCard.shareWhatsapp")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
