// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { dateLocale, businessTodayIso } from "../utils/dateFormat";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency, formatOwnerMoney } from "../utils/currency";
import { formatHours, formatHoursNumber, hoursUnit } from "../utils/hours";
import { errText } from "../utils/errText";
import { useConfirm } from "../hooks/useConfirm";
import { useAsyncData } from "../hooks/useAsyncData";
import { FadeIn, TabContent, AnimatedList, AnimatedListItem, AnimatePresence } from "../components/AnimationKit";
import { PageHeader, Button, TabPills, Icon, StatCard, SectionBanner, LoadFailed, Amount } from "../components/ui";
import WagePrivacyNotice from "../components/WagePrivacyNotice";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { readViewedPeriod, writeViewedPeriod } from "../utils/viewedPeriod";
import { VIEW_RANGES, viewRange, matchViewRange, stepUnit, stepWindow } from "../utils/viewRanges";

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
// Why a wage read was refused: null (not refused), "curtain" (this owner's own
// session on a shared device — they CAN lift it with their PIN) or "role" (a
// delegated seat — they cannot). The server already draws this line in the 403
// body; the page used to throw it away and tell both populations the role one,
// which is false for an owner and offers them no way forward.
function denialReason(err) {
  if (err?.response?.status !== 403) return null;
  return err?.response?.data?.detail?.code === "device_pin_required"
    ? "curtain"
    : "role";
}

/** The house sentence, never axios's.
 *
 * errText() ends its fall-through at `err.message` — and when the request never
 * reached the server that is axios's OWN English string ("Network Error",
 * "timeout of 0ms exceeded"), printed under a pay form to a Danish owner. A
 * request that got no response carries no server sentence to quote, so there is
 * nothing to surface but our own words.
 *
 * The same third-state rule the reads on this page now follow: "the server said
 * no, and here is why" and "I never got an answer" are different facts, and only
 * the first one has a server sentence worth showing.
 */
function houseErrText(err, fallback) {
  return err?.response ? errText(err, fallback) : fallback;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
}

function fmtDateFull(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

function fmtPeriod(from, to) {
  if (!from || !to) return "\u2014"; // em dash fallback, skeleton handles loading
  return `${fmtDate(from)} \u2013 ${fmtDate(to)}`;
}

// Local-TZ ISO date — using toISOString here would split the day at UTC
// midnight, so a Danish owner logging hours at 01:00 local time would
// see "yesterday" as today. Match the rest of the app via dateFormat.localIso.
function isoDate(d) {
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().split("T")[0];
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function getMonday(iso) {
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return isoDate(d);
}

// The BUSINESS day (06:00 cutoff): after midnight tonight's hours still sit
// on yesterday's date, and the Log form defaulted to tomorrow's.
function today() {
  return businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
}

// Client mirror of backend _compute_pay_period (staff.py) — used ONLY to
// navigate prev/next for calendar-anchored frames so the window snaps to the
// real 1st / 15th / custom-day boundary instead of drifting by a fixed day count.
const CALENDAR_FRAMES = ["monthly_1st", "monthly_15th", "custom"];
function computePayPeriod(type, startDay, refIso) {
  const ref = new Date(refIso + "T00:00:00");
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const day = ref.getDate();
  const isoOf = (yy, mm, dd) => isoDate(new Date(yy, mm, dd)); // JS Date normalizes over/underflow
  if (type === "monthly_15th") {
    if (day >= 15) return { from: isoOf(y, m, 15), to: isoOf(y, m + 1, 14) };
    return { from: isoOf(y, m - 1, 15), to: isoOf(y, m, 14) };
  }
  if (type === "weekly") {
    // Monday-Sunday, mirroring _compute_pay_period in routers/staff.py. JS
    // getDay() is 0=Sunday, so shift it to Python's 0=Monday before
    // subtracting, or every Sunday lands in the wrong week.
    const dow = (ref.getDay() + 6) % 7;
    return { from: isoOf(y, m, day - dow), to: isoOf(y, m, day - dow + 6) };
  }
  if (type === "custom") {
    const csd = Math.min(28, Math.max(1, parseInt(startDay, 10) || 1));
    // to = the day before the next occurrence of csd (isoOf(y, m+1, csd-1) handles csd=1)
    if (day >= csd) return { from: isoOf(y, m, csd), to: isoOf(y, m + 1, csd - 1) };
    return { from: isoOf(y, m - 1, csd), to: isoOf(y, m, csd - 1) };
  }
  // monthly_1st + fallback
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { from: isoOf(y, m, 1), to: isoOf(y, m, lastDay) };
}

// "18 %" in Danish (a space before the sign), "18%" in English — one way on
// every tile, line and sentence of this page; it said "18 %", "18%" and "0%".
function pctText(n, lang) {
  return lang === "da" ? `${n} %` : `${n}%`;
}

function calcHoursFromTimes(start, end, breakMin) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let totalMin = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMin < 0) totalMin += 24 * 60; // overnight shift
  totalMin -= (breakMin || 0);
  return Math.max(0, +(totalMin / 60).toFixed(2));
}

