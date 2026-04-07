import { Component, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { LanguageProvider } from "./hooks/useLanguage";

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

// Landing, Login, Register load immediately (small)
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ContactPage from "./pages/ContactPage";
import TermsPage from "./pages/TermsPage";
import CookiePolicyPage from "./pages/CookiePolicyPage";

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
const Layout = lazyRetry(() => import("./components/Layout"));
const ForgotPasswordPage = lazyRetry(() => import("./pages/ForgotPasswordPage"));
const DashboardPage = lazyRetry(() => import("./pages/DashboardPage"));
const SalesPage = lazyRetry(() => import("./pages/SalesPage"));
const ExpensesPage = lazyRetry(() => import("./pages/ExpensesPage"));
const InventoryPage = lazyRetry(() => import("./pages/InventoryPage"));
const StaffingPage = lazyRetry(() => import("./pages/StaffingPage"));
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
const LoanTrackerPage = lazyRetry(() => import("./pages/LoanTrackerPage"));
const WeatherPage = lazyRetry(() => import("./pages/WeatherPage"));
const BankImportPage = lazyRetry(() => import("./pages/BankImportPage"));
const BudgetPage = lazyRetry(() => import("./pages/BudgetPage"));
const PrivacyPolicyPage = lazyRetry(() => import("./pages/PrivacyPolicyPage"));

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" />;
  return children;
}

function PublicOrDashboard() {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (user) return <Navigate to="/dashboard" />;
  return <LandingPage />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<PublicOrDashboard />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/cookies" element={<CookiePolicyPage />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/staffing" element={<StaffingPage />} />
          <Route path="/weather" element={<WeatherPage />} />
          <Route path="/waste" element={<WastePage />} />
          <Route path="/weekly-report" element={<WeeklyReportPage />} />
          <Route path="/vat-report" element={<VatReportPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/cashbook" element={<CashBookPage />} />
          <Route path="/recently-deleted" element={<RecentlyDeletedPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/personal" element={<PersonalPage />} />
          <Route path="/khata" element={<KhataPage />} />
          <Route path="/loans" element={<LoanTrackerPage />} />
          <Route path="/bank-import" element={<BankImportPage />} />
          <Route path="/budgets" element={<BudgetPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <LanguageProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </LanguageProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
