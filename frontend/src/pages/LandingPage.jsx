import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";

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

/* ══════════════════════════════════════════════════════════ */
export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950 overflow-x-hidden">

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
            <Link to="/login" className="px-5 py-2 text-sm font-medium text-gray-300 hover:text-white transition">
              Sign In
            </Link>
            <Link to="/register" className="px-5 py-2.5 text-sm font-semibold bg-green-500 text-white rounded-lg hover:bg-green-400 transition shadow-lg shadow-green-500/25">
              Start Free
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
            <Link to="/register" className="block w-full text-center px-4 py-3 text-sm font-semibold bg-green-500 text-white rounded-lg">Start Free</Link>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className="relative pt-32 sm:pt-40 pb-20 sm:pb-32 text-white overflow-hidden">
        {/* Glow orbs */}
        <div className="absolute top-20 left-1/4 w-[500px] h-[500px] bg-green-600/10 rounded-full blur-[120px]" />
        <div className="absolute top-40 right-1/4 w-[400px] h-[400px] bg-orange-600/8 rounded-full blur-[120px]" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 text-center">
          <FadeIn>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-green-500/10 backdrop-blur-sm rounded-full text-sm font-medium text-green-400 mb-8 border border-green-500/20">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              100% free — no card, no catch
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold leading-[1.08] tracking-tight">
              Know your business.
              <br />
              <span className="bg-gradient-to-r from-green-400 via-emerald-400 to-green-300 bg-clip-text text-transparent">
                Grow your business.
              </span>
            </h1>
          </FadeIn>

          <FadeIn delay={200}>
            <p className="mt-6 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Sales, expenses, inventory, weather, staff — all in one dashboard.
              <br className="hidden sm:block" />
              Built for <span className="text-white font-medium">21+ business types</span> who want real numbers, not paperwork.
            </p>
          </FadeIn>

          <FadeIn delay={300}>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/register" className="w-full sm:w-auto px-10 py-4 bg-green-500 text-white font-bold rounded-xl hover:bg-green-400 transition shadow-2xl shadow-green-500/25 text-center text-lg">
                Get Started — It's Free
              </Link>
              <a href="https://play.google.com/store/apps/details?id=dk.bonbox.app" target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto px-10 py-4 border border-white/15 text-white font-semibold rounded-xl hover:bg-white/5 transition text-center flex items-center justify-center gap-2">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/></svg>
                Android App
              </a>
            </div>
          </FadeIn>

          <FadeIn delay={350}>
            <div className="mt-6 flex items-center justify-center gap-6 text-sm text-gray-500">
              {["Works on any phone", "60-second setup", "No hidden fees"].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                  {t}
                </span>
              ))}
            </div>
          </FadeIn>

          {/* ── Dashboard Preview ── */}
          <FadeIn delay={500}>
            <div className="mt-16 max-w-5xl mx-auto">
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

                <div className="bg-gray-900 rounded-xl p-3 sm:p-5">
                  {/* Welcome bar */}
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-white text-sm font-semibold">Welcome back, Manoj's Shop</p>
                      <p className="text-gray-500 text-[11px]">Sunday, 30 March 2026</p>
                    </div>
                    <div className="hidden sm:flex gap-2">
                      <span className="px-3 py-1.5 bg-green-600 text-white text-[11px] rounded-lg font-semibold flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                        Quick Sale
                      </span>
                      <span className="px-3 py-1.5 bg-orange-500 text-white text-[11px] rounded-lg font-semibold flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4"/></svg>
                        Item Sale
                      </span>
                    </div>
                  </div>

                  {/* KPI Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-3">
                    {[
                      { label: "Today's Revenue", val: "24,500 kr", sub: "+12% vs yesterday", color: "text-white", subColor: "text-green-400", border: "border-green-500/20" },
                      { label: "Profit", val: "70,097 kr", sub: "57.8% margin", color: "text-white", subColor: "text-green-400", border: "border-green-500/20" },
                      { label: "Stock Value", val: "82,400 kr", sub: "3 low stock items", color: "text-white", subColor: "text-yellow-400", border: "border-yellow-500/20" },
                      { label: "Khata Receivable", val: "40,000 kr", sub: "5 customers", color: "text-orange-400", subColor: "text-gray-500", border: "border-orange-500/20" },
                    ].map((kpi) => (
                      <div key={kpi.label} className={`bg-gray-800/60 p-2.5 sm:p-3 rounded-lg border ${kpi.border}`}>
                        <p className="text-gray-500 text-[10px] sm:text-xs">{kpi.label}</p>
                        <p className={`${kpi.color} text-base sm:text-lg font-bold mt-0.5`}>{kpi.val}</p>
                        <p className={`${kpi.subColor} text-[10px]`}>{kpi.sub}</p>
                      </div>
                    ))}
                  </div>

                  {/* Health + Inventory row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
                    <div className="bg-gray-800/60 rounded-lg border border-gray-700/50 p-3 flex items-center gap-4">
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
                    <div className="bg-gray-800/60 rounded-lg border border-gray-700/50 p-3">
                      <p className="text-gray-400 text-[10px] font-semibold uppercase tracking-wider mb-2">Recent Sales</p>
                      <div className="space-y-1.5">
                        {[
                          { name: "Coca-Cola x 10", price: "150 kr", method: "Cash", dot: "bg-green-400" },
                          { name: "Basmati Rice 5kg x 3", price: "1,350 kr", method: "MobilePay", dot: "bg-green-400" },
                          { name: "Bar: 2x Vodka", price: "90 kr", method: "Card", dot: "bg-orange-400" },
                        ].map((s, i) => (
                          <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-gray-700/30 last:border-0">
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                              <span className="text-gray-300">{s.name}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-white font-medium">{s.price}</span>
                              <span className="text-gray-600 text-[10px]">{s.method}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-gray-600 text-xs mt-3 tracking-wide">Live dashboard preview</p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="py-12 border-y border-white/5 bg-slate-900/50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { val: 15, suffix: "+", label: "Features" },
              { val: 21, suffix: "+", label: "Business Types" },
              { val: 3, suffix: "", label: "Languages" },
              { val: 0, suffix: "kr", label: "Price", prefix: "" },
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

      {/* ── Who it's for ── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-green-400 text-sm font-semibold uppercase tracking-wider mb-3">Built for you</p>
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-white tracking-tight">
                One app. Every business need.
              </h2>
              <p className="mt-5 text-gray-400 text-lg max-w-xl mx-auto">
                Restaurant, bar, grocery, salon, bakery, food truck, thrift store — BonBox has you covered.
              </p>
            </div>
          </FadeIn>

          {/* Top 6 features - the convincing ones */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              { icon: "💰", title: "Sales & Cash Flow", desc: "Log sales in 2 taps. See revenue, profit, and cash flow — auto-synced to your cashbook in real-time.", accent: "from-green-500/20 to-emerald-500/10", border: "border-green-500/20 hover:border-green-500/40" },
              { icon: "📦", title: "Inventory & Stock", desc: "Track stock levels, get low-stock alerts, sell items with auto-deduction. Pre-built templates for 21+ business types.", accent: "from-blue-500/20 to-cyan-500/10", border: "border-blue-500/20 hover:border-blue-500/40" },
              { icon: "🌦️", title: "Weather Smart", desc: "Rain = less foot traffic. See how weather affects your revenue, plan staff smarter, and track sick calls by condition.", accent: "from-cyan-500/20 to-sky-500/10", border: "border-cyan-500/20 hover:border-cyan-500/40" },
              { icon: "👥", title: "Smart Staffing", desc: "AI-powered shifts based on your busiest days + weather forecast. See payroll costs. Right people, right time.", accent: "from-violet-500/20 to-purple-500/10", border: "border-violet-500/20 hover:border-violet-500/40" },
              { icon: "🍸", title: "Bar Pour System", desc: "Buy bottles in bulk, sell by glass. Auto-track pours, deduct stock, and log sales per drink.", accent: "from-orange-500/20 to-amber-500/10", border: "border-orange-500/20 hover:border-orange-500/40" },
              { icon: "🗑️", title: "Waste Tracker", desc: "Log expired and wasted stock. See how much you're losing. Reduce waste, increase profit.", accent: "from-red-500/20 to-rose-500/10", border: "border-red-500/20 hover:border-red-500/40" },
            ].map((f, i) => (
              <FadeIn key={f.title} delay={i * 80}>
                <div className={`bg-gradient-to-br ${f.accent} rounded-2xl p-6 border ${f.border} transition-all duration-300 h-full group`}>
                  <div className="text-3xl mb-4">{f.icon}</div>
                  <h3 className="text-lg font-bold text-white mb-2">{f.title}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
                </div>
              </FadeIn>
            ))}
          </div>

          {/* Extra features ribbon */}
          <FadeIn delay={200}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              {["Cash Book", "Khata Credit Book", "Business Health Score", "VAT Reports", "PDF Export", "Loan Tracker", "Personal Finance", "Dark Mode", "Seasonal Patterns", "Sick Call Tracker", "Multi-currency", "Multi-language"].map((f) => (
                <span key={f} className="px-4 py-2 bg-white/5 border border-white/10 text-gray-400 text-sm font-medium rounded-full">
                  {f}
                </span>
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
              <p className="text-orange-400 text-sm font-semibold uppercase tracking-wider mb-3">For bars & restaurants</p>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                Buy in bulk. Sell by glass.
                <br />
                <span className="text-orange-400">Track everything.</span>
              </h2>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 sm:p-10">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 text-center">
                {[
                  { icon: "🍾", title: "Buy Bottle", sub: "750ml Vodka", color: "text-white" },
                  { icon: "🥃", title: "Pour Glass", sub: "30ml per shot", color: "text-white" },
                  { icon: "📉", title: "Auto Deduct", sub: "Stock updates live", color: "text-green-400" },
                  { icon: "💵", title: "Sale Logged", sub: "45 DKK per glass", color: "text-orange-400" },
                ].map((step, i) => (
                  <div key={step.title} className="relative">
                    <div className="text-4xl mb-3">{step.icon}</div>
                    <p className={`font-bold text-sm ${step.color}`}>{step.title}</p>
                    <p className="text-gray-500 text-xs mt-1">{step.sub}</p>
                    {i < 3 && (
                      <span className="hidden sm:block absolute top-8 -right-3 sm:-right-4 text-orange-500 text-lg font-bold">→</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-center text-green-400 font-semibold text-sm mt-8">One bottle = 25 drinks = 1,125 DKK revenue. BonBox tracks every pour.</p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center mb-16">
              <p className="text-green-400 text-sm font-semibold uppercase tracking-wider mb-3">Get started</p>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                Up and running in 60 seconds
              </h2>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {[
              { num: "1", title: "Sign up free", sub: "Name + email. That's it.", icon: "👤" },
              { num: "2", title: "Log your first sale", sub: "Tap, type, or speak.", icon: "✏️" },
              { num: "3", title: "See your numbers", sub: "Dashboard lights up instantly.", icon: "⚡" },
            ].map((step, i) => (
              <FadeIn key={step.num} delay={i * 120}>
                <div className="text-center relative">
                  {i < 2 && (
                    <div className="hidden md:block absolute top-8 left-[60%] w-[80%] border-t-2 border-dashed border-gray-700" />
                  )}
                  <div className="relative z-10 w-16 h-16 bg-green-500/10 border border-green-500/30 text-3xl rounded-2xl flex items-center justify-center mx-auto mb-5">
                    {step.icon}
                  </div>
                  <div className="text-green-400 text-xs font-bold mb-2">STEP {step.num}</div>
                  <h3 className="text-lg font-bold text-white mb-1">{step.title}</h3>
                  <p className="text-gray-500 text-sm">{step.sub}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social proof / credibility ── */}
      <section className="py-16 border-y border-white/5 bg-slate-900/30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <FadeIn>
            <div className="text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-white mb-4">
                Works where you work
              </h2>
              <p className="text-gray-400 text-lg mb-8 max-w-lg mx-auto">
                3 languages, 17+ currencies, 21+ business types, and growing.
              </p>
              <div className="flex flex-wrap justify-center gap-3 mb-10">
                {[
                  { flag: "🇩🇰", name: "Denmark" },
                  { flag: "🇳🇵", name: "Nepal" },
                  { flag: "🇬🇧", name: "UK" },
                  { flag: "🇪🇺", name: "Europe" },
                  { flag: "🇮🇳", name: "India" },
                  { flag: "🇯🇵", name: "Japan" },
                ].map((c) => (
                  <span key={c.name} className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/5 border border-white/10 text-gray-300 text-sm font-medium rounded-full">
                    <span className="text-lg">{c.flag}</span>
                    {c.name}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
                {[
                  { icon: "🎓", text: "Built by MSc Data-Driven Business graduate, SDU Denmark" },
                  { icon: "📱", text: "Available on web + Android (Google Play)" },
                  { icon: "🔒", text: "Your data is yours. Always encrypted. Never sold." },
                ].map((item) => (
                  <div key={item.text} className="bg-white/[0.03] border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl mb-2">{item.icon}</div>
                    <p className="text-gray-400 text-sm">{item.text}</p>
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
              Your business deserves
              <br />
              <span className="bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">better than guesswork</span>
            </h2>
            <p className="text-gray-400 text-lg mb-10 max-w-lg mx-auto">
              Join BonBox and finally see your business clearly — sales, stock, staff, weather, cash, all in one place.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/register" className="w-full sm:w-auto px-12 py-4 bg-green-500 text-white font-bold rounded-xl hover:bg-green-400 transition shadow-2xl shadow-green-500/25 text-lg">
                Get Started Free
              </Link>
              <a href="https://play.google.com/store/apps/details?id=dk.bonbox.app" target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto px-8 py-4 border border-white/15 text-white font-semibold rounded-xl hover:bg-white/5 transition flex items-center justify-center gap-2">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/></svg>
                Get on Android
              </a>
            </div>
            <p className="mt-5 text-gray-600 text-sm">No credit card. No monthly fees. No catch.</p>
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
            &copy; 2026 BonBox &middot; Smart analytics for small businesses
          </p>
          <div className="flex items-center gap-4">
            <Link to="/contact" className="text-gray-500 text-sm hover:text-gray-300 transition">Contact</Link>
            <Link to="/privacy" className="text-gray-500 text-sm hover:text-gray-300 transition">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
