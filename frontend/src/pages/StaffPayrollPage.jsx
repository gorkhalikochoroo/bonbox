// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { formatDate, localIso } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import { UpgradeNudge, PageHeader, Button, SectionBanner, Icon } from "../components/ui";

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function fmtMoney(n, cur) {
  if (n == null) return "—";
  return `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
}

function fmtHours(h) {
  if (h == null) return "—";
  return `${Number(h).toFixed(1)}h`;
}

function periodLabel(start, end) {
  if (!start || !end) return "—";
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return localIso(d);
}

const REASON_OPTIONS = [
  { value: "sick", labelKey: "sickReasonSick", label: "Sick", icon: "🤒" },
  { value: "personal", labelKey: "sickReasonPersonal", label: "Personal", icon: "🏠" },
  { value: "weather", labelKey: "sickReasonWeather", label: "Weather", icon: "🌧️" },
  { value: "other", labelKey: "sickReasonOther", label: "Other", icon: "📝" },
];

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffPayrollPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  // ─── Pay Period ───
  const [period, setPeriod] = useState(null);
  const [periodLoading, setPeriodLoading] = useState(true);
  // Owner-configurable DK lønperiode (calendar month / 15th→14th / custom day).
  const [periodCfg, setPeriodCfg] = useState({ period_type: "monthly_1st", custom_start_day: 16 });
  const [savingCfg, setSavingCfg] = useState(false);

  // ─── Staff & Hours ───
  const [staffList, setStaffList] = useState([]);
  const [hoursSummary, setHoursSummary] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Staff list collapses by default — 16+ checkboxes was too much scroll on
  // the way to the preview + export buttons. Header shows the count; tap to open.
  const [staffOpen, setStaffOpen] = useState(false);
  // Per-staff preview table also collapses by default — same scroll problem.
  // Collapsed state still shows the grand total (staff · hours · payout).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [staffLoading, setStaffLoading] = useState(true);

  // ─── PDF ───
  const [pdfLoading, setPdfLoading] = useState(false);

  // ─── Sick Calls ───
  const [sickCalls, setSickCalls] = useState([]);
  const [sickStats, setSickStats] = useState(null);
  const [sickForm, setSickForm] = useState({
    staff_name: "",
    date: localIso(),
    reason: "",
    notes: "",
  });
  const [sickSuccess, setSickSuccess] = useState("");
  const [sickLoading, setSickLoading] = useState(true);

  // ─── Error ───
  const [error, setError] = useState("");

  // ─── Danish payroll estimate (only relevant for DKK users) ───
  const [dkEstimate, setDkEstimate] = useState(null);
  const [dkLoading, setDkLoading] = useState(false);
  const isDanish = user?.currency === "DKK";

  useEffect(() => {
    if (!period || !isDanish) { setDkEstimate(null); return; }
    setDkLoading(true);
    api.get("/staff/payroll/estimate", {
      params: { period_start: period.period_start, period_end: period.period_end },
    })
      .then(r => { setDkEstimate(r.data); setDkLoading(false); })
      .catch(() => { setDkEstimate(null); setDkLoading(false); });
  }, [period, isDanish]);

  /* ─── Fetch current pay period ─── */
  useEffect(() => {
    setPeriodLoading(true);
    api.get("/staff/pay-period/current")
      .then(r => {
        // Backend returns { start_date, end_date }; the rest of this page
        // reads period_start / period_end. Normalise here so we don't have
        // to thread the legacy key names through every consumer below.
        const d = r.data || {};
        setPeriod({
          period_start: d.period_start || d.start_date || null,
          period_end: d.period_end || d.end_date || null,
          period_type: d.period_type || null,
        });
        setPeriodLoading(false);
      })
      .catch(() => {
        // Fallback: bi-weekly period ending today
        const today = localIso();
        const start = addDays(today, -13);
        setPeriod({ period_start: start, period_end: today });
        setPeriodLoading(false);
      });
  }, []);

  /* ─── Fetch the saved lønperiode config (type + custom day) ─── */
  useEffect(() => {
    api.get("/staff/pay-period")
      .then((r) => setPeriodCfg({
        period_type: r.data?.period_type || "monthly_1st",
        custom_start_day: r.data?.custom_start_day || 16,
      }))
      .catch(() => {});
  }, []);

  /* ─── Save lønperiode config → refetch the computed current period ─── */
  const savePeriodCfg = async (periodType, customDay) => {
    const day = Math.min(28, Math.max(1, Number(customDay) || 16));
    setSavingCfg(true);
    setPeriodCfg({ period_type: periodType, custom_start_day: day });
    try {
      await api.post("/staff/pay-period", {
        period_type: periodType,
        custom_start_day: periodType === "custom" ? day : null,
      });
      const r = await api.get("/staff/pay-period/current");
      const d = r.data || {};
      setPeriod({
        period_start: d.period_start || d.start_date || null,
        period_end: d.period_end || d.end_date || null,
        period_type: d.period_type || periodType,
      });
    } catch (e) {
      /* keep the current period on failure */
    }
    setSavingCfg(false);
  };

  /* ─── Fetch staff list ─── */
  useEffect(() => {
    api.get("/staff/members")
      .then(r => {
        setStaffList(r.data || []);
        setSelectedIds(new Set((r.data || []).map(s => s.id)));
      })
      .catch(() => setStaffList([]));
  }, []);

  /* ─── Fetch hours when period changes ─── */
  useEffect(() => {
    if (!period) return;
    setStaffLoading(true);
    api.get("/staff/hours/summary", {
      params: { from: period.period_start, to: period.period_end },
    })
      .then(r => {
        setHoursSummary(r.data || []);
        setStaffLoading(false);
      })
      .catch(() => {
        setHoursSummary([]);
        setStaffLoading(false);
      });
  }, [period]);

  /* ─── Fetch sick calls ─── */
  useEffect(() => {
    setSickLoading(true);
    Promise.allSettled([
      api.get("/weather/sick-calls"),
      api.get("/weather/sick-calls/stats"),
    ]).then(([callsRes, statsRes]) => {
      if (callsRes.status === "fulfilled") setSickCalls(callsRes.value.data || []);
      if (statsRes.status === "fulfilled") setSickStats(statsRes.value.data);
      setSickLoading(false);
    });
  }, []);

  /* ─── Period navigation ─── */
  const navigatePeriod = (direction) => {
    if (!period) return;
    const len = Math.round(
      (new Date(period.period_end) - new Date(period.period_start)) / 86400000
    ) + 1;
    const offset = direction === "next" ? len : -len;
    setPeriod({
      period_start: addDays(period.period_start, offset),
      period_end: addDays(period.period_end, offset),
    });
  };

  /* ─── Selection helpers ─── */
  const toggleStaff = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === staffList.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(staffList.map(s => s.id)));
    }
  };

  /* ─── Build payroll rows (merge staff list + hours) ─── */
  const payrollRows = useMemo(() => {
    const hoursMap = {};
    hoursSummary.forEach(h => { hoursMap[h.staff_id] = h; });

    return staffList
      .filter(s => selectedIds.has(s.id))
      .map(s => {
        const h = hoursMap[s.id] || {};
        // Backend `/staff/hours/summary` returns: total_hours, total_earned,
        // overtime_hours, tips_received. We accept legacy field names too
        // (base_earned / overtime_pay / tips) so a stale schema mid-deploy
        // won't render zeros — multi-layer fallback.
        const baseEarned = h.total_earned ?? h.base_earned ?? 0;
        const overtimePay = h.overtime_pay ?? 0; // not yet computed by backend
        const tips = h.tips_received ?? h.tips ?? 0;
        return {
          id: s.id,
          name: s.name || s.staff_name || "—",
          role: s.role || "Staff",
          contract_type: s.contract_type || "hourly",
          hours: h.total_hours || 0,
          base_earned: baseEarned,
          overtime: overtimePay,
          overtime_hours: h.overtime_hours || 0,
          tips,
          total: baseEarned + overtimePay + tips,
        };
      });
  }, [staffList, hoursSummary, selectedIds]);

  /* ─── Grand totals ─── */
  const totals = useMemo(() => {
    return payrollRows.reduce(
      (acc, r) => ({
        hours: acc.hours + r.hours,
        base_earned: acc.base_earned + r.base_earned,
        overtime: acc.overtime + r.overtime,
        tips: acc.tips + r.tips,
        total: acc.total + r.total,
      }),
      { hours: 0, base_earned: 0, overtime: 0, tips: 0, total: 0 }
    );
  }, [payrollRows]);

  /* ─── PDF export ─── */
  const generatePdf = async () => {
    if (!period || selectedIds.size === 0) return;
    setPdfLoading(true);
    setError("");
    try {
      const res = await api.post(
        "/staff/payroll/pdf",
        {
          period_start: period.period_start,
          period_end: period.period_end,
          staff_ids: Array.from(selectedIds),
        },
        { responseType: "blob" }
      );
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `payroll_${period.period_start}_${period.period_end}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // Surface the actual server detail when available — `responseType: "blob"`
      // means axios delivers the error body as a Blob, so we read it as text first.
      let detail = "Could not generate PDF. Please try again.";
      try {
        const data = err?.response?.data;
        if (data instanceof Blob) {
          const txt = await data.text();
          try {
            const parsed = JSON.parse(txt);
            if (parsed?.detail) detail = parsed.detail;
          } catch {
            if (txt) detail = txt.slice(0, 200);
          }
        } else if (data?.detail) {
          detail = data.detail;
        }
      } catch { /* fall through to generic */ }
      // A non-blob 422 makes data.detail an ARRAY ([{type,loc,msg,input}]);
      // rendering that as a child would crash. Keep the parsed string as-is,
      // else fall back to the generic message.
      setError(typeof detail === "string" ? detail : "Could not generate PDF. Please try again.");
    }
    setPdfLoading(false);
  };

  /* ─── Email payroll PDF directly to accountant ───
   *
   * Mirrors the daily-close-to-accountant pattern: one button → server
   * renders the PDF and ships it via Resend with the owner set as
   * reply-to. Falls back gracefully if no accountant_email is set on
   * Profile (surfaces the helpful 400 detail).
   */
  const [sending, setSending] = useState(false);
  const [sendToast, setSendToast] = useState("");
  // UpgradeNudge state — shown as a dialog when a Free user tries
  // to send payroll to the accountant (Starter+ gated feature).
  const [upgradeNudge, setUpgradeNudge] = useState(null);

  const sendToAccountant = async () => {
    if (!period || selectedIds.size === 0) return;
    setSending(true);
    setError("");
    setSendToast("");
    try {
      const r = await api.post("/staff/payroll/send-to-accountant", {
        period_start: period.period_start,
        period_end: period.period_end,
        staff_ids: Array.from(selectedIds),
        cc_self: true,
      });
      if (r.data?.ok) {
        setSendToast(
          (t("payrollSentTo", "✓ Sent to") + " " + r.data.sent_to) +
          (r.data.cc_self ? ` (${t("ccdYou", "you cc'd")})` : "")
        );
        setTimeout(() => setSendToast(""), 7000);
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required — surface as the tasteful UpgradeNudge dialog
      // instead of a red error message. Free user can still download
      // the PDF and attach it manually via the "Generate PDF" button.
      if (err?.response?.status === 402 &&
          detail?.code === "plan_required" &&
          detail?.feature === "direct_accountant_email") {
        setUpgradeNudge({
          tier: detail.required_plan || "starter",
          benefit: t("nudgePayrollSend", "Email payroll to your bogholder in one tap"),
          icon: "📤",
        });
      } else {
        setError(
          typeof detail === "string"
            ? detail
            : (detail?.message || t("payrollSendFailed", "Couldn't email the payroll. Try downloading the PDF instead."))
        );
      }
    } finally {
      setSending(false);
    }
  };

  /* ─── Log sick call ─── */
  const logSickCall = async (e) => {
    e.preventDefault();
    if (!sickForm.staff_name) return;
    try {
      await api.post("/weather/sick-calls", {
        staff_name: sickForm.staff_name,
        date: sickForm.date,
        weather_condition: sickForm.reason === "weather" ? "weather" : sickForm.reason || null,
        notes: sickForm.notes || null,
      });
      setSickForm({ staff_name: "", date: localIso(), reason: "", notes: "" });
      setSickSuccess(t("sickCallLogged", "Sick call logged"));
      setTimeout(() => setSickSuccess(""), 2500);
      const [res, statsRes] = await Promise.all([
        api.get("/weather/sick-calls"),
        api.get("/weather/sick-calls/stats"),
      ]);
      setSickCalls(res.data || []);
      setSickStats(statsRes.data);
    } catch {
      setError(t("couldNotLogSickCall", "Could not log sick call"));
    }
  };

  /* ─── LOADING STATE ─── */
  if (periodLoading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="mb-3 animate-pulse text-gray-400">
            <Icon name="FileText" size={36} className="mx-auto" />
          </div>
          <p className="text-gray-500 dark:text-gray-400">{t("loadingPayroll", "Loading payroll...")}</p>
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        eyebrow="STAFF"
        title={t("payroll", "Payroll")}
        subtitle={t("payrollSubtitle", "Generate payroll reports for your revisor")}
      />

      <DismissibleTip
        id="payroll-intro-v1"
        icon="💼"
        title={t("payrollTipTitle", "DK payroll, the easy way")}
      >
        <p className="mb-1.5">
          BonBox runs <strong>lønhjælp mode</strong> — from the hours you already log, we estimate
          AM-bidrag (8%), A-skat (~36% after personfradrag), ATP and feriepenge, then generate a clean
          Lønseddel PDF + a summary CSV (DKK, semikolon-separeret for Excel) your revisor can key into
          DataLøn / Zenegy.
        </p>
        <p className="text-xs opacity-75">
          Built for timelønnet (hourly) staff — funktionærer på fast månedsløn køres via lønsystemet. We
          don&rsquo;t store CPR, run eIndkomst, or file with SKAT — your lønsystem and revisor sign off on
          the final numbers.
        </p>
      </DismissibleTip>

      {/* ─── PERIOD SELECTOR ─── */}
      <FadeIn delay={0.05}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <Button variant="secondary" size="sm" onClick={() => navigatePeriod("prev")}>
              ← Previous
            </Button>
            <div className="text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t("payPeriod")}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {period ? periodLabel(period.period_start, period.period_end) : "—"}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => navigatePeriod("next")}>
              Next →
            </Button>
          </div>
          {/* DK lønperiode is often mid-month (16.→15., 25.→24.) rather than the
              calendar month — let the owner set it. Staff Hours + payroll totals
              follow automatically (the backend computes from this config). */}
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-center gap-2 text-xs">
            <span className="text-gray-500 dark:text-gray-400">{t("payPeriodLabel", "Pay period")}:</span>
            <select
              value={periodCfg.period_type}
              onChange={(e) => savePeriodCfg(e.target.value, periodCfg.custom_start_day)}
              disabled={savingCfg}
              className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-xs focus:ring-2 focus:ring-gray-400 outline-none disabled:opacity-50"
              aria-label={t("payPeriodLabel", "Pay period")}
            >
              <option value="monthly_1st">{t("payPeriodMonth1", "Calendar month (1st → end)")}</option>
              <option value="monthly_15th">{t("payPeriodMonth15", "15th → 14th")}</option>
              <option value="custom">{t("payPeriodCustomOpt", "Custom start day…")}</option>
            </select>
            {periodCfg.period_type === "custom" && (
              <span className="inline-flex items-center gap-1">
                <span className="text-gray-500 dark:text-gray-400">{t("payPeriodStarts", "starts on the")}</span>
                <input
                  type="number"
                  min="1"
                  max="28"
                  value={periodCfg.custom_start_day}
                  onChange={(e) => setPeriodCfg((c) => ({ ...c, custom_start_day: e.target.value }))}
                  onBlur={(e) => savePeriodCfg("custom", e.target.value)}
                  disabled={savingCfg}
                  className="w-14 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-xs tabular-nums focus:ring-2 focus:ring-gray-400 outline-none disabled:opacity-50"
                  aria-label={t("payPeriodStartDay", "Start day of month")}
                />
              </span>
            )}
          </div>
        </div>
      </FadeIn>

      {/* ─── STAFF SELECTOR ─── */}
      <FadeIn delay={0.1}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={() => setStaffOpen((o) => !o)}
              className="flex items-center gap-2 text-left"
              aria-expanded={staffOpen}
            >
              <span className={`text-gray-400 transition-transform ${staffOpen ? "rotate-90" : ""}`}>›</span>
              <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("staffSelection")}</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 tabular-nums">
                {selectedIds.size}/{staffList.length}
              </span>
            </button>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={staffList.length > 0 && selectedIds.size === staffList.length}
                onChange={toggleAll}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-gray-400"
              />
              <span className="text-sm text-gray-600 dark:text-gray-400">{t("selectAll")}</span>
            </label>
          </div>

          {staffOpen && (staffLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <div className="text-2xl mb-2 animate-pulse">👥</div>
                <p className="text-sm text-gray-400">Loading staff...</p>
              </div>
            </div>
          ) : staffList.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">👥</div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No staff members found. Add staff from the Staffing page to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {staffList.map(s => {
                const hoursMap = {};
                hoursSummary.forEach(h => { hoursMap[h.staff_id] = h; });
                const h = hoursMap[s.id] || {};
                const totalEarned = (h.base_earned || 0) + (h.overtime_pay || 0) + (h.tips || 0);

                return (
                  <label
                    key={s.id}
                    className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition border ${
                      selectedIds.has(s.id)
                        ? "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-800"
                        : "bg-gray-50 dark:bg-gray-700/50 border-gray-100 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleStaff(s.id)}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-gray-400"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 dark:text-white truncate">
                          {s.name || s.staff_name || "—"}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                          {s.role || "Staff"}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">
                          {s.contract_type || "hourly"}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {fmtHours(h.total_hours || 0)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {fmtMoney(totalEarned, currency)}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          ))}
          {!staffOpen && staffList.length > 0 && (
            <button
              type="button"
              onClick={() => setStaffOpen(true)}
              className="w-full text-left text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {selectedIds.size} of {staffList.length} staff selected — tap to change
            </button>
          )}
        </div>
      </FadeIn>

      {/* ─── PAYROLL PREVIEW TABLE ─── */}
      <FadeIn delay={0.15}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setPreviewOpen((o) => !o)}
            className="flex items-center gap-2 text-left mb-4 w-full"
            aria-expanded={previewOpen}
          >
            <span className={`text-gray-400 transition-transform ${previewOpen ? "rotate-90" : ""}`}>›</span>
            <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("payrollPreview")}</h2>
            {payrollRows.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 tabular-nums">
                {payrollRows.length}
              </span>
            )}
          </button>

          {payrollRows.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">📊</div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select staff members above to preview payroll
              </p>
            </div>
          ) : previewOpen ? (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("navStaff")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("hoursLabel")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("baseEarned")}</th>
                    <th className="text-right py-3 px-2 text-amber-600 dark:text-amber-400 font-medium">{t("overtime")}</th>
                    <th className="text-right py-3 px-2 text-emerald-600 dark:text-gray-300 font-medium">Tips</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollRows.map(row => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
                      <td className="py-3 px-2">
                        <p className="font-medium text-gray-800 dark:text-white">{row.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{row.role} · {row.contract_type}</p>
                      </td>
                      <td className="text-right py-3 px-2 text-gray-700 dark:text-gray-300 tabular-nums">
                        {fmtHours(row.hours)}
                      </td>
                      <td className="text-right py-3 px-2 text-gray-700 dark:text-gray-300 tabular-nums">
                        {fmtMoney(row.base_earned, currency)}
                      </td>
                      <td className="text-right py-3 px-2 tabular-nums">
                        {row.overtime > 0 ? (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                            {fmtMoney(row.overtime, currency)}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right py-3 px-2 tabular-nums">
                        {row.tips > 0 ? (
                          <span className="text-emerald-600 dark:text-gray-300 font-medium">
                            {fmtMoney(row.tips, currency)}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right py-3 px-2 font-semibold text-gray-800 dark:text-white tabular-nums">
                        {fmtMoney(row.total, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
                    <td className="py-3 px-2 font-bold text-gray-800 dark:text-white">
                      Grand Total ({payrollRows.length} staff)
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtHours(totals.hours)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.base_earned, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                      {fmtMoney(totals.overtime, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-emerald-600 dark:text-gray-300 tabular-nums">
                      {fmtMoney(totals.tips, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.total, currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="w-full text-left text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {payrollRows.length} staff · {fmtHours(totals.hours)} · {fmtMoney(totals.total, currency)} total — tap to see per-staff
            </button>
          )}
        </div>
      </FadeIn>

      {/* ─── DANISH PAYROLL ESTIMATE — A-skat / AM-bidrag / ATP / Feriepenge ─── */}
      {isDanish && (
        <FadeIn delay={0.15}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
            <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("danishPayrollBreakdown")}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Estimate for SKAT remittance and FerieKonto. Submit via your lønsystem.
                </p>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                Estimate
              </span>
            </div>

            {dkLoading ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">Loading estimate…</div>
            ) : !dkEstimate ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">
                No estimate available — log staff hours first.
              </div>
            ) : dkEstimate.staff_count === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">
                No active staff or hours logged in this period.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <DkStat label="Gross wages" value={dkEstimate.totals.gross} currency={currency} accent="gray" />
                  <DkStat label="AM-bidrag (8%)" value={dkEstimate.totals.am_bidrag} currency={currency} accent="blue" />
                  <DkStat label="A-skat (est. 36%)" value={dkEstimate.totals.a_skat} currency={currency} accent="blue" />
                  <DkStat label="Net to staff" value={dkEstimate.totals.net_pay} currency={currency} accent="green" />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <DkStat label="ATP" value={dkEstimate.totals.atp} currency={currency} small />
                  <DkStat label="Feriepenge (12.5%)" value={dkEstimate.totals.feriepenge} currency={currency} small />
                  <DkStat label="Employer total cost" value={dkEstimate.totals.employer_total_cost} currency={currency} small accent="dark" />
                </div>

                <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2.5 text-xs text-blue-800 dark:text-blue-200">
                  <div className="font-semibold mb-0.5">{t("skatRemittance")}</div>
                  <div>{fmtMoney(dkEstimate.skat_remit.total, currency)} = AM-bidrag {fmtMoney(dkEstimate.skat_remit.am_bidrag, currency)} + A-skat {fmtMoney(dkEstimate.skat_remit.a_skat, currency)}</div>
                </div>

                <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  {dkEstimate.estimate_note}
                </p>

                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={async () => {
                      try {
                        const res = await api.get("/staff/payroll/csv", {
                          params: { period_start: period.period_start, period_end: period.period_end },
                          responseType: "blob",
                        });
                        const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `bonbox_payroll_${period.period_start}_${period.period_end}.csv`;
                        document.body.appendChild(a); a.click(); a.remove();
                        window.URL.revokeObjectURL(url);
                      } catch {
                        setError("Could not generate CSV.");
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100 transition"
                  >
                    Download summary CSV (for DataLøn / Zenegy)
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const res = await api.get("/staff/payroll/loenseddel", {
                          params: { period_start: period.period_start, period_end: period.period_end },
                          responseType: "blob",
                        });
                        const url = window.URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `bonbox_loenseddel_${period.period_start}_${period.period_end}.pdf`;
                        document.body.appendChild(a); a.click(); a.remove();
                        window.URL.revokeObjectURL(url);
                      } catch (e) {
                        setError(e?.response?.status === 404 ? "No staff hours logged in this period." : "Could not generate Lønseddel.");
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
                  >
                    Lønseddel PDF (one per employee)
                  </button>
                </div>

                {dkEstimate.per_staff?.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300 select-none">
                      Per-employee breakdown ({dkEstimate.per_staff.length})
                    </summary>
                    <div className="overflow-x-auto mt-2">
                      <table className="w-full text-xs text-gray-700 dark:text-gray-300">
                        <thead className="text-[10px] uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                          <tr>
                            <th className="text-left py-1.5 px-2">Name</th>
                            <th className="text-right py-1.5 px-2">{t("hoursLabel")}</th>
                            <th className="text-right py-1.5 px-2">{t("gross")}</th>
                            <th className="text-right py-1.5 px-2">AM</th>
                            <th className="text-right py-1.5 px-2">A-skat</th>
                            <th className="text-right py-1.5 px-2">Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dkEstimate.per_staff.map((s) => (
                            <tr key={s.staff_id} className="border-b border-gray-100 dark:border-gray-800">
                              <td className="py-1.5 px-2">{s.name}</td>
                              <td className="py-1.5 px-2 text-right">{s.hours.toFixed(1)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.gross, currency)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.am_bidrag, currency)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.a_skat, currency)}</td>
                              <td className="py-1.5 px-2 text-right font-semibold">{fmtMoney(s.net_pay, currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        </FadeIn>
      )}

      {/* ─── EXPORT SECTION ─── */}
      <FadeIn delay={0.2}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-3">{t("exportLabel")}</h2>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              size="lg"
              onClick={generatePdf}
              disabled={pdfLoading || sending || selectedIds.size === 0}
              busy={pdfLoading}
              iconLeft={!pdfLoading && <Icon name="FileText" size={16} />}
              title={t("downloadPdfTooltip", "Download PDF to your device")}
            >
              {pdfLoading ? "Generating..." : t("generatePdf", "Generate PDF")}
            </Button>
            <Button
              variant="accent"
              size="lg"
              onClick={sendToAccountant}
              disabled={sending || pdfLoading || selectedIds.size === 0}
              busy={sending}
              iconLeft={!sending && <Icon name="Send" size={16} />}
              title={t("payrollSendTooltip", "Email this payroll directly to your accountant — set their address on Profile")}
            >
              {sending ? t("payrollSending", "Sending…") : t("payrollSendToAccountant", "Send to accountant")}
            </Button>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {selectedIds.size === 0
                ? "Select at least one staff member to export"
                : `${selectedIds.size} staff member${selectedIds.size > 1 ? "s" : ""} selected · ${period ? periodLabel(period.period_start, period.period_end) : ""}`}
            </p>
          </div>
          {sendToast && (
            <div className="mt-3">
              <SectionBanner severity="success" title={sendToast} />
            </div>
          )}
          {error && (
            <div className="mt-3">
              <SectionBanner severity="critical" title={error} />
            </div>
          )}
        </div>
      </FadeIn>

      {/* ─── SICK CALL TRACKER ─── */}
      <FadeIn delay={0.25}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-4">
            {t("sickCallTracker", "Sick Calls")}
          </h2>

          {/* Stats cards */}
          {sickLoading ? (
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-xl text-center animate-pulse">
                  <div className="h-8 w-10 bg-gray-200 dark:bg-gray-600 rounded mx-auto mb-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-600 rounded mx-auto" />
                </div>
              ))}
            </div>
          ) : sickStats ? (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.this_month ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("thisMonth", "This Month")}</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.last_month ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("lastMonth", "Last Month")}</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.weather_related ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("weatherDays", "Weather Days")}</p>
              </div>
            </div>
          ) : null}

          {/* Quick log form */}
          <form onSubmit={logSickCall} className="flex flex-wrap gap-2 mb-4">
            <input
              placeholder={t("staffName", "Staff name")}
              value={sickForm.staff_name}
              onChange={e => setSickForm(f => ({ ...f, staff_name: e.target.value }))}
              className="flex-1 min-w-[120px] px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white placeholder-gray-400"
            />
            <input
              type="date"
              value={sickForm.date}
              onChange={e => setSickForm(f => ({ ...f, date: e.target.value }))}
              className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white"
            />
            <select
              value={sickForm.reason}
              onChange={e => setSickForm(f => ({ ...f, reason: e.target.value }))}
              className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white"
            >
              <option value="">{t("reason", "Reason")}</option>
              {REASON_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.icon} {t(opt.labelKey, opt.label)}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              type="submit"
              disabled={!sickForm.staff_name}
            >
              {t("log", "Log")}
            </Button>
          </form>
          {sickSuccess && (
            <p className="text-gray-700 dark:text-emerald-400 text-sm mb-3">{sickSuccess}</p>
          )}

          {/* Recent sick calls */}
          {sickLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 py-2 animate-pulse">
                  <div className="h-4 w-24 bg-gray-200 dark:bg-gray-600 rounded" />
                  <div className="flex-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-600 rounded" />
                </div>
              ))}
            </div>
          ) : sickCalls.length > 0 ? (
            <div className="space-y-2">
              {sickCalls.slice(0, 10).map((sc, i) => {
                const reasonObj = REASON_OPTIONS.find(r => r.value === sc.weather_condition) || REASON_OPTIONS.find(r => r.value === "other");
                return (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{reasonObj?.icon || "📝"}</span>
                      <div>
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{sc.staff_name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {sc.weather_condition || "other"} · {formatDate(sc.date)}
                        </p>
                      </div>
                    </div>
                    {sc.notes && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[120px]">{sc.notes}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
              {t("noSickCalls", "No sick calls recorded yet")}
            </p>
          )}
        </div>
      </FadeIn>

      {/* Upgrade nudge — Free user trying gated payroll send. The
          modal explains the value sentence + founding rate price +
          a "See plans" link. Closing returns them to the page so
          they can still hit "Generate PDF" and email manually. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          icon={upgradeNudge.icon}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   DK payroll stat tile
   ═══════════════════════════════════════════════════════════ */
function DkStat({ label, value, currency, accent = "gray", small = false }) {
  const accentClass =
    accent === "blue" ? "border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/20"
    : accent === "green" ? "border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/50"
    : accent === "dark" ? "border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700/40"
    : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40";
  return (
    <div className={`rounded-lg border ${accentClass} px-3 py-2.5`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">{label}</div>
      <div className={`mt-0.5 font-bold text-gray-900 dark:text-white ${small ? "text-base" : "text-lg"}`}>
        {value == null ? "—" : `${Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${currency}`}
      </div>
    </div>
  );
}
