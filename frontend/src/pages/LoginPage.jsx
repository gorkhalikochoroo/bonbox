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
  const { login, googleLogin, needsEmailVerification } = useAuth();
  const { lang, setLang, LANGUAGES } = useLanguage();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  // Hide Google sign-in on native iOS (Apple requires Sign in with Apple for third-party login)
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  const hasGoogle = !!import.meta.env.VITE_GOOGLE_CLIENT_ID && !isNative;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await login(email, password);
      if (data.user && !data.user.email_verified && data.user.created_at && new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")) {
        navigate("/verify-email");
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      let msg;
      const detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        // Server returned a specific string error message
        msg = detail;
      } else if (Array.isArray(detail)) {
        // Pydantic validation errors — extract first readable message
        const first = detail[0] || {};
        msg = (first.msg || "Invalid input").replace(/^Value error,\s*/, "");
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
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="min-h-screen flex flex-col bg-[#fafaf7] dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        {/* Top bar — wordmark left, language dropdown right (Copenhagen-style minimal nav) */}
        <header className="px-6 sm:px-10 py-5 flex items-center justify-between border-b border-gray-200/60 dark:border-gray-800">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-900 dark:bg-white">
              <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="currentColor"
                      className="text-white dark:text-gray-900" strokeWidth="2.2"/>
                <path d="M9 8h10M9 12h10M9 16h6" stroke="currentColor"
                      className="text-white dark:text-gray-900" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-[15px] font-semibold tracking-tight">BonBox</span>
          </Link>

          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label="Language"
            className="text-[13px] bg-transparent border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1.5
              text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500
              focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-white dark:bg-gray-900">
                {l.label}
              </option>
            ))}
          </select>
        </header>

        {/* Body — single column, generous whitespace */}
        <main className="flex-1 flex items-center justify-center px-6 py-12 sm:py-20">
          <div className="w-full max-w-[400px]" style={{ animation: "slideUp 0.4s ease-out" }}>
            <h1 className="text-[28px] sm:text-[32px] font-semibold tracking-tight leading-[1.15] text-gray-900 dark:text-white">
              Welcome back
            </h1>
            <p className="text-[15px] text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">
              Sign in to continue with BonBox.
            </p>

            {error && (
              <div role="alert" className="mt-6 flex items-start gap-2.5 bg-red-50 dark:bg-red-900/20
                border border-red-200 dark:border-red-800/60 text-red-700 dark:text-red-300 px-3.5 py-3 rounded-lg text-[13px]">
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-7 space-y-4">
              <div>
                <label htmlFor="email" className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  className="w-full px-3.5 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700
                    rounded-lg text-[15px] text-gray-900 dark:text-white placeholder:text-gray-400
                    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  required
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="block text-[13px] font-medium text-gray-700 dark:text-gray-300">
                    Password
                  </label>
                  <Link to="/forgot-password"
                        className="text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white underline-offset-2 hover:underline">
                    Forgot?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    className="w-full px-3.5 pr-11 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700
                      rounded-lg text-[15px] text-gray-900 dark:text-white placeholder:text-gray-400
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    aria-label={showPass ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {showPass ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 py-2.5 rounded-lg
                  text-[14px] font-medium hover:bg-gray-800 dark:hover:bg-gray-100
                  disabled:opacity-60 disabled:cursor-not-allowed transition
                  flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Signing in…
                  </>
                ) : "Sign in"}
              </button>
            </form>

            {hasGoogle && (
              <>
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800"/>
                  <span className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">or</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800"/>
                </div>
                <div className="flex justify-center [&>div]:w-full">
                  <GoogleLogin
                    onSuccess={(res) => {
                      setError("");
                      googleLogin(res.credential)
                        .then((data) => {
                          if (data.user && !data.user.email_verified && data.user.created_at && new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")) {
                            navigate("/verify-email");
                          } else {
                            navigate("/dashboard");
                          }
                        })
                        .catch((err) => setError(err.response?.data?.detail || "Google sign-in failed"));
                    }}
                    onError={() => setError("Google sign-in failed")}
                    shape="rectangular"
                    size="large"
                    width="400"
                    text="signin_with"
                    theme={typeof window !== "undefined" && document.documentElement.classList.contains("dark") ? "filled_black" : "outline"}
                  />
                </div>
              </>
            )}

            <p className="mt-7 text-center text-[13px] text-gray-500 dark:text-gray-400">
              New to BonBox?{" "}
              <Link to="/register" className="text-gray-900 dark:text-white font-medium underline-offset-2 hover:underline">
                Create an account
              </Link>
            </p>
          </div>
        </main>

        {/* Footer — quietly Danish */}
        <footer className="px-6 sm:px-10 py-5 text-[12px] text-gray-400 dark:text-gray-500 flex items-center justify-between border-t border-gray-200/60 dark:border-gray-800">
          <span>Made in Copenhagen · GDPR · EU-hosted</span>
          <div className="flex items-center gap-4">
            <Link to="/privacy" className="hover:text-gray-700 dark:hover:text-gray-300">Privacy</Link>
            <Link to="/terms" className="hover:text-gray-700 dark:hover:text-gray-300">Terms</Link>
          </div>
        </footer>
      </div>
    </>
  );
}
