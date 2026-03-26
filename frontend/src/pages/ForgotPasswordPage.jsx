import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";

export default function ForgotPasswordPage() {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRequestReset = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.detail || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/reset-password", {
        email,
        reset_token: code,
        new_password: newPassword,
      });
      setSuccess(res.data.message);
      setStep(3);
    } catch (err) {
      setError(err.response?.data?.detail || "Invalid code or something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="bg-white p-6 sm:p-8 rounded-xl shadow-md w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600 rounded-2xl mb-3">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
              <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">BonBox</h1>
          <p className="text-sm text-gray-500 mt-1">Reset your password</p>
        </div>

        {error && (
          <p className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</p>
        )}

        {step === 1 && (
          <form onSubmit={handleRequestReset} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                placeholder="Enter your account email"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-semibold text-base disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send Reset Code"}
            </button>
            <p className="text-center text-sm text-gray-600">
              <Link to="/login" className="text-blue-600 hover:underline">
                Back to sign in
              </Link>
            </p>
          </form>
        )}

        {step === 2 && (
          <>
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-4 text-center">
              <p className="text-sm text-blue-800">
                We sent a 6-digit code to <strong>{email}</strong>
              </p>
              <p className="text-xs text-blue-600 mt-1">Check your inbox (and spam folder)</p>
            </div>
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  6-digit code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-center text-2xl font-bold tracking-[0.5em]"
                  placeholder="••••••"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                  placeholder="Min 8 chars, include a letter and a digit"
                  required
                  minLength={8}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                  placeholder="Re-enter your new password"
                  required
                  minLength={8}
                />
              </div>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-semibold text-base disabled:opacity-50"
              >
                {loading ? "Resetting..." : "Reset Password"}
              </button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  onClick={() => { setStep(1); setError(""); setCode(""); }}
                  className="text-blue-600 hover:underline"
                >
                  Try different email
                </button>
                <button
                  type="button"
                  onClick={handleRequestReset}
                  className="text-gray-500 hover:underline"
                >
                  Resend code
                </button>
              </div>
            </form>
          </>
        )}

        {step === 3 && (
          <div className="text-center space-y-4">
            <div className="bg-green-50 border border-green-200 p-4 rounded-lg">
              <p className="text-green-700 font-medium">{success}</p>
            </div>
            <Link
              to="/login"
              className="inline-block w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-semibold text-center"
            >
              Sign in with new password →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
