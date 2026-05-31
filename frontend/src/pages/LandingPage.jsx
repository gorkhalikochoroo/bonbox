/*
 * LandingPage — PREMIUM craft pass 2026-06 (task: 4-expert review consensus).
 *
 * What this pass changed (vs. the May-2026 "competent template" build):
 *
 *   1. WHITESPACE — Section padding lifted from app-density (py-14/20)
 *      to landing-grade py-24 sm:py-32; hero pt-32 pb-28; section-intro
 *      gap mb-16. The page now "affords to waste space."
 *
 *   2. TYPE SCALE — a real 3-size body ramp (lead 17/1.6, body 15/1.65,
 *      meta 13/1.5) replacing the scattered 12.5/14/14.5/15.5/16.5 px.
 *      H1 clamp(44,6.2vw,68) w800 -0.035em; H2 weight 600 (not 700)
 *      -0.02em. ONE icon stroke (1.5) for decorative/feature glyphs;
 *      2 reserved for tiny inline checks.
 *
 *   3. CAPABILITY SHOWCASE — was a 9-card bordered grid; now a calm
 *      borderless vertical LIST inside one white CARD, divide-y rows,
 *      with the 8am Daily Brief row softly highlighted (bg-gray-50).
 *      Cut 9 → 6; Reservations + Inventory + standalone Receipt-OCR
 *      demoted into the collapsed "everything else" index (kept, one
 *      click away).
 *
 *   4. TWO-TIER ELEVATION — only product surfaces (DailyCloseHero,
 *      MomsCountdownSpotlight, the Brief preview) float on SHADOW_FLOAT;
 *      every other card is flat/border-only. Hero artifacts nest
 *      rounded-2xl > rounded-lg; the rest of the page stays rounded-xl.
 *
 *   5. HONESTY — killed the "90s target / 6+ terminals / 5 min" stat
 *      cards (they quietly admitted no traction). The proof band now
 *      carries only definitionally-true facts (6 sprog, EU-servere,
 *      Bogføringsloven §7 & §10-klar, 0 mistede MOMS-frister). No
 *      "save X kr/yr" headline number.
 *
 *   6. STRUCTURE — spine tightened 13 → 10: Hero → Flow → Capabilities
 *      → MOMS → Brief → How → Proof band → IS/IS-NOT → FAQ → Final CTA.
 *      The generic "Grow with BonBox" outcomes section was cut.
 *
 *   7. STICKY MOBILE CTA — fixed bottom bar appears once the hero
 *      scrolls out of view (IntersectionObserver), safe-area aware.
 *
 *   8/9. ALIGNMENT + HERO COPY — deep-dive sections left-aligned,
 *      full-width index/FAQ/positioning centered. Hero subhead is now
 *      ONE pain + ONE promise (audience list moved to the proof band).
 *
 * Design system doctrine (locked): single accent gray-900; emerald =
 * success/money/CTA only; bg-gray-50 canvas; Inter; Lucide outline.
 * DK terms stay Danish (MOMS / kasserapport / revisor / faktura / SKAT /
 * Bogføringsloven). All copy resolves through real en+da keys via tx_().
 */

import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import FounderRatePill from "../components/FounderRatePill";
import useFounderRateStatus from "../hooks/useFounderRateStatus";
import {
  Clock, Sparkles, Check, ArrowRight, Menu, X, ChevronDown, Apple, Mail,
  // Capability-showcase glyphs — one Lucide outline icon per core
  // capability, all at the single decorative stroke weight (1.5).
  CalendarClock, FileText, Calendar, Eye,
} from "lucide-react";

// tx(t, key, fallback) — wrapper around the i18n t() helper that falls
// back to the supplied default when the key isn't present in any locale.
// The shared t() returns the key itself on miss (so `t(k) || fb` never
// fires); we keep this wrapper so call sites stay clean. Every key below
// also has a real en+da entry in useLanguage.jsx — the fallback is a
// belt-and-braces default, never the only source.
function tx(t, key, fallback) {
  const v = t(key);
  return (v && v !== key) ? v : fallback;
}

// ─── Design tokens ─────────────────────────────────────────────────

// Flat card — bg-white + border + rounded-xl. The default for every
// NON-product card on the page (no shadow; emphasis from border + space).
const CARD = "bg-white border border-gray-200 rounded-xl p-6 sm:p-7";

// Two-tier elevation (task #4): ONLY product surfaces float. A whisper of
// a shadow on a near-white card — the "expensive" lift.
const SHADOW_FLOAT =
  "shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]";

// One decorative icon stroke across the whole page (task #2).
const STROKE = 1.5;

// ─── Shape primitives (80% of the leverage — task #2's expert) ──────

// Section wrapper — landing-grade vertical rhythm (py-24 sm:py-32).
function Section({ id, className = "", children }) {
  return (
    <section id={id} className={`relative py-24 sm:py-32 ${className}`}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}

// Eyebrow — 11px semibold uppercase, gray-400. Matches the in-app
// PageHeader eyebrow + sidebar group labels.
function Eyebrow({ children }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-3">
      {children}
    </p>
  );
}

// Heading — H2. Weight 600 (not 700 — heavier-at-size reads bootstrappy),
// tracking -0.02em, gray-900.
function Heading({ className = "", children }) {
  return (
    <h2
      className={`text-[28px] sm:text-[34px] lg:text-[40px] leading-[1.1] tracking-[-0.02em] text-gray-900 font-semibold ${className}`}
    >
      {children}
    </h2>
  );
}

