import React, { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { AuthProvider } from "@/context/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import { SyncProvider } from "@/context/SyncContext";
import OfflineBanner from "@/components/OfflineBanner";
import GlobalDemoBanner from "@/components/GlobalDemoBanner";
import CookieConsent from "@/components/CookieConsent";
import RouteSkeleton from "@/components/shared/RouteSkeleton";
import { IS_DEMO } from "@/lib/demoMode";

// Pages — Auth (static — small, needed immediately)
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import VerifyConsentPage from "./pages/VerifyConsentPage";
import WithdrawConsentPage from "./pages/WithdrawConsentPage";
import ConfirmEmailPage from "./pages/ConfirmEmailPage";

// Pages — Core (static — hit on every session)
import Index from "./pages/Index";
import PublicLanding from "./pages/PublicLanding";
import NotFound from "./pages/NotFound";
import BottomNav from "./components/BottomNav";
import GlobalSearch from "./components/GlobalSearch";
import ContextualFAB from "./components/ContextualFAB";
import OnboardingTour from "./components/OnboardingTour";
import FirstRunWizard from "./components/FirstRunWizard";
import AcceptTermsGate from "./components/AcceptTermsGate";
import DemoGate from "./components/demo/DemoGate";

// Pages — Lazy loaded (heavy pages, loaded on demand)
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const ScoutFeed = lazyWithRetry(() => import("./pages/ScoutFeed"));
const SoloDrill = lazyWithRetry(() => import("./pages/SoloDrill"));
const Rankings = lazyWithRetry(() => import("./pages/Rankings"));
const PlayerHubPage = lazyWithRetry(() => import("./pages/PlayerHubPage"));
const PlayerHubPrint = lazyWithRetry(() => import("./pages/PlayerHubPrint"));
const PlayerComparison = lazyWithRetry(() => import("./pages/PlayerComparison"));
const VitasLab = lazyWithRetry(() => import("./pages/VitasLab"));
const MasterDashboard = lazyWithRetry(() => import("./pages/MasterDashboard"));
const SettingsPage = lazyWithRetry(() => import("./pages/SettingsPage"));
const RoleProfile = lazyWithRetry(() => import("./pages/RoleProfile"));
const RoleProfileCompare = lazyWithRetry(() => import("./pages/RoleProfileCompare"));
const RoleProfileAudit = lazyWithRetry(() => import("./pages/RoleProfileAudit"));
const ReportsPage = lazyWithRetry(() => import("./pages/ReportsPage"));
const PlayerForm = lazyWithRetry(() => import("./pages/PlayerForm"));
const BillingPage = lazyWithRetry(() => import("./pages/BillingPage"));
const OnboardingPage = lazyWithRetry(() => import("./pages/OnboardingPage"));
const DirectorDashboard = lazyWithRetry(() => import("./pages/DirectorDashboard"));
const PlayerIntelligencePage = lazyWithRetry(() => import("./pages/PlayerIntelligencePage"));
const AdminDashboardPage = lazyWithRetry(() => import("./pages/AdminDashboardPage"));
const AdminManagePlanPage = lazyWithRetry(() => import("./pages/AdminManagePlanPage"));
const BiasAuditDashboard = lazyWithRetry(() => import("./pages/BiasAuditDashboard"));
const ParentalConsentPage = lazyWithRetry(() => import("./pages/ParentalConsentPage"));
const PricingPage = lazyWithRetry(() => import("./pages/PricingPage"));
const PlayerReportPrint = lazyWithRetry(() => import("./pages/PlayerReportPrint"));
const AnalysisReportPrint = lazyWithRetry(() => import("./pages/AnalysisReportPrint"));
const CompleteReportPrint = lazyWithRetry(() => import("./pages/CompleteReportPrint"));
const TeamPage = lazyWithRetry(() => import("./pages/TeamPage"));
const TeamAnalysisPage = lazyWithRetry(() => import("./pages/TeamAnalysisPage"));
const TeamBaselinePage = lazyWithRetry(() => import("./pages/TeamBaselinePage"));
const LiveHubPage = lazyWithRetry(() => import("./pages/LiveHubPage"));
const LiveMatchPage = lazyWithRetry(() => import("./pages/LiveMatchPage"));
const LiveSummaryPage = lazyWithRetry(() => import("./pages/LiveSummaryPage"));
const CompareRivalPage = lazyWithRetry(() => import("./pages/CompareRivalPage"));
const MatchReportPage = lazyWithRetry(() => import("./pages/MatchReportPage"));
const ParentDashboardPage = lazyWithRetry(() => import("./pages/ParentDashboardPage"));
const CoachDashboardPage = lazyWithRetry(() => import("./pages/CoachDashboardPage"));
const WellbeingDashboardPage = lazyWithRetry(() => import("./pages/WellbeingDashboardPage"));
const AcceptInvitationPage = lazyWithRetry(() => import("./pages/AcceptInvitationPage"));
const PlayerReportsPage = lazyWithRetry(() => import("./pages/PlayerReportsPage"));
const PlayerEvolutionPage = lazyWithRetry(() => import("./pages/PlayerEvolutionPage"));
const PlayerAnalysisPage = lazyWithRetry(() => import("./pages/PlayerAnalysisPage"));
const SharedAnalysisPage = lazyWithRetry(() => import("./pages/SharedAnalysisPage"));
const TermsPage = lazyWithRetry(() => import("./pages/TermsPage"));
const PrivacyPage = lazyWithRetry(() => import("./pages/PrivacyPage"));
const UserGuidePage = lazyWithRetry(() => import("./pages/UserGuidePage"));
const SetPiecePage = lazyWithRetry(() => import("./pages/SetPiecePage"));
const SetPieceEditorPage = lazyWithRetry(() => import("./pages/SetPieceEditorPage"));
const SetPieceFolderPage = lazyWithRetry(() => import("./pages/SetPieceFolderPage"));
const HighlightsPage = lazyWithRetry(() => import("./pages/HighlightsPage"));
const HighlightDetailPage = lazyWithRetry(() => import("./pages/HighlightDetailPage"));
const BehavioralOverviewPage = lazyWithRetry(() => import("./pages/BehavioralOverviewPage"));
const IDPPage = lazyWithRetry(() => import("./pages/IDPPage"));
const IDPIndexPage = lazyWithRetry(() => import("./pages/IDPIndexPage"));
const TacticalIndexPage = lazyWithRetry(() => import("./pages/TacticalIndexPage"));
const TacticalMatchPage = lazyWithRetry(() => import("./pages/TacticalMatchPage"));
const TransferMarketPage = lazyWithRetry(() => import("./pages/TransferMarketPage"));
const ListingDetailPage = lazyWithRetry(() => import("./pages/ListingDetailPage"));
const CreateListingPage = lazyWithRetry(() => import("./pages/CreateListingPage"));
const ScanningIntelligencePage = lazyWithRetry(() => import("./pages/ScanningIntelligencePage"));
const SprintSpeed = lazyWithRetry(() => import("./pages/SprintSpeed"));

// Suspense fallback for lazy routes — branded skeleton (Sprint 4.3)
const LazyFallback = () => <RouteSkeleton />;

// Health check + purge — diagnóstico automático al iniciar
// (Sync is now handled by SyncProvider)
function SyncManager() {
  // Purge mock players + health check on mount (once)
  React.useEffect(() => {
    if (IS_DEMO) {
      // DEMO (piso piloto): NO purgar — los datos de ejemplo SON el contenido.
      // Se siembra el club SI ESTÁ VACÍO (primera carga del navegador); en recargas
      // NO se regenera → los IDs son estables y los deep-links/recargas de una ficha
      // funcionan. Un visitante nuevo (navegador limpio) siempre ve el club base.
      import("@/services/real/demoDataService").then(({ DemoDataService }) => {
        DemoDataService.seed();
      });
    } else {
      // Remove any fake/mock players from localStorage (legacy seed data)
      import("@/services/real/playerService").then(({ PlayerService }) => {
        PlayerService.purgeMockPlayers();
      });
    }

    import("@/services/real/healthCheck").then(({ HealthCheckService }) => {
      const result = HealthCheckService.run();
      if (!result.healthy) {
        const errors = result.checks.filter(c => c.status === "error");
        console.error("[HealthCheck] Issues detected:", errors);
        // Import toast dynamically to avoid circular deps
        import("sonner").then(({ toast }) => {
          for (const err of errors) {
            toast.error(`${err.name}: ${err.message}`);
          }
        });
      }
      const warnings = result.checks.filter(c => c.status === "warning");
      if (warnings.length > 0) {
        console.warn("[HealthCheck] Warnings:", warnings);
      }
    });
  }, []);

  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Wrapper para rutas protegidas
const P = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>{children}</ProtectedRoute>
);

// Redirige rutas legacy (/intelligence, /role-profile) al hub con tab pre-seleccionado
const RedirectToHub = ({ tab }: { tab: string }) => {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/players/${id}?tab=${tab}`} replace />;
};

const App = () => {
  const { t } = useTranslation();
  return (
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            <SyncProvider>
            <SyncManager />
            {/* A11y (Sprint 3.4): salto al contenido para navegación por teclado/lector */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:font-display focus:text-sm focus:shadow-lg"
            >
              {t("appRoot.skipToContent")}
            </a>
            <OfflineBanner />
            {IS_DEMO && <GlobalDemoBanner />}
            <CookieConsent />
            <DemoGate>
            <AcceptTermsGate>
            <main id="main-content" tabIndex={-1}>
            <ErrorBoundary>
              <Suspense fallback={<LazyFallback />}>
              <Routes>
                {/* ── Rutas públicas (auth) ─────────────────────────── */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                {/* Enlace del email de consentimiento (sign-consent.ts): el TUTOR confirma con un
                    botón (DNI + aceptaciones); nada se verifica al abrir. */}
                <Route path="/auth/verify-consent" element={<VerifyConsentPage />} />
                {/* Enlace del correo de confirmación: el TUTOR retira con un botón. */}
                <Route path="/auth/withdraw-consent" element={<WithdrawConsentPage />} />
                <Route path="/auth/confirm" element={<ConfirmEmailPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/pricing" element={<PricingPage />} />
                <Route path="/share/analysis/:analysisId" element={<SharedAnalysisPage />} />

                {/* ── Landing pública (visitante frío ve la propuesta de valor). ──
                    PublicLanding auto-redirige a /pulse si ya hay sesión. ── */}
                <Route path="/" element={<PublicLanding />} />
                {/* Embed para incrustar el landing en krujens.eu vía <iframe>. Misma
                    página, pero los CTA rompen el marco (target="_top") hacia el
                    VITAS completo; sin redirección por sesión (pathname ≠ "/"). */}
                <Route path="/embed" element={<PublicLanding embed />} />
                <Route path="/welcome" element={<Navigate to="/" replace />} />

                {/* ── Rutas protegidas ──────────────────────────────── */}
                <Route path="/onboarding" element={<P><OnboardingPage /></P>} />
                <Route path="/home" element={<P><Index /></P>} />
                <Route path="/pulse" element={<P><Dashboard /></P>} />
                <Route path="/master" element={<P><MasterDashboard /></P>} />
                <Route path="/scout" element={<P><ScoutFeed /></P>} />
                <Route path="/drill" element={<P><SoloDrill /></P>} />
                <Route path="/rankings" element={<P><Rankings /></P>} />
                {/* Perfil clásico jubilado → Hub (fuente única de la ficha). */}
                <Route path="/player/:id" element={<RedirectToHub tab="resumen" />} />
                <Route path="/compare" element={<P><PlayerComparison /></P>} />
                <Route path="/lab" element={<P><VitasLab /></P>} />
                <Route path="/settings" element={<P><SettingsPage /></P>} />
                <Route path="/billing" element={<P><BillingPage /></P>} />
                <Route path="/director" element={<P><DirectorDashboard /></P>} />
                <Route path="/admin" element={<P><AdminDashboardPage /></P>} />
                <Route path="/admin/plans" element={<P><AdminManagePlanPage /></P>} />
                <Route path="/admin/bias" element={<P><BiasAuditDashboard /></P>} />
                <Route path="/admin/consent" element={<P><ParentalConsentPage /></P>} />
                <Route path="/reports" element={<P><ReportsPage /></P>} />
                <Route path="/players/new" element={<P><PlayerForm /></P>} />
                {/* Hub consolidado · /players/:id?tab=resumen|stats|movimiento|rol|historico */}
                <Route path="/players/:id" element={<P><PlayerHubPage /></P>} />
                <Route path="/players/:id/edit" element={<P><PlayerForm /></P>} />
                {/* Legacy compat · ahora redirigen al hub con tab pre-seleccionado */}
                <Route path="/players/:id/intelligence" element={<P><RedirectToHub tab="stats" /></P>} />
                <Route path="/players/:id/role-profile" element={<P><RedirectToHub tab="rol" /></P>} />
                <Route path="/players/:id/role-profile/compare" element={<P><RoleProfileCompare /></P>} />
                <Route path="/players/:id/role-profile/audit" element={<P><RoleProfileAudit /></P>} />
                {/* /classic jubilado → redirige al Hub (backward-compat de enlaces viejos). */}
                <Route path="/players/:id/classic" element={<RedirectToHub tab="resumen" />} />
                {/* Print-ready · 2 páginas A4 · descargable como PDF */}
                <Route path="/players/:id/print" element={<P><PlayerHubPrint /></P>} />
                <Route path="/players/:id/reports" element={<P><PlayerReportsPage /></P>} />
                <Route path="/players/:id/evolution" element={<P><PlayerEvolutionPage /></P>} />
                <Route path="/player/:id/analysis/:analysisId" element={<P><PlayerAnalysisPage /></P>} />
                {/* Alias: /player/:id/intelligence → misma página (backward compat) */}
                <Route path="/player/:id/intelligence" element={<P><PlayerIntelligencePage /></P>} />
                <Route path="/report/:id" element={<P><PlayerReportPrint /></P>} />
                <Route path="/analysis-report/:id" element={<AnalysisReportPrint />} />
                <Route path="/report-full/:id" element={<CompleteReportPrint />} />
                <Route path="/equipo" element={<P><TeamPage /></P>} />
                <Route path="/team-analysis" element={<P><TeamAnalysisPage /></P>} />
                <Route path="/equipo/baseline" element={<P><TeamBaselinePage /></P>} />
                <Route path="/live" element={<P><LiveHubPage /></P>} />
                <Route path="/live/:matchId" element={<P><LiveMatchPage /></P>} />
                <Route path="/live/:matchId/summary" element={<P><LiveSummaryPage /></P>} />
                <Route path="/equipo/rival" element={<P><CompareRivalPage /></P>} />
                <Route path="/equipo/partido" element={<P><MatchReportPage /></P>} />
                <Route path="/coach" element={<P><CoachDashboardPage /></P>} />
                <Route path="/wellbeing" element={<P><WellbeingDashboardPage /></P>} />
                <Route path="/family/:playerId" element={<P><ParentDashboardPage /></P>} />
                <Route path="/aceptar-invitacion" element={<AcceptInvitationPage />} />
                <Route path="/guide" element={<P><UserGuidePage /></P>} />
                <Route path="/set-pieces" element={<P><SetPiecePage /></P>} />
                <Route path="/set-pieces/new" element={<P><SetPieceEditorPage /></P>} />
                <Route path="/set-pieces/edit/:id" element={<P><SetPieceEditorPage /></P>} />
                <Route path="/set-pieces/folder/:id" element={<P><SetPieceFolderPage /></P>} />
                <Route path="/highlights" element={<P><HighlightsPage /></P>} />
                <Route path="/highlights/:id" element={<P><HighlightDetailPage /></P>} />
                <Route path="/behavioral" element={<P><BehavioralOverviewPage /></P>} />
                <Route path="/scanning" element={<P><ScanningIntelligencePage /></P>} />
                <Route path="/idp" element={<P><IDPIndexPage /></P>} />
                <Route path="/idp/:playerId" element={<P><IDPPage /></P>} />
                <Route path="/tactical" element={<P><TacticalIndexPage /></P>} />
                <Route path="/tactical/:matchId" element={<P><TacticalMatchPage /></P>} />
                <Route path="/transfer" element={<P><TransferMarketPage /></P>} />
                <Route path="/transfer/new" element={<P><CreateListingPage /></P>} />
                <Route path="/transfer/listing/:id" element={<P><ListingDetailPage /></P>} />
                <Route path="/velocidad-sprint" element={<P><SprintSpeed /></P>} />

                {/* Redirects for common broken URLs */}
              <Route path="/dashboard" element={<Navigate to="/pulse" replace />} />
              <Route path="/videos" element={<Navigate to="/reports" replace />} />
              <Route path="/players" element={<Navigate to="/rankings" replace />} />
              <Route path="/teams" element={<Navigate to="/equipo" replace />} />
              <Route path="/scouting" element={<Navigate to="/scout" replace />} />
              <Route path="/solo-drill" element={<Navigate to="/drill" replace />} />

              <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
            </ErrorBoundary>
            </main>
            </AcceptTermsGate>
            <BottomNav />
            <GlobalSearch />
            <ContextualFAB />
            <OnboardingTour />
            <FirstRunWizard />
            </DemoGate>
            </SyncProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
  );
};

export default App;
