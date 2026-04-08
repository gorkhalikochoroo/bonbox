import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

/* Hero floating illustration — receipt + boxes scene */
function HeroFloat() {
  return (
    <svg viewBox="0 0 360 320" fill="none" className="w-full max-w-md mx-auto">
      {/* Big receipt */}
      <g style={{ animation: "heroFloat 3s ease-in-out infinite" }}>
        <rect x="120" y="40" width="100" height="180" rx="10" fill="white" fillOpacity="0.95" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        <rect x="138" y="62" width="65" height="6" rx="3" fill="rgba(255,255,255,0.15)" />
        <rect x="138" y="78" width="48" height="6" rx="3" fill="rgba(255,255,255,0.15)" />
        <rect x="138" y="94" width="56" height="6" rx="3" fill="rgba(255,255,255,0.15)" />
        <line x1="138" y1="116" x2="210" y2="116" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="4 3" />
        <rect x="138" y="128" width="38" height="10" rx="5" fill="#22c55e" fillOpacity="0.9" />
        <text x="142" y="137" fontSize="7" fill="white" fontWeight="bold">PAID</text>
        <path d="M120 220 l8-9 8 9 8-9 8 9 8-9 8 9 8-9 8 9 8-9 8 9 8-9 8 9 8-9 v0 h-100 z" fill="white" fillOpacity="0.95" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
      {/* Coin */}
      <g style={{ animation: "heroFloat 2.5s ease-in-out infinite 0.4s" }}>
        <circle cx="280" cy="80" r="26" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
        <text x="280" y="87" fontSize="18" fill="#92400E" fontWeight="bold" textAnchor="middle">$</text>
      </g>
      {/* Green box */}
      <g style={{ animation: "heroFloat 3.5s ease-in-out infinite 0.8s" }}>
        <rect x="255" y="160" width="58" height="58" rx="12" fill="#22c55e" fillOpacity="0.85" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        <path d="M268 182 h32 M284 170 v22" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      {/* Purple box */}
      <g style={{ animation: "heroFloat 4s ease-in-out infinite 0.2s" }}>
        <rect x="50" y="130" width="50" height="50" rx="12" fill="#A78BFA" fillOpacity="0.85" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        <path d="M63 155 l9 9 15-18" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {/* Mini chart */}
      <g style={{ animation: "heroFloat 3s ease-in-out infinite 0.6s" }}>
        <rect x="60" y="60" width="45" height="55" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
        <polyline points="70,98 78,86 88,92 98,74" stroke="#22c55e" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </g>
      {/* Sparkles */}
      <g fill="#FCD34D" fillOpacity="0.8">
        <path d="M310 45 l3-8 3 8 -8-3 8-3z" style={{ animation: "heroTwinkle 2s ease-in-out infinite" }} />
        <path d="M40 100 l2-6 2 6 -6-2 6-2z" style={{ animation: "heroTwinkle 2s ease-in-out infinite 0.7s" }} />
        <path d="M330 230 l2-6 2 6 -6-2 6-2z" style={{ animation: "heroTwinkle 2s ease-in-out infinite 1.4s" }} />
      </g>
    </svg>
  );
}