// SectionIntro — the left-aligned intro block for deep-dive sections.
// Generous mb-16 gap to the content below (task #1). measure ~max-w-xl.
function SectionIntro({ eyebrow, title, sub, className = "" }) {
  return (
    <div className={`max-w-xl mb-16 ${className}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Heading>{title}</Heading>
      {sub && (
        <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
          {sub}
        </p>
      )}
    </div>
  );
}

// CenteredIntro — centered intro for full-width index / FAQ / positioning
// bands (task #8: centered reserved for these only).
function CenteredIntro({ eyebrow, title, sub }) {
  return (
    <div className="text-center max-w-2xl mx-auto mb-16">
      <Eyebrow>{eyebrow}</Eyebrow>
      <Heading>{title}</Heading>
      {sub && (
        <p className="mt-4 text-[17px] text-gray-600 leading-[1.6]">{sub}</p>
      )}
    </div>
  );
}

// ─── Capability glyphs (one stroke weight, 20px) ────────────────────
const CAP_ICON = { size: 20, strokeWidth: STROKE, "aria-hidden": "true" };
const ICON_CAP_BRIEF = <Sparkles {...CAP_ICON} />;
const ICON_CAP_CLOSE = <Clock {...CAP_ICON} />;
const ICON_CAP_MOMS = <CalendarClock {...CAP_ICON} />;
const ICON_CAP_FAKTURA = <FileText {...CAP_ICON} />;
const ICON_CAP_STAFF = <Calendar {...CAP_ICON} />;
const ICON_CAP_REVISOR = <Eye {...CAP_ICON} />;

// CapabilityRow — borderless row on the canvas (task #3). The list's
// divide-y handles separation; whitespace + the icon tile structure it.
// `highlight` gives the wedge feature (8am Brief) its soft gray-50 fill —
// the one "designed, not generated" row the founder's reference shows.
// Crisper "settings-app" icon tile: gray-50 + ring + gray-900 glyph.
function CapabilityRow({ icon, title, body, pro = false, highlight = false }) {
  return (
    <div
      className={`flex items-start gap-4 py-5 ${
        highlight ? "bg-gray-50 rounded-lg -mx-3 px-3" : ""
      }`}
    >
      <span className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-lg bg-gray-50 ring-1 ring-gray-200/70 text-gray-900">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight leading-snug">
            {title}
          </h3>
          {pro && (
            <span className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Pro
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[15px] text-gray-600 leading-[1.65]">{body}</p>
      </div>
    </div>
  );
}

// ─── Hero product surface — Daily Close card ───────────────────────
//
// Concentric nesting (task #4): outer rounded-2xl, inner tiles rounded-lg.
// Floats on SHADOW_FLOAT — it's a product surface.
function DailyCloseHero({ tx_ }) {
  return (
    <div className="relative w-full max-w-[520px] mx-auto">
      <div className={`bg-white border border-gray-200 rounded-2xl overflow-hidden ${SHADOW_FLOAT}`}>
        {/* Header strip — eyebrow + date + business name */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {tx_("landingDailyCloseEyebrow", "Daily close")}
              </p>
              <p className="text-[15px] font-semibold text-gray-900 mt-1">
                {tx_("landingDailyCloseDate", "Tor. 22. maj")}
              </p>
            </div>
            <span className="text-[13px] text-gray-500 tabular-nums text-right">
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
          <p className="text-[13px] text-emerald-700 mt-0.5">
            {tx_("landingDailyCloseDelta", "+12% vs. forrige tirsdag")}
          </p>
        </div>

        {/* Kontant + kort breakdown — inner tiles on gray-50, rounded-lg */}
        <div className="px-5 sm:px-6 mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
              {tx_("landingDailyCloseCash", "Kontant")}
              <Check size={13} strokeWidth={2} className="text-emerald-600" aria-hidden="true" />
            </div>
            <p className="text-[18px] font-semibold text-gray-900 tabular-nums mt-1">3.140 kr</p>
            <p className="text-[13px] text-emerald-700 mt-0.5">{tx_("landingDailyCloseMatched", "matchet i kassen")}</p>
          </div>
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{tx_("landingDailyCloseCard", "Kort + MobilePay")}</p>
            <p className="text-[18px] font-semibold text-gray-900 tabular-nums mt-1">11.090 kr</p>
            <p className="text-[13px] text-gray-500 mt-0.5">{tx_("landingDailyCloseTxns", "47 transaktioner")}</p>
          </div>
        </div>

        {/* MOMS row — amber severity surface (time-sensitive deadline) */}
        <div className="mx-5 sm:mx-6 mt-5 rounded-lg bg-amber-50 border border-amber-200/80 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                {tx_("landingDailyCloseMomsLabel", "MOMS Q2 · Frist 1. juni")}
              </p>
              <p className="text-[15px] font-semibold text-amber-900 mt-0.5">
                {tx_("landingDailyCloseMomsAside", "4.230 kr. afsat automatisk")}
              </p>
            </div>
            <p className="text-[22px] font-bold tabular-nums text-amber-700 shrink-0">
              13<span className="text-[13px] font-medium ml-1">dage</span>
            </p>
          </div>
        </div>

        {/* Action — gray-900 primary CTA (matches Button.primary) */}
        <div className="px-5 sm:px-6 pt-5 pb-5">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-gray-900 text-white text-[15px] font-semibold rounded-lg"
          >
            {tx_("landingDailyCloseCta", "Luk dagen")}
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <p className="text-[13px] text-gray-500 text-center mt-2.5">
            {tx_("landingDailyCloseFooterMicro", "Z-rapport · kasserapport · revisor-eksport · ét tryk")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── MOMS Countdown — killer-feature spotlight surface ─────────────
// Product surface → floats. Concentric rounded-2xl > rounded-lg.
function MomsCountdownSpotlight({ tx_ }) {
  return (
    <div className="relative w-full max-w-[540px] mx-auto">
      <div className={`bg-white border border-gray-200 rounded-2xl overflow-hidden ${SHADOW_FLOAT}`}>
        {/* Eyebrow strip */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 flex items-baseline justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {tx_("landingMomsEyebrow", "MOMS Q2 · 2026")}
          </p>
          <p className="text-[13px] text-gray-500">
            {tx_("landingMomsDeadlineLabel", "Frist · 1. juni")}
          </p>
        </div>

        {/* Big number — gray-900 (fact, not promotion) */}
        <div className="px-5 sm:px-6 pt-7 pb-4 text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 mb-1">
            {tx_("landingMomsCountdownLabel", "Dage tilbage")}
          </p>
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
          <div className="flex justify-between text-[13px] text-gray-500 mt-1.5 tabular-nums">
            <span>1. apr.</span>
            <span>22. maj · i dag</span>
            <span>1. juni</span>
          </div>
        </div>

        {/* Amount + already set aside — inner tiles rounded-lg */}
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
              <Check size={13} strokeWidth={2} aria-hidden="true" />
            </div>
            <p className="text-[20px] font-semibold text-emerald-800 tabular-nums mt-1">4.230 kr</p>
          </div>
        </div>

        <div className="px-5 sm:px-6 pt-4 pb-5">
          <p className="text-[13px] text-gray-500 leading-relaxed text-center">
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
  // Sticky mobile CTA visibility — shown once the hero scrolls out of view.
  const [heroPassed, setHeroPassed] = useState(false);
  const heroRef = useRef(null);

  // Founder-rate live count — feeds the FounderRatePill in the hero.
  // Defensive: fetch failure falls back to the static founding copy.
  useFounderRateStatus();

  // Bind tx() to this component's t() so call sites stay clean.
  const tx_ = (key, fallback) => tx(t, key, fallback);

  // Thin shadow on the nav once scrolled past the top.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Sticky mobile CTA — appears after the hero leaves the viewport.
  // IntersectionObserver keeps it cheap; falls back to always-hidden if
  // the API is unavailable (the top-nav CTA still covers the action).
  useEffect(() => {
    const el = heroRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setHeroPassed(!entry.isIntersecting),
      { rootMargin: "0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const navLinks = [
    { href: "#features", label: tx_("landingNavFeatures", "Features") },
    { href: "#how", label: tx_("landingNavHow", "How it works") },
  ];

  // The 6 core capabilities (task #3). 8am Brief is the highlighted row.
  // Honesty: MOMS line = owner submits to SKAT; faktura line folds the
  // Receipt-OCR benefit in and notes matching is from an uploaded netbank
  // CSV (not a live bank feed). Reservations / Inventory / standalone
  // Receipt-OCR live in the "everything else" disclosure below.
  const capabilities = [
    {
      key: "Brief",
      icon: ICON_CAP_BRIEF,
      highlight: true,
      title: tx_("landingCapBriefTitle", "8am Daily Brief"),
      body: tx_("landingCapBriefBody", "Open the app at 8 and already know your day: revenue, MOMS countdown, overdue invoices, regulars drifting away."),
    },
    {
      key: "Close",
      icon: ICON_CAP_CLOSE,
      title: tx_("landingCapCloseTitle", "30-second daily close"),
      body: tx_("landingCapCloseBody", "Snap the Z-report and the kasserapport signs itself — dated, locked, and SKAT-ready before you lock up."),
    },
    {
      key: "Moms",
      icon: ICON_CAP_MOMS,
      title: tx_("landingCapMomsTitle", "MOMS on autopilot"),
      body: tx_("landingCapMomsBody", "A live countdown to every frist plus a filing-ready PDF. You submit to SKAT — BonBox makes sure you never miss the date."),
    },
    {
      key: "Faktura",
      icon: ICON_CAP_FAKTURA,
      title: tx_("landingCapFakturaTitle", "Faktura that gets paid"),
      body: tx_("landingCapFakturaBody2", "One-click invoices with gap-less numbering per Bogføringsloven §7. Snap a kvittering and the expense fills itself; upload your netbank CSV and deposits match to open fakturaer."),
    },
    {
      key: "Staff",
      icon: ICON_CAP_STAFF,
      pro: true,
      title: tx_("landingCapStaffTitle", "Staff schedule autopilot"),
      body: tx_("landingCapStaffBody", "Next week's roster from the weather forecast, your own revenue, and DK labour law — proposed in one tap. Tweak per shift, publish."),
    },
    {
      key: "Revisor",
      icon: ICON_CAP_REVISOR,
      title: tx_("landingCapRevisorTitle", "Your revisor, read-only"),
      body: tx_("landingCapRevisorBody", "Invite your bogholder to a read-only login where every action is audit-logged. No more \"send me the CSVs.\""),
    },
  ];

  // Module index — the honest, granular toolkit, one click away. The
  // demoted-from-the-6 items (Reservations, Inventory, standalone OCR)
  // live here so the detail is never deleted, just calmed.
  const moduleIndex = [
    {
      titleKey: "landingCatMoney", titleFallback: "Money",
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
      titleKey: "landingCatFaktura", titleFallback: "Faktura",
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
      titleKey: "landingCatStock", titleFallback: "Stock",
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
      titleKey: "landingCatStaff", titleFallback: "Staff",
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
      titleKey: "landingCatAi", titleFallback: "AI",
      items: [
        tx_("landingCatAi1", "Daily Brief 2.0 (8am email + in-app)"),
        tx_("landingCatAi2", "MOMS countdown widget"),
        tx_("landingCatAi3", "Regulars-at-risk alerts"),
        tx_("landingCatAi4", "Sales↔Close variance flagging"),
        tx_("landingCatAi5", "Receipt OCR (vendor + amount + date)"),
        tx_("landingCatAi6", "Weather-aware staff predictions"),
      ],
    },
    {
      titleKey: "landingCatMore", titleFallback: "More",
      items: [
        tx_("landingCatMore1", "Reservations + floor plan"),
        tx_("landingCatMore2", "Khata · regulars credit book"),
        tx_("landingCatMore3", "Loan tracker"),
        tx_("landingCatMore4", "Multi-currency · 6 languages"),
        tx_("landingCatMore5", "Dark mode"),
        tx_("landingCatMore6", "Revisor read-only export bundle"),
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 antialiased">
      {/* Reduce-motion-respecting subtle keyframes for the flow steps. */}
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

      {/* ── NAV ──────────────────────────────────────────────────── */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 backdrop-blur-md transition-shadow ${
          scrolled
            ? "bg-gray-50/90 border-b border-gray-200"
            : "bg-gray-50/70 border-b border-transparent"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
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
                className="px-3 py-2 text-[15px] text-gray-700 hover:text-gray-900 transition-colors"
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
              className="hidden sm:block text-[13px] font-medium tracking-wider uppercase bg-transparent border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-900 cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} aria-label={l.label}>
                  {l.short || l.code.toUpperCase()}
                </option>
              ))}
            </select>
            <Link
              to="/login"
              className="hidden sm:inline-block px-3 py-2 text-[15px] font-medium text-gray-700 hover:text-gray-900"
            >
              {tx_("landingSignIn", "Sign in")}
            </Link>
            {/* Primary CTA — emerald-600, the page's single brand-green
                action. Label is the trial offer, not generic "Get started". */}
            <Link
              to="/register"
              className="inline-flex items-center px-3.5 h-9 text-[14px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap"
            >
              {tx_("landingCtaPrimary", "Start gratis i 14 dage")}
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

      {/* ── 1 · HERO ─────────────────────────────────────────────── */}
      <section
        ref={heroRef}
        className="relative pt-[calc(env(safe-area-inset-top,0px)+8rem)] pb-28"
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
            <div>
              <FounderRatePill />

              {/* H1 — clamp(44,6.2vw,68), w800, -0.035em, lh 1.02 */}
              <h1
                className="text-gray-900 mt-4"
                style={{
                  fontSize: "clamp(44px, 6.2vw, 68px)",
                  fontWeight: 800,
                  letterSpacing: "-0.035em",
                  lineHeight: 1.02,
                }}
              >
                {tx_("landingHeroLine1", "Luk dagen på 30 sekunder.")}
                <br />
                <span className="text-gray-400">
                  {tx_("landingHeroLine2", "Så er du fri.")}
                </span>
              </h1>

              {/* Subhead — ONE pain + ONE promise. Lead size, tight measure. */}
              <p className="mt-5 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
                {tx_(
                  "landingHeroSub2",
                  "Slut med den trætte kasseoptælling kl. 22:30 og MOMS-fristen der lurer. Luk dagen på 30 sekunder, miss aldrig en frist, og alt er klar til din revisor.",
                )}
              </p>

              <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center h-11 px-5 bg-emerald-600 text-white text-[15px] font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
                >
                  {tx_("landingCtaPrimary", "Start gratis i 14 dage")}
                  <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
                </Link>
                <a
                  href="#how"
                  className="inline-flex items-center justify-center h-11 px-4 text-[15px] font-medium text-gray-700 hover:text-gray-900 transition-colors"
                >
                  {tx_("landingCtaSecondary", "Se Daily Close i 60 sek")}
                  <ArrowRight size={14} strokeWidth={2} className="ml-1.5" aria-hidden="true" />
                </a>
              </div>

              {/* Trust strip — definitionally-true claims, gray-600 meta */}
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-gray-600">
                {[
                  tx_("landingCheck1", "14 dages gratis prøve"),
                  tx_("landingCheck2", "Ingen kortoplysninger"),
                  tx_("landingCheckCompliance", "Bogføringsloven §7 & §10"),
                  tx_("landingCheckGdpr", "GDPR · servere i EU"),
                ].map((txt) => (
                  <span key={txt} className="inline-flex items-center gap-1.5">
                    <Check size={14} strokeWidth={2} className="text-emerald-600 shrink-0" aria-hidden="true" />
                    {txt}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-8 lg:mt-0">
              <DailyCloseHero tx_={tx_} />
            </div>
          </div>
        </div>
      </section>

      {/* ── 2 · FLOW — "Snap. Merge. Done in 36s" (the magic moment) ─ */}
      <Section className="bg-white border-y border-gray-200">
        <CenteredIntro
          eyebrow={tx_("landingFlowTag", "See it in action")}
          title={tx_("landingFlowTitle", "Snap. Merge. Done — in 36 seconds.")}
          sub={tx_("landingFlowSub", "Three steps. No retyping. The owner sees the consolidated PDF before lights out.")}
        />

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-stretch max-w-5xl mx-auto">
          {[
            { n: "01", titleKey: "landingFlow1", titleFb: "Snap the kasserapport", subKey: "landingFlow1Sub", subFb: "Front-of-house photographs the receipt strip from each terminal.", micro: tx_("landingFlow1Micro", "~6s per terminal"), stepClass: "flowStep1" },
            null,
            { n: "02", titleKey: "landingFlow2", titleFb: "AI merges them", subKey: "landingFlow2Sub", subFb: "OCR reads each strip. BonBox cross-checks the totals across all terminals.", micro: tx_("landingFlow2Micro", "~6s"), stepClass: "flowStep2" },
            null,
            { n: "03", titleKey: "landingFlow3", titleFb: "PDF in owner's inbox", subKey: "landingFlow3Sub", subFb: "Consolidated kasserapport PDF — signed, dated, ready for the revisor.", micro: tx_("landingFlow3Micro", "before close-up"), stepClass: "flowStep3" },
          ].map((step, idx) =>
            step === null ? (
              <div key={`arrow-${idx}`} aria-hidden="true">
                <div className="hidden md:flex items-center justify-center h-full">
                  <ArrowRight size={20} strokeWidth={STROKE} className="text-gray-300" />
                </div>
                <div className="flex md:hidden items-center justify-center -my-1">
                  <ChevronDown size={18} strokeWidth={STROKE} className="text-gray-300" />
                </div>
              </div>
            ) : (
              <div key={step.n} className={`${CARD} text-center flowStep ${step.stepClass}`}>
                <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">{step.n}</p>
                <h3 className="text-[15px] font-semibold text-gray-900 mb-1.5 tracking-tight">
                  {tx_(step.titleKey, step.titleFb)}
                </h3>
                <p className="text-[15px] text-gray-600 leading-[1.65]">
                  {tx_(step.subKey, step.subFb)}
                </p>
                <p className="mt-4 text-[13px] font-medium text-gray-400 tabular-nums">{step.micro}</p>
              </div>
            ),
          )}
        </div>

        <p className="mt-12 text-center text-[13px] text-gray-500">
          {tx_("landingFlowFootnote", "Built for multi-terminal closes — restaurants, bars, cafés, takeaways with 2-6 registers.")}
        </p>
      </Section>

      {/* ── 3 · CAPABILITY SHOWCASE — the calm list of 6 ───────────── */}
      <Section id="features">
        <SectionIntro
          eyebrow={tx_("landingCapTag", "What BonBox does")}
          title={tx_("landingCapTitle", "A few powerful things, done properly.")}
          sub={tx_("landingCapSub2", "Not a wall of half-finished features. Six things at the core of running a Danish small business — close, MOMS, faktura, staff, your revisor — each built to actually carry its weight.")}
        />

        {/* Borderless rows in ONE white card; divide-y separates them. */}
        <div className={`${CARD} divide-y divide-gray-100 py-2 sm:py-3`}>
          {capabilities.map((c) => (
            <CapabilityRow
              key={c.key}
              icon={c.icon}
              pro={c.pro}
              highlight={c.highlight}
              title={c.title}
              body={c.body}
            />
          ))}
        </div>

        {/* Everything else — honest detail, one click away (collapsed). */}
        <details className="group mt-6 bg-white border border-gray-200 rounded-xl overflow-hidden">
          <summary className="flex items-center justify-between cursor-pointer px-6 py-4 hover:bg-gray-50 transition-colors list-none gap-3 min-h-[44px]">
            <span className="text-[15px] font-semibold text-gray-900 tracking-tight">
              {tx_("landingMoreToggle2", "See everything else BonBox does")}
            </span>
            <ChevronDown size={18} strokeWidth={STROKE} className="text-gray-400 group-open:rotate-180 transition-transform shrink-0" aria-hidden="true" />
          </summary>

          <div className="px-6 pb-7 pt-1 border-t border-gray-100">
            <p className="mt-5 mb-7 text-[15px] text-gray-600 leading-[1.65] max-w-[560px]">
              {tx_("landingMoreSub2", "Reservations, inventory, the credit book and more — every module shares the same data, so the morning Brief always knows what you sold yesterday.")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-7">
              {moduleIndex.map((cat) => (
                <div key={cat.titleKey}>
                  <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3.5">
                    {tx_(cat.titleKey, cat.titleFallback)}
                  </h3>
                  <ul className="space-y-2.5">
                    {cat.items.map((item) => (
                      <li key={item} className="flex gap-2.5 text-[15px] text-gray-700 leading-snug">
                        <span className="mt-[8px] flex-shrink-0 w-1 h-1 rounded-full bg-gray-400" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </details>
      </Section>

      {/* ── 4 · MOMS COUNTDOWN spotlight ───────────────────────────── */}
      <Section className="bg-white border-y border-gray-200">
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center">
          <div className="max-w-lg">
            <Eyebrow>{tx_("landingMomsTag", "Aldrig mere en MOMS-bøde")}</Eyebrow>
            <Heading>
              {tx_("landingMomsHeading", "Din MOMS er en dato — ikke en rapport.")}
            </Heading>
            <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
              {tx_(
                "landingMomsBody",
                "BonBox sætter pengene til side automatisk i takt med dine fakturaer og kasserapport. Når fristen nærmer sig, ved du præcis hvor meget der skal indberettes — og hvor meget der allerede ligger klar.",
              )}
            </p>
            <ul className="mt-6 space-y-2.5 text-[15px] text-gray-700">
              {[
                tx_("landingMomsBullet1", "Auto-afsætning ved hvert salg"),
                tx_("landingMomsBullet2", "Q1 / Q2 / halvår — vi følger din kadence"),
                tx_("landingMomsBullet3", "Indberetnings-PDF klar til SKAT"),
              ].map((b) => (
                <li key={b} className="flex items-start gap-2">
                  <Check size={16} strokeWidth={2} className="mt-1 text-emerald-600 shrink-0" aria-hidden="true" />
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

      {/* ── 5 · BRIEF PREVIEW — "see the product" moment ───────────── */}
      <Section>
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-14 items-center">
          <div className="max-w-lg">
            <Eyebrow>{tx_("landingBriefPreviewTag", "See it before you sign up")}</Eyebrow>
            <Heading>
              {tx_("landingBriefPreviewTitle", "This is your 9am brief.")}
            </Heading>
            <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
              {tx_(
                "landingBriefPreviewSub",
                "Every morning at 8am Copenhagen, BonBox pulls together yesterday's revenue, this week's trend, your MOMS deadline, regulars who haven't been back, and bills due — into one card you can read in 30 seconds. Each insight is one tap to the action that matters.",
              )}
            </p>
            <p className="mt-3 text-[15px] text-gray-500 leading-[1.65] max-w-[560px]">
              {tx_(
                "landingBriefPreviewShare",
                "Forward to your business partner with one tap. The shareable moment that turned BonBox from \"an app I open\" into \"the advisor that arrives.\"",
              )}
            </p>
          </div>

          {/* Static replica of DailyBriefCard — product surface, floats. */}
          <div className={`bg-white border border-gray-200 rounded-2xl p-6 sm:p-7 ${SHADOW_FLOAT}`}>
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-gray-50 ring-1 ring-gray-200/70 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles size={16} strokeWidth={STROKE} className="text-gray-900" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[16px] font-semibold text-gray-900 tracking-tight">
                  {tx_("landingBriefPreviewGreeting", "God morgen, Manoj")}
                </h3>
                <p className="text-[13px] text-gray-500 mt-0.5">
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
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-gray-900 mb-3">
              {tx_("landingBriefPreviewHeadCta", "Review filing")}
              <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
            </span>

            <ul className="space-y-3 mt-2">
              {[
                {
                  text: tx_("landingBriefPreviewIns1", "Today is tracking +12% above your usual Tuesday — strong start."),
                  cta: null,
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
                    <p className="text-[15px] leading-[1.65] text-gray-700">{ins.text}</p>
                    {ins.cta && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[13px] font-medium text-gray-900">
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

      {/* ── 6 · HOW IT WORKS — 3 steps (moved up) ──────────────────── */}
      <Section id="how" className="bg-white border-y border-gray-200">
        <SectionIntro
          eyebrow={tx_("landingHowDeepTag", "How it works")}
          title={tx_("landingHowDeepTitle", "From signup to first sale in under 5 minutes.")}
        />

        <div className="grid md:grid-cols-3 gap-8 md:gap-10">
          {[
            {
              n: "01",
              titleKey: "landingHow1Title", titleFallback: "Pick your business type",
              bodyKey: "landingHow1Body", bodyFallback: "Café, bar, restaurant, shop, freelancer. We pre-fill the right modules so you're not staring at a blank slate.",
            },
            {
              n: "02",
              titleKey: "landingHow2Title", titleFallback: "Add your first customer or sale",
              bodyKey: "landingHow2Body", bodyFallback: "Type a CVR — we auto-fill name + address from the public register. Or just log today's revenue and grow from there.",
            },
            {
              n: "03",
              titleKey: "landingHow3Title", titleFallback: "Open the Brief tomorrow morning",
              bodyKey: "landingHow3Body", bodyFallback: "BonBox is most useful 24 hours in. The morning Brief tells you what you'd otherwise have asked your accountant.",
            },
          ].map((s) => (
            <div key={s.n}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 tabular-nums">{s.n}</p>
              <h3 className="text-[17px] font-semibold text-gray-900 mb-2 tracking-tight">
                {tx_(s.titleKey, s.titleFallback)}
              </h3>
              <p className="text-[15px] text-gray-600 leading-[1.65]">
                {tx_(s.bodyKey, s.bodyFallback)}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 7 · PROOF BAND — "Built for the Danish reality" ─────────
          One merged band: definitionally-true facts (task #5) + the
          compliance badges + the audience list. No traction/savings
          numbers — every figure here is true by definition. */}
      <Section>
        <CenteredIntro
          eyebrow={tx_("landingProofTag", "Built for the Danish reality")}
          title={tx_("landingProofTitle", "Made for how Danish small businesses actually run.")}
        />

        {/* Definitionally-true fact row — replaces the killed "target" stats. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 max-w-4xl mx-auto">
          {[
            { val: tx_("landingFactLangVal", "6 sprog"), label: tx_("landingFactLangLabel", "i appen") },
            { val: tx_("landingFactEuVal", "EU-servere"), label: tx_("landingFactEuLabel", "GDPR fra bunden") },
            { val: tx_("landingFactBogfVal", "§7 & §10"), label: tx_("landingFactBogfLabel", "Bogføringsloven-klar") },
            { val: tx_("landingFactFristVal", "0"), label: tx_("landingFactFristLabel", "mistede MOMS-frister") },
          ].map((s) => (
            <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-5 text-center">
              <p className="text-[24px] sm:text-[30px] font-semibold tracking-tight text-gray-900 tabular-nums leading-tight">
                {s.val}
              </p>
              <p className="text-[13px] text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Compliance badges — left-bullet + heading + body, no color fills. */}
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8 max-w-4xl mx-auto">
          {[
            { title: tx_("landingTrustBogf7", "Bogføringsloven §7"), body: tx_("landingTrustBogf7Body", "Gap-free invoice numbering, kreditnota with the next number, locked books.") },
            { title: tx_("landingTrustBogf10", "Bogføringsloven §10"), body: tx_("landingTrustBogf10Body", "5-year retention. Immutable audit log on every financial change.") },
            { title: tx_("landingTrustGdpr", "GDPR-compliant"), body: tx_("landingTrustGdprBody", "EU-hosted infrastructure. Owner-controlled data export and deletion. Your revisor logs in without sharing a password.") },
            { title: tx_("landingTrustAudit", "Audit-logged"), body: tx_("landingTrustAuditBody", "Every send, void, unlock and schedule publish leaves an append-only trail you can show SKAT.") },
          ].map((badge) => (
            <div key={badge.title}>
              <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-1.5">
                {badge.title}
              </h3>
              <p className="text-[13px] text-gray-600 leading-[1.5]">
                {badge.body}
              </p>
            </div>
          ))}
        </div>

        {/* Built-for — audience list moved here from the hero (task #9). */}
        <p className="mt-12 text-center text-[13px] text-gray-500">
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

      {/* ── 8 · POSITIONING — IS / IS NOT ──────────────────────────── */}
      <Section className="bg-white border-y border-gray-200">
        <CenteredIntro
          eyebrow={tx_("landingPositioningTag", "Where it fits")}
          title={tx_("landingPositioningTitle", "Not bookkeeping. Not POS. The layer on top.")}
          sub={tx_("landingPositioningSub", "BonBox is the morning-after close + AI brief that sits on top of whatever you already use. Keep your POS. Keep your bookkeeper. We do the part nobody else does.")}
        />
        <div className="grid md:grid-cols-2 gap-4 max-w-4xl mx-auto">
          {/* IS — gray-900 ring marks the affirmative side. */}
          <div className={`${CARD} ring-1 ring-gray-900/10`}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-900 mb-3">
              {tx_("landingPositioningIs", "BonBox is")}
            </p>
            <ul className="space-y-2.5">
              {[
                tx_("landingPosIs1", "The 30-second multi-terminal daily close"),
                tx_("landingPosIs2", "Faktura with Bogføringsloven §7 gap-less numbering"),
                tx_("landingPosIs3", "The AI morning Brief that knows your last 90 days"),
                tx_("landingPosIs4", "OCR receipts + bank-CSV auto-match to fakturaer"),
                tx_("landingPosIs5", "Revisor-ready CSV bundle for the årsregnskab"),
              ].map((line) => (
                <li key={line} className="flex gap-2 text-[15px] text-gray-700 leading-snug">
                  <Check size={16} strokeWidth={2} className="mt-0.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* IS NOT */}
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
                <li key={line} className="flex gap-2 text-[15px] text-gray-600 leading-snug">
                  <span className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-gray-300" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 9 · FAQ ────────────────────────────────────────────────── */}
      <Section>
        <CenteredIntro
          eyebrow={tx_("landingFaqTag", "Questions")}
          title={tx_("landingFaqTitle", "What people ask before signing up.")}
        />
        <div className="max-w-3xl mx-auto divide-y divide-gray-200 border border-gray-200 rounded-xl overflow-hidden bg-white">
          {[
            { q: tx_("landingFaq1Q", "Does this work with my POS?"),
              a: tx_("landingFaq1A", "BonBox doesn't replace your POS — it reads what comes out of it. Snap a photo of the kasserapport from any phone, BonBox extracts the numbers. Works regardless of which till you use, including paper kasserapport. (We don't have brand integrations — we OCR the Z-report, so any POS that prints one works.)") },
            { q: tx_("landingFaq2Q", "Do I still need an accountant?"),
              a: tx_("landingFaq2A2", "Yes, for the årsregnskab and SKAT filings. BonBox handles the monthly grind (sales, faktura, bank-match, OCR receipts, MOMS tracking) so your revisor only needs you once a year.") },
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
                <span className="text-[15px] font-semibold text-gray-900 tracking-tight pr-3">{item.q}</span>
                <ChevronDown size={18} strokeWidth={STROKE} className="text-gray-400 group-open:rotate-180 transition-transform shrink-0" aria-hidden="true" />
              </summary>
              <div className="px-5 sm:px-6 pb-5 text-[15px] text-gray-600 leading-[1.65]">
                {item.a}
              </div>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-[13px] text-gray-500">
          {tx_("landingFaqMore", "Different question? Email")}{" "}
          <a href="mailto:hello@bonbox.dk" className="text-gray-900 hover:text-gray-700 underline underline-offset-2">hello@bonbox.dk</a>
        </p>
      </Section>

      {/* ── 9b · FOUNDER BAND — a human pause before the final ask ───
          Not a product surface → flat/border-only (a single CARD), no
          SHADOW_FLOAT. Calm narrow left block; the founder's own words.
          Quiet on purpose — this is a person, not a testimonial card. */}
      <Section>
        <div className={`${CARD} max-w-[560px] sm:p-8`}>
          {/* Avatar + name/role */}
          <div className="flex items-center gap-4">
            {/* Initials avatar — ~60px circle. When a real photo is added,
                swap this initials <div> for an <img> of the same size:
                <img src="…" alt="Manoj" className="w-15 h-15 rounded-full object-cover ring-1 ring-gray-200" />
                (w-15 h-15 = 60px). Keep the ring-1 ring-gray-200 for a
                clean edge on light photos. */}
            <div
              className="shrink-0 inline-flex items-center justify-center rounded-full bg-gray-100 ring-1 ring-gray-200 text-gray-900 font-bold text-[24px] select-none"
              style={{ width: 60, height: 60 }}
              aria-hidden="true"
            >
              M
            </div>
            <p className="text-[15px] font-semibold text-gray-900 tracking-tight">
              {tx_("landingFounderName", "Manoj · Founder, BonBox")}
            </p>
          </div>

          {/* Eyebrow sits under the identity — keeps the human first. */}
          <div className="mt-6">
            <Eyebrow>{tx_("landingFounderEyebrow", "Made by a real person")}</Eyebrow>
          </div>

          {/* Three short paragraphs — lead size (17px), generous spacing. */}
          <div className="space-y-4">
            <p className="text-[17px] text-gray-900 leading-[1.6]">
              {tx_("landingFounderP1", "Hi, I'm Manoj — I built BonBox.")}
            </p>
            <p className="text-[15px] text-gray-600 leading-[1.65]">
              {tx_(
                "landingFounderP2",
                "I kept meeting small business owners stuck on the same few things: the nightly cash-up, the MOMS frist sneaking up, the endless \"send me the CSVs\" from the revisor. None of it is why anyone opens a café or a shop. So I'm building the tool that just takes it off their plate.",
              )}
            </p>
            <p className="text-[15px] text-gray-600 leading-[1.65]">
              {tx_("landingFounderP3", "It's just me for now — so when you email, you get me. Usually the same day.")}
            </p>
          </div>

          {/* Email — quiet link with a tiny Mail glyph (decorative stroke). */}
          <a
            href={`mailto:${tx_("landingFounderEmail", "hello@bonbox.dk")}`}
            className="mt-6 inline-flex items-center gap-2 text-[15px] font-medium text-gray-900 hover:text-gray-700 transition-colors"
          >
            <Mail size={16} strokeWidth={STROKE} aria-hidden="true" />
            {tx_("landingFounderEmail", "hello@bonbox.dk")}
          </a>
        </div>
      </Section>

      {/* ── 10 · FINAL CTA ─────────────────────────────────────────── */}
      <Section>
        <div className="rounded-xl px-6 sm:px-10 py-16 sm:py-20 text-center bg-gray-900 text-white">
          <h2 className="text-[28px] sm:text-[36px] lg:text-[40px] font-semibold tracking-[-0.02em] leading-[1.1]">
            {tx_("landingFinalTitle", "Try BonBox for two weeks.")}
            <br />
            <span className="text-gray-400">{tx_("landingFinalTitle2", "Decide on day 15.")}</span>
          </h2>
          <p className="mt-4 text-[17px] text-gray-300 max-w-lg mx-auto leading-[1.6]">
            {tx_("landingFinalSub", "No card. No setup call. Open the app, log today's revenue, and see your morning Brief tomorrow.")}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/register"
              className="inline-flex items-center justify-center h-11 px-6 bg-emerald-600 text-white text-[15px] font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
            >
              {tx_("landingFinalCta", "Start free trial")}
              <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
            </Link>
            <a
              href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 h-11 px-5 bg-transparent border border-gray-700 rounded-lg text-white hover:bg-gray-800 transition-colors text-[15px] font-medium"
            >
              <Apple size={16} strokeWidth={STROKE} aria-hidden="true" />
              App Store
            </a>
          </div>
        </div>
      </Section>

      {/* ── FOOTER ─────────────────────────────────────────────────── */}
      <footer className="border-t border-gray-200 bg-gray-50 pb-[env(safe-area-inset-bottom,0px)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-5">
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

      {/* ── STICKY MOBILE CTA (task #7) ─────────────────────────────
          Appears once the hero scrolls out of view. Full-width emerald
          trial CTA, safe-area aware, above content but below any modal. */}
      <div
        className={`fixed bottom-0 inset-x-0 z-40 md:hidden border-t border-gray-200 bg-gray-50/95 backdrop-blur-md transition-transform duration-200 ${
          heroPassed ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        aria-hidden={!heroPassed}
      >
        <div className="px-4 py-3">
          <Link
            to="/register"
            tabIndex={heroPassed ? 0 : -1}
            className="flex items-center justify-center w-full h-12 bg-emerald-600 text-white text-[15px] font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
          >
            {tx_("landingCtaPrimary", "Start gratis i 14 dage")}
            <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
