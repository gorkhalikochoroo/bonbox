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
              <p className="text-white text-[11px] font-bold leading-tight">{t("dashboard") || "Dashboard"}</p>
              <p className="text-gray-500 text-[8px]">{t("today") || "Today"}</p>
            </div>
            <div className="w-5 h-5 bg-emerald-500/20 rounded-full" />
          </div>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            <div className="bg-gray-800/70 rounded-md p-2">
              <p className="text-gray-500 text-[7px] uppercase tracking-wider">{t("revenue") || "Revenue"}</p>
              <p className="text-white text-[13px] font-bold tabular-nums mt-0.5">24,500 kr</p>
              <p className="text-emerald-400 text-[7px] mt-0.5">+12%</p>
            </div>
            <div className="bg-gray-800/70 rounded-md p-2">
              <p className="text-gray-500 text-[7px] uppercase tracking-wider">{t("profit") || "Profit"}</p>
              <p className="text-white text-[13px] font-bold tabular-nums mt-0.5">70,097 kr</p>
              <p className="text-emerald-400 text-[7px] mt-0.5">57.8%</p>
            </div>
          </div>
          {/* sparkline */}
          <div className="bg-gray-800/70 rounded-md p-2 mb-2">
            <p className="text-gray-500 text-[7px] uppercase tracking-wider mb-1">{t("weeklySales") || "Weekly sales"}</p>
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
            <p className="text-gray-500 text-[7px] uppercase tracking-wider mb-1">{t("recentSales") || "Recent sales"}</p>
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
function Counter({ end, duration = 1400, suffix = "", prefix = "" }) {
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
    <div className="group relative bg-white rounded-2xl p-7 border border-gray-200/80 hover:border-gray-300 hover:shadow-[0_4px_24px_-8px_rgba(15,23,42,0.08)] transition-all duration-200">
      <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center mb-5 group-hover:bg-emerald-100 transition-colors">
        {icon}
      </div>
      <h3 className="text-[17px] font-semibold text-gray-900 mb-2 tracking-tight">{title}</h3>
      <p className="text-[14.5px] text-gray-600 leading-relaxed">{body}</p>
    </div>
  );
}

