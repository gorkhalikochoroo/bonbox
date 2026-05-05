import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

/* Hero phone mockup showing BonBox dashboard */
function HeroPhone() {
  return (
    <div className="relative w-full max-w-sm mx-auto" style={{ animation: "heroFloat 4s ease-in-out infinite" }}>
      {/* Glow behind phone */}
      <div className="absolute inset-0 bg-green-500/20 rounded-[3rem] blur-[60px] scale-110" />
      {/* Phone frame */}
      <div className="relative bg-gray-900 rounded-[2.5rem] p-3 border-2 border-gray-700/60 shadow-2xl shadow-green-500/10">
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-6 bg-gray-900 rounded-b-2xl z-10" />
        {/* Screen */}
        <div className="bg-gray-950 rounded-[2rem] overflow-hidden p-4 pt-8">
          {/* Status bar */}
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="text-white text-[10px] font-semibold">9:41</span>
            <div className="flex items-center gap-1">
              <div className="w-3.5 h-2 border border-white/60 rounded-sm relative"><div className="absolute inset-0.5 bg-green-400 rounded-[1px]" style={{width:"70%"}} /></div>
            </div>
          </div>
          {/* App header */}
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-white text-xs font-bold">Dashboard</p>
              <p className="text-gray-500 text-[9px]">Today</p>
            </div>
            <div className="w-6 h-6 bg-green-500/20 rounded-full flex items-center justify-center">
              <span className="text-[8px]">+</span>
            </div>
          </div>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            <div className="bg-gray-800/80 rounded-lg p-2 border border-green-500/20">
              <p className="text-gray-500 text-[7px]">Revenue</p>
              <p className="text-white text-sm font-bold">24,500 kr</p>
              <p className="text-green-400 text-[7px]">+12%</p>
            </div>
            <div className="bg-gray-800/80 rounded-lg p-2 border border-green-500/20">
              <p className="text-gray-500 text-[7px]">Profit</p>
              <p className="text-white text-sm font-bold">70,097 kr</p>
              <p className="text-green-400 text-[7px]">57.8%</p>
            </div>
          </div>
          {/* Mini chart */}
          <div className="bg-gray-800/80 rounded-lg p-2 border border-gray-700/50 mb-2">
            <p className="text-gray-500 text-[7px] mb-1">Weekly Sales</p>
            <svg viewBox="0 0 200 40" className="w-full h-8">
              <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0,30 L30,22 L60,28 L90,15 L120,18 L150,8 L180,12 L200,5 L200,40 L0,40 Z" fill="url(#chartGrad)" />
              <polyline points="0,30 30,22 60,28 90,15 120,18 150,8 180,12 200,5" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          {/* Recent sales */}
          <div className="bg-gray-800/80 rounded-lg p-2 border border-gray-700/50">
            <p className="text-gray-500 text-[7px] mb-1">Recent Sales</p>
            {["Coca-Cola x10", "Rice 5kg", "Vodka 2x"].map((s, i) => (
              <div key={i} className="flex items-center justify-between py-0.5 border-b border-gray-700/30 last:border-0">
                <span className="text-gray-300 text-[8px]">{s}</span>
                <span className="text-white text-[8px] font-medium">{["150", "1,350", "90"][i]} kr</span>
              </div>
            ))}
          </div>
          {/* Bottom nav */}
          <div className="flex items-center justify-around mt-3 pt-2 border-t border-gray-700/40">
            {["Home", "Sales", "Stock", "Staff", "More"].map((tab, i) => (
              <div key={tab} className={`text-center ${i === 0 ? "text-green-400" : "text-gray-600"}`}>
                <div className={`w-4 h-4 mx-auto mb-0.5 rounded ${i === 0 ? "bg-green-400/20" : ""}`} />
                <span className="text-[6px]">{tab}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
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
    { key: "staff", label: t("landingDemoTabStaff") },
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

        {activeTab === "staff" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-white text-sm font-semibold">{t("landingDemoStaffTitle")}</p>
              <span className="px-3 py-1 bg-purple-600 text-white text-[11px] rounded-lg font-semibold">{t("landingDemoPublish")}</span>
            </div>
            {/* Weekly schedule mini grid */}
            <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
              <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wider mb-2">{t("landingDemoThisWeek")}</p>
              <div className="grid grid-cols-7 gap-1 mb-2">
                {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
                  <div key={d} className="text-center text-[9px] text-gray-500 font-medium">{d}</div>
                ))}
              </div>
              {[
                { name: "Maria K.", shifts: [1,1,0,1,1,0,0], role: "Kitchen", on: "bg-orange-500/30 border border-orange-500/40" },
                { name: "Jakob R.", shifts: [0,1,1,1,0,1,1], role: "Bar", on: "bg-purple-500/30 border border-purple-500/40" },
                { name: "Rina T.", shifts: [1,0,1,0,1,1,0], role: "Floor", on: "bg-blue-500/30 border border-blue-500/40" },
              ].map((staff) => (
                <div key={staff.name} className="flex items-center gap-2 py-1.5 border-b border-gray-700/30 last:border-0">
                  <span className="text-gray-300 text-[11px] font-medium w-16 truncate">{staff.name}</span>
                  <div className="flex-1 grid grid-cols-7 gap-1">
                    {staff.shifts.map((s, i) => (
                      <div key={i} className={`h-5 rounded ${s ? staff.on : "bg-gray-800"} flex items-center justify-center`}>
                        {s ? <span className="text-[8px] text-gray-300">{staff.role.charAt(0)}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* Hours + Tips summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
                <p className="text-gray-400 text-[10px] font-semibold uppercase mb-2">{t("landingDemoHoursLogged")}</p>
                <p className="text-white text-2xl font-bold">127<span className="text-gray-500 text-sm font-normal">h</span></p>
                <p className="text-green-400 text-[10px]">3 {t("landingDemoStaffMembers")}</p>
              </div>
              <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
                <p className="text-gray-400 text-[10px] font-semibold uppercase mb-2">{t("landingDemoTipPool")}</p>
                <p className="text-white text-2xl font-bold">4,820 <span className="text-gray-500 text-sm font-normal">{currency}</span></p>
                <p className="text-purple-400 text-[10px]">{t("landingDemoSplitByHours")}</p>
              </div>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2.5 flex items-center gap-2">
              <span className="text-lg">📄</span>
              <span className="text-green-400 text-[11px] font-medium flex-1">{t("landingDemoPayrollReady")}</span>
              <span className="px-2 py-1 bg-green-600 text-white text-[10px] rounded font-semibold">PDF</span>
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
    <div className="min-h-screen bg-[#fafaf7] overflow-x-hidden">
      <style>{`
        @keyframes heroFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
        @keyframes heroTwinkle { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.2; transform: scale(0.5); } }
      `}</style>

      {/* ── Navigation (Copenhagen-clean: light bg, restrained accent) ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#fafaf7]/85 backdrop-blur-xl border-b border-gray-200/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 bg-gray-900 rounded-lg flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-[17px] font-semibold text-gray-900 tracking-tight">BonBox</span>
          </Link>

          <div className="hidden sm:flex items-center gap-3">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-label="Language"
              className="text-[13px] bg-transparent border border-gray-200 rounded-md px-2.5 py-1.5 text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <Link to="/login" className="px-3 py-2 text-[14px] font-medium text-gray-700 hover:text-gray-900 transition">
              {t("landingSignIn")}
            </Link>
            <Link to="/register" className="px-4 py-2 text-[14px] font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition">
              {t("landingStartFree")}
            </Link>
          </div>

          <button onClick={() => setMenuOpen(!menuOpen)} className="sm:hidden text-gray-700 p-2" aria-label="Menu">
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
          <div className="sm:hidden px-4 pb-4 space-y-2 border-t border-gray-200/60 pt-3 bg-[#fafaf7]">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="w-full text-sm bg-white border border-gray-200 rounded-lg px-3 py-2.5 mb-1"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <Link to="/login" className="block w-full text-center px-4 py-3 text-sm font-medium text-gray-800 border border-gray-300 rounded-lg">{t("landingSignIn")}</Link>
            <Link to="/register" className="block w-full text-center px-4 py-3 text-sm font-medium bg-gray-900 text-white rounded-lg">{t("landingStartFree")}</Link>
          </div>
        )}
      </nav>

      {/* ── Hero (Copenhagen-clean: warm white, restrained accent, no glow) ── */}
      <section className="relative pt-32 sm:pt-40 pb-20 sm:pb-32 text-gray-900 overflow-hidden">
        <div className="absolute top-20 left-1/4 w-[500px] h-[500px] bg-blue-100/60 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-40 right-1/4 w-[400px] h-[400px] bg-amber-100/40 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6">
          {/* Split hero: text left, illustration right */}
          <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
            {/* Left — text */}
            <div className="flex-1 text-center lg:text-left">
              <FadeIn>
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-blue-50 rounded-full text-[12px] font-medium text-blue-700 mb-8 border border-blue-200/60">
                  <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                  {t("landingBadge")}
                </div>
              </FadeIn>

              <FadeIn delay={100}>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-[1.08] tracking-tight text-gray-900">
                  {t("landingHeroLine1")}
                  <br />
                  <span className="text-blue-600">
                    {t("landingHeroLine2")}
                  </span>
                </h1>
              </FadeIn>

              <FadeIn delay={200}>
                <p className="mt-6 text-lg text-gray-600 max-w-lg mx-auto lg:mx-0 leading-relaxed">
                  {t("landingHeroSub")}
                </p>
              </FadeIn>

              <FadeIn delay={300}>
                <div className="mt-10 flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-3">
                  <Link to="/register" className="w-full sm:w-auto px-7 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition text-center text-[15px]">
                    {t("landingCtaPrimary")}
                  </Link>
                  <a href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-300 rounded-lg hover:border-gray-400 transition">
                    <svg className="w-5 h-5 text-gray-900" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    <div className="text-left">
                      <div className="text-[9px] text-gray-500 leading-none">Download on the</div>
                      <div className="text-[13px] text-gray-900 font-semibold leading-tight">App Store</div>
                    </div>
                  </a>
                </div>
              </FadeIn>

              <FadeIn delay={350}>
                <div className="mt-6 flex flex-wrap items-center justify-center lg:justify-start gap-5 text-[13px] text-gray-500">
                  {[t("landingCheck1"), t("landingCheck2"), t("landingCheck3")].map((txt) => (
                    <span key={txt} className="flex items-center gap-1.5">
                      <svg className="w-4 h-4 text-gray-900" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                      {txt}
                    </span>
                  ))}
                </div>
              </FadeIn>
            </div>

            {/* Right — phone mockup */}
            <FadeIn delay={400} className="flex-1 hidden md:block">
              <HeroPhone />
            </FadeIn>
          </div>

          {/* ── Interactive Demo ── */}
          <FadeIn delay={500}>
            <div className="mt-16 max-w-5xl mx-auto">
              <LiveDemo t={t} currency={currency} />
              <p className="text-gray-500 text-xs mt-3 tracking-wide">{t("landingDemoCaption")}</p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Stats bar (Copenhagen-light: subtle gray panel) ── */}
      <section className="py-12 border-y border-gray-200/70 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { val: 25, suffix: "+", label: t("landingStatFeatures") },
              { val: 21, suffix: "+", label: t("landingStatBusinessTypes") },
              { val: 12, suffix: "", label: t("landingStatLanguages") },
              { val: 5, suffix: "", label: t("landingStatSetup"), prefix: "" },
            ].map((s) => (
              <FadeIn key={s.label}>
                <div>
                  <p className="text-3xl sm:text-4xl font-bold text-gray-900">
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
              <p className="text-blue-600 text-xs font-semibold uppercase tracking-wider mb-3">{t("landingFeaturesTag")}</p>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-gray-900 tracking-tight">
                {t("landingFeaturesTitle")}
              </h2>
              <p className="mt-5 text-gray-600 text-lg max-w-xl mx-auto">
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
              { icon: "🔧", titleKey: "landingFeature8Title", descKey: "landingFeature8Desc", accent: "from-amber-500/20 to-yellow-500/10", border: "border-amber-500/20 hover:border-amber-500/40" },
              { icon: "🏢", titleKey: "landingFeature9Title", descKey: "landingFeature9Desc", accent: "from-indigo-500/20 to-violet-500/10", border: "border-indigo-500/20 hover:border-indigo-500/40" },
              { icon: "🍷", titleKey: "landingFeature10Title", descKey: "landingFeature10Desc", accent: "from-purple-500/20 to-pink-500/10", border: "border-purple-500/20 hover:border-purple-500/40" },
              { icon: "👨‍💼", titleKey: "landingFeature11Title", descKey: "landingFeature11Desc", accent: "from-teal-500/20 to-cyan-500/10", border: "border-teal-500/20 hover:border-teal-500/40" },
              { icon: "🧮", titleKey: "landingFeature12Title", descKey: "landingFeature12Desc", accent: "from-lime-500/20 to-green-500/10", border: "border-lime-500/20 hover:border-lime-500/40" },
              { icon: "🔄", titleKey: "landingFeature13Title", descKey: "landingFeature13Desc", accent: "from-sky-500/20 to-blue-500/10", border: "border-sky-500/20 hover:border-sky-500/40" },
            ].map((f, i) => (
              <FadeIn key={f.titleKey} delay={i * 80}>
                <div className="bg-white rounded-2xl p-6 border border-gray-200 hover:border-gray-300 transition-all duration-300 h-full group">
                  <div className="text-3xl mb-4">{f.icon}</div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{t(f.titleKey)}</h3>
                  <p className="text-gray-600 text-sm leading-relaxed">{t(f.descKey)}</p>
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
                t("landingTagWorkshop"), t("landingTagDailyClose"), t("landingTagMultiBiz"),
                t("landingTagWineList"), t("landingTagScanBottle"), t("landingTagSommelier"),
                t("landingTagStaffSchedule"), t("landingTagTipSplit"), t("landingTagPayrollPdf"), t("landingTagUnitConvert"),
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
      <section className="py-20 sm:py-28 bg-gradient-to-b from-white via-purple-50/40 to-white border-y border-gray-200/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-12">
              <p className="text-purple-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingIntelTag")}</p>
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">
                {t("landingIntelTitle1")}
                <br />
                <span className="text-purple-400">{t("landingIntelTitle2")}</span>
              </h2>
              <p className="mt-5 text-gray-600 text-lg max-w-xl mx-auto">
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
      <section className="py-20 sm:py-28 bg-gray-50 border-y border-gray-200/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-12">
              <p className="text-orange-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingBarTag")}</p>
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">
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

      {/* ── Staff Management Spotlight ── */}
      <section className="py-20 sm:py-28 bg-gradient-to-b from-white via-teal-50/40 to-white border-y border-gray-200/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-12">
              <p className="text-teal-400 text-sm font-semibold uppercase tracking-wider mb-3">{t("landingStaffTag")}</p>
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">
                {t("landingStaffTitle1")}
                <br />
                <span className="text-teal-400">{t("landingStaffTitle2")}</span>
              </h2>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 sm:p-10">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 text-center">
                {[
                  { icon: "📅", titleKey: "landingStaffStep1", subKey: "landingStaffStep1Sub", color: "text-white" },
                  { icon: "⏱️", titleKey: "landingStaffStep2", subKey: "landingStaffStep2Sub", color: "text-white" },
                  { icon: "💰", titleKey: "landingStaffStep3", subKey: "landingStaffStep3Sub", color: "text-teal-400" },
                  { icon: "📄", titleKey: "landingStaffStep4", subKey: "landingStaffStep4Sub", color: "text-green-400" },
                ].map((step, i) => (
                  <div key={step.titleKey} className="relative">
                    <div className="text-4xl mb-3">{step.icon}</div>
                    <p className={`font-bold text-sm ${step.color}`}>{t(step.titleKey)}</p>
                    <p className="text-gray-500 text-xs mt-1">{t(step.subKey)}</p>
                    {i < 3 && (
                      <span className="hidden sm:block absolute top-8 -right-3 sm:-right-4 text-teal-500 text-lg font-bold">&#8594;</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-center text-teal-400 font-semibold text-sm mt-8">{t("landingStaffBottom")}</p>
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
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">
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

      {/* ── Download the App ── */}
      <section className="py-16 border-y border-gray-200/60 bg-gradient-to-r from-emerald-50 via-white to-emerald-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
              <div className="text-center md:text-left">
                <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2">
                  Take BonBox Everywhere
                </h2>
                <p className="text-gray-400 text-sm">
                  Available on iOS. Your dashboard in your pocket.
                </p>
              </div>
              <div className="flex flex-row gap-3 flex-shrink-0">
                <a href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 px-5 py-3 bg-white text-black rounded-xl hover:bg-gray-100 transition shadow-lg">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  <div className="text-left">
                    <div className="text-[9px] text-gray-500 leading-none font-medium">Download on the</div>
                    <div className="text-base font-bold leading-tight">App Store</div>
                  </div>
                </a>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Global reach ── */}
      <section className="py-16 border-y border-gray-200/60 bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-4">
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

      {/* ── Final CTA (Copenhagen-clean: warm white, restrained accent) ── */}
      <section className="relative py-24 sm:py-32 text-gray-900 text-center overflow-hidden bg-white">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-10 left-1/3 w-72 h-72 bg-blue-100/50 rounded-full blur-[100px]" />
          <div className="absolute bottom-10 right-1/3 w-60 h-60 bg-amber-100/40 rounded-full blur-[100px]" />
        </div>
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-5 tracking-tight text-gray-900">
              {t("landingCtaTitle1")}
              <br />
              <span className="text-blue-600">{t("landingCtaTitle2")}</span>
            </h2>
            <p className="text-gray-600 text-lg mb-10 max-w-lg mx-auto">
              {t("landingCtaSub")}
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link to="/register" className="w-full sm:w-auto px-9 py-3.5 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition text-[15px]">
                {t("landingCtaButton")}
              </Link>
              <a href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-5 py-3.5 bg-white border border-gray-300 rounded-lg hover:border-gray-400 transition">
                <svg className="w-5 h-5 text-gray-900" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                <span className="text-[14px] text-gray-900 font-semibold">App Store</span>
              </a>
            </div>
            <p className="mt-5 text-gray-500 text-sm">{t("landingNoCard")}</p>
          </FadeIn>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-10 border-t border-gray-200/60 bg-[#fafaf7]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex items-center justify-center w-7 h-7 bg-gray-900 rounded-md">
              <svg width="16" height="16" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-gray-900 font-semibold text-sm">BonBox</span>
          </div>
          <p className="text-gray-500 text-xs text-center">
            &copy; 2026 BonBox &middot; {t("landingFooterTagline")}
          </p>
          <div className="flex items-center gap-4">
            <Link to="/contact" className="text-gray-600 text-sm hover:text-gray-900 transition">{t("landingFooterContact")}</Link>
            <Link to="/privacy" className="text-gray-600 text-sm hover:text-gray-900 transition">{t("landingFooterPrivacy")}</Link>
            <Link to="/terms" className="text-gray-600 text-sm hover:text-gray-900 transition">Terms</Link>
          </div>
        </div>
        {/* Trademark notice */}
        <p className="mt-6 text-[10px] text-gray-500 text-center max-w-3xl mx-auto px-4 leading-relaxed">
          Dinero, Billy, e-conomic, Visma, MobilePay, Dankort, Apple, App Store, Anthropic and Claude are
          trademarks of their respective owners. BonBox is operated independently and is not affiliated
          with or endorsed by these companies. See <Link to="/terms" className="underline hover:text-gray-700">Terms § 13</Link> for the full notice.
        </p>
      </footer>
    </div>
  );
}
