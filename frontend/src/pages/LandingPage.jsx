import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";

/* ── feature cards ── */
const features = [
  {
    title: "Sales + Expenses + Cash Flow",
    desc: "Log sales, track expenses, see cash flow — all auto-synced. No double entry.",
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    color: "blue",
  },
  {
    title: "Inventory & Item Sales",
    desc: "Sell from inventory with flexible pricing. Auto-deduct stock and see profit per sale instantly.",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    color: "emerald",
  },
  {
    title: "Staff Scheduling",
    desc: "AI-powered scheduling based on your busiest days. Right people, right time.",
    icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
    color: "violet",
  },
  {
    title: "WhatsApp Bot",
    desc: "Text 'sale 450' to log a sale. Text 'balance' to check cash flow. From the app you already use.",
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    color: "green",
  },
  {
    title: "Khata (Credit Book)",
    desc: "Track who owes what. Partial payments, customer balances — the way you already do business.",
    icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
    color: "amber",
  },
  {
    title: "Personal Finance Mode",
    desc: "Switch to personal mode. Track income, spending, budgets, loans — separately from business.",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
    color: "pink",
  },
  {
    title: "VAT Reports & PDF Export",
    desc: "Auto VAT calculation for your country. Professional PDF reports ready for tax time.",
    icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
    color: "orange",
  },
  {
    title: "12 Currencies, 10+ Languages",
    desc: "DKK, NPR, INR, USD, EUR and more. VAT terms adapt to your country automatically.",
    icon: "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    color: "cyan",
  },
  {
    title: "Voice-Powered Entry",
    desc: "Say '5000 cash' and it logs instantly. No typing, no friction.",
    icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z",
    color: "rose",
  },
];

