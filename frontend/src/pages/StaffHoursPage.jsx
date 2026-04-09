import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn, TabContent, AnimatedList, AnimatedListItem, AnimatePresence } from "../components/AnimationKit";

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
  if (!from || !to) return "Loading...";
  return `${fmtDate(from)} \u2013 ${fmtDate(to)}`;
}

function isoDate(d) {
  return d.toISOString().split("T")[0];
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

function calcHoursFromTimes(start, end, breakMin) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let totalMin = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMin < 0) totalMin += 24 * 60; // overnight shift
  totalMin -= (breakMin || 0);
  return Math.max(0, +(totalMin / 60).toFixed(2));
}

const METHOD_BADGES = {
  quick: { label: "Quick", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  clock: { label: "Clock", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  schedule: { label: "Schedule", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
};

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

  // Fetch pay period config
  useEffect(() => {
    api.get("/staff/pay-period/current")
      .then(r => {
        setPeriodConfig(r.data);
        setPeriodFrom(r.data.period_start);
        setPeriodTo(r.data.period_end);
      })
      .catch(() => {
        // Fallback: current month
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        setPeriodFrom(isoDate(start));
        setPeriodTo(isoDate(end));
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

  // Period navigation
  const periodLength = useMemo(() => {
    if (!periodFrom || !periodTo) return 30;
    const a = new Date(periodFrom + "T00:00:00");
    const b = new Date(periodTo + "T00:00:00");
    return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
  }, [periodFrom, periodTo]);

  const goPrev = () => {
    if (!periodFrom || !periodTo) return;
    setPeriodFrom(addDays(periodFrom, -periodLength));
    setPeriodTo(addDays(periodTo, -periodLength));
  };

  const goNext = () => {
    if (!periodFrom || !periodTo) return;
    setPeriodFrom(addDays(periodFrom, periodLength));
    setPeriodTo(addDays(periodTo, periodLength));
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <FadeIn>
        <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
          {t("staffHours") || "Staff Hours"}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
          Track working hours, clock in/out, and confirm schedules.
        </p>
      </FadeIn>

      {/* Period Selector */}
      <FadeIn delay={0.05}>
        <PeriodSelector
          from={periodFrom}
          to={periodTo}
          loading={periodLoading}
          onPrev={goPrev}
          onNext={goNext}
        />
      </FadeIn>

      {/* Hours Summary Table */}
      <FadeIn delay={0.1}>
        <HoursSummaryTable
          summary={summary}
          loading={summaryLoading}
          currency={currency}
        />
      </FadeIn>

      {/* Logging Section */}
      <FadeIn delay={0.15}>
        <LoggingSection
          staffList={staffList}
          currency={currency}
          periodFrom={periodFrom}
          onLogged={fetchData}
        />
      </FadeIn>

      {/* Recent Hours Log */}
      <FadeIn delay={0.2}>
        <RecentHoursLog
          entries={entries}
          loading={entriesLoading}
          currency={currency}
          staffList={staffList}
          onUpdated={fetchData}
        />
      </FadeIn>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PERIOD SELECTOR
   ═══════════════════════════════════════════════════════════ */
function PeriodSelector({ from, to, loading, onPrev, onNext }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4 flex items-center justify-between">
      <button
        onClick={onPrev}
        disabled={loading}
        className="flex items-center gap-1 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 transition disabled:opacity-40"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Previous Period
      </button>

      <div className="text-center">
        {loading ? (
          <div className="h-5 w-40 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        ) : (
          <span className="text-sm font-semibold text-gray-800 dark:text-white">
            {fmtPeriod(from, to)}
          </span>
        )}
      </div>

      <button
        onClick={onNext}
        disabled={loading}
        className="flex items-center gap-1 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 transition disabled:opacity-40"
      >
        Next Period
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOURS SUMMARY TABLE
   ═══════════════════════════════════════════════════════════ */
function HoursSummaryTable({ summary, loading, currency }) {
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
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
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-8 text-center">
        <div className="text-3xl mb-2">&#128337;</div>
        <p className="text-gray-500 dark:text-gray-400 font-medium">No hours logged this period</p>
        <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">Use the logging section below to start tracking hours.</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-base font-semibold text-gray-800 dark:text-white">Period Summary</h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-750 text-gray-500 dark:text-gray-400 text-left text-xs uppercase tracking-wider">
              <th className="px-5 py-3 font-medium">Staff</th>
              <th className="px-3 py-3 font-medium text-right">Scheduled</th>
              <th className="px-3 py-3 font-medium text-right">Actual</th>
              <th className="px-3 py-3 font-medium text-right">Diff</th>
              <th className="px-3 py-3 font-medium text-right">Rate</th>
              <th className="px-3 py-3 font-medium text-right">Earned</th>
              <th className="px-3 py-3 font-medium text-right">Tips</th>
              <th className="px-3 py-3 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {summary.map((row, idx) => {
              const diff = (row.actual_hours || 0) - (row.scheduled_hours || 0);
              const isOvertime = diff > 0;
              const isNearLimit = row.work_limit && row.actual_hours >= row.work_limit * 0.95;
              const isOverLimit = row.work_limit && row.actual_hours >= row.work_limit;

              return (
                <tr
                  key={row.staff_id || idx}
                  className="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center text-xs font-bold text-green-700 dark:text-green-300">
                        {(row.staff_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <span className="font-medium text-gray-800 dark:text-white">{row.staff_name}</span>
                        {isNearLimit && (
                          <div className={`text-xs mt-0.5 font-semibold ${isOverLimit ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {row.staff_name?.split(" ")[0]}: {Math.round(row.actual_hours)}/{row.work_limit} hrs!
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.scheduled_hours != null ? `${row.scheduled_hours.toFixed(1)}h` : "\u2014"}
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {row.actual_hours != null ? `${row.actual_hours.toFixed(1)}h` : "\u2014"}
                  </td>
                  <td className={`px-3 py-3 text-right font-medium tabular-nums ${
                    diff === 0 ? "text-gray-400 dark:text-gray-500"
                      : isOvertime ? "text-red-600 dark:text-red-400"
                      : "text-green-600 dark:text-green-400"
                  }`}>
                    {diff === 0 ? "\u2014" : `${diff > 0 ? "+" : ""}${diff.toFixed(1)}h`}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
                    {row.hourly_rate != null ? `${row.hourly_rate} ${currency}/hr` : "\u2014"}
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-gray-800 dark:text-white tabular-nums">
                    {row.earned != null ? `${row.earned.toFixed(0)} ${currency}` : "\u2014"}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-600 dark:text-gray-300 tabular-nums">
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
              <td className="px-5 py-3 text-sm">Total ({summary.length} staff)</td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0).toFixed(1)}h
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.actual_hours || 0), 0).toFixed(1)}h
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {(() => {
                  const d = summary.reduce((s, r) => s + (r.actual_hours || 0), 0) - summary.reduce((s, r) => s + (r.scheduled_hours || 0), 0);
                  return d === 0 ? "\u2014" : `${d > 0 ? "+" : ""}${d.toFixed(1)}h`;
                })()}
              </td>
              <td className="px-3 py-3" />
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.earned || 0), 0).toFixed(0)} {currency}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.tips || 0), 0).toFixed(0)} {currency}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-sm">
                {summary.reduce((s, r) => s + (r.total || 0), 0).toFixed(0)} {currency}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LOGGING SECTION — 3 TABS
   ═══════════════════════════════════════════════════════════ */
function LoggingSection({ staffList, currency, periodFrom, onLogged }) {
  const [logTab, setLogTab] = useState("quick");

  const tabs = [
    { id: "quick", label: "Quick Log" },
    { id: "clock", label: "Clock In/Out" },
    { id: "schedule", label: "From Schedule" },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-base font-semibold text-gray-800 dark:text-white">Log Hours</h2>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-900/50 rounded-xl p-1 mx-4 mt-4">
        {tabs.map(tb => (
          <button
            key={tb.id}
            onClick={() => setLogTab(tb.id)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
              logTab === tb.id
                ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {tb.label}
          </button>
        ))}
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
        staff_id: Number(staffId),
        date,
        total_hours: parseFloat(hours),
        entry_method: "quick",
      });
      setSuccess("Hours logged successfully!");
      setHours("");
      onLogged();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to log hours");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Fastest way to log hours. Select staff, pick the date, enter total hours.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Staff select */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Staff Member</label>
          <select
            value={staffId}
            onChange={e => setStaffId(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            <option value="">Select staff...</option>
            {staffList.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Hours */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Total Hours</label>
          <input
            type="number"
            step="0.25"
            min="0"
            max="24"
            value={hours}
            onChange={e => setHours(e.target.value)}
            placeholder="e.g. 8"
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}

      <button
        type="submit"
        disabled={saving || !staffId || !hours}
        className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? "Saving..." : "Log Hours"}
      </button>
    </form>
  );
}

/* ─────────────────────────────────────────────────────────
   Tab 2: Clock In/Out
   ───────────────────────────────────────────────────────── */
function ClockInOutForm({ staffList, currency, onLogged }) {
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState(today());
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [breakMin, setBreakMin] = useState("30");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const calcHours = useMemo(
    () => calcHoursFromTimes(startTime, endTime, parseInt(breakMin) || 0),
    [startTime, endTime, breakMin]
  );

  // Look up staff rate for preview
  const selectedStaff = staffList.find(s => s.id === Number(staffId));
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
        staff_id: Number(staffId),
        date,
        total_hours: calcHours,
        start_time: startTime,
        end_time: endTime,
        break_minutes: parseInt(breakMin) || 0,
        entry_method: "clock",
      });
      setSuccess("Clock entry logged!");
      setStartTime("");
      setEndTime("");
      onLogged();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to log entry");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Enter clock-in and clock-out times. Break is auto-deducted.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Staff select */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Staff Member</label>
          <select
            value={staffId}
            onChange={e => setStaffId(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          >
            <option value="">Select staff...</option>
            {staffList.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Start time */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Start Time</label>
          <input
            type="time"
            value={startTime}
            onChange={e => setStartTime(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* End time */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">End Time</label>
          <input
            type="time"
            value={endTime}
            onChange={e => setEndTime(e.target.value)}
            required
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Break minutes */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Break (minutes)</label>
          <input
            type="number"
            step="5"
            min="0"
            max="120"
            value={breakMin}
            onChange={e => setBreakMin(e.target.value)}
            className="w-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        {/* Calculated preview */}
        <div className="flex items-end">
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg px-4 py-2.5 w-full">
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Calculated</span>
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
      {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}

      <button
        type="submit"
        disabled={saving || !staffId || !startTime || !endTime}
        className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? "Saving..." : "Log Clock Entry"}
      </button>
    </form>
  );
}

/* ─────────────────────────────────────────────────────────
   Tab 3: From Schedule
   ───────────────────────────────────────────────────────── */
function FromScheduleForm({ periodFrom, onLogged }) {
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
      setError(err.response?.data?.detail || "Failed to confirm schedule");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Confirm all published shifts for a given week as actual hours worked. This copies the scheduled shifts into the hours log.
      </p>

      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Week Starting (Monday)</label>
          <input
            type="date"
            value={weekStart}
            onChange={e => setWeekStart(e.target.value)}
            className="border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>

        <button
          onClick={handleConfirm}
          disabled={confirming}
          className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {confirming ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Confirming...
            </span>
          ) : (
            "Confirm All Published Shifts for This Week"
          )}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Schedule confirmed!
          </p>
          {result.confirmed_count != null && (
            <p className="text-sm text-green-700 dark:text-green-400 mt-1">
              {result.confirmed_count} shift{result.confirmed_count !== 1 ? "s" : ""} logged as actual hours.
            </p>
          )}
          {result.skipped_count > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              {result.skipped_count} shift{result.skipped_count !== 1 ? "s" : ""} skipped (already logged).
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
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
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
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-8 text-center">
        <div className="text-3xl mb-2">&#128203;</div>
        <p className="text-gray-500 dark:text-gray-400 font-medium">No hour entries this period</p>
        <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">Logged entries will appear here with edit and delete options.</p>
      </div>
    );
  }

  // Sort entries by date descending
  const sorted = [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800 dark:text-white">Recent Hours Log</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{sorted.length} entries</span>
      </div>

      <AnimatedList className="divide-y divide-gray-100 dark:divide-gray-700">
        {sorted.map(entry => {
          const staffName = entry.staff_name || nameMap[entry.staff_id] || "Unknown";
          const badge = METHOD_BADGES[entry.entry_method] || METHOD_BADGES.quick;
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
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${badge.color}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <span>{fmtDateFull(entry.date)}</span>
                    {entry.start_time && entry.end_time && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span>{entry.start_time}\u2013{entry.end_time}</span>
                      </>
                    )}
                    {entry.break_minutes > 0 && (
                      <>
                        <span className="text-gray-300 dark:text-gray-600">|</span>
                        <span>{entry.break_minutes}min break</span>
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
                        className="w-16 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white rounded px-2 py-1 text-sm focus:ring-2 focus:ring-green-500 outline-none"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") handleEdit(entry.id);
                          if (e.key === "Escape") { setEditingId(null); setEditHours(""); }
                        }}
                      />
                      <button
                        onClick={() => handleEdit(entry.id)}
                        disabled={editSaving}
                        className="text-green-600 hover:text-green-700 dark:text-green-400 text-xs font-medium"
                      >
                        {editSaving ? "..." : "Save"}
                      </button>
                      <button
                        onClick={() => { setEditingId(null); setEditHours(""); }}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                      >
                        Cancel
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
                      className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                      title="Edit hours"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      disabled={isDeleting}
                      className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition disabled:opacity-40"
                      title="Delete entry"
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
