import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { LanguageProvider } from "./hooks/useLanguage";
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
import FeedbackPage from "./pages/FeedbackPage";
import CashBookPage from "./pages/CashBookPage";
import ContactPage from "./pages/ContactPage";
import RecentlyDeletedPage from "./pages/RecentlyDeletedPage";
import ProfilePage from "./pages/ProfilePage";
import PersonalPage from "./pages/PersonalPage";

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
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/cashbook" element={<CashBookPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/recently-deleted" element={<RecentlyDeletedPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/personal" element={<PersonalPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
