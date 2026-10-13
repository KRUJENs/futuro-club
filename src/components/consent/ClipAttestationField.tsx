/**
 * VITAS · ClipAttestationField — declaración del entrenador OBLIGATORIA antes de subir o
 * analizar un clip (decisión del owner, 30 sep 2026 · regla en src/lib/shared/videoConsent).
 *
 * Una sola pieza de UI (invariante #7) para VideoUpload, VideoUploader, VitasLab y el
 * análisis de equipo. Reutiliza el MISMO texto versionado que el job de partido completo
 * (AttestationCheckbox → matchJob.attestation.text_<versión>): el servidor acepta solo esa
 * versión. Nunca se marca sola: el estado lo tiene el llamador, empieza en `false` y el
 * llamador lo vuelve a `false` al cambiar de vídeo.
 *
 * Debajo explica qué falta mientras no está marcada y avisa de la regla de menores de 14
 * (consentimiento del tutor verificado), que comprueba el servidor.
 */

import { useTranslation } from "react-i18next";
import AttestationCheckbox from "@/components/match/AttestationCheckbox";

interface ClipAttestationFieldProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** "upload" = antes de subir (el webhook analiza solo); "analysis" = antes de (re)analizar. */
  purpose: "upload" | "analysis";
}

export default function ClipAttestationField({ id, checked, onChange, purpose }: ClipAttestationFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1" data-testid="clip-attestation">
      <AttestationCheckbox id={id} checked={checked} onChange={onChange} />
      {!checked && (
        <p role="status" className="text-[10px] text-muted-foreground leading-relaxed pl-1">
          {t(purpose === "upload" ? "clipConsent.uploadNeedsAttestation" : "clipConsent.analysisNeedsAttestation")}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground leading-relaxed pl-1">{t("clipConsent.minorNote")}</p>
    </div>
  );
}
