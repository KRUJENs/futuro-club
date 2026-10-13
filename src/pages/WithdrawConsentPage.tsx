/**
 * VITAS — El TUTOR retira su consentimiento (ruta pública /auth/withdraw-consent#token=…; también
 * acepta ?token=…)
 *
 * Enlace del correo de confirmación (api/auth/verify-consent.ts). P1 bloque 3, decisión del plan:
 * «el tutor retira con un enlace firmado en el correo». Nada se retira al abrir la página (un
 * escáner de enlaces podría hacerlo, CWE-650): solo al pulsar «Retirar el consentimiento».
 * Textos en los 7 idiomas.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Loader2, CheckCircle2, AlertCircle, ShieldOff } from "lucide-react";

type Status = "idle" | "submitting" | "done" | "error";

export default function WithdrawConsentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [checkedUrl, setCheckedUrl] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [already, setAlready] = useState(false);
  const read = useRef(false);

  // Solo LEE el token (y lo quita de la barra y del historial). No llama a nada.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
    setToken(fromHash ?? new URLSearchParams(window.location.search).get("token"));
    try { window.history.replaceState(null, "", "/auth/withdraw-consent"); } catch { /* noop */ }
    setCheckedUrl(true);
  }, []);

  async function handleWithdraw() {
    if (!token) return;
    setStatus("submitting");
    setErrorKey(null);
    try {
      const res = await fetch("/api/auth/guardian-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: { alreadyWithdrawn?: boolean }; errorDetail?: { code?: string } }
        | null;
      if (res.ok && json?.success) {
        setAlready(json.data?.alreadyWithdrawn === true);
        setStatus("done");
      } else {
        setErrorKey(json?.errorDetail?.code === "invalid_token" ? "withdrawConsentPage.errors.invalidToken" : "withdrawConsentPage.errors.generic");
        setStatus("error");
      }
    } catch {
      setErrorKey("withdrawConsentPage.errors.network");
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="glass rounded-2xl p-8 max-w-md w-full space-y-4">
        <h1 className="text-lg font-display font-bold text-foreground flex items-center gap-2">
          <ShieldOff size={18} className="text-primary" aria-hidden />
          {t("withdrawConsentPage.title")}
        </h1>

        {checkedUrl && !token ? (
          <p role="alert" className="text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden /> {t("withdrawConsentPage.errors.missingToken")}
          </p>
        ) : status === "done" ? (
          <div className="space-y-3" role="status">
            <p className="text-sm text-foreground flex items-start gap-2">
              <CheckCircle2 size={18} className="text-emerald-600 shrink-0" aria-hidden />
              {already ? t("withdrawConsentPage.already") : t("withdrawConsentPage.done")}
            </p>
            <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-display">
              {t("withdrawConsentPage.goHome")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">{t("withdrawConsentPage.explainer")}</p>
            {status === "error" && errorKey && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{t(errorKey)}</p>
            )}
            <button
              onClick={handleWithdraw}
              disabled={status === "submitting" || !token}
              className="w-full py-3 rounded-lg bg-red-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {status === "submitting" && <Loader2 size={15} className="animate-spin" aria-hidden />}
              {t("withdrawConsentPage.confirm")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
