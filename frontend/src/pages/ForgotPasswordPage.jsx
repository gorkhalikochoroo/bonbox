import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";

const inputCls = "w-full pl-11 pr-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-base text-gray-800 dark:text-gray-200 placeholder:text-gray-400 transition";

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
    <>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
      `}</style>

      <div className="min-h-screen flex bg-white dark:bg-gray-900">
        {/* Left panel — lock illustration */}
        <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-800 dark:via-gray-800 dark:to-gray-800 items-center justify-center p-12 relative overflow-hidden">
          <div className="absolute top-10 left-10 w-64 h-64 bg-blue-200/30 dark:bg-blue-900/20 rounded-full blur-3xl" />
          <div className="absolute bottom-20 right-10 w-48 h-48 bg-indigo-200/40 dark:bg-indigo-900/20 rounded-full blur-3xl" />
          <div className="relative z-10 text-center">
            <svg viewBox="0 0 300 300" fill="none" className="w-64 mx-auto" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.08))" }}>
              <ellipse cx="150" cy="160" rx="130" ry="120" fill="#EEF2FF" className="dark:opacity-10" />
              {/* Lock body */}
              <g className="animate-[float_3s_ease-in-out_infinite]">
                <rect x="95" y="140" width="110" height="90" rx="16" fill="#6366F1" />
                <rect x="105" y="150" width="90" height="70" rx="12" fill="#818CF8" />
                {/* Keyhole */}
                <circle cx="150" cy="178" r="12" fill="#312E81" />
                <rect x="146" y="185" width="8" height="16" rx="4" fill="#312E81" />
              </g>
              {/* Lock shackle */}
              <g className="animate-[float_3s_ease-in-out_infinite]">
                <path d="M120 145 v-25 a30 30 0 0 1 60 0 v25" stroke="#4F46E5" strokeWidth="10" strokeLinecap="round" fill="none" />
              </g>
              {/* Sparkle */}
              <g className="animate-[float_2.5s_ease-in-out_infinite_0.5s]">
                <circle cx="230" cy="100" r="16" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
                <path d="M230 92 l2 6 6-2 -4 5 4 5 -6-2 -2 6 -2-6 -6 2 4-5 -4-5 6 2z" fill="white" />
              </g>
              {/* Key floating */}
              <g className="animate-[float_3.5s_ease-in-out_infinite_0.8s]">
                <circle cx="80" cy="100" r="14" fill="none" stroke="#10B981" strokeWidth="3" />
                <rect x="90" y="96" width="30" height="8" rx="4" fill="#10B981" />
                <rect x="110" y="100" width="4" height="10" rx="2" fill="#10B981" />
                <rect x="118" y="100" width="4" height="8" rx="2" fill="#10B981" />
              </g>
            </svg>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white mt-6">
              No worries!
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mt-2 max-w-xs mx-auto">
              We'll send you a code to reset your password in seconds.
            </p>
          </div>
        </div>

        {/* Right panel — form */}
        <div className="flex-1 flex items-center justify-center px-6 py-10">
          <div className="w-full max-w-md" style={{ animation: "slideUp 0.5s ease-out" }}>
            {/* Logo + heading */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-11 h-11 bg-green-600 rounded-xl flex items-center justify-center shadow-lg shadow-green-600/20">
                  <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
                    <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.5"/>
                    <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2"/>
                  </svg>
                </div>
                <span className="text-xl font-bold text-gray-800 dark:text-white">BonBox</span>
              </div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Reset password</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1.5">
                {step === 1 && "Enter your email and we'll send a reset code"}
                {step === 2 && "Enter the code from your email"}
                {step === 3 && "You're all set!"}
              </p>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-6">
              {[1, 2, 3].map((s) => (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                    step >= s
                      ? "bg-green-600 text-white shadow-lg shadow-green-600/20"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-400"
                  }`}>
                    {step > s ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    ) : s}
                  </div>
                  {s < 3 && <div className={`flex-1 h-0.5 rounded ${step > s ? "bg-green-500" : "bg-gray-200 dark:bg-gray-700"}`} />}
                </div>
              ))}
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {step === 1 && (
              <form onSubmit={handleRequestReset} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Email address</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={inputCls}
                      placeholder="you@company.com"
                      required
                    />
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="w-full bg-green-600 text-white py-3.5 rounded-xl hover:bg-green-700 active:scale-[0.98] transition-all font-semibold text-base disabled:opacity-50 shadow-lg shadow-green-600/20">
                  {loading ? "Sending..." : "Send Reset Code"}
                </button>
                <p className="text-center text-sm text-gray-500 dark:text-gray-400">
                  <Link to="/login" className="text-green-600 dark:text-green-400 hover:underline font-medium">Back to sign in</Link>
                </p>
              </form>
            )}

            {step === 2 && (
              <div style={{ animation: "slideUp 0.3s ease-out" }}>
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 p-4 rounded-xl mb-5 text-center">
                  <p className="text-sm text-blue-800 dark:text-blue-300">
                    If an account exists with <strong>{email}</strong>, we've sent a reset code.
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">Check inbox & spam</p>
                </div>
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">6-digit code</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="w-full px-4 py-3.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 text-center text-2xl font-bold tracking-[0.5em] text-gray-800 dark:text-gray-200"
                      placeholder="------"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">New Password</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                      </span>
                      <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                        className={inputCls} placeholder="Min 8 characters" required minLength={8} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Confirm Password</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      </span>
                      <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                        className={inputCls} placeholder="Re-enter password" required minLength={8} />
                    </div>
                  </div>
                  <button type="submit" disabled={loading || code.length !== 6}
                    className="w-full bg-green-600 text-white py-3.5 rounded-xl hover:bg-green-700 active:scale-[0.98] transition-all font-semibold text-base disabled:opacity-50 shadow-lg shadow-green-600/20">
                    {loading ? "Resetting..." : "Reset Password"}
                  </button>
                  <div className="flex justify-between text-sm">
                    <button type="button" onClick={() => { setStep(1); setError(""); setCode(""); }}
                      className="text-green-600 dark:text-green-400 hover:underline font-medium">
                      Try different email
                    </button>
                    <button type="button" onClick={handleRequestReset}
                      className="text-gray-500 dark:text-gray-400 hover:underline">
                      Resend code
                    </button>
                  </div>
                </form>
              </div>
            )}

            {step === 3 && (
              <div className="text-center space-y-5" style={{ animation: "slideUp 0.3s ease-out" }}>
                <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                </div>
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 p-4 rounded-xl">
                  <p className="text-green-700 dark:text-green-400 font-medium">{success}</p>
                </div>
                <Link to="/login"
                  className="inline-block w-full bg-green-600 text-white py-3.5 rounded-xl hover:bg-green-700 active:scale-[0.98] transition-all font-semibold text-center shadow-lg shadow-green-600/20">
                  Sign in with new password
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
