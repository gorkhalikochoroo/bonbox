// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { errText } from "../utils/errText";
import { FadeIn, TabContent, AnimatedList, AnimatedListItem, AnimatePresence } from "../components/AnimationKit";
import { PageHeader, Button, TabPills, Icon, StatCard, SectionBanner } from "../components/ui";

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDateFull(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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
const METHOD_BADGES = {
  quick: { icon: "FileText", labelKey: "hovMethodQuick" },
  clock: { icon: "Clock", labelKey: "hovMethodClock" },
  schedule: { icon: "CalendarCheck", labelKey: "hovMethodSchedule" },
};
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

  // Data
  const [summary, setSummary] = useState([]);
  const [entries, setEntries] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [recentBeforeCount, setRecentBeforeCount] = useState(0);

  // Overview payload (one-glance hero + genuine narrative). Own fetch so a
  // slow summary/entries load never blocks the answer at the top.
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  // Period-frame control — how the owner frames the period to extract hours
  // (1st–end / 15th→14th / custom start-day / biweekly), plus an ad-hoc custom
  // date range. period_type/custom_start_day mirror the shared pay-period
  // config so Hours + Payroll always agree; "custom" range is a local override
  // that does NOT persist to the config.
  const [periodType, setPeriodType] = useState("monthly_1st");
  const [customStartDay, setCustomStartDay] = useState(16);
  const [frameMode, setFrameMode] = useState("recurring"); // "recurring" | "custom"

  // Fetch pay period config
  useEffect(() => {
    const fallbackPeriod = () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setPeriodFrom(isoDate(start));
      setPeriodTo(isoDate(end));
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
        } else {
          fallbackPeriod();
        }
      })
      .catch(() => {
        fallbackPeriod();
      })
      .finally(() => setPeriodLoading(false));
  }, []);

  // Fetch staff list
  useEffect(() => {
    api.get("/staff/members")
      .then(r => setStaffList(r.data || []))
      .catch(() => {});
  }, []);

  // Fetch summary + entries when period changes
  const fetchData = useCallback(() => {
    if (!periodFrom || !periodTo) return;
    setSummaryLoading(true);
    setEntriesLoading(true);

    api.get("/staff/hours/summary", { params: { from: periodFrom, to: periodTo } })
      .then(r => setSummary(r.data || []))
      .catch(() => setSummary([]))
      .finally(() => setSummaryLoading(false));

    api.get("/staff/hours", { params: { from: periodFrom, to: periodTo } })
      .then(r => setEntries(r.data || []))
      .catch(() => setEntries([]))
      .finally(() => setEntriesLoading(false));
  }, [periodFrom, periodTo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Keep the frame picker in sync when the saved config lands.
  useEffect(() => {
    if (!periodConfig) return;
    setPeriodType(periodConfig.period_type || "monthly_1st");
    if (periodConfig.custom_start_day) setCustomStartDay(periodConfig.custom_start_day);
  }, [periodConfig]);

  // Overview — the hero + narrative. Own loading state; compare=prev so the
  // narrative can (honestly) trend vs the prior equal-length period.
  useEffect(() => {
    if (!periodFrom || !periodTo) return;
    let alive = true;
    setOverviewLoading(true);
    api.get("/staff/hours/overview", { params: { from: periodFrom, to: periodTo, compare: "prev" } })
      .then((r) => { if (alive) setOverview(r.data || null); })
      .catch(() => { if (alive) setOverview(null); })
      .finally(() => { if (alive) setOverviewLoading(false); });
    return () => { alive = false; };
  }, [periodFrom, periodTo]);

  // Re-pull the overview after a log/edit so the hero + narrative stay honest.
  const refetchAll = useCallback(() => {
    fetchData();
    if (periodFrom && periodTo) {
      api.get("/staff/hours/overview", { params: { from: periodFrom, to: periodTo, compare: "prev" } })
        .then((r) => setOverview(r.data || null))
        .catch(() => {});
    }
  }, [fetchData, periodFrom, periodTo]);

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
  useEffect(() => {
    if (!periodFrom) return; // count stays 0 (initial) until a period is set
    let alive = true;
    api.get("/staff/hours", { params: { from: addDays(periodFrom, -4), to: addDays(periodFrom, -1) } })
      .then((r) => {
        if (!alive) return;
        setRecentBeforeCount((r.data || []).filter((e) => e.entry_method === "clock" && e.end_time).length);
      })
      .catch(() => { if (alive) setRecentBeforeCount(0); });
    return () => { alive = false; };
  }, [periodFrom]);

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
    const csd = type === "custom" ? (parseInt(day, 10) || customStartDay || 1) : null;
    if (csd) setCustomStartDay(csd);
    try {
      await api.post("/staff/pay-period", { period_type: type, custom_start_day: csd });
      const r = await api.get("/staff/pay-period/current");
      const d = r.data || {};
      const start = d.start_date || d.period_start || d.start || d.from;
      const end = d.end_date || d.period_end || d.end || d.to;
      if (start && end) { setPeriodFrom(start); setPeriodTo(end); }
      setPeriodConfig((c) => ({ ...(c || {}), period_type: type, custom_start_day: csd }));
    } catch {
      // Non-fatal: the picker still reflects the choice; a refresh reconciles.
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
    { id: "details", label: t("hovTabDetails", "Details"), count: entries?.length || undefined },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4 sm:space-y-6">
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
          periodType={frameMode === "custom" ? "custom_range" : periodType}
          customStartDay={customStartDay}
          onSelectFrame={selectFrame}
          onCustomRange={applyCustomRange}
        />
      </FadeIn>

      {/* Boundary nudge: this period shows no clocked hours, but a shift was
          clocked in the days just before it (an after-midnight punch is dated
          to the previous business day → lands in the prior period). One tap
          jumps there so the hours never look "missing". */}
      {recentBeforeCount > 0 && !currentHasClock && (
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
            loading={overviewLoading}
            currency={currency}
            onGoLog={() => setSubTab("log")}
          />
        </FadeIn>
      )}

      {/* LOG — the existing 3-tab logging block, unchanged behavior. */}
      {subTab === "log" && (
        <FadeIn delay={0.1}>
          <LoggingSection
            staffList={staffList}
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
              loading={summaryLoading}
              currency={currency}
              onResolved={refetchAll}
            />
          </FadeIn>
          <FadeIn delay={0.15}>
            <RecentHoursLog
              entries={entries}
              loading={entriesLoading}
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
// da-DK grouped integer + a currency word. DKK shows "kr" (the DK convention);
// other currencies show their code — we NEVER auto-convert across currencies.
function fmtMoneyShort(n, currencyCode) {
  const num = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(
    Math.round(Number(n) || 0),
  );
  const unit = !currencyCode || currencyCode === "DKK" ? "kr" : currencyCode;
  return `${num} ${unit}`;
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

function fillNarrative(t, currencyCode, line) {
  const key = NAR_KEY[line?.code];
  if (!key) return null;
  let s = t(key, line.code);
  const p = line.params || {};
  Object.keys(p).forEach((k) => {
    // Money params are formatted with the currency word; the rest are plain.
    const v = k === "cost" || k === "gross" ? fmtMoneyShort(p[k], currencyCode) : String(p[k]);
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
  { id: "biweekly", key: "hovFrameBiweekly" },
  { id: "custom_range", key: "hovFrameCustomRange" },
];

function PeriodControl({ from, to, loading, onPrev, onNext, periodType, customStartDay, onSelectFrame, onCustomRange }) {
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

          {periodType !== "custom_range" && editor !== "custom_range" && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500">{t("hovFrameSavedNote", "Saved — used for Hours and Payroll.")}</p>
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
  const { t } = useLanguage();
  if (!lines || lines.length === 0) return null;
  const sevMap = { good: "success", watch: "warn", alert: "critical", info: "info" };
  const iconMap = { success: "CheckCircle2", warn: "AlertTriangle", critical: "AlertTriangle", info: "Clock" };
  const variant = sevMap[severity] || "info";
  const rendered = lines.map((ln) => fillNarrative(t, currencyCode, ln)).filter(Boolean);
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

function HoursOverview({ overview, loading, currency, onGoLog }) {
  const { t } = useLanguage();

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
  if (!overview) return null;

  // Empty period → ONE honest card, never four "0"-value tiles that read like a
  // real slow week.
  if (!overview.has_any_hours) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
        <Icon name="Clock" size={28} className="text-gray-400 mx-auto mb-2" />
        <p className="text-gray-800 dark:text-gray-100 font-medium">{t("hovEmptyTitle", "No hours logged yet for this period")}</p>
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
      ? t("hovTileHoursSub", "{measured}% clocked · of {scheduled} t planned")
          .split("{measured}").join(measuredPct)
          .split("{scheduled}").join(hours.scheduled_total)
      : t("hovTileHoursSubNoPlan", "{measured}% clocked").split("{measured}").join(measuredPct);
  const hoursHelper = `${hoursHelperBase}${soFar}`;

  // Tile 2 — Lønudgift. With no configured wage rate gross=0 → show a neutral
  // "set wage rates" state instead of a misleading ~0 kr.
  let costValue = `~${fmtMoneyShort(cost.loaded_est, currency)}`;
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
    limHelper = over.length === 1 ? `${over[0].name} · ${over[0].actual}/${over[0].limit} t` : t("hovLimitsOver", "{n} over limit").split("{n}").join(over.length);
  } else if (near.length > 0) {
    limAccent = "warn";
    limVal = String(near.length);
    limHelper = near.length === 1 ? `${near[0].name} · ${near[0].actual}/${near[0].limit} t` : t("hovLimitsNear", "{n} near limit").split("{n}").join(near.length);
  } else if (ot > 0) {
    limAccent = "warn";
    limVal = `${ot} t`;
    limHelper = t("hovOvertimeHrs", "{n} t overtime").split("{n}").join(ot);
  }

  return (
    <div className="space-y-4">
      <NarrativeBanner lines={overview.narrative} severity={overview.banner_severity} currencyCode={currency} inProgress={!period.is_complete} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          dense
          label={t("hovTileHours", "Hours")}
          value={`${hours.actual_total ?? 0} t`}
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
                  <span className="text-gray-900 dark:text-gray-100 font-medium">~{fmtMoneyShort(c.loaded, currency)}</span>
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

/** Danish writes 7,0 t — not 7.0h. The old code was `toFixed(1) + "h"`, which
    was wrong in every row of the primary market. */
function fmtHours(n, lang) {
  if (n == null) return "\u2014";
  const num = new Intl.NumberFormat(lang === "da" ? "da-DK" : "en-GB", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(n);
  return `${num} ${lang === "da" ? "t" : "h"}`;
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
      setErr(errText(e, t("shpResolveFailed", "Could not save. Try again.")));
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

function HoursSummaryTable({ summary, loading, currency, onResolved }) {
  const { t, lang } = useLanguage();
  const [resolving, setResolving] = useState(null);   // {staffId, staffName, exception}
  // Same server field the rows read, so the chip and the rows can never
  // disagree about how many shifts are unanswered.
  const needsAnswer = (summary || []).reduce(
    (n, r) => n + (r.needs_answer_count || 0), 0,
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
            {summary.map((row, idx) => {
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
                          {stateMeta && row.scheduled_hours != null && (
                            <span className={stateMeta.cls}>
                              {" \u00b7 "}{stateMeta.label}
                            </span>
                          )}
                        </div>
                        {isNearLimit && (
                          <div className={`text-xs mt-0.5 font-semibold ${isOverLimit ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {row.staff_name?.split(" ")[0]}: {Math.round(row.actual_hours)}/{row.work_limit} hrs!
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.scheduled_hours != null ? `${row.scheduled_hours.toFixed(1)}h` : "\u2014"}
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {row.actual_hours != null ? `${row.actual_hours.toFixed(1)}h` : "\u2014"}
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
                  <td className="hidden md:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.hourly_rate != null ? `${row.hourly_rate} ${currency}/hr` : "\u2014"}
                  </td>
                  <td className="hidden sm:table-cell px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {row.earned != null ? `${row.earned.toFixed(0)} ${currency}` : "\u2014"}
                  </td>
                  <td className="hidden md:table-cell px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.tips != null && row.tips > 0 ? `${row.tips.toFixed(0)} ${currency}` : "\u2014"}
                  </td>
                  <td className="px-3 py-3 text-right font-bold text-gray-900 dark:text-white tabular-nums">
                    {row.total != null ? `${row.total.toFixed(0)} ${currency}` : "\u2014"}
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
                {summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0).toFixed(1)}h
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.actual_hours || 0), 0).toFixed(1)}h
              </td>
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {(() => {
                  const d = summary.reduce((s, r) => s + (r.actual_hours || 0), 0) - summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0);
                  return d === 0 ? "\u2014" : `${d > 0 ? "+" : ""}${d.toFixed(1)}h`;
                })()}
              </td>
              <td className="hidden md:table-cell px-3 py-3" />
              <td className="hidden sm:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.earned || 0), 0).toFixed(0)} {currency}
              </td>
              <td className="hidden md:table-cell px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.tips || 0), 0).toFixed(0)} {currency}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.total || 0), 0).toFixed(0)} {currency}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

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
  );
}

/* ═══════════════════════════════════════════════════════════
   LOGGING SECTION — 3 TABS
   ═══════════════════════════════════════════════════════════ */
function LoggingSection({ staffList, currency, periodFrom, onLogged }) {
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
        <TabContent tabKey={logTab}>
          {logTab === "quick" && (
            <QuickLogForm staffList={staffList} currency={currency} onLogged={onLogged} />
          )}
          {logTab === "clock" && (
            <ClockInOutForm staffList={staffList} currency={currency} onLogged={onLogged} />
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
function QuickLogForm({ staffList, currency, onLogged }) {
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
      setError(errText(err, t("shpFailedLogHours", "Failed to log hours")));
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
            <option value="">{t("shpSelectStaff", "Select staff...")}</option>
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
function ClockInOutForm({ staffList, currency, onLogged }) {
  const { t } = useLanguage();
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

  // Look up staff rate for preview
  const selectedStaff = staffList.find(s => s.id === staffId);
  const rate = selectedStaff?.hourly_rate || null;
  const estimated = rate && calcHours > 0 ? (rate * calcHours).toFixed(0) : null;

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
      setError(errText(err, t("shpFailedLogEntry", "Failed to log entry")));
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
            <option value="">{t("shpSelectStaff", "Select staff...")}</option>
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
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg px-4 py-2.5 w-full">
            <span className="text-xs text-gray-500 dark:text-gray-400 block">{t("calculated")}</span>
            <span className="text-lg font-bold text-gray-800 dark:text-white">
              {calcHours > 0 ? `${calcHours}h` : "\u2014"}
            </span>
            {estimated && (
              <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
                ({estimated} {currency} at {rate}/{currency === "DKK" ? "kr" : currency}/hr)
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
      setError(errText(err, t("shpFailedConfirmSchedule", "Failed to confirm schedule")));
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

      {result && (
        <div className="bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-300">
            {t("shpScheduleConfirmed", "Schedule confirmed!")}
          </p>
          {result.confirmed_count != null && (
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
              {t("shpShiftsLogged", "{count} shifts logged as actual hours.").replace("{count}", result.confirmed_count)}
            </p>
          )}
          {result.skipped_count > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              {t("shpShiftsSkipped", "{count} shifts skipped (already logged).").replace("{count}", result.skipped_count)}
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
function RecentHoursLog({ entries, loading, currency, staffList, onUpdated }) {
  const { t, lang } = useLanguage();
  const [editingId, setEditingId] = useState(null);
  const [editHours, setEditHours] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  // Build a name lookup
  const nameMap = useMemo(() => {
    const map = {};
    staffList.forEach(s => { map[s.id] = s.name; });
    return map;
  }, [staffList]);

  const handleEdit = async (id) => {
    if (!editHours) return;
    setEditSaving(true);
    try {
      await api.put(`/staff/hours/${id}`, { total_hours: parseFloat(editHours) });
      setEditingId(null);
      setEditHours("");
      onUpdated();
    } catch {
      // silent
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setDeletingId(id);
    try {
      await api.delete(`/staff/hours/${id}`);
      onUpdated();
    } catch {
      // silent
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
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800 dark:text-white">{t("recentHoursLog")}</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{t("shpEntriesCount", "{count} entries").replace("{count}", sorted.length)}</span>
      </div>

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
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${METHOD_CHIP}`}>
                      <Icon name={badge.icon} size={10} />
                      {badgeLabel}
                    </span>
                  </div>
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <span>{fmtDateFull(entry.date)}</span>
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
                    <div className="flex items-center gap-1">
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
                        onClick={() => { setEditingId(null); setEditHours(""); }}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                      >
                        {t("cancel", "Cancel")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="font-bold text-gray-800 dark:text-white text-sm">
                        {entry.total_hours != null ? `${entry.total_hours}h` : "\u2014"}
                      </span>
                      {entry.earned != null && entry.earned > 0 && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {entry.earned.toFixed(0)} {currency}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Actions */}
                {!isEditing && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={() => { setEditingId(entry.id); setEditHours(String(entry.total_hours || "")); }}
                      className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                      title={t("editHours", "Edit hours")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      disabled={isDeleting}
                      className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition disabled:opacity-40"
                      title={t("deleteEntry", "Delete entry")}
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
  );
}
