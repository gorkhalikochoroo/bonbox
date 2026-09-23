// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { dateLocale } from "../utils/dateFormat";
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

function today() {
  return isoDate(new Date());
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
// WEIGHT, not status colour, and the distinction is deliberate.
//
// These three chips answer one question: how much does this number deserve to
// be believed? Stempelur MEASURED it. Tastet means a person asserted it. Fra
// plan means nobody did either — it was assumed from a roster.
//
// The obvious move is three colours. The colour law a few hundred lines down
// forbids it, and is right to: amber means "needs an answer from you", and on
// this venue 96% of hours are not clocked, so amber-for-unmeasured would paint
// almost every row — "once everything is coloured nothing is", as the rail
// comment in this file puts it. Grey is already the correct colour for a
// measured fact.
//
// So the gradient is in WEIGHT. Stempelur is the darkest and the only one that
// carries a border, because it is the row an owner can defend to
// Arbejdstilsynet. Fra plan is the faintest, because it is the weakest claim on
// the page. Scannable at a glance, and it says something true rather than
// decorating.
const METHOD_BADGES = {
  quick: {
    icon: "FileText",
    labelKey: "hovMethodQuick",
    // Asserted by a person. Mid weight.
    chip: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200",
  },
  clock: {
    icon: "Clock",
    labelKey: "hovMethodClock",
    // Measured. The strongest claim, so the strongest chip.
    chip: "bg-gray-900 text-white ring-1 ring-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:ring-gray-100",
  },
  schedule: {
    icon: "CalendarCheck",
    labelKey: "hovMethodSchedule",
    // Assumed from a roster. Faintest — nobody has confirmed this happened.
    chip: "bg-transparent text-gray-500 ring-1 ring-gray-200 dark:text-gray-400 dark:ring-gray-700",
  },
};
// Fallback for an unknown method — never stronger than a measured one.
const METHOD_CHIP =
  "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffHoursPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

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
      setPeriodFrom(isoDate(start));
      setPeriodTo(isoDate(end));
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
          setPeriodFrom(start);
          setPeriodTo(end);
          setCurrentWindow({ from: start, to: end });
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
    setPeriodFrom(addDays(periodFrom, -periodLength));
    setPeriodTo(addDays(periodTo, -periodLength));
  };

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
    setFrameMode("custom");
    setPeriodFrom(from);
    setPeriodTo(to);
  };

  // Sub-tabs — the page now opens on the ANSWER (Oversigt), not the logging
  // form. Same three destinations on every viewport (desktop parity); the
  // logging block + the accountant detail are one tap away, never the landing.
  const [subTab, setSubTab] = useState("overview"); // "overview" | "log" | "details"
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
          customStartDay={customStartDay}
          onSelectFrame={selectFrame}
          onCustomRange={applyCustomRange}
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
            overview={overview}
            // The period window is a precondition for this request, so while it
            // resolves the tab is LOADING, not answered-and-empty.
            loading={overviewQ.loading || periodLoading}
            failed={overviewFailed}
            onRetry={overviewQ.reload}
            denied={overviewDenied}
            currency={currency}
            onGoLog={() => setSubTab("log")}
            onGoDetails={() => setSubTab("details")}
            rosterEmpty={rosterEmpty}
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
const FRAME_OPTIONS = [
  { id: "monthly_1st", key: "hovFrameMonth1" },
  { id: "monthly_15th", key: "hovFrameMonth15" },
  { id: "custom", key: "hovFrameCustom" },
  { id: "weekly", key: "hovFrameWeekly" },
  { id: "biweekly", key: "hovFrameBiweekly" },
  { id: "custom_range", key: "hovFrameCustomRange" },
];