const colorMap = {
  blue:    { bg: "bg-blue-50",    text: "text-blue-600",    border: "hover:border-blue-300" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600", border: "hover:border-emerald-300" },
  violet:  { bg: "bg-violet-50",  text: "text-violet-600",  border: "hover:border-violet-300" },
  green:   { bg: "bg-green-50",   text: "text-green-600",   border: "hover:border-green-300" },
  amber:   { bg: "bg-amber-50",   text: "text-amber-600",   border: "hover:border-amber-300" },
  pink:    { bg: "bg-pink-50",    text: "text-pink-600",    border: "hover:border-pink-300" },
  orange:  { bg: "bg-orange-50",  text: "text-orange-600",  border: "hover:border-orange-300" },
  cyan:    { bg: "bg-cyan-50",    text: "text-cyan-600",    border: "hover:border-cyan-300" },
  rose:    { bg: "bg-rose-50",    text: "text-rose-600",    border: "hover:border-rose-300" },
};

const steps = [
  { number: "1", title: "Sign up in 30 seconds", sub: "Name + email. That's it.", icon: "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" },
  { number: "2", title: "Log your first sale",   sub: "Tap, type, or speak.",     icon: "M12 6v6m0 0v6m0-6h6m-6 0H6" },
  { number: "3", title: "See your business clearly", sub: "Dashboard lights up instantly.", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
];

/* ── animated number counter ── */
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

/* ── fade-in on scroll ── */
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

/* ══════════════════════════════════════════════════════════ */
export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      {/* ── Navigation ── */}
      <nav className="bg-gradient-to-r from-slate-950 via-blue-950 to-slate-950 border-b border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <div className="inline-flex items-center justify-center w-10 h-10 bg-white/10 rounded-xl group-hover:bg-white/15 transition">
              <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-xl font-bold text-white tracking-tight">BonBox</span>
          </Link>
          <div className="hidden sm:flex items-center gap-3">
            <Link to="/login" className="px-5 py-2 text-sm font-medium text-blue-200 hover:text-white transition">
              Sign In
            </Link>
            <Link to="/register" className="px-5 py-2.5 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition shadow-lg shadow-blue-600/25">
              Get Started Free
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
            <Link to="/login" className="block w-full text-center px-4 py-3 text-sm font-medium text-white border border-white/20 rounded-lg">Sign In</Link>
            <Link to="/register" className="block w-full text-center px-4 py-3 text-sm font-semibold bg-blue-600 text-white rounded-lg">Get Started Free</Link>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className="relative bg-gradient-to-b from-slate-950 via-blue-950 to-slate-900 text-white overflow-hidden">
        {/* subtle grid pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")"}} />
        {/* glow orbs */}
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl" />
        <div className="absolute top-40 right-1/4 w-80 h-80 bg-violet-600/15 rounded-full blur-3xl" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-6 text-center">
          <FadeIn>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/[0.07] backdrop-blur-sm rounded-full text-sm font-medium text-blue-200 mb-8 border border-white/10">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              100% free — no credit card needed
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold leading-[1.1] tracking-tight">
              Run your business
              <br />
              <span className="bg-gradient-to-r from-yellow-300 via-amber-300 to-yellow-400 bg-clip-text text-transparent">
                with clarity
              </span>
            </h1>
          </FadeIn>

          <FadeIn delay={200}>
            <p className="mt-6 text-lg md:text-xl text-blue-200/80 max-w-2xl mx-auto leading-relaxed">
              Sales, expenses, inventory, staff, cash flow, and WhatsApp — all in one dashboard.
              Built for shop owners, not accountants.
            </p>
          </FadeIn>

          <FadeIn delay={300}>
            <div className="mt-5 flex items-center justify-center gap-6 text-sm text-blue-300/70">
              {["Works on any phone", "Set up in 60 seconds", "No hidden fees"].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                  {t}
                </span>
              ))}
            </div>
          </FadeIn>

          <FadeIn delay={400}>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/register" className="w-full sm:w-auto px-10 py-4 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-500 transition shadow-2xl shadow-blue-600/30 text-center text-lg">
                Get Started — It's Free
              </Link>
              <Link to="/login" className="w-full sm:w-auto px-10 py-4 border border-white/20 text-white font-semibold rounded-xl hover:bg-white/5 transition text-center">
                Sign In
              </Link>
            </div>
          </FadeIn>

          {/* ── Dashboard Preview ── */}
          <FadeIn delay={500}>
            <div className="mt-16 max-w-5xl mx-auto">
              <div className="bg-gray-950/80 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl shadow-black/50 p-3 sm:p-5">
                {/* browser-style top bar */}
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

                {/* Dashboard content */}
                <div className="bg-gray-900 rounded-xl p-3 sm:p-5">
                  {/* Welcome bar */}
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-white text-sm font-semibold">Welcome back, Manoj's Shop</p>
                      <p className="text-gray-500 text-[11px]">Tuesday, 25 March 2026</p>
                    </div>
                    <div className="hidden sm:flex gap-2">
                      <span className="px-3 py-1.5 bg-blue-600 text-white text-[11px] rounded-lg font-semibold flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                        Quick Sale
                      </span>
                      <span className="px-3 py-1.5 bg-emerald-600 text-white text-[11px] rounded-lg font-semibold flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4"/></svg>
                        Item Sale
                      </span>
                    </div>
                  </div>

                  {/* KPI Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-3">
                    {[
                      { label: "Today's Revenue", val: "24,500", sub: "+12% vs yesterday", color: "text-white", subColor: "text-green-400", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
                      { label: "Profit", val: "70,097", sub: "57.8% margin", color: "text-white", subColor: "text-blue-400", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
                      { label: "Stock Value", val: "82,400", sub: "3 low stock items", color: "text-white", subColor: "text-yellow-400", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
                      { label: "Khata Receivable", val: "40,000", sub: "5 customers", color: "text-red-400", subColor: "text-gray-500", icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253" },
                    ].map((kpi) => (
                      <div key={kpi.label} className="bg-gray-800/70 p-2.5 sm:p-3 rounded-lg border border-gray-700/50 group hover:border-gray-600 transition">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-gray-500 text-[10px] sm:text-xs">{kpi.label}</p>
                          <svg className="w-3.5 h-3.5 text-gray-600 hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={kpi.icon}/></svg>
                        </div>
                        <p className={`${kpi.color} text-base sm:text-lg font-bold`}>{kpi.val}</p>
                        <p className={`${kpi.subColor} text-[10px]`}>{kpi.sub}</p>
                      </div>
                    ))}
                  </div>

                  {/* Bottom row: Health Score + Inventory Overview */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
                    {/* Health Score */}
                    <div className="bg-gray-800/70 rounded-lg border border-gray-700/50 p-3 flex items-center gap-4">
                      <div className="text-center flex-shrink-0">
                        <div className="w-12 h-12 rounded-full border-[3px] border-green-500 flex items-center justify-center bg-green-500/10">
                          <span className="text-green-400 font-bold text-base">76</span>
                        </div>
                        <p className="text-gray-500 text-[10px] mt-1">Health</p>
                      </div>
                      <div className="flex-1 space-y-1.5 hidden sm:block">
                        {[
                          { label: "Profitability", pct: 82, color: "bg-green-500" },
                          { label: "Consistency", pct: 95, color: "bg-blue-500" },
                          { label: "Cost Control", pct: 60, color: "bg-yellow-500" },
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

                    {/* Inventory Widget */}
                    <div className="bg-gray-800/70 rounded-lg border border-gray-700/50 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wider">Inventory Overview</p>
                        <span className="text-blue-400 text-[10px]">View all</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-gray-900/50 rounded-md p-1.5">
                          <p className="text-gray-500 text-[9px]">Stock Value</p>
                          <p className="text-white text-xs font-bold">82,400</p>
                        </div>
                        <div className="bg-gray-900/50 rounded-md p-1.5">
                          <p className="text-gray-500 text-[9px]">Potential Profit</p>
                          <p className="text-emerald-400 text-xs font-bold">+47,600</p>
                        </div>
                        <div className="bg-gray-900/50 rounded-md p-1.5">
                          <p className="text-gray-500 text-[9px]">Avg Margin</p>
                          <p className="text-white text-xs font-bold">58%</p>
                        </div>
                        <div className="bg-gray-900/50 rounded-md p-1.5">
                          <p className="text-gray-500 text-[9px]">Low Stock</p>
                          <p className="text-yellow-400 text-xs font-bold">3 items</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Recent Sales row */}
                  <div className="mt-3 bg-gray-800/70 rounded-lg border border-gray-700/50 p-3 hidden sm:block">
                    <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wider mb-2">Recent Sales</p>
                    <div className="space-y-1.5">
                      {[
                        { name: "Coca-Cola × 10", price: "150", profit: "+100", method: "Cash" },
                        { name: "Basmati Rice 5kg × 3", price: "1,350", profit: "+270", method: "MobilePay" },
                        { name: "Quick Sale", price: "2,400", profit: "", method: "Card" },
                      ].map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-gray-700/30 last:border-0">
                          <div className="flex items-center gap-2">
                            <div className={`w-1.5 h-1.5 rounded-full ${s.profit ? "bg-emerald-400" : "bg-blue-400"}`} />
                            <span className="text-gray-300">{s.name}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            {s.profit && <span className="text-emerald-400 text-[10px]">{s.profit}</span>}
                            <span className="text-white font-medium">{s.price} kr</span>
                            <span className="text-gray-600 text-[10px]">{s.method}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-blue-400/40 text-xs mt-3 tracking-wide">Live dashboard preview</p>
            </div>
          </FadeIn>
        </div>

        {/* Curved divider */}
        <div className="relative h-16 sm:h-24">
          <svg className="absolute bottom-0 w-full" viewBox="0 0 1440 96" fill="none" preserveAspectRatio="none">
            <path d="M0 96L1440 96L1440 0C1440 0 1080 96 720 96C360 96 0 0 0 0L0 96Z" fill="white"/>
          </svg>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="py-12 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { val: 9, suffix: "+", label: "Features" },
              { val: 12, suffix: "", label: "Currencies" },
              { val: 10, suffix: "+", label: "Languages" },
              { val: 3, suffix: "", label: "Countries" },
            ].map((s) => (
              <FadeIn key={s.label}>
                <div>
                  <p className="text-3xl sm:text-4xl font-extrabold text-gray-900">
                    <Counter end={s.val} duration={1200} suffix={s.suffix} />
                  </p>
                  <p className="text-gray-500 text-sm mt-1">{s.label}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features Grid ── */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-blue-600 text-sm font-semibold uppercase tracking-wider mb-3">Features</p>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-gray-900 tracking-tight">
                Everything you need to run your shop
              </h2>
              <p className="mt-5 text-gray-500 text-lg max-w-xl mx-auto">
                Built for the kiosk owner, the grillbar chef, the wholesaler, the corner shop
              </p>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => {
              const c = colorMap[f.color];
              return (
                <FadeIn key={f.title} delay={i * 60}>
                  <div className={`bg-white rounded-2xl p-6 border border-gray-100 hover:shadow-lg ${c.border} transition-all duration-300 group cursor-default h-full`}>
                    <div className={`w-12 h-12 ${c.bg} rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                      <svg className={`w-6 h-6 ${c.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={f.icon} />
                      </svg>
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">{f.title}</h3>
                    <p className="text-gray-500 text-sm leading-relaxed">{f.desc}</p>
                  </div>
                </FadeIn>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="py-16 sm:py-24 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-blue-600 text-sm font-semibold uppercase tracking-wider mb-3">Get started</p>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-gray-900 tracking-tight">
                Up and running in 60 seconds
              </h2>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {steps.map((step, i) => (
              <FadeIn key={step.number} delay={i * 120}>
                <div className="text-center relative">
                  {/* connector line */}
                  {i < 2 && (
                    <div className="hidden md:block absolute top-8 left-[60%] w-[80%] border-t-2 border-dashed border-gray-300" />
                  )}
                  <div className="relative z-10 w-16 h-16 bg-blue-600 text-white rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-blue-600/25">
                    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={step.icon} />
                    </svg>
                  </div>
                  <div className="text-blue-600 text-xs font-bold mb-2">STEP {step.number}</div>
                  <h3 className="text-lg font-bold text-gray-900 mb-1">{step.title}</h3>
                  <p className="text-gray-500 text-sm">{step.sub}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Built for real businesses ── */}
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center">
              <p className="text-blue-600 text-sm font-semibold uppercase tracking-wider mb-3">Global</p>
              <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-4">
                Works where you work
              </h2>
              <p className="text-gray-500 text-lg mb-8 max-w-lg mx-auto">
                Whether you're in Copenhagen, Kathmandu, or Delhi — BonBox speaks your language and supports your currency.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                {[
                  { flag: "\ud83c\udde9\ud83c\uddf0", name: "Denmark" },
                  { flag: "\ud83c\uddf3\ud83c\uddf5", name: "Nepal" },
                  { flag: "\ud83c\uddee\ud83c\uddf3", name: "India" },
                ].map((c) => (
                  <span key={c.name} className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-50 border border-gray-200 text-gray-700 text-sm font-medium rounded-full hover:border-blue-300 transition">
                    <span className="text-lg">{c.flag}</span>
                    {c.name}
                  </span>
                ))}
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative py-20 sm:py-28 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 text-white text-center overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-10 left-1/3 w-72 h-72 bg-blue-600/20 rounded-full blur-3xl" />
          <div className="absolute bottom-10 right-1/3 w-60 h-60 bg-violet-600/15 rounded-full blur-3xl" />
        </div>
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold mb-5 tracking-tight">
              Your business deserves
              <br />
              <span className="bg-gradient-to-r from-yellow-300 to-amber-300 bg-clip-text text-transparent">better than guesswork</span>
            </h2>
            <p className="text-blue-200/70 text-lg mb-10 max-w-lg mx-auto">
              Join BonBox and see your business clearly — sales, stock, staff, cash, all in one place.
            </p>
            <Link to="/register" className="inline-block px-12 py-4 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-500 transition shadow-2xl shadow-blue-600/30 text-lg">
              Get Started Free
            </Link>
            <p className="mt-5 text-blue-300/50 text-sm">No credit card. No monthly fees. No catch.</p>
          </FadeIn>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-10 bg-slate-950 border-t border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-8 h-8 bg-white/10 rounded-lg">
              <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-white font-bold text-sm">BonBox</span>
          </div>
          <p className="text-gray-500 text-xs text-center">
            Built by Manoj Chaudhary &middot; MSc Data-Driven Business Development, SDU
          </p>
          <Link to="/contact" className="text-blue-400 text-sm hover:text-blue-300 transition">
            Contact
          </Link>
        </div>
      </footer>
    </div>
  );
}
