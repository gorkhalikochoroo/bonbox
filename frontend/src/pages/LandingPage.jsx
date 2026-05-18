/*
 * LandingPage — rebuilt 2026-05-13.
 *
 * Design rules (intentional, not vibe-coded):
 *
 *   1. ONE accent colour: BonBox green (#10B981 / emerald-500). No
 *      per-section purple/teal/blue gradient backgrounds. Decoration
 *      that doesn't carry meaning gets cut.
 *
 *   2. Editorial typography: large display heading, restrained body,
 *      mono-feel for numbers. Hierarchy does the work, not colour.
 *
 *   3. Restrained palette: warm white (#fafaf7) for sections, true
 *      white for cards, charcoal (#0f172a) for the hero band. No
 *      4-colour gradient washes.
 *
 *   4. 7 sections, max. The previous landing had 16 with heavy
 *      padding — users gave up halfway. Sections that didn't earn
 *      their space (per-vertical spotlights, 27-pill ribbon,
 *      "global reach" with zero users) are gone.
 *
 *   5. Sticky nav with smooth-scroll anchors so the page is
 *      navigable as well as scrollable.
 *
 *   6. Single fade-in is fine on hero. Below-the-fold sections
 *      render fully — no fade-in-on-scroll theatre that makes the
 *      page look broken until you scroll past it.
 *
 * The HeroPhone component is preserved (it works) but tightened.
 * The LiveDemo / Spotlight components are intentionally NOT carried
 * over — they conflicted with the single-accent rule and added
 * scroll without adding clarity.
 */

import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

// tx(t, key, fallback) — wrapper around the i18n t() helper that
// falls back to the supplied default when the key isn't present in
// any locale. The shared t() returns the key itself on miss (so the
// idiomatic `t(k) || fb` never fires), and we don't want to change
// global i18n behaviour. Pure function, no React hooks — safe to use
// inside any component (HeroPhone, Counter, the main page itself).
function tx(t, key, fallback) {
  const v = t(key);
  return (v && v !== key) ? v : fallback;
}

