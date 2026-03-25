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

// Catch React render crashes — prevents white screen
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err, info) { console.error("BonBox error:", err, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
          <div className="text-center max-w-md">
            <div className="text-5xl mb-4">📦</div>
            <h1 className="text-2xl font-bold text-gray-800 mb-2">Something went wrong</h1>
            <p className="text-gray-500 mb-6">This might be a connection issue. Try refreshing.</p>
            <button onClick={() => { this.setState({ hasError: false }); window.location.href = "/dashboard"; }}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold">
              Go to Dashboard
            </button>
            <button onClick={() => { this.setState({ hasError: false }); window.location.href = "/login"; }}
              className="ml-3 px-6 py-3 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition font-semibold">
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

// Everything else lazy-loaded (only downloaded when needed)
const Layout = lazy(() => import("./components/Layout"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const SalesPage = lazy(() => import("./pages/SalesPage"));
const ExpensesPage = lazy(() => import("./pages/ExpensesPage"));
const InventoryPage = lazy(() => import("./pages/InventoryPage"));
const StaffingPage = lazy(() => import("./pages/StaffingPage"));
const WastePage = lazy(() => import("./pages/WastePage"));
const WeeklyReportPage = lazy(() => import("./pages/WeeklyReportPage"));
const VatReportPage = lazy(() => import("./pages/VatReportPage"));
const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const FeedbackPage = lazy(() => import("./pages/FeedbackPage"));
const CashBookPage = lazy(() => import("./pages/CashBookPage"));
const RecentlyDeletedPage = lazy(() => import("./pages/RecentlyDeletedPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const PersonalPage = lazy(() => import("./pages/PersonalPage"));
const KhataPage = lazy(() => import("./pages/KhataPage"));
const LoanTrackerPage = lazy(() => import("./pages/LoanTrackerPage"));

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
