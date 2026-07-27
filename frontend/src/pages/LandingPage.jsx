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
 *      cards (they quietly admitted no traction). No "save X kr/yr"
 *      headline number.
 *
 *      Jul 2026: "EU-servere" was NOT a definitionally-true fact, and
 *      calling it one here is how it survived review for months. The
 *      database is in eu-west-1 (Ireland) and receipt photos are sent
 *      to Anthropic in the US to be read, so "EU servers" implied an
 *      EU-only pipeline that does not exist. A reader in a Danish dev
 *      group checked the claim against the privacy policy, found they
 *      contradicted each other, and said so in public. The band now
 *      names the country instead of wearing a compliance badge.
 *      If you add a fact here, verify it against the code first.
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
import WhatDoYouPayNow from "../components/landing/WhatDoYouPayNow";
import FloorPlan from "../components/landing/FloorPlan";
import FounderRatePill from "../components/FounderRatePill";
import useFounderRateStatus from "../hooks/useFounderRateStatus";
import { TableMark } from "../config/tableArchetypes";
import {
  Clock, Check, ArrowRight, Menu, X, ChevronDown, Apple, Mail,
  Receipt, Utensils, Landmark,
  // Pillar/day glyphs — one Lucide outline icon per surface,
  // all at the single decorative stroke weight (1.5).
  CalendarClock, FileText, Calendar,
  // Proof-tile + trust glyphs.
  Users, FileCheck, Globe, Server, BookCheck,
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
                {tx_("landingDailyCloseDate", "Tir. 19. maj")}
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
          {/* Derived, not decorative. The bars are these takings in
              1.000 kr, and the "+12%" caption beside them is computed from
              the same numbers: today (14.23) against the mean of the six
              days before it (76.2/6 = 12.70 → +12.0%). The previous version
              hardcoded seven heights that showed +117% next to a caption
              claiming +12% — if you change a bar, recompute the caption. */}
          <div className="mt-3 flex items-end gap-1.5 h-12" aria-hidden="true">
            {[11.9, 13.2, 12.4, 13.9, 12.1, 12.7, 14.23].map((v, i, all) => (
              <span
                key={i}
                className={`closeBar flex-1 rounded-sm ${i === all.length - 1 ? "bg-gray-900" : "bg-gray-200"}`}
                style={{ height: `${Math.round((v / 14.23) * 100)}%`, animationDelay: `${i * 55}ms` }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[12px]">
            <span className="text-gray-400">{tx_("landingDailyCloseTrend", "Last 7 days")}</span>
            <span className="text-emerald-700 font-medium tabular-nums">{tx_("landingDailyCloseDelta", "+12% vs. forrige tirsdag")}</span>
          </div>
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
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                {tx_("landingDailyCloseMomsLabel", "MOMS 1. kvartal · frist 1. juni")}
              </p>
              <p className="text-[15px] font-semibold text-amber-900 mt-0.5">
                {tx_("landingDailyCloseMomsAside", "2.846 kr. klar til at afsætte")}
              </p>
            </div>
            <div className="relative shrink-0 h-12 w-12" aria-hidden="true">
              <svg viewBox="0 0 36 36" className="h-12 w-12 -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="stroke-amber-200" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-amber-500" strokeDasharray="97.4" strokeDashoffset="16" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                <span className="text-[15px] font-bold tabular-nums text-amber-700">13</span>
                <span className="text-[8px] font-semibold text-amber-600 uppercase tracking-wide mt-0.5">dage</span>
              </div>
            </div>
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

// ─── Showcase surface — Reservations 2D floor (the showpiece) ──────
// Static, honest illustration of the public booking floor. Renders from the
// SAME archetype geometry (config/tableArchetypes) the real owner floor +
// public map use, so a Langbord/Højbord here is byte-identical to the product.
// Status vocabulary mirrors PublicFloorMap: emerald = open, gray-900 = the
// guest's pick, muted gray = taken.
const FLOOR_TOK = {
  open:  { box: "bg-emerald-50 ring-emerald-300 text-emerald-900", chair: "bg-emerald-300/80", stool: "border-emerald-400" },
  taken: { box: "bg-gray-100 ring-gray-200 text-gray-400",         chair: "bg-gray-200",        stool: "border-gray-300" },
  pick:  { box: "bg-gray-900 ring-gray-900 text-white",            chair: "bg-gray-700",        stool: "border-gray-500" },
};
const SCHED_DAYS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
const SCHED_ROWS = [
  { who: "Mette", init: "M", bar: "bg-gray-900", shifts: { 0: "10–18", 2: "10–18", 4: "12–20" } },
  { who: "Jonas", init: "J", bar: "bg-gray-500", shifts: { 1: "16–23", 3: "16–23", 5: "16–23" } },
  { who: "Sara",  init: "S", bar: "bg-gray-400", shifts: { 4: "17–23", 5: "12–20", 6: "11–17" } },
];

function LandingScheduleMini({ tx_ }) {
  const weekend = (i) => i >= 5;
  return (
    <div className="relative w-full max-w-[520px] mx-auto">
      <div className={`bg-white border border-gray-200 rounded-2xl overflow-hidden ${SHADOW_FLOAT}`}>
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <p className="text-[15px] font-semibold text-gray-900">{tx_("landingShowSchedWeek", "Week 26 · auto-proposed")}</p>
          <span className="inline-flex items-center rounded-full bg-gray-900 text-white text-[12px] font-semibold px-2.5 py-1 tabular-nums">
            {tx_("landingShowSchedLabor", "Labour 28%")}
          </span>
        </div>
        <div className="px-5 sm:px-6 py-5">
          <div className="grid gap-1" style={{ gridTemplateColumns: "auto repeat(7, 1fr)" }}>
            <div className="border-b border-gray-100" />
            {SCHED_DAYS.map((d, i) => (
              <div key={d} className={`text-center text-[10px] font-semibold uppercase tracking-wide pb-1.5 border-b border-gray-100 ${weekend(i) ? "text-gray-300" : "text-gray-400"}`}>{d}</div>
            ))}
            {SCHED_ROWS.flatMap((r, ri) => [
              <div key={`l-${ri}`} className="flex items-center gap-2 pr-2 pt-1">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600 shrink-0">{r.init}</span>
                <span className="text-[12px] font-medium text-gray-700">{r.who}</span>
              </div>,
              ...SCHED_DAYS.map((d, i) => (
                <div key={`c-${ri}-${i}`} className={`h-9 mt-1 rounded-md flex items-center justify-center px-0.5 ${weekend(i) ? "bg-gray-100/70" : "bg-gray-50/70"}`}>
                  {r.shifts[i] && (
                    <div className="relative w-full h-7 rounded-md bg-white border border-gray-200 shadow-sm flex items-center justify-center overflow-hidden">
                      <span className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md ${r.bar}`} />
                      <span className="text-[10px] font-semibold text-gray-700 tabular-nums leading-none">{r.shifts[i]}</span>
                    </div>
                  )}
                </div>
              )),
            ])}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[12px] text-gray-400 leading-snug max-w-[280px]">
              {tx_("landingShowSchedFoot", "Proposed by revenue + weather — you review and publish.")}
            </p>
            <button type="button" tabIndex={-1} aria-hidden="true"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 text-white text-[12px] font-semibold px-3 py-1.5">
              {tx_("landingShowSchedPublish", "Publish week")}
              <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Showcase surface — Faktura (2D invoice) ───────────────────────
// Honest illustration of a faktura: sequential number, line items, MOMS,
// a paid (netbank-matched) chip, and the kreditnota path. Demo amounts add up.
const FAKTURA_LINES = [
  { d: "Catering · 40 couverts", a: "6.000,00" },
  { d: "Drikkevarer", a: "1.850,00" },
  { d: "Levering", a: "350,00" },
];
function LandingFakturaMini({ tx_ }) {
  return (
    <div className="relative w-full max-w-[520px] mx-auto">
      <div className={`bg-white border border-gray-200 rounded-2xl overflow-hidden ${SHADOW_FLOAT}`}>
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Faktura</p>
            <p className="text-[15px] font-semibold text-gray-900 mt-0.5 tabular-nums">2026-0042</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 text-[12px] font-semibold px-2.5 py-1">
            <Check size={12} strokeWidth={2.5} aria-hidden="true" />{tx_("landingShowFakturaPaid", "Paid")}
          </span>
        </div>
        <div className="px-5 sm:px-6 py-5">
          <p className="text-[12px] text-gray-500">
            {tx_("landingShowFakturaTo", "To")} <span className="text-gray-800 font-medium">Café Nord ApS · CVR 00000000 (eksempel)</span>
          </p>
          <div className="mt-4 space-y-2.5">
            {FAKTURA_LINES.map((l) => (
              <div key={l.d} className="flex items-center justify-between text-[13px]">
                <span className="text-gray-600">{l.d}</span>
                <span className="text-gray-900 tabular-nums">{l.a}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-gray-100 space-y-1.5">
            <div className="flex items-center justify-between text-[12px] text-gray-500">
              <span>{tx_("landingShowFakturaVat", "MOMS 25%")}</span>
              <span className="tabular-nums">2.050,00</span>
            </div>
            <div className="flex items-center justify-between text-[15px] font-semibold text-gray-900">
              <span>{tx_("landingShowFakturaTotal", "Total")}</span>
              <span className="tabular-nums">10.250,00 kr</span>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[12px] text-gray-400 leading-snug max-w-[280px]">
              {tx_("landingShowFakturaFoot", "Numbers run in sequence, with no gaps.")}
            </p>
            <button type="button" tabIndex={-1} aria-hidden="true"
              className="shrink-0 inline-flex items-center rounded-lg border border-gray-300 bg-white text-gray-700 text-[12px] font-semibold px-3 py-1.5">
              {tx_("landingShowFakturaCredit", "Kreditnota")}
            </button>
          </div>
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
            {tx_("landingMomsEyebrow", "MOMS 1. kvartal 2026")}
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
            <div className="h-full bg-gray-900 rounded-full" style={{ width: "79%" }} />
          </div>
          <div className="flex justify-between text-[13px] text-gray-500 mt-1.5 tabular-nums">
            <span>1. apr.</span>
            <span>19. maj · i dag</span>
            <span>1. juni</span>
          </div>
        </div>

        {/* Amount + already set aside — inner tiles rounded-lg */}
        <div className="px-5 sm:px-6 mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-gray-50 border border-gray-200/70 px-3.5 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
              {tx_("landingMomsDueLabel", "Skal betales")}
            </p>
            <p className="text-[20px] font-semibold text-gray-900 tabular-nums mt-1">148.000 kr</p>
          </div>
          <div className="rounded-lg bg-emerald-50 border border-emerald-200/70 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-emerald-700">
              {tx_("landingMomsAsideLabel", "Afsat automatisk")}
              <Check size={13} strokeWidth={2} aria-hidden="true" />
            </div>
            <p className="text-[20px] font-semibold text-emerald-800 tabular-nums mt-1">148.000 kr</p>
          </div>
        </div>

        <div className="px-5 sm:px-6 pt-4 pb-5">
          <p className="text-[13px] text-gray-500 leading-relaxed text-center">
            {tx_("landingMomsFooterMicro", "Beregnet på faktura + kasserapport · indberetning på et tryk")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Day timeline — narrative bridge (pure-CSS rail, NO faux surface) ─
//
// A single 1px gray-200 vertical rail with gray-900 dots; each node is a
// flat CARD to the right. Reuse-of-copy only (no new product chrome) so
// build + TDZ risk stay low. Time chip = tabular-nums on gray-100.
// `node.href` anchor-links to the matching pillar card in #pillars.
function DayTimeline({ nodes }) {
  return (
    <ol className="relative max-w-3xl mx-auto pl-8 sm:pl-10">
      {/* The rail — 1px gray-200, runs the full height behind the dots. */}
      <span
        className="absolute left-[7px] sm:left-[11px] top-2 bottom-2 w-px bg-gray-200"
        aria-hidden="true"
      />
      {nodes.map((node, idx) => (
        <li
          key={node.key}
          className={`relative dayNode ${idx === nodes.length - 1 ? "" : "mb-4"}`}
          style={{ animationDelay: `${idx * 80}ms` }}
        >
          {/* Dot on the rail. */}
          <span
            className="absolute -left-8 sm:-left-10 top-5 w-3.5 h-3.5 rounded-full bg-gray-900 ring-4 ring-gray-50"
            aria-hidden="true"
          />
          <a
            href={node.href}
            className="block bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 transition-colors"
          >
            <div className="flex items-center gap-3 mb-1.5">
              <span className="inline-flex items-center rounded-lg bg-gray-100 px-2 py-0.5 text-[13px] font-semibold text-gray-900 tabular-nums">
                {node.time}
              </span>
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gray-50 ring-1 ring-gray-200/70 text-gray-900 shrink-0">
                {node.icon}
              </span>
              <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight leading-snug">
                {node.title}
              </h3>
            </div>
            <p className="text-[15px] text-gray-600 leading-[1.65]">{node.body}</p>
          </a>
        </li>
      ))}
    </ol>
  );
}

// ─── Pillar card — the centrepiece grid (5 cards) ──────────────────
//
// Flat CARD (no SHADOW_FLOAT) + hover:border-gray-300. Lucide glyph in a
// rounded-xl gray-50 tile; H3 title; one-line save-promise; an optional
// gray-900-fill tier Chip; and the verbatim honesty micro-footnote.
function PillarCard({ icon, title, promise, foot, tier, tap, appLink, className = "" }) {
  return (
    <div
      className={`bg-white border border-gray-200 rounded-xl p-6 hover:border-gray-300 transition-colors flex flex-col ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex items-center justify-center size-11 rounded-xl bg-gray-50 text-gray-900 shrink-0">
          {icon}
        </span>
        {tier && (
          <span className="inline-flex items-center rounded-md bg-gray-900 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white">
            {tier}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-[17px] font-semibold text-gray-900 tracking-tight leading-snug">
        {title}
      </h3>
      <p className="mt-2 text-[15px] text-gray-600 leading-[1.65] flex-1">
        {promise}
        {tap && (
          <span className="text-gray-400">
            {" · "}
            {tap}
          </span>
        )}
      </p>
      {foot && (
        <p className="mt-3 text-[13px] text-gray-400 leading-[1.5]">{foot}</p>
      )}
      {appLink && (
        <a
          href={appLink.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-gray-900 transition-colors"
        >
          <Apple size={14} strokeWidth={STROKE} aria-hidden="true" />
          {appLink.label}
        </a>
      )}
    </div>
  );
}

// ─── Proof tile — definitionally-true fact (not measured ROI) ──────
function ProofTile({ icon, fig, label, sub }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <span className="inline-flex items-center justify-center size-9 rounded-lg bg-gray-50 ring-1 ring-gray-200/70 text-gray-900">
        {icon}
      </span>
      <p className="mt-4 text-[34px] sm:text-[36px] font-bold text-gray-900 tabular-nums leading-none tracking-tight">
        {fig}
      </p>
      <p className="mt-2 text-[13px] font-medium text-gray-700 leading-snug">{label}</p>
      <p className="mt-1.5 text-[13px] text-gray-500 leading-[1.5]">{sub}</p>
    </div>
  );
}

// ─── Pricing card — one of three tiers ─────────────────────────────
//
// `recommended` gives the Pro card its gray-900 ring + "Most popular"
// Chip (gray-900, NOT emerald — emphasis is not a success state).
// `priceNow` is the live number; `priceWas` (when founding) struck
// through in gray-400 beside it. CTA always → /register.
function PricingCard({
  name, tagline, priceNow, priceWas, perMonth, foundingLabel,
  bullets, ctaLabel, ctaStyle, recommended = false, popularLabel,
}) {
  const ctaCls =
    ctaStyle === "primary"
      ? "bg-emerald-600 text-white hover:bg-emerald-700"
      : ctaStyle === "dark"
        ? "bg-gray-900 text-white hover:bg-gray-800"
        : "bg-gray-100 text-gray-900 hover:bg-gray-200";
  return (
    <div
      className={`relative bg-white rounded-xl p-6 sm:p-7 flex flex-col ${
        recommended
          ? "ring-1 ring-gray-900 border border-gray-900"
          : "border border-gray-200"
      }`}
    >
      {recommended && popularLabel && (
        <span className="absolute -top-3 left-6 inline-flex items-center rounded-full bg-gray-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
          {popularLabel}
        </span>
      )}
      <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight">{name}</h3>
      <p className="mt-1 text-[13px] text-gray-500 leading-[1.5] min-h-[2.6em]">{tagline}</p>

      {/* Price — live founding number big; standard rate struck through. */}
      <div className="mt-5 flex items-baseline gap-2 flex-wrap">
        <span className="text-[40px] font-bold text-gray-900 tabular-nums leading-none tracking-tight">
          {priceNow}
        </span>
        <span className="text-[15px] font-medium text-gray-500">{perMonth}</span>
        {priceWas && (
          <span className="text-[15px] text-gray-400 line-through tabular-nums">
            {priceWas}
          </span>
        )}
      </div>
      {foundingLabel && (
        <p className="mt-1 text-[12px] font-medium uppercase tracking-wider text-emerald-700">
          {foundingLabel}
        </p>
      )}

      <ul className="mt-6 space-y-2 flex-1">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2 text-[14px] text-gray-700 leading-snug">
            <Check size={16} strokeWidth={2} className="mt-0.5 text-emerald-600 shrink-0" aria-hidden="true" />
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <Link
        to="/register"
        className={`mt-6 inline-flex items-center justify-center w-full h-11 px-5 text-[15px] font-semibold rounded-lg transition-colors ${ctaCls}`}
      >
        {ctaLabel}
        {ctaStyle === "primary" && (
          <ArrowRight size={16} strokeWidth={2} className="ml-2" aria-hidden="true" />
        )}
      </Link>
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

  // Founder-rate live count — feeds the FounderRatePill in the hero AND
  // the pricing table's founding-vs-standard number. Defensive: fetch
  // failure (status null / !valid / sold out) falls back to showing the
  // standard rate as the live number with no strike-through — never a
  // bait-and-switch "founding" promise we can't honour.
  const { status: founderStatus, valid: founderValid } = useFounderRateStatus();
  const foundingOpen = founderValid && founderStatus?.locked === true;

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

  // Scroll-reveal — each .reveal surface settles in once as it enters view.
  // Honours prefers-reduced-motion and a missing IntersectionObserver
  // (both just show everything immediately — never leaves a surface hidden).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".reveal"));
    if (!els.length) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("reveal-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("reveal-in"); io.unobserve(e.target); }
      }),
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const navLinks = [
    { href: "#pillars", label: tx_("landingNavFeatures", "Features") },
    { href: "#pricing", label: tx_("landingNavPricing", "Pricing") },
  ];

  // ── Day timeline (4 moments) — the narrative bridge. Reuse-of-copy
  // only; each node anchor-links into its pillar card in #pillars.
  const dayNodes = [
    {
      key: "brief",
      href: "#pillars",
      icon: <Mail size={16} strokeWidth={STROKE} aria-hidden="true" />,
      time: tx_("landingDay1Time", "08:00"),
      title: tx_("landingDay1Title", "Your brief is waiting"),
      body: tx_("landingDay1Body", "Revenue, MOMS countdown, overdue fakturaer, regulars drifting — before your first coffee."),
    },
    {
      key: "staff",
      href: "#pillars",
      icon: <Calendar size={16} strokeWidth={STROKE} aria-hidden="true" />,
      time: tx_("landingDay2Time", "11:30"),
      title: tx_("landingDay2Title", "Next week's Vagtplan, proposed"),
      body: tx_("landingDay2Body", "One tap proposes a roster sized to your revenue and the weather — at your target labour %."),
    },
    {
      key: "reservations",
      href: "#pillars",
      icon: <Utensils size={16} strokeWidth={STROKE} aria-hidden="true" />,
      time: tx_("landingDay3Time", "18:00"),
      title: tx_("landingDay3Title", "Guests book their own table"),
      body: tx_("landingDay3Body", "Guests pick their own table on your floor plan."),
    },
    {
      key: "close",
      href: "#pillars",
      icon: <Receipt size={16} strokeWidth={STROKE} aria-hidden="true" />,
      time: tx_("landingDay4Time", "22:30"),
      title: tx_("landingDay4Title", "Close the day in 30 seconds"),
      body: tx_("landingDay4Body", "Photograph the Z-report. While you cash up, a dated and locked kasserapport is made ready for your revisor."),
    },
  ];

  // ── Pillars grid (5 cards). The Dagsafslutning card spans 2 cols.
  // Honesty micro-footnotes verbatim; tier Chips (gray-900) where real.
  const pillars = [
    {
      key: "close",
      span: true,
      icon: <Receipt size={22} strokeWidth={STROKE} aria-hidden="true" />,
      title: tx_("landingPillarCloseTitle", "Daily close · kasserapport"),
      promise: tx_("landingPillarClosePromise", "Photograph the Z-report. The numbers are read out, you check them, and the day locks with a dated kasserapport your revisor can use as it is."),
      foot: tx_("landingPillarCloseFoot", "You scan the Z-report — BonBox isn't the POS."),
      tier: null,
    },
    {
      key: "staff",
      icon: <Users size={22} strokeWidth={STROKE} aria-hidden="true" />,
      title: tx_("landingPillarStaffTitle", "Vagtplan autopilot"),
      promise: tx_("landingPillarStaffPromise", "Next week's vagtplan proposed in one tap. It weighs your revenue, the weather and Danish labour law, and holds your target labour percentage."),
      foot: tx_("landingPillarStaffFoot", "Proposes — never auto-publishes. You publish."),
      tier: tx_("pricingTierPro", "Pro"),
      appLink: {
        href: "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793",
        label: tx_("landingStaffAppLink", "Your team gets their own free app"),
      },
    },
    {
      key: "reservations",
      icon: <Utensils size={22} strokeWidth={STROKE} aria-hidden="true" />,
      title: tx_("landingPillarReservationsTitle", "Reservationer"),
      promise: tx_("landingPillarReservationsPromise", "A public booking page on a floor plan of your own room. The same table cannot be booked twice, even when two guests tap at once."),
      foot: tx_("landingPillarReservationsFoot", "Free taste: 20 bookings/mo, 3 tables."),
      tier: null,
    },
    {
      key: "faktura",
      icon: <FileText size={22} strokeWidth={STROKE} aria-hidden="true" />,
      title: tx_("landingPillarFakturaTitle", "Faktura"),
      promise: tx_("landingPillarFakturaPromise", "One-click fakturaer with numbering that runs without gaps — and a proper kreditnota when you void one. Upload your netbank CSV and deposits self-match."),
      foot: tx_("landingPillarFakturaFoot", "Matching reads your uploaded netbank CSV — no live bank feed."),
      tier: tx_("pricingTierStarter", "Starter"),
    },
    {
      key: "skat",
      icon: <Landmark size={22} strokeWidth={STROKE} aria-hidden="true" />,
      title: tx_("landingPillarSkatTitle", "Skat Autopilot · MOMS"),
      promise: tx_("landingPillarSkatPromise", "A live countdown to every MOMS deadline and the amount to set aside each week. When the deadline nears, the filing is ready as a PDF, and you send it to SKAT yourself."),
      foot: tx_("landingPillarSkatFoot", "BonBox doesn't file to SKAT — you submit; the amount is an estimate."),
      tier: null,
    },
  ];

  // ── Proof tiles (4 facts). Definitionally true — NOT measured ROI.
  const proofTiles = [
    {
      key: "wages",
      icon: <Users size={18} strokeWidth={STROKE} aria-hidden="true" />,
      fig: tx_("landingSaveWagesFig", "30–40%"),
      label: tx_("landingSaveWagesLabel", "of café revenue is wages"),
      sub: tx_("landingSaveWagesSub", "Autopilot sizes the roster to demand at your target labour %."),
    },
    {
      key: "frist",
      icon: <CalendarClock size={18} strokeWidth={STROKE} aria-hidden="true" />,
      fig: tx_("landingSaveFristFig", "1"),
      label: tx_("landingSaveFristLabel", "missed MOMS frist = a fine"),
      sub: tx_("landingSaveFristSub", "A live countdown + weekly set-aside rate so the date never surprises you."),
    },
    {
      key: "close",
      icon: <Clock size={18} strokeWidth={STROKE} aria-hidden="true" />,
      fig: tx_("landingSaveCloseFig", "~30 sec"),
      label: tx_("landingSaveCloseLabel", "to close, not 30 minutes"),
      sub: tx_("landingSaveCloseSub", "Photograph and confirm. It replaces the spreadsheet cash-up, and you review before anything locks."),
    },
    {
      key: "rekey",
      icon: <FileCheck size={18} strokeWidth={STROKE} aria-hidden="true" />,
      fig: tx_("landingSaveRekeyFig", "0"),
      label: tx_("landingSaveRekeyLabel", "lines re-keyed for the revisor"),
      sub: tx_("landingSaveRekeySub", "OCR pre-fills; the PDF is stored for you."),
    },
  ];

  // ── Pricing tiers (3). Numbers LOCKED to billing.py PLAN_CAPS:
  // Free 0 / Starter 199 (129 founding) / Pro 349 (249 founding).
  // The founding number shows as the live figure with the standard
  // rate struck through ONLY while the founder rate is open (live).
  const perMonth = tx_("landingPricingPerMonth", "kr./mo");
  const foundingLabel = tx_("landingPricingFoundingFrom", "founding rate");
  const pricingTiers = [
    {
      key: "free",
      name: tx_("landingPricingFreeName", "Free"),
      tagline: tx_("landingPricingFreeTagline", "Close the day, kasserapport PDF, MOMS countdown — forever free."),
      priceNow: "0",
      priceWas: null,
      foundingLabel: null,
      bullets: [
        tx_("landingPricingFreeB1", "Daily close + kasserapport PDF"),
        tx_("landingPricingFreeB2", "MOMS countdown + weekly set-aside rate"),
        tx_("landingPricingFreeB3", "Reservationer — up to 20/mo, 3 tables"),
        tx_("landingPricingFreeB4", "10 receipt scans/mo"),
        tx_("landingPricingFreeB5", "7-day export window"),
      ],
      ctaLabel: tx_("landingPricingCtaFree", "Start free"),
      ctaStyle: "secondary",
      recommended: false,
    },
    {
      key: "starter",
      name: tx_("landingPricingStarterName", "Starter"),
      tagline: tx_("landingPricingStarterTagline", "Faktura, auto-email close to your revisor, bank reconcile from CSV."),
      priceNow: foundingOpen ? "129" : "199",
      priceWas: foundingOpen ? "199" : null,
      foundingLabel: foundingOpen ? foundingLabel : null,
      bullets: [
        tx_("landingPricingStarterB1", "Everything in Free"),
        tx_("landingPricingStarterB2", "Faktura + kreditnota (30/md), numre uden huller"),
        tx_("landingPricingStarterB3", "Auto-email close + Z-photo to revisor"),
        tx_("landingPricingStarterB4", "Reservationer unlimited · SMS reminders 300/mo"),
        tx_("landingPricingStarterB5", "Netbank-CSV reconciliation · 300 receipt scans/mo"),
        // Moved to Starter under the 2026-07 tier doctrine (every functional
        // feature is on Starter now; Pro differs only by size + volume + perks).
        tx_("landingPricingStarterB6", "Vagtplan autopilot (revenue + weather + labour %)"),
        tx_("landingPricingStarterB7", "MOMS angivelse as PDF, ready to file + reservation insights"),
      ],
      ctaLabel: tx_("landingPricingCtaStarter", "Try 14 days free"),
      ctaStyle: "dark",
      recommended: false,
    },
    {
      key: "pro",
      name: tx_("landingPricingProName", "Pro"),
      tagline: tx_("landingPricingProTagline", "Multi-terminal close, 3 locations, white-label faktura, priority support."),
      priceNow: foundingOpen ? "249" : "349",
      priceWas: foundingOpen ? "349" : null,
      foundingLabel: foundingOpen ? foundingLabel : null,
      bullets: [
        tx_("landingPricingProB1", "Everything in Starter"),
        tx_("landingPricingProB2", "3 branches + 5 team members with role permissions"),
        tx_("landingPricingProB3", "Priority email support"),
        tx_("landingPricingProB4", "Multi-terminal consolidated close (up to 3 sites)"),
        tx_("landingPricingProB5", "White-label faktura · unlimited faktura · 1,000 scans + 1,000 SMS/mo"),
      ],
      ctaLabel: tx_("landingPricingCtaPro", "Try 14 days free"),
      ctaStyle: "primary",
      recommended: true,
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
        tx_("landingCatMoney6", "MOMS countdown + PDF ready for the filing (you submit yourself)"),
      ],
    },
    {
      titleKey: "landingCatFaktura", titleFallback: "Faktura",
      items: [
        tx_("landingCatFaktura1", "Send fakturaer (direct email)"),
        tx_("landingCatFaktura2", "CVR-verified customers"),
        tx_("landingCatFaktura3", "Bank auto-match (±2 kr tolerance)"),
        tx_("landingCatFaktura4", "Proper kreditnota — the original keeps its number"),
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
        tx_("landingCatStaff1", "Schedule autopilot"),
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
        tx_("landingCatAi3", "Regulars-at-risk alerts"),
        tx_("landingCatAi4", "Sales↔Close variance flagging"),
        tx_("landingCatAi6", "Weather-aware staff predictions"),
      ],
    },
    {
      titleKey: "landingCatMore", titleFallback: "More",
      items: [
        tx_("landingCatMore2", "Khata · regulars credit book"),
        tx_("landingCatMore3", "Loan tracker"),
        tx_("landingCatMore4", "Multi-currency · 6 languages"),
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
        /* One calm settle beat for the day timeline (fade-up, <=600ms). */
        @keyframes dayFadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .dayNode { animation: dayFadeUp 0.4s ease-out both; }
        /* Gentle halo on the booker's picked table — one calm slow beat. */
        @keyframes floorPulse {
          0%, 100% { opacity: 0; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(1.4); }
        }
        .floorPulse { animation: floorPulse 2.6s ease-in-out infinite; }
        /* Hero revenue bars rise once on load — the creative 2D beat. */
        @keyframes barRise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        .closeBar { transform-origin: bottom; animation: barRise 0.55s cubic-bezier(0.22,1,0.36,1) both; }
        /* Scroll-reveal — each product surface settles in as it enters view. */
        .reveal { opacity: 0; transform: translateY(16px); }
        .reveal-in { opacity: 1; transform: none; transition: opacity 0.5s ease-out, transform 0.55s cubic-bezier(0.22,1,0.36,1); }
        @media (prefers-reduced-motion: reduce) {
          .flowStep { animation: none; opacity: 1; }
          .dayNode  { animation: none; opacity: 1; transform: none; }
          .floorPulse { animation: none; opacity: 0; }
          .closeBar { animation: none; transform: none; }
          .reveal, .reveal-in { opacity: 1; transform: none; transition: none; }
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
              aria-label={tx_("languageLabel", "Language")}
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
              aria-label={tx_("landingNavMenuAria", "Menu")}
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
                  "Tag et billede af Z-rapporten, tjek tallene, færdig. MOMS-nedtællingen viser, hvad du skal lægge til side, og kasserapporten ligger klar til revisor.",
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
                  href="#day"
                  className="inline-flex items-center justify-center h-11 px-4 text-[15px] font-medium text-gray-700 hover:text-gray-900 transition-colors"
                >
                  {tx_("landingHeroSecondaryDay", "See the 4 moments")}
                  <ArrowRight size={14} strokeWidth={2} className="ml-1.5" aria-hidden="true" />
                </a>
              </div>

              {/* Trust strip — definitionally-true claims, gray-600 meta */}
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-gray-600">
                {[
                  tx_("landingCheck1", "14 dages gratis prøve"),
                  tx_("landingCheck2", "Ingen kortoplysninger"),
                  tx_("landingCheckCompliance", "Bogføringsloven"),
                  tx_("landingCheckGdpr", "Database i Irland"),
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

      {/* ── 2 · DAY — the four-moment timeline (narrative bridge) ──── */}
      <Section id="day" className="bg-white border-y border-gray-200">
        <CenteredIntro
          eyebrow={tx_("landingDayTag", "One day, handled")}
          title={tx_("landingDayTitle", "Your day, from first coffee to lights-out.")}
          sub={tx_("landingDaySub", "Four things that used to take the rest of the evening. Now they run while you work, and the paperwork is ready for your revisor afterwards.")}
        />
        <DayTimeline nodes={dayNodes} />
        <p className="mt-10 text-center text-[15px] text-gray-500 max-w-2xl mx-auto leading-[1.6]">
          {tx_("landingDayClose", "And while you sleep: it's already in the books, ready for your revisor.")}
        </p>
      </Section>

      {/* ── 2c · SHOWCASE — see the two most visual products in 2D ──── */}
      <Section id="showcase" className="bg-gray-50">
        <div className="space-y-20 lg:space-y-28">
          {/* Reservations — copy left, real 2D floor right */}
          <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center reveal">
            <div className="max-w-lg">
              <Eyebrow>{tx_("landingShowFloorTag", "Reservationer")}</Eyebrow>
              <Heading>{tx_("landingShowFloorTitle", "Guests book themselves — on your real floor.")}</Heading>
              <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
                {tx_("landingShowFloorSub", "Share one link. Diners pick their own table on a 2D map of your room — round tables, langborde, bås, the bar. The same table cannot be booked twice, even when two guests tap at once.")}
              </p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-gray-700">
                {[
                  tx_("landingShowFloorB1", "A booking page that looks like your room, not a form"),
                  tx_("landingShowFloorB2", "Guest taps a free table — you get the booking instantly"),
                  tx_("landingShowFloorB3", "No-double-booking is enforced in the database, not by hope"),
                ].map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <Check size={16} strokeWidth={2} className="mt-1 text-emerald-600 shrink-0" aria-hidden="true" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-center"><FloorPlan /></div>
          </div>

          {/* Vagtplan — real 2D grid left, copy right (alternate) */}
          <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center reveal">
            <div className="order-2 lg:order-1"><LandingScheduleMini tx_={tx_} /></div>
            <div className="order-1 lg:order-2 max-w-lg">
              <Eyebrow>{tx_("landingShowSchedTag", "Vagtplan")}</Eyebrow>
              <Heading>{tx_("landingShowSchedTitle", "Next week's rota, proposed in one tap.")}</Heading>
              <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
                {tx_("landingShowSchedSub", "Autopilot sizes the week to your revenue, the weather and Danish labour law — at your target labour %. It proposes; you review and publish. Staff get the shift on their phone.")}
              </p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-gray-700">
                {[
                  tx_("landingShowSchedB1", "Sized to demand, kept at your target labour %"),
                  tx_("landingShowSchedB2", "Proposes — never auto-publishes. You stay in control"),
                  tx_("landingShowSchedB3", "Published shifts land on each phone, with .ics + reminders"),
                ].map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <Check size={16} strokeWidth={2} className="mt-1 text-emerald-600 shrink-0" aria-hidden="true" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Faktura — copy left, real 2D invoice right */}
          <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center reveal">
            <div className="max-w-lg">
              <Eyebrow>{tx_("landingShowFakturaTag", "Faktura")}</Eyebrow>
              <Heading>{tx_("landingShowFakturaTitle", "Send a faktura. Numbered exactly right.")}</Heading>
              <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
                {tx_("landingShowFakturaSub", "One tap makes a faktura with numbering that runs without gaps. Void one and you get a proper kreditnota — never a deleted line. Upload your netbank CSV and paid invoices are matched automatically.")}
              </p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-gray-700">
                {[
                  tx_("landingShowFakturaB1", "Numbers run without gaps, which is the first thing a revisor checks"),
                  tx_("landingShowFakturaB2", "A real kreditnota on void, never a silent delete"),
                  tx_("landingShowFakturaB3", "Netbank-CSV reconciliation matches payments for you"),
                ].map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <Check size={16} strokeWidth={2} className="mt-1 text-emerald-600 shrink-0" aria-hidden="true" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div><LandingFakturaMini tx_={tx_} /></div>
          </div>
        </div>
      </Section>

      {/* ── 3 · PILLARS — the five-card centrepiece grid ───────────── */}
      <Section id="pillars">
        <SectionIntro
          eyebrow={tx_("landingPillarsTag", "What BonBox does for you")}
          title={tx_("landingPillarsTitle", "Five things. Each one saves you money or time.")}
          sub={tx_("landingPillarsSub", "Not a wall of half-finished features. Five things at the core of running a Danish business — each built to actually carry its weight.")}
        />

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {pillars.map((p) => (
            <PillarCard
              key={p.key}
              icon={p.icon}
              title={p.title}
              promise={p.promise}
              foot={p.foot}
              tier={p.tier}
              appLink={p.appLink}
              tap={tx_("landingPillarsTap", "one tap")}
              className={p.span ? "lg:col-span-2 reveal" : "reveal"}
            />
          ))}
        </div>

        {/* Everything else — honest detail, one click away (collapsed). */}
        <details className="group mt-6 bg-white border border-gray-200 rounded-xl overflow-hidden">
          <summary className="flex items-center justify-between cursor-pointer px-6 py-4 hover:bg-gray-50 transition-colors list-none gap-3 min-h-[44px]">
            <span className="text-[15px] font-semibold text-gray-900 tracking-tight">
              {tx_("landingPillarsMoreToggle", "See everything else BonBox does")}
            </span>
            <ChevronDown size={18} strokeWidth={STROKE} className="text-gray-400 group-open:rotate-180 transition-transform shrink-0" aria-hidden="true" />
          </summary>

          <div className="px-6 pb-7 pt-1 border-t border-gray-100">
            <p className="mt-5 mb-7 text-[15px] text-gray-600 leading-[1.65] max-w-[560px]">
              {tx_("landingPillarsMoreSub", "Receipt OCR, netbank-CSV reconciliation, inventory, the 8am Brief and more — every module shares the same data, so the morning Brief always knows what you sold yesterday.")}
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

      {/* ── 4 · PROOF — definitionally-true fact tiles (not ROI) ───── */}
      <Section className="bg-gray-50">
        <CenteredIntro
          eyebrow={tx_("landingSaveTag", "Where the money and time hide")}
          title={tx_("landingSaveTitle", "The four places BonBox pays for itself.")}
          sub={tx_("landingSaveSub", "No invented numbers. Just the places an hour — or a fine — disappears every month. These are jobs BonBox does, not a promise about your numbers.")}
        />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-5xl mx-auto">
          {proofTiles.map((tile) => (
            <ProofTile
              key={tile.key}
              icon={tile.icon}
              fig={tile.fig}
              label={tile.label}
              sub={tile.sub}
            />
          ))}
        </div>
        <p className="mt-10 text-center text-[13px] text-gray-400 max-w-2xl mx-auto leading-[1.5]">
          {tx_("landingSaveFootnote", "30 sec is happy-path scan-and-confirm, not a guarantee. Figures you already know — not customer claims.")}
        </p>
      </Section>

      {/* ── 5 · MOMS COUNTDOWN spotlight (reused, honesty-edited) ──── */}
      <Section className="bg-white border-y border-gray-200">
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center">
          <div className="max-w-lg">
            <Eyebrow>{tx_("landingMomsTag", "Never another MOMS fine")}</Eyebrow>
            <Heading>
              {tx_("landingMomsHeading", "Your MOMS is a date — not a report.")}
            </Heading>
            <p className="mt-4 text-[17px] text-gray-600 leading-[1.6] max-w-[560px]">
              {tx_(
                "landingMomsBody",
                "BonBox computes your set-aside rate at every sale, from your fakturaer and kasserapport. When the deadline approaches, you know exactly how much to file — and how much to keep aside. BonBox tells you the number; it never holds your money.",
              )}
            </p>
            <ul className="mt-6 space-y-2.5 text-[15px] text-gray-700">
              {[
                tx_("landingMomsBullet1", "Set-aside rate computed at every sale"),
                tx_("landingMomsBullet2", "Q1 / Q2 / half-year — we follow your cadence"),
                tx_("landingMomsBullet3", "Filing-ready PDF for SKAT"),
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

      {/* ── 6 · PRICING — 3 real tiers + founder + trial ───────────── */}
      <Section id="pricing">
        <CenteredIntro
          eyebrow={tx_("landingPricingTag", "Simple pricing")}
          title={tx_("landingPricingHeadline", "Simple pricing. Founders lock the low rate.")}
          sub={tx_("landingPricingLede", "Start free for 14 days on full Pro — no card. Prices ex. MOMS, per business.")}
        />

        <div className="grid md:grid-cols-3 gap-4 items-stretch max-w-5xl mx-auto">
          {pricingTiers.map((tier) => (
            <PricingCard
              key={tier.key}
              name={tier.name}
              tagline={tier.tagline}
              priceNow={tier.priceNow}
              priceWas={tier.priceWas}
              perMonth={perMonth}
              foundingLabel={tier.foundingLabel}
              bullets={tier.bullets}
              ctaLabel={tier.ctaLabel}
              ctaStyle={tier.ctaStyle}
              recommended={tier.recommended}
              popularLabel={tx_("landingPricingPopular", "Most popular")}
            />
          ))}
        </div>

        {/* Trial reassurance + founder honesty. */}
        <div className="mt-10 max-w-3xl mx-auto text-center">
          <p className="inline-flex items-start gap-2 text-[15px] text-gray-700 leading-[1.6]">
            <Check size={16} strokeWidth={2} className="mt-1 text-emerald-600 shrink-0" aria-hidden="true" />
            <span>{tx_("landingPricingTrial", "Every account starts on 14 days of full Pro — free, no card required. On day 15 you choose Pro, Starter, or stay on Free.")}</span>
          </p>
          <p className="mt-4 text-[13px] text-gray-400 leading-[1.5]">
            {tx_("landingPricingHonesty", "Per business, ex. MOMS. Founder rate holds while your subscription stays active.")}
          </p>
        </div>

        {/* The owner's own arithmetic. We assert nothing about anyone
            else's price — see the component header for why a comparison
            table was rejected. */}
        <div className="max-w-3xl mx-auto">
          <WhatDoYouPayNow />
        </div>
      </Section>

      {/* ── 7 · TRUST — definitionally-true facts + compliance ─────── */}
      <Section>
        <CenteredIntro
          eyebrow={tx_("landingProofTag", "Built for the Danish reality")}
          title={tx_("landingProofTitle", "Made for how Danish small businesses actually run.")}
        />

        {/* Definitionally-true fact row — replaces the killed "target" stats. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 max-w-4xl mx-auto">
          {[
            { val: tx_("landingFactLangVal", "6 languages"), label: tx_("landingFactLangLabel", "in the app") },
            { val: tx_("landingFactEuVal", "Ireland"), label: tx_("landingFactEuLabel", "Where your database sits") },
            { val: tx_("landingFactBogfVal", "6 år"), label: tx_("landingFactBogfLabel", "your documents are kept") },
            { val: tx_("landingFactFristVal", "25%"), label: tx_("landingFactFristLabel", "MOMS worked out on every sale") },
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
            { title: tx_("landingTrustBogf7", "Fortløbende fakturanumre"), body: tx_("landingTrustBogf7Body", "Gap-free invoice numbering, kreditnota with the next number, locked books.") },
            { title: tx_("landingTrustBogf10", "Bogføringsloven"), body: tx_("landingTrustBogf10Body", "5-year retention. Immutable audit log on every financial change.") },
            { title: tx_("landingTrustGdpr", "Built to GDPR"), body: tx_("landingTrustGdprBody", "Database in Ireland. Receipts are read in the US. Every processor is named in the privacy policy, so you can check them before you sign up. You export or delete your data yourself, and your revisor logs in without sharing a password.") },
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

        {/* Built-for — audience list. */}
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
                tx_("landingPosIs2", "Faktura with numbering that runs without gaps"),
                tx_("landingPosIs3", "The AI morning Brief that knows your last 90 days"),
                tx_("landingPosIs4", "OCR receipts + bank-CSV auto-match to fakturaer"),
                tx_("landingPosIs5", "CSV bundle for the årsregnskab, ready for your revisor to use as it is"),
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
              a: tx_("landingFaq4A", "The database is in Ireland. When a receipt needs reading, the image goes to Anthropic in the US. Every company that touches your data is named in the privacy policy.\n\nThe audit log can't be edited or deleted. That's locked in the database itself.\n\nYou can pull everything out as CSV and delete your account whenever you want.") },
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
              <div className="px-5 sm:px-6 pb-5 text-[15px] text-gray-600 leading-[1.65] whitespace-pre-line">
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
            <p className="text-[15px] font-semibold text-gray-900 tracking-tight">
              {tx_("landingFounderName", "Manoz Chaudhary · København")}{" "}
              <a
                href="https://datacvr.virk.dk/enhed/virksomhed/46417321"
                target="_blank"
                rel="noopener noreferrer"
                className="font-normal text-gray-500 underline underline-offset-2 hover:text-gray-900"
              >
                {tx_("landingFounderCvr", "CVR 46417321")}
              </a>
            </p>
          </div>

          {/* Eyebrow sits under the identity — keeps the human first. */}
          <div className="mt-6">
            <Eyebrow>{tx_("landingFounderEyebrow", "Who's behind this")}</Eyebrow>
          </div>

          {/* Three short paragraphs — lead size (17px), generous spacing. */}
          <div className="space-y-4">
            <p className="text-[17px] text-gray-900 leading-[1.6]">
              {tx_("landingFounderP1", "My name is Manoj.")}
            </p>
            <p className="text-[15px] text-gray-600 leading-[1.65] whitespace-pre-line">
              {tx_(
                "landingFounderP2",
                "I spent five years in a kitchen in Copenhagen. The part that wore you down was not the evenings, it was the half hour afterwards, counting up and writing numbers down by hand. That half hour is what BonBox is built to remove.",
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

            {/* The trading name is BonBox; the registered business is
                DukaanAI v/Manoz Chaudhary. Naming both, with the CVR
                linked to the public register, is the cheapest credibility
                on the page — anyone can check it in ten seconds. */}
            <p className="text-[12px] text-gray-500">
              © {new Date().getFullYear()} BonBox —{" "}
              {tx_("landingFooterEntity", "et produkt fra DukaanAI v/Manoz Chaudhary")} ·{" "}
              <a
                href="https://datacvr.virk.dk/enhed/virksomhed/46417321"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-gray-700"
              >
                CVR 46417321
              </a>
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