// ─── HeroPhone ──────────────────────────────────────────────────────
//
// Compact mock of the BonBox dashboard inside a phone frame. Same
// component as before — single accent (green), tight layout, no
// status-bar/notch overkill. Used in the hero, not elsewhere.
function HeroPhone() {
  const { t } = useLanguage();
  return (
    <div className="relative w-full max-w-[280px] sm:max-w-[300px] mx-auto" style={{ animation: "heroFloat 5s ease-in-out infinite" }}>
      <div className="absolute inset-0 bg-emerald-500/25 rounded-[3rem] blur-[80px] scale-110 pointer-events-none" />
      <div className="relative bg-gray-900 rounded-[2.25rem] p-2.5 border border-gray-800 shadow-2xl shadow-emerald-500/10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-5 bg-gray-900 rounded-b-2xl z-10" />
        <div className="bg-gray-950 rounded-[1.85rem] overflow-hidden p-3.5 pt-7">
          {/* status row */}
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-white/80 text-[9px] font-semibold tabular-nums">9:41</span>
            <div className="flex items-center gap-1 text-white/40">
              <div className="w-3 h-1.5 border border-white/40 rounded-sm">
                <div className="h-full bg-emerald-400 rounded-[1px]" style={{ width: "70%" }} />
              </div>
            </div>
          </div>
          {/* header */}
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-white text-[11px] font-bold leading-tight">{tx(t, "dashboard", "Dashboard")}</p>
              <p className="text-stone-500 text-[8px]">{tx(t, "today", "Today")}</p>
            </div>
            <div className="w-5 h-5 bg-emerald-500/20 rounded-full" />
          </div>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            <div className="bg-gray-800/70 rounded-md p-2">
              <p className="text-stone-500 text-[7px] uppercase tracking-wider">{tx(t, "revenue", "Revenue")}</p>
              <p className="text-white text-[13px] font-bold tabular-nums mt-0.5">24,500 kr</p>
              <p className="text-emerald-400 text-[7px] mt-0.5">+12%</p>
            </div>
            <div className="bg-gray-800/70 rounded-md p-2">
              <p className="text-stone-500 text-[7px] uppercase tracking-wider">{tx(t, "profit", "Profit")}</p>
              <p className="text-white text-[13px] font-bold tabular-nums mt-0.5">70,097 kr</p>
              <p className="text-emerald-400 text-[7px] mt-0.5">57.8%</p>
            </div>
          </div>
          {/* sparkline */}
          <div className="bg-gray-800/70 rounded-md p-2 mb-2">
            <p className="text-stone-500 text-[7px] uppercase tracking-wider mb-1">{tx(t, "weeklySales", "Weekly sales")}</p>
            <svg viewBox="0 0 200 36" className="w-full h-7">
              <defs>
                <linearGradient id="hpGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0,28 L30,22 L60,26 L90,14 L120,18 L150,8 L180,12 L200,5 L200,36 L0,36 Z" fill="url(#hpGrad)" />
              <polyline points="0,28 30,22 60,26 90,14 120,18 150,8 180,12 200,5" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {/* recent items — compact */}
          <div className="bg-gray-800/70 rounded-md p-2">
            <p className="text-stone-500 text-[7px] uppercase tracking-wider mb-1">{tx(t, "recentSales", "Recent sales")}</p>
            {[
              ["Coca-Cola x10", "150"],
              ["Rice 5kg", "1,350"],
              ["Vodka 2x", "90"],
            ].map(([n, p]) => (
              <div key={n} className="flex items-center justify-between py-0.5">
                <span className="text-gray-300 text-[8px]">{n}</span>
                <span className="text-white text-[8px] font-medium tabular-nums">{p} kr</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Counter — animates a number once it scrolls into view ──────────
// Initial value = `end`, so the first paint shows the REAL number, not
// a "0s · 0+ · 0 min" zero-flash that briefly tells visitors our close
// takes zero seconds. When the strip scrolls into view we briefly
// reset to 0 and animate up — but only if motion is allowed and the
// initial render had time to commit. Belt + braces.
function Counter({ end, duration = 1400, suffix = "", prefix = "" }) {
  const [val, setVal] = useState(end);
  const ref = useRef(null);
  const started = useRef(false);
  useEffect(() => {
    // Respect prefers-reduced-motion → keep the static end value
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (prefersReduced) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          setVal(0);
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
      { threshold: 0.4 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, duration]);
  return <span ref={ref} className="tabular-nums">{prefix}{val.toLocaleString("da-DK")}{suffix}</span>;
}

// ─── Section primitive — consistent padding + max-width ─────────────
function Section({ id, className = "", children }) {
  return (
    <section id={id} className={`relative py-16 sm:py-24 ${className}`}>
      <div className="max-w-6xl mx-auto px-5 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}

// ─── Eyebrow heading — small uppercase label above section title ────
function Eyebrow({ children }) {
  return (
    <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700 mb-3">
      {children}
    </span>
  );
}

// ─── Heading — restrained, editorial, single colour ────────────────
function Heading({ as: As = "h2", className = "", children }) {
  return (
    <As className={`text-[28px] sm:text-[36px] lg:text-[44px] leading-[1.1] tracking-tight font-semibold text-gray-900 ${className}`}>
      {children}
    </As>
  );
}

// ─── Feature card — uniform, single accent, no per-card colour ──────
function FeatureCard({ icon, title, body }) {
  return (
    <div className="group relative bg-white rounded-2xl p-7 border border-stone-200/80 hover:border-stone-300 hover:shadow-[0_4px_24px_-8px_rgba(15,23,42,0.08)] transition-all duration-200">
      <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center mb-5 group-hover:bg-emerald-100 transition-colors">
        {icon}
      </div>
      <h3 className="text-[17px] font-semibold text-gray-900 mb-2 tracking-tight">{title}</h3>
      <p className="text-[14.5px] text-stone-600 leading-relaxed">{body}</p>
    </div>
  );
}

// Monochrome line icons — one design language, not a 14-emoji parade.
// Each is a 20×20 stroke-1.75 icon at currentColor (emerald-700 in
// the feature card slot).
const Icons = {
  Clock: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  Receipt: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h10a1 1 0 011 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 011-1z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  ),
  Spark: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  ),
  Bank: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18" />
    </svg>
  ),
  Stack: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4" />
    </svg>
  ),
  Calendar: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  ),
  Shield: (
    <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  Apple: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  ),
  Check: (
    <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
    </svg>
  ),
  Cross: (
    <svg className="w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4.3 4.3a1 1 0 011.4 0L10 8.6l4.3-4.3a1 1 0 111.4 1.4L11.4 10l4.3 4.3a1 1 0 11-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 11-1.4-1.4L8.6 10 4.3 5.7a1 1 0 010-1.4z" clipRule="evenodd" />
    </svg>
  ),
};

// ═══════════════════════════════════════════════════════════════════
//                        Main component
// ═══════════════════════════════════════════════════════════════════
export default function LandingPage() {
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Bind the module-level tx() helper to this component's t() so call
  // sites can write `tx_("key", "fallback")` without threading t/
  // through every prop.
  const tx_ = (key, fallback) => tx(t, key, fallback);

  // Add a thin shadow to the nav once we've scrolled past the hero so
  // the floating chrome reads against any background.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Nav anchors — these set the navigable shape of the page. Keep
  // short (3-4 items) so the nav doesn't crowd the brand on mobile.
  // Anchor links kept intentionally short. We don't link to the
  // comparison/competitor on the landing — BonBox stands on its own
  // story, not by sending users to research Dinero.
  const navLinks = [
    { href: "#features", label: tx_("landingNavFeatures", "Features") },
    { href: "#how", label: tx_("landingNavHow", "How it works") },
    { href: "#pricing", label: tx_("landingNavPricing", "Pricing") },
  ];

  return (
    <div className="min-h-screen bg-[#fafaf7] text-gray-900 antialiased">
      <style>{`
        @keyframes heroFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        html { scroll-behavior: smooth; }

        /* Flow demo — staggered fade-in loop. Each step lights up in
           sequence (snap → merge → PDF) then loops. Reduced motion
           respected so users who hate animation see all three steady. */
        @keyframes flowFadeIn {
          0%, 100% { opacity: 0.45; transform: translateY(0); }
          15%, 85% { opacity: 1; transform: translateY(-3px); }
        }
        @keyframes flowArrowPulse {
          0%, 100% { opacity: 0.35; }
          50%      { opacity: 1; }
        }
        @keyframes flowPulse {
          0%, 100% { transform: scale(1);   opacity: 0.0; }
          50%      { transform: scale(1.4); opacity: 0.6; }
        }
        .flowStep  { animation: flowFadeIn 4.5s ease-in-out infinite; }
        .flowStep1 { animation-delay: 0s; }
        .flowStep2 { animation-delay: 1.5s; }
        .flowStep3 { animation-delay: 3s; }
        .flowArrow  { animation: flowArrowPulse 4.5s ease-in-out infinite; }
        .flowArrow1 { animation-delay: 0.75s; }
        .flowArrow2 { animation-delay: 2.25s; }
        .flowPulse { animation: flowPulse 1.5s ease-in-out infinite; animation-delay: 1.5s; }
        @media (prefers-reduced-motion: reduce) {
          .flowStep, .flowArrow, .flowPulse { animation: none; opacity: 1; }
        }
      `}</style>

      {/* ── NAV ──────────────────────────────────────────────────
          Safe-area aware: nav extends behind the notch / status bar
          (so the blur covers the whole top edge) but the actual link
          row sits BELOW the inset, never under the notch. Uses
          `env(safe-area-inset-top)` which is exposed because we have
          `viewport-fit=cover` in the viewport meta. Falls back to 0
          on devices without a notch (Android tablets, desktop). */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 backdrop-blur-xl transition-shadow ${
          scrolled
            ? "bg-[#fafaf7]/90 border-b border-stone-200 shadow-[0_1px_0_rgba(15,23,42,0.04)]"
            : "bg-[#fafaf7]/70 border-b border-transparent"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="max-w-6xl mx-auto px-5 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-500 rounded-md flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
            </div>
            <span className="text-[16px] font-semibold tracking-tight">BonBox</span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="px-3 py-2 text-[14px] text-gray-700 hover:text-gray-900 transition-colors"
              >
                {l.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-label="Language"
              className="hidden sm:block text-[13px] bg-transparent border border-stone-200 rounded-md px-2 py-1.5 text-gray-700 hover:border-stone-300 focus:outline-none focus:ring-2 focus:ring-emerald-300 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <Link
              to="/login"
              className="hidden sm:inline-block px-3 py-2 text-[14px] font-medium text-gray-700 hover:text-gray-900"
            >
              {tx_("landingSignIn", "Sign in")}
            </Link>
            <Link
              to="/register"
              className="px-4 py-2 text-[14px] font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition shadow-sm"
            >
              {tx_("landingStartFree", "Get started")}
            </Link>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="md:hidden text-gray-700 p-2 -mr-2"
              aria-label="Menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                {menuOpen
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  : <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="md:hidden border-t border-stone-200 bg-[#fafaf7]">
            <div className="px-5 py-3 space-y-1">
              {navLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="block py-2 text-[15px] text-gray-700"
                >
                  {l.label}
                </a>
              ))}
              <div className="flex gap-2 pt-2">
                <Link to="/login" onClick={() => setMenuOpen(false)} className="flex-1 text-center py-2.5 text-[14px] border border-stone-300 rounded-md text-gray-800">
                  {tx_("landingSignIn", "Sign in")}
                </Link>
              </div>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="mt-2 w-full text-[14px] bg-white border border-stone-200 rounded-md px-3 py-2"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </nav>

      {/* ── HERO ───────────────────────────────────────────────────
          Top padding = base (matches old pt-32 sm:pt-36) PLUS the
          dynamic notch inset on phones with status-bar cutouts.
          `env(safe-area-inset-top, 0px)` resolves to 0 on devices
          without a notch (desktop / older Androids / iPads in portrait)
          so layout is unchanged there. Tailwind arbitrary-value brackets
          preserve the `sm:` breakpoint so desktop still gets the
          original 144px spacing. */}
      <Section className="pt-[calc(env(safe-area-inset-top,0px)+8rem)] sm:pt-[calc(env(safe-area-inset-top,0px)+9rem)] pb-12 sm:pb-16">
        {/* Single subtle glow — replaces the previous 2 blur circles
            that made the page look like a 2019 SaaS template. */}
        <div className="absolute inset-x-0 top-20 -z-10 flex justify-center pointer-events-none">
          <div className="h-[420px] w-[820px] bg-emerald-200/40 blur-[140px] rounded-full" />
        </div>

        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-12 lg:gap-20 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-emerald-200/80 rounded-full text-[12px] font-medium text-emerald-700 mb-7">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {tx_("landingBadge", "For multi-terminal hospitality")}
            </div>

            <h1 className="text-[40px] sm:text-[52px] lg:text-[60px] leading-[1.04] tracking-tight font-semibold">
              {tx_("landingHeroLine1", "The 90 seconds between")}{" "}
              <span className="text-emerald-600">{tx_("landingHeroLine2", "last guest and lights out.")}</span>
            </h1>

            <p className="mt-6 text-[17px] sm:text-[18px] text-stone-600 leading-relaxed max-w-[520px]">
              {tx_("landingHeroSub", "Front-of-house snaps each kasserapport. AI merges them in 6 seconds. Owner gets the consolidated PDF before close-up is even done.")}
            </p>

            <div className="mt-9 flex flex-col sm:flex-row gap-3">
              <Link
                to="/register"
                className="inline-flex items-center justify-center px-6 py-3.5 bg-emerald-600 text-white text-[15px] font-medium rounded-md hover:bg-emerald-700 transition shadow-[0_4px_14px_-4px_rgba(16,185,129,0.4)]"
              >
                {tx_("landingCtaPrimary", "Get started — free")}
                <svg className="w-4 h-4 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              {/* Secondary CTA — for the "kick tires before signup"
                  visitor. Smooth-scrolls to the how-it-works section
                  rather than forcing them through the register flow. */}
              <a
                href="#how"
                className="inline-flex items-center justify-center px-5 py-3.5 bg-white border border-stone-200 rounded-md hover:border-stone-300 transition text-[14px] font-medium text-stone-800"
              >
                {tx_("landingCtaSecondary", "See how it works")}
                <svg className="w-4 h-4 ml-2 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
              </a>
              <a
                href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2.5 px-5 py-3.5 bg-white border border-stone-200 rounded-md hover:border-stone-300 transition text-[14px]"
              >
                <span className="text-gray-900">{Icons.Apple}</span>
                <span className="text-gray-900 font-medium">App Store</span>
              </a>
            </div>

            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-stone-600">
              {[
                tx_("landingCheck1", "Free 14-day trial"),
                tx_("landingCheck2", "No card required"),
                tx_("landingCheck3", "Cancel anytime"),
              ].map((txt) => (
                <span key={txt} className="flex items-center gap-1.5">
                  {Icons.Check}
                  {txt}
                </span>
              ))}
            </div>
          </div>

          {/* Phone mockup — single, centred, no decorative duplicates */}
          {/* Phone mockup — visible from md (768px) up. Was hidden
              below lg (1024px) which meant tablets + portrait iPads
              saw a text-only hero with too much whitespace on the
              right. md works because HeroPhone scales nicely down
              to 280px wide. Mobile (<md) still hides it — the hero
              text + CTA stack reads cleaner on a 390px viewport
              than any squeezed visual. */}
          <div className="hidden md:block">
            <HeroPhone />
          </div>
        </div>
      </Section>

      {/* ── PROOF NUMBERS + INDUSTRIES STRIP ────────────────────── */}
      {/* Three big numbers that earn the strip + a "built for" line
          that quietly signals BonBox knows its segment. The strip
          replaces the previous "we trust this without naming names"
          look with a real positioning statement. */}
      <section className="py-12 border-y border-stone-200/70 bg-white">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 lg:px-8">
          <div className="grid grid-cols-3 gap-6 sm:gap-10">
            {[
              { val: 90, suffix: "s", label: tx_("landingStatCloseTime", "to close a day") },
              { val: 6, suffix: "+", label: tx_("landingStatTerminals", "terminals merged at once") },
              { val: 5, suffix: " min", label: tx_("landingStatSetup", "from signup to first sale") },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-[36px] sm:text-[44px] font-semibold tracking-tight text-gray-900">
                  <Counter end={s.val} suffix={s.suffix} />
                </p>
                <p className="text-[13px] sm:text-[14px] text-stone-500 mt-1.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Built-for chips — small, restrained, single line on
              desktop. Communicates segment without claiming customer
              logos we don't have yet. Each chip is a real persona
              BonBox is configured for (modules pre-enabled, copy
              tuned, OCR templates pre-built). */}
          {/* Smaller chips at mobile (11px) so all 6 fit in 2 even
              rows of 3 instead of 5+1 awkward. Bumps back to 13px on
              sm+ where there's room. "Built for" label drops below
              the chips on mobile to give them centre alignment. */}
          <div className="mt-10 pt-8 border-t border-stone-100 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 text-[11px] sm:text-[13px]">
            <span className="hidden sm:inline text-stone-500 mr-1 text-[13px]">
              {tx_("landingBuiltFor", "Built for")}
            </span>
            {[
              tx_("landingIndCafe", "Cafés"),
              tx_("landingIndRestaurant", "Restaurants"),
              tx_("landingIndBar", "Bars"),
              tx_("landingIndShop", "Retail shops"),
              tx_("landingIndFreelance", "Freelancers"),
              tx_("landingIndKonsulent", "Konsulenter"),
            ].map((label) => (
              <span
                key={label}
                className="px-2 sm:px-2.5 py-1 bg-stone-50 border border-stone-200 rounded-full text-stone-700 font-medium"
              >
                {label}
              </span>
            ))}
          </div>
          {/* "Built for" label only on mobile, sits above the chips
              once they wrap to multiple rows. Keeps the desktop
              inline layout but solves the lone "Konsulenter" widow. */}
          <p className="sm:hidden text-center text-[11px] text-stone-500 mt-2">
            {tx_("landingBuiltFor", "Built for")}
          </p>
        </div>
      </section>

      {/* ── GROW WITH BONBOX — outcomes, not features ─────────── */}
      {/* The "features" section below tells WHAT BonBox is. This one
          tells what changes in your business when you use it. The
          page now leads with outcomes (this section) and follows
          with the features that deliver them. Three outcome cards,
          each grounded in a real module we already shipped, so the
          claims aren't marketing wishes. */}
      <Section className="bg-[#fafaf7]">
        <div className="max-w-2xl mb-14">
          <Eyebrow>{tx_("landingGrowTag", "Grow with BonBox")}</Eyebrow>
          <Heading>{tx_("landingGrowTitle", "Built to grow your business — not just track it.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600 leading-relaxed">
            {tx_("landingGrowSub", "Most accounting tools tell you what already happened. BonBox surfaces what to do next — every morning, with numbers from your actual yesterday.")}
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          {[
            {
              icon: (
                <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 17l6-6 4 4 8-8" />
                  <path d="M14 7h7v7" />
                </svg>
              ),
              titleKey: "landingGrow1Title",
              titleFallback: "Higher margins",
              bodyKey: "landingGrow1Body",
              bodyFallback: "Catch what's bleeding before it costs you a month. Bar over-pour, low-margin items, waste creeping up — BonBox flags the anomalies in the morning Brief, not in next month's revisor meeting.",
              proofKey: "landingGrow1Proof",
              proofFallback: "Powered by · AI anomaly detection · Bar pour system · Expense OCR",
            },
            {
              icon: (
                <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              ),
              titleKey: "landingGrow2Title",
              titleFallback: "Steadier cash flow",
              bodyKey: "landingGrow2Body",
              bodyFallback: "Get paid faster, chase less. Bank deposits auto-match to open fakturaer. Overdue invoices surface in the morning Brief. Tax Autopilot never lets you miss a SKAT deadline — no surprise penalties.",
              proofKey: "landingGrow2Proof",
              proofFallback: "Powered by · Bank import · Faktura auto-match · Tax Autopilot",
            },
            {
              icon: (
                <svg className="w-5 h-5 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
                </svg>
              ),
              titleKey: "landingGrow3Title",
              titleFallback: "Smarter decisions",
              bodyKey: "landingGrow3Body",
              bodyFallback: "What today's top seller is, whether you're tracking ahead of last Wednesday, which customers pay late, when to staff up for the weekend rush. The kind of insight you'd otherwise pay a bookkeeper 2,000 kr/month to surface.",
              proofKey: "landingGrow3Proof",
              proofFallback: "Powered by · AI Daily Brief · Smart Drift · Predictive staffing",
            },
          ].map((o) => (
            <div
              key={o.titleKey}
              className="bg-white rounded-2xl p-7 border border-stone-200/80 hover:border-stone-300 hover:shadow-[0_4px_24px_-8px_rgba(15,23,42,0.08)] transition-all duration-200"
            >
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center mb-5">
                {o.icon}
              </div>
              <h3 className="text-[18px] font-semibold text-gray-900 mb-3 tracking-tight">
                {tx_(o.titleKey, o.titleFallback)}
              </h3>
              <p className="text-[14.5px] text-stone-600 leading-relaxed">
                {tx_(o.bodyKey, o.bodyFallback)}
              </p>
              {/* Proof strip — ties each outcome to real modules we
                  ship, so the marketing claim is auditable. */}
              <p className="mt-5 pt-5 border-t border-stone-100 text-[11px] font-medium uppercase tracking-[0.08em] text-emerald-700/80">
                {tx_(o.proofKey, o.proofFallback)}
              </p>
            </div>
          ))}
        </div>

        {/* Quiet conversion nudge tied to the section theme.
            "See yesterday's profit" is a real action a user can
            take in BonBox on day one — anchors the abstract outcome
            language to a concrete first-session moment. */}
        <p className="mt-10 text-center text-[14px] text-stone-600">
          {tx_("landingGrowFootnote", "Log today's revenue tonight. See yesterday's profit (and what to do today) tomorrow morning.")}
        </p>
      </Section>

      {/* ── FEATURES (6, not 14) ───────────────────────────────── */}
      <Section id="features" className="bg-white border-y border-stone-200/70">
        <div className="max-w-2xl mb-14">
          <Eyebrow>{tx_("landingFeaturesTag", "Everything in one place")}</Eyebrow>
          <Heading>{tx_("landingFeaturesTitle", "Built for the closer. Owned by the owner.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600 leading-relaxed">
            {tx_("landingFeaturesSub", "Six things BonBox does so you don't have to glue spreadsheets, POS apps, and a revisor every month.")}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            {
              icon: Icons.Clock,
              titleKey: "landingFeatHeroTitle",
              titleFallback: "Daily close in 90 seconds",
              bodyKey: "landingFeatHeroBody",
              bodyFallback: "Staff snap each kasserapport from any phone. AI merges them, owner gets the consolidated PDF before close-up is done.",
            },
            {
              icon: Icons.Receipt,
              titleKey: "landingFeatFakturaTitle",
              titleFallback: "Faktura, properly",
              bodyKey: "landingFeatFakturaBody",
              bodyFallback: "Gap-less fakturanummer per Bogføringsloven §7. Send + email + PDF in one tap. Auto-matched when the bank deposit lands.",
            },
            {
              icon: Icons.Bank,
              titleKey: "landingFeatBankTitle",
              titleFallback: "Bank import that thinks",
              bodyKey: "landingFeatBankBody",
              bodyFallback: "Upload your bank CSV. We auto-match incoming deposits to open fakturaer with confidence tiers — the ones we're not sure about land in a review inbox, not the books.",
            },
            {
              icon: Icons.Stack,
              titleKey: "landingFeatPosTitle",
              titleFallback: "POS + Inventory + Cash",
              bodyKey: "landingFeatPosBody",
              bodyFallback: "Log sales in 2 taps. Track stock with auto-deduction and low-stock alerts. Cash book stays in sync with every entry.",
            },
            {
              icon: Icons.Calendar,
              titleKey: "landingFeatStaffTitle",
              titleFallback: "Staff & shifts",
              bodyKey: "landingFeatStaffBody",
              bodyFallback: "Weekly schedule, hours logged from the staff portal, tip-pool split, PDF lønseddel preview ready for your revisor.",
            },
            {
              icon: Icons.Spark,
              titleKey: "landingFeatAiTitle",
              titleFallback: "AI that knows your business",
              bodyKey: "landingFeatAiBody",
              bodyFallback: "Morning brief with overdue fakturaer, low-stock items, and revenue trend vs your usual. Not a chatbot — a quiet assistant.",
            },
          ].map((f) => (
            <FeatureCard
              key={f.titleKey}
              icon={f.icon}
              title={tx_(f.titleKey, f.titleFallback)}
              body={tx_(f.bodyKey, f.bodyFallback)}
            />
          ))}
        </div>
      </Section>

      {/* ── EVERYTHING IN BONBOX — dense feature index ───────── */}
      {/* The 6 cards above tell the story. This section answers
          the "...but do you have X?" question for every X. Five
          named categories, ~6 capabilities each = 30 things shown
          in one structured viewport-height block. Replaces the old
          "27 random pills" antipattern with real information
          architecture. */}
      <Section className="bg-white border-y border-stone-200/70">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <Eyebrow>{tx_("landingAllTag", "Everything in BonBox")}</Eyebrow>
          <Heading>{tx_("landingAllTitle", "One app. 30+ tools that work together.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600 leading-relaxed">
            {tx_("landingAllSub", "BonBox replaces the spreadsheet + POS + bookkeeping glue. Every module shares the same data, so the morning Brief actually knows what you sold yesterday.")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-7 lg:gap-5">
          {[
            {
              titleKey: "landingCatMoney",
              titleFallback: "Money",
              items: [
                tx_("landingCatMoney1", "POS + Sales"),
                tx_("landingCatMoney2", "Expenses + OCR"),
                tx_("landingCatMoney3", "Cash Book"),
                tx_("landingCatMoney4", "Budget tracker"),
                tx_("landingCatMoney5", "Bank import"),
                tx_("landingCatMoney6", "Tax Autopilot (Moms)"),
              ],
            },
            {
              titleKey: "landingCatFaktura",
              titleFallback: "Faktura",
              items: [
                tx_("landingCatFaktura1", "Send fakturaer"),
                tx_("landingCatFaktura2", "CVR-verified customers"),
                tx_("landingCatFaktura3", "Bank auto-match"),
                tx_("landingCatFaktura4", "Audit log (10y)"),
                tx_("landingCatFaktura5", "Brand + logo on PDF"),
                tx_("landingCatFaktura6", "Kreditnota"),
              ],
            },
            {
              titleKey: "landingCatStock",
              titleFallback: "Stock",
              items: [
                tx_("landingCatStock1", "Inventory tracking"),
                tx_("landingCatStock2", "Low-stock alerts"),
                tx_("landingCatStock3", "Expiry warnings"),
                tx_("landingCatStock4", "Bar pour system"),
                tx_("landingCatStock5", "Smart import"),
                tx_("landingCatStock6", "Unit converter"),
              ],
            },
            {
              titleKey: "landingCatStaff",
              titleFallback: "Staff",
              items: [
                tx_("landingCatStaff1", "Weekly schedule"),
                tx_("landingCatStaff2", "Hours logged"),
                tx_("landingCatStaff3", "Tip-pool split"),
                tx_("landingCatStaff4", "Payroll PDF"),
                tx_("landingCatStaff5", "Staff portal"),
                tx_("landingCatStaff6", "Multi-branch"),
              ],
            },
            {
              titleKey: "landingCatAi",
              titleFallback: "AI",
              items: [
                tx_("landingCatAi1", "Daily Brief"),
                tx_("landingCatAi2", "Anomaly detection"),
                tx_("landingCatAi3", "Predictive staffing"),
                tx_("landingCatAi4", "OCR receipts"),
                tx_("landingCatAi5", "Smart Drift"),
                tx_("landingCatAi6", "BonBox Agent"),
              ],
            },
          ].map((cat) => (
            <div key={cat.titleKey}>
              <h3 className="text-[13px] font-semibold text-emerald-700 uppercase tracking-[0.1em] mb-4">
                {tx_(cat.titleKey, cat.titleFallback)}
              </h3>
              <ul className="space-y-2.5">
                {cat.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[14px] text-stone-700 leading-snug">
                    <span className="mt-1 flex-shrink-0 w-1 h-1 rounded-full bg-emerald-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footnote — there are more, this is the headline set.
            Sets honest expectation without dumping 60 things. */}
        <p className="mt-12 text-center text-[13px] text-stone-500">
          {tx_("landingAllFootnote", "Plus Khata, Loan tracker, Multi-currency, 6 languages, Dark mode, and a few weekend-project bonuses you'll find along the way.")}
        </p>
      </Section>

      {/* ── ANIMATED FLOW — the 36-second story, no video needed ─ */}
      {/* Stripe / Linear / Notion all show "the actual flow" without
          requiring a Loom recording. We do the same with pure HTML
          + CSS: three boxes animate in sequence to show the path
          from kasserapport photo → AI merge → owner's inbox PDF.
          The infinite-loop animation is what visitors see in lieu
          of a real demo video until we record one. */}
      <Section className="bg-[#fafaf7]">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <Eyebrow>{tx_("landingFlowTag", "See it in action")}</Eyebrow>
          <Heading>{tx_("landingFlowTitle", "Snap. Merge. Done — in 36 seconds.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600 leading-relaxed">
            {tx_("landingFlowSub", "Three steps. No retyping. The owner sees the consolidated PDF before lights out.")}
          </p>
        </div>

        {/* Flow rail. Mobile = vertical stack with down-arrows, desktop = horizontal with right-arrows. */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-6 md:gap-3 items-stretch max-w-5xl mx-auto">
          {/* Step 1 — Snap */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6 text-center flowStep flowStep1">
            <div className="mx-auto w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h3l2-3h6l2 3h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <p className="text-[11px] uppercase tracking-[0.1em] font-semibold text-emerald-700 mb-1">01</p>
            <h3 className="text-[16px] font-semibold text-gray-900 mb-1.5 tracking-tight">{tx_("landingFlow1", "Snap the kasserapport")}</h3>
            <p className="text-[13.5px] text-stone-600 leading-relaxed">{tx_("landingFlow1Sub", "Front-of-house photographs the receipt strip from each terminal.")}</p>
            <p className="mt-4 text-[11px] font-mono text-stone-400 tabular-nums">~6s per terminal</p>
          </div>

          {/* Arrow */}
          <div className="hidden md:flex items-center justify-center flowArrow flowArrow1">
            <svg className="w-6 h-6 text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>
          <div className="flex md:hidden items-center justify-center -my-2">
            <svg className="w-5 h-5 text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </div>

          {/* Step 2 — AI merge */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6 text-center flowStep flowStep2">
            <div className="mx-auto w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center mb-4">
              {/* Pulse ring to suggest "thinking" */}
              <span className="absolute w-12 h-12 rounded-xl bg-emerald-400/30 flowPulse" />
              <svg className="w-6 h-6 text-emerald-700 relative" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
              </svg>
            </div>
            <p className="text-[11px] uppercase tracking-[0.1em] font-semibold text-emerald-700 mb-1">02</p>
            <h3 className="text-[16px] font-semibold text-gray-900 mb-1.5 tracking-tight">{tx_("landingFlow2", "AI merges them")}</h3>
            <p className="text-[13.5px] text-stone-600 leading-relaxed">{tx_("landingFlow2Sub", "OCR reads each strip. BonBox cross-checks the totals across all terminals.")}</p>
            <p className="mt-4 text-[11px] font-mono text-stone-400 tabular-nums">~6s</p>
          </div>

          {/* Arrow */}
          <div className="hidden md:flex items-center justify-center flowArrow flowArrow2">
            <svg className="w-6 h-6 text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>
          <div className="flex md:hidden items-center justify-center -my-2">
            <svg className="w-5 h-5 text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </div>

          {/* Step 3 — PDF in owner's inbox */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6 text-center flowStep flowStep3">
            <div className="mx-auto w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-emerald-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16v12H4z" />
                <path d="M4 6l8 7 8-7" />
              </svg>
            </div>
            <p className="text-[11px] uppercase tracking-[0.1em] font-semibold text-emerald-700 mb-1">03</p>
            <h3 className="text-[16px] font-semibold text-gray-900 mb-1.5 tracking-tight">{tx_("landingFlow3", "PDF in owner's inbox")}</h3>
            <p className="text-[13.5px] text-stone-600 leading-relaxed">{tx_("landingFlow3Sub", "Consolidated kasserapport PDF — signed, dated, ready for the revisor.")}</p>
            <p className="mt-4 text-[11px] font-mono text-stone-400 tabular-nums">before close-up</p>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] text-stone-500">
          {tx_("landingFlowFootnote", "Built for multi-terminal closes — restaurants, bars, cafés, takeaways with 2-6 registers.")}
        </p>
      </Section>

      {/* ── HOW IT WORKS — 3 steps, restrained ─────────────────── */}
      <Section id="how" className="bg-white border-y border-stone-200/70">
        <div className="max-w-2xl mb-12">
          <Eyebrow>{tx_("landingHowTag", "How it works")}</Eyebrow>
          <Heading>{tx_("landingHowTitle", "From signup to first sale in under 5 minutes.")}</Heading>
        </div>

        <div className="grid md:grid-cols-3 gap-8 md:gap-10">
          {[
            {
              n: "01",
              titleKey: "landingHow1Title",
              titleFallback: "Pick your business type",
              bodyKey: "landingHow1Body",
              bodyFallback: "Café, bar, restaurant, shop, freelancer. We pre-fill the right modules so you're not staring at a blank slate.",
            },
            {
              n: "02",
              titleKey: "landingHow2Title",
              titleFallback: "Add your first customer or sale",
              bodyKey: "landingHow2Body",
              bodyFallback: "Type a CVR — we auto-fill name + address from the public register. Or just log today's revenue and grow from there.",
            },
            {
              n: "03",
              titleKey: "landingHow3Title",
              titleFallback: "Open the Brief tomorrow morning",
              bodyKey: "landingHow3Body",
              bodyFallback: "BonBox is most useful 24 hours in. The morning Brief tells you what you'd otherwise have asked your accountant.",
            },
          ].map((s) => (
            <div key={s.n}>
              <p className="text-[13px] font-semibold text-emerald-700 tabular-nums tracking-wider mb-3">{s.n}</p>
              <h3 className="text-[18px] font-semibold text-gray-900 mb-2 tracking-tight">
                {tx_(s.titleKey, s.titleFallback)}
              </h3>
              <p className="text-[14.5px] text-stone-600 leading-relaxed">
                {tx_(s.bodyKey, s.bodyFallback)}
              </p>
            </div>
          ))}
        </div>
      </Section>


      {/* ── PRICING ────────────────────────────────────────────── */}
      <Section id="pricing" className="bg-white border-y border-stone-200/70">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <Eyebrow>{tx_("landingPricingTag", "Pricing")}</Eyebrow>
          <Heading>{tx_("landingPricingTitle", "Free to start. Pro unlocks white-label.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600">
            {tx_("landingPricingSub", "Every tier includes Bogføringsloven §7 / §12 compliance and the AI brief. No per-seat pricing.")}
          </p>
        </div>

        {/* Pricing — must match the source-of-truth in
            backend/app/services/billing.py + frontend/src/pages/SubscriptionPage.jsx:
              Starter  regular 199 kr/mo · founding 129 kr/mo
              Pro      regular 349 kr/mo · founding 249 kr/mo
            Founding rate is locked in for life for the first 100
            customers. We surface both so the page reads honest:
            big number = what you actually pay today, small struck-
            through = the rate after the founding window closes. */}
        <div className="grid md:grid-cols-3 gap-5">
          {[
            {
              name: "Free",
              price: 0,
              regularPrice: null,
              descFallback: "Try BonBox for as long as you like.",
              descKey: "landingPriceFreeDesc",
              features: [
                tx_("landingFreeF1", "POS + Sales + Expenses"),
                tx_("landingFreeF2", "AI Daily Brief (1× refresh/day)"),
                tx_("landingFreeF3", "Solo owners · 1 location"),
              ],
              cta: tx_("landingFreeCta", "Start free"),
              ctaHref: "/register",
              emphasis: false,
            },
            {
              name: "Starter",
              price: 129,           // founding rate
              regularPrice: 199,    // post-founding rate
              descFallback: "When you start sending fakturaer.",
              descKey: "landingPriceStarterDesc",
              features: [
                tx_("landingStarterF1", "Faktura + bank-match + audit log"),
                tx_("landingStarterF2", "Brand on faktura (logo + accent)"),
                tx_("landingStarterF3", "Revisor-ready CSV exports"),
              ],
              cta: tx_("landingStarterCta", "Start 14-day trial"),
              ctaHref: "/register",
              emphasis: true,
            },
            {
              name: "Pro",
              price: 249,           // founding rate (was wrongly 299)
              regularPrice: 349,    // post-founding rate
              descFallback: "Clean PDFs + multi-branch.",
              descKey: "landingPriceProDesc",
              features: [
                tx_("landingProF1", "White-label faktura PDF (no BonBox footer)"),
                tx_("landingProF2", "AI predictive staffing + multi-branch dashboard"),
                tx_("landingProF3", "Priority support"),
              ],
              cta: tx_("landingProCta", "Start 14-day trial"),
              ctaHref: "/register",
              emphasis: false,
            },
          ].map((p) => (
            <div
              key={p.name}
              className={`relative bg-white rounded-2xl p-7 ${
                p.emphasis
                  ? "border-2 border-emerald-500 shadow-[0_8px_32px_-8px_rgba(16,185,129,0.25)]"
                  : "border border-stone-200"
              }`}
            >
              {p.emphasis && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-emerald-600 text-white text-[11px] font-semibold rounded-full">
                  {tx_("landingPricingMostPopular", "Most popular")}
                </span>
              )}
              <h3 className="text-[18px] font-semibold text-gray-900">{p.name}</h3>
              <p className="text-[14px] text-stone-600 mt-1">{tx_(p.descKey, p.descFallback)}</p>
              <div className="mt-5 flex items-baseline gap-2 flex-wrap">
                <span className="text-[40px] font-semibold tracking-tight tabular-nums text-gray-900">
                  {p.price === 0 ? "0" : p.price} kr
                </span>
                <span className="text-[15px] text-stone-500">
                  {p.price === 0 ? tx_("landingForever", "forever") : "/mo"}
                </span>
                {p.regularPrice && (
                  <span className="text-[13px] text-stone-400 line-through tabular-nums">
                    {p.regularPrice} kr
                  </span>
                )}
              </div>
              {p.regularPrice && (
                <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wider text-emerald-700">
                  {tx_("landingFoundingRate", "Founding rate · first 100 customers")}
                </p>
              )}
              <Link
                to={p.ctaHref}
                className={`mt-6 block text-center px-5 py-3 rounded-md text-[14px] font-medium transition ${
                  p.emphasis
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-white border border-stone-300 text-gray-900 hover:border-stone-400"
                }`}
              >
                {p.cta}
              </Link>
              <ul className="mt-7 space-y-3 border-t border-gray-100 pt-6">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-3 text-[14px] text-gray-700">
                    <span className="mt-0.5 flex-shrink-0">{Icons.Check}</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-[13px] text-stone-500">
          {tx_("landingPricingNote", "All plans include Bogføringsloven §12 retention + audit log. Cancel anytime, no questions asked.")}
        </p>
      </Section>

      {/* ── POSITIONING — what BonBox IS / what BonBox IS NOT ─── */}
      {/* Danish café owners already know Dinero, Billy, Lightspeed.
          We don't name competitors (user moved that off the front
          page), but we DO clarify what BonBox replaces vs what it
          sits alongside. Cuts the "is this another bookkeeping app?"
          confusion in one viewport. */}
      <Section className="bg-[#fafaf7]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <Eyebrow>{tx_("landingPositioningTag", "Where it fits")}</Eyebrow>
          <Heading>{tx_("landingPositioningTitle", "Not bookkeeping. Not POS. The layer on top.")}</Heading>
          <p className="mt-5 text-[16px] text-stone-600 leading-relaxed">
            {tx_("landingPositioningSub", "BonBox is the morning-after close + AI brief that sits on top of whatever you already use. Keep your POS. Keep your bookkeeper. We do the part nobody else does.")}
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-5 max-w-4xl mx-auto">
          {/* IS column */}
          <div className="bg-white border-2 border-emerald-500 rounded-2xl p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700 mb-4">
              {tx_("landingPositioningIs", "BonBox is")}
            </p>
            <ul className="space-y-3">
              {[
                tx_("landingPosIs1", "The 90-second multi-terminal daily close"),
                tx_("landingPosIs2", "Faktura with Bogføringsloven §7 gap-less numbering"),
                tx_("landingPosIs3", "The AI morning Brief that knows your last 90 days"),
                tx_("landingPosIs4", "OCR receipts + auto-match bank deposits to invoices"),
                tx_("landingPosIs5", "Revisor-ready CSV bundle for the årsregnskab"),
              ].map((line) => (
                <li key={line} className="flex gap-3 text-[14px] text-stone-700 leading-snug">
                  <span className="mt-0.5 flex-shrink-0">{Icons.Check}</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* IS NOT column */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 mb-4">
              {tx_("landingPositioningIsNot", "BonBox is not")}
            </p>
            <ul className="space-y-3">
              {[
                tx_("landingPosNot1", "A POS terminal — keep yours, we sync from it"),
                tx_("landingPosNot2", "A registered digital bookkeeping system — pair with one for SKAT filings"),
                tx_("landingPosNot3", "A replacement for your revisor at årsregnskab time"),
                tx_("landingPosNot4", "A payment processor — MobilePay / Stripe stay yours"),
                tx_("landingPosNot5", "A spreadsheet — but it absorbs the busywork the spreadsheet was hiding"),
              ].map((line) => (
                <li key={line} className="flex gap-3 text-[14px] text-stone-600 leading-snug">
                  <span className="mt-1 flex-shrink-0 w-1.5 h-1.5 rounded-full bg-stone-300" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── FAQ — 5 honest answers above the final CTA ────────── */}
      <Section className="bg-white border-y border-stone-200/70">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <Eyebrow>{tx_("landingFaqTag", "Questions")}</Eyebrow>
          <Heading>{tx_("landingFaqTitle", "What people ask before signing up.")}</Heading>
        </div>
        <div className="max-w-3xl mx-auto divide-y divide-stone-200 border border-stone-200 rounded-2xl overflow-hidden bg-white">
          {[
            {
              q: tx_("landingFaq1Q", "Does this work with my POS?"),
              a: tx_("landingFaq1A", "BonBox doesn't replace your POS — it reads what comes out of it. Snap a photo of the kasserapport from any phone, BonBox merges them. Works regardless of brand (Lightspeed, Square, SumUp, paper, whatever)."),
            },
            {
              q: tx_("landingFaq2Q", "Do I still need an accountant?"),
              a: tx_("landingFaq2A", "Yes, for the årsregnskab and SKAT filings. BonBox handles the monthly grind (sales, faktura, bank-match, OCR receipts, Moms tracking) so your revisor only needs you once a year. Most users save ~17,500 kr/yr vs monthly revisor service."),
            },
            {
              q: tx_("landingFaq3Q", "What if the AI misreads a kasserapport?"),
              a: tx_("landingFaq3A", "Every parsed receipt is editable — the AI suggests, you confirm. Low-confidence matches go to a Review inbox instead of the books. Nothing flips to 'final' without your tap. Plus a 10-year audit log records every change."),
            },
            {
              q: tx_("landingFaq4Q", "Where does my data live?"),
              a: tx_("landingFaq4A", "EU-only. Hosted in Denmark. Encrypted at rest, audit log immutable at the DB level (Postgres rules), GDPR-first by design. You can export everything as CSV at any time and delete your account in one click."),
            },
            {
              q: tx_("landingFaq5Q", "Do I need a CVR to sign up?"),
              a: tx_("landingFaq5A", "No. Sign up with email. Add CVR later when you want CVR-verified customers + auto-fill on fakturaer. Freelancers without a CVR work fine — just toggle 'Privatperson' on each customer."),
            },
            {
              q: tx_("landingFaq6Q", "What happens after the 14-day trial?"),
              a: tx_("landingFaq6A", "You drop to Free automatically — no card, no auto-charge. Free keeps POS + Sales + Expenses + the AI Brief forever. To unlock faktura + bank-match + brand-on-PDF, upgrade to Starter (129 kr/mo founding). Pricing is shown on this page; nothing is hidden."),
            },
          ].map((item) => (
            <details key={item.q} className="group">
              <summary className="flex items-center justify-between cursor-pointer px-6 py-5 hover:bg-stone-50 transition-colors list-none">
                <span className="text-[15px] font-semibold text-gray-900 tracking-tight">{item.q}</span>
                <svg className="w-5 h-5 text-stone-400 group-open:rotate-180 transition-transform flex-shrink-0 ml-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <div className="px-6 pb-5 text-[14.5px] text-stone-600 leading-relaxed">
                {item.a}
              </div>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-[13px] text-stone-500">
          {tx_("landingFaqMore", "Different question? Email")}{" "}
          <a href="mailto:hello@bonbox.dk" className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2">hello@bonbox.dk</a>
        </p>
      </Section>

      {/* ── FINAL CTA ──────────────────────────────────────────── */}
      {/* Replaced the dark slab with a warm light panel — the
          black/green/white sandwich felt harsh. Soft emerald wash on
          warm cream reads as confident-not-aggressive, matches the
          Copenhagen restraint we set up in the hero. */}
      <Section>
        <div className="relative rounded-3xl px-8 sm:px-14 py-14 sm:py-20 text-center overflow-hidden bg-gradient-to-br from-emerald-50 via-stone-50 to-emerald-50 border border-emerald-100/80">
          {/* Subtle accent glow behind the headline */}
          <div className="absolute inset-x-0 top-0 -z-10 flex justify-center pointer-events-none">
            <div className="h-[300px] w-[640px] bg-emerald-200/40 blur-[140px] rounded-full" />
          </div>
          <h2 className="text-[28px] sm:text-[38px] lg:text-[44px] font-semibold tracking-tight text-stone-900 leading-tight">
            {tx_("landingFinalTitle", "Try BonBox for two weeks.")}
            <br />
            <span className="text-emerald-700">{tx_("landingFinalTitle2", "Decide on day 15.")}</span>
          </h2>
          <p className="mt-5 text-[16px] sm:text-[17px] text-stone-600 max-w-lg mx-auto leading-relaxed">
            {tx_("landingFinalSub", "No card. No setup call. Open the app, log today's revenue, and see your morning Brief tomorrow.")}
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/register"
              className="inline-flex items-center justify-center px-7 py-3.5 bg-emerald-600 text-white text-[15px] font-medium rounded-md hover:bg-emerald-700 transition shadow-[0_4px_14px_-4px_rgba(16,185,129,0.4)]"
            >
              {tx_("landingFinalCta", "Start free trial")}
              <svg className="w-4 h-4 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
            <a
              href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 px-6 py-3.5 bg-white border border-stone-200 rounded-md text-stone-900 hover:border-stone-300 transition text-[14px] font-medium"
            >
              {Icons.Apple}
              App Store
            </a>
          </div>
        </div>
      </Section>

      {/* ── FOOTER ─────────────────────────────────────────────── */}
      <footer className="border-t border-stone-200/70 bg-[#fafaf7]">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
            <Link to="/" className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-emerald-500 rounded-md flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </div>
              <span className="text-[15px] font-semibold tracking-tight text-gray-900">BonBox</span>
            </Link>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-stone-600">
              <Link to="/privacy" className="hover:text-gray-900 transition">{tx_("privacy", "Privacy")}</Link>
              <Link to="/terms" className="hover:text-gray-900 transition">{tx_("terms", "Terms")}</Link>
              <Link to="/cookies" className="hover:text-gray-900 transition">{tx_("cookies", "Cookies")}</Link>
              <Link to="/contact" className="hover:text-gray-900 transition">{tx_("contact", "Contact")}</Link>
            </div>

            <p className="text-[12px] text-stone-500">
              © {new Date().getFullYear()} BonBox · København
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
