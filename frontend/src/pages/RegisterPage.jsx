import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { GoogleLogin } from "@react-oauth/google";

/* Inline SVG — growth / rocket scene for registration */
function RegisterIllustration() {
  return (
    <svg viewBox="0 0 400 400" fill="none" className="w-full max-w-sm mx-auto" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.08))" }}>
      <ellipse cx="200" cy="210" rx="170" ry="160" fill="#ECFDF5" className="dark:opacity-10" />
      {/* Ground */}
      <rect x="60" y="300" width="280" height="10" rx="5" fill="#D1FAE5" />
      {/* Rising bar chart */}
      <g className="animate-[float_3s_ease-in-out_infinite]">
        <rect x="100" y="220" width="30" height="80" rx="6" fill="#6EE7B7" />
        <rect x="145" y="190" width="30" height="110" rx="6" fill="#34D399" />
        <rect x="190" y="155" width="30" height="145" rx="6" fill="#10B981" />
        <rect x="235" y="130" width="30" height="170" rx="6" fill="#059669" />
      </g>
      {/* Arrow going up */}
      <g className="animate-[float_2.5s_ease-in-out_infinite_0.3s]">
        <path d="M120 210 L250 100" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeDasharray="6 4" />
        <polygon points="255,95 245,95 250,82" fill="#10B981" />
      </g>
      {/* Star burst */}
      <g className="animate-[float_3.5s_ease-in-out_infinite_0.6s]">
        <circle cx="310" cy="120" r="28" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
        <path d="M310 108 l3 8 8-3 -6 6 6 6 -8-3 -3 8 -3-8 -8 3 6-6 -6-6 8 3z" fill="white" />
      </g>
      {/* Small receipt */}
      <g className="animate-[float_4s_ease-in-out_infinite_1s]">
        <rect x="70" y="110" width="50" height="70" rx="6" fill="white" stroke="#D1D5DB" strokeWidth="1.5" />
        <rect x="80" y="122" width="30" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="132" width="22" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="142" width="26" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="155" width="18" height="6" rx="3" fill="#10B981" />
      </g>
      {/* Floating heart */}
      <g className="animate-[float_3s_ease-in-out_infinite_0.5s]">
        <path d="M330 210 c0-8 12-14 12-6 c0 8-12 18-12 18 s-12-10-12-18 c0-8 12-2 12 6z" fill="#F472B6" />
      </g>
      {/* Sparkles */}
      <g fill="#FCD34D">
        <path d="M160 90 l3-8 3 8 -8-3 8-3z" className="animate-[twinkle_2s_ease-in-out_infinite]" />
        <path d="M340 280 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_0.7s]" />
        <path d="M80 270 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_1.4s]" />
      </g>
    </svg>
  );
}

const inputCls = "w-full pl-11 pr-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-base text-gray-800 dark:text-gray-200 placeholder:text-gray-400 transition";
const selectCls = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-base text-gray-800 dark:text-gray-200 transition appearance-none";

