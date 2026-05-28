/*
 * LandingPage — rebuilt 2026-05-25 to match the interior aesthetic.
 *
 * Design system doctrine (locked, task #164 / #167 / #169):
 *
 *   1. **Single accent: gray-900** — primary CTA, H1, surface emphasis.
 *      Emerald is reserved for "success" / money-moment moments (the
 *      checkmark icon, the "Most popular" ring on Starter, the
 *      founding-rate live count). No emerald primary buttons, no
 *      emerald headings.
 *
 *   2. **Page background: bg-gray-50** — the same neutral canvas as
 *      the interior (Layout.jsx + DashboardPage). Cards sit as
 *      bg-white on top. Severity-tinted sections use bg-gray-50 /
 *      amber-50 / red-50 per the SectionBanner recipe. No
 *      `bg-[#fafaf7]` hex.
 *
 *   3. **One radius: rounded-xl** — task #169 codemodded out
 *      rounded-2xl + rounded-3xl across pages. Landing now obeys.
 *
 *   4. **No rainbow gradients** — `from-* via-* to-*` is banned.
 *      Each section is a flat surface; emphasis comes from typography
 *      + spacing + the gray-900 ring on Most-popular, not from glow.
 *
 *   5. **Lucide outline icons via `Icon`** — same primitive as the
 *      sidebar. 1.75 stroke, 18px default. No emoji, no hand-rolled
 *      inline SVG paths.
 *
 *   6. **Inter throughout** — never Fraunces (rolled back task #111).
 *      The H1 ramps via weight (700-800) + tracking, not via family.
 *
 *   7. **Cards: bg-white + border border-gray-200 + rounded-xl +
 *      p-5 sm:p-6** — the EntryCard / Card primitive shape. Every
 *      feature card, pricing card, FAQ row, trust badge, hero
 *      surface uses this exact recipe so a visitor scrolling from
 *      landing → /dashboard feels the same product.
 *
 *   8. **Eyebrow labels** — 11px font-semibold uppercase
 *      tracking-wider text-gray-400 (matches PageHeader eyebrow +
 *      Layout.jsx sidebar group labels like "MONEY" / "STOCK").
 *
 *   9. **DK terminology lock** — MOMS uppercase, revisor in EN
 *      copy, SKAT all-caps, Skat Autopilot mixed-case. No changes
 *      here — copy is preserved from the previous iteration.
 *
 * Content preserved verbatim: every t() key + fallback string is the
 * same as the May-2026 iteration. We're only reshaping visuals.
 * Functional hooks (useFounderRateStatus, scroll handler, mobile
 * menu) are untouched.
 */

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import FounderRatePill from "../components/FounderRatePill";
import useFounderRateStatus from "../hooks/useFounderRateStatus";
import {
  Clock, Receipt, Sparkles, Landmark, Layers, Calendar, Shield,
  Check, ArrowRight, Menu, X, ChevronDown, Apple,
} from "lucide-react";

// tx(t, key, fallback) — wrapper around the i18n t() helper that
// falls back to the supplied default when the key isn't present in
// any locale. The shared t() returns the key itself on miss (so the
// idiomatic `t(k) || fb` never fires), and we don't want to change
// global i18n behaviour.
function tx(t, key, fallback) {
  const v = t(key);
  return (v && v !== key) ? v : fallback;
}

// ─── Reusable shape primitives ─────────────────────────────────────
//
// These mirror the interior's Card / PageHeader / SectionBanner
// recipes by hand (we can't import the actual primitives because
// they reach into i18n + theme contexts the landing page doesn't
// want to pay for). The CLASSES are identical strings so the visual
// language is byte-equivalent.

const CARD =
  "bg-white border border-gray-200 rounded-xl p-5 sm:p-6";

const CARD_HOVER =
  "bg-white border border-gray-200 rounded-xl p-5 sm:p-6 " +
  "transition-colors hover:border-gray-300";

// Section wrapper — consistent padding rhythm + max-width.
// Padding follows the interior's "py-10 / py-14" rhythm rather than
// the marketing-page "py-24" stretch that made the previous landing
// feel disconnected from the app.
function Section({ id, className = "", children }) {
  return (
    <section id={id} className={`relative py-14 sm:py-20 ${className}`}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}

// Eyebrow — matches PageHeader eyebrow + sidebar group labels exactly.
function Eyebrow({ children }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
      {children}
    </p>
  );
}

// Heading — H2 default. Inter weight 700, tight tracking, gray-900.
// Same ramp as the interior PageHeader H1 (28px → 38px → 46px).
function Heading({ className = "", children }) {
  return (
    <h2
      className={`text-[28px] sm:text-[34px] lg:text-[40px] leading-[1.1] tracking-[-0.025em] text-gray-900 font-bold ${className}`}
    >
      {children}
    </h2>
  );
}

// Feature card — interior EntryCard shape with Lucide icon + heading
// + one-line description. Single layout language reused everywhere.
// `icon` is passed as a rendered React element (e.g.
// <Clock size={18} className="..." />) so the eslint config's
// JSX-blind unused-vars rule doesn't fight us; same call pattern as
// the interior Card.Header primitive.
function FeatureCard({ icon, title, body }) {
  return (
    <div className={CARD_HOVER}>
      <div className="flex items-center gap-2.5 mb-2.5">
        <span className="text-gray-700 shrink-0">{icon}</span>
        <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight">
          {title}
        </h3>
      </div>
      <p className="text-[14px] text-gray-600 leading-[1.6]">{body}</p>
    </div>
  );
}

// Single Lucide icon instances reused across the feature grid + outcomes
// grid. Defined once so the JSX-blind eslint rule sees them as used,
// and so the visual weight (size 18, stroke 1.75) is consistent.
const ICON_CLOCK = <Clock size={18} strokeWidth={1.75} aria-hidden="true" />;
const ICON_RECEIPT = <Receipt size={18} strokeWidth={1.75} aria-hidden="true" />;
const ICON_SPARK = <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />;
const ICON_BANK = <Landmark size={18} strokeWidth={1.75} aria-hidden="true" />;
const ICON_LAYERS = <Layers size={18} strokeWidth={1.75} aria-hidden="true" />;
const ICON_CAL = <Calendar size={18} strokeWidth={1.75} aria-hidden="true" />;

