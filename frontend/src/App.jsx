import { Component, lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { EntitlementsProvider } from "./hooks/useEntitlements";
import { FeaturesProvider } from "./hooks/useFeatures";
import { PillarsProvider } from "./hooks/usePillars";
import { LiveAlertsProvider } from "./hooks/useLiveAlerts";
import { BranchProvider } from "./components/BranchSelector";
import { LanguageProvider } from "./hooks/useLanguage";
import { GoogleOAuthProvider } from "@react-oauth/google";

// ── Keep-alive: prevent Render cold starts ──
// Pings health endpoint every 10 min while app is open
const API_BASE = import.meta.env.VITE_API_URL || "";
function useKeepAlive() {
  useEffect(() => {
    const ping = () => fetch(`${API_BASE}/api/health`, { method: "HEAD" }).catch(() => {});
    ping(); // immediate ping on app load
    const id = setInterval(ping, 10 * 60 * 1000); // every 10 min
    return () => clearInterval(id);
  }, []);
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

// Loading spinner for lazy-loaded pages
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-900">
      <div className="text-center">
        <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-3" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        <p className="text-gray-500 dark:text-gray-400 text-sm">Loading...</p>
      </div>
    </div>
  );
}

// Catch React render crashes — auto-recovers from stale cache
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, retrying: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err, info) {
    console.error("BonBox error:", err, info);
    // Auto-recover from chunk loading failures (stale deploy / slow network)
    const isChunkError = err?.message?.includes("Loading chunk") || err?.message?.includes("Failed to fetch dynamically imported");
    const retryCount = parseInt(sessionStorage.getItem("error_retry_count") || "0", 10);
    if (retryCount < 2) {
      sessionStorage.setItem("error_retry_count", String(retryCount + 1));
      if ("caches" in window) {
        caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => {
          window.location.reload();
        });
      } else {
        window.location.reload();
      }
    }
    // Clear retry count after 60s so future crashes can auto-recover again
    setTimeout(() => sessionStorage.removeItem("error_retry_count"), 60000);
  }
  handleClearAndReload = () => {
    this.setState({ retrying: true });
    sessionStorage.removeItem("error_retry_count");
    if ("caches" in window) {
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => {
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  };
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-900 px-4">
          <div className="text-center max-w-md">
            <div className="text-5xl mb-4">📦</div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">Something went wrong</h1>
            <p className="text-gray-500 dark:text-gray-400 mb-6">This might be a connection issue. Try refreshing.</p>
            <button onClick={this.handleClearAndReload} disabled={this.state.retrying}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold disabled:opacity-60">
              {this.state.retrying ? "Refreshing..." : "Refresh & Try Again"}
            </button>
            <button onClick={() => { this.setState({ hasError: false }); window.location.href = "/login"; }}
              className="ml-3 px-6 py-3 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition font-semibold">
              Sign In
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// CookieConsent is shown on every route (incl. login/register/landing)
// so it stays statically imported — lazy-loading it would flash the
// banner in late after first paint.
import CookieConsent from "./components/CookieConsent";
// PillarGate — RELEVANCE-axis interstitial. Wraps ONLY owner pillar pages
// (reservations / events / inventory / staff / insights). A deactivated
// pillar deep link renders a one-tap "turn back on" card instead of the
// page — never a 404, never a redirect. Statically imported (tiny) so the
// gate decision happens before the lazy page chunk is even fetched.
// NEVER wraps public (/r, /e, /s, /scan), spine, accountant, or auth routes.
import PillarGate from "./components/PillarGate";

/**
 * Self-contained ErrorBoundary for the cookie banner. If anything inside the
 * CookieConsent component throws (a hardened browser, weird locale, broken
 * localStorage proxy, etc.) we silently render nothing rather than letting
 * a non-essential UI surface crash the entire app. The user is still
 * compliant — the banner just doesn't show this session, and we log it.
 */
class CookieConsentBoundary extends Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(err) { try { console.warn("CookieConsent crashed:", err); } catch {} }
  render() { return this.state.broken ? null : this.props.children; }
}

// Retry wrapper for lazy imports — retries 2x on slow connections
function lazyRetry(importFn) {
  return lazy(() => importFn().catch(() =>
    new Promise((resolve) => setTimeout(resolve, 1500)).then(() =>
      importFn().catch(() =>
        new Promise((resolve) => setTimeout(resolve, 3000)).then(() => importFn())
      )
    )
  ));
}

// Everything else lazy-loaded (only downloaded when needed)
// Public-facing pages — lazy because authenticated users hitting
// /dashboard never need to download these. Saves ~250KB in the main
// bundle (LandingPage alone is heavy with marketing animations).
const LandingPage = lazyRetry(() => import("./pages/LandingPage"));
const LoginPage = lazyRetry(() => import("./pages/LoginPage"));
const LoginMagicPage = lazyRetry(() => import("./pages/LoginMagicPage"));
const RegisterPage = lazyRetry(() => import("./pages/RegisterPage"));
const ContactPage = lazyRetry(() => import("./pages/ContactPage"));
const TermsPage = lazyRetry(() => import("./pages/TermsPage"));
const CookiePolicyPage = lazyRetry(() => import("./pages/CookiePolicyPage"));
const Layout = lazyRetry(() => import("./components/Layout"));
const ForgotPasswordPage = lazyRetry(() => import("./pages/ForgotPasswordPage"));
const DashboardPage = lazyRetry(() => import("./pages/DashboardPage"));
const SalesPage = lazyRetry(() => import("./pages/SalesPage"));
const ExpensesPage = lazyRetry(() => import("./pages/ExpensesPage"));
const InventoryPage = lazyRetry(() => import("./pages/InventoryPage"));
// StaffingPage / WeatherPage (C7) are no longer routed here — they render
// embedded inside ScheduleForecastPanel on /staff/schedule, which imports
// them itself. /staffing + /weather are redirects (see the routes below).
const WastePage = lazyRetry(() => import("./pages/WastePage"));
const WeeklyReportPage = lazyRetry(() => import("./pages/WeeklyReportPage"));
const VatReportPage = lazyRetry(() => import("./pages/VatReportPage"));
const ReportsPage = lazyRetry(() => import("./pages/ReportsPage"));
const FeedbackPage = lazyRetry(() => import("./pages/FeedbackPage"));
const CashBookPage = lazyRetry(() => import("./pages/CashBookPage"));
const RecentlyDeletedPage = lazyRetry(() => import("./pages/RecentlyDeletedPage"));
const ProfilePage = lazyRetry(() => import("./pages/ProfilePage"));
const PersonalPage = lazyRetry(() => import("./pages/PersonalPage"));
const KhataPage = lazyRetry(() => import("./pages/KhataPage"));
// Invoicing module — Starter-tier feature for occasional businesses.
const FakturaPage = lazyRetry(() => import("./pages/FakturaPage"));
const FakturaReviewPage = lazyRetry(() => import("./pages/FakturaReviewPage"));
const CustomersPage = lazyRetry(() => import("./pages/CustomersPage"));
// Cultural events (migration 013, kulturarrangør sprint) — Sudip-style
// owners tag Sales by which event (movie night, pop-up stall) they belong to.
const EventsPage = lazyRetry(() => import("./pages/EventsPage"));
// Event-booking public surface (Phase 1 ship). Visitor-facing pages —
// no auth, must work for FB-click cold loads. /scan is organizer-only
// (auth required) for door-side QR check-in.
const EventPublicPage = lazyRetry(() => import("./pages/EventPublicPage"));
const BookingCheckoutPage = lazyRetry(() => import("./pages/BookingCheckoutPage"));
const BookingSuccessPage = lazyRetry(() => import("./pages/BookingSuccessPage"));
const TicketPage = lazyRetry(() => import("./pages/TicketPage"));
const DoorScanPage = lazyRetry(() => import("./pages/DoorScanPage"));
// Reservations (table booking + appointments). Public widget at /r/:slug
// is no-auth (guest books from a link / table QR). Owner book lives at
// /reservations and is a Starter+ feature, gated inside the page.
const ReservationPublicPage = lazyRetry(() => import("./pages/ReservationPublicPage"));
const ReservationsPage = lazyRetry(() => import("./pages/ReservationsPage"));
const MileagePage = lazyRetry(() => import("./pages/MileagePage"));
const LoanTrackerPage = lazyRetry(() => import("./pages/LoanTrackerPage"));
// C5 nav-diet (Imports merge): /bank-import + /payment-imports are now ONE
// 'Imports' destination — a thin TabPills wrapper. The legacy routes stay
// registered but redirect into the right tab (below). The two underlying
// pages are still imported by ImportsPage, so no dynamic-import is needed
// for them here anymore.
const ImportsPage = lazyRetry(() => import("./pages/ImportsPage"));
const BudgetPage = lazyRetry(() => import("./pages/BudgetPage"));
const TeamPage = lazyRetry(() => import("./pages/TeamPage"));
const CashFlowPage = lazyRetry(() => import("./pages/CashFlowPage"));
const TaxAutopilotPage = lazyRetry(() => import("./pages/TaxAutopilotPage"));
// PricingPage / RetentionPage / CompetitorPage (C7) are no longer routed here —
// they render as embedded tab bodies inside InsightsHubPage, which imports
// them itself. /pricing, /retention, /competitors are redirects (below).
const ExpiryPage = lazyRetry(() => import("./pages/ExpiryPage"));
const OutletPage = lazyRetry(() => import("./pages/OutletPage"));
const BranchPage = lazyRetry(() => import("./pages/BranchPage"));
const TerminalsPage = lazyRetry(() => import("./pages/TerminalsPage"));
const ModulesPage = lazyRetry(() => import("./pages/ModulesPage"));
const ConsolidatedClosePage = lazyRetry(() => import("./pages/ConsolidatedClosePage"));
const BarPage = lazyRetry(() => import("./pages/BarPage"));
const MultiTerminalClosePage = lazyRetry(() => import("./pages/MultiTerminalClosePage"));
const ShareRecipientsPage = lazyRetry(() => import("./pages/ShareRecipientsPage"));
const DailyClosePage = lazyRetry(() => import("./pages/DailyClosePage"));
const WorkshopPage = lazyRetry(() => import("./pages/WorkshopPage"));
const WineListPage = lazyRetry(() => import("./pages/WineListPage"));
const JobCardPage = lazyRetry(() => import("./pages/JobCardPage"));
const NewJobPage = lazyRetry(() => import("./pages/JobCardPage").then(m => ({ default: m.NewJobPage })));
const PrivacyPolicyPage = lazyRetry(() => import("./pages/PrivacyPolicyPage"));
const StaffSchedulePage = lazyRetry(() => import("./pages/StaffSchedulePage"));
const StaffHoursPage = lazyRetry(() => import("./pages/StaffHoursPage"));
const TimeRegistrationPage = lazyRetry(() => import("./pages/TimeRegistrationPage"));
const StaffTipsPage = lazyRetry(() => import("./pages/StaffTipsPage"));
const StaffPayrollPage = lazyRetry(() => import("./pages/StaffPayrollPage"));
const MorePage = lazyRetry(() => import("./pages/MorePage"));
const StaffPortalPage = lazyRetry(() => import("./pages/StaffPortalPage"));
const VerifyEmailPage = lazyRetry(() => import("./pages/VerifyEmailPage"));
// Task #55 — First-run welcome wizard. Full-screen, no Layout chrome.
const OnboardingPage = lazyRetry(() => import("./pages/OnboardingPage"));
const AdminPage = lazyRetry(() => import("./pages/AdminPage"));
const AdminTrainingPage = lazyRetry(() => import("./pages/AdminTrainingPage"));
const SubscriptionPage = lazyRetry(() => import("./pages/SubscriptionPage"));
const BookkeepingExportPage = lazyRetry(() => import("./pages/BookkeepingExportPage"));
// C6 — /insights is now the InsightsHub (TabPills over the AI-insights,
// pricing+market, and retention pages as embedded tab bodies). The hub
// lazy-loads InsightsPage / PricingPage / CompetitorPage / RetentionPage
// itself, so App.jsx only needs the hub here.
const InsightsHubPage = lazyRetry(() => import("./pages/InsightsHubPage"));
// Property Financial Report — the legacy "Today's Floor" page.
// Merged into End-of-Day Close (#150); /daily-report now redirects
// to /daily-close. The component file is kept for back-compat but
// is no longer routed to, so we drop the lazy import to keep the
// chunk graph clean. If the file needs to be re-introduced, restore
// the import + register the route below.
// Order Channel Settings — user-editable catalogue of order channels
const ChannelSettingsPage = lazyRetry(() => import("./pages/ChannelSettingsPage"));
// Connections hub — single page showing all integrations + their status
const ConnectionsPage = lazyRetry(() => import("./pages/ConnectionsPage"));
// Task #49 — Accountant read-only login (stickiness moat)
const AcceptInvitePage = lazyRetry(() => import("./pages/AcceptInvitePage"));
const AccountantClientsPage = lazyRetry(() => import("./pages/AccountantClientsPage"));
// Task #202 — Team magic-link invite (P0 security; replaces the
// plaintext temp_password flow). Separate page from the accountant
// invite because the role chip + welcome copy + post-accept landing
// page are different (team members land on /dashboard with full
// app chrome; revisors land on /clients with their picker).
const TeamAcceptInvitePage = lazyRetry(() => import("./pages/TeamAcceptInvitePage"));

function ProtectedRoute({ children }) {
  const { user, loading, needsEmailVerification } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" />;
  // Allow skipping email verification (native apps or user chose "skip for now")
  const skipped = sessionStorage.getItem("skip_email_verify");
  if (needsEmailVerification() && !skipped) return <Navigate to="/verify-email" />;
  // Task #55 — first-run wizard. After signup, send the user to /onboarding
  // until they finish (or explicitly skip past) the welcome flow. We only
  // gate on the OWNER role here — team members and accountants don't see
  // the wizard (it's a brand-new-business flow). The wizard itself stamps
  // onboarding_completed_at then drops them on /dashboard.
  const role = (user.role || "owner").toLowerCase();
  if (
    role === "owner" &&
    user.onboarding_completed_at === null
  ) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
}

/**
 * OnboardingRoute — wraps the welcome wizard. Auth-required, owner-only.
 * If the user has already finished, we kick them to /dashboard so the
 * wizard can't be re-entered casually (they can re-trigger from Profile).
 */
function OnboardingRoute() {
  const { user, loading, needsEmailVerification } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  const skipped = sessionStorage.getItem("skip_email_verify");
  if (needsEmailVerification() && !skipped) {
    return <Navigate to="/verify-email" replace />;
  }
  const role = (user.role || "owner").toLowerCase();
  if (role !== "owner") return <Navigate to="/dashboard" replace />;
  if (user.onboarding_completed_at) return <Navigate to="/dashboard" replace />;
  return <OnboardingPage />;
}

/**
 * SuperAdminRoute — frontend gate for /admin pages.
 * Frontend gating is COSMETIC ONLY — backend require_super_admin enforces the
 * real boundary (multi-layer: role + email allowlist + verification + age + audit).
 * If the frontend check is bypassed, every API call still 404s.
 */
function SuperAdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "super_admin") return <Navigate to="/dashboard" replace />;
  if (!user.email_verified) return <Navigate to="/verify-email" replace />;
  return children;
}

