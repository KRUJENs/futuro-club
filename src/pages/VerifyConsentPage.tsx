/**
 * VITAS — Confirmación del TUTOR legal (ruta pública /auth/verify-consent#token=…; también
 * acepta ?token=…)
 *
 * A esta página llega el tutor desde el correo que pidió el responsable del jugador
 * (api/auth/sign-consent.ts). P1 bloque 3:
 *   - NADA se verifica al abrir la página (antes el POST salía en el useEffect: un escáner de
 *     enlaces del correo podía «firmar» sin el tutor, CWE-650). El tutor lee qué autoriza,
 *     escribe SU DNI, marca condiciones y privacidad y pulsa «Confirmo como tutor legal»
 *     (decisión del owner, 14 oct: el DNI y la aceptación son del tutor, no del entrenador);
 *   - al confirmar recibe el enlace para RETIRAR el consentimiento (también se muestra aquí, por
 *     si el correo de confirmación no llega);
 *   - textos en los 7 idiomas.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";

type Status = "form" | "submitting" | "success" | "error";

/** El código del enlace: tras «#» (no viaja a ningún servidor) o, en enlaces antiguos, en ?token=. */
function tokenFromUrl(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  return fromHash ?? new URLSearchParams(window.location.search).get("token");
}

const ERROR_KEYS: Record<string, string> = {
  invalid_token: "verifyConsentPage.errors.invalidToken",
  token_expired: "verifyConsentPage.errors.expired",
  consent_changed: "verifyConsentPage.errors.changed",
  VALIDATION_ERROR: "verifyConsentPage.errors.validation",
};

export default function VerifyConsentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [checkedUrl, setCheckedUrl] = useState(false);
  const [dni, setDni] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [status, setStatus] = useState<Status>("form");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [withdrawToken, setWithdrawToken] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(true);
  const [alreadyVerified, setAlreadyVerified] = useState(false);
  const read = useRef(false);

  // Solo LEE el token de la URL (y lo quita de la barra y del historial). No llama a nada.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    setToken(tokenFromUrl());
    try { window.history.replaceState(null, "", "/auth/verify-consent"); } catch { /* noop */ }
    setCheckedUrl(true);
  }, []);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !acceptedTerms || !acceptedPrivacy || !dni.trim()) return;
    setStatus("submitting");
    setErrorKey(null);
    try {
      const res = await fetch("/api/auth/verify-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, parentDni: dni.trim().toUpperCase(), acceptedTerms: true, acceptedPrivacy: true }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: { withdrawToken?: string | null; confirmationEmailSent?: boolean; alreadyVerified?: boolean }; errorDetail?: { code?: string } }
        | null;
      if (res.ok && json?.success) {
        setWithdrawToken(json.data?.withdrawToken ?? null);
        setConfirmationSent(json.data?.confirmationEmailSent !== false);
        setAlreadyVerified(json.data?.alreadyVerified === true);
        setStatus("success");
      } else {
        setErrorKey(ERROR_KEYS[json?.errorDetail?.code ?? ""] ?? "verifyConsentPage.errors.generic");
        setStatus("error");
      }
    } catch {
      setErrorKey("verifyConsentPage.errors.network");
      setStatus("error");
    }
  }

  const missingToken = checkedUrl && !token;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="glass rounded-2xl p-8 max-w-lg w-full space-y-5">
        <h1 className="text-lg font-display font-bold text-foreground flex items-center gap-2">
          <ShieldCheck size={18} className="text-primary" aria-hidden />
          {t("verifyConsentPage.title")}
        </h1>

        {missingToken && (
          <p role="alert" className="text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden /> {t("verifyConsentPage.errors.missingToken")}
          </p>
        )}

        {status === "success" && (
          <div className="space-y-3" role="status">
            <p className="text-sm text-foreground flex items-start gap-2">
              <CheckCircle2 size={18} className="text-emerald-600 shrink-0" aria-hidden />
              {alreadyVerified ? t("verifyConsentPage.success.already") : t("verifyConsentPage.success.done")}
            </p>
            {withdrawToken && (
              <div className="rounded-lg border border-border bg-card p-3 space-y-1">
                <p className="text-xs text-muted-foreground">
                  {confirmationSent ? t("verifyConsentPage.success.withdrawEmailed") : t("verifyConsentPage.success.withdrawNoEmail")}
                </p>
                <a href={`/auth/withdraw-consent#token=${withdrawToken}`} className="text-xs font-semibold text-primary underline">
                  {t("verifyConsentPage.success.withdrawLink")}
                </a>
              </div>
            )}
            {/* Sin enlace de retirada: ya confirmado antes (el enlace está en el primer correo) o no
                se pudo generar. Se dice, para que el tutor nunca se quede sin saber cómo retirarlo. */}
            {!withdrawToken && (
              <p className="text-xs rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800" data-testid="withdraw-unavailable">
                {alreadyVerified ? t("verifyConsentPage.success.alreadyHint") : t("verifyConsentPage.success.withdrawUnavailable")}
              </p>
            )}
            <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-display">
              {t("verifyConsentPage.goHome")}
            </button>
          </div>
        )}

        {!missingToken && status !== "success" && (
          <form onSubmit={handleConfirm} className="space-y-4" data-testid="verify-consent-form">
            <p className="text-sm text-muted-foreground leading-relaxed">{t("verifyConsentPage.intro")}</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-5">
              <li>{t("verifyConsentPage.what1")}</li>
              <li>{t("verifyConsentPage.what2")}</li>
              <li>{t("verifyConsentPage.what3")}</li>
            </ul>

            <div>
              <label htmlFor="guardian-dni" className="block text-sm font-semibold text-foreground mb-1">
                {t("verifyConsentPage.dniLabel")}
              </label>
              <input
                id="guardian-dni"
                type="text"
                required
                minLength={5}
                maxLength={20}
                pattern="[A-Za-z0-9]+"
                autoComplete="off"
                value={dni}
                onChange={(e) => setDni(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-card border border-border text-sm uppercase focus:outline-none focus:border-primary/60"
              />
              <p className="text-[11px] text-muted-foreground mt-1">{t("verifyConsentPage.dniHint")}</p>
            </div>

            <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
              <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} className="mt-1" required />
              <span>
                {t("verifyConsentPage.termsBefore")}{" "}
                <a href="/terms" target="_blank" rel="noreferrer" className="text-primary underline">{t("verifyConsentPage.termsLink")}</a>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
              <input type="checkbox" checked={acceptedPrivacy} onChange={(e) => setAcceptedPrivacy(e.target.checked)} className="mt-1" required />
              <span>
                {t("verifyConsentPage.privacyBefore")}{" "}
                <a href="/privacy" target="_blank" rel="noreferrer" className="text-primary underline">{t("verifyConsentPage.privacyLink")}</a>
              </span>
            </label>

            {status === "error" && errorKey && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{t(errorKey)}</p>
            )}

            <button
              type="submit"
              disabled={status === "submitting" || !acceptedTerms || !acceptedPrivacy || !dni.trim()}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {status === "submitting" && <Loader2 size={15} className="animate-spin" aria-hidden />}
              {t("verifyConsentPage.confirm")}
            </button>
            <p className="text-[11px] text-muted-foreground">{t("verifyConsentPage.notGuardian")}</p>
          </form>
        )}
      </div>
    </div>
  );
}
