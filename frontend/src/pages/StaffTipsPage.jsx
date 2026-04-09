import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { formatDate } from "../utils/dateFormat";
import { FadeIn, AnimatedCard, StaggerContainer, StaggerItem } from "../components/AnimationKit";

/* ═══════════════════════════════════════════════════════════
   SPLIT METHOD DEFINITIONS
   ═══════════════════════════════════════════════════════════ */
const SPLIT_METHODS = [
  { id: "hours", label: "By Hours Worked", icon: "⏱️", desc: "Proportional to hours logged today" },
  { id: "role", label: "By Role Share", icon: "👔", desc: "Full-time = 1.0, Part-time/Student = 0.5" },
  { id: "custom", label: "Custom Ratio", icon: "✏️", desc: "Set your own percentages" },
];

const ROLE_SHARES = {
  "full-time": 1.0,
  "full_time": 1.0,
  "manager": 1.0,
  "part-time": 0.5,
  "part_time": 0.5,
  "student": 0.5,
  "intern": 0.5,
  "trainee": 0.5,
};

function getRoleShare(role) {
  if (!role) return 1.0;
  return ROLE_SHARES[role.toLowerCase()] ?? 1.0;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffTipsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("new"); // new | history
  const [tipHistory, setTipHistory] = useState([]);
  const [staffMembers, setStaffMembers] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(() => {
    const from = new Date();
    from.setDate(from.getDate() - 90);
    api.get("/staff/tips", { params: { from: from.toISOString().split("T")[0], to: today() } })
      .then(r => setTipHistory(r.data))
      .catch(() => {});
  }, []);

  const fetchStaff = useCallback(() => {
    api.get("/staff/members")
      .then(r => setStaffMembers(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      api.get("/staff/tips", { params: { from: new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0], to: today() } }),
      api.get("/staff/members"),
    ]).then(([histRes, staffRes]) => {
      if (histRes.status === "fulfilled") setTipHistory(histRes.value.data);
      if (staffRes.status === "fulfilled") setStaffMembers(staffRes.value.data);
      setLoading(false);
    });
  }, []);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <FadeIn>
        <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
          {"\uD83D\uDCB0"} {t("tips") || "Tips"}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
          {t("tipsDesc") || "Distribute tips fairly \u2014 by hours, role, or custom split"}
        </p>
      </FadeIn>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {[
          { id: "new", label: t("newTipEntry") || "New Entry", icon: "\u2795" },
          { id: "history", label: t("tipHistory") || "History", icon: "\uD83D\uDCC5" },
        ].map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
              tab === tb.id
                ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400 dark:text-gray-500">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full mb-3" />
          <p className="text-sm">Loading...</p>
        </div>
      )}

      {!loading && tab === "new" && (
        <TipEntryForm
          currency={currency}
          t={t}
          staffMembers={staffMembers}
          onDone={() => { fetchHistory(); setTab("history"); }}
        />
      )}
      {!loading && tab === "history" && (
        <TipHistoryView
          data={tipHistory}
          currency={currency}
          t={t}
          onRefresh={fetchHistory}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   TIP ENTRY FORM
   ═══════════════════════════════════════════════════════════ */
function TipEntryForm({ currency, t, staffMembers, onDone }) {
  const [date, setDate] = useState(today());
  const [totalAmount, setTotalAmount] = useState("");
  const [splitMethod, setSplitMethod] = useState("hours");
  const [staffHours, setStaffHours] = useState([]);
  const [customRatios, setCustomRatios] = useState({});
  const [hoursLoading, setHoursLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Fetch hours for the selected date
  useEffect(() => {
    if (!date) return;
    setHoursLoading(true);
    api.get("/staff/hours", { params: { from: date, to: date } })
      .then(r => {
        const hoursData = r.data || [];
        // Merge with staff members to get names and roles
        const merged = staffMembers.map(member => {
          const hourEntry = hoursData.find(h => h.staff_id === member.id);
          return {
            staff_id: member.id,
            name: member.name || member.full_name || `Staff #${member.id}`,
            role: member.role || member.employment_type || "full-time",
            hours: hourEntry ? parseFloat(hourEntry.hours || hourEntry.total_hours || 0) : 0,
          };
        }).filter(m => m.hours > 0 || hoursData.length === 0);

        // If no hours data, show all staff with 0 hours for manual entry
        if (merged.length === 0 && staffMembers.length > 0) {
          setStaffHours(staffMembers.map(m => ({
            staff_id: m.id,
            name: m.name || m.full_name || `Staff #${m.id}`,
            role: m.role || m.employment_type || "full-time",
            hours: 0,
          })));
        } else if (merged.length > 0) {
          setStaffHours(merged);
        } else if (hoursData.length > 0) {
          // If we have hours data but no matching staff, use hours data directly
          setStaffHours(hoursData.map(h => ({
            staff_id: h.staff_id,
            name: h.staff_name || h.name || `Staff #${h.staff_id}`,
            role: h.role || "full-time",
            hours: parseFloat(h.hours || h.total_hours || 0),
          })));
        }
      })
      .catch(() => {
        // Fallback: use staff members list with 0 hours
        if (staffMembers.length > 0) {
          setStaffHours(staffMembers.map(m => ({
            staff_id: m.id,
            name: m.name || m.full_name || `Staff #${m.id}`,
            role: m.role || m.employment_type || "full-time",
            hours: 0,
          })));
        }
      })
      .finally(() => setHoursLoading(false));
  }, [date, staffMembers]);

  // Initialize custom ratios when staff changes
  useEffect(() => {
    if (staffHours.length > 0 && Object.keys(customRatios).length === 0) {
      const even = Math.floor(10000 / staffHours.length) / 100;
      const initial = {};
      staffHours.forEach((s, i) => {
        initial[s.staff_id] = i === 0
          ? (100 - even * (staffHours.length - 1)).toFixed(2)
          : even.toFixed(2);
      });
      setCustomRatios(initial);
    }
  }, [staffHours]);

  const totalHours = useMemo(
    () => staffHours.reduce((sum, s) => sum + (parseFloat(s.hours) || 0), 0),
    [staffHours]
  );

  const totalRoleWeight = useMemo(
    () => staffHours.reduce((sum, s) => {
      const hrs = parseFloat(s.hours) || 0;
      return sum + (hrs > 0 ? getRoleShare(s.role) : 0);
    }, 0),
    [staffHours]
  );

  const totalCustomPercent = useMemo(
    () => Object.values(customRatios).reduce((sum, v) => sum + (parseFloat(v) || 0), 0),
    [customRatios]
  );

  const amount = parseFloat(totalAmount) || 0;

  // Calculate distribution for each staff member
  const distribution = useMemo(() => {
    if (!amount || staffHours.length === 0) return [];

    return staffHours.map(s => {
      const hours = parseFloat(s.hours) || 0;
      let share = 0;
      let pct = 0;

      if (splitMethod === "hours") {
        pct = totalHours > 0 ? (hours / totalHours) * 100 : 0;
        share = totalHours > 0 ? (hours / totalHours) * amount : 0;
      } else if (splitMethod === "role") {
        const weight = hours > 0 ? getRoleShare(s.role) : 0;
        pct = totalRoleWeight > 0 ? (weight / totalRoleWeight) * 100 : 0;
        share = totalRoleWeight > 0 ? (weight / totalRoleWeight) * amount : 0;
      } else if (splitMethod === "custom") {
        pct = parseFloat(customRatios[s.staff_id]) || 0;
        share = (pct / 100) * amount;
      }

      return {
        ...s,
        share_pct: Math.round(pct * 100) / 100,
        share_amount: Math.round(share * 100) / 100,
      };
    });
  }, [staffHours, amount, splitMethod, totalHours, totalRoleWeight, customRatios]);

  const distributionTotal = useMemo(
    () => distribution.reduce((sum, d) => sum + d.share_amount, 0),
    [distribution]
  );

  const updateStaffHours = (staffId, newHours) => {
    setStaffHours(prev => prev.map(s =>
      s.staff_id === staffId ? { ...s, hours: parseFloat(newHours) || 0 } : s
    ));
  };

  const updateCustomRatio = (staffId, newPct) => {
    setCustomRatios(prev => ({ ...prev, [staffId]: newPct }));
  };

  const handleSubmit = async () => {
    if (!amount || amount <= 0) {
      setError("Please enter a tip amount.");
      return;
    }
    if (staffHours.length === 0) {
      setError("No staff available for distribution.");
      return;
    }
    if (splitMethod === "custom" && Math.abs(totalCustomPercent - 100) > 0.5) {
      setError("Custom percentages must add up to 100%.");
      return;
    }
    if (splitMethod === "hours" && totalHours === 0) {
      setError("No hours logged. Enter hours manually or switch to another split method.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await api.post("/staff/tips", {
        date,
        total_amount: amount,
        split_method: splitMethod,
        staff_hours: staffHours.map(s => ({
          staff_id: s.staff_id,
          hours: parseFloat(s.hours) || 0,
        })),
        distribution: distribution.map(d => ({
          staff_id: d.staff_id,
          amount: d.share_amount,
          percentage: d.share_pct,
        })),
      });
      setSuccess("Tips distributed successfully!");
      setTimeout(() => {
        setSuccess("");
        onDone();
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to save tip distribution.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 text-right text-lg";
  const labelClass = "text-sm font-medium text-gray-600 dark:text-gray-300";

  return (
    <div className="space-y-4">
      {/* Date & Amount Card */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold dark:text-white">{"\uD83D\uDCDD"} Tip Details</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{"\uD83D\uDCC5"} Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              max={today()}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className={labelClass}>{"\uD83D\uDCB0"} Total Tips ({currency})</label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={totalAmount}
              onChange={e => setTotalAmount(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Split Method Card */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold dark:text-white">{"\u2696\uFE0F"} Split Method</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SPLIT_METHODS.map(method => (
            <button
              key={method.id}
              onClick={() => setSplitMethod(method.id)}
              className={`p-3 rounded-xl border-2 text-left transition-all ${
                splitMethod === method.id
                  ? "border-green-500 bg-green-50 dark:bg-green-900/20"
                  : "border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{method.icon}</span>
                <span className={`text-sm font-semibold ${
                  splitMethod === method.id
                    ? "text-green-700 dark:text-green-300"
                    : "dark:text-white"
                }`}>
                  {method.label}
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-7">
                {method.desc}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Staff Distribution Table */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="p-5 sm:p-6 pb-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold dark:text-white">{"\uD83D\uDC65"} Staff Distribution</h2>
            {amount > 0 && (
              <span className="text-sm font-semibold text-green-600 dark:text-green-400">
                {amount.toLocaleString()} {currency}
              </span>
            )}
          </div>

          {hoursLoading && (
            <div className="text-center py-8 text-gray-400">
              <div className="animate-spin inline-block w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full mb-2" />
              <p className="text-sm">Loading staff hours...</p>
            </div>
          )}

          {!hoursLoading && staffHours.length === 0 && (
            <div className="text-center py-8">
              <p className="text-3xl mb-2">{"\uD83D\uDC65"}</p>
              <p className="font-semibold dark:text-white">No staff found</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Add staff members first, or check that hours are logged for {date}.
              </p>
            </div>
          )}
        </div>

        {!hoursLoading && staffHours.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-5 py-3">
                    Staff
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-3 w-24">
                    Hours
                  </th>
                  {splitMethod === "role" && (
                    <th className="text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-3 w-20">
                      Weight
                    </th>
                  )}
                  <th className="text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-3 w-24">
                    Share %
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-5 py-3 w-28">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {distribution.map(row => (
                  <tr key={row.staff_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-5 py-3">
                      <div>
                        <p className="text-sm font-medium dark:text-white">{row.name}</p>
                        <p className="text-xs text-gray-400 capitalize">{row.role}</p>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        min="0"
                        value={row.hours || ""}
                        onChange={e => updateStaffHours(row.staff_id, e.target.value)}
                        className="w-20 px-2 py-1.5 text-sm text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-green-500"
                        placeholder="0"
                      />
                    </td>
                    {splitMethod === "role" && (
                      <td className="px-3 py-3 text-right">
                        <span className="text-sm text-gray-600 dark:text-gray-300">
                          {getRoleShare(row.role).toFixed(1)}x
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-3 text-right">
                      {splitMethod === "custom" ? (
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          max="100"
                          value={customRatios[row.staff_id] || ""}
                          onChange={e => updateCustomRatio(row.staff_id, e.target.value)}
                          className="w-20 px-2 py-1.5 text-sm text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-green-500"
                          placeholder="0"
                        />
                      ) : (
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {row.share_pct.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className="text-sm font-bold text-green-600 dark:text-green-400">
                        {row.share_amount > 0 ? row.share_amount.toLocaleString() : "\u2014"} {row.share_amount > 0 ? currency : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
                  <td className="px-5 py-3 text-sm font-bold dark:text-white">Total</td>
                  <td className="px-3 py-3 text-right text-sm font-semibold dark:text-gray-300">
                    {totalHours > 0 ? totalHours.toFixed(1) : "\u2014"}
                  </td>
                  {splitMethod === "role" && <td className="px-3 py-3" />}
                  <td className="px-3 py-3 text-right">
                    <span className={`text-sm font-semibold ${
                      splitMethod === "custom" && Math.abs(totalCustomPercent - 100) > 0.5
                        ? "text-red-500"
                        : "dark:text-gray-300"
                    }`}>
                      {splitMethod === "custom"
                        ? `${totalCustomPercent.toFixed(1)}%`
                        : `${distribution.reduce((s, d) => s + d.share_pct, 0).toFixed(1)}%`
                      }
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-sm font-bold text-green-600 dark:text-green-400">
                    {distributionTotal > 0 ? `${distributionTotal.toLocaleString()} ${currency}` : "\u2014"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Validation messages */}
        {splitMethod === "custom" && Math.abs(totalCustomPercent - 100) > 0.5 && totalCustomPercent > 0 && (
          <div className="mx-5 mb-4 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 rounded-xl text-sm text-red-600 dark:text-red-400">
            {"\u26A0\uFE0F"} Percentages total {totalCustomPercent.toFixed(1)}% \u2014 must equal 100%
          </div>
        )}

        {splitMethod === "hours" && totalHours === 0 && staffHours.length > 0 && (
          <div className="mx-5 mb-4 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-sm text-amber-700 dark:text-amber-300">
            {"\u26A0\uFE0F"} No hours logged for {date}. Enter hours manually above, or switch to Role or Custom split.
          </div>
        )}
      </div>

      {/* Preview & Submit */}
      {amount > 0 && staffHours.length > 0 && (
        <div className="space-y-3">
          {/* Preview Toggle */}
          {!showPreview && (
            <button
              onClick={() => setShowPreview(true)}
              className="w-full py-3 text-sm font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-xl hover:bg-green-100 dark:hover:bg-green-900/30 transition"
            >
              {"\uD83D\uDD0D"} Preview Distribution
            </button>
          )}

          {showPreview && (
            <FadeIn>
              <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold dark:text-white">{"\u2705"} Distribution Preview</h2>
                  <button
                    onClick={() => setShowPreview(false)}
                    className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    Close
                  </button>
                </div>

                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-2">
                  <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400">
                    <span>Date</span>
                    <span className="dark:text-gray-300">{formatDate(date)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400">
                    <span>Method</span>
                    <span className="dark:text-gray-300">
                      {SPLIT_METHODS.find(m => m.id === splitMethod)?.label}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-bold pt-2 border-t dark:border-gray-600 dark:text-white">
                    <span>Total Tips</span>
                    <span className="text-green-600 dark:text-green-400">{amount.toLocaleString()} {currency}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  {distribution.filter(d => d.share_amount > 0).map(d => (
                    <div key={d.staff_id} className="flex items-center justify-between py-2 px-3 bg-green-50 dark:bg-green-900/15 rounded-xl">
                      <div>
                        <p className="text-sm font-medium dark:text-white">{d.name}</p>
                        <p className="text-xs text-gray-400">{d.share_pct.toFixed(1)}% share</p>
                      </div>
                      <span className="text-lg font-bold text-green-600 dark:text-green-400">
                        {d.share_amount.toLocaleString()} {currency}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Rounding note */}
                {Math.abs(distributionTotal - amount) > 0.01 && (
                  <p className="text-xs text-gray-400 text-center">
                    Rounding difference: {(amount - distributionTotal).toFixed(2)} {currency}
                  </p>
                )}
              </div>
            </FadeIn>
          )}

          {/* Error / Success */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-4 py-3 rounded-xl text-sm font-medium text-center">
              {"\u2705"} {success}
            </div>
          )}

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={saving || amount <= 0}
            className="w-full py-3.5 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold transition disabled:opacity-50 text-base"
          >
            {saving ? "Distributing..." : `\uD83D\uDCB0 Distribute ${amount > 0 ? amount.toLocaleString() + " " + currency : "Tips"}`}
          </button>

          {/* Tax reminder */}
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
            <strong>Tax note:</strong> Tips must be reported per local tax law. Share distribution records with your accountant.
          </div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   TIP HISTORY VIEW
   ═══════════════════════════════════════════════════════════ */
function TipHistoryView({ data, currency, t, onRefresh }) {
  const [confirmingId, setConfirmingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const handleConfirm = async (tipId) => {
    setConfirmingId(tipId);
    try {
      await api.post(`/staff/tips/${tipId}/confirm`);
      onRefresh();
    } catch {
      // silent
    } finally {
      setConfirmingId(null);
    }
  };

  if (!data || data.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <p className="text-4xl mb-3">{"\uD83D\uDCB0"}</p>
        <p className="font-semibold dark:text-white">No tip distributions yet</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Create your first tip distribution to see history here.
        </p>
      </div>
    );
  }

  // Sort by date descending
  const sorted = [...data].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // Stats summary
  const totalTips = data.reduce((s, d) => s + (parseFloat(d.total_amount) || 0), 0);
  const confirmedCount = data.filter(d => d.status === "confirmed" || d.confirmed).length;

  return (
    <div className="space-y-4">
      {/* Summary Row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">Total Distributed</p>
          <p className="text-lg font-bold text-green-600 dark:text-green-400 mt-1">
            {totalTips.toLocaleString()} {currency}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">Distributions</p>
          <p className="text-lg font-bold dark:text-white mt-1">{data.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">Confirmed</p>
          <p className="text-lg font-bold dark:text-white mt-1">
            {confirmedCount}/{data.length}
          </p>
        </div>
      </div>

      {/* Tip Cards */}
      <StaggerContainer className="space-y-3">
        {sorted.map(tip => {
          const isConfirmed = tip.status === "confirmed" || tip.confirmed;
          const isPending = !isConfirmed;
          const isExpanded = expandedId === tip.id;
          const distributions = tip.distribution || tip.distributions || [];

          return (
            <StaggerItem key={tip.id}>
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
                {/* Card Header */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : tip.id)}
                  className="w-full p-4 sm:p-5 text-left"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-bold dark:text-white">
                        {tip.date ? new Date(tip.date).toLocaleDateString("en-GB", {
                          weekday: "short", day: "numeric", month: "short", year: "numeric",
                        }) : "Unknown date"}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-400 capitalize">
                          {SPLIT_METHODS.find(m => m.id === tip.split_method)?.icon}{" "}
                          {SPLIT_METHODS.find(m => m.id === tip.split_method)?.label || tip.split_method}
                        </span>
                        <span className="text-xs text-gray-300 dark:text-gray-600">{"\u2022"}</span>
                        <span className="text-xs text-gray-400">
                          {distributions.length} staff
                        </span>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-2">
                      <p className="text-lg font-bold text-green-600 dark:text-green-400">
                        {(parseFloat(tip.total_amount) || 0).toLocaleString()} {currency}
                      </p>
                      {isConfirmed ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          {"\u2713"} Confirmed
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">
                          {"\u25CB"} Pending
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Collapsed preview: first 3 staff */}
                  {!isExpanded && distributions.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {distributions.slice(0, 3).map((d, i) => (
                        <span key={i} className="px-2 py-1 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-lg text-xs font-medium">
                          {d.staff_name || d.name || `Staff #${d.staff_id}`}: {(parseFloat(d.amount) || 0).toLocaleString()}
                        </span>
                      ))}
                      {distributions.length > 3 && (
                        <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-lg text-xs">
                          +{distributions.length - 3} more
                        </span>
                      )}
                    </div>
                  )}
                </button>

                {/* Expanded Breakdown */}
                {isExpanded && (
                  <div className="px-4 sm:px-5 pb-4 sm:pb-5 border-t border-gray-100 dark:border-gray-700">
                    <div className="pt-4 space-y-2">
                      {distributions.map((d, i) => (
                        <div key={i} className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
                          <div>
                            <p className="text-sm font-medium dark:text-white">
                              {d.staff_name || d.name || `Staff #${d.staff_id}`}
                            </p>
                            <p className="text-xs text-gray-400">
                              {d.hours ? `${d.hours}h` : ""}{d.hours && d.percentage ? " \u2022 " : ""}
                              {d.percentage ? `${parseFloat(d.percentage).toFixed(1)}%` : ""}
                            </p>
                          </div>
                          <span className="text-sm font-bold text-green-600 dark:text-green-400">
                            {(parseFloat(d.amount) || 0).toLocaleString()} {currency}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Confirm button for pending */}
                    {isPending && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleConfirm(tip.id); }}
                        disabled={confirmingId === tip.id}
                        className="mt-4 w-full py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold text-sm transition disabled:opacity-50"
                      >
                        {confirmingId === tip.id ? "Confirming..." : "\u2705 Confirm Distribution"}
                      </button>
                    )}

                    {isConfirmed && (
                      <div className="mt-4 px-4 py-2.5 bg-green-50 dark:bg-green-900/20 rounded-xl text-center text-sm text-green-600 dark:text-green-400 font-medium">
                        {"\uD83D\uDD12"} Locked \u2014 This distribution has been confirmed
                      </div>
                    )}
                  </div>
                )}
              </div>
            </StaggerItem>
          );
        })}
      </StaggerContainer>
    </div>
  );
}