function PeriodControl({ from, to, loading, onPrev, onNext, isCurrent = true, onCurrent, periodType, customStartDay, onSelectFrame, onCustomRange, saveFailed = false }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // Which editor sub-panel is open. The two editor chips (custom start-day,
  // ad-hoc range) don't change the active frame until confirmed, so they need
  // their own local "which panel is expanded" state — the panels also stay open
  // when the active periodType prop already is that frame.
  const [editor, setEditor] = useState(null); // null | "custom" | "custom_range"
  const [dayDraft, setDayDraft] = useState(customStartDay || 16);
  const [rangeFrom, setRangeFrom] = useState(from || "");
  const [rangeTo, setRangeTo] = useState(to || "");

  useEffect(() => { if (customStartDay) setDayDraft(customStartDay); }, [customStartDay]);
  useEffect(() => { if (from) setRangeFrom(from); if (to) setRangeTo(to); }, [from, to]);

  const inputCls =
    "border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-2.5 py-2 text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none";

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
          className="min-w-0 flex-1 mx-1 rounded-lg px-2 py-1 text-center hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
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

      {/* The way back to now. Silent while the current period IS on screen —
          a button that does nothing is worse than no button — and a plain
          text control, not a third arrow, so the row keeps its shape on a
          375px phone. */}
      {!loading && !isCurrent && onCurrent && (
        <div className="px-3 sm:px-4 pb-3 sm:pb-4 -mt-2 flex justify-center">
          <button
            type="button"
            onClick={onCurrent}
            className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg text-[13px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            {t("hovThisPeriod", "This period")}
          </button>
        </div>
      )}

      {/* Frame picker — one tap, no trip to Payroll settings. */}
      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700 p-3 sm:p-4 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("hovFrameHeading", "How is the period framed?")}
          </p>
          <div className="flex flex-wrap gap-2">
            {FRAME_OPTIONS.map((opt) => {
              const selected = periodType === opt.id || editor === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    // The two editor chips reveal their sub-panel; a normal
                    // recurring chip applies immediately and closes any editor.
                    if (opt.id === "custom" || opt.id === "custom_range") {
                      setEditor(opt.id);
                      return;
                    }
                    setEditor(null);
                    onSelectFrame(opt.id);
                  }}
                  aria-pressed={selected}
                  className={
                    "px-3 py-1.5 rounded-lg text-[13px] font-medium border transition " +
                    (selected
                      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                      : "bg-white text-gray-700 border-gray-200 hover:border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600")
                  }
                >
                  {t(opt.key, opt.id)}
                </button>
              );
            })}
          </div>

          {/* Custom start day — e.g. the 16th → 15th */}
          {(periodType === "custom" || editor === "custom") && (
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {t("hovFrameStartDay", "Starts on day")}
                </label>
                <input
                  type="number" min="1" max="28" value={dayDraft}
                  onChange={(e) => setDayDraft(e.target.value)}
                  className={inputCls + " w-20"}
                />
              </div>
              <button
                type="button"
                onClick={() => { setEditor(null); onSelectFrame("custom", dayDraft); }}
                className="bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-4 py-2 rounded-lg transition"
              >
                {t("save", "Save")}
              </button>
            </div>
          )}

          {/* Ad-hoc custom date range — a one-off extraction, not saved. */}
          {(periodType === "custom_range" || editor === "custom_range") && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">{t("hovFrameFrom", "From")}</label>
                <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1">{t("hovFrameTo", "To")}</label>
                <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className={inputCls} />
              </div>
              <button
                type="button"
                onClick={() => { setEditor(null); onCustomRange(rangeFrom, rangeTo); }}
                disabled={!rangeFrom || !rangeTo || rangeTo < rangeFrom}
                className="bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white font-medium text-sm px-4 py-2 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("hovFrameApply", "Show these dates")}
              </button>
            </div>
          )}

          {/* "Saved — used for Hours and Payroll." is a statement about the
              SERVER, so it may only appear when the write reached it. When it
              did not, the frame on screen is a local view and the note says
              exactly that instead of quietly claiming Løn now agrees. */}
          {periodType !== "custom_range" && editor !== "custom_range" && (
            saveFailed ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {t("hovFrameNotSaved", "Not saved — showing here only. Pick the frame again to retry.")}
              </p>
            ) : (
              <p className="text-[11px] text-gray-400 dark:text-gray-500">{t("hovFrameSavedNote", "Saved — used for Hours and Payroll.")}</p>
            )
          )}
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