// ─── Hero product surface ──────────────────────────────────────────
//
// Static screen-accurate render of the Daily Close card. Lives in the
// hero right column. Numbers anchored to a real-feeling Tuesday at a
// Danish café. No phone frame, no fake status bar — just the screen,
// using the same Card chrome as the actual app.
function DailyCloseHero({ tx_ }) {
  return (
    <div className="relative w-full max-w-[520px] mx-auto">
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
        {/* Header strip — eyebrow + date + business name */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {tx_("landingDailyCloseEyebrow", "Daily close")}
              </p>
              <p className="text-[16px] font-semibold text-gray-900 mt-1">
                {tx_("landingDailyCloseDate", "Tor. 22. maj")}
              </p>
            </div>
            <span className="text-[12px] text-gray-500 tabular-nums text-right">
              {tx_("landingDailyCloseBiz", "Café Bonbo · Vesterbro")}
            </span>
          </div>
        </div>

        {/* Hero number — omsætning */}
        <div className="px-5 sm:px-6 pt-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
            {tx_("landingDailyCloseRevenue", "Omsætning i dag")}
          </p>
          <p className="text-[40px] sm:text-[44px] font-bold text-gray-900 tabular-nums leading-tight tracking-tight mt-0.5">
            14.230<span className="text-gray-400 ml-1.5 text-[22px] font-semibold">kr</span>
          </p>
          <p className="text-[12.5px] text-emerald-700 mt-0.5">
            {tx_("landingDailyCloseDelta", "+12% vs. forrige tirsdag")}
          </p>
        </div>

        {/* Kontant + kort breakdown — subtle inner cards on gray-50 */}
        <div className="px-5 sm:px-6 mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
              {tx_("landingDailyCloseCash", "Kontant")}
              <Check size={13} strokeWidth={2.5} className="text-emerald-600" aria-hidden="true" />
            </div>
            <p className="text-[18px] font-semibold text-gray-900 tabular-nums mt-1">3.140 kr</p>
            <p className="text-[11px] text-emerald-700 mt-0.5">{tx_("landingDailyCloseMatched", "matchet i kassen")}</p>
          </div>
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{tx_("landingDailyCloseCard", "Kort + MobilePay")}</p>
            <p className="text-[18px] font-semibold text-gray-900 tabular-nums mt-1">11.090 kr</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{tx_("landingDailyCloseTxns", "47 transaktioner")}</p>
          </div>
        </div>

        {/* MOMS row — single line, draws the eye to the deadline.
            Severity-tinted surface recipe per doctrine: bg-amber-50
            because MOMS deadlines are time-sensitive (not gray-50 /
            calm, not red-50 / overdue — amber is the right register). */}
        <div className="mx-5 sm:mx-6 mt-5 rounded-lg bg-amber-50 border border-amber-200/80 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                {tx_("landingDailyCloseMomsLabel", "MOMS Q2 · Frist 1. juni")}
              </p>
              <p className="text-[14px] font-semibold text-amber-900 mt-0.5">
                {tx_("landingDailyCloseMomsAside", "4.230 kr. afsat automatisk")}
              </p>
            </div>
            <p className="text-[22px] font-bold tabular-nums text-amber-700 shrink-0">
              13<span className="text-[12px] font-medium ml-1">dage</span>
            </p>
          </div>
        </div>

        {/* Action — gray-900 primary CTA, matches Button.primary */}
        <div className="px-5 sm:px-6 pt-5 pb-5">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-gray-900 text-white text-[14.5px] font-semibold rounded-lg"
          >
            {tx_("landingDailyCloseCta", "Luk dagen")}
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <p className="text-[11.5px] text-gray-500 text-center mt-2.5">
            {tx_("landingDailyCloseFooterMicro", "Z-rapport · kasserapport · revisor-eksport · ét tryk")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── MOMS Countdown — killer-feature spotlight surface ─────────────
function MomsCountdownSpotlight({ tx_ }) {
  return (
    <div className="relative w-full max-w-[540px] mx-auto">
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
        {/* Eyebrow strip */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 flex items-baseline justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {tx_("landingMomsEyebrow", "MOMS Q2 · 2026")}
          </p>
          <p className="text-[12px] text-gray-500">
            {tx_("landingMomsDeadlineLabel", "Frist · 1. juni")}
          </p>
        </div>

        {/* Big number */}
        <div className="px-5 sm:px-6 pt-7 pb-4 text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 mb-1">
            {tx_("landingMomsCountdownLabel", "Dage tilbage")}
          </p>
          {/* Gray-900 — not emerald — so the number reads as fact, not
              promotion. Inter weight 800, tightest tracking we use. */}
          <p
            className="text-[120px] sm:text-[140px] leading-[0.9] tracking-[-0.06em] text-gray-900 tabular-nums"
            style={{ fontWeight: 800 }}
          >
            13
          </p>
        </div>

        {/* Progress bar — gray-200 track, gray-900 fill */}
        <div className="px-5 sm:px-6">
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-gray-900 rounded-full" style={{ width: "71%" }} />
          </div>
          <div className="flex justify-between text-[11px] text-gray-500 mt-1.5 tabular-nums">
            <span>1. apr.</span>
            <span>22. maj · i dag</span>
            <span>1. juni</span>
          </div>
        </div>

        {/* Amount + already set aside */}
        <div className="px-5 sm:px-6 mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
              {tx_("landingMomsDueLabel", "Skal betales")}
            </p>
            <p className="text-[20px] font-semibold text-gray-900 tabular-nums mt-1">4.230 kr</p>
          </div>
          <div className="rounded-lg bg-emerald-50 border border-emerald-200/70 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-emerald-700">
              {tx_("landingMomsAsideLabel", "Afsat automatisk")}
              <Check size={13} strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="text-[20px] font-semibold text-emerald-800 tabular-nums mt-1">4.230 kr</p>
          </div>
        </div>

        <div className="px-5 sm:px-6 pt-4 pb-5">
          <p className="text-[12px] text-gray-500 leading-relaxed text-center">
            {tx_("landingMomsFooterMicro", "Beregnet på faktura + kasserapport · Bogføringsloven §7 · indberetning på et tryk")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//                        Main component
// ═══════════════════════════════════════════════════════════════════
export default function LandingPage() {
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Founder-rate live count — feeds the pricing stripe under the
  // recommended-tier card. Defensive: fetch failure falls back to
  // the static "first 100 customers" copy.
  const { status: founderStatus, valid: founderStatusValid } = useFounderRateStatus();

  // Bind tx() to this component's t() so call sites stay clean.
  const tx_ = (key, fallback) => tx(t, key, fallback);

  // Thin shadow on the nav once scrolled past the hero.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinks = [
    { href: "#features", label: tx_("landingNavFeatures", "Features") },
    { href: "#how", label: tx_("landingNavHow", "How it works") },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 antialiased">
      {/* Reduce-motion-respecting subtle keyframes — same as the
          AnimationKit timings used inside the app so the marketing
          surface inherits the same micro-motion language. */}
      <style>{`
        html { scroll-behavior: smooth; }
        @keyframes flowFadeIn {
          0%, 100% { opacity: 0.55; transform: translateY(0); }
          15%, 85% { opacity: 1; transform: translateY(-2px); }
        }
        .flowStep  { animation: flowFadeIn 4.5s ease-in-out infinite; }
        .flowStep1 { animation-delay: 0s; }
        .flowStep2 { animation-delay: 1.5s; }
        .flowStep3 { animation-delay: 3s; }
        @media (prefers-reduced-motion: reduce) {
          .flowStep { animation: none; opacity: 1; }
        }
      `}</style>

      {/* ── NAV ──────────────────────────────────────────────────
          Matches the interior app-header rhythm: gray-900 wordmark,
          gray-700 links, gray-900 primary CTA, ghost sign-in. The
          safe-area inset keeps the link row clear of the notch. */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 backdrop-blur-md transition-shadow ${
          scrolled
            ? "bg-gray-50/90 border-b border-gray-200"
            : "bg-gray-50/70 border-b border-transparent"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Brand mark — emerald-600 tile is the saturated brand-green
              moment per the "BRAND GREEN" block in index.css. Wordmark
              stays gray-900 so it reads as the structural primary. */}
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
            </div>
            <span className="text-[16px] font-semibold tracking-tight text-gray-900">BonBox</span>
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
              className="hidden sm:block text-[12px] font-medium tracking-wider uppercase bg-transparent border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-900 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} aria-label={l.label}>
                  {l.short || l.code.toUpperCase()}
                </option>
              ))}
            </select>
            <Link
              to="/login"
              className="hidden sm:inline-block px-3 py-2 text-[14px] font-medium text-gray-700 hover:text-gray-900"
            >
              {tx_("landingSignIn", "Sign in")}
            </Link>
            {/* Primary CTA — emerald-600. The marketing surface's single
                primary action gets the brand-green; the rest of the top
                bar (Sign in, language switch) stays neutral. */}
            <Link
              to="/register"
              className="inline-flex items-center px-3.5 h-9 text-[14px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            >
              {tx_("landingStartFree", "Get started")}
            </Link>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="md:hidden text-gray-700 p-2 -mr-2"
              aria-label="Menu"
            >
              {menuOpen ? <X size={20} strokeWidth={2} /> : <Menu size={20} strokeWidth={2} />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="md:hidden border-t border-gray-200 bg-gray-50">
            <div className="px-4 py-3 space-y-1">
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
                <Link to="/login" onClick={() => setMenuOpen(false)} className="flex-1 text-center py-2.5 text-[14px] border border-gray-300 rounded-lg text-gray-800">
                  {tx_("landingSignIn", "Sign in")}
                </Link>
              </div>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="mt-2 w-full text-[14px] bg-white border border-gray-200 rounded-lg px-3 py-2"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────
          Calm, gray-900 H1, gray-600 subhead, single gray-900
          primary CTA + ghost secondary text link. No gradient wash
          behind the headline. The product surface (right column)
          replaces the previous emerald-glow phone mock. */}
      <Section className="pt-[calc(env(safe-area-inset-top,0px)+6rem)] sm:pt-[calc(env(safe-area-inset-top,0px)+7rem)] pb-12 sm:pb-20">
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
          <div>
            <FounderRatePill />

            <h1
              className="text-[36px] sm:text-[46px] lg:text-[56px] leading-[1.05] tracking-[-0.03em] text-gray-900 mt-4"
              style={{ fontWeight: 800 }}
            >
              {tx_("landingHeroLine1", "Luk dagen på 30 sekunder.")}
              <br />
              <span className="text-gray-400">
                {tx_("landingHeroLine2", "Så er du fri.")}
              </span>
            </h1>

            <p className="mt-5 text-[16px] sm:text-[17px] text-gray-600 leading-[1.65] max-w-[540px]">
              {tx_(
                "landingHeroSub",
                "Cafés, restaurants, bars, retail, freelancers, konsulenter. Daily close in 30 seconds, MOMS countdown, faktura with auto-match on bank CSV, receipt OCR. A 9am brief that actually helps. 129 DKK/mo founding rate.",
              )}
            </p>

            <div className="mt-7 flex flex-col sm:flex-row sm:items-center gap-3">
              {/* Hero primary CTA — emerald-600. The ONE call-to-action on
                  the page that earns the saturated brand mark. Secondary
                  "Se Daily Close" link stays gray-700 ghost. */}
              <Link
                to="/register"
                className="inline-flex items-center justify-center h-11 px-5 bg-emerald-600 text-white text-[14.5px] font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
              >
                {tx_("landingCtaPrimary", "Start gratis i 14 dage")}
                <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
              </Link>
              <a
                href="#how"
                className="inline-flex items-center justify-center h-11 px-4 text-[14px] font-medium text-gray-700 hover:text-gray-900 transition-colors"
              >
                {tx_("landingCtaSecondary", "Se Daily Close i 60 sek")}
                <ArrowRight size={14} strokeWidth={2} className="ml-1.5" aria-hidden="true" />
              </a>
            </div>

            {/* Trust strip — 4 short claims, Lucide check, gray-600 */}
            <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-gray-600">
              {[
                tx_("landingCheck1", "14 dages gratis prøve"),
                tx_("landingCheck2", "Ingen kortoplysninger"),
                tx_("landingCheckCompliance", "Bogføringsloven §7 & §10"),
                tx_("landingCheckGdpr", "GDPR · servere i EU"),
              ].map((txt) => (
                <span key={txt} className="inline-flex items-center gap-1.5">
                  <Check size={14} strokeWidth={2.5} className="text-emerald-600 shrink-0" aria-hidden="true" />
                  {txt}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-8 lg:mt-0">
            <DailyCloseHero tx_={tx_} />
          </div>
        </div>
      </Section>

      {/* ── MOMS COUNTDOWN spotlight ────────────────────────────
          White surface section on the gray-50 page bg, divided by
          a subtle top border. Mirrors how the dashboard's
          ComplianceCountdownCard sits in its zone. */}
      <Section className="bg-white border-y border-gray-200">
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-10 lg:gap-16 items-center">
          <div className="max-w-lg">
            <Eyebrow>{tx_("landingMomsTag", "Aldrig mere en MOMS-bøde")}</Eyebrow>
            <Heading>
              {tx_(
                "landingMomsHeading",
                "Din MOMS er en dato — ikke en rapport.",
              )}
            </Heading>
            <p className="mt-4 text-[15.5px] sm:text-[16px] text-gray-600 leading-[1.65]">
              {tx_(
                "landingMomsBody",
                "BonBox sætter pengene til side automatisk i takt med dine fakturaer og kasserapport. Når fristen nærmer sig, ved du præcis hvor meget der skal indberettes — og hvor meget der allerede ligger klar.",
              )}
            </p>
            <ul className="mt-5 space-y-2.5 text-[14.5px] text-gray-700">
              {[
                tx_("landingMomsBullet1", "Auto-afsætning ved hvert salg"),
                tx_("landingMomsBullet2", "Q1 / Q2 / halvår — vi følger din kadence"),
                tx_("landingMomsBullet3", "Indberetnings-PDF klar til SKAT"),
              ].map((b) => (
                <li key={b} className="flex items-start gap-2">
                  <Check size={16} strokeWidth={2.5} className="mt-0.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <MomsCountdownSpotlight tx_={tx_} />
          </div>
        </div>
      </Section>

      {/* ── BRIEF PREVIEW — "see the product" moment ─────────────
          The actual DailyBriefCard's rendering shape: 9px rounded
          icon tile (gray-100, not emerald-tinted), gray-900 H3,
          dotted insights with severity-tinted bullets — same
          treatment as the in-app card. */}
      <Section>
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-10 lg:gap-14 items-center">
          <div className="max-w-lg">
            <Eyebrow>{tx_("landingBriefPreviewTag", "See it before you sign up")}</Eyebrow>
            <Heading>
              {tx_("landingBriefPreviewTitle", "This is your 9am brief.")}
            </Heading>
            <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
              {tx_(
                "landingBriefPreviewSub",
                "Every morning at 8am Copenhagen, BonBox pulls together yesterday's revenue, this week's trend, your MOMS deadline, regulars who haven't been back, and bills due — into one card you can read in 30 seconds. Each insight is one tap to the action that matters.",
              )}
            </p>
            <p className="mt-3 text-[14px] text-gray-500 leading-relaxed">
              {tx_(
                "landingBriefPreviewShare",
                "Forward to your business partner with one tap. The shareable moment that turned BonBox from \"an app I open\" into \"the advisor that arrives.\"",
              )}
            </p>
          </div>

          {/* Static replica of DailyBriefCard — calm chrome, no glow. */}
          <div className={CARD}>
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles size={16} strokeWidth={1.75} className="text-gray-700" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[16px] font-semibold text-gray-900 tracking-tight">
                  {tx_("landingBriefPreviewGreeting", "God morgen, Manoj")}
                </h3>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  {tx_("landingBriefPreviewDate", "Tirsdag, 19. maj 2026")}
                </p>
              </div>
            </div>

            <p className="text-[15px] leading-snug text-gray-900 mb-1.5">
              {tx_(
                "landingBriefPreviewHeadline",
                "MOMS filing in 8 days — est. 96,405 DKK owed. Slightly ahead of pace this month.",
              )}
            </p>
            <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-gray-900 mb-3">
              {tx_("landingBriefPreviewHeadCta", "Review filing")}
              <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
            </span>

            <ul className="space-y-3 mt-2">
              {[
                {
                  text: tx_("landingBriefPreviewIns1", "Today is tracking +12% above your usual Tuesday — strong start."),
                  cta: null,
                  ctaKey: null,
                  tone: "info",
                },
                {
                  text: tx_("landingBriefPreviewIns2", "Recurring posts tomorrow: Husleje, Yousee, Spotify Business (19,547 DKK)."),
                  cta: tx_("landingBriefPreviewIns2Cta", "Manage recurring"),
                  tone: "warn",
                },
                {
                  text: tx_("landingBriefPreviewIns3", "3 regulars haven't been back in ~18 days (Marie, Andreas, Lukas) — a quick hello could bring them in this week."),
                  cta: tx_("landingBriefPreviewIns3Cta", "Open Khata"),
                  tone: "info",
                },
                {
                  text: tx_("landingBriefPreviewIns4", "Saturday forecast is sunny 19°C — terrace will fill. Schedule autopilot suggests 1 extra waiter."),
                  cta: tx_("landingBriefPreviewIns4Cta", "Review schedule"),
                  tone: "warn",
                },
              ].map((ins, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full mt-[8px] shrink-0 ${
                      ins.tone === "warn" ? "bg-amber-500" : "bg-gray-400"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-relaxed text-gray-700">{ins.text}</p>
                    {ins.cta && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[12px] font-medium text-gray-900">
                        {ins.cta}
                        <ArrowRight size={11} strokeWidth={2} aria-hidden="true" />
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-5 pt-3.5 border-t border-gray-100 flex items-center justify-between gap-3">
              <span className="text-[11px] uppercase tracking-wider text-gray-400">
                {tx_("landingBriefPreviewFooter", "AI Insight · BonBox")}
              </span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── TRUST + COMPLIANCE STRIP ────────────────────────────
          White surface on gray-50 page. 5 compliance badges in the
          same "left-bullet + heading + body" treatment as the
          sidebar group items. No emoji, no colored backgrounds. */}
      <Section className="bg-white border-y border-gray-200">
        <p className="text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-8">
          {tx_("landingTrustHeader", "Built for the Danish compliance reality")}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5 sm:gap-6">
          {[
            {
              title: tx_("landingTrustBogf7", "Bogføringsloven §7"),
              body: tx_("landingTrustBogf7Body", "Gap-less fakturanummer, kreditnota with the next number, locked records."),
            },
            {
              title: tx_("landingTrustBogf10", "Bogføringsloven §10"),
              body: tx_("landingTrustBogf10Body", "5-year retention. Immutable audit log on every financial mutation."),
            },
            {
              title: tx_("landingTrustGdpr", "GDPR-compliant"),
              body: tx_("landingTrustGdprBody", "EU-hosted infra. Owner-controlled data export + delete. Revisor logs in without a password share."),
            },
            {
              title: tx_("landingTrustAudit", "Audit-logged"),
              body: tx_("landingTrustAuditBody", "Every send, void, unlock, schedule-apply leaves an append-only trail you can hand to SKAT."),
            },
            {
              title: tx_("landingTrustDk", "Built in DK"),
              body: tx_("landingTrustDkBody", "Made for Danish small businesses, by people who've sat with a revisor at month-end. MOMS, lønseddel, CVR-aware. Cafés, restaurants, retail, freelancers — all welcome."),
            },
          ].map((badge) => (
            <div key={badge.title}>
              <div className="flex items-center gap-2 mb-1.5">
                <Shield size={14} strokeWidth={1.75} className="text-gray-500 shrink-0" aria-hidden="true" />
                <h3 className="text-[13px] font-semibold text-gray-900 tracking-tight">
                  {badge.title}
                </h3>
              </div>
              <p className="text-[12.5px] text-gray-600 leading-relaxed">
                {badge.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── DESIGN TARGETS + INDUSTRIES ───────────────────────────
          Three big numbers (design targets, NOT measured stats — see
          task #113), industry chips below. Same Reassure-card shape
          as SubscriptionPage so the "row of 3 numbers" reads as
          interior, not marketing. */}
      <Section>
        <p className="text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-6">
          {tx_("landingDesignedForHeader", "Designed for")}
        </p>
        <div className="grid grid-cols-3 gap-3 sm:gap-5 max-w-3xl mx-auto">
          {[
            { val: "90s", label: tx_("landingStatCloseTime", "Daily close target") },
            { val: "6+", label: tx_("landingStatTerminals", "Terminals merged at once") },
            { val: "5 min", label: tx_("landingStatSetup", "Signup to first sale") },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-white border border-gray-200 rounded-xl p-4 sm:p-5 text-center"
            >
              <p className="text-[28px] sm:text-[36px] font-bold tracking-tight text-gray-900 tabular-nums">
                {s.val}
              </p>
              <p className="text-[12px] sm:text-[13px] text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Built-for — typography-only customer types. Calm gray-500
            so it reads as "for these kinds of businesses" rather
            than "look how many of them we have". */}
        <p className="mt-8 text-center text-[13px] text-gray-500">
          <span className="font-medium text-gray-700">{tx_("landingBuiltFor", "Built for")}</span>
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndCafe", "Cafés")}
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndRestaurant", "Restaurants")}
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndBar", "Bars")}
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndShop", "Retail shops")}
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndFreelance", "Freelancers")}
          <span className="mx-2 text-gray-300">·</span>
          {tx_("landingIndKonsulent", "Konsulenter")}
        </p>
      </Section>

      {/* ── GROW WITH BONBOX — outcomes ─────────────────────────
          Interior card shape (white + border + rounded-xl). Each
          card carries a Lucide icon, heading, body, and a quiet
          "Powered by" footer in gray-500 (NOT emerald, per
          doctrine — emerald isn't a labelling tool). */}
      <Section className="bg-white border-y border-gray-200">
        <div className="max-w-2xl mb-10 sm:mb-12">
          <Eyebrow>{tx_("landingGrowTag", "Grow with BonBox")}</Eyebrow>
          <Heading>{tx_("landingGrowTitle", "Built to grow your business — not just track it.")}</Heading>
          <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
            {tx_("landingGrowSub", "Most accounting tools tell you what already happened. BonBox surfaces what to do next — every morning, with numbers from your actual yesterday.")}
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-3 sm:gap-4">
          {[
            {
              icon: ICON_SPARK,
              titleKey: "landingGrow1Title",
              titleFallback: "Higher margins",
              bodyKey: "landingGrow1Body",
              bodyFallback: "Catch what's bleeding before it costs you a month. Bar over-pour, low-margin items, waste creeping up — BonBox flags the anomalies in the morning Brief, not in next month's revisor meeting.",
              proofKey: "landingGrow1Proof",
              proofFallback: "Powered by · AI anomaly detection · Bar pour system · Expense OCR",
            },
            {
              icon: ICON_BANK,
              titleKey: "landingGrow2Title",
              titleFallback: "Steadier cash flow",
              bodyKey: "landingGrow2Body",
              bodyFallback: "Get paid faster, chase less. Upload your bank CSV — BonBox matches deposits to open fakturaer. Overdue invoices surface in the morning Brief. The MOMS countdown plus the filing-ready PDF mean you stay ahead of every SKAT deadline — you submit, we keep the calendar.",
              proofKey: "landingGrow2Proof",
              proofFallback: "Powered by · Bank CSV import · Faktura auto-match · MOMS countdown + filing PDF",
            },
            {
              icon: ICON_CLOCK,
              titleKey: "landingGrow3Title",
              titleFallback: "Smarter decisions",
              bodyKey: "landingGrow3Body",
              bodyFallback: "What today's top seller is, whether you're tracking ahead of last Wednesday, which customers pay late, when to staff up for the weekend rush. The kind of insight you'd otherwise pay a bookkeeper 2,000 kr/month to surface.",
              proofKey: "landingGrow3Proof",
              proofFallback: "Powered by · AI Daily Brief · Smart Drift · Predictive staffing",
            },
          ].map((o) => (
            <div key={o.titleKey} className={CARD_HOVER}>
              <div className="flex items-center gap-2.5 mb-2.5">
                <span className="text-gray-700 shrink-0">{o.icon}</span>
                <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight">
                  {tx_(o.titleKey, o.titleFallback)}
                </h3>
              </div>
              <p className="text-[14px] text-gray-600 leading-[1.6]">
                {tx_(o.bodyKey, o.bodyFallback)}
              </p>
              <p className="mt-4 pt-4 border-t border-gray-100 text-[10.5px] font-medium uppercase tracking-wider text-gray-400">
                {tx_(o.proofKey, o.proofFallback)}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-[14px] text-gray-600">
          {tx_("landingGrowFootnote", "Log today's revenue tonight. See yesterday's profit (and what to do today) tomorrow morning.")}
        </p>
      </Section>

      {/* ── SIX WAYS LIFE GETS EASIER ─────────────────────────────
          Feature grid using the exact same EntryCard shape as the
          interior. Lucide outline icons in gray-700 (not emerald). */}
      <Section id="features">
        <div className="max-w-2xl mb-10 sm:mb-12">
          <Eyebrow>{tx_("landingFeaturesTag", "What changes Monday morning")}</Eyebrow>
          <Heading>{tx_("landingFeaturesTitle", "Six ways life gets easier.")}</Heading>
          <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
            {tx_(
              "landingFeaturesSub",
              "BonBox isn't \"another bookkeeping app.\" It's the layer that turns 12 separate panic-moments a week — close, MOMS, faktura chase, revisor email, weekend staff — into one calm rhythm.",
            )}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {[
            {
              icon: ICON_SPARK,
              titleKey: "landingFeatBriefTitle",
              titleFallback: "Open the app at 8 and already know what to do.",
              bodyKey: "landingFeatBriefBody",
              bodyFallback: "The 8am Daily Brief lands with yesterday's revenue, MOMS countdown, overdue invoices, regulars drifting away, recurring bills due. Each insight is one tap to fix. You'll re-find the morning rhythm you lost.",
            },
            {
              icon: ICON_CLOCK,
              titleKey: "landingFeatHeroTitle",
              titleFallback: "Close the till in 30 seconds. Go home.",
              bodyKey: "landingFeatHeroBody",
              bodyFallback: "Snap the Z-report, BonBox reads the numbers. Four taps — revenue, payments, cash, review. Kasserapport is signed, locked, and ready for SKAT. Saves the 20 minutes of typing you do every night.",
            },
            {
              icon: ICON_RECEIPT,
              titleKey: "landingFeatFakturaTitle",
              titleFallback: "Get paid faster. Chase less.",
              bodyKey: "landingFeatFakturaBody",
              bodyFallback: "Send fakturaer in one click — gap-less number per Bogføringsloven §7. Bank deposits auto-match to open invoices on the next CSV. Overdue ones surface in the morning Brief before they become a phone call.",
            },
            {
              icon: ICON_BANK,
              titleKey: "landingFeatBankTitle",
              titleFallback: "Stop typing receipts into Excel.",
              bodyKey: "landingFeatBankBody",
              bodyFallback: "Snap a kvittering with your phone — receipt OCR fills the expense in 4 seconds. Upload your netbank CSV — BonBox matches incoming payments to open fakturaer with confidence tiers. The Excel sheet your bookkeeper hates? Gone.",
            },
            {
              icon: ICON_CAL,
              titleKey: "landingFeatStaffTitle",
              titleFallback: "Stop guessing on weekend staffing.",
              bodyKey: "landingFeatStaffBody",
              bodyFallback: "Schedule autopilot reads the weather forecast, your last 8 weeks of revenue, and DK labor law — proposes next week in one tap. Tweak per shift, publish. Pro-tier cafés save 5–10% on labor without overworking the crew.",
            },
            {
              icon: ICON_LAYERS,
              titleKey: "landingFeatRevisorTitle",
              titleFallback: "Your revisor stops calling.",
              bodyKey: "landingFeatRevisorBody",
              bodyFallback: "Invite your bogholder by email — they get a read-only login, every action audit-logged. No password sharing, no GDPR risk, no monthly \"send me the CSVs\" email. SAF-T + kasserapport + faktura, ready for them whenever.",
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
      <Section className="bg-white border-y border-gray-200">
        <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-12">
          <Eyebrow>{tx_("landingAllTag", "Everything in BonBox")}</Eyebrow>
          <Heading>{tx_("landingAllTitle", "One app. 30+ tools that work together.")}</Heading>
          <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
            {tx_("landingAllSub", "BonBox replaces the spreadsheet glue between your POS and your bookkeeping. Every module shares the same data, so the morning Brief actually knows what you sold yesterday.")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6 lg:gap-5">
          {[
            {
              titleKey: "landingCatMoney",
              titleFallback: "Money",
              items: [
                tx_("landingCatMoney1", "Sales tracking · Z-report capture"),
                tx_("landingCatMoney2", "Receipt OCR — snap, we fill the expense"),
                tx_("landingCatMoney3", "Recurring expenses (rent, internet, subs)"),
                tx_("landingCatMoney4", "Cash Book + cash drawer variance"),
                tx_("landingCatMoney5", "Bank reconciliation auto-match"),
                tx_("landingCatMoney6", "MOMS countdown + filing-ready PDF (you submit to SKAT)"),
              ],
            },
            {
              titleKey: "landingCatFaktura",
              titleFallback: "Faktura",
              items: [
                tx_("landingCatFaktura1", "Send fakturaer (direct email)"),
                tx_("landingCatFaktura2", "CVR-verified customers"),
                tx_("landingCatFaktura3", "Bank auto-match (±2 kr tolerance)"),
                tx_("landingCatFaktura4", "Proper kreditnota (Bogf. §7)"),
                tx_("landingCatFaktura5", "Brand + logo on PDF"),
                tx_("landingCatFaktura6", "Bilagsnummer audit trail"),
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
                tx_("landingCatStock6", "Per-channel breakdown (Wolt / Uber Eats / Foodora)"),
              ],
            },
            {
              titleKey: "landingCatStaff",
              titleFallback: "Staff",
              items: [
                tx_("landingCatStaff1", "Schedule autopilot (Pro)"),
                tx_("landingCatStaff2", "Hours logged + tip-pool"),
                tx_("landingCatStaff3", "Payroll PDF + lønseddel"),
                tx_("landingCatStaff4", "Staff portal (mobile)"),
                tx_("landingCatStaff5", "Revisor read-only login"),
                tx_("landingCatStaff6", "Multi-branch + role permissions"),
              ],
            },
            {
              titleKey: "landingCatAi",
              titleFallback: "AI",
              items: [
                tx_("landingCatAi1", "Daily Brief 2.0 (8am email + in-app)"),
                tx_("landingCatAi2", "MOMS countdown widget"),
                tx_("landingCatAi3", "Regulars-at-risk alerts"),
                tx_("landingCatAi4", "Sales↔Close variance flagging"),
                tx_("landingCatAi5", "Receipt OCR (vendor + amount + date)"),
                tx_("landingCatAi6", "Weather-aware staff predictions"),
              ],
            },
          ].map((cat) => (
            <div key={cat.titleKey}>
              {/* Category eyebrow — same shape as sidebar group labels
                  (MONEY / STOCK / STAFF in Layout.jsx). gray-400, not
                  emerald-700. */}
              <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-4">
                {tx_(cat.titleKey, cat.titleFallback)}
              </h3>
              <ul className="space-y-2.5">
                {cat.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[14px] text-gray-700 leading-snug">
                    <span className="mt-1 flex-shrink-0 w-1 h-1 rounded-full bg-gray-400" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-12 text-center text-[13px] text-gray-500">
          {tx_("landingAllFootnote", "Plus Khata, Loan tracker, Multi-currency, 6 languages, Dark mode, and a few weekend-project bonuses you'll find along the way.")}
        </p>
      </Section>

      {/* ── ANIMATED FLOW — the 36-second story ─────────────────── */}
      <Section>
        <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-12">
          <Eyebrow>{tx_("landingFlowTag", "See it in action")}</Eyebrow>
          <Heading>{tx_("landingFlowTitle", "Snap. Merge. Done — in 36 seconds.")}</Heading>
          <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
            {tx_("landingFlowSub", "Three steps. No retyping. The owner sees the consolidated PDF before lights out.")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 sm:gap-3 items-stretch max-w-5xl mx-auto">
          {[
            { n: "01", titleKey: "landingFlow1", titleFb: "Snap the kasserapport", subKey: "landingFlow1Sub", subFb: "Front-of-house photographs the receipt strip from each terminal.", micro: "~6s per terminal", stepClass: "flowStep1" },
            null,
            { n: "02", titleKey: "landingFlow2", titleFb: "AI merges them", subKey: "landingFlow2Sub", subFb: "OCR reads each strip. BonBox cross-checks the totals across all terminals.", micro: "~6s", stepClass: "flowStep2" },
            null,
            { n: "03", titleKey: "landingFlow3", titleFb: "PDF in owner's inbox", subKey: "landingFlow3Sub", subFb: "Consolidated kasserapport PDF — signed, dated, ready for the revisor.", micro: "before close-up", stepClass: "flowStep3" },
          ].map((step, idx) =>
            step === null ? (
              <div key={`arrow-${idx}`} aria-hidden="true">
                <div className="hidden md:flex items-center justify-center h-full">
                  <ArrowRight size={20} strokeWidth={1.5} className="text-gray-300" />
                </div>
                <div className="flex md:hidden items-center justify-center -my-1">
                  <ChevronDown size={18} strokeWidth={1.5} className="text-gray-300" />
                </div>
              </div>
            ) : (
              <div key={step.n} className={`${CARD} text-center flowStep ${step.stepClass}`}>
                <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">{step.n}</p>
                <h3 className="text-[15px] font-semibold text-gray-900 mb-1.5 tracking-tight">
                  {tx_(step.titleKey, step.titleFb)}
                </h3>
                <p className="text-[13.5px] text-gray-600 leading-relaxed">
                  {tx_(step.subKey, step.subFb)}
                </p>
                <p className="mt-4 text-[11px] font-medium text-gray-400 tabular-nums">{step.micro}</p>
              </div>
            ),
          )}
        </div>

        <p className="mt-8 text-center text-[13px] text-gray-500">
          {tx_("landingFlowFootnote", "Built for multi-terminal closes — restaurants, bars, cafés, takeaways with 2-6 registers.")}
        </p>
      </Section>

      {/* ── HOW IT WORKS — 3 steps ─────────────────────── */}
      <Section id="how" className="bg-white border-y border-gray-200">
        <div className="max-w-2xl mb-10">
          <Eyebrow>{tx_("landingHowTag", "How it works")}</Eyebrow>
          <Heading>{tx_("landingHowTitle", "From signup to first sale in under 5 minutes.")}</Heading>
        </div>

        <div className="grid md:grid-cols-3 gap-6 md:gap-8">
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
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 tabular-nums">{s.n}</p>
              <h3 className="text-[17px] font-semibold text-gray-900 mb-2 tracking-tight">
                {tx_(s.titleKey, s.titleFallback)}
              </h3>
              <p className="text-[14.5px] text-gray-600 leading-relaxed">
                {tx_(s.bodyKey, s.bodyFallback)}
              </p>
            </div>
          ))}
        </div>
      </Section>


      {/* ── POSITIONING — IS / IS NOT ─── */}
      <Section>
        <div className="text-center max-w-2xl mx-auto mb-10">
          <Eyebrow>{tx_("landingPositioningTag", "Where it fits")}</Eyebrow>
          <Heading>{tx_("landingPositioningTitle", "Not bookkeeping. Not POS. The layer on top.")}</Heading>
          <p className="mt-4 text-[15.5px] text-gray-600 leading-relaxed">
            {tx_("landingPositioningSub", "BonBox is the morning-after close + AI brief that sits on top of whatever you already use. Keep your POS. Keep your bookkeeper. We do the part nobody else does.")}
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-3 sm:gap-4 max-w-4xl mx-auto">
          {/* IS column — gray-900 ring marks it as the affirmative
              side without falling back to colored borders. */}
          <div className={`${CARD} ring-1 ring-gray-900/10`}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-900 mb-3">
              {tx_("landingPositioningIs", "BonBox is")}
            </p>
            <ul className="space-y-2.5">
              {[
                tx_("landingPosIs1", "The 90-second multi-terminal daily close"),
                tx_("landingPosIs2", "Faktura with Bogføringsloven §7 gap-less numbering"),
                tx_("landingPosIs3", "The AI morning Brief that knows your last 90 days"),
                tx_("landingPosIs4", "OCR receipts + bank-CSV auto-match to fakturaer"),
                tx_("landingPosIs5", "Revisor-ready CSV bundle for the årsregnskab"),
              ].map((line) => (
                <li key={line} className="flex gap-2 text-[14px] text-gray-700 leading-snug">
                  <Check size={16} strokeWidth={2.5} className="mt-0.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* IS NOT column */}
          <div className={CARD}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-3">
              {tx_("landingPositioningIsNot", "BonBox is not")}
            </p>
            <ul className="space-y-2.5">
              {[
                tx_("landingPosNot1", "A POS terminal — keep yours, we sync from it"),
                tx_("landingPosNot2", "A registered digital bookkeeping system — pair with one for SKAT filings"),
                tx_("landingPosNot3", "A replacement for your revisor at årsregnskab time"),
                tx_("landingPosNot4", "A payment processor — MobilePay / Stripe stay yours"),
                tx_("landingPosNot5", "A spreadsheet — but it absorbs the busywork the spreadsheet was hiding"),
              ].map((line) => (
                <li key={line} className="flex gap-2 text-[14px] text-gray-600 leading-snug">
                  <span className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-gray-300" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── FAQ ─────────────────────────────── */}
      <Section className="bg-white border-y border-gray-200">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <Eyebrow>{tx_("landingFaqTag", "Questions")}</Eyebrow>
          <Heading>{tx_("landingFaqTitle", "What people ask before signing up.")}</Heading>
        </div>
        <div className="max-w-3xl mx-auto divide-y divide-gray-200 border border-gray-200 rounded-xl overflow-hidden bg-white">
          {[
            { q: tx_("landingFaq1Q", "Does this work with my POS?"),
              a: tx_("landingFaq1A", "BonBox doesn't replace your POS — it reads what comes out of it. Snap a photo of the kasserapport from any phone, BonBox extracts the numbers. Works regardless of which till you use, including paper kasserapport. (We don't have brand integrations — we OCR the Z-report, so any POS that prints one works.)") },
            { q: tx_("landingFaq2Q", "Do I still need an accountant?"),
              a: tx_("landingFaq2A", "Yes, for the årsregnskab and SKAT filings. BonBox handles the monthly grind (sales, faktura, bank-match, OCR receipts, Moms tracking) so your revisor only needs you once a year. Most users save ~17,500 kr/yr vs monthly revisor service.") },
            { q: tx_("landingFaq3Q", "What if the AI misreads a kasserapport?"),
              a: tx_("landingFaq3A", "Every parsed receipt is editable — the AI suggests, you confirm. Low-confidence matches go to a Review inbox instead of the books. Nothing flips to 'final' without your tap. Plus a 10-year audit log records every change.") },
            { q: tx_("landingFaq4Q", "Where does my data live?"),
              a: tx_("landingFaq4A", "EU-only. Hosted in Denmark. Encrypted at rest, audit log immutable at the DB level (Postgres rules), GDPR-first by design. You can export everything as CSV at any time and delete your account in one click.") },
            { q: tx_("landingFaq5Q", "Do I need a CVR to sign up?"),
              a: tx_("landingFaq5A", "No. Sign up with email. Add CVR later when you want CVR-verified customers + auto-fill on fakturaer. Freelancers without a CVR work fine — just toggle 'Privatperson' on each customer.") },
            { q: tx_("landingFaq6Q", "What happens after the 14-day trial?"),
              a: tx_("landingFaq6A", "You drop to Free automatically — no card, no auto-charge. Free keeps Sales + Expenses + Daily Close + the AI Brief forever. To unlock faktura + bank-match + brand-on-PDF, upgrade to Starter (129 kr/mo founding). Pricing is shown on this page; nothing is hidden.") },
          ].map((item) => (
            <details key={item.q} className="group">
              <summary className="flex items-center justify-between cursor-pointer px-5 sm:px-6 py-4 hover:bg-gray-50 transition-colors list-none">
                <span className="text-[14.5px] font-semibold text-gray-900 tracking-tight pr-3">{item.q}</span>
                <ChevronDown size={18} strokeWidth={1.75} className="text-gray-400 group-open:rotate-180 transition-transform shrink-0" aria-hidden="true" />
              </summary>
              <div className="px-5 sm:px-6 pb-5 text-[14px] text-gray-600 leading-relaxed">
                {item.a}
              </div>
            </details>
          ))}
        </div>
        <p className="mt-6 text-center text-[13px] text-gray-500">
          {tx_("landingFaqMore", "Different question? Email")}{" "}
          <a href="mailto:hello@bonbox.dk" className="text-gray-900 hover:text-gray-700 underline underline-offset-2">hello@bonbox.dk</a>
        </p>
      </Section>

      {/* ── FINAL CTA ─────────────────── */}
      {/* Single calm card, NO rainbow wash. Gray-900 surface inversion:
          the dark slab returns as ONE intentional moment, matching the
          gray-900 primary CTA aesthetic. */}
      <Section>
        <div className="rounded-xl px-6 sm:px-10 py-12 sm:py-16 text-center bg-gray-900 text-white">
          <h2 className="text-[26px] sm:text-[34px] lg:text-[40px] font-bold tracking-tight leading-tight">
            {tx_("landingFinalTitle", "Try BonBox for two weeks.")}
            <br />
            <span className="text-gray-400">{tx_("landingFinalTitle2", "Decide on day 15.")}</span>
          </h2>
          <p className="mt-4 text-[15.5px] sm:text-[16px] text-gray-300 max-w-lg mx-auto leading-relaxed">
            {tx_("landingFinalSub", "No card. No setup call. Open the app, log today's revenue, and see your morning Brief tomorrow.")}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            {/* Final CTA on the dark slab — emerald-600 with white text so
                it stands out against the gray-900 surface. The slab itself
                stays gray-900 (intentional inversion moment from the
                landing redesign #8439566); only the pill earns brand-green. */}
            <Link
              to="/register"
              className="inline-flex items-center justify-center h-11 px-6 bg-emerald-600 text-white text-[14.5px] font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
            >
              {tx_("landingFinalCta", "Start free trial")}
              <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
            </Link>
            <a
              href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 h-11 px-5 bg-transparent border border-gray-700 rounded-lg text-white hover:bg-gray-800 transition-colors text-[14px] font-medium"
            >
              <Apple size={16} strokeWidth={1.75} aria-hidden="true" />
              App Store
            </a>
          </div>
        </div>
      </Section>

      {/* ── FOOTER ─────────────────────────────────── */}
      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-5">
            {/* Footer brand mark — emerald-600 tile matching the top-bar
                wordmark. Wordmark stays gray-900. */}
            <Link to="/" className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-emerald-600 rounded-lg flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </div>
              <span className="text-[15px] font-semibold tracking-tight text-gray-900">BonBox</span>
            </Link>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-gray-600">
              <Link to="/privacy" className="hover:text-gray-900 transition-colors">{tx_("privacy", "Privacy")}</Link>
              <Link to="/terms" className="hover:text-gray-900 transition-colors">{tx_("terms", "Terms")}</Link>
              <Link to="/cookies" className="hover:text-gray-900 transition-colors">{tx_("cookies", "Cookies")}</Link>
              <Link to="/contact" className="hover:text-gray-900 transition-colors">{tx_("contact", "Contact")}</Link>
            </div>

            <p className="text-[12px] text-gray-500">
              © {new Date().getFullYear()} BonBox · København · CVR 46417321
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