/* ── Animated counter ── */
function Counter({ end, duration = 1800, prefix = "", suffix = "" }) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const startTime = performance.now();
          const tick = (now) => {
            const progress = Math.min((now - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setVal(Math.round(eased * end));
            if (progress < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, duration]);

  return <span ref={ref}>{prefix}{val.toLocaleString()}{suffix}</span>;
}

/* ── Fade-in on scroll ── */
function FadeIn({ children, className = "", delay = 0 }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.15 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ── Interactive demo dashboard ── */
function LiveDemo({ t, currency }) {
  const [activeTab, setActiveTab] = useState("dashboard");
  const tabs = [
    { key: "dashboard", label: t("landingDemoTabDashboard") },
    { key: "sales", label: t("landingDemoTabSales") },
    { key: "inventory", label: t("landingDemoTabInventory") },
  ];

  return (
    <div className="bg-gray-950/80 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl shadow-green-500/5 p-3 sm:p-5">
      {/* browser bar */}
      <div className="flex items-center gap-2 mb-4 px-1">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </div>
        <div className="flex-1 flex justify-center">
          <div className="px-4 py-1 bg-gray-800/80 rounded-md text-[10px] text-gray-500 font-mono">bonbox.dk/dashboard</div>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-3 px-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition ${
              activeTab === tab.key
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-gray-900 rounded-xl p-3 sm:p-5 min-h-[280px]">
        {activeTab === "dashboard" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white text-sm font-semibold">{t("landingDemoWelcome")}</p>
                <p className="text-gray-500 text-[11px]">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
              </div>
              <div className="hidden sm:flex gap-2">
                <span className="px-3 py-1.5 bg-green-600 text-white text-[11px] rounded-lg font-semibold flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                  {t("quickSale")}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-3">
              {[
                { label: t("todayRevenue"), val: `24,500 ${currency}`, sub: "+12%", color: "text-white", subColor: "text-green-400", border: "border-green-500/20" },
                { label: t("profit"), val: `70,097 ${currency}`, sub: "57.8%", color: "text-white", subColor: "text-green-400", border: "border-green-500/20" },
                { label: t("inventoryAlerts"), val: "3", sub: t("landingDemoLowStock"), color: "text-yellow-400", subColor: "text-yellow-400", border: "border-yellow-500/20" },
                { label: t("landingDemoKhata"), val: `40,000 ${currency}`, sub: t("landingDemo5Customers"), color: "text-orange-400", subColor: "text-gray-500", border: "border-orange-500/20" },
              ].map((kpi) => (
                <div key={kpi.label} className={`bg-gray-800/60 p-2.5 sm:p-3 rounded-lg border ${kpi.border}`}>
                  <p className="text-gray-500 text-[10px] sm:text-xs">{kpi.label}</p>
                  <p className={`${kpi.color} text-base sm:text-lg font-bold mt-0.5`}>{kpi.val}</p>
                  <p className={`${kpi.subColor} text-[10px]`}>{kpi.sub}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
              <div className="bg-gray-800/60 rounded-lg border border-gray-700/50 p-3 flex items-center gap-4">
                <div className="text-center flex-shrink-0">
                  <div className="w-12 h-12 rounded-full border-[3px] border-green-500 flex items-center justify-center bg-green-500/10">
                    <span className="text-green-400 font-bold text-base">76</span>
                  </div>
                  <p className="text-gray-500 text-[10px] mt-1">{t("businessHealth")}</p>
                </div>
                <div className="flex-1 space-y-1.5 hidden sm:block">
                  {[
                    { label: t("profitability"), pct: 82, color: "bg-green-500" },
                    { label: t("consistency"), pct: 95, color: "bg-blue-500" },
                    { label: t("costControl"), pct: 60, color: "bg-yellow-500" },
                  ].map((bar) => (
                    <div key={bar.label} className="flex items-center gap-2">
                      <span className="text-gray-500 text-[10px] w-20">{bar.label}</span>
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div className={`h-full ${bar.color} rounded-full`} style={{width: `${bar.pct}%`}} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-gray-800/60 rounded-lg border border-gray-700/50 p-3">
                <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wider mb-2">{t("recentSales")}</p>
                <div className="space-y-1.5">
                  {[
                    { name: "Coca-Cola x 10", price: `150 ${currency}`, method: t("cash") },
                    { name: "Basmati Rice 5kg", price: `1,350 ${currency}`, method: "MobilePay" },
                    { name: "Bar: 2x Vodka", price: `90 ${currency}`, method: t("card") },
                  ].map((s, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-gray-700/30 last:border-0">
                      <span className="text-gray-300">{s.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-white font-medium">{s.price}</span>
                        <span className="text-gray-600 text-[10px]">{s.method}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "sales" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-white text-sm font-semibold">{t("salesTracker")}</p>
              <span className="px-3 py-1 bg-green-600 text-white text-[11px] rounded-lg font-semibold">{t("logSale")}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[100, 250, 500, 1000, 2500, 5000].map((amt) => (
                <button key={amt} className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2.5 text-center hover:border-green-500/40 transition">
                  <p className="text-white font-bold text-sm">{amt.toLocaleString()}</p>
                  <p className="text-gray-500 text-[10px]">{currency}</p>
                </button>
              ))}
            </div>
            <div className="bg-gray-800/40 rounded-lg p-3 mt-2">
              <p className="text-gray-400 text-[10px] font-semibold uppercase mb-2">{t("recentSales")}</p>
              <div className="space-y-1.5">
                {[
                  { date: "Apr 2", amount: "24,500", method: "Cash" },
                  { date: "Apr 1", amount: "18,200", method: "MobilePay" },
                  { date: "Mar 31", amount: "31,800", method: "Card" },
                ].map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] py-1.5 border-b border-gray-700/30 last:border-0">
                    <span className="text-gray-400">{s.date}</span>
                    <span className="text-white font-bold">{s.amount} {currency}</span>
                    <span className="text-gray-500 text-[10px]">{s.method}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "inventory" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-white text-sm font-semibold">{t("inventoryMonitor")}</p>
              <span className="px-2.5 py-1 bg-yellow-500/20 text-yellow-400 text-[11px] rounded-lg font-medium">3 {t("lowStockAlerts")}</span>
            </div>
            <div className="space-y-1.5">
              {[
                { name: "Coca-Cola", qty: 4, min: 10, unit: t("pieces"), status: "low" },
                { name: "Basmati Rice 5kg", qty: 45, min: 10, unit: t("kg"), status: "ok" },
                { name: "Vodka 750ml", qty: 2, min: 5, unit: t("bottles"), status: "low" },
                { name: "Tomatoes", qty: 8, min: 3, unit: t("kg"), status: "ok" },
                { name: "Chicken Breast", qty: 1, min: 5, unit: t("kg"), status: "low" },
              ].map((item) => (
                <div key={item.name} className="flex items-center justify-between bg-gray-800/60 rounded-lg p-2.5 border border-gray-700/50">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${item.status === "low" ? "bg-red-400 animate-pulse" : "bg-green-400"}`} />
                    <span className="text-gray-200 text-[12px] font-medium">{item.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[11px] font-bold ${item.status === "low" ? "text-red-400" : "text-green-400"}`}>
                      {item.qty} {item.unit}
                    </span>
                    <span className="text-gray-600 text-[10px]">min: {item.min}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */
export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const currency = "kr";

  return (
    <div className="min-h-screen bg-slate-950 overflow-x-hidden">
      <style>{`
        @keyframes heroFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
        @keyframes heroTwinkle { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.2; transform: scale(0.5); } }
      `}</style>

      {/* ── Navigation ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-slate-950/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <div className="inline-flex items-center justify-center w-10 h-10 bg-white/10 rounded-xl group-hover:bg-white/15 transition">
              <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#22c55e" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-xl font-bold text-white tracking-tight">
              Bon<span className="text-green-400">Box</span>
            </span>
          </Link>

          <div className="hidden sm:flex items-center gap-3">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="bg-white/5 border border-white/10 text-gray-300 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-green-500/50 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} className="bg-gray-900 text-white">{l.flag} {l.label}</option>
              ))}
            </select>
            <Link to="/login" className="px-5 py-2 text-sm font-medium text-gray-300 hover:text-white transition">
              {t("landingSignIn")}
            </Link>
            <Link to="/register" className="px-5 py-2.5 text-sm font-semibold bg-green-500 text-white rounded-lg hover:bg-green-400 transition shadow-lg shadow-green-500/25">
              {t("landingStartFree")}
            </Link>
          </div>

          <button onClick={() => setMenuOpen(!menuOpen)} className="sm:hidden text-white p-2">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <div className="sm:hidden px-4 pb-4 space-y-2 border-t border-white/10 pt-3">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="w-full bg-white/5 border border-white/10 text-gray-300 text-sm rounded-lg px-3 py-2.5 mb-1"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} className="bg-gray-900 text-white">{l.flag} {l.label}</option>
              ))}
            </select>
            <Link to="/login" className="block w-full text-center px-4 py-3 text-sm font-medium text-white border border-white/20 rounded-lg">{t("landingSignIn")}</Link>
            <Link to="/register" className="block w-full text-center px-4 py-3 text-sm font-semibold bg-green-500 text-white rounded-lg">{t("landingStartFree")}</Link>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className="relative pt-32 sm:pt-40 pb-20 sm:pb-32 text-white overflow-hidden">
        <div className="absolute top-20 left-1/4 w-[500px] h-[500px] bg-green-600/10 rounded-full blur-[120px]" />
        <div className="absolute top-40 right-1/4 w-[400px] h-[400px] bg-orange-600/8 rounded-full blur-[120px]" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6">
          {/* Split hero: text left, illustration right */}
          <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
            {/* Left — text */}
            <div className="flex-1 text-center lg:text-left">
              <FadeIn>
                <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-green-500/10 backdrop-blur-sm rounded-full text-sm font-medium text-green-400 mb-8 border border-green-500/20">
                  <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  {t("landingBadge")}
                </div>
              </FadeIn>

              <FadeIn delay={100}>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold leading-[1.08] tracking-tight">
                  {t("landingHeroLine1")}
                  <br />
                  <span className="bg-gradient-to-r from-green-400 via-emerald-400 to-green-300 bg-clip-text text-transparent">
                    {t("landingHeroLine2")}
                  </span>
                </h1>
              </FadeIn>

              <FadeIn delay={200}>
                <p className="mt-6 text-lg text-gray-400 max-w-lg mx-auto lg:mx-0 leading-relaxed">
                  {t("landingHeroSub")}
                </p>
              </FadeIn>

              <FadeIn delay={300}>
                <div className="mt-10 flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-4">
                  <Link to="/register" className="w-full sm:w-auto px-10 py-4 bg-green-500 text-white font-bold rounded-xl hover:bg-green-400 transition shadow-2xl shadow-green-500/25 text-center text-lg">
                    {t("landingCtaPrimary")}
                  </Link>
                  <a href="https://play.google.com/store/apps/details?id=dk.bonbox.app" target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto px-10 py-4 border border-white/15 text-white font-semibold rounded-xl hover:bg-white/5 transition text-center flex items-center justify-center gap-2">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/></svg>
                    {t("landingAndroidApp")}
                  </a>
                </div>
              </FadeIn>

              <FadeIn delay={350}>
                <div className="mt-6 flex flex-wrap items-center justify-center lg:justify-start gap-6 text-sm text-gray-500">
                  {[t("landingCheck1"), t("landingCheck2"), t("landingCheck3")].map((txt) => (
                    <span key={txt} className="flex items-center gap-1.5">
                      <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                      {txt}
                    </span>
                  ))}
                </div>
              </FadeIn>
            </div>

            {/* Right — floating illustration */}
            <FadeIn delay={400} className="flex-1 hidden md:block">
              <HeroFloat />
            </FadeIn>
          </div>

          {/* ── Interactive Demo ── */}
          <FadeIn delay={500}>
            <div className="mt-16 max-w-5xl mx-auto">
              <LiveDemo t={t} currency={currency} />
              <p className="text-gray-600 text-xs mt-3 tracking-wide">{t("landingDemoCaption")}</p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="py-12 border-y border-white/5 bg-slate-900/50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { val: 20, suffix: "+", label: t("landingStatFeatures") },
              { val: 21, suffix: "+", label: t("landingStatBusinessTypes") },
              { val: 12, suffix: "", label: t("landingStatLanguages") },
              { val: 0, suffix: "kr", label: t("landingStatPrice"), prefix: "" },
            ].map((s) => (
              <FadeIn key={s.label}>
                <div>
                  <p className="text-3xl sm:text-4xl font-extrabold text-white">
                    <Counter end={s.val} duration={1200} prefix={s.prefix} suffix={s.suffix} />
                  </p>
                  <p className="text-gray-500 text-sm mt-1">{s.label}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-green-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingFeaturesTag")}</p>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-white tracking-tight">
                {t("landingFeaturesTitle")}
              </h2>
              <p className="mt-5 text-gray-400 text-lg max-w-xl mx-auto">
                {t("landingFeaturesSub")}
              </p>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              { icon: "💰", titleKey: "landingFeature1Title", descKey: "landingFeature1Desc", accent: "from-green-500/20 to-emerald-500/10", border: "border-green-500/20 hover:border-green-500/40" },
              { icon: "📦", titleKey: "landingFeature2Title", descKey: "landingFeature2Desc", accent: "from-blue-500/20 to-cyan-500/10", border: "border-blue-500/20 hover:border-blue-500/40" },
              { icon: "🍸", titleKey: "landingFeature3Title", descKey: "landingFeature3Desc", accent: "from-orange-500/20 to-amber-500/10", border: "border-orange-500/20 hover:border-orange-500/40" },
              { icon: "👥", titleKey: "landingFeature4Title", descKey: "landingFeature4Desc", accent: "from-violet-500/20 to-purple-500/10", border: "border-violet-500/20 hover:border-violet-500/40" },
              { icon: "📊", titleKey: "landingFeature5Title", descKey: "landingFeature5Desc", accent: "from-emerald-500/20 to-green-500/10", border: "border-emerald-500/20 hover:border-emerald-500/40" },
              { icon: "🗑️", titleKey: "landingFeature6Title", descKey: "landingFeature6Desc", accent: "from-red-500/20 to-rose-500/10", border: "border-red-500/20 hover:border-red-500/40" },
              { icon: "🌦️", titleKey: "landingFeature7Title", descKey: "landingFeature7Desc", accent: "from-cyan-500/20 to-sky-500/10", border: "border-cyan-500/20 hover:border-cyan-500/40" },
            ].map((f, i) => (
              <FadeIn key={f.titleKey} delay={i * 80}>
                <div className={`bg-gradient-to-br ${f.accent} rounded-2xl p-6 border ${f.border} transition-all duration-300 h-full group`}>
                  <div className="text-3xl mb-4">{f.icon}</div>
                  <h3 className="text-lg font-bold text-white mb-2">{t(f.titleKey)}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{t(f.descKey)}</p>
                </div>
              </FadeIn>
            ))}
          </div>

          {/* Extra features ribbon */}
          <FadeIn delay={200}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              {[
                t("landingTagCashBook"), t("landingTagKhata"), t("landingTagVat"),
                t("landingTagPdf"), t("landingTagLoan"), t("landingTagPersonal"),
                t("landingTagDark"), t("landingTagSeasonal"), t("landingTagMultiCurrency"),
                t("landingTagMultiLang"), t("landingTagTax"), t("landingTagBudget"),
                t("landingTagExpiry"), t("landingTagCompetitor"), t("landingTagBranch"),
              ].map((f) => (
                <span key={f} className="px-4 py-2 bg-white/5 border border-white/10 text-gray-400 text-sm font-medium rounded-full">
                  {f}
                </span>
              ))}
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Intelligence Suite ── */}
      <section className="py-20 sm:py-28 bg-gradient-to-b from-slate-950 via-purple-950/20 to-slate-950 border-y border-white/5">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-12">
              <p className="text-purple-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingIntelTag")}</p>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                {t("landingIntelTitle1")}
                <br />
                <span className="text-purple-400">{t("landingIntelTitle2")}</span>
              </h2>
              <p className="mt-5 text-gray-400 text-lg max-w-xl mx-auto">
                {t("landingIntelSub")}
              </p>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[
                { icon: "💲", titleKey: "landingIntel1", subKey: "landingIntel1Sub", color: "hover:border-green-500/30" },
                { icon: "🤝", titleKey: "landingIntel2", subKey: "landingIntel2Sub", color: "hover:border-pink-500/30" },
                { icon: "🔍", titleKey: "landingIntel3", subKey: "landingIntel3Sub", color: "hover:border-blue-500/30" },
                { icon: "⏰", titleKey: "landingIntel4", subKey: "landingIntel4Sub", color: "hover:border-amber-500/30" },
                { icon: "🏢", titleKey: "landingIntel5", subKey: "landingIntel5Sub", color: "hover:border-slate-400/30" },
                { icon: "🧾", titleKey: "landingIntel6", subKey: "landingIntel6Sub", color: "hover:border-emerald-500/30" },
              ].map((f, i) => (
                <FadeIn key={f.titleKey} delay={i * 80}>
                  <div className={`bg-white/[0.03] border border-white/10 rounded-2xl p-5 text-center transition-all duration-300 ${f.color}`}>
                    <div className="text-3xl mb-3">{f.icon}</div>
                    <p className="text-white font-bold text-sm">{t(f.titleKey)}</p>
                    <p className="text-gray-500 text-xs mt-1.5 leading-relaxed">{t(f.subKey)}</p>
                  </div>
                </FadeIn>
              ))}
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Bar/Restaurant Spotlight ── */}
      <section className="py-20 sm:py-28 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 border-y border-white/5">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-12">
              <p className="text-orange-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingBarTag")}</p>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                {t("landingBarTitle1")}
                <br />
                <span className="text-orange-400">{t("landingBarTitle2")}</span>
              </h2>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 sm:p-10">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 text-center">
                {[
                  { icon: "🍾", titleKey: "landingBarStep1", subKey: "landingBarStep1Sub", color: "text-white" },
                  { icon: "🥃", titleKey: "landingBarStep2", subKey: "landingBarStep2Sub", color: "text-white" },
                  { icon: "📉", titleKey: "landingBarStep3", subKey: "landingBarStep3Sub", color: "text-green-400" },
                  { icon: "💵", titleKey: "landingBarStep4", subKey: "landingBarStep4Sub", color: "text-orange-400" },
                ].map((step, i) => (
                  <div key={step.titleKey} className="relative">
                    <div className="text-4xl mb-3">{step.icon}</div>
                    <p className={`font-bold text-sm ${step.color}`}>{t(step.titleKey)}</p>
                    <p className="text-gray-500 text-xs mt-1">{t(step.subKey)}</p>
                    {i < 3 && (
                      <span className="hidden sm:block absolute top-8 -right-3 sm:-right-4 text-orange-500 text-lg font-bold">→</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-center text-green-400 font-semibold text-sm mt-8">{t("landingBarBottom")}</p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-green-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingHowTag")}</p>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                {t("landingHowTitle")}
              </h2>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {[
              { num: "1", titleKey: "landingStep1Title", subKey: "landingStep1Sub", icon: "👤" },
              { num: "2", titleKey: "landingStep2Title", subKey: "landingStep2Sub", icon: "✏️" },
              { num: "3", titleKey: "landingStep3Title", subKey: "landingStep3Sub", icon: "⚡" },
            ].map((step, i) => (
              <FadeIn key={step.num} delay={i * 120}>
                <div className="text-center relative">
                  {i < 2 && (
                    <div className="hidden md:block absolute top-8 left-[60%] w-[80%] border-t-2 border-dashed border-gray-700" />
                  )}
                  <div className="relative z-10 w-16 h-16 bg-green-500/10 border border-green-500/30 text-3xl rounded-2xl flex items-center justify-center mx-auto mb-5">
                    {step.icon}
                  </div>
                  <div className="text-green-400 text-xs font-bold mb-2">{t("landingStepLabel")} {step.num}</div>
                  <h3 className="text-lg font-bold text-white mb-1">{t(step.titleKey)}</h3>
                  <p className="text-gray-500 text-sm">{t(step.subKey)}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials removed — will add real ones when we have actual user feedback */}

      {/* ── Global reach ── */}
      <section className="py-16 border-y border-white/5 bg-slate-900/30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-white mb-4">
                {t("landingGlobalTitle")}
              </h2>
              <p className="text-gray-400 text-lg mb-8 max-w-lg mx-auto">
                {t("landingGlobalSub")}
              </p>
              <div className="flex flex-wrap justify-center gap-3 mb-10">
                {[
                  { flag: "🇩🇰", name: "Denmark" }, { flag: "🇳🇵", name: "Nepal" },
                  { flag: "🇩🇪", name: "Germany" }, { flag: "🇫🇷", name: "France" },
                  { flag: "🇪🇸", name: "Spain" }, { flag: "🇬🇧", name: "UK" },
                  { flag: "🇳🇱", name: "Netherlands" }, { flag: "🇸🇪", name: "Sweden" },
                  { flag: "🇳🇴", name: "Norway" }, { flag: "🇵🇹", name: "Portugal" },
                  { flag: "🇮🇹", name: "Italy" }, { flag: "🇯🇵", name: "Japan" },
                  { flag: "🇮🇳", name: "India" }, { flag: "🇪🇺", name: "Europe" },
                ].map((c) => (
                  <span key={c.name} className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 text-gray-300 text-sm font-medium rounded-full">
                    <span className="text-lg">{c.flag}</span>
                    {c.name}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
                {[
                  { icon: "🎓", textKey: "landingCredibility1" },
                  { icon: "📱", textKey: "landingCredibility2" },
                  { icon: "🔒", textKey: "landingCredibility3" },
                ].map((item) => (
                  <div key={item.textKey} className="bg-white/[0.03] border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl mb-2">{item.icon}</div>
                    <p className="text-gray-400 text-sm">{t(item.textKey)}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative py-24 sm:py-32 text-white text-center overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-10 left-1/3 w-72 h-72 bg-green-600/15 rounded-full blur-[100px]" />
          <div className="absolute bottom-10 right-1/3 w-60 h-60 bg-orange-600/10 rounded-full blur-[100px]" />
        </div>
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold mb-5 tracking-tight">
              {t("landingCtaTitle1")}
              <br />
              <span className="bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">{t("landingCtaTitle2")}</span>
            </h2>
            <p className="text-gray-400 text-lg mb-10 max-w-lg mx-auto">
              {t("landingCtaSub")}
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/register" className="w-full sm:w-auto px-12 py-4 bg-green-500 text-white font-bold rounded-xl hover:bg-green-400 transition shadow-2xl shadow-green-500/25 text-lg">
                {t("landingCtaButton")}
              </Link>
              <a href="https://play.google.com/store/apps/details?id=dk.bonbox.app" target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto px-8 py-4 border border-white/15 text-white font-semibold rounded-xl hover:bg-white/5 transition flex items-center justify-center gap-2">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/></svg>
                {t("landingGetAndroid")}
              </a>
            </div>
            <p className="mt-5 text-gray-600 text-sm">{t("landingNoCard")}</p>
          </FadeIn>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-10 border-t border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-8 h-8 bg-white/10 rounded-lg">
              <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#22c55e" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-white font-bold text-sm">Bon<span className="text-green-400">Box</span></span>
          </div>
          <p className="text-gray-600 text-xs text-center">
            &copy; 2026 BonBox &middot; {t("landingFooterTagline")}
          </p>
          <div className="flex items-center gap-4">
            <Link to="/contact" className="text-gray-500 text-sm hover:text-gray-300 transition">{t("landingFooterContact")}</Link>
            <Link to="/privacy" className="text-gray-500 text-sm hover:text-gray-300 transition">{t("landingFooterPrivacy")}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