function HoursOverview({ overview, loading, failed, onRetry, denied, currency, onGoLog, onGoDetails, rosterEmpty = false }) {
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
        actionLabel={t("hovTabDetails", "Details")}
        onAction={onGoDetails}
      />
    );
  }

  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <div className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
              {t("hovEmptyAddStaffWhere", "Under Manage staff on Vagtplan.")}
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
  let costHelper = `${t("hovTileCostSub", "~ incl. feriepenge · estimate")}${soFar}`;
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
  if (pct != null) {
    pctValue = `${Math.round(pct * 100)}%`;
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
      <NarrativeBanner lines={overview.narrative} severity={overview.banner_severity} currencyCode={currency} inProgress={!period.is_complete} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          dense
          label={t("hovTileHours", "Hours")}
          value={formatHours(hours.actual_total, { lang })}
          helper={hoursHelper}
        />
        <StatCard
          dense
          label={t("hovTileCost", "Labor cost")}
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

      {overview.labor_split && <LaborSplitCard split={overview.labor_split} currency={currency} />}
    </div>
  );
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
  const { t } = useLanguage();
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
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{pct}%</span>
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

    Deliberately NOT here: a "godkend alle" button. Batch navigation is fine;
    batch decision is not — a single tap that accepts twelve shifts the owner
    never looked at is exactly the rubber stamp this feature exists to replace.
*/
/** The first shift worth asking about. Unanswered punches outrank measured
    deviations — only one of them needs a human. */
function firstException(row) {
  const ex = row.exceptions || [];
  return ex.find((e) => e.state === "no_clock_in") || ex[0] || null;
}

