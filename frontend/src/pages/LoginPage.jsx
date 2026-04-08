import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { GoogleLogin } from "@react-oauth/google";

/* Inline SVG illustration — a fun receipt-and-boxes scene */
function HeroIllustration() {
  return (
    <svg viewBox="0 0 400 400" fill="none" className="w-full max-w-sm mx-auto drop-shadow-lg" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.08))" }}>
      {/* Background blob */}
      <ellipse cx="200" cy="210" rx="170" ry="160" fill="#ECFDF5" className="dark:opacity-10" />

      {/* Desk */}
      <rect x="60" y="280" width="280" height="12" rx="6" fill="#D1FAE5" />
      <rect x="80" y="292" width="8" height="50" rx="4" fill="#A7F3D0" />
      <rect x="312" y="292" width="8" height="50" rx="4" fill="#A7F3D0" />

      {/* Big receipt */}
      <g className="animate-[float_3s_ease-in-out_infinite]">
        <rect x="130" y="100" width="90" height="170" rx="8" fill="white" stroke="#D1D5DB" strokeWidth="2" />
        <rect x="145" y="120" width="60" height="6" rx="3" fill="#E5E7EB" />
        <rect x="145" y="134" width="45" height="6" rx="3" fill="#E5E7EB" />
        <rect x="145" y="148" width="55" height="6" rx="3" fill="#E5E7EB" />
        <line x1="145" y1="168" x2="205" y2="168" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="4 3" />
        <rect x="145" y="180" width="35" height="8" rx="4" fill="#10B981" />
        <text x="148" y="187" fontSize="6" fill="white" fontWeight="bold">PAID</text>
        {/* Zigzag bottom */}
        <path d="M130 270 l7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 v0 h-90 z" fill="white" stroke="#D1D5DB" strokeWidth="2" strokeLinejoin="round" />
      </g>

      {/* Floating coin */}
      <g className="animate-[float_2.5s_ease-in-out_infinite_0.5s]">
        <circle cx="280" cy="140" r="24" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
        <text x="280" y="146" fontSize="16" fill="#92400E" fontWeight="bold" textAnchor="middle">$</text>
      </g>

      {/* Small box 1 */}
      <g className="animate-[float_3.5s_ease-in-out_infinite_1s]">
        <rect x="260" y="200" width="55" height="55" rx="10" fill="#34D399" stroke="#059669" strokeWidth="2" />
        <path d="M270 220 h35 M287 210 v20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </g>

      {/* Small box 2 */}
      <g className="animate-[float_4s_ease-in-out_infinite_0.3s]">
        <rect x="70" y="190" width="45" height="45" rx="10" fill="#A78BFA" stroke="#7C3AED" strokeWidth="2" />
        <path d="M82 212 l8 8 14-16" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Chart mini */}
      <g className="animate-[float_3s_ease-in-out_infinite_0.8s]">
        <rect x="80" y="120" width="40" height="50" rx="6" fill="#DBEAFE" stroke="#93C5FD" strokeWidth="1.5" />
        <polyline points="88,155 95,145 102,150 112,135" stroke="#3B82F6" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>

      {/* Sparkles */}
      <g fill="#FCD34D">
        <path d="M320 100 l3-8 3 8 -8-3 8-3z" className="animate-[twinkle_2s_ease-in-out_infinite]" />
        <path d="M100 90 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_0.7s]" />
        <path d="M340 250 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_1.4s]" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const { login, googleLogin } = useAuth();
  const { lang, setLang, LANGUAGES } = useLanguage();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const hasGoogle = !!import.meta.env.VITE_GOOGLE_CLIENT_ID;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/dashboard");
    } catch (err) {
      let msg;
      if (err.response?.data?.detail) {
        // Server returned a specific error message
        msg = err.response.data.detail;
      } else if (err.code === "ECONNABORTED") {
        msg = "Server is waking up — please wait 30s and try again";
      } else if (err.code === "ERR_NETWORK" || !err.response) {
        msg = "Cannot reach server — check your connection or try again in a moment";
      } else if (err.response?.status >= 500) {
        msg = "Server error — please try again in a moment";
      } else {
        msg = "Invalid email or password";
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Keyframe animations — pure CSS, no library */}
      <style>{`
        @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes twinkle { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.6); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      <div className="min-h-screen flex bg-white dark:bg-gray-900">
        {/* Left panel — illustration (hidden on mobile) */}
        <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 dark:from-gray-800 dark:via-gray-800 dark:to-gray-800 items-center justify-center p-12 relative overflow-hidden">
          {/* Decorative background circles */}
          <div className="absolute top-10 left-10 w-64 h-64 bg-green-200/30 dark:bg-green-900/20 rounded-full blur-3xl" />
          <div className="absolute bottom-20 right-10 w-48 h-48 bg-emerald-200/40 dark:bg-emerald-900/20 rounded-full blur-3xl" />

          <div className="relative z-10 text-center" style={{ animation: "fadeIn 0.8s ease-out" }}>
            <HeroIllustration />
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white mt-6">
              Your business, simplified.
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mt-2 max-w-xs mx-auto">
              Track sales, expenses, and receipts — all in one beautiful dashboard.
            </p>
          </div>
        </div>

        {/* Right panel — login form */}
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
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Welcome back!</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1.5">Sign in to continue managing your business</p>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Email</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full pl-11 pr-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-base text-gray-800 dark:text-gray-200 placeholder:text-gray-400 transition"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Password</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  </span>
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-11 pr-12 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-base text-gray-800 dark:text-gray-200 placeholder:text-gray-400 transition"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1"
                  >
                    {showPass ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500" />
                  <span className="text-sm text-gray-600 dark:text-gray-400">Remember me</span>
                </label>
                <Link to="/forgot-password" className="text-sm text-green-600 dark:text-green-400 hover:underline font-medium">
                  Forgot password?
                </Link>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-green-600 text-white py-3.5 rounded-xl hover:bg-green-700 active:scale-[0.98] transition-all font-semibold text-base disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-green-600/20"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    Signing in...
                  </>
                ) : "Sign In"}
              </button>
            </form>

            {/* Google Sign-In */}
            {hasGoogle && (
              <>
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                  <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">or</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                </div>
                <div className="flex justify-center [&>div]:w-full">
                  <GoogleLogin
                    onSuccess={(res) => {
                      setError("");
                      googleLogin(res.credential)
                        .then(() => navigate("/dashboard"))
                        .catch((err) => setError(err.response?.data?.detail || "Google sign-in failed"));
                    }}
                    onError={() => setError("Google sign-in failed")}
                    shape="rectangular"
                    size="large"
                    width="400"
                    text="signin_with"
                    theme="outline"
                  />
                </div>
              </>
            )}

            <p className="mt-5 text-center text-sm text-gray-500 dark:text-gray-400">
              Don't have an account?{" "}
              <Link to="/register" className="text-green-600 dark:text-green-400 hover:underline font-semibold">
                Create one
              </Link>
            </p>

            {/* Language switcher — compact flag grid */}
            <div className="flex flex-wrap justify-center gap-1 mt-6">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => setLang(l.code)}
                  title={l.label}
                  className={`w-9 h-9 rounded-lg text-base flex items-center justify-center transition ${
                    lang === l.code
                      ? "bg-green-50 dark:bg-green-900/30 ring-2 ring-green-400 dark:ring-green-500 scale-110"
                      : "hover:bg-gray-100 dark:hover:bg-gray-800 opacity-60 hover:opacity-100"
                  }`}
                >
                  {l.flag}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
