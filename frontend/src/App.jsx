import { Component } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { LanguageProvider } from "./hooks/useLanguage";

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
import Layout from "./components/Layout";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import DashboardPage from "./pages/DashboardPage";
import SalesPage from "./pages/SalesPage";
import ExpensesPage from "./pages/ExpensesPage";
import InventoryPage from "./pages/InventoryPage";
import StaffingPage from "./pages/StaffingPage";
import WastePage from "./pages/WastePage";
import WeeklyReportPage from "./pages/WeeklyReportPage";
import VatReportPage from "./pages/VatReportPage";
import ReportsPage from "./pages/ReportsPage";
import FeedbackPage from "./pages/FeedbackPage";
import CashBookPage from "./pages/CashBookPage";
import ContactPage from "./pages/ContactPage";
import RecentlyDeletedPage from "./pages/RecentlyDeletedPage";
import ProfilePage from "./pages/ProfilePage";
import PersonalPage from "./pages/PersonalPage";
import KhataPage from "./pages/KhataPage";
import LoanTrackerPage from "./pages/LoanTrackerPage";

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
}

function PublicOrDashboard() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (user) return <Navigate to="/dashboard" />;
  return <LandingPage />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<PublicOrDashboard />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
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
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/recently-deleted" element={<RecentlyDeletedPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/personal" element={<PersonalPage />} />
        <Route path="/khata" element={<KhataPage />} />
        <Route path="/loans" element={<LoanTrackerPage />} />
      </Route>
    </Routes>
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
