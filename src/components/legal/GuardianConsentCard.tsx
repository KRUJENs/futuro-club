/**
 * VITAS · Consentimiento del tutor de un menor de 14 (P1 bloque 3)
 *
 * Tarjeta de la ficha del jugador (y de la vista de familia): estado REAL que da el servidor
 * (/api/auth/consent-status; «confirmado» = la misma regla que el gate de análisis) y las
 * acciones: pedir la firma al tutor, volver a pedirla, retirarlo. Antes un menor de 14 con
 * fecha de nacimiento quedaba sin análisis de vídeo y sin forma de pedir la firma desde la app.
 *
 * Solo se muestra para un menor de 14 CONOCIDO (fecha de nacimiento en la ficha; misma regla
 * que el gate). En el demo no se muestra (no hay servidor ni tutores).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldAlert, Clock, Loader2, UserX } from "lucide-react";
import { minorStatusFromBirthDate } from "@/lib/shared/videoConsent";
import { IS_DEMO } from "@/lib/demoMode";
import { useConsentStatus, useWithdrawGuardianConsent } from "@/hooks/useParentalConsent";
import type { GuardianConsentState } from "@/services/real/parentalConsentService";
import { ParentalConsentForm } from "./ParentalConsentForm";

interface Props {
  playerId: string;
  playerName: string;
  birthDate?: string | null;
}

const PILL: Record<GuardianConsentState, string> = {
  verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-red-50 text-red-700 border-red-200",
  withdrawn: "bg-red-50 text-red-700 border-red-200",
  none: "bg-slate-50 text-slate-700 border-slate-200",
  unavailable: "bg-slate-50 text-slate-700 border-slate-200",
};

function fmtDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(lang, { day: "2-digit", month: "short", year: "numeric" });
}

export function GuardianConsentCard({ playerId, playerName, birthDate }: Props) {
  const { t, i18n } = useTranslation();
  const minor = minorStatusFromBirthDate(birthDate ?? null);
  const { data, isLoading } = useConsentStatus(minor === "minor" && !IS_DEMO ? [playerId] : []);
  const withdraw = useWithdrawGuardianConsent();
  const [showForm, setShowForm] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [sentTo, setSentTo] = useState<{ email: string; emailSent: boolean } | null>(null);
  const [withdrawError, setWithdrawError] = useState(false);

  if (IS_DEMO || minor !== "minor") return null;

  const status = data?.[playerId];
  const state: GuardianConsentState | null = status?.state ?? null;
  const lang = i18n.language;

  const Icon = state === "verified" ? ShieldCheck : state === "pending" ? Clock : ShieldAlert;

  const description = (() => {
    switch (state) {
      case "verified":
        return t("guardianConsent.state.verifiedDesc", {
          name: status?.guardianName ?? "",
          email: status?.guardianEmail ?? "",
          date: fmtDate(status?.verifiedAt, lang),
        });
      case "pending":
        return t("guardianConsent.state.pendingDesc", { email: status?.guardianEmail ?? "", date: fmtDate(status?.expiresAt, lang) });
      case "expired":
        return t("guardianConsent.state.expiredDesc", { email: status?.guardianEmail ?? "" });
      case "withdrawn":
        return t("guardianConsent.state.withdrawnDesc", { date: fmtDate(status?.withdrawnAt, lang) });
      case "unavailable":
        return t("guardianConsent.state.unavailableDesc");
      default:
        return t("guardianConsent.state.noneDesc", { name: playerName });
    }
  })();

  const requestLabel =
    state === "pending" ? t("guardianConsent.actions.resend")
    : state === "expired" || state === "withdrawn" ? t("guardianConsent.actions.requestAgain")
    : t("guardianConsent.actions.request");

  async function doWithdraw() {
    setWithdrawError(false);
    try {
      await withdraw.mutateAsync({ playerId });
      setConfirmWithdraw(false);
    } catch {
      setWithdrawError(true);
    }
  }

  return (
    <section className="glass rounded-xl p-4 space-y-3" data-testid="guardian-consent-card">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-primary shrink-0" aria-hidden />
        <h2 className="font-display font-semibold text-sm text-foreground">{t("guardianConsent.title")}</h2>
        {state && (
          <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border ${PILL[state]}`}>
            {t(`guardianConsent.state.${state}`)}
          </span>
        )}
      </div>

      {isLoading || !state ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {t("guardianConsent.loading")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      )}

      {sentTo && !showForm && (
        <p role="status" className={`text-xs rounded-lg border p-2 ${sentTo.emailSent ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {sentTo.emailSent
            ? t("guardianConsent.sent", { email: sentTo.email })
            : t("guardianConsent.sentNoEmail")}
        </p>
      )}

      {showForm ? (
        <ParentalConsentForm
          playerId={playerId}
          initialName={status?.guardianName ?? ""}
          initialEmail={status?.guardianEmail ?? ""}
          onCancel={() => setShowForm(false)}
          onDone={(r) => {
            setShowForm(false);
            setSentTo(r);
          }}
        />
      ) : confirmWithdraw ? (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-800">{t("guardianConsent.withdrawConfirm", { name: playerName })}</p>
          {withdrawError && <p role="alert" className="text-xs text-red-700">{t("guardianConsent.errors.withdraw")}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirmWithdraw(false)} className="flex-1 py-1.5 rounded-lg border border-border text-xs font-semibold text-muted-foreground bg-card">
              {t("guardianConsent.form.cancel")}
            </button>
            <button
              type="button"
              onClick={doWithdraw}
              disabled={withdraw.isPending}
              className="flex-1 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              {withdraw.isPending ? <Loader2 size={12} className="animate-spin inline" /> : t("guardianConsent.actions.withdrawConfirm")}
            </button>
          </div>
        </div>
      ) : (
        state && state !== "unavailable" && (
          <div className="flex flex-wrap gap-2">
            {state !== "verified" && (
              <button
                type="button"
                onClick={() => { setSentTo(null); setShowForm(true); }}
                className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold"
              >
                {requestLabel}
              </button>
            )}
            {(state === "verified" || state === "pending") && (
              <button
                type="button"
                onClick={() => setConfirmWithdraw(true)}
                className="px-3 py-1.5 rounded-lg border border-border bg-card text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <UserX size={12} aria-hidden /> {state === "verified" ? t("guardianConsent.actions.withdraw") : t("guardianConsent.actions.cancelRequest")}
              </button>
            )}
          </div>
        )
      )}
    </section>
  );
}