function VerifyEmailRoute() {
  const { user, loading, needsEmailVerification } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" />;
  // If already verified or skipped, go to dashboard
  const skipped = sessionStorage.getItem("skip_email_verify");
  if (!needsEmailVerification() || skipped) return <Navigate to="/dashboard" />;
  return <VerifyEmailPage />;
}

function PublicOrDashboard() {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (user) return <Navigate to="/dashboard" />;
  // Staff fallback: if THIS device has a saved staff-portal token and the
  // visitor is NOT an authenticated owner (handled above), a landing on "/"
  // should go to THEIR schedule — not the marketing/owner app. This covers a
  // stale-bundle bounce, an old global-manifest PWA opening at its start_url,
  // or staff just typing the bare domain. Their portal token IS their
  // credential. (Previously gated on display-mode: standalone, which missed
  // staff who tap the link in a normal browser tab — the common case.)
  // Prospects who never opened a portal have no token and see the landing page.
  try {
    const portalToken = localStorage.getItem("bonbox_portal_token");
    if (portalToken) {
      return <Navigate to={`/s/${portalToken}`} replace />;
    }
  } catch { /* private mode / SSR — fall through to normal flow */ }
  // On native iOS, skip the marketing landing page (no third-party platform references, native feel)
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  if (isNative) return <Navigate to="/login" />;
  return <LandingPage />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<PublicOrDashboard />} />
        <Route path="/login" element={<LoginPage />} />
        {/* Task #61 — magic-link landing. Token in ?token=… is the only
            credential; the page POSTs to /auth/magic-link/verify on
            mount and redirects to /dashboard on success. */}
        <Route path="/login/magic" element={<LoginMagicPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailRoute />} />
        {/* Task #55 — First-run welcome wizard. Sits OUTSIDE the
            ProtectedRoute layout because the wizard is full-screen
            (no sidebar / mobile nav chrome). OnboardingRoute does its
            own auth + owner-only + onboarding-pending guards. */}
        <Route path="/onboarding" element={<OnboardingRoute />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/cookies" element={<CookiePolicyPage />} />
        <Route path="/s/:token" element={<StaffPortalPage />} />
        {/* Branded staff link — /s/<restaurant-slug>/<token>. Slug is cosmetic;
            the token is the capability key. StaffPortalPage reads :token in both. */}
        <Route path="/s/:slug/:token" element={<StaffPortalPage />} />
        {/* Task #49 — Public magic-link landing for revisor invites.
            Token in URL is the only credential; the page collects
            password + name and POSTs to /accountants/signup. */}
        <Route path="/accept-invite/:token" element={<AcceptInvitePage />} />
        {/* Task #202 — Team magic-link landing. Token is the only
            credential; the page collects a NEW password (no plaintext
            temp_password roundtrip) and POSTs to /team/accept-invite. */}
        <Route path="/accept-invite/team/:token" element={<TeamAcceptInvitePage />} />
        {/* Event-booking public surface — no auth required (guest checkout).
            Visitors land here from FB/Messenger clicks on the organizer's
            shared link. Mobile-first; cover image is the only color moment. */}
        <Route path="/e/:slug" element={<EventPublicPage />} />
        <Route path="/e/:slug/checkout" element={<BookingCheckoutPage />} />
        <Route path="/e/:slug/success" element={<BookingSuccessPage />} />
        <Route path="/t/:ticket_id" element={<TicketPage />} />
        {/* Reservations public widget — no auth (guest books a table from
            the restaurant's link / QR). Mobile-first; pick date → party →
            slot → details → confirm. */}
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/sales" element={<SalesPage />} />
          {/* EVENTS pillar. A hidden pillar shows the PillarGate interstitial
              (one tap to re-enable) instead of the page. */}
          <Route path="/events" element={<PillarGate pillar="events"><EventsPage /></PillarGate>} />
          {/* Reservations owner book — table bookings + appointments.
              RESERVATIONS pillar + Starter+ feature: pillar-hide (interstitial)
              and tier-lock (the page's own UpgradeNudge) are independent. */}
          <Route path="/reservations" element={<PillarGate pillar="reservations"><ReservationsPage /></PillarGate>} />
          {/* Organizer-only door-scan PWA page — opens camera, scans QR
              codes against the selected event's tickets. Capacitor 8
              and web both go through getUserMedia. NOT pillar-gated: door-scan
              is an operational capability surface (HARD INVARIANT). */}
          <Route path="/scan" element={<DoorScanPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          {/* INVENTORY pillar — covers stock + its sub-surfaces (waste,
              expiry) and the opt-in verticals (wine-list, bar-pour). */}
          <Route path="/inventory" element={<PillarGate pillar="inventory"><InventoryPage /></PillarGate>} />
          {/* C7 Intelligence collapse — smart-staffing + weather-smart folded
              into the Schedule page's forecast panel. Legacy routes stay
              registered as permanent redirects so old bookmarks / push links
              land on the new home (Cmd-K "weather"/"staffing" also routes
              there via the /staff/schedule manifest aliases). */}
          <Route path="/staffing" element={<Navigate to="/staff/schedule" replace />} />
          <Route path="/weather" element={<Navigate to="/staff/schedule" replace />} />
          <Route path="/waste" element={<PillarGate pillar="inventory"><WastePage /></PillarGate>} />
          <Route path="/weekly-report" element={<WeeklyReportPage />} />
          <Route path="/vat-report" element={<VatReportPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/cashbook" element={<CashBookPage />} />
          <Route path="/cashflow" element={<CashFlowPage />} />
          <Route path="/tax" element={<TaxAutopilotPage />} />
          {/* C7 Intelligence collapse — pricing + competitors + retention are
              now TABS of the InsightsHub at /insights. Legacy routes stay
              registered as permanent redirects into the matching tab so old
              bookmarks / deep links survive. */}
          <Route path="/pricing" element={<Navigate to="/insights?tab=pricing" replace />} />
          <Route path="/retention" element={<Navigate to="/insights?tab=guests" replace />} />
          <Route path="/expiry" element={<PillarGate pillar="inventory"><ExpiryPage /></PillarGate>} />
          <Route path="/outlets" element={<OutletPage />} />
          <Route path="/competitors" element={<Navigate to="/insights?tab=pricing" replace />} />
          <Route path="/branches" element={<BranchPage />} />
          <Route path="/terminals" element={<TerminalsPage />} />
          <Route path="/modules" element={<ModulesPage />} />
          <Route path="/consolidated-close" element={<ConsolidatedClosePage />} />
          <Route path="/daily-close/multi" element={<MultiTerminalClosePage />} />
          <Route path="/share-recipients" element={<ShareRecipientsPage />} />
          <Route path="/daily-close" element={<DailyClosePage />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/wine-list" element={<PillarGate pillar="inventory"><WineListPage /></PillarGate>} />
          <Route path="/bar" element={<PillarGate pillar="inventory"><BarPage /></PillarGate>} />
          <Route path="/workshop/job/:id" element={<JobCardPage />} />
          <Route path="/workshop/new-job" element={<NewJobPage />} />
          <Route path="/recently-deleted" element={<RecentlyDeletedPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/personal" element={<PersonalPage />} />
          <Route path="/khata" element={<KhataPage />} />
          <Route path="/faktura" element={<FakturaPage />} />
          <Route path="/faktura/review" element={<FakturaReviewPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/mileage" element={<MileagePage />} />
          <Route path="/loans" element={<LoanTrackerPage />} />
          {/* C5 Imports merge — one destination, two tabs. The legacy paths
              stay registered but redirect into the matching tab so old
              bookmarks / deep links / Connections-page links don't break. */}
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/bank-import" element={<Navigate to="/imports?tab=bank" replace />} />
          <Route path="/payment-imports" element={<Navigate to="/imports?tab=payments" replace />} />
          <Route path="/budgets" element={<BudgetPage />} />
          <Route path="/team" element={<TeamPage />} />
          {/* STAFF pillar — every /staff/* owner page. (The PUBLIC staff
              portal /s/:token is a separate, NON-gated route above.) */}
          <Route path="/staff/schedule" element={<PillarGate pillar="staff"><StaffSchedulePage /></PillarGate>} />
          <Route path="/staff/hours" element={<PillarGate pillar="staff"><StaffHoursPage /></PillarGate>} />
          <Route path="/staff/time-registration" element={<PillarGate pillar="staff"><TimeRegistrationPage /></PillarGate>} />
          <Route path="/staff/tips" element={<PillarGate pillar="staff"><StaffTipsPage /></PillarGate>} />
          <Route path="/staff/payroll" element={<PillarGate pillar="staff"><StaffPayrollPage /></PillarGate>} />
          <Route path="/more" element={<MorePage />} />
          <Route path="/subscription" element={<SubscriptionPage />} />
          <Route path="/bookkeeping-export" element={<BookkeepingExportPage />} />
          {/* INSIGHTS pillar — the InsightsHub (AI · Priser & marked · Gæster). */}
          <Route path="/insights" element={<PillarGate pillar="insights"><InsightsHubPage /></PillarGate>} />
          {/* Today's Floor merged into End-of-Day Close (#150). The
              page now lives at /daily-close — top of page shows the
              live KPIs that used to be at /daily-report. We keep the
              legacy route as a permanent redirect so bookmarks, share
              links, and any cached push notifications still land on
              the right page. Search engines / analytics treat
              <Navigate replace> as a same-tab replace (no history
              entry), so the back button works the way owners expect. */}
          <Route path="/daily-report" element={<Navigate to="/daily-close" replace />} />
          <Route path="/channel-settings" element={<ChannelSettingsPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          {/* Task #49 — Accountant client picker. Renders for accountants
              with 2+ active grants. Bypasses the standard Layout because
              the picker is its own minimal full-screen experience. */}
          <Route path="/accountant/clients" element={<AccountantClientsPage />} />
        </Route>
        {/* /admin — gated frontend, but real enforcement is server-side */}
        <Route
          element={
            <SuperAdminRoute>
              <Layout />
            </SuperAdminRoute>
          }
        >
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/training" element={<AdminTrainingPage />} />
        </Route>
        {/* Catch-all — any unknown / mistyped / stale-bookmark URL routes to
            "/", which renders the landing page (logged-out) or the dashboard
            (logged-in). Without this, an unmatched path rendered a blank
            white screen with no redirect. (Audit 2026-06-10) */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function AppInner() {
  useKeepAlive(); // ping Render every 10 min to prevent cold starts
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <LanguageProvider>
          <AuthProvider>
            {/* EntitlementsProvider sits INSIDE AuthProvider because the
                /billing/entitlements call needs the auth cookie/header.
                The hook fails closed (Free shape) if unauthenticated, so
                pre-login pages still render fine. */}
            <EntitlementsProvider>
              {/* FeaturesProvider exposes public feature flags
                  (bank_connect_enabled, mobilepay_enabled). Sits
                  inside Auth so it can use the same axios instance,
                  but the endpoint is public — works pre-login too. */}
              <FeaturesProvider>
                {/* PillarsProvider — the RELEVANCE axis (per-account pillar
                    toggles). Sits inside Auth (it reads user.role to no-op for
                    accountant-view) and wraps Branch + the routes so Layout,
                    MorePage, the ⌘K palette, and PillarGate all read the same
                    hiddenPillars Set. Free + uncapped — no entitlement coupling. */}
                <PillarsProvider>
                  <BranchProvider>
                    {/* LiveAlertsProvider — host-stand "pop + sound" on booking/
                        allergy changes. Inside Router (uses navigate) + Auth (no-ops
                        for accountant/logged-out); renders the global toast layer and
                        feeds the NotificationCenter bell. */}
                    <LiveAlertsProvider>
                      <AppRoutes />
                      {/* Cookie consent renders on top of any route, including landing/
                          login/register where pre-auth visitors must see it.
                          Wrapped in its own boundary so a failure here NEVER breaks the
                          rest of the app. */}
                      <CookieConsentBoundary>
                        <CookieConsent />
                      </CookieConsentBoundary>
                    </LiveAlertsProvider>
                  </BranchProvider>
                </PillarsProvider>
              </FeaturesProvider>
            </EntitlementsProvider>
          </AuthProvider>
        </LanguageProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default function App() {
  if (!GOOGLE_CLIENT_ID) return <AppInner />;
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AppInner />
    </GoogleOAuthProvider>
  );
}