export default function RegisterPage() {
  const { register, googleLogin } = useAuth();
  // Hide Google sign-in on native iOS (Apple requires Sign in with Apple for third-party login)
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  const hasGoogle = !!import.meta.env.VITE_GOOGLE_CLIENT_ID && !isNative;

  const googleWrap = useRef(null);
  const [googleWidth, setGoogleWidth] = useState(320);
  useEffect(() => {
    if (!googleWrap.current) return;
    const measure = () => {
      const w = googleWrap.current?.offsetWidth || 320;
      setGoogleWidth(Math.max(240, Math.min(400, w)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [hasGoogle]);
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    email: "",
    password: "",
    business_name: "",
    business_type: "",
    currency: "DKK",
  });
  const [error, setError] = useState("");
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setAlreadyExists(false);
    // Client-side password validation (backend requires letters + digits)
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      setError("Password must contain at least one letter and one number");
      return;
    }
    // On native iOS, default business fields (Apple 3.1.1 compliance)
    const submitData = isNative
      ? { ...form, business_type: form.business_type || "personal", business_name: form.business_name || "My Dashboard" }
      : form;
    if (!isNative && !form.business_type) { setError(t("pleaseSelectType")); return; }
    setLoading(true);
    try {
      await register(submitData);
      // On native apps, skip email verification and go straight to dashboard
      if (isNative) {
        sessionStorage.setItem("skip_email_verify", "1");
        navigate("/dashboard");
      } else {
        navigate("/verify-email");
      }
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;
      if (status === 429) {
        setError(t("tooManyAttempts"));
      } else if (status === 409 || detail === "Email already registered") {
        setAlreadyExists(true);
      } else if (status === 422 && Array.isArray(detail)) {
        // Pydantic validation errors — extract first readable message
        const first = detail[0] || {};
        const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
        const msg = (first.msg || "Validation error").replace(/^Value error,\s*/, "");
        setError(field ? `${field}: ${msg}` : msg);
      } else if (typeof detail === "string") {
        setError(detail);
      } else {
        setError(err.code === "ECONNABORTED" || !err.response ? t("slowConnection") : t("registrationFailed"));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes twinkle { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.6); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      <div className="min-h-screen flex bg-[#fafaf7] dark:bg-gray-950">
        {/* Left panel — minimalist Copenhagen-style copy, no illustration overload */}
        <div className="hidden lg:flex lg:w-1/2 items-center justify-center p-16 border-r border-gray-200/60 dark:border-gray-800">
          <div className="max-w-sm" style={{ animation: "fadeIn 0.8s ease-out" }}>
            <h2 className="text-[34px] font-semibold tracking-tight leading-[1.1] text-gray-900 dark:text-white">
              Start your 14-day free trial.
            </h2>
            <p className="text-[15px] text-gray-600 dark:text-gray-400 mt-4 leading-relaxed">
              No card required. Full Pro access for 14 days — AI Copilot, predictive insights,
              receipt OCR. After the trial you stay on Free; every feature still works, just with caps.
            </p>
            <ul className="mt-8 space-y-3 text-[14px] text-gray-700 dark:text-gray-300">
              {[
                "Built in Copenhagen · GDPR · EU-hosted",
                "Cancel anytime · Export your data",
                "Founding price 99 kr/mo locked in for first 1,000",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right panel — form */}
        <div className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto">
          <div className="w-full max-w-md" style={{ animation: "slideUp 0.5s ease-out" }}>
            {/* Logo + heading */}
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-gray-900 dark:bg-white rounded-lg flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
                    <rect x="4" y="2" width="20" height="24" rx="3" stroke="currentColor"
                          className="text-white dark:text-gray-900" strokeWidth="2.2"/>
                    <path d="M9 8h10M9 12h10M9 16h6" stroke="currentColor"
                          className="text-white dark:text-gray-900" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <span className="text-xl font-bold text-gray-800 dark:text-white">BonBox</span>
              </div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t("createYourAccount")}</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1.5">Set up in 30 seconds. Start tracking today.</p>
            </div>

            {alreadyExists && (
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 p-4 rounded-xl mb-5 text-center" style={{ animation: "slideUp 0.3s ease-out" }}>
                <p className="text-sm text-blue-800 dark:text-blue-300 font-medium mb-2">{t("emailAlreadyRegistered")}</p>
                <Link to="/login" className="inline-block bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-4 py-2 rounded-lg text-[13px] font-medium hover:bg-gray-800 dark:hover:bg-gray-100 transition">
                  {t("signInInstead")}
                </Link>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("email")}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                  </span>
                  <input type="email" name="email" value={form.email} onChange={handleChange}
                    placeholder="you@company.com" className={inputCls} required />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("password")}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  </span>
                  <input type="password" name="password" value={form.password} onChange={handleChange}
                    placeholder="8+ characters with letters and numbers" className={inputCls} required
                    minLength={8} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{isNative ? t("displayName") : (form.business_type === "personal" ? t("displayName") : t("businessName"))}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                  </span>
                  <input type="text" name="business_name" value={form.business_name} onChange={handleChange}
                    placeholder="My Awesome Shop" className={inputCls} required />
                </div>
              </div>
              {/* Hide business type/currency on native iOS (Apple 3.1.1 compliance) */}
              {!isNative && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("businessType")}</label>
                  <select name="business_type" value={form.business_type} onChange={handleChange}
                    className={selectCls} required>
                    <option value="" disabled>{t("selectType")}</option>
                    <option value="personal">{t("personalFinance")}</option>
                    <optgroup label={t("foodAndDrink")}>
                      <option value="restaurant">{t("btRestaurant")}</option>
                      <option value="cafe">{t("btCafe")}</option>
                      <option value="bar">{t("btBar")}</option>
                      <option value="bakery">{t("btBakery")}</option>
                      <option value="food_truck">{t("btFoodTruck")}</option>
                      <option value="tea_shop">{t("btTeaShop")}</option>
                    </optgroup>
                    <optgroup label={t("retail")}>
                      <option value="clothing">{t("btClothing")}</option>
                      <option value="online_clothing">{t("btOnlineClothing")}</option>
                      <option value="grocery">{t("btGrocery")}</option>
                      <option value="veggie_shop">{t("btVeggieShop")}</option>
                      <option value="kiosk">{t("btKiosk")}</option>
                      <option value="electronics">{t("btElectronics")}</option>
                      <option value="pharmacy">{t("btPharmacy")}</option>
                      <option value="cosmetics">{t("btCosmetics")}</option>
                      <option value="stationery">{t("btStationery")}</option>
                      <option value="hardware">{t("btHardware")}</option>
                      <option value="flower_shop">{t("btFlowerShop")}</option>
                      <option value="jewelry">{t("btJewelry")}</option>
                      <option value="thrift">{t("btThrift")}</option>
                    </optgroup>
                    <optgroup label={t("services")}>
                      <option value="salon">{t("btSalon")}</option>
                      <option value="mobile_repair">{t("btMobileRepair")}</option>
                      <option value="laundry">{t("btLaundry")}</option>
                    </optgroup>
                    <optgroup label={t("other")}>
                      <option value="retail">{t("btGeneralRetail")}</option>
                      <option value="wholesale">{t("btWholesale")}</option>
                      <option value="other">{t("other")}</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("currency")}</label>
                  <select name="currency" value={form.currency} onChange={handleChange} className={selectCls}>
                    <option value="DKK">{t("currDKK")}</option>
                    <option value="SEK">{t("currSEK")}</option>
                    <option value="NOK">{t("currNOK")}</option>
                    <option value="EUR">{t("currEUR")}</option>
                    <option value="EUR_PT">{t("currEUR_PT")}</option>
                    <option value="EUR_DE">{t("currEUR_DE")}</option>
                    <option value="EUR_FR">{t("currEUR_FR")}</option>
                    <option value="EUR_ES">{t("currEUR_ES")}</option>
                    <option value="EUR_IT">{t("currEUR_IT")}</option>
                    <option value="EUR_NL">{t("currEUR_NL")}</option>
                    <option value="USD">{t("currUSD")}</option>
                    <option value="GBP">{t("currGBP")}</option>
                    <option value="NPR">{t("currNPR")}</option>
                    <option value="INR">{t("currINR")}</option>
                    <option value="JPY">{t("currJPY")}</option>
                    <option value="AUD">{t("currAUD")}</option>
                    <option value="CAD">{t("currCAD")}</option>
                    <option value="CHF">{t("currCHF")}</option>
                  </select>
                </div>
              </div>
              )}

              <button type="submit" disabled={loading}
                className="w-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 py-2.5 rounded-lg
                  text-[14px] font-medium hover:bg-gray-800 dark:hover:bg-gray-100
                  disabled:opacity-60 disabled:cursor-not-allowed
                  flex items-center justify-center gap-2 mt-2 transition">
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    {t("creatingAccount")}
                  </>
                ) : t("createAccount")}
              </button>
            </form>

            {/* Google Sign-Up */}
            {hasGoogle && (
              <>
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                  <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">or</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                </div>
                <div ref={googleWrap} className="flex justify-center [&>div]:w-full overflow-hidden">
                  <GoogleLogin
                    onSuccess={(res) => {
                      setError("");
                      googleLogin(res.credential)
                        .then(() => navigate("/dashboard"))
                        .catch((err) => setError(err.response?.data?.detail || "Google sign-up failed"));
                    }}
                    onError={() => setError("Google sign-up failed")}
                    shape="rectangular"
                    size="large"
                    width={String(googleWidth)}
                    text="signup_with"
                    theme={typeof window !== "undefined" && document.documentElement.classList.contains("dark") ? "filled_black" : "outline"}
                  />
                </div>
              </>
            )}

            <p className="mt-5 text-center text-sm text-gray-500 dark:text-gray-400">
              {t("alreadyHaveAccount")}{" "}
              <Link to="/login" className="text-gray-900 dark:text-white font-medium underline-offset-2 hover:underline">{t("signIn")}</Link>
            </p>

            <div className="mt-6 flex justify-center">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                aria-label="Language"
                className="text-[12px] bg-transparent border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1
                  text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500
                  focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-white dark:bg-gray-900">
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
