/**
 * VITAS · Pedir la firma al TUTOR legal (P1 bloque 3)
 *
 * Lo rellena el responsable del jugador (entrenador o familia) con SOLO el nombre y el email del
 * tutor. El servidor le manda un correo con el enlace para confirmar; el TUTOR, en esa página,
 * escribe SU DNI y acepta las condiciones (decisión del owner del 14 oct). Aquí no se pide el
 * DNI ni se acepta nada en nombre del tutor.
 *
 * Uso: <ParentalConsentForm playerId={id} initialName={…} initialEmail={…} onDone={…} />
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send } from "lucide-react";
import { useRequestGuardianSignature } from "@/hooks/useParentalConsent";
import { ConsentRequestError } from "@/services/real/parentalConsentService";

interface Props {
  playerId: string;
  initialName?: string | null;
  initialEmail?: string | null;
  /** Tras enviar (con o sin correo): el padre refresca el estado. */
  onDone?: (result: { emailSent: boolean; email: string }) => void;
  onCancel?: () => void;
}

const ERROR_KEYS: Record<string, string> = {
  birth_date_required: "guardianConsent.errors.birthDateRequired",
  consent_not_required: "guardianConsent.errors.notRequired",
  tenant_missing: "guardianConsent.errors.tenantMissing",
  forbidden: "guardianConsent.errors.forbidden",
};

export function ParentalConsentForm({ playerId, initialName, initialEmail, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const [guardianName, setGuardianName] = useState(initialName ?? "");
  const [guardianEmail, setGuardianEmail] = useState(initialEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const request = useRequestGuardianSignature();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await request.mutateAsync({ playerId, guardianName, guardianEmail });
      onDone?.({ emailSent: res.emailSent, email: guardianEmail.trim() });
    } catch (err) {
      const code = err instanceof ConsentRequestError ? err.code : "";
      setError(t(ERROR_KEYS[code] ?? "guardianConsent.errors.generic"));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid="guardian-consent-form">
      <p className="text-[11px] text-muted-foreground leading-relaxed">{t("guardianConsent.form.explainer")}</p>
      <div>
        <label htmlFor={`gc-name-${playerId}`} className="block text-xs font-semibold text-foreground mb-1">
          {t("guardianConsent.form.nameLabel")}
        </label>
        <input
          id={`gc-name-${playerId}`}
          type="text"
          required
          minLength={2}
          maxLength={120}
          value={guardianName}
          onChange={(e) => setGuardianName(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground focus:outline-none focus:border-primary/60"
          placeholder={t("guardianConsent.form.namePlaceholder")}
        />
      </div>
      <div>
        <label htmlFor={`gc-email-${playerId}`} className="block text-xs font-semibold text-foreground mb-1">
          {t("guardianConsent.form.emailLabel")}
        </label>
        <input
          id={`gc-email-${playerId}`}
          type="email"
          required
          maxLength={254}
          value={guardianEmail}
          onChange={(e) => setGuardianEmail(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground focus:outline-none focus:border-primary/60"
          placeholder={t("guardianConsent.form.emailPlaceholder")}
        />
        <p className="text-[10px] text-muted-foreground mt-1">{t("guardianConsent.form.emailHint")}</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            {t("guardianConsent.form.cancel")}
          </button>
        )}
        <button
          type="submit"
          disabled={request.isPending}
          className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {request.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {t("guardianConsent.form.submit")}
        </button>
      </div>
    </form>
  );
}