// Monochrome line icons — one design language, not a 14-emoji parade.
// Each is a 20×20 stroke-1.75 icon at currentColor (emerald-700 in
// the feature card slot).
const Icons = {
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
  const navLinks = [
    { href: "#features", label: t("landingNavFeatures") || "Features" },
    { href: "#compare", label: t("landingNavCompare") || "vs Dinero" },
    { href: "#pricing", label: t("landingNavPricing") || "Pricing" },
  ];

  return (
    <div className="min-h-screen bg-[#fafaf7] text-gray-900 antialiased">
      <style>{`
        @keyframes heroFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        html { scroll-behavior: smooth; }
      `}</style>

      {/* ── NAV ────────────────────────────────────────────────── */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 backdrop-blur-xl transition-shadow ${
          scrolled
            ? "bg-[#fafaf7]/90 border-b border-gray-200 shadow-[0_1px_0_rgba(15,23,42,0.04)]"
            : "bg-[#fafaf7]/70 border-b border-transparent"
        }`}
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
              className="hidden sm:block text-[13px] bg-transparent border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-300 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <Link
              to="/login"
              className="hidden sm:inline-block px-3 py-2 text-[14px] font-medium text-gray-700 hover:text-gray-900"
            >
              {t("landingSignIn") || "Sign in"}
            </Link>
            <Link
              to="/register"
              className="px-4 py-2 text-[14px] font-medium bg-gray-900 text-white rounded-md hover:bg-gray-800 transition shadow-sm"
            >
              {t("landingStartFree") || "Get started"}
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
          <div className="md:hidden border-t border-gray-200 bg-[#fafaf7]">
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
                <Link to="/login" onClick={() => setMenuOpen(false)} className="flex-1 text-center py-2.5 text-[14px] border border-gray-300 rounded-md text-gray-800">
                  {t("landingSignIn") || "Sign in"}
                </Link>
              </div>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="mt-2 w-full text-[14px] bg-white border border-gray-200 rounded-md px-3 py-2"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </nav>

      {/* ── HERO ───────────────────────────────────────────────── */}
      <Section className="pt-32 sm:pt-36 pb-12 sm:pb-16">
        {/* Single subtle glow — replaces the previous 2 blur circles
            that made the page look like a 2019 SaaS template. */}
        <div className="absolute inset-x-0 top-20 -z-10 flex justify-center pointer-events-none">
          <div className="h-[420px] w-[820px] bg-emerald-200/40 blur-[140px] rounded-full" />
        </div>

        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-12 lg:gap-20 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-emerald-200/80 rounded-full text-[12px] font-medium text-emerald-700 mb-7">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {t("landingBadge") || "For multi-terminal hospitality"}
            </div>

            <h1 className="text-[40px] sm:text-[52px] lg:text-[60px] leading-[1.04] tracking-tight font-semibold">
              {t("landingHeroLine1") || "The 90 seconds between"}{" "}
              <span className="text-emerald-600">{t("landingHeroLine2") || "last guest and lights out."}</span>
            </h1>

            <p className="mt-6 text-[17px] sm:text-[18px] text-gray-600 leading-relaxed max-w-[520px]">
              {t("landingHeroSub") || "Front-of-house snaps each kasserapport. AI merges them in 6 seconds. Owner gets the consolidated PDF before close-up is even done."}
            </p>

            <div className="mt-9 flex flex-col sm:flex-row gap-3">
              <Link
                to="/register"
                className="inline-flex items-center justify-center px-6 py-3.5 bg-gray-900 text-white text-[15px] font-medium rounded-md hover:bg-gray-800 transition shadow-sm"
              >
                {t("landingCtaPrimary") || "Get started — free"}
                <svg className="w-4 h-4 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              <a
                href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2.5 px-5 py-3.5 bg-white border border-gray-200 rounded-md hover:border-gray-300 transition text-[14px]"
              >
                <span className="text-gray-900">{Icons.Apple}</span>
                <span className="text-gray-900 font-medium">App Store</span>
              </a>
            </div>

            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-gray-600">
              {[
                t("landingCheck1") || "Free 14-day trial",
                t("landingCheck2") || "No card required",
                t("landingCheck3") || "Cancel anytime",
              ].map((txt) => (
                <span key={txt} className="flex items-center gap-1.5">
                  {Icons.Check}
                  {txt}
                </span>
              ))}
            </div>
          </div>

          {/* Phone mockup — single, centred, no decorative duplicates */}
          <div className="hidden lg:block">
            <HeroPhone />
          </div>
        </div>
      </Section>

      {/* ── PROOF NUMBERS ──────────────────────────────────────── */}
      {/* Three big numbers that earn the strip. No 4-card row of
          generic stats. Each number is a real claim made elsewhere
          on the site so there's no contradiction. */}
      <section className="py-14 border-y border-gray-200/70 bg-white">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 lg:px-8">
          <div className="grid grid-cols-3 gap-6 sm:gap-10">
            {[
              { val: 90, suffix: "s", label: t("landingStatCloseTime") || "to close a day" },
              { val: 6, suffix: "+", label: t("landingStatTerminals") || "terminals merged at once" },
              { val: 5, suffix: " min", label: t("landingStatSetup") || "from signup to first sale" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-[36px] sm:text-[44px] font-semibold tracking-tight text-gray-900">
                  <Counter end={s.val} suffix={s.suffix} />
                </p>
                <p className="text-[13px] sm:text-[14px] text-gray-500 mt-1.5">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES (6, not 14) ───────────────────────────────── */}
      <Section id="features" className="bg-[#fafaf7]">
        <div className="max-w-2xl mb-14">
          <Eyebrow>{t("landingFeaturesTag") || "Everything in one place"}</Eyebrow>
          <Heading>{t("landingFeaturesTitle") || "Built for the closer. Owned by the owner."}</Heading>
          <p className="mt-5 text-[16px] text-gray-600 leading-relaxed">
            {t("landingFeaturesSub") || "Six things BonBox does so you don't have to glue spreadsheets, POS apps, and a revisor every month."}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            {
              icon: Icons.Receipt,
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
              title={t(f.titleKey) || f.titleFallback}
              body={t(f.bodyKey) || f.bodyFallback}
            />
          ))}
        </div>
      </Section>

      {/* ── HOW IT WORKS — 3 steps, restrained ─────────────────── */}
      <Section className="bg-white border-y border-gray-200/70">
        <div className="max-w-2xl mb-12">
          <Eyebrow>{t("landingHowTag") || "How it works"}</Eyebrow>
          <Heading>{t("landingHowTitle") || "From signup to first sale in under 5 minutes."}</Heading>
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
                {t(s.titleKey) || s.titleFallback}
              </h3>
              <p className="text-[14.5px] text-gray-600 leading-relaxed">
                {t(s.bodyKey) || s.bodyFallback}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── COMPARE TO DINERO ──────────────────────────────────── */}
      <Section id="compare">
        <div className="max-w-2xl mb-12">
          <Eyebrow>{t("landingCompareTag") || "Honest comparison"}</Eyebrow>
          <Heading>{t("landingCompareTitle") || "BonBox + annual revisor beats monthly revisor."}</Heading>
          <p className="mt-5 text-[16px] text-gray-600 leading-relaxed">
            {t("landingCompareSub") || "BonBox isn't a registered digital bookkeeping system. Pair it with Dinero (or similar) for filings + a revisor for the årsregnskab. You still save ~17,500 kr/year."}
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {/* BonBox card */}
          <div className="bg-white border-2 border-emerald-500 rounded-2xl p-7 relative">
            <span className="absolute -top-3 left-6 px-2.5 py-0.5 bg-emerald-500 text-white text-[11px] font-semibold rounded-full">
              {t("landingCompareUs") || "BonBox · 129 kr/mo"}
            </span>
            <p className="text-[13px] text-gray-500 mb-5 mt-1">{t("landingCompareUsSub") || "The monthly grind that costs you most"}</p>
            <ul className="space-y-3">
              {[
                t("landingCompareUs1") || "Send fakturaer — gap-less per Bogføringsloven §7",
                t("landingCompareUs2") || "CVR-verified customers + DAWA addresses",
                t("landingCompareUs3") || "OCR receipts in 6 seconds/scan",
                t("landingCompareUs4") || "Mileage log with the fields Skattestyrelsen requires",
                t("landingCompareUs5") || "Bank import auto-matches payments to invoices",
                t("landingCompareUs6") || "AI anomaly detection on sales + wages",
              ].map((line) => (
                <li key={line} className="flex gap-3 text-[14px] text-gray-700">
                  <span className="mt-0.5 flex-shrink-0">{Icons.Check}</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Revisor card */}
          <div className="bg-white border border-gray-200 rounded-2xl p-7">
            <p className="text-[14px] font-semibold text-gray-900 mb-1">
              {t("landingCompareThem") || "Revisor + Dinero · annual only"}
            </p>
            <p className="text-[13px] text-gray-500 mb-5">{t("landingCompareThemSub") || "Legal filings — 1–4× per year"}</p>
            <ul className="space-y-3">
              {[
                t("landingCompareThem1") || "Moms-angivelse to SKAT (quarterly)",
                t("landingCompareThem2") || "Årsregnskab (annual statement)",
                t("landingCompareThem3") || "Selvangivelse review",
                t("landingCompareThem4") || "Tax-strategy consultations",
              ].map((line) => (
                <li key={line} className="flex gap-3 text-[14px] text-gray-700">
                  <span className="mt-0.5 flex-shrink-0">
                    <svg className="w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                      <circle cx="10" cy="10" r="3" />
                    </svg>
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Savings strip — replaces the "green panel" that screamed
            with a quieter, restrained one-row summary */}
        <div className="mt-6 grid grid-cols-3 divide-x divide-gray-200 bg-white border border-gray-200 rounded-2xl overflow-hidden">
          {[
            { label: t("landingCompareCostA") || "Monthly revisor", val: "~24,000 kr/yr", muted: true },
            { label: t("landingCompareCostB") || "BonBox + annual revisor", val: "~6,500 kr/yr" },
            { label: t("landingCompareCostC") || "You save", val: "~17,500 kr/yr", emphasis: true },
          ].map((c) => (
            <div key={c.label} className="px-5 py-5 text-center">
              <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5 font-medium">{c.label}</p>
              <p className={`text-[20px] sm:text-[22px] font-semibold tabular-nums ${c.emphasis ? "text-emerald-600" : c.muted ? "text-gray-400" : "text-gray-900"}`}>
                {c.val}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-5 text-[12px] text-gray-500 max-w-2xl leading-relaxed">
          {t("landingCompareDisclaimer") || "BonBox is not a registered digital bookkeeping system (registreret digitalt bogføringssystem) under Bogføringsloven 2024. Savings estimate based on a typical Danish small business paying ~2,000 kr/month for monthly revisor service vs. annual-only revisor + BonBox."}
        </p>
      </Section>

      {/* ── PRICING ────────────────────────────────────────────── */}
      <Section id="pricing" className="bg-white border-y border-gray-200/70">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <Eyebrow>{t("landingPricingTag") || "Pricing"}</Eyebrow>
          <Heading>{t("landingPricingTitle") || "Free to start. Pro unlocks white-label."}</Heading>
          <p className="mt-5 text-[16px] text-gray-600">
            {t("landingPricingSub") || "Every tier includes Bogføringsloven §7 / §12 compliance and the AI brief. No per-seat pricing."}
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          {[
            {
              name: "Free",
              priceKey: "landingPriceFree",
              priceFallback: "0 kr",
              cycle: "/mo",
              descKey: "landingPriceFreeDesc",
              descFallback: "Try BonBox for as long as you like.",
              features: [
                t("landingFreeF1") || "POS + Sales + Expenses",
                t("landingFreeF2") || "AI Daily Brief (1× refresh/day)",
                t("landingFreeF3") || "1 branch · 1 team user",
              ],
              cta: t("landingFreeCta") || "Start free",
              ctaHref: "/register",
              emphasis: false,
            },
            {
              name: "Starter",
              priceKey: "landingPriceStarter",
              priceFallback: "129 kr",
              cycle: "/mo",
              descKey: "landingPriceStarterDesc",
              descFallback: "When you start sending fakturaer.",
              features: [
                t("landingStarterF1") || "Faktura + bank-match + audit log",
                t("landingStarterF2") || "Brand on faktura (logo + accent)",
                t("landingStarterF3") || "Revisor-ready CSV exports",
              ],
              cta: t("landingStarterCta") || "Start 14-day trial",
              ctaHref: "/register",
              emphasis: true,
            },
            {
              name: "Pro",
              priceKey: "landingPricePro",
              priceFallback: "299 kr",
              cycle: "/mo",
              descKey: "landingPriceProDesc",
              descFallback: "Clean PDFs + multi-branch.",
              features: [
                t("landingProF1") || "White-label faktura PDF (no BonBox footer)",
                t("landingProF2") || "AI predictive staffing + multi-branch dashboard",
                t("landingProF3") || "Priority support",
              ],
              cta: t("landingProCta") || "Start 14-day trial",
              ctaHref: "/register",
              emphasis: false,
            },
          ].map((p) => (
            <div
              key={p.name}
              className={`relative bg-white rounded-2xl p-7 ${
                p.emphasis
                  ? "border-2 border-gray-900 shadow-[0_8px_32px_-8px_rgba(15,23,42,0.18)]"
                  : "border border-gray-200"
              }`}
            >
              {p.emphasis && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-gray-900 text-white text-[11px] font-semibold rounded-full">
                  {t("landingPricingMostPopular") || "Most popular"}
                </span>
              )}
              <h3 className="text-[18px] font-semibold text-gray-900">{p.name}</h3>
              <p className="text-[14px] text-gray-600 mt-1">{t(p.descKey) || p.descFallback}</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-[40px] font-semibold tracking-tight tabular-nums text-gray-900">
                  {t(p.priceKey) || p.priceFallback}
                </span>
                <span className="text-[15px] text-gray-500">{p.cycle}</span>
              </div>
              <Link
                to={p.ctaHref}
                className={`mt-6 block text-center px-5 py-3 rounded-md text-[14px] font-medium transition ${
                  p.emphasis
                    ? "bg-gray-900 text-white hover:bg-gray-800"
                    : "bg-white border border-gray-300 text-gray-900 hover:border-gray-400"
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

        <p className="mt-10 text-center text-[13px] text-gray-500">
          {t("landingPricingNote") || "All plans include Bogføringsloven §12 retention + audit log. Cancel anytime, no questions asked."}
        </p>
      </Section>

      {/* ── FINAL CTA ──────────────────────────────────────────── */}
      <Section>
        <div className="relative bg-gray-900 rounded-3xl px-8 sm:px-14 py-14 sm:py-20 text-center overflow-hidden">
          <div className="absolute inset-0 -z-10 flex items-center justify-center">
            <div className="w-[720px] h-[360px] bg-emerald-500/20 blur-[120px] rounded-full" />
          </div>
          <h2 className="text-[28px] sm:text-[38px] lg:text-[44px] font-semibold tracking-tight text-white leading-tight">
            {t("landingFinalTitle") || "Try BonBox for two weeks."}
            <br />
            <span className="text-emerald-400">{t("landingFinalTitle2") || "Decide on day 15."}</span>
          </h2>
          <p className="mt-5 text-[16px] sm:text-[17px] text-gray-300 max-w-lg mx-auto">
            {t("landingFinalSub") || "No card. No setup call. Open the app, log today's revenue, and see your morning Brief tomorrow."}
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/register"
              className="inline-flex items-center justify-center px-7 py-3.5 bg-emerald-500 text-white text-[15px] font-medium rounded-md hover:bg-emerald-400 transition"
            >
              {t("landingFinalCta") || "Start free trial"}
              <svg className="w-4 h-4 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
            <a
              href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 px-6 py-3.5 bg-white/10 border border-white/15 rounded-md text-white hover:bg-white/15 transition text-[14px] font-medium backdrop-blur-sm"
            >
              {Icons.Apple}
              App Store
            </a>
          </div>
        </div>
      </Section>

      {/* ── FOOTER ─────────────────────────────────────────────── */}
      <footer className="border-t border-gray-200/70 bg-[#fafaf7]">
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

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-gray-600">
              <Link to="/privacy" className="hover:text-gray-900 transition">{t("privacy") || "Privacy"}</Link>
              <Link to="/terms" className="hover:text-gray-900 transition">{t("terms") || "Terms"}</Link>
              <Link to="/cookies" className="hover:text-gray-900 transition">{t("cookies") || "Cookies"}</Link>
              <Link to="/contact" className="hover:text-gray-900 transition">{t("contact") || "Contact"}</Link>
            </div>

            <p className="text-[12px] text-gray-500">
              © {new Date().getFullYear()} BonBox · København
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