function ResolveSheet({ staffId, staffName, exception, onClose, onResolved }) {
  const { t, lang } = useLanguage();
  const [hours, setHours] = useState(
    exception?.scheduled_hours != null ? String(exception.scheduled_hours) : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const send = async (action, total) => {
    setBusy(true); setErr("");
    try {
      await api.post("/staff/hours/resolve", {
        staff_id: staffId,
        date: exception.date,
        action,
        ...(total != null ? { total_hours: total } : {}),
      });
      onResolved();
      onClose();
    } catch (e) {
      // Surfaced, never swallowed. The old edit path had `catch { /* silent */ }`
      // so a failed save looked exactly like a successful one — on a pay record.
      setErr(houseErrText(e, t("shpResolveFailed", "Could not save. Try again.")));
      setBusy(false);
    }
  };

  const isMissing = exception?.state === "no_clock_in";

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog" aria-modal="true"
        className="relative w-full sm:max-w-sm bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl p-5"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{staffName}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {fmtDateFull(exception.date)} ·{" "}
          {t("shpScheduledShort", "{h} scheduled").replace("{h}", fmtHours(exception.scheduled_hours, lang))}
        </p>

        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {isMissing
            ? t("shpResolveMissingBody", "The clock recorded nothing for this shift. Only you know what happened.")
            : t("shpResolveShortBody", "The clock recorded {a} of {s}.")
                .replace("{a}", fmtHours(exception.actual_hours, lang))
                .replace("{s}", fmtHours(exception.scheduled_hours, lang))}
        </p>

        {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>}

        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="number" step="0.25" min="0" max="24"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-label={t("shpResolveHoursLabel", "Hours worked")}
              className="w-24 px-3 py-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 tabular-nums outline-none"
            />
            <Button
              className="flex-1"
              disabled={busy || !hours}
              onClick={() => send("adjust", parseFloat(hours))}
            >
              {t("shpResolveWorked", "They worked this")}
            </Button>
          </div>
          <Button
            variant="secondary" className="w-full" disabled={busy}
            onClick={() => send("absent")}
          >
            {t("shpResolveAbsent", "They did not work")}
          </Button>
          {!isMissing && (
            <Button
              variant="secondary" className="w-full" disabled={busy}
              onClick={() => send("confirm")}
            >
              {t("shpResolveConfirm", "The record is correct")}
            </Button>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-3 w-full text-center text-sm text-gray-500 dark:text-gray-400 py-2"
        >
          {t("shpResolveCancel", "Not now")}
        </button>
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

function HoursSummaryTable({ summary, loading, failed, onRetry, denied, currency, onResolved }) {
  const { t, lang } = useLanguage();
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
  const [resolving, setResolving] = useState(null);   // {staffId, staffName, exception}
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
  const moneyTotal = (key, unknowable = false) => (
    <Amount
      value={
        wagesHidden || unknowable
          ? null
          : (summary || []).reduce((s, r) => s + (r[key] || 0), 0)
      }
      currency={currency}
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
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{t("shpSummaryEmptyHint", "Use the logging section below to start tracking hours.")}</p>
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
          {needsAnswer > 0 && (
            <span
              className="inline-flex items-center gap-1.5 shrink-0 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-400"
            >
              <Icon name="AlertTriangle" className="w-3.5 h-3.5" aria-hidden />
              {needsAnswer === 1
                ? t("shpNeedsAnswerOne", "1 shift needs your answer")
                : t("shpNeedsAnswer", "{n} shifts need your answer").replace("{n}", String(needsAnswer))}
            </span>
          )}
        </div>
      </div>

      {/* Mobile-friendly columns: name + actual + total survive on phones;
          scheduled / diff / rate / earned / tips hide on < sm so the table
          fits a 375px viewport without horizontal-scroll.  Owner can tap
          the row OR view this page on tablet+ for the accountant-grade
          breakdown.  Pattern matches the Faktura row mobile pass (#140). */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-750 text-gray-500 dark:text-gray-400 text-left text-xs uppercase tracking-wider">
              <th className="px-3 sm:px-5 py-3 font-medium">{t("navStaff")}</th>
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right">{t("scheduled")}</th>
              <th className="px-3 py-3 font-medium text-right">{t("actual")}</th>
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right">{t("diff")}</th>
              <th className="hidden md:table-cell px-3 py-3 font-medium text-right">{t("rate")}</th>
              <th className="hidden sm:table-cell px-3 py-3 font-medium text-right">{t("earned")}</th>
              <th className="hidden md:table-cell px-3 py-3 font-medium text-right">{t("tips")}</th>
              <th className="px-3 sm:px-3 py-3 font-medium text-right">{t("total")}</th>
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
                  className="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                >
                  <td className="px-3 sm:px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-gray-300 flex-shrink-0">
                        {(row.staff_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <span className="font-medium text-gray-800 dark:text-white">{row.staff_name}</span>
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
                            onClick={() => setResolving({
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
                  <td className={`hidden sm:table-cell px-3 py-3 text-right font-medium ${
                    stateMeta ? stateMeta.cls : "text-gray-400 dark:text-gray-500"
                  }`}>
                    {/* A word, not a signed number. The number is already in
                        Scheduled and Actual either side of this cell, and it is
                        correct there; what it could never carry is WHICH KIND of
                        deviation this was. */}
                    {stateMeta ? (
                      firstException(row) ? (
                        <button
                          type="button"
                          onClick={() => setResolving({
                            staffId: row.staff_id,
                            staffName: row.staff_name,
                            exception: firstException(row),
                          })}
                          className="inline-flex items-center gap-1 justify-end underline underline-offset-2 decoration-dotted"
                        >
                          {stateMeta.label}
                          {row.needs_answer_count > 1 && (
                            <span className="tabular-nums opacity-70">×{row.needs_answer_count}</span>
                          )}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 justify-end">
                          {stateMeta.label}
                        </span>
                      )
                    ) : "\u2014"}
                  </td>
                  {/* The rate read "150 DKK/hr" — an English unit and a raw
                      currency code on a Danish payroll row. The unit now comes
                      off utils/hours.js, the same place the hour columns get
                      theirs, so a Danish owner reads "150 kr./t". */}
                  <td className="hidden md:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
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
                      <Amount value={row.earned} currency={currency} />
                    )}
                  </td>
                  <td className="hidden md:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.tips != null && row.tips > 0 ? <Amount value={row.tips} currency={currency} /> : "\u2014"}
                  </td>
                  {/* Total = earned + tips. With earned unknown the sum is
                      unknown too — printing the tips alone under a column
                      headed "I alt" would read as this person's whole pay. */}
                  <td className="px-3 py-3 text-right font-bold text-gray-900 dark:text-white tabular-nums">
                    {rateMissing(row) ? (
                      <span className="text-gray-400 dark:text-gray-500" title={t("shpEarnedNeedsRate", "No wage rate set for this person")}>&mdash;</span>
                    ) : (
                      <Amount value={row.total} currency={currency} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/* Totals row */}
          <tfoot>
            <tr className="bg-gray-50 dark:bg-gray-750 font-semibold text-gray-800 dark:text-white">
              <td className="px-3 sm:px-5 py-3 text-sm">{t("shpTotalCount", "Total ({count})").replace("{count}", summary.length)}</td>
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
              <td className="hidden md:table-cell px-3 py-3" />
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("earned", missingRateCount > 0)}
              </td>
              <td className="hidden md:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("tips")}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {moneyTotal("total", missingRateCount > 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

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

      {resolving && (
        <ResolveSheet
          staffId={resolving.staffId}
          staffName={resolving.staffName}
          exception={resolving.exception}
          onClose={() => setResolving(null)}
          onResolved={onResolved}
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
        entry_method: "clock",
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

  const handleEdit = async (id) => {
    if (!editHours) return;
    setEditErr("");
    setEditSaving(true);
    try {
      // PARTIAL body on purpose. The endpoint now binds HoursLogUpdate and
      // applies only the keys actually sent, so the row's start_time, end_time
      // and break_minutes survive a total-hours correction — those columns are
      // the venue's Arbejdstidsloven register and must show daily working time
      // for five years. Sending a "full" body to satisfy the old schema would
      // have blanked them.
      await api.put(`/staff/hours/${id}`, { total_hours: parseFloat(editHours) });
      setEditingId(null);
      setEditHours("");
      onUpdated();
    } catch (e) {
      // Stay open, keep what they typed, and SAY SO. Closing the editor here
      // would be the original bug wearing a different mask.
      setEditErr(houseErrText(e, t("shpEditHoursFailed", "Could not save. Try again.")));
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
      setDelErr(houseErrText(e, t("deleteHoursFailed")));
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
              <div className="px-5 py-3 flex items-center gap-3 group">
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-600 dark:text-gray-300 flex-shrink-0">
                  {staffName.charAt(0).toUpperCase()}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800 dark:text-white text-sm truncate">{staffName}</span>
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

                {/* Hours + Earned */}
                <div className="text-right flex-shrink-0">
                  {isEditing ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max="24"
                        value={editHours}
                        onChange={e => setEditHours(e.target.value)}
                        className="w-16 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded px-2 py-1 text-sm focus:ring-2 focus:ring-gray-400 outline-none"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") handleEdit(entry.id);
                          if (e.key === "Escape") { setEditingId(null); setEditHours(""); }
                        }}
                      />
                      <button
                        onClick={() => handleEdit(entry.id)}
                        disabled={editSaving}
                        className="text-emerald-600 hover:text-gray-700 dark:text-gray-300 text-xs font-medium"
                      >
                        {editSaving ? "..." : t("save", "Save")}
                      </button>
                      <button
                        onClick={() => { setEditingId(null); setEditHours(""); setEditErr(""); }}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                      >
                        {t("cancel", "Cancel")}
                      </button>
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
                          <Amount value={entry.earned} currency={currency} />
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
                  <div className="flex items-center gap-1 [@media(hover:none)]:gap-2 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={() => { setEditingId(entry.id); setEditHours(String(entry.total_hours || "")); }}
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