// Entry-method chip — neutral gray + a Lucide icon encoding meaning (design
// lock: no decorative blue/purple, no emoji). Clock = stemplet (measured),
// FileText = tastet (typed), CalendarCheck = fra plan.
// COLOUR, as a confidence gradient. How much does this number deserve to be
// believed?
//
//   Stempelur   the clock MEASURED it        green
//   Tastet      a person asserted it         amber
//   Fra plan    nobody did either            grey outline
//
// A traffic light, read in a glance, in the order an owner already understands.
// It answers the question the banner above the table asks out loud — "96% of
// hours were not clocked, the figures are an estimate" — by showing WHICH
// rows those are instead of only quoting a percentage.
//
// TWO NOTES FOR WHOEVER TOUCHES THE PALETTE NEXT.
//
// GREEN-* DOES NOT WORK HERE, and the first version of this shipped broken
// because of it. index.css:808-822 remaps every .bg-green-* / .text-green-*
// to rgb(var(--brand-*)) with !important so the app follows the owner's
// chosen theme — and the default theme is "calm", a soft BLUE. A green chip
// therefore renders blue, or vanishes against a pale background. emerald-*,
// teal-*, lime-* and amber-* carry no override; green is the one family that
// is hijacked. Check index.css before reaching for a colour here.
//
// The colour law at ~line 1228 governs the SHIFT-STATE cell: amber "needs an
// answer", red "statutory breach", emerald "LIVE, on the clock right now".
// These chips are a different axis — provenance, not state. The soft
// emerald-50/700 pair here is visually distinct from the emerald-500/600 TEXT
// that cell uses for "live", so the two do not read as the same signal.
//
// The greens and ambers are kept soft (50/700 pairs) rather than solid fills:
// on a venue where most rows are Tastet, a saturated amber block per row is
// the "once everything is coloured nothing is" trap. Soft tints stay legible
// in bulk and still separate at a glance.
const METHOD_BADGES = {
  quick: {
    icon: "FileText",
    labelKey: "hovMethodQuick",
    // Asserted by a person — true as far as anyone typed it.
    chip: "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:ring-amber-900/40",
  },
  clock: {
    icon: "Clock",
    labelKey: "hovMethodClock",
    // Measured. The only row an owner can hand to Arbejdstilsynet.
    chip: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-900/25 dark:text-emerald-300 dark:ring-emerald-900/40",
  },
  schedule: {
    icon: "CalendarCheck",
    labelKey: "hovMethodSchedule",
    // Assumed from a roster. Nobody has confirmed it happened, so it stays
    // uncoloured — an outline, not a claim.
    chip: "bg-transparent text-gray-500 ring-1 ring-gray-300 dark:text-gray-400 dark:ring-gray-600",
  },
  owner_resolved: {
    icon: "Pencil",
    labelKey: "hovMethodOwnerResolved",
    // Clocked in, but the end (or the whole shift) was set by the owner. Not
    // "tastet" — the clock did measure part of it — and not "stemplet" either.
    chip: "bg-gray-50 text-gray-700 ring-1 ring-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-600",
  },
};
// Fallback for an unknown method — never dressed as measured.
const METHOD_CHIP =
  "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffHoursPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  // The hub's shared URL: ?view= (this tab's sub-view) and ?from=&to= (the
  // period on screen, shared with Løn and Tidsregistrering — viewedPeriod.js).
  const [searchParams, setSearchParams] = useSearchParams();
  // The period a tab switch or a link brought with it — read once, at mount.
  const [urlPeriodAtMount] = useState(() => readViewedPeriod(searchParams));

  // Period state
  const [periodConfig, setPeriodConfig] = useState(null);
  const [periodFrom, setPeriodFrom] = useState(null);
  const [periodTo, setPeriodTo] = useState(null);
  const [periodLoading, setPeriodLoading] = useState(true);
  // THE CURRENT WINDOW, AS THE SERVER COMPUTED IT — {from, to}. Kept apart
  // from the window on screen so "am I looking at the current period?" is a
  // comparison against the venue's own answer instead of against the device
  // clock. GET /staff/pay-period/current anchors on business_today_local
  // (staff.py), which before the venue's 06:00 cutoff still returns
  // YESTERDAY; a device-date comparison therefore disagrees with the server
  // about which period is current for the whole after-midnight close hour on
  // the first day of every period.
  const [currentWindow, setCurrentWindow] = useState(null);

  // Data. THREE outcomes per request, not two — loading / failed / data — via
  // useAsyncData, because the two-outcome shape this page used to have
  // (`.catch(() => setSummary([]))`) makes a failure indistinguishable from an
  // absence, and every empty state on this page then states the absence as
  // fact: "Ingen timer registreret denne periode" to a venue that logged 312.
  // `enabled` holds the period-scoped requests until the window is known, so an
  // un-asked question is never reported as a failed one.
  const periodReady = !!(periodFrom && periodTo);

  const staffQ = useAsyncData(() => api.get("/staff/members"), [], { initial: [] });
  const staffList = staffQ.data || [];
  // THE ROSTER, IN THREE OUTCOMES — because the front door of this job used to
  // read it as two.
  //
  // "Log hours" was the only button on the Oversigt empty state, and it moved
  // the owner to the Log tab, where the staff <select> holds one disabled
  // "Vælg medarbejder…" and the submit button is dead forever: a venue that has
  // never added anybody cannot log an hour, and nothing on the way said so. The
  // owner reads that as a broken form, not as a missing prerequisite.
  //
  // `rosterEmpty` is deliberately NOT `staffList.length === 0`. A failed fetch
  // gives the same empty array, and telling an owner with nine staff to "add
  // your first team member" is the comforting-and-false answer this file has
  // spent its whole history removing. Empty means: we asked, the answer came
  // back, and it was nobody. A failure keeps the old CTA and gets LoadFailed
  // (already wired below) to explain itself.
  const rosterEmpty =
    !staffQ.loading && !staffQ.failed && staffList.length === 0;

  const summaryQ = useAsyncData(
    () => api.get("/staff/hours/summary", { params: { from: periodFrom, to: periodTo } }),
    [periodFrom, periodTo],
    { initial: [], enabled: periodReady },
  );
  const summary = summaryQ.data || [];

  const entriesQ = useAsyncData(
    () => api.get("/staff/hours", { params: { from: periodFrom, to: periodTo } }),
    [periodFrom, periodTo],
    { initial: [], enabled: periodReady },
  );
  // Memoised because currentHasClock reads it: a fresh `|| []` each render
  // would re-run that memo forever.
  const entries = useMemo(() => entriesQ.data || [], [entriesQ.data]);

  // Overview payload (one-glance hero + genuine narrative). Own fetch so a
  // slow summary/entries load never blocks the answer at the top.
  const overviewQ = useAsyncData(
    () => api.get("/staff/hours/overview", { params: { from: periodFrom, to: periodTo, compare: "prev" } }),
    [periodFrom, periodTo],
    { enabled: periodReady },
  );
  const overview = overviewQ.data || null;

  // "You can't see this", kept apart from "this failed".
  // null | "role" | "curtain": WHICH of the two it is decides what the notice
  // may honestly say, and the server already distinguishes them in the 403
  // body (read_forbidden vs device_pin_required). Collapsing both to a boolean
  // is what told an owner on a shared tablet that their ROLE was the obstacle.
  //
  // A 403 here is not a failure, it is an ANSWER: /hours/overview carries the
  // venue's labour cost AND its revenue, so it is owner-only. Everything that
  // is NOT a 403 is the third state — we could not ask — and it now gets
  // <LoadFailed> instead of the blank page it used to get.
  const overviewDenied = overviewQ.failed ? denialReason(overviewQ.error) : null;
  const overviewFailed = overviewQ.failed && !overviewDenied;
  // Same split for the period summary. /hours/summary is redacted per field
  // rather than denied — for a member seat AND, since the curtain round, for a
  // shared device — so the denial branch should never fire today. It exists
  // because when it DID fire, the empty array rendered "Ingen timer registreret
  // denne periode" directly above a RecentHoursLog listing this month's real
  // entries. A denial must never be able to look like an absence, and neither
  // must a 500 or an offline phone.
  const summaryDenied = summaryQ.failed ? denialReason(summaryQ.error) : null;
  const summaryFailed = summaryQ.failed && !summaryDenied;

  // Period-frame control — how the owner frames the period to extract hours
  // (1st–end / 15th→14th / custom start-day / biweekly), plus an ad-hoc custom
  // date range. period_type/custom_start_day mirror the shared pay-period
  // config so Hours + Payroll always agree; "custom" range is a local override
  // that does NOT persist to the config.
  const [periodType, setPeriodType] = useState("monthly_1st");
  const [customStartDay, setCustomStartDay] = useState(16);
  const [frameMode, setFrameMode] = useState("recurring"); // "recurring" | "custom"
  // Did the last frame write reach the server? The picker's footnote claims the
  // choice is SAVED and shared with Løn; it may only say that when it is true.
  const [frameSaveFailed, setFrameSaveFailed] = useState(false);

  // Fetch pay period config
  useEffect(() => {
    const fallbackPeriod = () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      // A window carried in from another tab is still the one to show.
      setPeriodFrom(urlPeriodAtMount?.from || isoDate(start));
      setPeriodTo(urlPeriodAtMount?.to || isoDate(end));
      setCurrentWindow({ from: isoDate(start), to: isoDate(end) });
    };

    api.get("/staff/pay-period/current")
      .then(r => {
        const d = r.data;
        setPeriodConfig(d);
        // Backend _compute_pay_period returns {start_date, end_date}; keep the
        // legacy aliases as a fallback so any shape still resolves.
        const start = d?.start_date || d?.period_start || d?.start || d?.from;
        const end = d?.end_date || d?.period_end || d?.end || d?.to;
        if (start && end) {
          setCurrentWindow({ from: start, to: end });
          if (urlPeriodAtMount) {
            // Carried in from Løn / a link: show THAT window. Off the saved
            // frame (a one-off range) it is a custom range, so Previous/Next
            // step by its length instead of snapping to the frame.
            const type = d?.period_type || "monthly_1st";
            const aligned = CALENDAR_FRAMES.includes(type)
              ? (() => {
                  const p = computePayPeriod(type, d?.custom_start_day || 16, urlPeriodAtMount.from);
                  return p.from === urlPeriodAtMount.from && p.to === urlPeriodAtMount.to;
                })()
              : true;
            if (!aligned) setFrameMode("custom");
            setPeriodFrom(urlPeriodAtMount.from);
            setPeriodTo(urlPeriodAtMount.to);
          } else {
            setPeriodFrom(start);
            setPeriodTo(end);
          }
        } else {
          fallbackPeriod();
        }
      })
      .catch(() => {
        fallbackPeriod();
      })
      .finally(() => setPeriodLoading(false));
  }, []);

  // Keep the frame picker in sync when the saved config lands.
  useEffect(() => {
    if (!periodConfig) return;
    setPeriodType(periodConfig.period_type || "monthly_1st");
    if (periodConfig.custom_start_day) setCustomStartDay(periodConfig.custom_start_day);
  }, [periodConfig]);

  // Re-pull everything after a log/edit so the hero + narrative stay honest.
  // The old version re-fetched the overview with a bare `.catch(() => {})`, so
  // a refresh that failed left the owner reading pre-edit figures with nothing
  // saying so. reload() keeps the numbers AND raises `failed`, which is what
  // lets the banner call them stale.
  const reloadSummary = summaryQ.reload;
  const reloadEntries = entriesQ.reload;
  const reloadOverview = overviewQ.reload;
  const refetchAll = useCallback(() => {
    reloadSummary();
    reloadEntries();
    reloadOverview();
  }, [reloadSummary, reloadEntries, reloadOverview]);

  // Does THIS period have any real clock punch? (Used to gate the boundary
  // nudge below so it only fires in the confusing "0 clocked this period" case.)
  const currentHasClock = useMemo(
    () => (entries || []).some((e) => e.entry_method === "clock" && e.end_time),
    [entries],
  );

  // Boundary nudge: a shift clocked just after midnight is business-day-dated to
  // the previous day, so it lands in the PRIOR pay period. When this period
  // shows no clocked hours, look at the last few days before it — if a clock
  // punch is there, surface a one-tap jump so the owner isn't left thinking the
  // hours vanished. Reuses /staff/hours; changes no period total.
  const recentBeforeQ = useAsyncData(
    () => api.get("/staff/hours", { params: { from: addDays(periodFrom, -4), to: addDays(periodFrom, -1) } }),
    [periodFrom],
    { initial: [], enabled: !!periodFrom },
  );
  // A failed probe is not "nothing was clocked before this period" — it is no
  // answer at all, and a nudge is exactly the kind of claim that must not be
  // built on one. No answer, no nudge.
  const recentBeforeCount = recentBeforeQ.failed
    ? 0
    : (recentBeforeQ.data || []).filter((e) => e.entry_method === "clock" && e.end_time).length;

  // Period navigation
  const periodLength = useMemo(() => {
    if (!periodFrom || !periodTo) return 30;
    const a = new Date(periodFrom + "T00:00:00");
    const b = new Date(periodTo + "T00:00:00");
    return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
  }, [periodFrom, periodTo]);

  const goPrev = () => {
    if (!periodFrom || !periodTo) return;
    // Calendar-anchored frames snap to the real boundary (1st / 15th / custom
    // day) rather than drifting by a fixed day count; fixed-length frames
    // (biweekly, ad-hoc range) shift by their span.
    if (frameMode === "recurring" && CALENDAR_FRAMES.includes(periodType)) {
      const p = computePayPeriod(periodType, customStartDay, addDays(periodFrom, -1));
      setPeriodFrom(p.from); setPeriodTo(p.to);
      return;
    }
    // A one-off month steps month by month and a week by 7 — "Sidste måned"
    // then ← is August, not 31 days before 1. september.
    const stepped = stepWindow(stepUnit(periodFrom, periodTo), periodFrom, -1);
    if (stepped) { setPeriodFrom(stepped.from); setPeriodTo(stepped.to); return; }
    setPeriodFrom(addDays(periodFrom, -periodLength));
    setPeriodTo(addDays(periodTo, -periodLength));
  };

  // Keep the URL in step with the window on screen, so the next tab opens on
  // it — and a reload or a shared link does too. Not before the first load:
  // writing then would drop the period another tab just handed over.
  useEffect(() => {
    if (periodLoading || !periodFrom || !periodTo) return;
    writeViewedPeriod(searchParams, setSearchParams, { from: periodFrom, to: periodTo }, currentWindow);
  }, [periodLoading, periodFrom, periodTo, currentWindow, searchParams, setSearchParams]);

  // Is the window on screen the current pay period? Compared against the
  // server's own window, NOT against the device date — see currentWindow.
  const showingCurrent = !!(
    currentWindow && periodFrom === currentWindow.from && periodTo === currentWindow.to
  );

  // THE WAY HOME. The control was prev · label · next and nothing else: an
  // owner who stepped back to March had to count the same number of taps
  // forward to return, and the label in the middle opens the frame picker
  // rather than resetting. This re-reads the shared pay-period config, which
  // is the same window Løn extracts.
  const goCurrentPeriod = async () => {
    let next = currentWindow;
    let cfg = null;
    try {
      const r = await api.get("/staff/pay-period/current");
      const d = r.data || {};
      const start = d.start_date || d.period_start || d.start || d.from;
      const end = d.end_date || d.period_end || d.end || d.to;
      if (start && end) { next = { from: start, to: end }; cfg = d; }
    } catch {
      // Offline or 500 — fall back to the window THIS SESSION LOADED WITH,
      // which the server computed on the venue's business day AND its saved
      // frame. Do NOT recompute one here: computePayPeriod has no biweekly
      // branch (which is why goPrev/goNext guard on CALENDAR_FRAMES), so
      // guessing would put a biweekly venue on a 1st–31st calendar month and
      // then let prev/next walk it 30 days at a time for the rest of the
      // session. Reusing the known window is never a dead end either — it is
      // by definition different from the one the owner navigated away to.
    }
    if (!next) return;
    setFrameMode("recurring");
    setCurrentWindow(next);
    setPeriodFrom(next.from);
    setPeriodTo(next.to);
    if (cfg) {
      // Adopt the frame too, not just the window. Taking the server's window
      // while the picker keeps claiming a different frame is the same screen
      // answering two ways — and it clears the "showing here only" note,
      // which has just stopped describing anything: the picker now shows what
      // is actually saved.
      setPeriodConfig(cfg);
      setFrameSaveFailed(false);
    }
  };

  const goNext = () => {
    if (!periodFrom || !periodTo) return;
    if (frameMode === "recurring" && CALENDAR_FRAMES.includes(periodType)) {
      const p = computePayPeriod(periodType, customStartDay, addDays(periodTo, 1));
      setPeriodFrom(p.from); setPeriodTo(p.to);
      return;
    }
    const stepped = stepWindow(stepUnit(periodFrom, periodTo), periodFrom, 1);
    if (stepped) { setPeriodFrom(stepped.from); setPeriodTo(stepped.to); return; }
    setPeriodFrom(addDays(periodFrom, periodLength));
    setPeriodTo(addDays(periodTo, periodLength));
  };

  // Change the RECURRING frame (writes the shared pay-period config, so Hours +
  // Payroll extract the same window), then re-anchor to the current period.
  const selectFrame = async (type, day) => {
    setFrameMode("recurring");
    setPeriodType(type);
    setFrameSaveFailed(false);
    const csd = type === "custom" ? (parseInt(day, 10) || customStartDay || 1) : null;
    if (csd) setCustomStartDay(csd);
    try {
      await api.post("/staff/pay-period", { period_type: type, custom_start_day: csd });
      const r = await api.get("/staff/pay-period/current");
      const d = r.data || {};
      const start = d.start_date || d.period_start || d.start || d.from;
      const end = d.end_date || d.period_end || d.end || d.to;
      // The new frame's window IS the current period — keep the "am I home?"
      // reference in step with it, or the way-home button would appear the
      // instant a frame is picked and then have nothing to do.
      if (start && end) { setPeriodFrom(start); setPeriodTo(end); setCurrentWindow({ from: start, to: end }); }
      setPeriodConfig((c) => ({ ...(c || {}), period_type: type, custom_start_day: csd }));
    } catch {
      // Not fatal to the VIEW — the window on screen is still the one the owner
      // picked — but the note under the picker read "Saved — used for Hours and
      // Payroll." on a write that never landed. That is this page's defect in
      // miniature: a state we could not confirm, printed as fact. The picker now
      // says the frame is showing here only.
      setFrameSaveFailed(true);
    }
  };

  // Ad-hoc custom range — a LOCAL override for a one-off extraction. Does not
  // touch the saved config (so the recurring frame is preserved).
  const applyCustomRange = (from, to) => {
    if (!from || !to || to < from) return;
    // The venue's own current period, picked as a range, IS the frame again —
    // Previous/Next then snap to it instead of stepping a one-off window.
    if (currentWindow && from === currentWindow.from && to === currentWindow.to) {
      setFrameMode("recurring");
    } else {
      setFrameMode("custom");
    }
    setPeriodFrom(from);
    setPeriodTo(to);
  };
  // "Denne uge · Sidste uge · Denne måned · Sidste måned": a window to LOOK
  // at, never a setting (utils/viewRanges.js). Same non-saving path as a
  // custom range.
  const applyViewRange = (id) => {
    const r = viewRange(id, today());
    applyCustomRange(r.from, r.to);
  };

  // Sub-tabs — the page now opens on the ANSWER (Oversigt), not the logging
  // form. Same three destinations on every viewport (desktop parity); the
  // logging block + the accountant detail are one tap away, never the landing.
  // The sub-tab lives in the URL (?view=), so a reload, a back-button or a
  // link from the schedule's clocked-in strip lands on the same view.
  const SUB_IDS = ["overview", "log", "details"];
  const subTab = SUB_IDS.includes(searchParams.get("view")) ? searchParams.get("view") : "overview";
  const setSubTab = (id) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", id);
    next.delete("resolve");
    setSearchParams(next, { replace: true });
  };
  const subTabs = [
    { id: "overview", label: t("hovTabOverview", "Overview") },
    { id: "log", label: t("hovTabLog", "Log") },
    // No count on a failed load. A tab badge is a claim about how many entries
    // this period has, and a list that did not arrive cannot support one —
    // including the "0" that a silent catch used to leave behind.
    // "Details" said nothing about what is behind it. This tab IS the
    // per-person answer — the table of who worked how much and what they
    // earned — and an owner opening Hours to pay somebody had to guess that
    // "Details" was where their people were. The badge counts STAFF for the
    // same reason: it now matches the noun in the label. No count on a failed
    // load — a badge is a claim about how many, and a list that did not
    // arrive cannot support one, including the "0" a silent catch leaves.
    {
      id: "details",
      label: t("hovTabPerStaff", "Per staff"),
      count: summaryQ.failed ? undefined : (summary?.length || undefined),
    },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-6xl 2xl:max-w-[1400px] mx-auto space-y-4 sm:space-y-6">
      <PageHeader
        eyebrow={t("shpEyebrow", "STAFF")}
        title={t("staffHours", "Staff Hours")}
        subtitle={t("staffHoursSubtitle", "Track working hours, clock in/out, and confirm schedules.")}
      />

      {/* Period-frame control — scopes every tab, tile, and the narrative. The
          owner frames the period (1st–end / 15th→14th / custom start-day /
          biweekly) or picks an ad-hoc date range, right here. */}
      <FadeIn delay={0.05}>
        <PeriodControl
          from={periodFrom}
          to={periodTo}
          loading={periodLoading}
          onPrev={goPrev}
          onNext={goNext}
          isCurrent={showingCurrent}
          onCurrent={goCurrentPeriod}
          periodType={frameMode === "custom" ? "custom_range" : periodType}
          savedType={periodConfig?.period_type || periodType}
          customStartDay={customStartDay}
          onSelectFrame={selectFrame}
          onCustomRange={applyCustomRange}
          onViewRange={applyViewRange}
          saveFailed={frameSaveFailed}
        />
      </FadeIn>

      {/* Boundary nudge: this period shows no clocked hours, but a shift was
          clocked in the days just before it (an after-midnight punch is dated
          to the previous business day → lands in the prior period). One tap
          jumps there so the hours never look "missing".
          `!entriesQ.failed` is the third state again: `!currentHasClock` is
          read off THIS period's entries, so when that list never arrived the
          absence of clocked hours is unknown, not established — and sending
          the owner to the previous period on the strength of it would be a
          claim built on a question we never got an answer to. */}
      {recentBeforeCount > 0 && !currentHasClock && !entriesQ.failed && (
        <button
          type="button"
          onClick={goPrev}
          className="w-full flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/15 px-4 py-2.5 text-left transition-colors hover:bg-amber-100/70 dark:hover:bg-amber-900/25"
        >
          <span className="text-[13px] text-amber-800 dark:text-amber-300">
            {t("staffHoursRecentOutOfPeriod", "Clocked hours landed just before this period")}
          </span>
          <span className="text-[13px] font-semibold text-amber-900 dark:text-amber-200 shrink-0">
            {t("staffHoursViewPrevPeriod", "Show previous period")} {"→"}
          </span>
        </button>
      )}

      <TabPills
        tabs={subTabs}
        activeId={subTab}
        onChange={setSubTab}
        ariaLabel={t("staffBackOffice", "Staff back office")}
      />

      {/* OVERSIGT — the one-glance answer: narrative + 4 hero tiles. */}
      {subTab === "overview" && (
        <FadeIn delay={0.1}>
          <HoursOverview
            // While another period loads, the data in hand belongs to the
            // OLD period — October's "353 t planlagt" sat under "1. sep. –
            // 30. sep." for 3 s. Show the skeleton then; a refresh of the
            // same period keeps its figures.
            overview={overviewQ.loading && !overviewQ.refreshing ? null : overview}
            // The period window is a precondition for this request, so while it
            // resolves the tab is LOADING, not answered-and-empty.
            loading={overviewQ.loading || periodLoading}
            failed={overviewFailed}
            // All three: the overview's retry reloaded only itself, and the
            // per-person and log figures under it stayed from before.
            onRetry={refetchAll}
            denied={overviewDenied}
            currency={currency}
            onGoLog={() => setSubTab("log")}
            onGoDetails={() => setSubTab("details")}
            people={summary}
            rosterEmpty={rosterEmpty}
            needsAnswer={summary.reduce((n, r) => n + (Number(r.needs_answer_count) || 0), 0)}
          />
        </FadeIn>
      )}

      {/* LOG — the existing 3-tab logging block, unchanged behavior. */}
      {subTab === "log" && (
        <FadeIn delay={0.1}>
          <LoggingSection
            staffList={staffList}
            // An empty name picker has two causes and they are not the same
            // sentence: a venue with no staff yet, or a roster we could not
            // fetch. The forms stay mounted either way — this only explains
            // the gap, it never takes the action away.
            staffFailed={staffQ.failed}
            onRetryStaff={staffQ.reload}
            rosterEmpty={rosterEmpty}
            currency={currency}
            periodFrom={periodFrom}
            onLogged={refetchAll}
          />
        </FadeIn>
      )}

      {/* DETALJER — demoted accountant detail: full per-staff table (responsive)
          + the recent-entries audit trail. Nothing removed, only lowered. */}
      {subTab === "details" && (
        <div className="space-y-4 sm:space-y-6">
          <FadeIn delay={0.1}>
            <HoursSummaryTable
              summary={summary}
              loading={summaryQ.loading || periodLoading}
              failed={summaryFailed}
              onRetry={summaryQ.reload}
              denied={summaryDenied}
              currency={currency}
              onResolved={refetchAll}
              periodFrom={periodFrom}
              periodTo={periodTo}
              onGoLog={() => setSubTab("log")}
              // Løn's cost breakdown (from the owner-only overview), so the
              // per-person gross reconciles to "Samlet lønomkostning".
              costBreakdown={overview?.cost?.basis === "payroll" ? overview.cost.breakdown : null}
            />
          </FadeIn>
          <FadeIn delay={0.15}>
            <RecentHoursLog
              entries={entries}
              loading={entriesQ.loading || periodLoading}
              failed={entriesQ.failed}
              onRetry={entriesQ.reload}
              currency={currency}
              staffList={staffList}
              onUpdated={refetchAll}
            />
          </FadeIn>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MONEY + NARRATIVE HELPERS
   ═══════════════════════════════════════════════════════════ */
// MONEY ON THIS PAGE GOES THROUGH THE HOUSE FORMATTERS — formatOwnerMoney in
// template literals, <Amount> in JSX value slots. Nothing else.
//
// The owner used to read three different kroner on one screen: the Overview
// tiles and the department split printed "12.500 kr" (a local fmtMoneyShort:
// da-DK grouping, no full stop), the Details table one tap away printed
// "12500 DKK" (toFixed(0) + the raw code: no grouping at all), and the Clock
// In/Out preview mixed both inside one parenthesis. Same venue, same period,
// three notations — and fmtMoneyShort turned a MISSING figure into "0 kr",
// which on a pay surface is a number stated as fact about wages nobody
// measured. formatOwnerMoney gives DKK "12.500 kr." and any other currency its
// own locale grouping plus its code, and a missing value "—".
//
// ONE EXCEPTION, AND IT IS THE HOURLY RATE. formatOwnerMoney defaults to whole
// kroner, which is right for a total nobody re-derives. The rate is the one
// figure on this page the owner MULTIPLIES by the hours beside it: base_rate is
// Numeric(10,2), 137,50 kr./t is a rate people really type, and `earned` is
// computed server-side from the exact value. Printing "138 kr./t" next to an
// earned figure derived from 137,50 hands the owner a payroll row they cannot
// reproduce — right notation, wrong number. Whole rates stay clean; øre survive.
function rateDecimals(rate) {
  const n = typeof rate === "string" ? parseFloat(rate) : rate;
  return Number.isInteger(n) ? 0 : 2;
}

// Narrative code → i18n key. The backend rule engine emits codes + params; the
// wording lives here (real en+da) so it stays honest + translatable in one place.
const NAR_KEY = {
  zero: "hovNarZero",
  labor_ok: "hovNarLaborOk",
  labor_watch: "hovNarLaborWatch",
  labor_over: "hovNarLaborOver",
  labor_no_revenue: "hovNarLaborNoRevenue",
  labor_partial: "hovNarLaborPartial",
  labor_no_rates: "hovNarNoRates",
  limit_over: "hovNarLimitOver",
  limit_over_multi: "hovNarLimitOverMulti",
  limit_near: "hovNarLimitNear",
  limit_near_multi: "hovNarLimitNearMulti",
  plan_over: "hovNarPlanOver",
  trend_more: "hovNarTrendMore",
  trend_fewer: "hovNarTrendFewer",
  trend_flat: "hovNarTrendFlat",
  trust_caveat: "hovNarTrustCaveat",
  typed_hours: "hovNarTypedHours",
};

// Hour params that stand ALONE in the sentence — they carry their own unit,
// so the catalogue string must not also spell one.
const NAR_HOUR_PARAMS = new Set(["hours", "diff", "delta"]);
// Hour params inside a ratio, "(38/160 t)". The unit is stated once by the
// string; these are numbers, but they still need the language's decimal mark.
const NAR_HOUR_RATIO_PARAMS = new Set(["actual", "limit"]);

function fillNarrative(t, currencyCode, line, lang) {
  const key = NAR_KEY[line?.code];
  if (!key) return null;
  let s = t(key, line.code);
  const p = line.params || {};
  Object.keys(p).forEach((k) => {
    // Money params carry the currency word. Hour params carry the hour unit
    // and the decimal mark — String(6.8) rendered "6.8" under a Danish "t",
    // which is the same hybrid this page's own hours columns were fixed for.
    let v;
    if (k === "cost" || k === "gross") v = formatOwnerMoney(p[k], currencyCode);
    else if (NAR_HOUR_PARAMS.has(k)) v = formatHours(p[k], { lang });
    else if (NAR_HOUR_RATIO_PARAMS.has(k)) v = formatHoursNumber(p[k], lang);
    else v = String(p[k]);
    s = s.split(`{${k}}`).join(v);
  });
  return s;
}

/* ═══════════════════════════════════════════════════════════
   PERIOD CONTROL — frame picker + prev/next + custom range
   ═══════════════════════════════════════════════════════════ */
// The owner frames the period however they run it (1st–end, 15th→14th, a custom
// start day like the 16th, biweekly) or picks an ad-hoc date range. Recurring
// frames write the SHARED /staff/pay-period config (so Hours + Payroll extract
// the same window); the custom range is a local, non-persisted override.
// The venue's PAY PERIOD — a saved setting, shared with Løn. Kept apart from
// the view-only ranges above it: three testers asked for "last week" and
// tapped "Hver uge (man.–søn.)", which rewrote the venue's pay period for Timer
// and Løn with nothing but a grey "Gemt" to say so.
const PAY_FRAMES = [
  { id: "monthly_1st", key: "hovFrameMonth1" },
  { id: "monthly_15th", key: "hovFrameMonth15" },
  { id: "custom", key: "hovFrameCustom" },
  { id: "weekly", key: "hovFrameWeekly" },
  { id: "biweekly", key: "hovFrameBiweekly" },
];

function PeriodControl({ from, to, loading, onPrev, onNext, isCurrent = true, onCurrent, periodType, savedType = null, customStartDay, onSelectFrame, onCustomRange, onViewRange, saveFailed = false }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  // Which editor sub-panel is open: the custom start-day of the pay period,
  // or the one-off date range. Neither changes anything until confirmed.
  const [editor, setEditor] = useState(null); // null | "custom" | "custom_range"
  const [dayDraft, setDayDraft] = useState(customStartDay || 16);
  const [rangeFrom, setRangeFrom] = useState(from || "");
  const [rangeTo, setRangeTo] = useState(to || "");

  useEffect(() => { if (customStartDay) setDayDraft(customStartDay); }, [customStartDay]);
  useEffect(() => { if (from) setRangeFrom(from); if (to) setRangeTo(to); }, [from, to]);

  const inputCls =
    "border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2.5 py-2 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none";
  const chipCls = (selected) =>
    "min-h-10 sm:min-h-0 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 " +
    (selected
      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
      : "bg-white text-gray-700 border-gray-200 hover:border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 dark:hover:border-gray-500");
  const applyBtnCls =
    "min-h-10 sm:min-h-0 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-4 py-2 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed";

  // The quick range the window on screen IS, if any — marked, so the sheet
  // says what is showing.
  const activeRange = matchViewRange(from, to, today());
  const rangeOk = !!rangeFrom && !!rangeTo && rangeTo >= rangeFrom;
  const applyRange = (e) => {
    e?.preventDefault?.();
    if (!rangeOk) return;
    setEditor(null);
    onCustomRange(rangeFrom, rangeTo);
  };

  // A CHANGE to the venue's pay period asks first. Looking is not saving.
  const changeFrame = async (id, day) => {
    const label = id === "custom"
      ? t("hovFrameCustomDay", "Starts on day {d}", { d: day })
      : t((PAY_FRAMES.find((f) => f.id === id) || {}).key || "", id);
    const ok = await confirm({
      title: t("hovFrameConfirmTitle", "Change the pay period for the whole venue?"),
      message: t("hovFrameConfirmBody", "Hours and Payroll use “{frame}” from now on.", { frame: label }),
      confirmLabel: t("hovFrameConfirmCta", "Change pay period"),
    });
    if (ok !== true) return;
    setEditor(null);
    onSelectFrame(id, day);
  };
  const pickFrame = (id) => {
    if (id === "custom") { setEditor(editor === "custom" ? null : "custom"); return; }
    setEditor(null);
    // The frame already saved: nothing to change — show its current period.
    if (id === savedType) { onCurrent?.(); return; }
    changeFrame(id);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      {/* Row: prev · period label (tap to reframe) · next */}
      <div className="p-3 sm:p-4 flex items-center justify-between gap-2">
        <Button
          variant="ghost" size="sm" onClick={onPrev} disabled={loading}
          title={t("periodPrev", "Previous period")}
          iconLeft={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          }
        >
          <span className="hidden sm:inline">{t("periodPrev", "Previous period")}</span>
          <span className="sm:hidden sr-only">{t("periodPrevShort", "Previous")}</span>
        </Button>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="min-w-0 flex-1 mx-1 rounded-lg px-2 py-1 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          title={t("hovFrameChange", "Change period")}
        >
          {loading ? (
            <div className="h-5 w-40 mx-auto bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          ) : (
            <span className="inline-flex items-center gap-1.5 justify-center min-w-0">
              <span className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {fmtPeriod(from, to)}
              </span>
              <Icon name="CalendarClock" size={14} className="text-gray-400 shrink-0" />
            </span>
          )}
        </button>

        <Button
          variant="ghost" size="sm" onClick={onNext} disabled={loading}
          title={t("periodNext", "Next period")}
          iconRight={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          }
        >
          <span className="hidden sm:inline">{t("periodNext", "Next period")}</span>
          <span className="sm:hidden sr-only">{t("periodNextShort", "Next")}</span>
        </Button>
      </div>

      {/* The way back to now. Silent while the current period IS on screen.
          "Denne periode" under "1. sep. – 30. sep." read as "September is the
          current period" — it now says where it goes. */}
      {!loading && !isCurrent && onCurrent && (
        <div className="px-3 sm:px-4 pb-3 sm:pb-4 -mt-2 flex justify-center">
          <button
            type="button"
            onClick={onCurrent}
            className="inline-flex items-center justify-center gap-1 min-h-[44px] px-3 rounded-lg text-[13px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <Icon name="RotateCcw" size={14} aria-hidden="true" />
            {t("hovToCurrentPeriod", "Back to the current period")}
          </button>
        </div>
      )}

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700 p-3 sm:p-4 space-y-4">
          {/* 1 · LOOK AT — a window on screen, never saved. */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("hovRangeHeading", "Show")}
              </p>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {t("hovRangeNote", "Only changes what you see — not the pay period.")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {VIEW_RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={activeRange === r.id}
                  onClick={() => { setEditor(null); onViewRange?.(r.id); }}
                  className={chipCls(activeRange === r.id)}
                >
                  {t(r.key, r.fallback)}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={editor === "custom_range" || (periodType === "custom_range" && !activeRange)}
                onClick={() => setEditor(editor === "custom_range" ? null : "custom_range")}
                className={chipCls(editor === "custom_range" || (periodType === "custom_range" && !activeRange))}
              >
                {t("hovFrameCustomRange", "Custom dates")}
              </button>
            </div>

            {/* A one-off date range. Enter in either field shows it. */}
            {editor === "custom_range" && (
              <form onSubmit={applyRange} className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="hov-range-from" className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">{t("hovFrameFrom", "From")}</label>
                  <input id="hov-range-from" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label htmlFor="hov-range-to" className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">{t("hovFrameTo", "To")}</label>
                  <input id="hov-range-to" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className={inputCls} />
                </div>
                <button type="submit" disabled={!rangeOk} className={applyBtnCls}>
                  {t("hovFrameApply", "Show these dates")}
                </button>
              </form>
            )}
          </section>

          {/* 2 · THE PAY PERIOD — a saved setting for the whole venue. */}
          <section className="space-y-2 pt-3 border-t border-gray-100 dark:border-gray-700">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("hovPayFrameHeading", "Pay period (saved setting)")}
            </p>
            <div className="flex flex-wrap gap-2">
              {PAY_FRAMES.map((opt) => {
                const selected = savedType === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => pickFrame(opt.id)}
                    aria-pressed={selected}
                    className={chipCls(selected || editor === opt.id)}
                  >
                    {t(opt.key, opt.id)}
                  </button>
                );
              })}
            </div>

            {/* Custom start day — e.g. the 16th → 15th. Saving it asks first. */}
            {editor === "custom" && (
              <form
                onSubmit={(e) => { e.preventDefault(); changeFrame("custom", parseInt(dayDraft, 10) || 1); }}
                className="flex items-end gap-2"
              >
                <div>
                  <label htmlFor="hov-frame-day" className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">
                    {t("hovFrameStartDay", "Starts on day")}
                  </label>
                  <input
                    id="hov-frame-day"
                    type="number" min="1" max="28" value={dayDraft}
                    onChange={(e) => setDayDraft(e.target.value)}
                    className={inputCls + " w-20"}
                  />
                </div>
                <button type="submit" className={applyBtnCls}>
                  {t("save", "Save")}
                </button>
              </form>
            )}

            {/* "Saved — used for Hours and Payroll." is a statement about the
                SERVER, so it may only appear when the write reached it. */}
            {saveFailed ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {t("hovFrameNotSaved", "Not saved — showing here only. Pick the frame again to retry.")}
              </p>
            ) : (
              <p className="text-[11px] text-gray-500 dark:text-gray-400">{t("hovFrameSavedNote", "Saved — used for Hours and Payroll.")}</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOURS OVERVIEW — one-glance narrative + 4 hero tiles
   ═══════════════════════════════════════════════════════════ */
function NarrativeBanner({ lines, severity, currencyCode, inProgress = false }) {
  const { t, lang } = useLanguage();
  if (!lines || lines.length === 0) return null;
  const sevMap = { good: "success", watch: "warn", alert: "critical", info: "info" };
  const iconMap = { success: "CheckCircle2", warn: "AlertTriangle", critical: "AlertTriangle", info: "Clock" };
  const variant = sevMap[severity] || "info";
  const rendered = lines.map((ln) => fillNarrative(t, currencyCode, ln, lang)).filter(Boolean);
  if (rendered.length === 0) return null;
  const [head, ...rest] = rendered;
  // When the period isn't over, close the banner with a muted honesty note so
  // the headline labor % / cost never reads as a settled, final figure.
  const note = inProgress ? t("hovInProgressNote", "Figures so far — the period isn't over yet.") : null;
  return (
    <SectionBanner severity={variant} icon={iconMap[variant]} title={head}>
      {(rest.length > 0 || note) && (
        <div className="space-y-0.5">
          {rest.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {note && <p className="text-gray-500 dark:text-gray-400">{note}</p>}
        </div>
      )}
    </SectionBanner>
  );
}

function HoursOverview({ overview, loading, failed, onRetry, denied, currency, onGoLog, onGoDetails, rosterEmpty = false, needsAnswer = 0, people = [] }) {
  const { t, lang } = useLanguage();

  // THE THIRD STATE, on the tab this hub opens on. `if (!overview) return null`
  // rendered a BLANK page under a working period picker whenever the request
  // failed — a 500, or simply an owner on a train — and on this surface blank
  // reads as "no hours this period", which is the one thing it must not say
  // when it does not know. Failure gets its own words and a retry; when an
  // earlier load did answer, those figures stay on screen and are LABELLED
  // stale rather than blanked, because last week's true numbers beat nothing.
  const failBanner = failed ? (
    <LoadFailed
      onRetry={onRetry}
      body={overview ? t("loadFailedStale", "These are the last figures that loaded — they may be out of date.") : null}
    />
  ) : null;

  // Owner-only by rule, not by accident: this surface carries the venue's
  // labour cost AND its revenue. Say so, rather than rendering nothing — a
  // blank page under a working period picker reads as broken, and the seat
  // that lands here is a manager who came to check a clock-in, so point them
  // at the tab that still answers that.
  //
  // Lifted into a shared component when the wage tabs were hidden from staff
  // seats (2026-09-18): the deep-link floor on /staff/hours?tab=payroll has to
  // say the SAME thing this does, and two copies of one sentence is how the
  // two surfaces start disagreeing.
  if (denied) {
    return (
      <WagePrivacyNotice
        reason={denied}
        actionLabel={t("hovTabPerStaff", "Per staff")}
        onAction={onGoDetails}
      />
    );
  }

  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <div className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }
  // Order matters: the failure is shown INSTEAD of the empty state, never
  // above it. With no figures at all there is nothing to keep, so the banner
  // is the whole answer.
  if (failed && !overview) return failBanner;

  // Not asked yet (the period window is still resolving and the request is
  // held): no answer, so nothing is claimed.
  if (!overview) return null;

  // Empty period → ONE honest card, never four "0"-value tiles that read like a
  // real slow week.
  if (!overview.has_any_hours) {
    // THE GAP, STATED. The payload already carries hours.scheduled_total — the
    // roster's planned hours for this window — and this branch used to return
    // before anything read it, so on the one screen where "93,8 t planned,
    // 0 t logged" IS the whole story, the owner was told only "no hours logged
    // yet". That single unrendered figure is the difference between a closed
    // schedule→clock-in→payroll loop and an open one: nothing else on the
    // surface announces that the two halves disagree.
    const plannedT = (overview.hours || {}).scheduled_total;
    return (
      <div className="space-y-4">
      {failBanner}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
        <Icon name="Clock" size={28} className="text-gray-400 mx-auto mb-2" />
        <p className="text-gray-800 dark:text-gray-100 font-medium">{t("hovEmptyTitle", "No hours logged yet for this period")}</p>
        {plannedT > 0 && (
          <p className="text-gray-800 dark:text-gray-100 text-sm mt-2">
            {t("hovEmptyPlanned", "{planned} planned on the schedule · nothing clocked yet")
              .split("{planned}").join(fmtHours(plannedT, lang))}
          </p>
        )}
        {/* THE CTA MUST MATCH THE ACTUAL BLOCKER.
            With nobody on the roster, "Registrér timer" opens a form whose
            name picker is empty and whose submit button can never light up —
            the front door of this job ending in a wall. The prerequisite is
            a staff member, so that is what the button offers, and it goes to
            the roster on Vagtplan, which is the one place BonBox adds one. */}
        {rosterEmpty ? (
          <>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
              {t("hovEmptyNoStaff", "Hours are logged against a person, and there is nobody on the roster yet.")}
            </p>
            <Link
              to="/staff/schedule"
              className="mt-4 inline-flex items-center gap-1.5 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-4 py-2 rounded-lg transition"
            >
              {/* "Plus", not "UserPlus": Icon's map carries ~50 curated names
                  and falls back to a generic circle for anything else, so a
                  name that is not in it degrades silently into the wrong
                  glyph. Checked against components/ui/Icon.jsx. */}
              <Icon name="Plus" size={15} aria-hidden="true" />
              {t("hovEmptyAddStaff", "Add a staff member")}
            </Link>
            <p className="text-gray-400 dark:text-gray-500 text-xs mt-2">
              {t("hovEmptyAddStaffWhere", "Under Manage staff on the Schedule page.")}
            </p>
          </>
        ) : (
          <>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{t("hovEmptyBody", "Log hours or confirm the schedule to see cost and labor %.")}</p>
            {onGoLog && (
              <button
                type="button"
                onClick={onGoLog}
                className="mt-4 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-4 py-2 rounded-lg transition"
              >
                {t("logHours", "Log hours")}
              </button>
            )}
          </>
        )}
      </div>
      </div>
    );
  }

  const hours = overview.hours || {};
  const cost = overview.cost || {};
  const labor = overview.labor || {};
  const flags = overview.flags || {};
  const period = overview.period || {};
  const measuredPct = Math.round((hours.measured_share || 0) * 100);
  // Older payloads lack has_basis → assume true (back-compat).
  const hasCostBasis = cost.has_basis !== false;
  // In-progress periods are labelled everywhere (not just the Hours tile) so no
  // figure ever reads as a final total.
  const soFar = period.is_complete ? "" : ` · ${t("hovSoFar", "so far")}`;

  // Tile 1 — Timer (volume, never colored).
  const hoursHelperBase =
    hours.scheduled_total > 0
      // The unit comes off the formatter, not out of the sentence: the
      // catalogue used to carry a literal " t" here, so an English session read
      // "of 93,8 t planned" with a Danish unit and an unformatted number.
      ? t("hovTileHoursSub", "{measured}% clocked · of {scheduled} planned")
          .split("{measured}").join(measuredPct)
          .split("{scheduled}").join(formatHours(hours.scheduled_total, { lang }))
      : t("hovTileHoursSubNoPlan", "{measured}% clocked").split("{measured}").join(measuredPct);
  const hoursHelper = `${hoursHelperBase}${soFar}`;

  // Tile 2 — Lønudgift. With no configured wage rate gross=0 → show a neutral
  // "set wage rates" state instead of a misleading ~0 kr.
  // The em-dash branch is new: fmtMoneyShort coerced a missing figure to zero,
  // so a payload that carried no cost at all rendered "~0 kr" — a venue told
  // it paid nothing for a period nobody had actually costed.
  let costValue = cost.loaded_est == null ? "—" : `~${formatOwnerMoney(cost.loaded_est, currency)}`;
  // ONE COST NUMBER. With basis "payroll" the server computed this with the
  // very function behind Løn's "Samlet lønomkostning" (bruttoløn + feriepenge
  // + ATP), so the two tabs say the same kroner. The gross × 1,125 fallback
  // (no DK payroll, or it could not run) still says it leaves ATP out.
  const isPayrollCost = cost.basis === "payroll";
  let costHelper = `${isPayrollCost
    ? t("hovTileCostSubTotal", "gross pay + holiday pay + ATP · estimate")
    : t("hovTileCostSubAtp", "incl. holiday pay · excl. ATP · estimate")}${soFar}`;
  // Someone worked with no wage on file: the figure is short by their pay.
  if (hasCostBasis && cost.unpriced_count > 0) {
    costHelper = t("hovTileCostUnpriced", "excl. {n} without a wage — set their rate", { n: cost.unpriced_count });
  }
  if (!hasCostBasis) {
    costValue = "—";
    costHelper = t("hovTileCostNoRates", "set wage rates");
  }

  // Tile 3 — Lønprocent (the one status-colored money tile).
  const pct = labor.pct_loaded;
  const target = labor.target_pct != null ? labor.target_pct : 0.30;
  let pctValue = "—";
  let pctAccent = "neutral";
  // Two honest "no %" reasons: no wage rates configured vs no revenue yet.
  let pctHelper = hasCostBasis
    ? t("hovTileLaborPctNone", "Waiting for sales")
    : t("hovTileLaborPctNoRates", "set wage rates");
  if (labor.partial && labor.pct_covered != null) {
    // Hours for only part of the revenue days: the covered-days figure, never
    // green — a whole-month % sat green under a banner saying 18 %.
    pctValue = pctText(Math.round(labor.pct_covered * 100), lang);
    pctHelper = t("hovTileLaborPartial", "on {covered} of {days} days with hours", { covered: labor.covered_days, days: labor.revenue_days });
    pctAccent = "warn";
  } else if (pct != null) {
    pctValue = pctText(Math.round(pct * 100), lang);
    pctHelper = `${t("hovTileLaborPctSub", "of revenue · target {target}%").split("{target}").join(Math.round(target * 100))}${soFar}`;
    if (pct <= target) pctAccent = "success";
    else if (pct <= target + 0.05) pctAccent = "warn";
    else pctAccent = "critical";
  }

  // Tile 4 — Overarbejde & grænser.
  const over = flags.over_limit || [];
  const near = flags.near_limit || [];
  const ot = flags.overtime_hours || 0;
  let limVal = "0";
  let limAccent = "neutral";
  let limHelper = t("hovLimitsNone", "all under limit");
  if (flags.limits_configured === 0) {
    // No limit on anyone: there is nothing to be "under" — and the tile says
    // where to set one instead of being a dead end.
    limVal = "—";
    limHelper = (
      <Link to="/staff/schedule" className="underline underline-offset-2 hover:no-underline">
        {t("hovLimitsSetLink", "set limits under Staff")}
      </Link>
    );
  }
  if (over.length > 0) {
    limAccent = "critical";
    limVal = String(over.length);
    limHelper = over.length === 1 ? `${over[0].name} · ${over[0].actual}/${formatHours(over[0].limit, { lang })}` : t("hovLimitsOver", "{n} over limit").split("{n}").join(over.length);
  } else if (near.length > 0) {
    limAccent = "warn";
    limVal = String(near.length);
    limHelper = near.length === 1 ? `${near[0].name} · ${near[0].actual}/${formatHours(near[0].limit, { lang })}` : t("hovLimitsNear", "{n} near limit").split("{n}").join(near.length);
  } else if (ot > 0) {
    limAccent = "warn";
    limVal = formatHours(ot, { lang });
    limHelper = t("hovOvertimeHrs", "{n} overtime").split("{n}").join(formatHours(ot, { lang }));
  }

  return (
    <div className="space-y-4">
      {/* Stale-but-true beats blank: the tiles below are the last figures that
          actually came back, and this says so rather than letting them read as
          current. */}
      {failBanner}
      {/* The open work leads: the unanswered shifts lived only on the
          per-staff tab while this landing tab said "God kontrol". */}
      {needsAnswer > 0 && (
        <button
          type="button"
          onClick={onGoDetails}
          className="w-full flex items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-left text-sm text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
        >
          {/* WHAT is wrong, not only that something is: "N vagter mangler
              dit svar" never said whether a clock-out or a whole shift was
              missing. */}
          <span className="font-medium">{answerKindsText(people, t) || (needsAnswer === 1
            ? t("hovNeedsAnswerOne", "1 shift needs your answer")
            : t("hovNeedsAnswerN", "{n} shifts need your answer", { n: needsAnswer }))}</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
      <NarrativeBanner lines={overview.narrative} severity={overview.banner_severity} currencyCode={currency} inProgress={!period.is_complete} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          dense
          label={t("hovTileHours", "Hours")}
          value={formatHours(hours.actual_total, { lang })}
          helper={hoursHelper}
        />
        <StatCard
          dense
          label={isPayrollCost ? t("hovTileCostTotal", "Total labour cost") : t("hovTileCost", "Labor cost")}
          value={costValue}
          helper={costHelper}
        />
        <StatCard
          dense
          label={t("hovTileLaborPct", "Labor %")}
          value={pctValue}
          accent={pctAccent}
          helper={pctHelper}
        />
        <StatCard
          dense
          label={t("hovTileLimits", "Overtime & limits")}
          value={limVal}
          accent={limAccent}
          helper={limHelper}
        />
      </div>

      {/* Who worked how much — the question the hub is opened for. It took a
          second tap, onto "Pr. medarbejder", to see a single name. */}
      <WhoWorkedCard people={people} currency={currency} onGoDetails={onGoDetails} breakdown={isPayrollCost ? cost.breakdown : null} />

      {overview.labor_split && <LaborSplitCard split={overview.labor_split} currency={currency} />}
    </div>
  );
}

function WhoWorkedCard({ people = [], currency, onGoDetails, breakdown = null }) {
  const { t, lang } = useLanguage();
  const worked = (people || [])
    .filter((p) => Number(p.actual_hours || p.total_hours || 0) > 0)
    .sort((a, b) => Number(b.actual_hours || 0) - Number(a.actual_hours || 0));
  if (!worked.length) return null;
  const shown = worked.slice(0, 6);
  const showMoney = shown.some((p) => p.earned != null);
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
      <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("hovWhoWorked", "Who worked")}</h3>
        {onGoDetails && (
          <button type="button" onClick={onGoDetails}
            className="min-h-10 sm:min-h-0 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white inline-flex items-center gap-1">
            {worked.length > shown.length
              ? t("hovSeeAllN", "See all {n}", { n: worked.length })
              : t("hovSeeDetails", "Per staff")}
            <Icon name="ChevronRight" size={14} />
          </button>
        )}
      </div>
      {/* The money column says what it is: bruttoløn, before feriepenge and
          ATP — the line under the list adds those up to the cost tile. */}
      <div className="px-4 sm:px-5 pt-2 flex items-center justify-end gap-3 text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        <span>{t("hovColHours", "Hours")}</span>
        {showMoney && <span className="w-24 text-right">{t("shpColGross", "Gross pay")}</span>}
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {shown.map((p) => (
          <li key={p.staff_id} className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3 text-sm tabular-nums">
            <span className="min-w-0 truncate text-gray-800 dark:text-gray-100">{p.staff_name}</span>
            <span className="shrink-0 flex items-center gap-3">
              <span className="font-semibold text-gray-900 dark:text-white">{formatHours(Number(p.actual_hours || 0), { lang, decimals: 2 })}</span>
              {/* Money only where it may be shown; a redacted seat sees hours. */}
              {p.earned != null && (
                <span className="w-24 text-right text-gray-600 dark:text-gray-300">
                  <Amount value={p.earned} currency={currency} decimals={2} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {showMoney && breakdown && (
        <CostReconcileLine breakdown={breakdown} people={people} currency={currency} className="px-4 sm:px-5 py-2.5 border-t border-gray-100 dark:border-gray-700" />
      )}
    </div>
  );
}

/** "Bruttoløn 44.317,67 kr. + feriepenge 5.539,70 kr. + ATP 189,33 kr. =
 *  50.046,70 kr." — so the per-person gross adds up to the cost tile and to
 *  Løn's "Samlet lønomkostning". Testers found three different answers to
 *  "what did it cost me" on two tabs, none of them explaining the others.
 *  The figures are the server's own (overview cost.breakdown, from the payroll
 *  computation Løn uses) — never re-derived here. Anyone whose hours are on
 *  this screen but not on the payroll (deactivated) is named, so a difference
 *  between the rows and the line is explained rather than silent. */
function CostReconcileLine({ breakdown, people = [], currency, className = "" }) {
  const { t } = useLanguage();
  if (!breakdown || breakdown.total == null) return null;
  const m = (v) => formatOwnerMoney(v, currency, { decimals: 2 });
  const offPayroll = (people || []).filter(
    (p) => p.on_payroll === false && Number(p.earned || 0) > 0,
  );
  return (
    <div className={`text-[12px] text-gray-600 dark:text-gray-400 tabular-nums ${className}`} data-testid="cost-reconcile">
      <p>
        {t("hovCostReconcile", "Gross pay {gross} + holiday pay {ferie} + ATP {atp} = {total}", {
          gross: m(breakdown.gross), ferie: m(breakdown.feriepenge), atp: m(breakdown.atp), total: m(breakdown.total),
        })}
      </p>
      {offPayroll.length > 0 && (
        <p className="mt-0.5">
          {t("hovCostOffPayroll", "Not on the payroll (inactive), so not in the total: {names}", {
            names: offPayroll.map((p) => p.staff_name).join(", "),
          })}
        </p>
      )}
    </div>
  );
}

/** "2 glemte udstemplinger · 3 uden stempling" — the parts that are not zero. */
function answerKindsText(rows, t) {
  let forgot = 0;
  let missing = 0;
  for (const r of rows || []) {
    for (const e of r.exceptions || []) {
      if (e.state === "forgot_clock_out") forgot += 1;
      else if (e.state === "no_clock_in") missing += 1;
    }
  }
  const parts = [];
  if (forgot > 0) {
    parts.push(forgot === 1
      ? t("hovForgotOutOne", "1 forgotten clock-out")
      : t("hovForgotOutN", "{n} forgotten clock-outs", { n: forgot }));
  }
  if (missing > 0) {
    parts.push(missing === 1
      ? t("hovNoClockInOne", "1 not clocked in")
      : t("hovNoClockInN", "{n} not clocked in", { n: missing }));
  }
  return parts.join(" · ");
}

/* Department cost split — reuses the shift-planner's per-vertical role categories
   so "kitchen" means the same thing on both surfaces. Labels adapt to the vertical
   (a salon shows "Stylists", not "Specialists"). */
const _DEPT_LABEL = {
  front_of_house: ["laborCatFront", "Front of house"],
  kitchen: ["laborCatKitchen", "Kitchen"],
  support: ["laborCatSupport", "Support"],
  specialist: ["laborCatSpecialist", "Specialists"],
  unassigned: ["laborCatUnassigned", "Unassigned"],
};
const _DEPT_LABEL_OVERRIDE = {
  salon: { front_of_house: ["laborCatReception", "Reception"], specialist: ["laborCatStylists", "Stylists"] },
  retail: { front_of_house: ["laborCatSalesFloor", "Sales floor"], specialist: ["laborCatManagement", "Management"] },
  grocery: { front_of_house: ["laborCatSalesFloor", "Sales floor"], specialist: ["laborCatManagement", "Management"] },
  workshop: { front_of_house: ["laborCatServiceDesk", "Service desk"], specialist: ["laborCatWorkshop", "Workshop"] },
};
function deptLabel(vertical, category, t) {
  const ov = _DEPT_LABEL_OVERRIDE[vertical] && _DEPT_LABEL_OVERRIDE[vertical][category];
  const pair = ov || _DEPT_LABEL[category];
  return pair ? t(pair[0], pair[1]) : category;
}

function LaborSplitCard({ split, currency }) {
  const { t, lang } = useLanguage();
  // Backend only sends this when cost genuinely splits across ≥2 departments;
  // guard anyway so a stale/partial payload can never render a lone bar.
  if (!split || !Array.isArray(split.categories) || split.categories.length < 2) return null;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("laborSplitTitle", "Where the payroll goes")}
        </h3>
        {/* honest caption: primary-role attribution + feriepenge estimate */}
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {t("laborSplitBasis", "by primary role · estimate")}
        </span>
      </div>
      <div className="space-y-2.5">
        {split.categories.map((c) => {
          const pct = Math.round((c.pct_of_cost || 0) * 100);
          return (
            <div key={c.category}>
              <div className="flex items-baseline justify-between text-sm mb-1">
                <span className="text-gray-700 dark:text-gray-200">{deptLabel(split.vertical, c.category, t)}</span>
                <span className="tabular-nums">
                  {/* Was fmtMoneyShort ("12.500 kr"), which disagreed with the
                      Details table's "12500 DKK" for the same kroner. */}
                  <span className="text-gray-900 dark:text-gray-100 font-medium">
                    ~<Amount value={c.loaded} currency={currency} />
                  </span>
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{pctText(pct, lang)}</span>
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div className="h-full rounded-full bg-gray-800 dark:bg-gray-300" style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOURS SUMMARY TABLE
   ═══════════════════════════════════════════════════════════ */

/** Shift state → how the row should SPEAK.
 *
 *  The server computes this per shift and hands us the worst one, because a
 *  period-level signed diff cannot express it: a no-show plus a later double
 *  nets to zero and renders as "worked exactly as scheduled". No colour fixes
 *  a number that is genuinely zero, so the number is not what carries meaning
 *  here — the word is.
 *
 *  Colour law:
 *    amber   = needs an answer from you. Nothing else in the table is amber.
 *    red     = a statutory limit is breached.
 *    grey    = the clock measured this. A fact, neither achievement nor fault.
 *    emerald = LIVE, on the clock right now. Never "good", never a past shift.
 *  The old cell painted every negative diff emerald, so a no-show wore the
 *  colour of success. Emerald is spent on exactly one state now.
 */
function shiftStateMeta(state, t) {
  switch (state) {
    case "forgot_clock_out":
      // Clocked in on a day that's over and never out: needs the end time.
      // Red: an open punch is a real problem — unknown hours on a pay record,
      // and it blocks approval. A shift that needs an answer stays amber.
      return {
        label: t("shpStateForgotOut", "No clock-out"),
        cls: "text-red-700 dark:text-red-400",
        needsAnswer: true,
      };
    case "no_clock_in":
      return {
        // The clock measured nothing. That is ALL it knows. "Didn't show up" is
        // a judgement about a person and only the owner may make it.
        label: t("shpStateNoClockIn", "Not clocked in"),
        cls: "text-amber-600 dark:text-amber-400",
        needsAnswer: true,
      };
    case "short":
      return { label: t("shpStateShort", "Left early"), cls: "text-gray-600 dark:text-gray-300" };
    case "over":
      return { label: t("shpStateOver", "Stayed longer"), cls: "text-gray-600 dark:text-gray-300" };
    case "unplanned":
      return { label: t("shpStateUnplanned", "Not scheduled"), cls: "text-gray-600 dark:text-gray-300" };
    case "running":
      return { label: t("shpStateRunning", "On the clock"), cls: "text-emerald-600 dark:text-emerald-400" };
    default:
      return null;     // "matched" — the boring majority stays silent
  }
}

/** What the owner ALREADY decided about a shift — the other half of the tick.
 *
 *  resolve() has taken confirm / adjust / absent for a long time and wrote
 *  resolution, resolved_by, resolved_at on the row. None of it was ever
 *  rendered, so answering a shift only made the amber go away: there was no
 *  way to tell "I checked this and it is right" from "I have not looked yet".
 *
 *  GREY, deliberately, and never emerald. The colour law above spends emerald
 *  on exactly one state — LIVE, on the clock right now — precisely because an
 *  earlier version painted every negative diff emerald and a no-show wore the
 *  colour of success. A resolution is a fact about what the owner decided, and
 *  grey is this table's colour for a fact.
 */
function resolutionMeta(resolution, t) {
  switch (resolution) {
    case "confirmed":
      return { label: t("shpStateConfirmed", "Checked"), icon: "Check" };
    case "adjusted":
      return { label: t("shpStateAdjusted", "Adjusted by you"), icon: "PencilLine" };
    case "absent":
      return { label: t("shpStateAbsentMark", "Marked absent"), icon: "MinusCircle" };
    default:
      return null;     // unanswered — the amber state above already says so
  }
}

/** Danish writes 7 t — not 7.0h.
 *
 *  This used to be the whole implementation, and the page then bypassed it
 *  seven times with `toFixed(1) + "h"` — so one cell of the summary table read
 *  "38,0 t" and the cell beside it read "38.0h", while Vagtplan printed "38h"
 *  for the same week. The rules now live in utils/hours.js, which both pages
 *  read. This wrapper stays only so the existing call sites keep their shape.
 */
function fmtHours(n, lang) {
  // 2 decimals, matching what the endpoints now report and what total_hours is
  // stored at. At 1 decimal a 6,85 h row printed "6,9 t" while the Total below
  // it summed the real values to 19,3 — the column did not add up to its own
  // footer, and "0,6 t x 145 kr./h" did not produce the 83 kr. printed beside
  // it. A pay-facing column has to survive being checked by hand.
  return formatHours(n, { lang, decimals: 2 });
}


/** Settle one shift. Three things the owner can say, and the system says none
    of them by itself.

    Batch navigation is fine; a batch decision only ever after a confirm that
    LISTS what it decides ("Alle uden stempling: som planlagt" names every
    person, day and planned time first) — a single tap that accepts twelve
    shifts the owner never saw is the rubber stamp this feature replaces.
*/
/** The first shift worth asking about. Unanswered punches outrank measured
    deviations — only one of them needs a human. */
function firstException(row) {
  const ex = row.exceptions || [];
  return ex.find((e) => e.state === "forgot_clock_out")
    || ex.find((e) => e.state === "no_clock_in") || ex[0] || null;
}

// The pause a forgotten clock-out can be given. The planned break joins the
// list when it is none of these (a 20-minute plan stays 20).
const PAUSE_CHOICES = [0, 15, 30, 45, 60];
// After a save, the next person's sheet ignores its buttons this long: a
// tester's double-tap nearly saved Tina's pay with Tilde's answer.
const NEXT_SHEET_GUARD_MS = 600;

function hhmmToMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** One answered shift, for the "Gemt · Tilde · 16:58–23:00 · 5,28 t" line. */
function savedDetail(action, data, local, t, lang) {
  const hrs = (v) => (v != null ? fmtHours(Number(v), lang) : "");
  if (action === "clock_out" || action === "as_planned") {
    const st = data?.start_time || local.start;
    const en = data?.end_time || local.end;
    return [st && en ? `${st}–${en}` : "", hrs(data?.total_hours ?? local.hours)].filter(Boolean).join(" · ");
  }
  if (action === "adjust") return hrs(data?.total_hours ?? local.hours);
  if (action === "absent") return t("shpSavedAbsent", "did not work");
  return t("shpSavedConfirmed", "record is correct");
}

function ResolveSheet({ staffId, staffName, exception, onClose, onResolved, position = null, saved = null }) {
  const { t, lang } = useLanguage();
  const [hours, setHours] = useState(
    exception?.scheduled_hours != null ? String(exception.scheduled_hours) : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The measured start, editable: a 16:58 punch for a 17:00 shift crossed
  // the 6-hour pause line by three minutes and paid less than a 5:59 one.
  const [startTime, setStartTime] = useState(exception?.start_time || "");
  // Prefilled with the planned end — most forgotten clock-outs ended on time.
  const [endTime, setEndTime] = useState(exception?.scheduled_end || "");
  const [longConfirm, setLongConfirm] = useState(false);
  // null = the default pause (the plan's break, else the DK suggestion).
  const [pauseChoice, setPauseChoice] = useState(null);
  const firstInputRef = useRef(null);
  // When this sheet appeared — set on mount, read by the double-tap guard.
  const armedAt = useRef(0);

  const forgotOut = exception?.state === "forgot_clock_out";
  const isMissing = exception?.state === "no_clock_in";
  const hasPlan = !!(exception?.scheduled_start && exception?.scheduled_end);

  // The pause, and where its default came from — said in one line, because
  // a deduction nobody can see or change is how the sheet lost trust.
  // A planned shift's break is the plan — INCLUDING a planned 0. Treating 0
  // as "no plan" pre-picked 45 min and paid a 17–23 shift as 5,28 t.
  const plannedBreak = hasPlan && exception?.scheduled_break_minutes != null
    && Number.isFinite(Number(exception.scheduled_break_minutes))
    ? Number(exception.scheduled_break_minutes)
    : null;
  const startMin = hhmmToMin(startTime);
  const endMin = hhmmToMin(endTime);
  const gross = (() => {
    if (startMin == null || endMin == null) return null;
    let mins = endMin - startMin;
    if (mins < 0) mins += 24 * 60;          // overnight
    return mins / 60;
  })();
  const suggested = gross != null && gross >= 6 ? 45 : 0;
  const pause = pauseChoice != null ? pauseChoice : (plannedBreak != null ? plannedBreak : suggested);
  const pauseSource = pauseChoice != null ? null : (plannedBreak != null ? "plan" : "rule");
  const pauseOptions = plannedBreak != null && !PAUSE_CHOICES.includes(plannedBreak)
    ? [...PAUSE_CHOICES, plannedBreak].sort((a, b) => a - b)
    : PAUSE_CHOICES;
  const pauseTooLong = gross != null && gross > 0 && pause >= gross * 60;
  const paid = gross != null ? Math.max(0, gross - pause / 60) : null;
  const canSaveOut = !busy && !longConfirm && gross != null && gross > 0 && !pauseTooLong;
  const startMoved = !!exception?.start_time && startTime !== exception.start_time;

  // Keyboard: the first field has the focus, Enter saves (each answer is a
  // form), Esc closes. Focus goes back to the opener — the parent does that.
  useEffect(() => {
    armedAt.current = Date.now();
    firstInputRef.current?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const send = async (action, payload = {}) => {
    if (busy) return;
    // The sheet that just replaced a saved one ignores a second tap.
    if (saved && Date.now() - armedAt.current < NEXT_SHEET_GUARD_MS) return;
    setBusy(true); setErr("");
    try {
      const res = await api.post("/staff/hours/resolve", {
        staff_id: staffId,
        date: exception.date,
        action,
        ...payload,
      });
      onResolved(savedDetail(action, res?.data, {
        start: payload.start_time || exception?.scheduled_start,
        end: payload.end_time || exception?.scheduled_end,
        hours: payload.total_hours ?? (action === "clock_out" ? paid : exception?.scheduled_hours),
      }, t, lang));
    } catch (e) {
      const d = e?.response?.data?.detail;
      if (e?.response?.status === 409 && d?.code === "long_shift") {
        // Over 16 h is usually a typo (16:30 for a 17:00 start wraps to
        // 23,5 t and pays it). Ask once; the next tap confirms.
        setLongConfirm(true);
        setErr(t("shpResolveLongShiftCheck", "That makes {h} hours — check the time.", { h: String(d.hours).replace(".", ",") }));
        setBusy(false);
        return;
      }
      // Surfaced, never swallowed — a failed save must not look like a
      // successful one on a pay record.
      setErr(houseErrText(e, t("shpResolveFailed", "Could not save. Try again.")));
      setBusy(false);
    }
  };
  const outPayload = (confirmLong = false) => ({
    end_time: endTime,
    ...(startTime ? { start_time: startTime } : {}),
    break_minutes: pause,
    confirm_long: confirmLong,
  });

  const timeCls = "w-full px-3 py-2 min-h-10 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 tabular-nums outline-none focus:ring-2 focus:ring-gray-400";

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog" aria-modal="true" aria-labelledby="resolve-sheet-name"
        className="relative w-full sm:max-w-sm max-h-[92vh] overflow-y-auto bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl p-5"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        {/* What was just saved, and that THIS is somebody else. The sheet
            used to swap the next person in under the same button, silently. */}
        {saved && (
          <p className="mb-3 -mt-1 flex items-center gap-1.5 text-[13px] text-emerald-700 dark:text-emerald-400 tabular-nums" role="status">
            <Icon name="CheckCircle2" size={15} className="shrink-0" />
            <span className="min-w-0">{t("shpSavedLine", "Saved · {name} · {detail}", { name: saved.name, detail: saved.detail })}</span>
          </p>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <h3 id="resolve-sheet-name" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {saved && <span className="font-normal text-gray-500 dark:text-gray-400">{t("shpNextLabel", "Next:")} </span>}
            {staffName}
          </h3>
          {position && position.n > 1 && (
            <span className="text-[12px] text-gray-500 dark:text-gray-400 tabular-nums shrink-0">
              {t("shpResolvePos", "{i} of {n}", { i: position.i, n: position.n })}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {fmtDateFull(exception.date)} ·{" "}
          {hasPlan
            ? t("shpPlannedTimes", "planned {start}–{end}", { start: exception.scheduled_start, end: exception.scheduled_end })
            : t("shpScheduledShort", "{h} scheduled").replace("{h}", fmtHours(exception.scheduled_hours, lang))}
        </p>

        {forgotOut ? (
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => { e.preventDefault(); if (canSaveOut) send("clock_out", outPayload()); }}
          >
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t("shpResolveForgotBody", "Clocked in at {start} and never out. When did the shift end?", { start: exception.start_time || "—" })}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="resolve-start" className="block text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1">
                  {t("shpResolveStartLabel", "Clock-in")}
                </label>
                <input
                  ref={firstInputRef}
                  id="resolve-start" type="time" value={startTime}
                  onChange={(e) => { setStartTime(e.target.value); setLongConfirm(false); setErr(""); }}
                  className={timeCls}
                />
              </div>
              <div>
                <label htmlFor="resolve-end" className="block text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1">
                  {t("shpResolveEndLabel", "Clock-out time")}
                </label>
                <input
                  id="resolve-end" type="time" value={endTime}
                  // A new time is a new question: the "tap again" confirmation
                  // must not carry over to it (16:30 → 16:45 saved 23 t unasked).
                  onChange={(e) => { setEndTime(e.target.value); setLongConfirm(false); setErr(""); }}
                  className={timeCls}
                />
              </div>
            </div>
            {startMoved && (
              <p className="text-[12px] text-gray-500 dark:text-gray-400">
                {t("shpStartMovedNote", "The clock measured {start} — that stays on the record.", { start: exception.start_time })}
              </p>
            )}

            <div>
              <p id="resolve-pause-label" className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("shpPauseLabel", "Break")}
              </p>
              <div role="group" aria-labelledby="resolve-pause-label" className="flex flex-wrap gap-1.5">
                {pauseOptions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={pause === m}
                    onClick={() => { setPauseChoice(m); setLongConfirm(false); setErr(""); }}
                    className={`min-h-10 min-w-[3.25rem] px-2.5 rounded-lg text-[13px] font-medium border tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${
                      pause === m
                        ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                        : "bg-white text-gray-700 border-gray-200 hover:border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
                    }`}
                  >
                    {t("shpPauseMin", "{m} min", { m })}
                  </button>
                ))}
              </div>
              {pauseSource && (
                <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
                  {pauseSource === "plan"
                    ? t("shpPauseFromPlan", "From the schedule: {m} min break.", { m: plannedBreak })
                    : t("shpPauseFromRule", "Standard: 45 min break from 6 hours.")}
                </p>
              )}
            </div>

            {gross != null && gross > 0 && (
              <p className="text-[13px] text-gray-600 dark:text-gray-300 tabular-nums">
                {startTime}–{endTime}
                {pause > 0 && <> = {fmtHours(gross, lang)} − {t("shpResolvePause", "{m} min break", { m: pause })}</>}
                {" = "}<strong className="text-gray-900 dark:text-gray-100">{fmtHours(paid, lang)}</strong>
              </p>
            )}
            {pauseTooLong && (
              <p className="text-[13px] text-amber-700 dark:text-amber-400">{t("shpPauseTooLong", "The break is as long as the shift.")}</p>
            )}
            {err && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{err}</p>}
            <Button type="submit" className="w-full max-sm:h-10" disabled={!canSaveOut}>
              {t("shpResolveSaveOut", "Save clock-out")}
            </Button>
            {longConfirm && (
              <Button variant="secondary" className="w-full" disabled={busy} onClick={() => send("clock_out", outPayload(true))}>
                {t("shpResolveLongYes", "Yes, {h} is right", { h: gross != null ? fmtHours(gross, lang) : endTime })}
              </Button>
            )}
          </form>
        ) : (
          <>
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
              {isMissing
                ? t("shpResolveMissingBody", "The clock recorded nothing for this shift. Only you know what happened.")
                : t("shpResolveShortBody", "The clock recorded {a} of {s}.")
                    .replace("{a}", fmtHours(exception.actual_hours, lang))
                    .replace("{s}", fmtHours(exception.scheduled_hours, lang))}
            </p>

            {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{err}</p>}

            <div className="mt-4 space-y-2">
              {/* The plan, as the answer: start, end and break written as
                  planned — the register keeps the times. */}
              {isMissing && hasPlan && (
                <Button className="w-full max-sm:h-10" disabled={busy} onClick={() => send("as_planned")}>
                  {t("shpResolveAsPlanned", "Worked as planned · {start}–{end}", { start: exception.scheduled_start, end: exception.scheduled_end })}
                </Button>
              )}
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); if (hours && !busy) send("adjust", { total_hours: parseFloat(String(hours).replace(",", ".")) }); }}
              >
                <input
                  ref={firstInputRef}
                  type="number" step="0.25" min="0" max="24" inputMode="decimal"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  aria-label={t("shpResolveHoursLabel", "Hours worked")}
                  className="w-24 px-3 py-2 min-h-10 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 tabular-nums outline-none focus:ring-2 focus:ring-gray-400"
                />
                <Button
                  type="submit"
                  variant={isMissing && hasPlan ? "secondary" : "primary"}
                  className="flex-1 max-sm:h-10"
                  disabled={busy || !hours}
                >
                  {t("shpResolveWorked", "They worked this")}
                </Button>
              </form>
              <Button
                variant="secondary" className="w-full max-sm:h-10" disabled={busy}
                onClick={() => send("absent")}
              >
                {t("shpResolveAbsent", "They did not work")}
              </Button>
              {!isMissing && (
                <Button
                  variant="secondary" className="w-full max-sm:h-10" disabled={busy}
                  onClick={() => send("confirm")}
                >
                  {t("shpResolveConfirm", "The record is correct")}
                </Button>
              )}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full min-h-10 text-center text-sm text-gray-500 dark:text-gray-400 py-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          {t("shpResolveCancel", "Not now")}
        </button>
      </div>
    </div>
  );
}

/** The queue is done — say so, and offer the approval right there. */
function QueueDoneSheet({ saved = null, range, canApprove, busy, onApprove, onClose }) {
  const { t } = useLanguage();
  const btnRef = useRef(null);
  useEffect(() => { btnRef.current?.focus?.(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog" aria-modal="true" aria-labelledby="queue-done-title"
        className="relative w-full sm:max-w-sm bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl p-5"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        {saved && (
          <p className="mb-3 -mt-1 flex items-center gap-1.5 text-[13px] text-emerald-700 dark:text-emerald-400 tabular-nums" role="status">
            <Icon name="CheckCircle2" size={15} className="shrink-0" />
            <span className="min-w-0">{t("shpSavedLine", "Saved · {name} · {detail}", { name: saved.name, detail: saved.detail })}</span>
          </p>
        )}
        <h3 id="queue-done-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t("shpQueueDoneTitle", "Every shift is answered")}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {canApprove
            ? t("shpQueueDoneBody", "Approve {range} now, so the payroll uses these hours.", { range })
            : t("shpQueueDoneNothing", "Nothing left to approve for {range}.", { range })}
        </p>
        <div className="mt-4 space-y-2">
          {canApprove && (
            <Button ref={btnRef} className="w-full max-sm:h-10" busy={busy} onClick={onApprove} iconLeft={<Icon name="Check" size={15} />}>
              {t("shpApprovePeriod", "Approve the period")}
            </Button>
          )}
          <Button ref={canApprove ? undefined : btnRef} variant="secondary" className="w-full max-sm:h-10" onClick={onClose}>
            {t("close", "Close")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Order the per-staff rows the way an owner reads them before paying.
 *
 * Exported so its tests exercise THIS function and not a copy of it — a
 * comparator duplicated into a test file drifts from the shipped one the first
 * time either is edited, and the suite keeps passing while the screen is wrong.
 *
 * Worked first, most hours first, everyone else alphabetical (Danish collation
 * — Æ Ø Å sort after z). Nobody is filtered: a rostered no-show is what the
 * DIFF column is for, and hiding them would hide the shift needing an answer.
 */
export function orderForPaying(summary) {
  const list = [...(summary || [])];
  list.sort((a, b) => {
    const ah = Number(a.actual_hours) || 0;
    const bh = Number(b.actual_hours) || 0;
    if ((ah > 0) !== (bh > 0)) return bh > 0 ? 1 : -1;
    if (ah !== bh) return bh - ah;
    return (a.staff_name || "").localeCompare(b.staff_name || "", "da");
  });
  return list;
}

/** Approving the period — shared by the bar above the table and the sheet
 *  that says the answer queue is done, so both ask and report the same way. */
function usePeriodApproval({ from, to, onChanged }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const range = fmtPeriod(from, to);

  const run = async (path, body, okText) => {
    setBusy(true);
    setNote("");
    try {
      const res = await api.post(`/staff/hours/${path}`, body);
      const text = typeof okText === "function" ? okText(res?.data || {}) : okText;
      if (text) setNote(text);
      onChanged?.();
      return true;
    } catch (e) {
      const d = e?.response?.data?.detail;
      setNote(d?.code === "open_punches"
        ? t("shpApproveOpenPunches", "{n} shifts were never clocked out — fix them first.", { n: d.count })
        : houseErrText(e, t("shpApproveFailed", "Couldn't save the approval. Try again.")));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const approve = async (pending) => {
    const ok = await confirm({
      title: t("shpApproveTitle", "Approve the hours for {range}?", { range }),
      message: t("shpApproveBody", "{n} entries are marked approved and locked. The payroll export uses them. You can undo this.", { n: pending }),
      confirmLabel: t("shpApproveCta", "Approve"),
    });
    if (ok !== true) return false;
    return run("approve", { from, to }, t("shpApprovedDone", "Approved — {range}.", { range }));
  };

  // "Godkend de klare nu": every row with an end time, now; the open
  // questions wait. Said before, and said after — what was left out.
  const approveClear = async ({ ready, forgot, missing }) => {
    const left = [];
    if (forgot > 0) left.push(forgot === 1 ? t("hovForgotOutOne", "1 forgotten clock-out") : t("hovForgotOutN", "{n} forgotten clock-outs", { n: forgot }));
    if (missing > 0) left.push(missing === 1 ? t("hovNoClockInOne", "1 not clocked in") : t("hovNoClockInN", "{n} not clocked in", { n: missing }));
    const leftText = left.join(" · ");
    const ok = await confirm({
      title: t("shpApproveClearTitle", "Approve the clear entries for {range}?", { range }),
      message: t("shpApproveClearBody", "{n} entries are approved and locked now. Waiting for your answer: {left}.", { n: ready, left: leftText }),
      confirmLabel: t("shpApproveClearCta", "Approve the clear ones"),
    });
    if (ok !== true) return false;
    return run("approve", { from, to, skip_open: true }, (d) => t("shpApprovedClearDone", "Approved {n} · still waiting: {left}", {
      n: d.approved ?? ready, left: leftText,
    }));
  };

  const undo = async () => {
    const ok = await confirm({
      title: t("shpUnapproveTitle", "Undo the approval for {range}?", { range }),
      message: t("shpUnapproveBody", "The hours can be changed again. Shifts you answered one by one keep their answer."),
      confirmLabel: t("shpUnapproveCta", "Undo approval"),
      destructive: true,
    });
    if (ok !== true) return false;
    return run("unapprove", { from, to }, "");
  };

  return { busy, note, approve, approveClear, undo, range };
}

/** The approval counts for a set of rows — one definition for the bar, the
 *  "clear ones" button and the done-sheet. */
function approvalCounts(rows) {
  const worked = (rows || []).filter((r) => (r.entries_count || 0) > 0);
  const total = worked.reduce((n, r) => n + (r.entries_count || 0), 0);
  const approved = worked.reduce((n, r) => n + Math.min(r.approved_count || 0, r.entries_count || 0), 0);
  const byApproval = worked.reduce((n, r) => n + (r.period_approved_count || 0), 0);
  let forgot = 0;
  let missing = 0;
  for (const r of rows || []) {
    for (const e of r.exceptions || []) {
      if (e.state === "forgot_clock_out") forgot += 1;
      else if (e.state === "no_clock_in") missing += 1;
    }
  }
  // A forgotten clock-out IS a row (open), and approving skips it; a shift
  // never clocked has no row at all.
  const ready = Math.max(0, total - approved - forgot);
  return { worked: worked.length, total, approved, byApproval, forgot, missing, ready, allApproved: total > 0 && approved >= total };
}

// "These hours are final" for the period. One action for the whole period,
// refused while shifts still need an answer — and that refusal is now a WAY
// IN: "Svar først på de N vagter" opens the answer sheet on the first one,
// and the clear entries can be approved now while the questions wait.
function ApprovalBar({ rows, from, to, needsAnswer = 0, approval, onAnswer, onAnswerAsPlanned, asPlannedCount = 0, bulkBusy = false, bulkNote = "" }) {
  const { t } = useLanguage();
  // A backend without approval sends no counts: say nothing rather than guess.
  if (!from || !to || !(rows || []).some((r) => r.entries_count != null)) return null;
  const c = approvalCounts(rows);
  if (!c.worked && !needsAnswer) return null;
  const { busy, note } = approval;
  const kinds = answerKindsText(rows, t);

  return (
    <div className="px-3 sm:px-5 py-3 border-b border-gray-200 dark:border-gray-700 space-y-2">
      {/* Nothing logged yet (only shifts the clock never saw): no counts and
          no approve — "0 af 0 godkendt" is not a state, the questions are. */}
      {c.total > 0 && (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[13px] text-gray-700 dark:text-gray-300 inline-flex flex-wrap items-center gap-1.5 tabular-nums">
          {c.allApproved && needsAnswer === 0 ? (
            <>
              <Icon name="CheckCircle2" size={16} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="font-medium text-gray-900 dark:text-gray-100">{t("shpApprovedAll", "Approved")}</span>
              <span>· {t("shpApprovedCount", "{a} of {n} entries", { a: c.approved, n: c.total })}</span>
            </>
          ) : (
            <span>{t("shpApprovedCount", "{a} of {n} entries", { a: c.approved, n: c.total })} {t("shpApprovedSuffix", "approved")}</span>
          )}
          {note && <span className="text-gray-600 dark:text-gray-400" role="status">· {note}</span>}
        </p>
        {c.allApproved && needsAnswer === 0 ? (
          c.byApproval > 0 && (
            <Button size="md" variant="ghost" onClick={approval.undo} disabled={busy} className="max-sm:h-10">
              {t("shpUnapproveCta", "Undo approval")}
            </Button>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {needsAnswer > 0 && c.ready > 0 && (
              <Button size="md" variant="secondary" className="max-sm:h-10"
                onClick={() => approval.approveClear(c)} disabled={busy}>
                {t("shpApproveClearCta", "Approve the clear ones")}
              </Button>
            )}
            <Button size="md" variant="primary" onClick={() => approval.approve(c.total - c.approved)}
              disabled={busy || needsAnswer > 0 || c.total - c.approved <= 0} className="max-sm:h-10"
              iconLeft={<Icon name="Check" size={15} />}>
              {t("shpApprovePeriod", "Approve the period")}
            </Button>
          </div>
        )}
      </div>
      )}
      {c.total === 0 && note && (
        <p className="text-[13px] text-gray-600 dark:text-gray-400" role="status">{note}</p>
      )}
      {needsAnswer > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The reason the approval waits, as the way to clear it. */}
          <button
            type="button"
            onClick={onAnswer}
            className="inline-flex items-center gap-1 min-h-10 sm:min-h-0 text-[13px] font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {needsAnswer === 1
              ? t("shpApproveAnswerFirstOne", "Answer the 1 shift first")
              : t("shpApproveAnswerFirst", "Answer the {n} shifts first", { n: needsAnswer })}
            {kinds && <span className="font-normal no-underline">({kinds})</span>}
            <Icon name="ChevronRight" size={14} aria-hidden="true" />
          </button>
          {asPlannedCount > 0 && (
            <Button size="md" variant="ghost" className="max-sm:h-10" onClick={onAnswerAsPlanned} disabled={bulkBusy} busy={bulkBusy}>
              {t("shpBulkPlannedBtn", "All not clocked in: as planned")}
            </Button>
          )}
          {bulkNote && <span className="text-[13px] text-gray-600 dark:text-gray-400" role="status">{bulkNote}</span>}
        </div>
      )}
    </div>
  );
}

function HoursSummaryTable({ summary, loading, failed, onRetry, denied, currency, onResolved, periodFrom = null, periodTo = null, onGoLog = null, costBreakdown = null }) {
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const approval = usePeriodApproval({ from: periodFrom, to: periodTo, onChanged: onResolved });
  // ORDER. The server builds these rows from a set union, so they arrived in
  // no order at all — and on a 16-person roster where two people worked, the
  // fourteen zero-hour rows landed wherever, burying the two the owner is
  // actually about to pay. BonBox does not run payroll; this table IS the
  // thing an owner reads before paying, so it has to lead with the people who
  // have hours.
  //
  // Worked first, most hours first. Everyone else keeps their place below,
  // alphabetically, so the list is stable between loads — a table that
  // reshuffles on every refresh cannot be trusted to have been read.
  // Nobody is hidden: a rostered no-show is exactly what the DIFF column is
  // for, and dropping them would hide the shift that needs an answer.
  const rows = useMemo(() => orderForPaying(summary), [summary]);
  // {staffId, staffName, exception} | "done" (the queue is answered)
  const [resolving, setResolving] = useState(null);
  // What the last save was — shown at the top of the next sheet so a swap to
  // the next person is never silent.
  const [lastSaved, setLastSaved] = useState(null);   // {name, detail}
  // The walk through the queue: how many it held when it was opened, and how
  // many of them are answered — so "2 af 5" does not jump when a reload drops
  // the answered one from the list.
  const [walk, setWalk] = useState(null);             // {total, done}
  // Where the sheet was opened from, to give the focus back on close.
  const openerRef = useRef(null);
  // Every shift that needs the owner's answer, in table order — the sheet
  // walks it ("2 af 5") instead of closing after each one.
  const answerQueue = useMemo(() => rows.flatMap((r) => (r.exceptions || [])
    .filter((e) => e.state === "forgot_clock_out" || e.state === "no_clock_in")
    .map((e) => ({ staffId: r.staff_id, staffName: r.staff_name, exception: e }))), [rows]);
  const sameItem = (a, b) => a && b && String(a.staffId) === String(b.staffId)
    && a.exception?.date === b.exception?.date && a.exception?.state === b.exception?.state;
  const resolvingIdx = resolving && resolving !== "done" ? answerQueue.findIndex((q) => sameItem(q, resolving)) : -1;
  const openSheet = (item) => {
    if (!item) return;
    if (typeof document !== "undefined") openerRef.current = document.activeElement;
    setLastSaved(null);
    const inQueue = answerQueue.some((q) => sameItem(q, item));
    setWalk(inQueue ? { total: answerQueue.length, done: 0 } : null);
    setResolving(item);
  };
  // "Svar først på de N vagter" and the amber count: the FIRST unanswered
  // shift of the period, in table order.
  const openQueue = () => openSheet(answerQueue[0]);
  const closeSheet = () => {
    setResolving(null);
    setLastSaved(null);
    setWalk(null);
    const el = openerRef.current;
    if (el && typeof el.focus === "function" && document.contains(el)) {
      setTimeout(() => el.focus(), 0);
    }
  };
  const afterSave = (detail) => {
    const current = resolving;
    // The next unanswered shift: after this one first, then any before it.
    const idx = answerQueue.findIndex((q) => sameItem(q, current));
    const order = idx >= 0 ? [...answerQueue.slice(idx + 1), ...answerQueue.slice(0, idx)] : [];
    const next = order.find((q) => !sameItem(q, current)) || null;
    setLastSaved({ name: current?.staffName, detail });
    setWalk((w) => (w ? { ...w, done: w.done + 1 } : w));
    onResolved();
    if (walk) setResolving(next || "done");
    else closeSheet();
  };

  // "Alle uden stempling: som planlagt" — every shift the clock never saw
  // and that has a published plan, answered as worked-as-planned through the
  // same resolve path, one request each, after one confirm that lists them.
  const asPlannedList = answerQueue.filter((q) => q.exception.state === "no_clock_in"
    && q.exception.scheduled_start && q.exception.scheduled_end);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState("");
  const answerAllAsPlanned = async () => {
    const list = asPlannedList;
    if (!list.length) return;
    const shown = list.slice(0, 10);
    const ok = await confirm({
      title: list.length === 1
        ? t("shpBulkPlannedTitleOne", "Answer 1 shift as worked as planned?")
        : t("shpBulkPlannedTitle", "Answer {n} shifts as worked as planned?", { n: list.length }),
      message: (
        <>
          {shown.map((q) => (
            <span key={`${q.staffId}-${q.exception.date}`} className="block tabular-nums">
              {q.staffName} · {fmtDate(q.exception.date)} · {q.exception.scheduled_start}–{q.exception.scheduled_end}
            </span>
          ))}
          {list.length > shown.length && (
            <span className="block">{t("shpBulkPlannedMore", "and {n} more", { n: list.length - shown.length })}</span>
          )}
          <span className="block mt-3">
            {t("shpBulkPlannedBody", "Each is saved with its planned times and break. You can change one afterwards.")}
          </span>
        </>
      ),
      confirmLabel: t("shpBulkPlannedCta", "Save as planned"),
    });
    if (ok !== true) return;
    setBulkBusy(true);
    setBulkNote("");
    let done = 0;
    let failedN = 0;
    for (const q of list) {
      try {
        await api.post("/staff/hours/resolve", { staff_id: q.staffId, date: q.exception.date, action: "as_planned" });
        done += 1;
      } catch {
        failedN += 1;
      }
    }
    setBulkBusy(false);
    setBulkNote(failedN > 0
      ? t("shpBulkPlannedPartial", "{done} saved as planned · {failed} could not be saved — answer them one by one.", { done, failed: failedN })
      : t("shpBulkPlannedDone", "{n} saved as planned.", { n: done }));
    onResolved();
  };
  // ?resolve=<staff_id> (the schedule's "no clock-out" chip) opens that
  // person's answer sheet once the rows are here.
  const [resolveParams, setResolveParams] = useSearchParams();
  const resolveId = resolveParams.get("resolve");
  useEffect(() => {
    if (!resolveId || !rows.length) return;
    const row = rows.find((r) => String(r.staff_id) === resolveId);
    const ex = row && firstException(row);
    if (ex) openSheet({ staffId: row.staff_id, staffName: row.staff_name, exception: ex });
    const next = new URLSearchParams(resolveParams);
    next.delete("resolve");
    setResolveParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveId, rows]);
  // Same server field the rows read, so the chip and the rows can never
  // disagree about how many shifts are unanswered.
  const needsAnswer = (summary || []).reduce(
    (n, r) => n + (r.needs_answer_count || 0), 0,
  );
  // WAGE PRIVACY. A manager/cashier/viewer seat still gets this table — it
  // carries the clock-in exception feed they run a shift on — but every money
  // field arrives null (backend redacts on _is_member_view). The rows already
  // print "—" for a null. The TOTALS row did not: `reduce((s, r) => s + (r.x
  // || 0))` turns "you can't see this" into "0 kr.", which is a figure stated
  // as fact and the one thing this page must never do on a pay record.
  const wagesHidden =
    (summary || []).length > 0 && (summary || []).every((r) => r.total == null);
  const { enabled: devShared, locked: devLocked } = useDeviceShare();
  const deviceCurtained = Boolean(devShared && devLocked);
  // The totals used to print "12500 DKK" — no thousands separator and the raw
  // code — under an Overview tile that said "12.500 kr" for the same period.
  // Rendered through <Amount>, the same primitive as the rows it sums: a
  // formatOwnerMoney string here would agree on the NOTATION and disagree on
  // the rendering, leaving "kr." full-size in the tfoot and a de-emphasized
  // whisper in every row above it — one column, two typographies. Amount
  // renders null as "—" on its own, which is exactly the wagesHidden branch.
  // THE THIRD CAUSE OF A NULL RATE, AND IT IS THE ONE THE ROWS GOT WRONG.
  //
  // hourly_rate arrives null for two different reasons. One is redaction —
  // handled by wagesHidden above. The other is that NOBODY EVER SET A RATE for
  // this person, and there the server does something the rows then stated as
  // fact: _pick_rate reads `float(staff.base_rate or 0)`, so every shift they
  // worked was costed at zero and `earned` came back as a real, stored 0. The
  // row printed "— | 0 kr. | 0 kr." — an em-dash admitting the rate is unknown,
  // sitting one cell away from a wage total asserting it is nothing. The owner
  // reads the number, not the dash, and 0 kr. for a person who worked 34 hours
  // is the single most expensive lie this table could tell.
  //
  // Not-known, not zero. A row only qualifies when wages are VISIBLE (so the
  // null is absence, not redaction) and the person actually worked: with no
  // actual hours, 0 kr. is genuinely zero and stays a figure.
  //
  // THE FOURTH CASE, and the one a rate being SET later leaves behind. A row
  // can carry a real hourly_rate and still show earned 0, because `earned` is
  // stored at log time: shifts worked before the rate existed were costed at
  // zero and the figure stuck. The backend now re-costs those the moment a
  // rate is first entered, but a row that predates that repair — or one the
  // bound deliberately would not touch — must not print a confident 0 kr
  // beside hours somebody actually worked.
  const rateMissing = (r) =>
    !wagesHidden &&
    r &&
    (r.actual_hours || 0) > 0 &&
    (r.hourly_rate == null ||
      ((r.earned ?? 0) === 0 && (r.hourly_rate || 0) > 0));
  const missingRateCount = (summary || []).filter(rateMissing).length;
  // THE RATE THAT RECONCILES WITH THE MONEY BESIDE IT.
  //
  // This file already states the rule, at the rateDecimals() comment: the rate
  // is "the one figure on this page the owner MULTIPLIES by the hours beside
  // it", and printing one that does not reproduce `earned` "hands the owner a
  // payroll row they cannot reproduce". That was written about øre rounding.
  // The same defect arrives much larger through `earned` being STORED:
  //
  //   16 t · 190 kr./t · 2.400 kr.        16 × 190 = 3.040, not 2.400
  //
  // Both numbers are individually true — 190 is today's rate, and the shifts
  // were really costed at 150 before the raise — but the row does not add up,
  // and an owner checking the arithmetic concludes the payroll is broken.
  //
  // So show what these hours ACTUALLY cost: earned ÷ hours. It reconciles by
  // construction, and it is more accurate than base_rate even without a raise,
  // because an evening or weekend premium already makes the two differ.
  // Falls back to the stated rate when there is nothing to divide.
  const effectiveRate = (r) => {
    const h = Number(r?.actual_hours) || 0;
    const e = Number(r?.earned) || 0;
    if (h > 0 && e > 0) return e / h;
    return r?.hourly_rate ?? null;
  };

  // The totals used to print "12500 DKK" — no thousands separator and the raw
  // code — under an Overview tile that said "12.500 kr" for the same period.
  // Rendered through <Amount>, the same primitive as the rows it sums: a
  // formatOwnerMoney string here would agree on the NOTATION and disagree on
  // the rendering, leaving "kr." full-size in the tfoot and a de-emphasized
  // whisper in every row above it — one column, two typographies. Amount
  // renders null as "—" on its own, which is exactly the wagesHidden branch.
  //
  // `unknowable`: a wage column whose rows are not all knowable has no honest
  // total. Summing the rest would print a confident figure that is short by
  // however much the rateless staff are owed — worse than the "—" here,
  // because it looks complete. Tips are recorded money and are never affected,
  // so that column keeps its total; the note under the table names the reason
  // and links to the fix, so the dash is never the end of the road.
  // Øre, like every row above it and like the Løn tab: whole kroner made the
  // rows (7.688) disagree with Løn (7.687,50) and sum to 23.202 under a
  // total of 23.201. A column of nothing but "—" totals to "—", not 0 kr.
  const moneyTotal = (key, unknowable = false) => (
    <Amount
      value={
        wagesHidden || unknowable || (summary || []).every((r) => r[key] == null)
          ? null
          : (summary || []).reduce((s, r) => s + (r[key] || 0), 0)
      }
      currency={currency}
      decimals={2}
    />
  );
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-40 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  // A REFUSAL IS NOT AN ABSENCE. "Ingen timer registreret denne periode" over a
  // RecentHoursLog that is still listing this month's real entries is a screen
  // stating a falsehood — and that is exactly what happened the one round
  // /hours/summary was prefix-denied. The endpoint is redacted per field now,
  // so this branch should stay unreached; it is the guard that makes bringing
  // the deny back a visible change rather than a silent lie.
  if (denied) {
    return <WagePrivacyNotice reason={denied} />;
  }

  // AND NEITHER IS A FAILED REQUEST. This is the site the audit found: a 500 or
  // an offline phone left `summary` at [] and the owner read "Ingen timer
  // registreret denne periode" — a statement of fact about a period nobody had
  // managed to look at. The failure is rendered INSTEAD of that empty state.
  if (failed && (!summary || summary.length === 0)) {
    return <LoadFailed onRetry={onRetry} />;
  }

  if (!summary || summary.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
        <Icon name="Clock" size={28} className="text-gray-400 mx-auto mb-2" />
        <p className="text-gray-700 dark:text-gray-200 font-medium">{t("noHoursLogged")}</p>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{t("shpSummaryEmptyHintLog", "Register hours under Log, or confirm the schedule there.")}</p>
        {onGoLog && (
          <Button size="md" variant="secondary" className="mt-3 max-sm:h-10" onClick={onGoLog}>
            {t("shpGoLog", "Register hours")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
    {/* Rows survived a failed refresh, so they are shown — and called stale.
        Every derived figure under this banner (the totals row, the "n shifts
        need your answer" chip) is computed from them, which is only honest
        while the banner is there to say where they came from. */}
    {failed ? <LoadFailed onRetry={onRetry} body={t("loadFailedStale", "These are the last figures that loaded — they may be out of date.")} /> : null}
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t("periodSummary")}</h2>
          {/* ONE amber thing on the page. Per-row amber on a twelve-person
              roster becomes a wall the owner stops seeing; a single count stays
              legible. Silent when there is nothing to answer — an all-clear
              badge every day is how a real one gets ignored. */}
          {/* A BUTTON, not a label: it opens the answer sheet on the first
              unanswered shift. The chip used to be a span a tap did nothing to. */}
          {needsAnswer > 0 && (
            <button
              type="button"
              onClick={openQueue}
              disabled={!answerQueue.length}
              className="inline-flex items-center gap-1.5 shrink-0 min-h-10 sm:min-h-0 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Icon name="AlertTriangle" className="w-3.5 h-3.5" aria-hidden />
              {needsAnswer === 1
                ? t("shpNeedsAnswerOne", "1 shift needs your answer")
                : t("shpNeedsAnswer", "{n} shifts need your answer", { n: needsAnswer })}
              <Icon name="ChevronRight" size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {/* A column of bare "—" said nothing about why. */}
      {wagesHidden && (
        <p className="px-5 py-2 border-b border-gray-200 dark:border-gray-700 text-[12px] text-gray-600 dark:text-gray-300 inline-flex items-center gap-1.5 w-full">
          <Icon name="Lock" size={13} className="shrink-0" />
          {deviceCurtained
            ? t("shpWagesHiddenCurtain", "Pay is hidden on this shared device — unlock with your PIN to see it.")
            : t("shpWagesHiddenRole", "Pay is hidden for your role — the owner sees it.")}
        </p>
      )}
      <ApprovalBar
        rows={rows} from={periodFrom} to={periodTo} needsAnswer={needsAnswer}
        approval={approval}
        onAnswer={openQueue}
        onAnswerAsPlanned={answerAllAsPlanned}
        asPlannedCount={asPlannedList.length}
        bulkBusy={bulkBusy}
        bulkNote={bulkNote}
      />

      {/* Mobile-friendly columns: name + actual + total survive on phones;
          scheduled / diff / rate / earned / tips hide on < sm so the table
          fits a 375px viewport without horizontal-scroll.  Owner can tap
          the row OR view this page on tablet+ for the accountant-grade
          breakdown.  Pattern matches the Faktura row mobile pass (#140). */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {/* The name and the total are STICKY: at 768 px with the sidebar
                open the table is wider than its card, and "I alt" sat
                off-screen behind a scroll nobody saw. */}
            <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-left text-xs uppercase tracking-wider">
              <th className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-800 px-3 sm:px-5 py-3 font-medium">{t("navStaff")}</th>
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right">{t("scheduled")}</th>
              <th className="px-3 py-3 font-medium text-right">{t("actual")}</th>
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right">{t("diff")}</th>
              <th className="hidden lg:table-cell px-3 py-3 font-medium text-right">{t("rate")}</th>
              {/* Bruttoløn, said: the money before feriepenge and ATP. The
                  line under the table adds those up to the cost total. */}
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right whitespace-nowrap">{t("shpColGross", "Gross pay")}</th>
              <th className="hidden lg:table-cell px-3 py-3 font-medium text-right">{t("tips")}</th>
              <th className="sticky right-0 z-10 bg-gray-50 dark:bg-gray-800 px-3 sm:px-3 py-3 font-medium text-right">{t("total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map((row, idx) => {
              // Server-computed, per SHIFT. Falls back to the old aggregate
              // reading only for a backend that has not shipped worst_state yet
              // — and that fallback deliberately reports NOTHING rather than
              // guessing, because guessing is how a no-show turned green.
              const stateMeta = shiftStateMeta(row.worst_state, t);
              const isNearLimit = row.work_limit && row.actual_hours >= row.work_limit * 0.95;
              const isOverLimit = row.work_limit && row.actual_hours >= row.work_limit;

              return (
                <tr
                  key={row.staff_id || idx}
                  className="group hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <td className="sticky left-0 z-[1] bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-800 px-3 sm:px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-gray-200 flex-shrink-0">
                        {(row.staff_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <span className="font-medium text-gray-800 dark:text-white inline-flex items-center gap-1">
                          {row.staff_name}
                          {/* Approved: every row of theirs in the period carries the tick. */}
                          {(row.entries_count || 0) > 0 && (row.approved_count || 0) >= row.entries_count && (
                            <Icon name="CheckCircle2" size={14} className="text-emerald-600 dark:text-emerald-400 shrink-0"
                              aria-label={t("shpApprovedAll", "Approved")} role="img" />
                          )}
                        </span>
                        {/* Mobile-only inline reveal of scheduled hours (column hidden < sm). */}
                        <div className="sm:hidden text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                          {/* This sub-line is the only place the phone can show
                              scheduled-vs-actual — Scheduled and Diff are both
                              `hidden sm:` — so it carries the same state word the
                              desktop cell does. `planlagt` used to be hardcoded
                              Danish sitting in the English UI. */}
                          {row.scheduled_hours != null
                            ? t("shpScheduledShort", "{h} scheduled").replace("{h}", fmtHours(row.scheduled_hours, lang))
                            : ""}
                          {/* When the row HAS something to resolve the state
                              word moves out of this line and becomes the real
                              button below, so the word is never shown twice. */}
                          {stateMeta && row.scheduled_hours != null && !firstException(row) && (
                            <span className={stateMeta.cls}>
                              {" \u00b7 "}{stateMeta.label}
                            </span>
                          )}
                        </div>
                        {/* PHONE-ONLY resolve control.
                            The desktop affordance lives in the Diff cell, which
                            is `hidden sm:table-cell` — so below 640px the only
                            caller of setResolving() was display:none, and the
                            amber "{n} shifts need your answer" chip above the
                            table pointed at nothing the owner could tap. The
                            ResolveSheet was unreachable code on a phone.
                            Deliberately its own <button> rather than making the
                            11px sub-line tappable: the coarse-pointer floor at
                            index.css:322-325 forces min-height:44px on every
                            button, which gives this a real touch target — but
                            inlined into that text row it would have stretched
                            the row instead. Only flagged rows grow, which is
                            the right emphasis anyway. */}
                        {stateMeta && firstException(row) && (
                          <button
                            type="button"
                            onClick={() => openSheet({
                              staffId: row.staff_id,
                              staffName: row.staff_name,
                              exception: firstException(row),
                            })}
                            className={`sm:hidden mt-1 inline-flex items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${stateMeta.cls}`}
                          >
                            {stateMeta.label}
                            {row.needs_answer_count > 1 && (
                              <span className="tabular-nums opacity-70">×{row.needs_answer_count}</span>
                            )}
                            <Icon name="ChevronRight" size={12} aria-hidden="true" />
                          </button>
                        )}
                        {isNearLimit && (
                          <div className={`text-xs mt-0.5 font-semibold ${isOverLimit ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {row.staff_name?.split(" ")[0]}: {Math.round(row.actual_hours)}/{formatHours(row.work_limit, { lang, decimals: 0 })}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {fmtHours(row.scheduled_hours, lang)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {fmtHours(row.actual_hours, lang)}
                  </td>
                  {/* The NUMBER a manager wants ("+0,5 t"), with the word that
                      says what kind of deviation it is underneath. Shifts that
                      need an answer keep the word as the button that opens it. */}
                  <td className="hidden sm:table-cell px-3 py-3 text-right align-top">
                    {(() => {
                      const d = (Number(row.actual_hours) || 0) - (Number(row.scheduled_hours) || 0);
                      const showNum = row.scheduled_hours != null && Math.abs(d) >= 0.005;
                      return (
                        <span className="inline-flex flex-col items-end gap-0.5">
                          <span className={`font-medium tabular-nums ${showNum ? "text-gray-900 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"}`}>
                            {showNum ? formatHours(d, { lang, sign: true, decimals: 2 }) : "\u2014"}
                          </span>
                          {stateMeta && (firstException(row) ? (
                            <button
                              type="button"
                              onClick={() => openSheet({
                                staffId: row.staff_id,
                                staffName: row.staff_name,
                                exception: firstException(row),
                              })}
                              className={`inline-flex items-center gap-1 justify-end text-[12px] font-medium underline underline-offset-2 decoration-dotted rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${stateMeta.cls}`}
                            >
                              {stateMeta.label}
                              {row.needs_answer_count > 1 && (
                                <span className="tabular-nums opacity-70">×{row.needs_answer_count}</span>
                              )}
                            </button>
                          ) : (
                            <span className={`text-[12px] ${stateMeta.cls}`}>{stateMeta.label}</span>
                          ))}
                        </span>
                      );
                    })()}
                  </td>
                  {/* The rate read "150 DKK/hr" — an English unit and a raw
                      currency code on a Danish payroll row. The unit now comes
                      off utils/hours.js, the same place the hour columns get
                      theirs, so a Danish owner reads "150 kr./t". */}
                  <td className="hidden lg:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {(() => {
                      const rate = effectiveRate(row);
                      return rate != null
                        ? `${formatOwnerMoney(rate, currency, { decimals: rateDecimals(rate) })}/${hoursUnit(lang)}`
                        : "\u2014";
                    })()}
                  </td>
                  {/* <Amount> renders a missing figure as "—" on its own, which
                      is what the redacted (member-seat) payload sends.
                      rateMissing() is the OTHER null: no rate was ever set, so
                      the server costed these hours at 0 and sent a stored,
                      confident 0 kr. back. Earned is not zero there — it is
                      unknown, and this column now says which. */}
                  <td className="hidden sm:table-cell px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {rateMissing(row) ? (
                      <span className="text-gray-400 dark:text-gray-500" title={t("shpEarnedNeedsRate", "No wage rate set for this person")}>&mdash;</span>
                    ) : (
                      <Amount value={row.earned} currency={currency} decimals={2} />
                    )}
                  </td>
                  <td className="hidden lg:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.tips != null && row.tips > 0 ? <Amount value={row.tips} currency={currency} decimals={2} /> : "\u2014"}
                  </td>
                  {/* Total = earned + tips. With earned unknown the sum is
                      unknown too — printing the tips alone under a column
                      headed "I alt" would read as this person's whole pay. */}
                  <td className="sticky right-0 z-[1] bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-800 px-3 py-3 text-right font-bold text-gray-900 dark:text-white tabular-nums">
                    {rateMissing(row) ? (
                      <span className="text-gray-400 dark:text-gray-500" title={t("shpEarnedNeedsRate", "No wage rate set for this person")}>&mdash;</span>
                    ) : (
                      <Amount value={row.total} currency={currency} decimals={2} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/* Totals row */}
          <tfoot>
            <tr className="bg-gray-50 dark:bg-gray-800 font-semibold text-gray-800 dark:text-white">
              <td className="sticky left-0 z-[1] bg-gray-50 dark:bg-gray-800 px-3 sm:px-5 py-3 text-sm">{t("shpTotalCount", "Total ({count})").replace("{count}", summary.length)}</td>
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {fmtHours(summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0), lang)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {fmtHours(summary.reduce((s, r) => s + (r.actual_hours || 0), 0), lang)}
              </td>
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {(() => {
                  const d = summary.reduce((s, r) => s + (r.actual_hours || 0), 0) - summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0);
                  return d === 0 ? "\u2014" : formatHours(d, { lang, sign: true });
                })()}
              </td>
              <td className="hidden lg:table-cell px-3 py-3" />
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("earned", missingRateCount > 0)}
              </td>
              <td className="hidden lg:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("tips")}
              </td>
              <td className="sticky right-0 z-[1] bg-gray-50 dark:bg-gray-800 px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("total", missingRateCount > 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* The rows are bruttoløn; this adds feriepenge and ATP to them, so the
          names add up to the cost tile and to Løn's total. */}
      {!wagesHidden && costBreakdown && (
        <CostReconcileLine
          breakdown={costBreakdown}
          people={summary}
          currency={currency}
          className="px-3 sm:px-5 py-3 border-t border-gray-200 dark:border-gray-700"
        />
      )}

      {/* A DASH THAT DOES NOT SAY WHY IS ITS OWN DEAD END. The wage totals
          above go "—" the moment one person on the roster has no rate, which
          is only honest if the owner can see the cause and reach the fix in
          one tap. Silent when every rate is set. */}
      {missingRateCount > 0 && (
        <div className="px-3 sm:px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-gray-600 dark:text-gray-300">
          {/* Gray, not amber. This card already spends its one amber on the
              "n shifts need your answer" chip in the header, and a second
              amber signal beside it turns both into wallpaper. The em-dash in
              the totals row is what catches the eye; this line is the
              explanation it sends you to. */}
          <Icon name="Info" size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
          <span>
            {missingRateCount === 1
              ? t("shpMissingRateOne", "1 person has no wage rate set, so wage figures wait for it.")
              : t("shpMissingRateMany", "{n} people have no wage rate set, so wage figures wait for them.").replace("{n}", String(missingRateCount))}
          </span>
          <Link
            to="/staff/schedule"
            className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
          >
            {t("shpSetWageRates", "Set wage rates")}
          </Link>
        </div>
      )}

      {resolving && resolving !== "done" && (
        <ResolveSheet
          // A fresh sheet per shift: its hours/end-time state is the shift's own.
          key={`${resolving.staffId}-${resolving.exception?.date}-${resolving.exception?.state}`}
          staffId={resolving.staffId}
          staffName={resolving.staffName}
          exception={resolving.exception}
          onClose={closeSheet}
          saved={lastSaved}
          position={walk && resolvingIdx >= 0 ? { i: Math.min(walk.done + 1, walk.total), n: walk.total } : null}
          onResolved={afterSave}
        />
      )}
      {resolving === "done" && (
        <QueueDoneSheet
          saved={lastSaved}
          range={approval.range}
          canApprove={approvalCounts(rows).total > approvalCounts(rows).approved}
          busy={approval.busy}
          onApprove={async () => {
            const c = approvalCounts(rows);
            const ok = await approval.approve(c.total - c.approved);
            if (ok) closeSheet();
          }}
          onClose={closeSheet}
        />
      )}
    </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LOGGING SECTION — 3 TABS
   ═══════════════════════════════════════════════════════════ */
function LoggingSection({ staffList, staffFailed, onRetryStaff, rosterEmpty = false, currency, periodFrom, onLogged }) {
  const { t } = useLanguage();
  const [logTab, setLogTab] = useState("quick");

  const tabs = [
    { id: "quick", label: t("shpTabQuickLog", "Quick Log") },
    { id: "clock", label: t("shpTabClockInOut", "Clock In/Out") },
    { id: "schedule", label: t("shpTabFromSchedule", "From Schedule") },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t("logHours")}</h2>
      </div>

      {/* Tab bar */}
      <div className="mx-4 mt-4">
        <TabPills
          tabs={tabs}
          activeId={logTab}
          onChange={setLogTab}
          ariaLabel={t("logHours")}
        />
      </div>

      <div className="p-4">
        {/* The roster feeds the name picker in two of these three tabs. When it
            did not load, an owner with nine staff sees the same empty dropdown
            as an owner with none — so say which it is, and keep every form
            mounted: "From Schedule" needs no picker and still works offline
            once the request comes back. The forms are never disabled here. */}
        {staffFailed && (
          <div className="mb-4">
            <LoadFailed
              onRetry={onRetryStaff}
              body={t("shpStaffListFailed", "The staff list did not load, so the name picker is empty.")}
            />
          </div>
        )}
        {/* THE OTHER CAUSE, AND IT IS NOT A FAILURE. The roster came back and
            it was nobody — so the picker below is empty, Registrér timer can
            never light up, and until this banner existed the form said none of
            that. It is the reason plus the one link that removes it; the forms
            stay mounted and enabled either way, exactly as under the failure
            banner above, because "From Schedule" needs no picker at all. */}
        {!staffFailed && rosterEmpty && (
          <SectionBanner
            severity="info"
            icon="Users"
            className="mb-4"
            title={t("shpNoStaffYetTitle", "No staff members yet")}
          >
            <p>{t("shpNoStaffYetBody", "Hours are logged against a person, so the name picker stays empty until you add one.")}</p>
            <Link
              to="/staff/schedule"
              className="mt-2 inline-flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
            >
              <Icon name="Plus" size={14} aria-hidden="true" />
              {t("hovEmptyAddStaff", "Add a staff member")}
            </Link>
          </SectionBanner>
        )}
        <TabContent tabKey={logTab}>
          {logTab === "quick" && (
            <QuickLogForm staffList={staffList} rosterEmpty={rosterEmpty} staffFailed={staffFailed} currency={currency} onLogged={onLogged} />
          )}
          {logTab === "clock" && (
            <ClockInOutForm staffList={staffList} rosterEmpty={rosterEmpty} staffFailed={staffFailed} currency={currency} onLogged={onLogged} />
          )}
          {logTab === "schedule" && (
            <FromScheduleForm periodFrom={periodFrom} onLogged={onLogged} />
          )}
        </TabContent>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Tab 1: Quick Log
   ───────────────────────────────────────────────────────── */
function QuickLogForm({ staffList, rosterEmpty = false, staffFailed = false, currency, onLogged }) {
  const { t } = useLanguage();
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!staffId || !date || !hours) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/staff/hours", {
        staff_id: staffId,
        date,
        total_hours: parseFloat(hours),
        entry_method: "quick",
      });
      setSuccess(t("shpHoursLoggedSuccess", "Hours logged successfully!"));
      setHours("");
      onLogged();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(houseErrText(err, t("shpFailedLogHours", "Failed to log hours")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t("shpQuickLogDesc", "Fastest way to log hours. Select staff, pick the date, enter total hours.")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Staff select */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("staffMember")}</label>
          <select
            value={staffId}
            onChange={e => setStaffId(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {/* An empty picker with "Vælg medarbejder…" in it looks like a
                list that failed to render. Saying which it is costs one line
                and stops the owner hunting for a bug that is not there — the
                banner above the tabs carries the link that fixes it.
                Three outcomes, not two: `staffList.length === 0` is ALSO true
                when the roster request failed, so keying the label off the
                length would tell an owner with nine staff that they have
                none. `rosterEmpty` means we asked and the answer was nobody;
                `staffFailed` means we never got an answer. */}
            <option value="">
              {rosterEmpty
                ? t("shpNoStaffYetOption", "No staff members yet")
                : staffFailed
                  ? t("shpStaffLoadFailedOption", "Could not load staff")
                  : t("shpSelectStaff", "Select staff...")}
            </option>
            {staffList.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("date", "Date")}</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* Hours */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("totalHours")}</label>
          <input
            type="number"
            step="0.25"
            min="0"
            max="24"
            value={hours}
            onChange={e => setHours(e.target.value)}
            placeholder={t("shpHoursPlaceholder", "e.g. 8")}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-sm text-emerald-600 dark:text-gray-300">{success}</p>}

      <button
        type="submit"
        disabled={saving || !staffId || !hours}
        className="bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? t("shpSaving", "Saving...") : t("shpLogHoursBtn", "Log Hours")}
      </button>
    </form>
  );
}

/* ─────────────────────────────────────────────────────────
   Tab 2: Clock In/Out
   ───────────────────────────────────────────────────────── */
function ClockInOutForm({ staffList, rosterEmpty = false, staffFailed = false, currency, onLogged }) {
  const { t, lang } = useLanguage();
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState(today());
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [breakMin, setBreakMin] = useState("0");
  const [breakTouched, setBreakTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const calcHours = useMemo(
    () => calcHoursFromTimes(startTime, endTime, parseInt(breakMin) || 0),
    [startTime, endTime, breakMin]
  );

  // DK convention: a shift past 6h carries a 45-min pause. Prefill it from the
  // entered times (owner can still override) so this form reads the SAME break
  // as the punch clock + roster — not the old hardcoded 30. Event-driven, so no
  // set-state-in-effect. Once the owner edits the field we never re-touch it.
  const syncBreak = (s, en) => {
    if (breakTouched) return;
    const gross = calcHoursFromTimes(s, en, 0);
    setBreakMin(String(gross >= 6 ? 45 : 0));
  };

  // Look up staff rate for preview.
  // Kept as a NUMBER now — it used to be a toFixed(0) string that the render
  // then pasted next to a hand-built currency token, which is how the preview
  // ended up reading "(1200 DKK at 150/kr/hr)" to a Danish owner. Formatting
  // belongs at the render, in the house formatter.
  //
  // `base_rate`, not `hourly_rate`: StaffMemberResponse has never carried a
  // key called hourly_rate (that name only exists on /staff/hours/summary
  // rows), so this read was `undefined` for every staff member in the
  // product's history and the estimate beside "Beregnet" has simply never
  // rendered. A preview nobody can see is not a small bug — it is the one
  // place this form says what the entry will cost before it is written.
  //
  // Three outcomes, not two. A staffer with no rate set, and a seat the
  // server redacts the rate from, both arrive as null → no estimate, because
  // there is nothing true to show. A rate of exactly 0 is a real answer an
  // owner typed, so it previews as 0 rather than disappearing — `|| null`
  // would have swallowed it back into "unknown".
  const selectedStaff = staffList.find(s => s.id === staffId);
  // WAGE PRIVACY — the same inference the summary table makes at ~1456, for
  // the same reason. A null base_rate has TWO causes: nobody set a rate, or
  // the backend stripped every pay field because this is a delegated seat or
  // the owner's curtained shared device (_wage_stripped_member, staff.py:213).
  // Saying "no wage rate set" in the second case states as fact something that
  // is merely hidden from this viewer — on the pay surface, which is the one
  // place this product must never do it.
  //
  // It is only knowable that THIS person has no rate when somebody else on the
  // roster does. If every row is null we cannot tell, so we say nothing.
  const wagesHidden =
    staffList.length > 0 && staffList.every((m) => m.base_rate == null);
  const rawRate = selectedStaff?.base_rate;
  const rate =
    rawRate == null || rawRate === "" || !Number.isFinite(Number(rawRate))
      ? null
      : Number(rawRate);
  const estimated = rate != null && calcHours > 0 ? rate * calcHours : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!staffId || !date || !startTime || !endTime) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/staff/hours", {
        staff_id: staffId,
        date,
        total_hours: calcHours,
        start_time: startTime,
        end_time: endTime,
        break_minutes: parseInt(breakMin) || 0,
        // Owner-typed times, not a punch-clock reading.
        entry_method: "quick",
      });
      setSuccess(t("shpClockEntryLogged", "Clock entry logged!"));
      setStartTime("");
      setEndTime("");
      onLogged();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(houseErrText(err, t("shpFailedLogEntry", "Failed to log entry")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t("shpClockDesc", "Enter clock-in and clock-out times. A 45-min break is suggested for 6h+ shifts — adjust if needed.")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Staff select */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("staffMember")}</label>
          <select
            value={staffId}
            onChange={e => setStaffId(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {/* An empty picker with "Vælg medarbejder…" in it looks like a
                list that failed to render. Saying which it is costs one line
                and stops the owner hunting for a bug that is not there — the
                banner above the tabs carries the link that fixes it.
                Three outcomes, not two: `staffList.length === 0` is ALSO true
                when the roster request failed, so keying the label off the
                length would tell an owner with nine staff that they have
                none. `rosterEmpty` means we asked and the answer was nobody;
                `staffFailed` means we never got an answer. */}
            <option value="">
              {rosterEmpty
                ? t("shpNoStaffYetOption", "No staff members yet")
                : staffFailed
                  ? t("shpStaffLoadFailedOption", "Could not load staff")
                  : t("shpSelectStaff", "Select staff...")}
            </option>
            {staffList.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("date", "Date")}</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* Start time */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("startTime")}</label>
          <input
            type="time"
            value={startTime}
            onChange={e => { setStartTime(e.target.value); syncBreak(e.target.value, endTime); }}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* End time */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("endTime")}</label>
          <input
            type="time"
            value={endTime}
            onChange={e => { setEndTime(e.target.value); syncBreak(startTime, e.target.value); }}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* Break minutes */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("shpBreakMinutes", "Break (minutes)")}</label>
          <input
            type="number"
            step="5"
            min="0"
            max="120"
            value={breakMin}
            onChange={e => { setBreakMin(e.target.value); setBreakTouched(true); }}
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* Calculated preview */}
        <div className="flex items-end">
          <div className="bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-lg px-4 py-2.5 w-full">
            <span className="text-xs text-gray-500 dark:text-gray-400 block">{t("calculated")}</span>
            <span className="text-lg font-bold text-gray-800 dark:text-white">
              {calcHours > 0 ? formatHours(calcHours, { lang, decimals: 2 }) : "\u2014"}
            </span>
            {/* One currency token for both figures, and the per-hour unit off
                utils/hours.js — the same source the "Calculated" figure beside
                it uses. The old line built its own token twice and disagreed
                with itself ("1200 DKK at 150/kr/hr"), with an untranslated
                "at" and "/hr" in the middle of a Danish form. Reads
                "(1.200 kr. · 150 kr./t)". */}
            {estimated != null && (
              <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
                ({formatOwnerMoney(estimated, currency)}
                {" · "}
                {formatOwnerMoney(rate, currency, { decimals: rateDecimals(rate) })}/{hoursUnit(lang)})
              </span>
            )}
            {/* Rate not set — say so, instead of leaving a blank the owner
                reads as "the estimate is broken". Only once a name and real
                times are on screen, so an untouched form stays quiet. */}
            {rate == null && !wagesHidden && staffId && calcHours > 0 && (
              <span className="text-sm text-gray-400 dark:text-gray-500 ml-2">
                ({t("shpNoRateSet", "no wage rate set")})
              </span>
            )}
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-sm text-emerald-600 dark:text-gray-300">{success}</p>}

      <button
        type="submit"
        disabled={saving || !staffId || !startTime || !endTime}
        className="bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? t("shpSaving", "Saving...") : t("shpLogClockEntryBtn", "Log Clock Entry")}
      </button>
    </form>
  );
}

/* ─────────────────────────────────────────────────────────
   Tab 3: From Schedule
   ───────────────────────────────────────────────────────── */
function FromScheduleForm({ periodFrom, onLogged }) {
  const { t } = useLanguage();
  const [weekStart, setWeekStart] = useState(() => getMonday(today()));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    setConfirming(true);
    setError("");
    setResult(null);
    try {
      const res = await api.post("/staff/hours/confirm-schedule", null, {
        params: { week_start: weekStart },
      });
      setResult(res.data);
      onLogged();
    } catch (err) {
      setError(houseErrText(err, t("shpFailedConfirmSchedule", "Failed to confirm schedule")));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t("shpFromScheduleDesc", "Confirm all published shifts for a given week as actual hours worked. This copies the scheduled shifts into the hours log.")}
      </p>

      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t("shpWeekStarting", "Week Starting (Monday)")}</label>
          <input
            type="date"
            value={weekStart}
            onChange={e => setWeekStart(e.target.value)}
            className="border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        <button
          onClick={handleConfirm}
          disabled={confirming}
          className="bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed whitespace-normal sm:whitespace-nowrap"
        >
          {confirming ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t("shpConfirming", "Confirming...")}
            </span>
          ) : (
            t("shpConfirmAllShifts", "Confirm All Published Shifts for This Week")
          )}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* WHAT THE SERVER ACTUALLY SAID.
          This block read `confirmed_count` and `skipped_count`; POST
          /staff/hours/confirm-schedule returns `created` and
          `skipped_not_ended`. Both reads were undefined, so every confirm —
          a bulk write into the register that pays wages — showed the owner
          the headline "Schedule confirmed!" and nothing else: no count, and
          no word about the shifts the server deliberately refused to log
          because they had not finished yet. */}
      {result && (
        <div className="bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-300">
            {t("shpScheduleConfirmed", "Schedule confirmed!")}
          </p>
          {/* Zero is reported too, and it is not "nothing happened": the
              server 400s when NO shift has ended, so a result with created=0
              means every ended shift in the week was already in the log.
              SCOPED TO THE SHIFTS THAT HAVE ENDED when some have not. The
              unscoped wording says "these shifts were already recorded" and
              the amber line directly beneath it can say two of them were left
              out because they are still running — the server only 400s when
              NO shift has ended, so created=0 with skipped_not_ended=2 is a
              reachable week. Two claims about the same shifts, one line
              apart, contradicting each other. */}
          {result.created != null && (
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
              {result.created === 0
                ? (result.skipped_not_ended > 0
                    ? t("shpShiftsNoneNewEnded", "Nothing new to log — the shifts that have ended were already recorded.")
                    : t("shpShiftsNoneNew", "Nothing new to log — these shifts were already recorded."))
                : result.created === 1
                  ? t("shpShiftsLoggedOne", "1 shift logged as actual hours.")
                  : t("shpShiftsLogged", "{count} shifts logged as actual hours.").replace("{count}", result.created)}
            </p>
          )}
          {/* Not "skipped (already logged)" — these are shifts that have not
              ended yet, and the owner needs the second half of that sentence:
              come back and confirm the week once they are over. */}
          {result.skipped_not_ended > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              {result.skipped_not_ended === 1
                ? t("shpShiftsNotEndedOne", "1 shift was left out — it has not finished yet. Confirm this week again once it is over.")
                : t("shpShiftsNotEnded", "{count} shifts were left out — they have not finished yet. Confirm this week again once they are over.").replace("{count}", result.skipped_not_ended)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   RECENT HOURS LOG
   ═══════════════════════════════════════════════════════════ */
function RecentHoursLog({ entries, loading, failed, onRetry, currency, staffList, onUpdated }) {
  const { t, lang } = useLanguage();
  const [editingId, setEditingId] = useState(null);
  const [editHours, setEditHours] = useState("");
  // A shift with times is corrected AS times — start, end, break — so the
  // working-time register keeps the right in/out. Only a typed total (no
  // times) is corrected as a number.
  const [editTimes, setEditTimes] = useState(null); // {start, end, brk} | null
  const [editSaving, setEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const confirm = useConfirm();
  // The delete used to `catch { // silent }`. A payroll record vanishing with
  // no word is worse than one that fails loudly, so failures land here.
  const [delErr, setDelErr] = useState("");
  // The EDIT had the same silent catch, and it was worse than the delete's.
  // handleEdit sent {total_hours} to an endpoint binding HoursLogCreate, where
  // staff_id and date are required — so every correction 422'd before the
  // handler ran. Because setEditingId(null) only ran on success, a failure left
  // the editor open still showing the number the owner had typed, spinner
  // stopped. It read exactly like a save. The owner types 8, sees 8, walks
  // away, and pays 6.25. Same class as the resolve bug this file already
  // records fixing 750 lines above: "a failed save looked exactly like a
  // successful one — on a pay record."
  const [editErr, setEditErr] = useState("");

  // Build a name lookup
  const nameMap = useMemo(() => {
    const map = {};
    staffList.forEach(s => { map[s.id] = s.name; });
    return map;
  }, [staffList]);

  const startEdit = (entry) => {
    setEditErr("");
    setEditingId(entry.id);
    if (entry.start_time) {
      setEditTimes({ start: entry.start_time, end: entry.end_time || "", brk: String(entry.break_minutes || 0) });
      setEditHours("");
    } else {
      setEditTimes(null);
      setEditHours(String(entry.total_hours || ""));
    }
  };
  const stopEdit = () => { setEditingId(null); setEditHours(""); setEditTimes(null); setEditErr(""); };

  const handleEdit = async (id) => {
    if (editTimes) {
      if (!editTimes.start || !editTimes.end) return;
    } else if (!editHours) return;
    setEditErr("");
    setEditSaving(true);
    try {
      // PARTIAL body on purpose. The endpoint now binds HoursLogUpdate and
      // applies only the keys actually sent, so the row's start_time, end_time
      // and break_minutes survive a total-hours correction — those columns are
      // the venue's Arbejdstidsloven register and must show daily working time
      // for five years. Sending a "full" body to satisfy the old schema would
      // have blanked them.
      await api.put(`/staff/hours/${id}`, editTimes
        ? { start_time: editTimes.start, end_time: editTimes.end, break_minutes: parseInt(editTimes.brk, 10) || 0 }
        : { total_hours: parseFloat(editHours) });
      setEditingId(null);
      setEditHours("");
      onUpdated();
    } catch (e) {
      // Stay open, keep what they typed, and SAY SO. Closing the editor here
      // would be the original bug wearing a different mask.
      setEditErr(e?.response?.data?.detail?.code === "approved"
        ? t("shpLockedApproved", "These hours are approved. Undo the approval under Per staff to change them.")
        : houseErrText(e, t("shpEditHoursFailed", "Could not save. Try again.")));
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (entry) => {
    // These hours pay wages and sit in an Arbejdstidsloven register kept five
    // years. There was no confirm, no undo, and a silent catch — and the button
    // itself is invisible on a phone (see the reveal class below), so a tap on
    // apparent blank space destroyed a record and said nothing.
    //
    // The confirm that closed that hole still said only "Delete this hours
    // entry?" — the same sentence over every row in the log, where one staffer
    // easily has five near-identical days. On a phone, where the row's own
    // buttons only appear on hover, the dialog was the owner's first sight of
    // what they had hit, and it named nothing. It now repeats the row back:
    // who, which day, how many hours, in the same words the row prints.
    const id = entry.id;
    const who = entry.staff_name || nameMap[entry.staff_id] || t("shpUnknownStaff", "Unknown");
    const ok = await confirm({
      title: t("shpDeleteHoursTitleNamed", "Delete the hours for {name} on {date}?", {
        name: who,
        date: fmtDateFull(entry.date),
      }),
      message: t(
        "shpDeleteHoursBodyHours",
        "This entry logs {hours} — those hours come out of pay and out of your working-hours register. It cannot be undone.",
        { hours: formatHours(entry.total_hours, { lang, decimals: 2 }) },
      ),
      destructive: true,
    });
    if (!ok) return;
    setDelErr("");
    setDeletingId(id);
    try {
      await api.delete(`/staff/hours/${id}`);
      onUpdated();
    } catch (e) {
      setDelErr(e?.response?.data?.detail?.code === "approved"
        ? t("shpLockedApproved", "These hours are approved. Undo the approval under Per staff to change them.")
        : houseErrText(e, t("deleteHoursFailed")));
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  // Instead of, never above: "Logged entries will appear here" is an invitation
  // to start, and this audit trail is the venue's Arbejdstidsloven register —
  // telling an owner it is empty because the GET failed is the worst reading of
  // the two states this page used to collapse.
  if (failed && (!entries || entries.length === 0)) {
    return <LoadFailed onRetry={onRetry} />;
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-8 text-center">
        <Icon name="ClipboardList" size={28} className="text-gray-400 mx-auto mb-2" />
        <p className="text-gray-500 dark:text-gray-400 font-medium">{t("noHourEntries")}</p>
        <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">{t("shpLogEmptyHint", "Logged entries will appear here with edit and delete options.")}</p>
      </div>
    );
  }

  // Sort entries by date descending
  const sorted = [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div className="space-y-4">
    {failed ? <LoadFailed onRetry={onRetry} body={t("loadFailedStale", "These are the last figures that loaded — they may be out of date.")} /> : null}
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800 dark:text-white">{t("recentHoursLog")}</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{t("shpEntriesCount", "{count} entries").replace("{count}", sorted.length)}</span>
      </div>

      {delErr && (
        <p className="px-5 py-2.5 text-sm text-red-600 dark:text-red-400 border-b border-gray-100 dark:border-gray-700" role="alert">
          {delErr}
        </p>
      )}

      <AnimatedList className="divide-y divide-gray-100 dark:divide-gray-700">
        {sorted.map(entry => {
          const staffName = entry.staff_name || nameMap[entry.staff_id] || t("shpUnknownStaff", "Unknown");
          const badge = METHOD_BADGES[entry.entry_method] || METHOD_BADGES.quick;
          const badgeLabel = t(badge.labelKey, entry.entry_method);
          const isEditing = editingId === entry.id;
          const isDeleting = deletingId === entry.id;

          return (
            <AnimatedListItem key={entry.id}>
              <div className="px-5 py-3 flex flex-wrap items-center gap-3 group">
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-600 dark:text-gray-300 flex-shrink-0">
                  {staffName.charAt(0).toUpperCase()}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  {/* Wraps instead of truncating: on a phone the name was cut to
                      "A" / "Te…" and Test Tina, Theo and Tilde looked the same. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium text-gray-800 dark:text-white text-sm break-words min-w-0">{staffName}</span>
                    {/* Per-method weight: measured > asserted > assumed. See
                        METHOD_BADGES for why this is weight and not colour. */}
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${badge.chip || METHOD_CHIP}`}>
                      <Icon name={badge.icon} size={10} />
                      {badgeLabel}
                    </span>
                  </div>
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <span>{fmtDateFull(entry.date)}</span>
                    {/* What you already decided about this shift. Until now
                        answering one only made the amber go away, so there was
                        no way to tell "I checked this and it is right" from "I
                        have not looked yet" — and an ADJUSTED shift, where you
                        changed the hours someone is paid for, looked exactly
                        like an ordinary one. Grey on purpose: this table spends
                        emerald on LIVE only, because a no-show once wore the
                        colour of success. */}
                    {(() => {
                      const rm = resolutionMeta(entry.resolution, t);
                      if (!rm) return null;
                      return (
                        <>
                          <span className="text-gray-300 dark:text-gray-600">|</span>
                          <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                            <Icon name={rm.icon} size={11} />
                            {rm.label}
                          </span>
                        </>
                      );
                    })()}
                    {/* Never clocked out: the start and a red "no clock-out" —
                        it read "stemplet · 0 t" with no time and no flag. */}
                    {entry.start_time && !entry.end_time && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span className="tabular-nums">{`${entry.start_time}\u2013`}</span>
                        <span className="inline-flex items-center gap-1 font-medium text-red-700 dark:text-red-400">
                          <Icon name="AlertTriangle" size={11} />
                          {t("shpStateForgotOut", "No clock-out")}
                        </span>
                      </>
                    )}
                    {entry.start_time && entry.end_time && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        {/* Render the time range with an en-dash. Bug fix:
                            `\u2013` text inside JSX is treated as raw
                            characters, not an escape \u2014 owners were seeing
                            "16:00\u201300:00" verbatim on every hours row.
                            Wrap the escape in a JS expression so it
                            evaluates to U+2013 properly. */}
                        <span>{`${entry.start_time}\u2013${entry.end_time}`}</span>
                      </>
                    )}
                    {entry.break_minutes > 0 && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span>{t("shpMinBreak", "{count}min break").replace("{count}", entry.break_minutes)}</span>
                      </>
                    )}
                    {entry.entry_method === "clock" && entry.notes === "Location unverified" && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span className="text-amber-600 dark:text-amber-400">{t("shpUnverifiedLoc", "Location not verified")}</span>
                      </>
                    )}
                    {/* What the clock measured, when an owner has since changed
                        it. The write-once guarantee already lived in the
                        database — but a staffer disputing their pay could not
                        SEE it, so it was only provable by someone with SQL
                        access. Shown only when the two actually disagree;
                        printing "clock said 8, owner said 8" is noise. */}
                    {entry.clock_hours != null
                      && Math.abs(Number(entry.clock_hours) - Number(entry.total_hours)) > 0.01 && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span className="text-amber-600 dark:text-amber-400">
                          {t("shpClockMeasured", "Clock: {h}").replace(
                            "{h}", fmtHours(Number(entry.clock_hours), lang))}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Hours + Earned. While editing, the editor takes its own
                    full-width row: inside this non-shrinking column its Gem
                    and Annuller rendered outside the card on a phone and a
                    tablet, and a clocked shift could not be corrected there. */}
                <div className={isEditing ? "basis-full w-full" : "text-right flex-shrink-0"}>
                  {isEditing ? (
                    <div className="flex flex-wrap items-end justify-start sm:justify-end gap-2">
                      {editTimes ? (
                        <>
                          {/* Times, not a total: the register keeps in/out. */}
                          <label className="text-[11px] text-gray-500 dark:text-gray-400 text-left">
                            {t("shpEditStart", "Start")}
                            <input type="time" value={editTimes.start} autoFocus
                              onChange={(e) => setEditTimes((v) => ({ ...v, start: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") handleEdit(entry.id); if (e.key === "Escape") stopEdit(); }}
                              className="block h-10 w-28 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-400" />
                          </label>
                          <label className="text-[11px] text-gray-500 dark:text-gray-400 text-left">
                            {t("shpEditEnd", "End")}
                            <input type="time" value={editTimes.end}
                              onChange={(e) => setEditTimes((v) => ({ ...v, end: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") handleEdit(entry.id); if (e.key === "Escape") stopEdit(); }}
                              className="block h-10 w-28 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-400" />
                          </label>
                          <label className="text-[11px] text-gray-500 dark:text-gray-400 text-left">
                            {t("shpEditBreak", "Break (min)")}
                            <input type="number" inputMode="numeric" min="0" max="240" step="5" value={editTimes.brk}
                              onChange={(e) => setEditTimes((v) => ({ ...v, brk: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") handleEdit(entry.id); if (e.key === "Escape") stopEdit(); }}
                              className="block h-10 w-20 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-400" />
                          </label>
                          {editTimes.start && editTimes.end && (
                            <span className="h-10 inline-flex items-center text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                              = {formatHours(calcHoursFromTimes(editTimes.start, editTimes.end, parseInt(editTimes.brk, 10) || 0), { lang, decimals: 2 })}
                            </span>
                          )}
                        </>
                      ) : (
                        <label className="text-[11px] text-gray-500 dark:text-gray-400 text-left">
                          {t("shpEditTotal", "Hours")}
                          <input
                            type="number"
                            step="0.25"
                            min="0"
                            max="24"
                            value={editHours}
                            onChange={e => setEditHours(e.target.value)}
                            className="block h-10 w-20 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-400"
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === "Enter") handleEdit(entry.id);
                              if (e.key === "Escape") stopEdit();
                            }}
                          />
                        </label>
                      )}
                      <Button size="md" variant="primary" className="h-10" onClick={() => handleEdit(entry.id)} disabled={editSaving}>
                        {editSaving ? t("saving", "Saving…") : t("save", "Save")}
                      </Button>
                      <Button size="md" variant="ghost" className="h-10" onClick={stopEdit}>
                        {t("cancel", "Cancel")}
                      </Button>
                      {editErr && (
                        <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
                          {editErr}
                        </span>
                      )}
                    </div>
                  ) : (
                    <>
                      <span className="font-bold text-gray-800 dark:text-white text-sm">
                        {formatHours(entry.total_hours, { lang, decimals: 2 })}
                      </span>
                      {/* Was "1200 DKK" — ungrouped, raw code — on the audit
                          trail of the same period the tiles price in "kr.". */}
                      {entry.earned != null && entry.earned > 0 && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          <Amount value={entry.earned} currency={currency} decimals={2} />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Actions */}
                {/* 28px-wide targets, 4px apart, on a payroll record — and the
                    right-hand one permanently deletes it. The coarse-pointer
                    floor in index.css sets min-height:44px but not min-width,
                    so on a phone these were 28x44 with a 4px gap: a thumb
                    aiming at Edit could land on Delete.
                    TOUCH ONLY. Gated on the same hover query the visibility
                    rule beside it uses: on a pointer device these buttons are
                    opacity-hidden until hover but still HOLD LAYOUT, so a
                    blanket min-width would have taken ~36px off the content
                    column of every row at every viewport — including desktop,
                    where a mouse never needed the target. Widening a control
                    nobody was mis-tapping is not a fix, it is a layout change.
                    On hover:none they are always visible and become 44x44,
                    8px apart. */}
                {!isEditing && (
                  // focus-within: a keyboard user tabbed onto an invisible
                  // Edit and Delete — on a pay record.
                  <div className="flex items-center gap-1 [@media(hover:none)]:gap-2 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={() => startEdit(entry)}
                      className="p-1.5 [@media(hover:none)]:min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                      title={t("editHours", "Edit hours")}
                      aria-label={t("editHours", "Edit hours")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(entry)}
                      disabled={isDeleting}
                      className="p-1.5 [@media(hover:none)]:min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition disabled:opacity-40"
                      title={t("deleteEntry", "Delete entry")}
                      aria-label={t("deleteEntry", "Delete entry")}
                    >
                      {isDeleting ? (
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </AnimatedListItem>
          );
        })}
      </AnimatedList>
    </div>
    </div>
  );
}
