/**
 * VITAS — Complete Report Print Layout
 * Ruta: /report-full/:id
 *
 * Renderiza el informe COMPLETO y FIEL: recorre todo el `content` de cada
 * report_type y muestra TODOS sus campos (incluidos los que la vista en pantalla
 * descarta: phv_summary, honesty_note, escenarios, drills, caveats, confianza…).
 * No es una captura de pantalla: es el contenido real, humanizado y legible.
 *
 * Honestidad: no fabrica nada. Un valor ausente se muestra como «—», nunca un 0.
 * Si el entorno es DEMO, banner visible de «Datos de ejemplo» (invariante #4).
 */
import { useParams, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IS_DEMO } from "@/lib/demoMode";
import { withCareerProjectionBlocked } from "@/lib/reports/careerProjection";

interface FullReportPayload {
  playerName: string;
  playerPosition: string;
  reports: Array<{ report_type: string; content: Record<string, unknown> }>;
}

// snake_case / camelCase → «Título Legible»
function humanizeKey(k: string): string {
  return k
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ValueBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-gray-400">—</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-gray-800">{value ? "Sí" : "No"}</span>;
  }
  if (typeof value === "number" || typeof value === "string") {
    return <span className="text-gray-800 whitespace-pre-wrap">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400">—</span>;
    const allPrimitive = value.every((x) => x === null || typeof x !== "object");
    if (allPrimitive) {
      return (
        <ul className="list-disc list-inside space-y-0.5 text-gray-800">
          {value.map((x, i) => (
            <li key={i}>{x === null || x === "" ? "—" : String(x)}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className="space-y-2 mt-1">
        {value.map((x, i) => (
          <div key={i} className="border-l-2 border-gray-200 pl-3 no-break">
            {isPlainObject(x) ? <ObjectBlock obj={x} /> : <ValueBlock value={x} />}
          </div>
        ))}
      </div>
    );
  }
  if (isPlainObject(value)) return <ObjectBlock obj={value} />;
  return <span className="text-gray-800">{String(value)}</span>;
}

function ObjectBlock({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return <span className="text-gray-400">—</span>;
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => {
        const nested = typeof v === "object" && v !== null;
        return (
          <div key={k} className="text-[12px] leading-relaxed">
            <span className="font-semibold text-gray-600">{humanizeKey(k)}:</span>{" "}
            {nested ? (
              <div className="mt-1 ml-3">
                <ValueBlock value={v} />
              </div>
            ) : (
              <ValueBlock value={v} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CompleteReportPrint() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<FullReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError(t("completeReport.errorNoId"));
      return;
    }
    const stored = sessionStorage.getItem(`vitas-full-reports-${id}`);
    if (!stored) {
      setError(t("completeReport.errorNotFound"));
      return;
    }
    try {
      setData(JSON.parse(stored) as FullReportPayload);
    } catch {
      setError(t("completeReport.errorNotFound"));
    }
  }, [id, t]);

  useEffect(() => {
    // ?noprint=1 → vista previa sin abrir el diálogo de impresión automáticamente.
    if (!data || searchParams.get("noprint") === "1") return;
    const timer = setTimeout(() => window.print(), 1200);
    return () => clearTimeout(timer);
  }, [data, searchParams]);

  if (error) return <div className="p-8 text-center text-red-500">{error}</div>;
  if (!data) return <div className="p-8 text-center text-gray-500">{t("completeReport.loading")}</div>;

  // Proyección de carrera bloqueada (P1 bloque 7, D2): su contenido llega ya como motivo.
  const reports = withCareerProjectionBlocked((data.reports ?? []).filter((r) => r && r.content));

  return (
    <>
      <style>{`@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-break { page-break-inside: avoid; } .page-break { page-break-before: always; } }`}</style>
      <div
        className="bg-white text-gray-900 min-h-screen p-8 max-w-3xl mx-auto font-sans print:p-4"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-200 no-break">
          <div>
            <div className="text-[10px] font-bold tracking-widest text-purple-600 uppercase mb-1">
              VITAS Intelligence · {t("completeReport.kicker")}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">{data.playerName}</h1>
            {data.playerPosition && <div className="text-sm text-gray-500 mt-0.5">{data.playerPosition}</div>}
            <div className="text-[10px] text-gray-400 mt-1">
              {t("completeReport.generatedLabel")}: {new Date().toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })}
            </div>
          </div>
        </div>

        {/* Banner demo (invariante #4) */}
        {IS_DEMO && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 no-break">
            {t("completeReport.demoBanner")}
          </div>
        )}

        <p className="text-[11px] text-gray-500 mb-5">{t("completeReport.intro")}</p>

        {reports.length === 0 ? (
          <div className="text-center text-gray-400 py-10">{t("completeReport.empty")}</div>
        ) : (
          reports.map((r, idx) => (
            <section key={`${r.report_type}-${idx}`} className={`mb-8 ${idx > 0 ? "page-break" : ""}`}>
              <h2 className="text-sm font-bold uppercase tracking-wider text-purple-700 border-b border-gray-200 pb-1 mb-3 no-break">
                {t(`analysisDashboard.reportTitle.${r.report_type}`, { defaultValue: humanizeKey(r.report_type) })}
              </h2>
              <ObjectBlock obj={r.content} />
            </section>
          ))
        )}

        {/* Footer */}
        <div className="pt-4 mt-6 border-t border-gray-200 flex items-center justify-between">
          <div className="text-[10px] text-purple-600 font-bold tracking-widest uppercase">VITAS.</div>
          <div className="text-[10px] text-gray-400">
            {t("completeReport.footer")} · {new Date().toLocaleDateString("es-ES")}
          </div>
          <div className="text-[10px] text-gray-400">&copy; {new Date().getFullYear()}</div>
        </div>
      </div>
    </>
  );
}
